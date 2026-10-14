// WatcherRunner on fake processes: the argv it builds, how it batches stdout into Inbox chunks, what
// it reports from stderr and exit codes, its restart/backoff schedule, and that it kills what it
// stops. What only a real process can show (bunSpawn's env merge, cwd, stderr pipe and process-group
// kill) is next/contract/watcher-spawn.test.ts.

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import type { Watcher, WatcherLive } from "@harness/shared";
import {
  findKeys,
  loginShell,
  toOutput,
  watcherArgv,
  WatcherRunner,
  type SpawnFn,
  type WatcherOutput,
  type WatcherTiming,
} from "../../service/src/orchestrator/watchers";
import { fakeSpawn, watcher } from "../support/fake-spawn";
import { afterTest } from "../support/teardown";
import { waitFor } from "../support/wait";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

describe("toOutput", () => {
  test("trims, and whitespace-only output is nothing", () => {
    expect(toOutput("\n  hello\n\n")).toEqual({ text: "hello", truncated: false });
    expect(toOutput(" \n\t\r\n")).toBeNull();
    expect(toOutput("")).toBeNull();
  });

  test("cuts at the limit and marks it truncated; exactly the limit is not truncated", () => {
    expect(toOutput("abcdefgh", 5)).toEqual({ text: "abcde", truncated: true });
    expect(toOutput("abcde", 5)).toEqual({ text: "abcde", truncated: false });
    expect(toOutput("abc", 5, true)).toEqual({ text: "abc", truncated: true });
  });
});

describe("findKeys", () => {
  test("finds upper-case keys once each, in order", () => {
    expect(findKeys('{"key":"FOO-12","parent":"BAR_X-3"} see FOO-12 and foo-9, notFOO-4')).toEqual(["FOO-12", "BAR_X-3"]);
  });

  test("is capped", () => {
    expect(findKeys("A-1 A-2 A-3 A-4", 2)).toEqual(["A-1", "A-2"]);
  });
});

describe("watcherArgv", () => {
  test("a command line runs through the login shell", () => {
    expect(watcherArgv({ command: "while true; do curl -s x | jq .; sleep 60; done", args: [] }, "/bin/zsh")).toEqual([
      "/bin/zsh",
      ["-lc", "while true; do curl -s x | jq .; sleep 60; done"],
    ]);
  });

  test("a legacy command + args is spawned directly, without a shell", () => {
    expect(watcherArgv({ command: "node", args: ["watch-jira.js", "--project", "FOO BAR"] }, "/bin/zsh")).toEqual([
      "node",
      ["watch-jira.js", "--project", "FOO BAR"],
    ]);
  });

  test("loginShell uses an absolute $SHELL and falls back otherwise", () => {
    expect(loginShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(loginShell({ SHELL: "zsh" })).toMatch(/^\/bin\/(zsh|sh)$/);
    expect(loginShell({})).toMatch(/^\/bin\/(zsh|sh)$/);
  });
});

// ---------------------------------------------------------------------------
// WatcherRunner with a fake spawn
// ---------------------------------------------------------------------------

/** Small enough to keep each test in milliseconds; every test that cares overrides what it checks. */
const FAST: Partial<WatcherTiming> = {
  batchIdleMs: 5,
  batchMaxMs: 50,
  restartDelayMs: 2,
  backoffBaseMs: 4,
  backoffMaxMs: 1000,
  minIntervalMs: 0,
};

/** A pause for "nothing else happens" checks, under the guard's 25ms limit. */
const pause = (ms = 15) => Bun.sleep(ms);

type StatusPatch = { lastRunAt?: number; lastError?: string | null };

function harness(
  spawn: SpawnFn,
  timing: Partial<WatcherTiming> = FAST,
  onOutput?: (w: Watcher, output: WatcherOutput) => void | Promise<void>,
  maxOutputChars?: number,
) {
  const outputs: { watcher: Watcher; text: string; truncated: boolean }[] = [];
  const statuses: { id: string; patch: StatusPatch }[] = [];
  const lives: { id: string; live: WatcherLive }[] = [];
  const runner = new WatcherRunner({
    spawn,
    timing,
    shell: "/bin/test-sh",
    maxOutputChars,
    onOutput: onOutput ?? ((w, o) => void outputs.push({ watcher: w, ...o })),
    onStatus: (id, patch) => void statuses.push({ id, patch }),
    onLive: (id, live) => void lives.push({ id, live }),
  });
  afterTest(() => runner.stopAll());
  /** The sequence of reported states for one watcher */
  const states = (id = "w1") => lives.filter((l) => l.id === id).map((l) => l.live.state);
  const errors = () => statuses.filter((s) => "lastError" in s.patch).map((s) => s.patch.lastError);
  /** Only the errors that were set, not the clears */
  const failures = () => errors().filter((e): e is string => typeof e === "string");
  const texts = () => outputs.map((o) => o.text);
  /** The delays the runner scheduled before each re-run, from the waits it reported (ms) */
  const delays = (id = "w1") => lives.filter((l) => l.id === id && l.live.nextRunAt !== null).map((l) => l.live.nextRunAt! - l.live.since);
  return { runner, outputs, texts, statuses, errors, failures, lives, states, delays };
}

/** Each actual delay snapped to the expected one when within `tol` ms (the report stamps `since` a moment after scheduling). */
const snap = (actual: number[], expected: number[], tol = 2) => actual.map((d, i) => (expected[i] !== undefined && Math.abs(d - expected[i]!) <= tol ? expected[i]! : d));

describe("WatcherRunner loop mode", () => {
  test("delivers a run's output as one chunk and re-runs after exit 0", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n === 0) {
        p.line({ key: "A-1", summary: "one" });
        p.write("plain text, not json\n");
        p.exit(0);
      }
    });
    const h = harness(spawn);
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 2, { label: "restart" });
    expect(h.texts()).toEqual(['{"key":"A-1","summary":"one"}\nplain text, not json']);
    expect(h.failures()).toEqual([]);
    expect(h.statuses.filter((s) => s.patch.lastRunAt !== undefined).length).toBeGreaterThanOrEqual(2);
  });

  test("exit 4 (nothing to report) restarts after the restart delay, without an error", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(4));
    const h = harness(spawn, { ...FAST, restartDelayMs: 2, backoffBaseMs: 60_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 3, { label: "three runs", timeoutMs: 1000 });
    expect(h.errors().every((e) => e === null)).toBe(true);
    expect(h.outputs).toHaveLength(0);
    expect(snap(h.delays().slice(0, 2), [2, 2])).toEqual([2, 2]);
  });

  test("failures report the stderr tail and back off exponentially; success resets to the restart delay", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n < 3) {
        p.writeErr("x".repeat(3000) + "auth rejected\n");
        p.exit(1);
      } else {
        p.exit(4);
      }
    });
    const h = harness(spawn, { ...FAST, backoffBaseMs: 4, restartDelayMs: 2 });
    h.runner.sync([watcher({ command: "watch-jira", args: ["--follow"] })]);
    await waitFor(() => procs.length >= 5, { label: "five runs" });
    const err = h.failures()[0]!;
    expect(err).toContain("watch-jira exited with code 1");
    expect(err).toContain("auth rejected");
    expect(err.length).toBeLessThan(2200); // stderr tail only
    // 4, 8, 16ms after the three failures; the restart delay once a run succeeds
    expect(snap(h.delays().slice(0, 4), [4, 8, 16, 2])).toEqual([4, 8, 16, 2]);
    expect(h.errors().at(-1)).toBeNull();
  });

  test("backoff is capped", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(1));
    const h = harness(spawn, { ...FAST, backoffBaseMs: 2, backoffMaxMs: 4 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length >= 6, { label: "six runs" });
    expect(snap(h.delays().slice(0, 5), [2, 4, 4, 4, 4])).toEqual([2, 4, 4, 4, 4]); // uncapped: 2, 4, 8, 16, 32
    expect(h.runner.live("w1")!.failures).toBeGreaterThanOrEqual(5);
  });

  test("a spawn that throws is reported and retried", async () => {
    let calls = 0;
    const inner = fakeSpawn((p) => p.exit(4));
    const spawn: SpawnFn = (cmd, args, opts) => {
      if (calls++ === 0) throw new Error("ENOENT: no such file");
      return inner.spawn(cmd, args, opts);
    };
    const h = harness(spawn);
    h.runner.sync([watcher({ command: "nope" })]);
    await waitFor(() => inner.procs.length >= 1, { label: "retry" });
    expect(h.errors()[0]).toBe("Failed to start nope: ENOENT: no such file");
  });

  test("splits a long-lived stream into bursts while it is still running", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    const proc = procs[0]!;
    proc.write("event 1\n");
    proc.write("event 1 detail\n");
    await waitFor(() => h.outputs.length === 1, { label: "first burst" });
    expect(h.texts()).toEqual(["event 1\nevent 1 detail"]);
    proc.write("event 2\n");
    await waitFor(() => h.outputs.length === 2, { label: "second burst" });
    expect(h.texts()[1]).toBe("event 2");
    expect(proc.killed).toBe(false);
  });

  test("whitespace-only bursts are skipped", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    procs[0]!.write("\n   \n\t\n");
    await pause(); // past batchIdleMs: that burst is flushed (as nothing)
    procs[0]!.write("  real  \n");
    await waitFor(() => h.outputs.length === 1, { label: "burst" });
    await pause();
    expect(h.texts()).toEqual(["real"]);
  });

  test("a steady trickle is flushed by the max burst age while it is still streaming, at line ends", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, batchIdleMs: 20, batchMaxMs: 6 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    for (let i = 0; i < 12; i++) {
      procs[0]!.write(`tick ${i}\n`);
      await Bun.sleep(2); // never quiet for batchIdleMs
    }
    const during = h.outputs.length;
    expect(during).toBeGreaterThanOrEqual(1);
    expect(during).toBeLessThan(12);
    for (const t of h.texts()) expect(t).toMatch(/^(tick \d+\n)*tick \d+$/);
  });

  test("an idle flush delivers everything, including a last line without a newline", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, restartDelayMs: 10_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    procs[0]!.write("line one\nline tw");
    await waitFor(() => h.outputs.length === 1, { label: "first burst" });
    await pause();
    expect(h.texts()).toEqual(["line one\nline tw"]);
  });

  test("pretty JSON without a trailing newline stays one item per response", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, batchMaxMs: 500, restartDelayMs: 10_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    const body = '{\n  "event": "assigned",\n  "to": "mark"\n}';
    procs[0]!.write(body); // like curl against an API that doesn't end its body with a newline
    await waitFor(() => h.outputs.length === 1, { label: "first response" });
    procs[0]!.write(body.replace("mark", "sam"));
    await waitFor(() => h.outputs.length === 2, { label: "second response" });
    await pause();
    expect(h.texts()).toEqual([body, body.replace("mark", "sam")]);
  });

  test("a max-age flush while output is still streaming keeps the partial line", async () => {
    const { spawn, procs } = fakeSpawn();
    // Idle longer than the max age: every flush here is a max-age one.
    const h = harness(spawn, { ...FAST, batchIdleMs: 200, batchMaxMs: 5, restartDelayMs: 10_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    procs[0]!.write("line one\nline tw");
    procs[0]!.write("o");
    await waitFor(() => h.outputs.length === 1, { label: "max-age flush" });
    expect(h.texts()[0]).toBe("line one");
    procs[0]!.write(" done\n");
    await waitFor(() => h.outputs.length === 2, { label: "rest" });
    expect(h.texts()[1]).toBe("line two done");
  });

  test("a huge burst is cut at maxOutputChars and marked truncated", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.write("a".repeat(30) + "\n");
      p.write("b".repeat(30) + "\n");
      p.exit(0);
    });
    const h = harness(spawn, { ...FAST, restartDelayMs: 10_000 }, undefined, 40);
    h.runner.sync([watcher()]);
    await waitFor(() => h.outputs.length === 1, { label: "burst" });
    await pause();
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.truncated).toBe(true);
    expect(h.outputs[0]!.text).toBe("a".repeat(30) + "\n" + "b".repeat(9));
  });

  test("an onOutput throw is reported and does not stop the runner", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      p.write(`E-${n}\n`);
      p.exit(0);
    });
    const seen: string[] = [];
    const h = harness(spawn, FAST, (_w, o) => {
      seen.push(o.text);
      if (seen.length === 1) throw new Error("db locked");
    });
    h.runner.sync([watcher()]);
    await waitFor(() => seen.length >= 3, { label: "later deliveries" });
    expect(h.failures()[0]).toBe("Failed to handle output: db locked");
    // The run whose delivery failed must not clear its own error on exit 0: between the
    // first and second run starts, the only error patches are the clear at spawn and the failure.
    const starts = h.statuses.flatMap((s, i) => (s.patch.lastRunAt !== undefined ? [i] : []));
    const firstRun = h.statuses.slice(starts[0], starts[1]).filter((s) => "lastError" in s.patch);
    expect(firstRun.map((s) => s.patch.lastError)).toEqual([null, "Failed to handle output: db locked"]);
    expect(h.errors().at(-1)).toBeNull();
    expect(procs.length).toBeGreaterThanOrEqual(3);
  });

  test("async onOutput rejections are caught too", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.write("R-1\n");
      p.exit(0);
    });
    const h = harness(spawn, { ...FAST, restartDelayMs: 10_000 }, async () => {
      throw new Error("async boom");
    });
    h.runner.sync([watcher()]);
    await waitFor(() => h.failures().length > 0, { label: "error" });
    expect(h.failures()[0]).toBe("Failed to handle output: async boom");
  });

  test("runNow kills a blocking child and restarts at once without an error", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, restartDelayMs: 10_000, backoffBaseMs: 10_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, { label: "restart" });
    expect(procs[0]!.kills).toBe(1);
    expect(h.errors().filter((e) => e !== null)).toEqual([]);
  });

  test("runNow cancels a pending backoff", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => (n === 0 ? p.exit(1) : undefined));
    const h = harness(spawn, { ...FAST, backoffBaseMs: 60_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => h.runner.live("w1")?.state === "waiting" && h.runner.live("w1")!.failures === 1, { label: "backoff" });
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, { label: "immediate re-run", timeoutMs: 1000 });
  });
});

describe("WatcherRunner interval mode", () => {
  test("runs every intervalSec and skips a tick while still running", async () => {
    const { spawn, procs } = fakeSpawn(); // first run hangs until we exit it
    const h = harness(spawn);
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.004 })]);
    await waitFor(() => procs.length === 1, { label: "first run" });
    await Bun.sleep(25); // ~6 ticks
    expect(procs.length).toBe(1);
    procs[0]!.exit(4);
    await waitFor(() => procs.length >= 2, { label: "next tick" });
    procs[1]!.exit(0);
    await waitFor(() => procs.length >= 3, { label: "another tick" });
  });

  test("each run's output is one chunk, however slowly it arrives; empty runs deliver nothing", async () => {
    const { spawn, procs } = fakeSpawn(async (p, n) => {
      if (n === 0) {
        p.write("first\n");
        await Bun.sleep(15); // longer than batchIdleMs: loop mode would split here
        p.write("second\n");
      } else {
        p.write("  \n");
      }
      p.exit(0);
    });
    const h = harness(spawn, { ...FAST, batchIdleMs: 2 });
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.005 })]);
    await waitFor(() => procs.length >= 3, { label: "three runs" });
    expect(h.texts()).toEqual(["first\nsecond"]);
  });

  test("interval is floored by minIntervalMs", async () => {
    const { spawn, procs } = fakeSpawn((p) => p.exit(4));
    const h = harness(spawn, { ...FAST, minIntervalMs: 10_000 });
    const before = Date.now();
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.001 })]);
    await waitFor(() => procs.length === 1 && h.runner.live("w1")?.state === "waiting", { label: "first run" });
    expect(h.runner.live("w1")!.nextRunAt! - before).toBeGreaterThanOrEqual(10_000);
    await pause();
    expect(procs.length).toBe(1);
  });

  test("a failing interval run reports the error but keeps the schedule", async () => {
    const { spawn, procs } = fakeSpawn((p, n) => {
      if (n === 0) {
        p.writeErr("rate limited");
        p.exit(1);
      } else p.exit(0);
    });
    const h = harness(spawn);
    h.runner.sync([watcher({ mode: "interval", intervalSec: 0.005 })]);
    await waitFor(() => procs.length >= 2, { label: "second run" });
    await waitFor(() => h.errors().length >= 2, { label: "cleared" });
    expect(h.errors()[0]).toBe("Command exited with code 1: rate limited");
    expect(h.errors()[1]).toBeNull();
  });

  test("runNow starts a run immediately, but not a second concurrent one", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, minIntervalMs: 60_000 });
    h.runner.sync([watcher({ mode: "interval", intervalSec: 3600 })]);
    await waitFor(() => procs.length === 1, { label: "first run" });
    await h.runner.runNow("w1");
    await pause();
    expect(procs.length).toBe(1);
    procs[0]!.exit(0);
    await waitFor(() => h.runner.live("w1")?.state === "waiting", { label: "run finished" });
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, { label: "manual run" });
  });
});

describe("WatcherRunner sync", () => {
  test("starts enabled watchers only, and passes a legacy command's args, its env and its cwd straight to spawn", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([
      watcher({ id: "a", args: ["-p", "FOO"], cwd: "/tmp", env: { JIRA_EMAIL: "x" } }),
      watcher({ id: "b", enabled: false }),
    ]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    await pause();
    expect(procs.length).toBe(1);
    expect(procs[0]!.cmd).toBe("watch");
    expect(procs[0]!.args).toEqual(["-p", "FOO"]);
    // Only the watcher's own env: merging it over process.env is bunSpawn's job (the contract test)
    expect(procs[0]!.opts).toEqual({ cwd: "/tmp", env: { JIRA_EMAIL: "x" } });
  });

  test("a cwd under ~ is expanded to the home directory; none means the service's own", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ id: "home", cwd: "~/sites/acme" }), watcher({ id: "tilde", cwd: "~" }), watcher({ id: "none", cwd: null })]);
    await waitFor(() => procs.length === 3, { label: "spawns" });
    expect(procs.map((p) => p.opts.cwd)).toEqual([`${homedir()}/sites/acme`, homedir(), undefined]);
  });

  test("a command line without args is run through the shell", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ command: "while true; do curl -s https://x/events; sleep 60; done" })]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    expect(procs[0]!.cmd).toBe("/bin/test-sh");
    expect(procs[0]!.args).toEqual(["-lc", "while true; do curl -s https://x/events; sleep 60; done"]);
  });

  test("stops removed and disabled watchers", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ id: "a" }), watcher({ id: "b" })]);
    await waitFor(() => procs.length === 2, { label: "spawns" });
    h.runner.sync([watcher({ id: "b", enabled: false })]);
    await waitFor(() => procs.every((p) => p.killed), { label: "kills" });
    await pause();
    expect(procs.length).toBe(2); // killed on purpose → no restart
    expect(procs.map((p) => p.kills)).toEqual([1, 1]);
    expect(h.errors().filter((e) => e !== null)).toEqual([]);
  });

  test("restarts on command changes, not on cosmetic ones", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    const w = watcher();
    h.runner.sync([w]);
    await waitFor(() => procs.length === 1, { label: "spawn" });

    h.runner.sync([{ ...w, name: "renamed", driver: "dummy", prompt: "only mine", updatedAt: 5 }]);
    await pause();
    expect(procs.length).toBe(1);
    expect(procs[0]!.killed).toBe(false);

    h.runner.sync([{ ...w, name: "renamed", args: ["--follow"] }]);
    await waitFor(() => procs.length === 2, { label: "restart" });
    expect(procs[0]!.killed).toBe(true);
    expect(procs[1]!.args).toEqual(["--follow"]);

    h.runner.sync([{ ...w, name: "renamed", args: ["--follow"], env: { A: "1" } }]);
    await waitFor(() => procs.length === 3, { label: "env restart" });
    expect(procs[1]!.killed).toBe(true);
  });

  test("output is delivered with the latest watcher object (and its prompt)", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    const w = watcher();
    h.runner.sync([w]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    h.runner.sync([{ ...w, driver: "claude-code", prompt: "only mine" }]);
    procs[0]!.line({ key: "D-1" });
    await waitFor(() => h.outputs.length === 1, { label: "output" });
    expect(h.outputs[0]!.watcher.driver).toBe("claude-code");
    expect(h.outputs[0]!.watcher.prompt).toBe("only mine");
  });

  test("runNow on a disabled watcher does a one-off run; unknown ids throw", async () => {
    const { spawn, procs } = fakeSpawn((p) => {
      p.line({ key: "O-1" });
      p.exit(0);
    });
    const h = harness(spawn);
    h.runner.sync([watcher({ enabled: false })]);
    await pause();
    expect(procs.length).toBe(0);
    await h.runner.runNow("w1");
    await waitFor(() => h.outputs.length === 1, { label: "one-off output" });
    await pause();
    expect(procs.length).toBe(1); // not looped
    await expect(h.runner.runNow("missing")).rejects.toThrow("Unknown watcher");
  });

  test("stopAll kills everything and nothing restarts", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ id: "a" }), watcher({ id: "b", mode: "interval", intervalSec: 0.004 })]);
    await waitFor(() => procs.length === 2, { label: "spawns" });
    await h.runner.stopAll();
    expect(procs.map((p) => p.kills)).toEqual([1, 1]);
    await Bun.sleep(20); // several interval ticks
    expect(procs.length).toBe(2);
  });

  test("stopAll waits for a killed process to exit, then resolves", async () => {
    // A process that takes its time to die (a shell finishing a pipe): stopping must wait for the
    // run to end, not leave it running behind the service's back.
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    const proc = procs[0]!;
    proc.kill = () => void proc.kills++; // the signal is sent; the exit comes later
    let stopped = false;
    const stopping = h.runner.stopAll().then(() => (stopped = true));
    await pause(5);
    expect([proc.kills, stopped]).toEqual([1, false]);
    proc.exit(143);
    await stopping;
    expect(stopped).toBe(true);
    expect(h.failures()).toEqual([]); // an intentional stop is not a failure
  });
});

describe("WatcherRunner live state", () => {
  test("loop: a spawned process is running; a failed exit waits out the backoff with the failure count", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, backoffBaseMs: 5000, backoffMaxMs: 10_000 });
    h.runner.sync([watcher()]);
    await waitFor(() => h.runner.live("w1")?.state === "running", { label: "running" });
    const before = Date.now();
    procs[0]!.writeErr("boom\n");
    procs[0]!.exit(1);
    await waitFor(() => h.runner.live("w1")?.state === "waiting", { label: "backoff" });
    const live = h.runner.live("w1")!;
    expect(live.failures).toBe(1);
    // Backoff, not the 2ms restart delay
    expect(live.nextRunAt! - before).toBeGreaterThanOrEqual(4900);
    expect(h.failures()).toEqual(["Command exited with code 1: boom"]);
    expect(h.states()).toEqual(["waiting", "running", "waiting"]);
    expect(procs).toHaveLength(1);
  });

  test("loop: a process that stays up clears a stale error from an earlier run", async () => {
    // The jira-sprint case: an old failure kept showing while the new process ran fine.
    const { spawn } = fakeSpawn(); // never exits
    const h = harness(spawn);
    h.runner.sync([watcher({ lastError: "Failed to start …: ENOENT" })]);
    await waitFor(() => h.runner.live("w1")?.state === "running", { label: "running" });
    expect(h.errors()).toEqual([null]);
  });

  test("loop: a clean exit resets the failure count", async () => {
    const { spawn } = fakeSpawn((p, n) => p.exit(n === 0 ? 1 : 0));
    const h = harness(spawn, { ...FAST, backoffBaseMs: 2, restartDelayMs: 5000 });
    h.runner.sync([watcher()]);
    await waitFor(() => h.lives.filter((l) => l.live.state === "waiting").length >= 3, { label: "second wait" });
    expect(h.lives.filter((l) => l.live.state === "waiting").map((l) => l.live.failures)).toEqual([0, 1, 0]);
  });

  test("a spawn failure is an error and a wait, never running", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT: no such file or directory, posix_spawn 'nope'");
    };
    const h = harness(spawn, { ...FAST, backoffBaseMs: 5000, backoffMaxMs: 10_000 });
    h.runner.sync([watcher({ command: "nope" })]);
    await waitFor(() => h.runner.live("w1")?.failures === 1, { label: "failure" });
    expect(h.runner.live("w1")).toMatchObject({ state: "waiting", failures: 1 });
    expect(h.runner.live("w1")!.nextRunAt).toBeGreaterThan(Date.now() + 4000);
    expect(h.states()).not.toContain("running");
    expect(h.failures()[0]).toContain("Failed to start nope: ENOENT");
  });

  test("interval: running during a run, then waiting for the next tick; failures count across runs", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn, { ...FAST, minIntervalMs: 0 });
    const start = Date.now();
    h.runner.sync([watcher({ mode: "interval", intervalSec: 60 })]);
    await waitFor(() => procs.length === 1, { label: "spawn" });
    expect(h.runner.live("w1")?.state).toBe("running");
    procs[0]!.exit(2);
    await waitFor(() => h.runner.live("w1")?.state === "waiting", { label: "waiting" });
    const live = h.runner.live("w1")!;
    expect(live.failures).toBe(1);
    expect(live.nextRunAt! - start).toBeGreaterThanOrEqual(60_000);
    expect(live.nextRunAt! - start).toBeLessThan(61_000);
    // An interval run's error isn't cleared when the next run starts, only when one succeeds.
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 2, { label: "second run" });
    expect(h.errors()).toEqual(["Command exited with code 2"]);
    procs[1]!.exit(0);
    await waitFor(() => h.runner.live("w1")?.failures === 0, { label: "reset" });
    expect(h.errors().at(-1)).toBeNull();
  });

  test("disabling or removing stops it; a disabled watcher is stopped from the start", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher(), watcher({ id: "off", enabled: false })]);
    await waitFor(() => h.runner.live("w1")?.state === "running", { label: "running" });
    expect(h.runner.live("off")).toMatchObject({ state: "stopped", nextRunAt: null });
    h.runner.sync([watcher({ enabled: false }), watcher({ id: "off", enabled: false })]);
    expect(h.runner.live("w1")?.state).toBe("stopped");
    await waitFor(() => procs[0]!.killed, { label: "kill" });
    await pause();
    expect(h.states().at(-1)).toBe("stopped"); // the killed process's exit doesn't report a wait
    h.runner.sync([]);
    expect(h.runner.live("w1")).toBeUndefined();
  });

  test("a restart on a command change reports the new process, not the old one's exit", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher()]);
    await waitFor(() => procs.length === 1, { label: "first" });
    h.runner.sync([watcher({ command: "watch --v2" })]);
    await waitFor(() => procs.length === 2, { label: "second" });
    await pause();
    expect(procs[0]!.killed).toBe(true);
    expect(h.runner.live("w1")?.state).toBe("running");
    expect(h.states()).not.toContain("stopped");
  });

  test("a one-off run of a disabled watcher is running, then stopped again", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ enabled: false, mode: "interval" })]);
    await h.runner.runNow("w1");
    await waitFor(() => procs.length === 1, { label: "spawn" });
    expect(h.runner.live("w1")?.state).toBe("running");
    procs[0]!.exit(0);
    await waitFor(() => h.runner.live("w1")?.state === "stopped", { label: "stopped" });
    expect(h.states()).toEqual(["stopped", "running", "stopped"]);
  });

  test("stopAll reports every watcher stopped", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = harness(spawn);
    h.runner.sync([watcher({ id: "a" }), watcher({ id: "b", mode: "interval" })]);
    await waitFor(() => procs.length === 2, { label: "spawns" });
    await h.runner.stopAll();
    await pause();
    expect([h.runner.live("a")?.state, h.runner.live("b")?.state]).toEqual(["stopped", "stopped"]);
    expect([h.states("a").at(-1), h.states("b").at(-1)]).toEqual(["stopped", "stopped"]);
  });
});
