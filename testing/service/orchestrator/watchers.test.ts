import { expect, test } from "bun:test";
import type { Watcher, WatcherLive } from "@harness/shared";
import { findKeys, loginShell, MAX_OUTPUT_CHARS, toOutput, watcherArgv, WatcherRunner, type SpawnedProcess, type SpawnFn, type WatcherOutput } from "../../../service/src/orchestrator/watchers";
import { fakeClock } from "../../builders/clock";

test("toOutput trims, drops whitespace-only output and caps long output, marking it truncated", () => {
  expect(toOutput("  hello \n")).toEqual({ text: "hello", truncated: false });
  expect(toOutput(" \n\t ")).toBeNull();
  expect(toOutput("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true });
  expect(toOutput("ab   cdef", 5)).toEqual({ text: "ab", truncated: true });
  expect(toOutput("short", 100, true)).toEqual({ text: "short", truncated: true });
  expect(MAX_OUTPUT_CHARS).toBe(16_000);
});

test("findKeys lists upper-case keys once each in order of appearance, up to the max", () => {
  expect(findKeys("see FOO-1, bar-2, FOO-1 and ABC_D-33, X-9")).toEqual(["FOO-1", "ABC_D-33", "X-9"]);
  expect(findKeys("A-1 B-2 C-3", 2)).toEqual(["A-1", "B-2"]);
  expect(findKeys("no keys here, FOO1 or foo-1")).toEqual([]);
});

test("a watcher with no args runs its command line in the login shell; one with args is spawned directly", () => {
  expect(watcherArgv({ command: "watch-jira --project FOO | head", args: [] }, "/bin/zsh")).toEqual(["/bin/zsh", ["-lc", "watch-jira --project FOO | head"]]);
  expect(watcherArgv({ command: "node", args: ["w.js", "--x"] }, "/bin/zsh")).toEqual(["node", ["w.js", "--x"]]);
});

test("loginShell prefers an absolute $SHELL", () => {
  expect(loginShell({ SHELL: "/usr/local/bin/fish" })).toBe("/usr/local/bin/fish");
  expect(loginShell({ SHELL: "fish" })).toBe(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
});

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  throws?: Error;
}

/** A spawn that answers each call from the next script, recording what it was asked to run. */
function rig(...scripts: Script[]) {
  const spawned: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    spawned.push({ cmd, args, ...opts });
    const s = scripts.shift() ?? {};
    if (s.throws) throw s.throws;
    const proc: SpawnedProcess = { stdout: stream(s.stdout ?? ""), stderr: stream(s.stderr ?? ""), exited: Promise.resolve(s.code ?? 0), kill() {} };
    return proc;
  };
  const outputs: { watcher: string; output: WatcherOutput }[] = [];
  const statuses: { id: string; patch: { lastRunAt?: number; lastError?: string | null } }[] = [];
  const lives: WatcherLive["state"][] = [];
  let failDelivery = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const runner = new WatcherRunner({
    spawn,
    shell: "/bin/sh",
    now: fakeClock(5_000),
    maxOutputChars: 20,
    onOutput: (w, output) => {
      if (failDelivery) throw new Error("inbox is full");
      outputs.push({ watcher: w.name, output });
    },
    onStatus: (id, patch) => statuses.push({ id, patch }),
    onLive: (_id, live) => {
      lives.push(live.state);
      // The sync reports "stopped" first; the one-off run reports it again once it has finished.
      if (live.state === "stopped" && lives.filter((l) => l === "stopped").length === 2) finished();
    },
  });
  const watcher = (over: Partial<Watcher> = {}): Watcher => ({
    id: "w1",
    name: "jira",
    command: "echo hi",
    args: [],
    prompt: "",
    cwd: null,
    env: {},
    mode: "interval",
    intervalSec: 60,
    enabled: false,
    driver: null,
    models: {},
    lastRunAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  /** Run the (disabled, so one-off) watcher once and wait for the run to finish. */
  const runOnce = async (w: Watcher) => {
    runner.sync([w]);
    await runner.runNow(w.id);
    await done;
    await runner.stopAll();
  };
  return { runner, spawned, outputs, statuses, lives, watcher, runOnce, failDelivery: () => (failDelivery = true) };
}

test("a one-off run of a disabled watcher spawns its command in the shell and delivers its output once", async () => {
  const r = rig({ stdout: "  FOO-1 changed \n" });
  await r.runOnce(r.watcher({ command: "check-jira", env: { TOKEN: "t" }, cwd: "/work" }));
  expect(r.spawned).toEqual([{ cmd: "/bin/sh", args: ["-lc", "check-jira"], cwd: "/work", env: { TOKEN: "t" } }]);
  expect(r.outputs).toEqual([{ watcher: "jira", output: { text: "FOO-1 changed", truncated: false } }]);
  expect(r.statuses.map((s) => Object.keys(s.patch).join())).toEqual(["lastRunAt", "lastError"]);
  expect(r.statuses.at(-1)).toEqual({ id: "w1", patch: { lastError: null } });
  expect(r.lives).toContain("running");
  expect(r.lives.at(-1)).toBe("stopped");
});

test("a run that prints nothing delivers nothing", async () => {
  const r = rig({ stdout: " \n" });
  await r.runOnce(r.watcher());
  expect(r.outputs).toEqual([]);
});

test("output over the cap is cut and marked truncated", async () => {
  const r = rig({ stdout: "x".repeat(50) });
  await r.runOnce(r.watcher());
  expect(r.outputs[0]!.output).toEqual({ text: "x".repeat(20), truncated: true });
});

test("exit code 4 counts as success, other codes record the exit and the stderr tail as the watcher's error", async () => {
  const ok = rig({ stdout: "out", code: 4 });
  await ok.runOnce(ok.watcher());
  expect(ok.statuses.at(-1)!.patch.lastError).toBeNull();
  const bad = rig({ stdout: "out", stderr: "token expired\n", code: 2 });
  await bad.runOnce(bad.watcher());
  expect(bad.statuses.at(-1)!.patch.lastError).toBe("Command exited with code 2: token expired");
  expect(bad.outputs).toHaveLength(1);
  const legacy = rig({ code: 1 });
  await legacy.runOnce(legacy.watcher({ command: "node", args: ["w.js"] }));
  expect(legacy.statuses.at(-1)!.patch.lastError).toBe("node exited with code 1");
});

test("a command that can't be spawned is recorded as the watcher's error", async () => {
  const r = rig({ throws: new Error("ENOENT") });
  await r.runOnce(r.watcher({ command: "missing" }));
  expect(r.statuses.at(-1)!.patch.lastError).toBe("Failed to start missing: ENOENT");
});

test("an output the inbox refuses is reported on the watcher without ending the run", async () => {
  const r = rig({ stdout: "something" });
  r.failDelivery();
  await r.runOnce(r.watcher());
  expect(r.statuses.some((s) => s.patch.lastError === "Failed to handle output: inbox is full")).toBe(true);
  expect(r.statuses.at(-1)!.patch.lastError).toBe("Failed to handle output: inbox is full");
});

test("running an unknown watcher is an error, and its live state is dropped when the sync no longer has it", async () => {
  const r = rig();
  await expect(r.runner.runNow("nope")).rejects.toThrow("Unknown watcher: nope");
  r.runner.sync([r.watcher()]);
  expect(r.runner.live("w1")).toMatchObject({ state: "stopped", since: 5_000 });
  r.runner.sync([]);
  expect(r.runner.live("w1")).toBeUndefined();
});
