import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mapping, Watcher, WorkItem } from "@harness/shared";
import { matchMapping, parseWorkItem, WatcherRunner, type SpawnFn, type WatcherTiming } from "./watchers";

// ---------------------------------------------------------------------------
// parseWorkItem
// ---------------------------------------------------------------------------

describe("parseWorkItem", () => {
  test("reads a watch-jira line", () => {
    const line = JSON.stringify({
      event: "new",
      key: "RFAWC-742",
      url: "https://jira.example/browse/RFAWC-742",
      summary: "Super user feature",
      updated: "2026-08-12T14:29:49.000+0000",
    });
    const item = parseWorkItem(line)!;
    expect(item.key).toBe("RFAWC-742");
    expect(item.title).toBe("Super user feature");
    expect(item.url).toBe("https://jira.example/browse/RFAWC-742");
    expect(item.version).toBe("2026-08-12T14:29:49.000+0000");
    expect((item.raw as { event: string }).event).toBe("new");
  });

  test("falls back through key fields, numbers become strings", () => {
    expect(parseWorkItem('{"id": 42}')!.key).toBe("42");
    expect(parseWorkItem('{"identifier": "LIN-7"}')!.key).toBe("LIN-7");
    expect(parseWorkItem('{"key": "", "id": "X-1"}')!.key).toBe("X-1");
  });

  test("title falls back summary → title → name → key", () => {
    expect(parseWorkItem('{"key":"A-1","title":"T","name":"N"}')!.title).toBe("T");
    expect(parseWorkItem('{"key":"A-1","name":"N"}')!.title).toBe("N");
    expect(parseWorkItem('{"key":"A-1","summary":"  "}')!.title).toBe("A-1");
  });

  test("url and version fallbacks", () => {
    const a = parseWorkItem('{"key":"A-1","html_url":"https://gh/1","updated_at":"v9"}')!;
    expect(a.url).toBe("https://gh/1");
    expect(a.version).toBe("v9");
    const b = parseWorkItem('{"key":"A-1","self":"https://api/1","updatedAt":"x","version":"y"}')!;
    expect(b.url).toBe("https://api/1");
    expect(b.version).toBe("y"); // version outranks updatedAt
    const c = parseWorkItem('{"key":"A-1","url":5,"updated":{}}')!;
    expect(c.url).toBeNull();
    expect(c.version).toBeNull();
    expect(parseWorkItem('{"key":"A-1","version":17}')!.version).toBe("17");
  });

  test("rejects blank, non-JSON, non-objects and keyless objects", () => {
    expect(parseWorkItem("")).toBeNull();
    expect(parseWorkItem("   \r")).toBeNull();
    expect(parseWorkItem("watch-jira: polling…")).toBeNull();
    expect(parseWorkItem('{"key": "A-1"')).toBeNull();
    expect(parseWorkItem('["A-1"]')).toBeNull();
    expect(parseWorkItem('"A-1"')).toBeNull();
    expect(parseWorkItem('{"summary":"no key"}')).toBeNull();
    expect(parseWorkItem('{"key": null, "id": false}')).toBeNull();
  });

  test("tolerates CRLF", () => {
    expect(parseWorkItem('{"key":"A-1"}\r')!.key).toBe("A-1");
  });
});

// ---------------------------------------------------------------------------
// matchMapping
// ---------------------------------------------------------------------------

function mapping(pattern: string, projectId = pattern): Mapping {
  return { id: `m-${pattern}`, pattern, projectId, notes: "", createdAt: 0 };
}

describe("matchMapping", () => {
  test("prefix matches only on a PREFIX- boundary, case-insensitively", () => {
    const ms = [mapping("FOO")];
    expect(matchMapping("FOO-1", ms)?.projectId).toBe("FOO");
    expect(matchMapping("foo-12", ms)?.projectId).toBe("FOO");
    expect(matchMapping("FOOBAR-1", ms)).toBeNull();
    expect(matchMapping("FOO", ms)).toBeNull();
    expect(matchMapping("XFOO-1", ms)).toBeNull();
  });

  test("a trailing dash in the pattern is accepted", () => {
    expect(matchMapping("FOO-1", [mapping("foo-")])?.projectId).toBe("foo-");
  });

  test("longest prefix wins regardless of order", () => {
    const ms = [mapping("FOO", "short"), mapping("FOO-BAR", "long")];
    expect(matchMapping("FOO-BAR-3", ms)?.projectId).toBe("long");
    expect(matchMapping("FOO-3", ms)?.projectId).toBe("short");
    expect(matchMapping("FOO-BAR-3", [...ms].reverse())?.projectId).toBe("long");
  });

  test("regexes are checked after prefixes, in list order", () => {
    const ms = [mapping("/.*/", "catchall"), mapping("/^OPS-\\d+$/", "ops"), mapping("OPS", "prefix")];
    expect(matchMapping("OPS-1", ms)?.projectId).toBe("prefix");
    expect(matchMapping("ZED-1", ms)?.projectId).toBe("catchall");
    const ordered = [mapping("/^OPS-\\d+$/", "ops"), mapping("/.*/", "catchall")];
    expect(matchMapping("OPS-1", ordered)?.projectId).toBe("ops");
  });

  test("regex flags apply and g does not make matching stateful", () => {
    expect(matchMapping("ops-1", [mapping("/^OPS-/i", "ops")])?.projectId).toBe("ops");
    expect(matchMapping("ops-1", [mapping("/^OPS-/", "ops")])).toBeNull();
    const g = [mapping("/^OPS-/g", "ops")];
    expect(matchMapping("OPS-1", g)?.projectId).toBe("ops");
    expect(matchMapping("OPS-1", g)?.projectId).toBe("ops");
  });

  test("invalid regexes are ignored", () => {
    const ms = [mapping("/([/", "broken"), mapping("/^A-/", "a")];
    expect(matchMapping("A-1", ms)?.projectId).toBe("a");
    expect(matchMapping("B-1", ms)).toBeNull();
  });

  test("no mappings, no match", () => {
    expect(matchMapping("A-1", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WatcherRunner with a fake spawn
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

class FakeProc {
  killed = false;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private closed = false;
  readonly stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.out = c) });
  readonly stderr = new ReadableStream<Uint8Array>({ start: (c) => void (this.err = c) });
  readonly exited = new Promise<number>((r) => (this.resolveExit = r));
  readonly startedAt = Date.now();

  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly opts: { cwd?: string; env?: Record<string, string> },
  ) {}

  write(text: string) {
    if (!this.closed) this.out.enqueue(enc.encode(text));
  }
  line(obj: unknown) {
    this.write(JSON.stringify(obj) + "\n");
  }
  writeErr(text: string) {
    if (!this.closed) this.err.enqueue(enc.encode(text));
  }
  exit(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.out.close();
    this.err.close();
    this.resolveExit(code);
  }
  kill() {
    this.killed = true;
    this.exit(143);
  }
}

/** Spawn fake whose processes are driven by `script` (called once per spawn). */
function fakeSpawn(script: (p: FakeProc, n: number) => void = () => {}) {
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const p = new FakeProc(cmd, args, opts);
    procs.push(p);
    queueMicrotask(() => script(p, procs.length - 1));
    return p;
  };
  return { spawn, procs };
}

function watcher(patch: Partial<Watcher> = {}): Watcher {
  return {
    id: "w1",
    name: "test",
    command: "watch",
    args: [],
    cwd: null,
    env: {},
    mode: "loop",
    intervalSec: 60,
    enabled: true,
    driver: null,
    lastRunAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const FAST: Partial<WatcherTiming> = {
  batchIdleMs: 20,
  batchMaxMs: 200,
  restartDelayMs: 10,
  backoffBaseMs: 40,
  backoffMaxMs: 1000,
  minIntervalMs: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

type StatusPatch = { lastRunAt?: number; lastError?: string | null };

function harness(spawn: SpawnFn, timing: Partial<WatcherTiming> = FAST, onItems?: (w: Watcher, items: WorkItem[]) => void | Promise<void>) {
  const batches: { watcher: Watcher; items: WorkItem[] }[] = [];
  const statuses: { id: string; patch: StatusPatch }[] = [];
  const runner = new WatcherRunner({
    spawn,
    timing,
    onItems: onItems ?? ((w, items) => void batches.push({ watcher: w, items })),
    onStatus: (id, patch) => void statuses.push({ id, patch }),
  });
  const errors = () => statuses.filter((s) => "lastError" in s.patch).map((s) => s.patch.lastError);
  return { runner, batches, statuses, errors };
}

let active: WatcherRunner[] = [];
afterEach(async () => {
  await Promise.all(active.map((r) => r.stopAll()));
  active = [];
});
function track<T extends { runner: WatcherRunner }>(h: T): T {
  active.push(h.runner);
  return h;
}

describe("WatcherRunner loop mode", () => {
  test("delivers items and re-runs after exit 0", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n === 0) {
        p.line({ key: "A-1", summary: "one" });
        p.line({ key: "A-2", summary: "two" });
        p.exit(0);
      }
    });
    const h = track(harness(spawn));
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 2, 2000, "restart");
    expect(h.batches.flatMap((b) => b.items.map((i) => i.key))).toEqual(["A-1", "A-2"]);
    expect(h.errors()).toEqual([null]);
    expect(h.statuses.filter((s) => s.patch.lastRunAt !== undefined).length).toBeGreaterThanOrEqual(2);
  });

  test("exit 4 (nothing to report) restarts promptly without an error", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(4));
    const h = track(harness(spawn, { ...FAST, restartDelayMs: 10, backoffBaseMs: 5000 }));
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 3, 1000, "three runs");
    expect(h.errors().every((e) => e === null)).toBe(true);
    expect(h.batches).toHaveLength(0);
  });

  test("failures report stderr and back off exponentially; success resets", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n < 3) {
        p.writeErr("x".repeat(3000) + "auth rejected\n");
        p.exit(1);
      } else {
        p.exit(4);
      }
    });
    const h = track(harness(spawn, { ...FAST, backoffBaseMs: 50, restartDelayMs: 10 }));
    h.runner.sync([watcher({ command: "watch-jira" })]);
    await waitFor(() => procs.length >= 5, 3000, "five runs");
    const err = h.errors().find((e) => typeof e === "string")!;
    expect(err).toContain("watch-jira exited with code 1");
    expect(err).toContain("auth rejected");
    expect(err.length).toBeLessThan(2200); // stderr tail only
    const gap = (i: number) => procs[i]!.startedAt - procs[i - 1]!.startedAt;
    expect(gap(1)).toBeGreaterThanOrEqual(45); // 50ms
    expect(gap(2)).toBeGreaterThanOrEqual(95); // 100ms
    expect(gap(3)).toBeGreaterThanOrEqual(195); // 200ms
    expect(gap(4)).toBeLessThan(150); // exit 4 after success → restart delay, not backoff
    expect(h.errors().at(-1)).toBeNull();
  });

  test("backoff is capped", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(1));
    const h = track(harness(spawn, { ...FAST, backoffBaseMs: 20, backoffMaxMs: 40 }));
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 6, 3000, "six runs");
    const gap = procs[5]!.startedAt - procs[4]!.startedAt; // uncapped would be 320ms
    expect(gap).toBeLessThan(150);
  });

  test("a spawn that throws is reported and retried", async () => {
    let calls = 0;
    const inner = fakeSpawn((p) => p.exit(4));
    const spawn: SpawnFn = (cmd, args, opts) => {
      if (calls++ === 0) throw new Error("ENOENT: no such file");
      return inner.spawn(cmd, args, opts);
    };
    const h = track(harness(spawn));
    h.runner.sync([watcher({ command: "nope" })]);
    await waitFor(() => inner.procs.length >= 1, 2000, "retry");
    expect(h.errors()[0]).toContain("ENOENT");
  });

  test("batches a long-lived stream while it is still running", async () => {
    let proc!: FakeProc;
    const { spawn } = fakeSpawn((p) => (proc = p));
    const h = track(harness(spawn, { ...FAST, batchIdleMs: 30 }));
    h.runner.sync([watcher()]);
    await waitFor(() => !!proc, 1000, "spawn");
    proc.line({ key: "A-1" });
    proc.line({ key: "A-2" });
    proc.line({ key: "A-3" });
    await waitFor(() => h.batches.length === 1, 1000, "first batch");
    expect(h.batches[0]!.items.map((i) => i.key)).toEqual(["A-1", "A-2", "A-3"]);
    proc.line({ key: "A-4" });
    await waitFor(() => h.batches.length === 2, 1000, "second batch");
    expect(h.batches[1]!.items.map((i) => i.key)).toEqual(["A-4"]);
    expect(proc.killed).toBe(false);
  });

  test("a steady trickle is still flushed by the max batch age", async () => {
    let proc!: FakeProc;
    const { spawn } = fakeSpawn((p) => (proc = p));
    const h = track(harness(spawn, { ...FAST, batchIdleMs: 60, batchMaxMs: 100 }));
    h.runner.sync([watcher()]);
    await waitFor(() => !!proc, 1000, "spawn");
    for (let i = 0; i < 12; i++) {
      proc.line({ key: `T-${i}` });
      await sleep(20); // never idle for 60ms
    }
    expect(h.batches.length).toBeGreaterThanOrEqual(1);
    expect(h.batches.length).toBeLessThan(12);
  });

  test("reassembles lines split across chunks and keeps a final unterminated line", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.write('{"key":"S-');
      p.write('1"}\nnot json\n\n{"ke');
      p.write('y":"S-2"}');
      p.exit(0);
    });
    const h = track(harness(spawn, { ...FAST, restartDelayMs: 10_000 }));
    h.runner.sync([watcher()]);
    await waitFor(() => h.batches.flatMap((b) => b.items).length >= 2, 1000, "items");
    expect(h.batches.flatMap((b) => b.items.map((i) => i.key))).toEqual(["S-1", "S-2"]);
  });

  test("an onItems throw is reported and does not stop the runner", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      p.line({ key: `E-${n}` });
      p.exit(0);
    });
    const seen: string[] = [];
    const h = track(
      harness(spawn, FAST, (_w, items) => {
        seen.push(...items.map((i) => i.key));
        if (seen.length === 1) throw new Error("db locked");
      }),
    );
    h.runner.sync([watcher()]);
    await waitFor(() => seen.length >= 3, 2000, "later deliveries");
    expect(h.errors()[0]).toBe("Failed to handle items: db locked");
    // The run whose delivery failed must not clear its own error on exit 0: between the
    // first and second run starts, the only error patch is the failure.
    const starts = h.statuses.flatMap((s, i) => (s.patch.lastRunAt !== undefined ? [i] : []));
    const firstRun = h.statuses.slice(starts[0], starts[1]).filter((s) => "lastError" in s.patch);
    expect(firstRun.map((s) => s.patch.lastError)).toEqual(["Failed to handle items: db locked"]);
    expect(h.errors().at(-1)).toBeNull();
    expect(procs.length).toBeGreaterThanOrEqual(3);
  });

  test("async onItems rejections are caught too", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.line({ key: "R-1" });
      p.exit(0);
    });
    const h = track(harness(spawn, { ...FAST, restartDelayMs: 10_000 }, async () => {
      throw new Error("async boom");
    }));
    h.runner.sync([watcher()]);
    await waitFor(() => h.errors().length > 0, 1000, "error");
    expect(h.errors()[0]).toContain("async boom");
  });

  test("runNow kills a blocking child and restarts at once without an error", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = track(harness(spawn, { ...FAST, restartDelayMs: 10_000, backoffBaseMs: 10_000 }));
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, 1000, "spawn");
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, 1000, "restart");
    expect(procs[0]!.killed).toBe(true);
    expect(h.errors().filter((e) => e !== null)).toEqual([]);
  });

  test("runNow cancels a pending backoff", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => (n === 0 ? p.exit(1) : undefined));
    const h = track(harness(spawn, { ...FAST, backoffBaseMs: 60_000 }));
    h.runner.sync([watcher()]);
    await waitFor(() => h.errors().length === 1, 1000, "failure");
    await sleep(10);
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, 1000, "immediate re-run");
  });
});

describe("WatcherRunner interval mode", () => {
  test("runs every intervalSec and skips a tick while still running", async () => {
    const { spawn, procs } = fakeSpawn(); // first run hangs until we exit it
    const h = track(harness(spawn));
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.03 })]);
    await waitFor(() => procs.length === 1, 1000, "first run");
    await sleep(150); // ~5 ticks
    expect(procs.length).toBe(1);
    procs[0]!.exit(4);
    await waitFor(() => procs.length >= 2, 1000, "next tick");
    procs[1]!.exit(0);
    await waitFor(() => procs.length >= 3, 1000, "another tick");
  });

  test("interval is floored by minIntervalMs", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(4));
    const h = track(harness(spawn, { ...FAST, minIntervalMs: 10_000 }));
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.01 })]);
    await waitFor(() => procs.length === 1, 1000, "first run");
    await sleep(100);
    expect(procs.length).toBe(1);
  });

  test("a failing interval run reports the error but keeps the schedule", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n === 0) {
        p.writeErr("rate limited");
        p.exit(1);
      } else p.exit(0);
    });
    const h = track(harness(spawn));
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.03 })]);
    await waitFor(() => procs.length >= 2, 1000, "second run");
    await waitFor(() => h.errors().length >= 2, 1000, "cleared");
    expect(h.errors()[0]).toContain("rate limited");
    expect(h.errors()[1]).toBeNull();
  });

  test("runNow starts a run immediately, but not a second concurrent one", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = track(harness(spawn, { ...FAST, minIntervalMs: 60_000 }));
    h.runner.sync([watcher({ mode: "interval", intervalSec: 3600 })]);
    await waitFor(() => procs.length === 1, 1000, "first run");
    await h.runner.runNow("w1");
    await sleep(20);
    expect(procs.length).toBe(1);
    procs[0]!.exit(0);
    await sleep(20);
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, 1000, "manual run");
  });
});

describe("WatcherRunner sync", () => {
  test("starts enabled watchers only, passes cwd/env/args", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = track(harness(spawn));
    h.runner.sync([
      watcher({ id: "a", args: ["-p", "FOO"], cwd: "/tmp", env: { JIRA_EMAIL: "x" } }),
      watcher({ id: "b", enabled: false }),
    ]);
    await waitFor(() => procs.length === 1, 1000, "spawn");
    await sleep(30);
    expect(procs.length).toBe(1);
    expect(procs[0]!.args).toEqual(["-p", "FOO"]);
    expect(procs[0]!.opts).toEqual({ cwd: "/tmp", env: { JIRA_EMAIL: "x" } });
  });

  test("stops removed and disabled watchers", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = track(harness(spawn));
    h.runner.sync([watcher({ id: "a" }), watcher({ id: "b" })]);
    await waitFor(() => procs.length === 2, 1000, "spawns");
    h.runner.sync([watcher({ id: "b", enabled: false })]);
    await waitFor(() => procs.every((p) => p.killed), 1000, "kills");
    await sleep(40);
    expect(procs.length).toBe(2); // killed on purpose → no restart
    expect(h.errors().filter((e) => e !== null)).toEqual([]);
  });

  test("restarts on command changes, not on cosmetic ones", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = track(harness(spawn));
    const w = watcher();
    h.runner.sync([w]);
    await waitFor(() => procs.length === 1, 1000, "spawn");

    h.runner.sync([{ ...w, name: "renamed", driver: "dummy", updatedAt: 5 }]);
    await sleep(40);
    expect(procs.length).toBe(1);
    expect(procs[0]!.killed).toBe(false);

    h.runner.sync([{ ...w, name: "renamed", args: ["--follow"] }]);
    await waitFor(() => procs.length === 2, 1000, "restart");
    expect(procs[0]!.killed).toBe(true);
    expect(procs[1]!.args).toEqual(["--follow"]);

    h.runner.sync([{ ...w, name: "renamed", args: ["--follow"], env: { A: "1" } }]);
    await waitFor(() => procs.length === 3, 1000, "env restart");
    expect(procs[1]!.killed).toBe(true);
  });

  test("items are delivered with the latest watcher object", async () => {
    let proc!: FakeProc;
    const { spawn } = fakeSpawn((p) => (proc = p));
    const h = track(harness(spawn));
    const w = watcher();
    h.runner.sync([w]);
    await waitFor(() => !!proc, 1000, "spawn");
    h.runner.sync([{ ...w, driver: "claude-code" }]);
    proc.line({ key: "D-1" });
    await waitFor(() => h.batches.length === 1, 1000, "batch");
    expect(h.batches[0]!.watcher.driver).toBe("claude-code");
  });

  test("runNow on a disabled watcher does a one-off run; unknown ids throw", async () => {
    const { spawn, procs } = fakeSpawn((p) => {
      p.line({ key: "O-1" });
      p.exit(0);
    });
    const h = track(harness(spawn));
    h.runner.sync([watcher({ enabled: false })]);
    await sleep(20);
    expect(procs.length).toBe(0);
    await h.runner.runNow("w1");
    await waitFor(() => h.batches.length === 1, 1000, "one-off items");
    await sleep(40);
    expect(procs.length).toBe(1); // not looped
    await expect(h.runner.runNow("missing")).rejects.toThrow("Unknown watcher");
  });

  test("stopAll kills everything and nothing restarts", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ id: "a" }), watcher({ id: "b", mode: "interval", intervalSec: 0.02 })]);
    await waitFor(() => procs.length === 2, 1000, "spawns");
    await h.runner.stopAll();
    expect(procs.every((p) => p.killed)).toBe(true);
    await sleep(60);
    expect(procs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Real processes
// ---------------------------------------------------------------------------

describe("WatcherRunner with Bun.spawn", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watchers-"));
  const script = join(dir, "emit.ts");
  writeFileSync(
    script,
    `const mode = process.argv[2];
if (mode === "fail") { console.error("watch: bad credentials"); process.exit(1); }
console.log(JSON.stringify({ key: "REAL-1", summary: "from " + process.env.HARNESS_TEST_VAR, cwd: process.cwd(), hasPath: !!process.env.PATH }));
console.log("noise that is not json");
await Bun.sleep(20);
console.log(JSON.stringify({ key: "REAL-2", updated: "v2" }));
process.exit(4);
`,
  );

  test("emits NDJSON items with the watcher env and cwd", async () => {
    // No spawn override: exercises the default Bun.spawn implementation.
    const batches: WorkItem[][] = [];
    const errors: (string | null | undefined)[] = [];
    const runner = new WatcherRunner({
      onItems: (_w, items) => void batches.push(items),
      onStatus: (_id, patch) => void ("lastError" in patch && errors.push(patch.lastError)),
      timing: { ...FAST, minIntervalMs: 60_000 },
    });
    active.push(runner);
    runner.sync([
      watcher({ mode: "interval", intervalSec: 3600, command: process.execPath, args: [script], cwd: dir, env: { HARNESS_TEST_VAR: "env" } }),
    ]);
    await waitFor(() => errors.length > 0, 10_000, "exit");
    const items = batches.flat();
    expect(items.map((i) => i.key)).toEqual(["REAL-1", "REAL-2"]);
    const raw = items[0]!.raw as { summary: string; cwd: string; hasPath: boolean };
    expect(items[0]!.title).toBe("from env");
    expect(raw.hasPath).toBe(true); // merged over process.env
    expect(raw.cwd.endsWith(dir.split("/").pop()!)).toBe(true);
    expect(items[1]!.version).toBe("v2");
    expect(errors).toEqual([null]);
  });

  test("a failing process reports its stderr", async () => {
    const errors: (string | null | undefined)[] = [];
    const runner = new WatcherRunner({
      onItems: () => {},
      onStatus: (_id, patch) => void ("lastError" in patch && errors.push(patch.lastError)),
      timing: { ...FAST, backoffBaseMs: 60_000 },
    });
    active.push(runner);
    runner.sync([watcher({ command: process.execPath, args: [script, "fail"] })]);
    await waitFor(() => errors.length > 0, 10_000, "failure");
    expect(errors[0]).toContain("exited with code 1");
    expect(errors[0]).toContain("watch: bad credentials");
  });

  test("a missing executable is reported, not thrown", async () => {
    const errors: (string | null | undefined)[] = [];
    const runner = new WatcherRunner({
      onItems: () => {},
      onStatus: (_id, patch) => void ("lastError" in patch && errors.push(patch.lastError)),
      timing: { ...FAST, backoffBaseMs: 60_000 },
    });
    active.push(runner);
    runner.sync([watcher({ command: join(dir, "does-not-exist") })]);
    await waitFor(() => errors.length > 0, 5000, "failure");
    expect(errors[0]).toBeTruthy();
  });
});
