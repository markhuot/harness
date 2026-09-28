import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { ensureSpawnHelperExecutable } from "./pty";
import { loginShell, parseEnsureOptions, resolveCwd, Scrollback, shellEnv, TerminalError, TerminalManager, type Pty, type SpawnOptions } from "./terminals";
import type { TerminalExit } from "./types";

class FakePty implements Pty {
  static nextPid = 100;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  resized: [number, number][] = [];
  signals: string[] = [];
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: SpawnOptions,
  ) {}
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.resized.push([c, r]);
  }
  kill(signal = "SIGHUP") {
    this.signals.push(signal);
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(exitCode: number, signal?: number) {
    for (const cb of this.exitCbs) cb({ exitCode, signal });
  }
}

function setup(over: { env?: Record<string, string>; dirs?: string[]; scrollbackLimit?: number; killGraceMs?: number } = {}) {
  const ptys: FakePty[] = [];
  const data: [string, string][] = [];
  const ends: number[] = [];
  const exits: [string, TerminalExit][] = [];
  const flushes: (() => void)[] = [];
  const dirs = new Set(over.dirs ?? ["/home/me", "/work"]);
  const manager = new TerminalManager({
    spawn: (file, args, opts) => {
      const p = new FakePty(file, args, opts);
      ptys.push(p);
      return p;
    },
    events: { data: (id, d, end) => (data.push([id, d]), ends.push(end)), exit: (id, e) => exits.push([id, e]) },
    env: over.env ?? { SHELL: "/bin/bash", PATH: "/usr/bin" },
    home: "/home/me",
    isDirectory: (p) => dirs.has(p),
    scrollbackLimit: over.scrollbackLimit,
    killGraceMs: over.killGraceMs,
    schedule: (f) => void flushes.push(f),
  });
  const tick = () => flushes.splice(0).forEach((f) => f());
  return { manager, ptys, data, ends, exits, tick, flushes };
}

describe("Scrollback", () => {
  test("keeps everything under the limit", () => {
    const s = new Scrollback(10);
    s.push("abc");
    s.push("def");
    expect(s.toString()).toBe("abcdef");
  });
  test("drops whole old chunks, then trims the oldest to the limit", () => {
    const s = new Scrollback(10);
    s.push("aaaaaa");
    s.push("bbbbbb");
    expect(s.toString()).toBe("aaaabbbbbb");
    s.push("cccccccccc");
    expect(s.toString()).toBe("cccccccccc");
    expect(s.length).toBe(10);
  });
  test("a single chunk bigger than the limit keeps its tail", () => {
    const s = new Scrollback(4);
    s.push("0123456789");
    expect(s.toString()).toBe("6789");
  });
  test("a trim starts the replay at the next line when one is close", () => {
    const s = new Scrollback(12);
    // 19 chars, 7 over: a plain cut would start inside "\x1b[0m"; it moves past the newline.
    s.push("\x1b[31mred\x1b[0m\nline2\n");
    expect(s.toString()).toBe("line2\n");
    s.push("line3\n");
    expect(s.toString()).toBe("line2\nline3\n");
    // With no newline near the cut, it trims to the limit exactly.
    s.push("x".repeat(20));
    expect(s.toString()).toBe("x".repeat(12));
  });
});

describe("resolveCwd", () => {
  const isDir = (p: string) => ["/home/me", "/home/me/code", "/work"].includes(p);
  test("expands ~ and ~/", () => {
    expect(resolveCwd("~", "/home/me", isDir)).toBe("/home/me");
    expect(resolveCwd("~/code", "/home/me", isDir)).toBe("/home/me/code");
  });
  test("keeps an existing absolute directory", () => {
    expect(resolveCwd("/work", "/home/me", isDir)).toBe("/work");
  });
  test("falls back to home when missing, relative or empty", () => {
    expect(resolveCwd("/gone", "/home/me", isDir)).toBe("/home/me");
    expect(resolveCwd("~/gone", "/home/me", isDir)).toBe("/home/me");
    expect(resolveCwd("work", "/home/me", isDir)).toBe("/home/me");
    expect(resolveCwd("", "/home/me", isDir)).toBe("/home/me");
    expect(resolveCwd(undefined, "/home/me", isDir)).toBe("/home/me");
  });
});

describe("shell and environment", () => {
  test("uses an absolute $SHELL, else /bin/zsh", () => {
    expect(loginShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(loginShell({ SHELL: "fish" })).toBe("/bin/zsh");
    expect(loginShell({})).toBe("/bin/zsh");
  });
  test("sets the terminal's identity and strips Electron's switches", () => {
    const env = shellEnv({ PATH: "/usr/bin", TERM: "dumb", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", UNSET: undefined });
    expect(env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Harness", LANG: "en_US.UTF-8" });
  });
  test("leaves an existing locale alone", () => {
    expect(shellEnv({ LC_ALL: "de_DE.UTF-8" }).LANG).toBeUndefined();
    expect(shellEnv({ LANG: "de_DE.UTF-8" }).LANG).toBe("de_DE.UTF-8");
  });
});

describe("parseEnsureOptions", () => {
  test("defaults to 80×24", () => {
    expect(parseEnsureOptions(undefined)).toEqual({ cwd: undefined, cols: 80, rows: 24 });
  });
  test("rejects bad sizes and cwd types", () => {
    for (const bad of [{ cols: 0 }, { cols: 1001 }, { rows: 2.5 }, { rows: "24" }, { cwd: 42 }, { cwd: "x".repeat(5000) }]) {
      expect(() => parseEnsureOptions(bad)).toThrow(TerminalError);
    }
  });
});

describe("TerminalManager", () => {
  test("ensure spawns a login shell with the resolved cwd, size and env", () => {
    const { manager, ptys } = setup();
    const s = manager.ensure("p1", { cwd: "~", cols: 100, rows: 30 });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.file).toBe("/bin/bash");
    expect(ptys[0]!.args).toEqual(["-l"]);
    expect(ptys[0]!.opts).toMatchObject({ cwd: "/home/me", cols: 100, rows: 30 });
    expect(ptys[0]!.opts.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", PATH: "/usr/bin" });
    expect(s).toMatchObject({ id: "p1", pid: ptys[0]!.pid, created: true, cwd: "/home/me", scrollback: "", exit: null });
  });

  test("a missing cwd starts in home", () => {
    const { manager, ptys } = setup();
    manager.ensure("p1", { cwd: "/deleted/worktree", cols: 80, rows: 24 });
    expect(ptys[0]!.opts.cwd).toBe("/home/me");
  });

  test("ensure is idempotent: an existing id re-attaches with its scrollback", () => {
    const { manager, ptys, tick } = setup();
    manager.ensure("p1", { cwd: "/work", cols: 80, rows: 24 });
    ptys[0]!.emit("$ ls\r\n");
    tick();
    ptys[0]!.emit("a.txt\r\n");
    const again = manager.ensure("p1", { cwd: "/home/me", cols: 120, rows: 40 });
    expect(ptys).toHaveLength(1);
    expect(again).toMatchObject({ created: false, cwd: "/work", cols: 80, rows: 24, scrollback: "$ ls\r\na.txt\r\n" });
  });

  test("each chunk carries the offset it ends at, and ensure the offset its scrollback ends at", () => {
    const { manager, ptys, data, ends, tick } = setup();
    expect(manager.ensure("p1", { cols: 80, rows: 24 }).end).toBe(0);
    ptys[0]!.emit("one");
    tick();
    ptys[0]!.emit("two");
    // Re-attaching mid-flush: the scrollback holds "onetwo", so a pane skips every chunk ending by 6.
    const again = manager.ensure("p1", { cols: 80, rows: 24 });
    expect(again).toMatchObject({ scrollback: "onetwo", end: 6 });
    tick();
    ptys[0]!.emit("three");
    tick();
    expect(data).toEqual([
      ["p1", "one"],
      ["p1", "two"], // still sent: another window may be showing this session
      ["p1", "three"],
    ]);
    expect(ends).toEqual([3, 6, 11]);
  });

  test("offsets keep counting past the scrollback's bound", () => {
    const { manager, ptys, ends, tick } = setup({ scrollbackLimit: 4 });
    manager.ensure("p1", { cols: 80, rows: 24 });
    ptys[0]!.emit("0123456789");
    tick();
    expect(manager.ensure("p1", { cols: 80, rows: 24 })).toMatchObject({ scrollback: "6789", end: 10 });
    expect(ends).toEqual([10]);
  });

  test("output is coalesced per session until the flush", () => {
    const { manager, ptys, data, tick, flushes } = setup();
    manager.ensure("a", { cols: 80, rows: 24 });
    manager.ensure("b", { cols: 80, rows: 24 });
    ptys[0]!.emit("x");
    ptys[0]!.emit("y");
    ptys[1]!.emit("z");
    ptys[0]!.emit("w");
    expect(flushes).toHaveLength(1);
    expect(data).toEqual([]);
    tick();
    expect(data).toEqual([
      ["a", "xyw"],
      ["b", "z"],
    ]);
    ptys[1]!.emit("q");
    expect(flushes).toHaveLength(1);
  });

  test("scrollback is bounded per session", () => {
    const { manager, ptys } = setup({ scrollbackLimit: 8 });
    manager.ensure("p1", { cols: 80, rows: 24 });
    ptys[0]!.emit("0123456789");
    ptys[0]!.emit("abc");
    expect(manager.ensure("p1", { cols: 80, rows: 24 }).scrollback).toBe("56789abc");
  });

  test("exit flushes pending output first, then stays queryable until killed", () => {
    const { manager, ptys, data, exits } = setup();
    manager.ensure("p1", { cols: 80, rows: 24 });
    ptys[0]!.emit("bye\r\n");
    ptys[0]!.exit(130, 2);
    expect(data).toEqual([["p1", "bye\r\n"]]);
    expect(exits).toEqual([["p1", { exitCode: 130, signal: 2 }]]);
    expect(manager.list()).toEqual(["p1"]);
    const s = manager.ensure("p1", { cols: 80, rows: 24 });
    expect(s).toMatchObject({ created: false, exit: { exitCode: 130, signal: 2 }, scrollback: "bye\r\n" });
    expect(ptys).toHaveLength(1);
    expect(manager.write("p1", "ls\r")).toBe(false);
    expect(manager.resize("p1", 10, 10)).toBe(false);
    expect(manager.kill("p1")).toBe(true);
    expect(ptys[0]!.signals).toEqual([]); // already dead: nothing to signal
    expect(manager.list()).toEqual([]);
  });

  test("a clean exit reports signal null", () => {
    const { manager, ptys, exits } = setup();
    manager.ensure("p1", { cols: 80, rows: 24 });
    ptys[0]!.exit(0, 0);
    expect(exits).toEqual([["p1", { exitCode: 0, signal: null }]]);
  });

  test("write and resize reach the pty; resize to the same size is skipped", () => {
    const { manager, ptys } = setup();
    manager.ensure("p1", { cols: 80, rows: 24 });
    expect(manager.write("p1", "echo hi\r")).toBe(true);
    expect(manager.resize("p1", 80, 24)).toBe(true);
    expect(manager.resize("p1", 132, 43)).toBe(true);
    expect(ptys[0]!.written).toEqual(["echo hi\r"]);
    expect(ptys[0]!.resized).toEqual([[132, 43]]);
    expect(manager.ensure("p1", {}).cols).toBe(132);
    expect(manager.write("nope", "x")).toBe(false);
  });

  test("kill hangs up, forgets the session, ignores its late events, and a new ensure respawns", () => {
    const { manager, ptys, data, exits, tick } = setup();
    manager.ensure("p1", { cols: 80, rows: 24 });
    ptys[0]!.emit("pending");
    expect(manager.kill("p1")).toBe(true);
    expect(ptys[0]!.signals).toEqual(["SIGHUP"]);
    ptys[0]!.emit("late");
    ptys[0]!.exit(0);
    tick();
    expect(data).toEqual([]);
    expect(exits).toEqual([]);
    expect(manager.kill("p1")).toBe(false);
    const fresh = manager.ensure("p1", { cols: 80, rows: 24 });
    expect(fresh.created).toBe(true);
    expect(fresh.scrollback).toBe("");
    expect(ptys).toHaveLength(2);
  });

  test("kill escalates to SIGKILL when the shell ignores SIGHUP", async () => {
    const { manager, ptys } = setup({ killGraceMs: 5 });
    manager.ensure("stubborn", { cols: 80, rows: 24 });
    manager.ensure("polite", { cols: 80, rows: 24 });
    manager.kill("stubborn");
    manager.kill("polite");
    ptys[1]!.exit(0, 1);
    await Bun.sleep(20);
    expect(ptys[0]!.signals).toEqual(["SIGHUP", "SIGKILL"]);
    expect(ptys[1]!.signals).toEqual(["SIGHUP"]);
  });

  test("list lets the renderer reconcile away sessions whose panes are gone", () => {
    const { manager, ptys } = setup();
    for (const id of ["p1", "p2", "p3"]) manager.ensure(id, { cols: 80, rows: 24 });
    const panes = new Set(["p2"]);
    for (const id of manager.list()) if (!panes.has(id)) manager.kill(id);
    expect(manager.list()).toEqual(["p2"]);
    expect(ptys.map((p) => p.signals)).toEqual([["SIGHUP"], [], ["SIGHUP"]]);
  });

  test("killAll hangs up every running shell", () => {
    const { manager, ptys } = setup();
    manager.ensure("a", { cols: 80, rows: 24 });
    manager.ensure("b", { cols: 80, rows: 24 });
    ptys[1]!.exit(0);
    manager.killAll();
    expect(manager.list()).toEqual([]);
    expect(ptys.map((p) => p.signals)).toEqual([["SIGHUP"], []]);
  });

  test("rejects malformed IPC input", () => {
    const { manager, ptys } = setup();
    for (const id of ["", "a b", "../x", "x".repeat(129), 7, null, {}]) {
      expect(() => manager.ensure(id, { cols: 80, rows: 24 })).toThrow(TerminalError);
      expect(() => manager.kill(id)).toThrow(TerminalError);
    }
    manager.ensure("p1", { cols: 80, rows: 24 });
    expect(() => manager.write("p1", 42)).toThrow(TerminalError);
    expect(() => manager.write("p1", "x".repeat(1024 * 1024 + 1))).toThrow(TerminalError);
    expect(() => manager.resize("p1", 0, 24)).toThrow(TerminalError);
    expect(() => manager.resize("p1", 80, NaN)).toThrow(TerminalError);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.written).toEqual([]);
  });
});

// A real PTY. node-pty loads under bun but bun can't read the PTY's master side (the shell gets
// SIGHUP before any output arrives), so this runs the manager in Electron's own Node
// (ELECTRON_RUN_AS_NODE), the runtime it ships in. Skipped when Electron isn't installed.
const repoRoot = resolve(import.meta.dir, "../../..");
const electronBin = (() => {
  try {
    const path = require(require.resolve("electron", { paths: [resolve(import.meta.dir, "../..")] })) as unknown;
    return typeof path === "string" && existsSync(path) ? path : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!electronBin)("real pty (Electron's Node)", () => {
  const dir = tempDir("harness-pty-test-");

  test("spawns a login shell, echoes input, replays scrollback and reports the exit code", async () => {
    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      `import { TerminalManager } from ${JSON.stringify(join(import.meta.dir, "terminals.ts"))};
import { nodePtySpawn } from ${JSON.stringify(join(import.meta.dir, "pty.ts"))};
let out = "";
const manager = new TerminalManager({
  spawn: nodePtySpawn(),
  env: { ...process.env, SHELL: "/bin/sh" },
  events: {
    data: (_id, d) => { out += d; },
    exit: (id, exit) => {
      const replay = manager.ensure(id, {}).scrollback;
      console.log(JSON.stringify({ out, replay, exit, list: manager.list() }));
      manager.killAll();
      process.exit(0);
    },
  },
});
const s = manager.ensure("smoke", { cwd: ${JSON.stringify(dir)}, cols: 80, rows: 24 });
if (!s.created) process.exit(2);
manager.write("smoke", "echo hi-$((40+2)) $TERM $COLORTERM; pwd; exit 7\\r");
setTimeout(() => { console.log("timeout " + JSON.stringify(out)); process.exit(1); }, 8000);
`,
    );
    const built = await Bun.build({ entrypoints: [driver], outdir: dir, target: "node", format: "cjs", external: ["node-pty"], naming: "driver.cjs" });
    expect(built.success).toBe(true);
    const proc = Bun.spawn([electronBin!, join(dir, "driver.cjs")], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: join(repoRoot, "node_modules") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!) as { out: string; replay: string; exit: TerminalExit; list: string[] };
    expect(result.out, stderr).toContain("hi-42 xterm-256color truecolor");
    expect(result.out).toMatch(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/private${dir}`));
    expect(result.replay).toBe(result.out);
    expect(result.exit).toEqual({ exitCode: 7, signal: null });
    expect(result.list).toEqual(["smoke"]);
  }, 20000);
});

describe("ensureSpawnHelperExecutable", () => {
  test("adds the executable bit node-pty's tarball leaves off", () => {
    const dir = tempDir("harness-pty-helper-");
    mkdirSync(join(dir, "prebuilds/darwin-arm64"), { recursive: true });
    const helper = join(dir, "prebuilds/darwin-arm64/spawn-helper");
    writeFileSync(helper, "", { mode: 0o644 });
    ensureSpawnHelperExecutable(dir, "darwin", "arm64");
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });
});
