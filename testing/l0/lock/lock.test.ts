import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooldownReason, leftoverProcesses, queueStatus } from "../../queue-lock";

const fixture = join(import.meta.dir, "holder.fixture.ts");
let dir: string;
let procs: ReturnType<typeof Bun.spawn>[] = [];
let events: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "testing-lock-"));
  events = [];
});

afterEach(() => {
  for (const p of procs) p.kill("SIGKILL");
  procs = [];
  rmSync(dir, { recursive: true, force: true });
});

/** Starts a process that takes the lock, holds it `holdMs` and lets go; its GOT and DONE lines land in `events`. */
function start(label: string, holdMs: number, env: Record<string, string> = {}, child?: string) {
  const p = Bun.spawn(["bun", fixture, label, String(holdMs), ...(child ? [child] : [])], { env: { ...process.env, HARNESS_TESTING_LOCKED: "", HARNESS_TESTING_LOCK_DIR: dir, ...env }, stdout: "pipe", stderr: "inherit" });
  procs.push(p);
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) for (const line of decoder.decode(chunk).split("\n").filter(Boolean)) events.push(line);
  })();
  return p;
}

async function until(what: string, ok: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${events.join(", ")}`);
    await Bun.sleep(25);
  }
}

describe("testing lock", () => {
  test("three runs take turns in arrival order and never overlap", async () => {
    start("A", 500);
    await until("A holds", () => events.includes("GOT A"));
    start("B", 300);
    await until("B queued", () => queueStatus(dir).waiters.length === 1);
    start("C", 100);
    await until("C queued", () => queueStatus(dir).waiters.length === 2);
    await until("C done", () => events.includes("DONE C"));
    expect(events).toEqual(["GOT A", "DONE A", "GOT B", "DONE B", "GOT C", "DONE C"]);
  });

  test("a holder that was killed outright doesn't block the next run", async () => {
    const a = start("A", 60_000);
    await until("A holds", () => events.includes("GOT A"));
    a.kill("SIGKILL");
    start("B", 50);
    await until("B got its turn", () => events.includes("GOT B"));
  });

  test("a waiter that died is skipped when it reaches the head of the line", async () => {
    start("A", 600);
    await until("A holds", () => events.includes("GOT A"));
    const b = start("B", 50);
    await until("B queued", () => queueStatus(dir).waiters.length === 1);
    start("C", 50);
    await until("C queued", () => queueStatus(dir).waiters.length === 2);
    b.kill("SIGKILL");
    await until("C got its turn", () => events.includes("GOT C"));
    expect(events).not.toContain("GOT B");
    expect(queueStatus(dir).waiters).toEqual([]);
  });

  test("a terminated holder lets the next run in", async () => {
    const a = start("A", 60_000);
    await until("A holds", () => events.includes("GOT A"));
    start("B", 50);
    await until("B queued", () => queueStatus(dir).waiters.length === 1);
    a.kill("SIGTERM");
    await until("B got its turn", () => events.includes("GOT B"));
    // A let go itself on the signal (a hard kill leaves no release record behind).
    expect(existsSync(join(dir, "last.json"))).toBe(true);
  });

  test("a run started by the holder, with no environment passed down, doesn't queue behind it", async () => {
    start("A", 60_000, {}, "nested");
    await until("nested ran under A", () => events.includes("DONE nested"));
  });

  test("a run started under a holder (HARNESS_TESTING_LOCKED) doesn't queue behind it", async () => {
    start("A", 60_000);
    await until("A holds", () => events.includes("GOT A"));
    start("nested", 10, { HARNESS_TESTING_LOCKED: String(queueStatus(dir).holder!.pid) });
    await until("nested ran", () => events.includes("DONE nested"));
    expect(queueStatus(dir).holder?.command).toContain("holder.fixture.ts A");
  });

  test("HARNESS_TESTING_LOCKED naming a process that doesn't hold the lock is no bypass", async () => {
    start("A", 600);
    await until("A holds", () => events.includes("GOT A"));
    start("B", 10, { HARNESS_TESTING_LOCKED: "1" });
    await until("B done", () => events.includes("DONE B"));
    expect(events).toEqual(["GOT A", "DONE A", "GOT B", "DONE B"]);
  });

  test("a live waiter whose queue entry was deleted puts itself back and keeps its turn", async () => {
    start("A", 600);
    await until("A holds", () => events.includes("GOT A"));
    start("B", 10);
    await until("B queued", () => queueStatus(dir).waiters.length === 1);
    for (const n of readdirSync(join(dir, "queue"))) rmSync(join(dir, "queue", n));
    await until("B got its turn", () => events.includes("GOT B"));
  });

  test("a run that died holding the lock leaves held.json for the next holder to see, and a clean release leaves none", async () => {
    const a = start("A", 60_000);
    await until("A holds", () => events.includes("GOT A"));
    expect(existsSync(join(dir, "held.json"))).toBe(true);
    a.kill("SIGKILL");
    start("B", 10);
    await until("B done", () => events.includes("DONE B"));
    expect(existsSync(join(dir, "held.json"))).toBe(false);
  });
});

describe("cooldown", () => {
  const base = { now: 100_000, releasedAt: 95_000, leftover: [] as string[], load1: 1, cores: 10 };

  test("a quiet machine goes straight in even right after a release", () => {
    expect(cooldownReason(base)).toBeNull();
  });

  test("leftover processes from a run that just ended make it wait", () => {
    expect(cooldownReason({ ...base, leftover: ["xcodebuild -scheme Harness"] })).toContain("xcodebuild");
  });

  test("a high load average waits only inside the minute after a release", () => {
    expect(cooldownReason({ ...base, load1: 9 })).toContain("load average 9.0");
    expect(cooldownReason({ ...base, load1: 9, releasedAt: 30_000 })).toBeNull();
  });

  test("nothing waits when no run has ever released the lock", () => {
    expect(cooldownReason({ ...base, releasedAt: null, load1: 20, leftover: ["xcodebuild"] })).toBeNull();
  });

  test("it picks out xcodebuild and checkout-Electron processes, and ignores swift tests, simulator boots, the rest and its own ancestry", () => {
    const procs = [
      { pid: 1, command: "/usr/bin/xcodebuild -project ios/Harness.xcodeproj" },
      { pid: 2, command: "xcrun simctl shutdown harness-shared" },
      { pid: 3, command: "/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron app" },
      { pid: 4, command: "bun testing/run.ts mac" },
      { pid: 5, command: "vim xcodebuild-notes.md" },
      { pid: 6, command: "xcrun simctl list devices --json" },
      { pid: 7, command: "/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler" },
      { pid: 8, command: "xcodebuild -version" },
      { pid: 9, command: "swift-test --package-path testing/swift" },
      { pid: 10, command: "xcrun simctl boot harness-HARNESS-12" },
    ];
    expect(leftoverProcesses(procs, [8]).map((p) => p.pid)).toEqual([1, 3]);
  });
});
