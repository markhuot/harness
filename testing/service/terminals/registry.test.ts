import { afterEach, beforeEach, expect, test } from "bun:test";
import { assertNoTimerLeaks, trackTimers } from "../leaks";
import type { HarnessEvent } from "@harness/shared";
import type { BusEvent } from "../../../service/src/events";
import { EventBus } from "../../../service/src/events";
import { HarnessError } from "../../../service/src/orchestrator/errors";
import { DEFAULT_READ_LINES, MAX_READ_CHARS, MAX_READ_LINES, isTerminalReply, loginShell, MAX_EXITED_TERMINALS, MAX_WRITE, MAX_WRITE_PER_SECOND, resolveCwd, shellEnv, TerminalRegistry } from "../../../service/src/terminals/registry";
import { tempDir } from "../../builders/tmp";
import { FakeClient, fakeEmulators, fakeSpawn, manualTimers } from "./fakes";

beforeEach(trackTimers);
afterEach(assertNoTimerLeaks);

function rig(opts: { maxRunning?: number; exitedGraceMs?: number; idleMs?: number; poll?: ConstructorParameters<typeof TerminalRegistry>[0]["poll"]; highWater?: number } = {}) {
  const clock = manualTimers(1_000_000);
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.on((e) => events.push(e));
  const { spawn, ptys } = fakeSpawn();
  const emus = fakeEmulators();
  const home = tempDir();
  const logs: string[] = [];
  const registry = new TerminalRegistry({
    bus,
    spawn,
    env: { SHELL: "/bin/zsh", PATH: "/bin", HARNESS_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", LANG: "C.UTF-8" },
    home,
    now: clock.now,
    timers: clock.timers,
    createEmulator: emus.create,
    log: (m) => logs.push(m),
    ...opts,
  });
  const kinds = () => events.map((e) => e.kind);
  return { registry, clock, ptys, emus, events, kinds, home, logs };
}

/** Let the promise chains the registry started (snapshots) run to the end. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const rejects = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(status);
    return;
  }
  throw new Error("expected a HarnessError");
};

test("shellEnv drops the service's own switches and sets the terminal's identity; a missing locale gets a default", () => {
  const env = shellEnv({ PATH: "/bin", HARNESS_TOKEN: "s", ELECTRON_RUN_AS_NODE: "1", BUN_INSPECT: "x", npm_config: "y", NODE_OPTIONS: "z", NODE_ENV: "dev", GONE: undefined });
  expect(env).toEqual({ PATH: "/bin", NODE_ENV: "dev", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Harness", LANG: "en_US.UTF-8" });
  expect(shellEnv({ LC_ALL: "fr_FR.UTF-8" }).LANG).toBeUndefined();
});

test("loginShell uses an absolute $SHELL and otherwise zsh", () => {
  expect(loginShell({ SHELL: "/bin/fish" })).toBe("/bin/fish");
  expect(loginShell({ SHELL: "fish" })).toBe("/bin/zsh");
  expect(loginShell({})).toBe("/bin/zsh");
});

test("resolveCwd expands ~, and anything missing, relative or not a directory is home", () => {
  const isDir = (p: string) => p.startsWith("/dirs/");
  expect(resolveCwd("~", "/home/u", isDir)).toBe("/home/u");
  expect(resolveCwd("~/x", "/home/u", () => true)).toBe("/home/u/x");
  expect(resolveCwd("/dirs/a", "/home/u", isDir)).toBe("/dirs/a");
  expect(resolveCwd("/files/a", "/home/u", isDir)).toBe("/home/u");
  expect(resolveCwd("rel", "/home/u", () => true)).toBe("/home/u");
  expect(resolveCwd(undefined, "/home/u", isDir)).toBe("/home/u");
  expect(resolveCwd("  ", "/home/u", isDir)).toBe("/home/u");
});

test("isTerminalReply tells a terminal's answers (cursor position, device attributes, colors, focus) from typing", () => {
  for (const reply of ["\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[I", "\x1b[O", "\x1b[?2004;2$y", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) {
    expect(isTerminalReply(reply)).toBe(true);
  }
  for (const typed of ["ls\r", "\x1b[A", "\x1b", "\x1b[12;40Rextra", "R"]) expect(isTerminalReply(typed)).toBe(false);
});

test("create spawns a login shell in the resolved cwd with the cleaned environment and announces it on the bus", () => {
  const r = rig();
  const info = r.registry.create({ cwd: "~", cols: 100, rows: 30, deviceId: "dev-1", projectId: "p1" });
  expect(info).toMatchObject({ cwd: r.home, cols: 100, rows: 30, process: "zsh", state: "running", exitCode: null, createdAt: 1_000_000, createdBy: "dev-1", projectId: "p1" });
  expect(info.id).toMatch(/^t-[0-9a-f]{12}$/);
  const pty = r.ptys[0]!;
  expect([pty.file, pty.args, pty.opts.cwd, pty.opts.cols, pty.opts.rows]).toEqual(["/bin/zsh", ["-l"], r.home, 100, 30]);
  expect(Object.keys(pty.opts.env)).not.toContain("HARNESS_TOKEN");
  expect(r.kinds()).toEqual(["terminal.created"]);
  expect(r.registry.list().map((t) => t.id)).toEqual([info.id]);
});

test("create refuses a bad cwd value and a full house, but counts only running terminals", () => {
  const r = rig({ maxRunning: 2 });
  rejects(() => r.registry.create({ cwd: 5 as never }), 400);
  rejects(() => r.registry.create({ cwd: "x".repeat(5000) }), 400);
  const a = r.registry.create();
  r.registry.create();
  rejects(() => r.registry.create(), 409);
  r.ptys[0]!.exit(0);
  expect(r.registry.get(a.id)!.state).toBe("exited");
  expect(() => r.registry.create()).not.toThrow();
});

test("a shell that fails to spawn leaves nothing behind", () => {
  const r = rig();
  const failing = new TerminalRegistry({ bus: new EventBus(), spawn: () => { throw new Error("no pty"); }, createEmulator: r.emus.create, home: r.home });
  expect(() => failing.create()).toThrow("no pty");
  expect(failing.list()).toEqual([]);
  expect(r.emus.made.map((e) => e.disposed)).toEqual([true]);
});

test("output is coalesced for a few ms, then written to the emulator and sent with its byte offset to ready clients", async () => {
  const r = rig();
  const { id } = r.registry.create();
  const client = new FakeClient("s1");
  await r.registry.attach(client, id, "d1", 80, 24);
  expect(client.of("terminal.snapshot")).toHaveLength(1);
  r.ptys[0]!.emit("héllo ");
  r.ptys[0]!.emit("world");
  expect(client.of("terminal.output")).toHaveLength(0);
  r.clock.advance(4);
  expect(client.of("terminal.output")).toEqual([{ type: "terminal.output", id, data: "héllo world", offset: Buffer.byteLength("héllo world") }]);
  expect(r.emus.made[0]!.written).toEqual(["héllo world"]);
});

test("a multi-byte character split across chunks is decoded whole", () => {
  const r = rig();
  const { id } = r.registry.create();
  const euro = new TextEncoder().encode("€");
  r.ptys[0]!.opts.onData(euro.subarray(0, 1));
  r.ptys[0]!.opts.onData(euro.subarray(1));
  r.clock.advance(4);
  expect(r.emus.made[0]!.written.join("")).toBe("€");
  expect(id).toBeTruthy();
});

test("a client attaching later gets the screen as of now, with the offset to continue from, and then only newer output", async () => {
  const r = rig();
  const { id } = r.registry.create();
  r.ptys[0]!.emit("before");
  const late = new FakeClient("s2");
  await r.registry.attach(late, id, "d2", 80, 24);
  const [snap] = late.of("terminal.snapshot");
  expect(snap).toMatchObject({ id, offset: 6, cols: 80, rows: 24, truncated: false });
  expect(snap!.data).toContain("before");
  r.ptys[0]!.emit("after");
  r.clock.advance(4);
  expect(late.of("terminal.output").map((o) => o.data)).toEqual(["after"]);
  expect(late.of("terminal.output")[0]!.offset).toBe(11);
});

test("a client whose queue grows past the high-water mark skips output and is resynced from a snapshot", async () => {
  const r = rig({ highWater: 100 });
  const { id } = r.registry.create();
  const slow = new FakeClient("slow");
  const fast = new FakeClient("fast");
  await r.registry.attach(slow, id, "d1", 80, 24);
  await r.registry.attach(fast, id, "d2", 80, 24);
  slow.queued = 500;
  r.ptys[0]!.emit("x");
  r.clock.advance(4);
  expect(fast.of("terminal.output")).toHaveLength(1);
  expect(slow.of("terminal.output")).toHaveLength(0);
  // The resync waits for the queue to drain, on the injected timers.
  expect(slow.of("terminal.snapshot")).toHaveLength(1);
  slow.queued = 0;
  r.clock.advance(50);
  await Promise.resolve();
  await Promise.resolve();
  expect(slow.of("terminal.snapshot")).toHaveLength(2);
});

test("the shell is sized to the smallest attached client and the emulator and every client follow", async () => {
  const r = rig();
  const { id } = r.registry.create();
  const big = new FakeClient("big");
  const small = new FakeClient("small");
  await r.registry.attach(big, id, "d1", 120, 40);
  expect(r.registry.get(id)).toMatchObject({ cols: 120, rows: 40 });
  r.clock.advance(200);
  await r.registry.attach(small, id, "d2", 60, 20);
  expect(r.registry.get(id)).toMatchObject({ cols: 60, rows: 20 });
  expect(r.ptys[0]!.resizes.at(-1)).toEqual({ cols: 60, rows: 20 });
  expect(r.emus.made[0]!.sizes.at(-1)).toEqual({ cols: 60, rows: 20 });
  await Promise.resolve();
  expect(big.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 60, rows: 20 });
});

test("a client whose presence says another terminal is on screen stops holding the size down", async () => {
  const r = rig();
  const { id } = r.registry.create();
  await r.registry.attach(new FakeClient("a"), id, "d1", 120, 40);
  r.clock.advance(200);
  await r.registry.attach(new FakeClient("b"), id, "d2", 60, 20);
  expect(r.registry.get(id)!.cols).toBe(60);
  r.registry.setPresence("b", { deviceId: "d2", platform: "ios", visible: true, tickets: [], terminals: ["t-other"] });
  r.clock.advance(200);
  r.clock.advance(1500);
  expect(r.registry.get(id)!.cols).toBe(120);
});

test("the same device reconnecting on a new socket doesn't count twice for sizing", async () => {
  const r = rig();
  const { id } = r.registry.create();
  await r.registry.attach(new FakeClient("old"), id, "phone", 40, 20);
  r.clock.advance(200);
  await r.registry.attach(new FakeClient("new"), id, "phone", 100, 30);
  r.clock.advance(1500);
  expect(r.registry.sizeReports(id).clients.map((c) => c.clientId)).toEqual(["new"]);
  expect(r.registry.get(id)!.cols).toBe(100);
});

test("write sends typing to the shell, lets only the primary client answer terminal queries, and rejects abuse", async () => {
  const r = rig();
  const { id } = r.registry.create();
  r.registry.write("s1", id, "ls\r");
  r.registry.write("s2", id, "\x1b[1;1R"); // a reply from a non-primary client: dropped
  r.registry.write("s1", id, "\x1b[1;1R");
  expect(r.ptys[0]!.writes).toEqual(["ls\r", "\x1b[1;1R"]);
  rejects(() => r.registry.write("s1", "nope", "x"), 404);
  rejects(() => r.registry.write("s1", id, 5), 400);
  rejects(() => r.registry.write("s1", id, "x".repeat(MAX_WRITE + 1)), 400);
});

test("input is throttled per second of the injected clock", () => {
  const r = rig();
  const { id } = r.registry.create();
  const chunk = "x".repeat(MAX_WRITE);
  for (let i = 0; i < MAX_WRITE_PER_SECOND / MAX_WRITE; i++) r.registry.write("s", id, chunk);
  rejects(() => r.registry.write("s", id, "x"), 400);
  r.clock.advance(1000);
  expect(() => r.registry.write("s", id, "x")).not.toThrow();
});

test("writing to a shell whose master already closed says the terminal has ended", () => {
  const r = rig();
  const { id } = r.registry.create();
  r.ptys[0]!.dead = true;
  rejects(() => r.registry.write("s", id, "x"), 404);
});

test("title and cwd from the shell update the terminal's info and are announced, at most once a second", () => {
  const r = rig();
  const { id } = r.registry.create();
  const emu = r.emus.made[0]!;
  const updates = () => r.kinds().filter((k) => k === "terminal.updated").length;
  emu.events.title("first");
  expect(r.registry.get(id)!.title).toBe("first");
  expect(updates()).toBe(0); // the terminal was created less than a second ago
  r.clock.advance(1000);
  expect(updates()).toBe(1);
  emu.events.title("second");
  emu.events.cwd("/work");
  expect(updates()).toBe(1); // held for the rest of the second
  r.clock.advance(1000);
  expect(updates()).toBe(2);
  const last = r.events.filter((e) => e.kind === "terminal.updated").at(-1) as Extract<HarnessEvent, { kind: "terminal.updated" }>;
  expect(last.terminal).toMatchObject({ title: "second", cwd: "/work" });
});

test("when the shell exits the terminal is exited, clients hear it, and attaching afterwards gets the exit too", async () => {
  const r = rig();
  const { id } = r.registry.create();
  const client = new FakeClient("s1");
  await r.registry.attach(client, id, "d", 80, 24);
  r.ptys[0]!.emit("bye");
  r.ptys[0]!.exit(3);
  expect(client.of("terminal.output").map((o) => o.data)).toEqual(["bye"]);
  expect(client.of("terminal.exit")).toEqual([{ type: "terminal.exit", id, exitCode: 3 }]);
  expect(r.registry.get(id)).toMatchObject({ state: "exited", exitCode: 3 });
  const later = new FakeClient("s2");
  await r.registry.attach(later, id, "d2", 80, 24);
  expect(later.of("terminal.exit")).toHaveLength(1);
  r.registry.write("s", id, "ignored"); // no throw, nothing written
  expect(r.ptys[0]!.writes).toEqual([]);
});

test("an exited terminal is reaped after its grace period, and only the newest few are kept", () => {
  const r = rig({ exitedGraceMs: 60_000 });
  const first = r.registry.create();
  r.ptys[0]!.exit(0);
  r.clock.advance(59_999);
  return r.registry.tick().then(() => {
    expect(r.registry.get(first.id)).not.toBeNull();
    r.clock.advance(1);
    return r.registry.tick().then(() => {
      expect(r.registry.get(first.id)).toBeNull();
      expect(r.kinds()).toContain("terminal.removed");
    });
  });
});

test("past the cap on exited terminals the oldest go first", () => {
  const r = rig({ maxRunning: 100 });
  const ids = Array.from({ length: MAX_EXITED_TERMINALS + 2 }, () => r.registry.create().id);
  ids.forEach((_, i) => {
    r.clock.advance(1);
    r.ptys[i]!.exit(0);
  });
  expect(r.registry.list().map((t) => t.id)).toEqual(ids.slice(2));
});

test("restart revives an exited terminal under the same id and tells attached clients; a running one is refused", async () => {
  const r = rig();
  const { id } = r.registry.create();
  rejects(() => r.registry.restart(id), 409);
  rejects(() => r.registry.restart("nope"), 404);
  const client = new FakeClient("s1");
  await r.registry.attach(client, id, "d", 80, 24);
  r.ptys[0]!.exit(1);
  r.registry.restart(id);
  await settle();
  expect(r.ptys).toHaveLength(2);
  expect(r.registry.get(id)).toMatchObject({ state: "running", exitCode: null });
  // The old shell's late callbacks are ignored.
  r.ptys[0]!.emit("ghost");
  r.clock.advance(4);
  expect(client.of("terminal.output").map((o) => o.data)).not.toContain("ghost");
  r.ptys[1]!.emit("alive");
  r.clock.advance(4);
  expect(client.of("terminal.output").map((o) => o.data)).toContain("alive");
});

test("close hangs up the shell, tells clients, forgets the terminal and announces the removal", async () => {
  const r = rig();
  const { id } = r.registry.create();
  const client = new FakeClient("s1");
  await r.registry.attach(client, id, "d", 80, 24);
  r.registry.close(id);
  expect(r.ptys[0]!.kills[0]).toBe("SIGHUP");
  expect(client.of("terminal.exit")).toHaveLength(1);
  expect(r.registry.get(id)).toBeNull();
  expect(r.emus.made[0]!.disposed).toBe(true);
  expect(r.kinds().at(-1)).toBe("terminal.removed");
  rejects(() => r.registry.close(id), 404);
});

test("an idle terminal nobody is attached to ends after idleMs, unless a program other than the shell is running", async () => {
  const r = rig({ idleMs: 10_000, poll: { ps: async () => "1001 1001 2000 -zsh\n2000 2000 2000 vim\n", lsof: async () => "" } });
  const idle = r.registry.create();
  r.clock.advance(10_000);
  await r.registry.tick();
  expect(r.registry.get(idle.id)).toBeNull();

  const busy = r.registry.create();
  const watcher = new FakeClient("w");
  await r.registry.attach(watcher, busy.id, "d", 80, 24);
  await r.registry.poll(false); // learns that vim is in the foreground
  r.registry.detach("w", busy.id);
  r.clock.advance(10_000);
  await r.registry.tick();
  expect(r.registry.get(busy.id)).not.toBeNull();
});

test("poll fills in the foreground process and cwd, but an OSC 7 cwd wins over lsof", async () => {
  const r = rig({ poll: { ps: async () => "1000 1000 1000 -zsh\n1001 1001 1001 -zsh\n", lsof: async () => "p1000\nn/from/lsof\np1001\nn/from/lsof2\n" } });
  const a = r.registry.create();
  const b = r.registry.create();
  r.emus.made[1]!.events.cwd("/from/osc7");
  await r.registry.poll(true);
  expect(r.registry.get(a.id)!.cwd).toBe("/from/lsof");
  expect(r.registry.get(b.id)!.cwd).toBe("/from/osc7");
});

test("dropClient detaches a socket everywhere and shutdown hangs up every shell", async () => {
  const r = rig();
  const a = r.registry.create();
  const b = r.registry.create();
  const client = new FakeClient("s1");
  await r.registry.attach(client, a.id, "d", 80, 24);
  await r.registry.attach(client, b.id, "d", 80, 24);
  r.registry.dropClient("s1");
  expect(r.registry.sizeReports(a.id).clients).toEqual([]);
  r.ptys[0]!.emit("x");
  r.clock.advance(4);
  expect(client.of("terminal.output")).toHaveLength(0);
  r.registry.shutdown();
  expect(r.ptys.map((p) => p.kills[0])).toEqual(["SIGHUP", "SIGHUP"]);
  expect(r.registry.list()).toEqual([]);
  rejects(() => r.registry.sizeReports(a.id), 404);
});

test("a callback that throws is logged, not allowed to escape into the PTY's native code", () => {
  const r = rig();
  r.registry.create();
  r.emus.made[0]!.write = () => {
    throw new Error("emulator exploded");
  };
  r.ptys[0]!.emit("x");
  expect(() => r.clock.advance(4)).not.toThrow();
  expect(r.logs[0]).toContain("terminal callback failed: ");
  expect(r.logs[0]).toContain("emulator exploded");
});

test("text() flushes output still waiting and keeps the last lines within the line and character caps", async () => {
  const r = rig();
  const { id } = await r.registry.create({ cwd: r.home });
  r.emus.made[0]!.lines = (max) => ["a", "b", "c", "d"].slice(-max);
  expect(await r.registry.text(id, 2)).toEqual({ text: "c\nd", lines: 2, truncated: true });
  expect((await r.registry.text(id)).truncated).toBe(false);
  expect(DEFAULT_READ_LINES).toBeLessThanOrEqual(MAX_READ_LINES);
  r.emus.made[0]!.lines = () => ["x".repeat(MAX_READ_CHARS * 2)];
  const huge = await r.registry.text(id);
  expect(huge.text.length).toBeLessThan(MAX_READ_CHARS);
  expect(huge.truncated).toBe(true);
  await expect(r.registry.text("t-nope")).rejects.toMatchObject({ status: 404 });
});

test("writeAgent types without a socket, shares the per-second budget with sockets, and refuses an exited shell", async () => {
  const r = rig();
  const { id } = await r.registry.create({ cwd: r.home });
  r.registry.writeAgent(id, "ls\r");
  expect(r.ptys[0]!.writes).toEqual(["ls\r"]);
  for (let i = 0; i < MAX_WRITE_PER_SECOND / MAX_WRITE - 1; i++) r.registry.write("s1", id, "x".repeat(MAX_WRITE));
  rejects(() => r.registry.writeAgent(id, "x".repeat(MAX_WRITE)), 400);
  rejects(() => r.registry.writeAgent("t-nope", "x"), 404);
  r.clock.advance(1000);
  r.ptys[0]!.exit(0);
  await settle();
  rejects(() => r.registry.writeAgent(id, "x"), 400);
});
