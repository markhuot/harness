import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { HarnessEvent } from "@harness/shared";
import { EventBus } from "../events";
import { HarnessError } from "../orchestrator/errors";
import { TerminalRegistry, isTerminalReply, resolveCwd, shellEnv, type TerminalRegistryOptions } from "./registry";
import { FakeClient, fakeClock, fakeSpawn } from "./testing";

function setup(extra: Partial<TerminalRegistryOptions> = {}) {
  const clock = fakeClock();
  const { spawn, ptys } = fakeSpawn();
  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on((e) => events.push(e));
  const registry = new TerminalRegistry({
    bus,
    spawn,
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin", HARNESS_TOKEN: "secret", BUN_INSTALL: "x", ELECTRON_RUN_AS_NODE: "1" },
    home: "/home/mark",
    isDirectory: (p) => p === "/tmp" || p === "/home/mark/Sites",
    now: clock.now,
    timers: clock.timers,
    poll: { ps: async () => "", lsof: async () => "" },
    ...extra,
  });
  /** Flush output the way the 4 ms timer does, and let the emulator parse it. */
  const settle = async () => {
    clock.advance(10);
    await Bun.sleep(5);
  };
  return { registry, clock, ptys, events, settle };
}

const kinds = (events: HarnessEvent[]) => events.map((e) => e.kind);

describe("create", () => {
  test("spawns a login shell with a clean environment in a resolved cwd, and announces it", () => {
    const { registry, ptys, events } = setup();
    const info = registry.create({ cwd: "~/Sites", projectId: "prj_1", deviceId: "dev" });
    expect(ptys[0]!.file).toBe("/bin/zsh");
    expect(ptys[0]!.args).toEqual(["-l"]);
    expect(ptys[0]!.opts.cwd).toBe("/home/mark/Sites");
    expect(ptys[0]!.opts.env.PATH).toBe("/usr/bin");
    expect(ptys[0]!.opts.env.TERM).toBe("xterm-256color");
    expect(Object.keys(ptys[0]!.opts.env).filter((k) => /HARNESS|BUN_|ELECTRON/.test(k))).toEqual([]);
    expect(info).toMatchObject({ cwd: "/home/mark/Sites", projectId: "prj_1", state: "running", createdBy: "dev", process: "zsh", cols: 80, rows: 24 });
    expect(kinds(events)).toEqual(["terminal.created"]);
    registry.shutdown();
  });

  test("a missing or relative cwd falls back to home; no project means All projects", () => {
    expect(resolveCwd("/nope", "/home/mark", () => false)).toBe("/home/mark");
    expect(resolveCwd("relative", "/home/mark", () => true)).toBe("/home/mark");
    expect(resolveCwd(undefined, "/home/mark", () => true)).toBe("/home/mark");
    const { registry } = setup();
    expect(registry.create({}).projectId).toBeNull();
    registry.shutdown();
  });

  test("the 25th running terminal is refused with a 409, and an exited one frees its slot", () => {
    const { registry, ptys } = setup({ maxRunning: 2 });
    registry.create();
    registry.create();
    expect(() => registry.create()).toThrow(HarnessError);
    try {
      registry.create();
    } catch (e) {
      expect((e as HarnessError).status).toBe(409);
    }
    ptys[0]!.exit(0);
    expect(() => registry.create()).not.toThrow();
    registry.shutdown();
  });

  test("shellEnv sets a locale only when there is none", () => {
    expect(shellEnv({ LANG: "de_DE.UTF-8" }).LANG).toBe("de_DE.UTF-8");
    expect(shellEnv({}).LANG).toBe("en_US.UTF-8");
  });
});

describe("lifecycle", () => {
  test("an exited terminal stays listed for the grace period, then goes", async () => {
    const { registry, clock, ptys, events } = setup({ exitedGraceMs: 10 * 60_000 });
    const { id } = registry.create();
    ptys[0]!.exit(3);
    expect(registry.get(id)).toMatchObject({ state: "exited", exitCode: 3 });
    clock.advance(9 * 60_000);
    await registry.tick();
    expect(registry.get(id)).not.toBeNull();
    clock.advance(61_000);
    await registry.tick();
    expect(registry.get(id)).toBeNull();
    expect(kinds(events)).toEqual(["terminal.created", "terminal.updated", "terminal.removed"]);
  });

  test("the idle reaper ends a terminal nobody has attached to for a day, but not one running a program", async () => {
    const { registry, clock, ptys } = setup({ idleMs: 24 * 3600_000, poll: { ps: async () => "  1000 1000 1000 -zsh\n  1001 1001 1001 vim\n", lsof: async () => "" } });
    const a = registry.create();
    const b = registry.create();
    // b is running vim (as the poller would report once a client looked at it)
    const client = new FakeClient("s1");
    await registry.attach(client, b.id, "d", 80, 24);
    ptys[1]!.pid; // pid 1001 is b's shell in the fake ps
    await registry.poll(false);
    registry.detach("s1", b.id);
    clock.advance(25 * 3600_000);
    await registry.tick();
    expect(registry.get(a.id)).toBeNull();
    expect(ptys[0]!.kills).toEqual(["SIGHUP"]);
    expect(registry.get(b.id)).not.toBeNull();
    expect(ptys[1]!.kills).toEqual([]);
    registry.shutdown();
  });

  test("nothing is killed because the last client left", async () => {
    const { registry, clock, ptys } = setup();
    const { id } = registry.create();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    registry.dropClient("s1");
    clock.advance(3600_000);
    await registry.tick();
    expect(registry.get(id)).not.toBeNull();
    expect(ptys[0]!.kills).toEqual([]);
    registry.shutdown();
  });

  test("close hangs up the shell, forgets it and tells attached clients", async () => {
    const { registry, ptys, events } = setup();
    const { id } = registry.create();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    registry.close(id);
    expect(ptys[0]!.kills).toEqual(["SIGHUP"]);
    expect(registry.list()).toEqual([]);
    expect(client.of("terminal.exit")).toHaveLength(1);
    expect(kinds(events).at(-1)).toBe("terminal.removed");
    expect(() => registry.close(id)).toThrow(HarnessError);
  });

  test("shutdown hangs up every running shell", () => {
    const { registry, ptys } = setup();
    registry.create();
    registry.create();
    registry.shutdown();
    expect(ptys.map((p) => p.kills)).toEqual([["SIGHUP"], ["SIGHUP"]]);
  });

  test("terminal.updated is sent only on a change and at most once a second", async () => {
    const { registry, clock, ptys, events, settle } = setup();
    registry.create();
    events.length = 0;
    for (let i = 0; i < 5; i++) {
      ptys[0]!.emit(`\x1b]0;title ${i}\x07`);
      await settle();
    }
    // five title changes within ~50 ms: the first went out at once, the rest wait for the second
    expect(kinds(events)).toEqual([]);
    clock.advance(1000);
    expect(events.filter((e) => e.kind === "terminal.updated")).toHaveLength(1);
    const updated = events.find((e) => e.kind === "terminal.updated") as Extract<HarnessEvent, { kind: "terminal.updated" }>;
    expect(updated.terminal.title).toBe("title 4");
    clock.advance(5000);
    expect(events.filter((e) => e.kind === "terminal.updated")).toHaveLength(1);
    registry.shutdown();
  });

  test("OSC 7 sets the cwd and wins over polling", async () => {
    const { registry, ptys, settle } = setup({ poll: { ps: async () => "  1000 1000 1000 -zsh\n", lsof: async () => "p1000\nn/polled\n" } });
    const { id } = registry.create();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    await registry.poll(false);
    expect(registry.get(id)!.cwd).toBe("/polled");
    ptys[0]!.emit("\x1b]7;file://host/from/osc\x07");
    await settle();
    await registry.poll(false);
    expect(registry.get(id)!.cwd).toBe("/from/osc");
    registry.shutdown();
  });

  test("polling skips terminals nobody is attached to unless asked for all", async () => {
    const asked: number[][] = [];
    const { registry } = setup({ poll: { ps: async () => "", lsof: async (pids) => (asked.push(pids), "") } });
    registry.create();
    await registry.poll(false);
    expect(asked).toEqual([]);
    await registry.poll(true);
    expect(asked).toEqual([[1000]]);
    registry.shutdown();
  });
});

describe("attach, output and snapshots", () => {
  test("a client gets a snapshot of what was written, then live output with continuing offsets", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create();
    ptys[0]!.emit("hello\r\n");
    await settle();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    const snap = client.of("terminal.snapshot")[0]!;
    expect(snap.data).toContain("hello");
    expect(snap.offset).toBe(7);
    ptys[0]!.emit("world");
    await settle();
    expect(client.of("terminal.output")).toEqual([{ type: "terminal.output", id, data: "world", offset: 12 }]);
    registry.shutdown();
  });

  test("a multi-byte character split across PTY reads arrives whole, with byte offsets", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    const bytes = new TextEncoder().encode("é€😀");
    ptys[0]!.opts.onData(bytes.slice(0, 1)); // half of é
    await settle();
    ptys[0]!.opts.onData(bytes.slice(1, 4)); // rest of é, first byte of €... split again
    ptys[0]!.opts.onData(bytes.slice(4));
    await settle();
    const text = client.of("terminal.output").map((m) => m.data).join("");
    expect(text).toBe("é€😀");
    expect(client.of("terminal.output").at(-1)!.offset).toBe(bytes.length);
    registry.shutdown();
  });

  test("snapshot plus the output after it reproduces the screen of a reference emulator fed the same bytes", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create({ cols: 60, rows: 12 });
    const chunks = Array.from({ length: 40 }, (_, i) => `line ${i} \x1b[1mbold\x1b[0m\r\n`);
    for (const c of chunks.slice(0, 25)) ptys[0]!.emit(c);
    await settle();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 60, 12);
    for (const c of chunks.slice(25)) ptys[0]!.emit(c);
    await settle();

    const draw = new Terminal({ cols: 60, rows: 12, scrollback: 5000, allowProposedApi: true });
    const ref = new Terminal({ cols: 60, rows: 12, scrollback: 5000, allowProposedApi: true });
    for (const m of client.messages) {
      if (m.type === "terminal.snapshot") await new Promise<void>((r) => draw.write(m.data, r));
      if (m.type === "terminal.output") await new Promise<void>((r) => draw.write(m.data, r));
    }
    for (const c of chunks) await new Promise<void>((r) => ref.write(c, r));
    const a = new SerializeAddon();
    const b = new SerializeAddon();
    draw.loadAddon(a);
    ref.loadAddon(b);
    expect(a.serialize()).toBe(b.serialize());
    registry.shutdown();
  });

  test("attaching to a terminal that doesn't exist is a 404", async () => {
    const { registry } = setup();
    await expect(registry.attach(new FakeClient("s"), "t-nope", "d", 80, 24)).rejects.toMatchObject({ status: 404 });
  });

  test("a client attaching to an exited terminal gets the snapshot and the exit", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create();
    ptys[0]!.emit("bye\r\n");
    ptys[0]!.exit(0);
    await settle();
    const client = new FakeClient("s1");
    await registry.attach(client, id, "d", 80, 24);
    expect(client.messages.map((m) => m.type)).toEqual(["terminal.snapshot", "terminal.exit"]);
    registry.shutdown();
  });
});

describe("shared size", () => {
  test("the shell follows the smallest attached client, both ways, and the others get the screen again at the new size", async () => {
    const { registry, clock, ptys } = setup();
    const { id } = registry.create({ cols: 120, rows: 40 });
    const mac = new FakeClient("mac");
    const phone = new FakeClient("phone");
    await registry.attach(mac, id, "mac-dev", 120, 40);
    await registry.attach(phone, id, "phone-dev", 50, 20);
    clock.advance(200);
    expect(ptys[0]!.resizes.at(-1)).toEqual({ cols: 50, rows: 20 });
    await Bun.sleep(20);
    expect(mac.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 50, rows: 20 });
    expect(registry.get(id)).toMatchObject({ cols: 50, rows: 20 });
    registry.detach("phone", id);
    clock.advance(2000);
    expect(ptys[0]!.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
    await Bun.sleep(20);
    expect(mac.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 120, rows: 40 });
    registry.shutdown();
  });

  test("a silent client expires from the size", async () => {
    const { registry, clock, ptys } = setup();
    const { id } = registry.create({ cols: 120, rows: 40 });
    await registry.attach(new FakeClient("mac"), id, "m", 120, 40);
    await registry.attach(new FakeClient("phone"), id, "p", 50, 20);
    clock.advance(200);
    for (let i = 0; i < 4; i++) {
      clock.advance(5000);
      registry.touch("mac");
      await registry.tick();
    }
    clock.advance(2000);
    expect(ptys[0]!.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
    registry.shutdown();
  });

  test("the same device on a new socket replaces the old one instead of counting twice", async () => {
    const { registry, clock, ptys } = setup();
    const { id } = registry.create({ cols: 120, rows: 40 });
    await registry.attach(new FakeClient("old"), id, "phone-dev", 50, 20);
    clock.advance(200);
    await registry.attach(new FakeClient("new"), id, "phone-dev", 90, 30);
    clock.advance(200);
    // the old 50x20 is gone: the size is now the reconnected 90x30 (after the grow delay)
    clock.advance(2000);
    expect(ptys[0]!.resizes.at(-1)).toEqual({ cols: 90, rows: 30 });
    registry.shutdown();
  });

  test("a client that went quiet stops counting for the size but keeps getting output", async () => {
    const { registry, clock, ptys, settle } = setup();
    const { id } = registry.create({ cols: 120, rows: 40 });
    const stalled = new FakeClient("stalled");
    await registry.attach(new FakeClient("mac"), id, "m", 120, 40);
    await registry.attach(stalled, id, "p", 50, 20);
    for (let i = 0; i < 4; i++) {
      clock.advance(5000);
      registry.touch("mac");
      await registry.tick();
    }
    await settle(); // size changes resync clients first
    await Bun.sleep(20);
    ptys[0]!.emit("still here\r\n");
    await settle();
    expect(stalled.of("terminal.output").map((m) => m.data)).toEqual(["still here\r\n"]);
    // and it counts again as soon as it reports a viewport
    registry.resize("stalled", id, 30, 10);
    clock.advance(200);
    expect(ptys[0]!.resizes.at(-1)).toEqual({ cols: 30, rows: 10 });
    registry.shutdown();
  });

  test("a second socket from the same device doesn't freeze the first one's output", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create();
    const first = new FakeClient("window-1");
    const second = new FakeClient("window-2");
    await registry.attach(first, id, "mac", 80, 24);
    await registry.attach(second, id, "mac", 80, 24);
    ptys[0]!.emit("hi\r\n");
    await settle();
    expect(first.of("terminal.output")).toHaveLength(1);
    expect(second.of("terminal.output")).toHaveLength(1);
    registry.shutdown();
  });

  test("a resize from a socket that isn't attached is ignored", async () => {
    const { registry, clock, ptys } = setup();
    const { id } = registry.create({ cols: 80, rows: 24 });
    registry.resize("stranger", id, 30, 10);
    clock.advance(500);
    expect(ptys[0]!.resizes).toEqual([]);
    registry.shutdown();
  });
});

describe("input", () => {
  test("typed input reaches the shell and makes that client primary; replies from others are dropped", async () => {
    const { registry, ptys } = setup();
    const { id } = registry.create();
    await registry.attach(new FakeClient("a"), id, "a", 80, 24);
    await registry.attach(new FakeClient("b"), id, "b", 80, 24);
    registry.write("a", id, "ls\r");
    registry.write("a", id, "\x1b[12;5R"); // a's emulator answers the cursor query
    registry.write("b", id, "\x1b[12;5R"); // so does b's: dropped
    registry.write("b", id, "\x1b[?1;2c");
    expect(ptys[0]!.writes).toEqual(["ls\r", "\x1b[12;5R"]);
    registry.write("b", id, "x"); // b types: now b answers
    registry.write("b", id, "\x1b[3;3R");
    registry.write("a", id, "\x1b[3;3R");
    expect(ptys[0]!.writes).toEqual(["ls\r", "\x1b[12;5R", "x", "\x1b[3;3R"]);
    registry.shutdown();
  });

  test("when the primary detaches, the next reply goes through", async () => {
    const { registry, ptys } = setup();
    const { id } = registry.create();
    await registry.attach(new FakeClient("a"), id, "a", 80, 24);
    await registry.attach(new FakeClient("b"), id, "b", 80, 24);
    registry.write("a", id, "x");
    registry.detach("a", id);
    registry.write("b", id, "\x1b[1;1R");
    expect(ptys[0]!.writes).toEqual(["x", "\x1b[1;1R"]);
    registry.shutdown();
  });

  test("oversized or non-string writes are rejected; writes to an exited shell are dropped", () => {
    const { registry, ptys } = setup();
    const { id } = registry.create();
    expect(() => registry.write("a", id, 5)).toThrow();
    expect(() => registry.write("a", id, "x".repeat(1024 * 1024 + 1))).toThrow();
    ptys[0]!.exit(0);
    registry.write("a", id, "x");
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("input past the per-second budget is refused, and the budget refills", () => {
    const { registry, ptys, clock } = setup();
    const { id } = registry.create();
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 4; i++) registry.write("a", id, chunk);
    expect(() => registry.write("a", id, "y")).toThrow(/faster than the shell/);
    expect(ptys[0]!.writes.length).toBe(4);
    clock.advance(1000);
    registry.write("a", id, "y");
    expect(ptys[0]!.writes.at(-1)).toBe("y");
    registry.shutdown();
  });

  test("a write that lands on a closed master reads as the terminal ending, not a failure", () => {
    const { registry, ptys } = setup();
    const { id } = registry.create();
    ptys[0]!.dead = true;
    expect(() => registry.write("a", id, "x")).toThrow(expect.objectContaining({ status: 404 }));
    registry.shutdown();
  });

  test("what counts as a terminal reply", () => {
    for (const reply of ["\x1b[12;5R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b[?2004;2$y", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) {
      expect(isTerminalReply(reply)).toBe(true);
    }
    for (const typed of ["r", "\x1b", "\x1b[A", "\x1b[1;5R x", "ls\r", "\x1b[200~pasted\x1b[201~", "\x03"]) expect(isTerminalReply(typed)).toBe(false);
  });
});

describe("a crashing shell", () => {
  test("an exited terminal restarts in place: same id and screen, a new shell, attached clients resynced", async () => {
    const { registry, ptys, events, settle } = setup();
    const { id } = registry.create({ cwd: "/tmp" });
    const client = new FakeClient("a");
    await registry.attach(client, id, "a", 80, 24);
    ptys[0]!.emit("before crash\r\n");
    await settle();
    ptys[0]!.exit(139);
    expect(registry.get(id)?.state).toBe("exited");
    const info = registry.restart(id);
    expect(info).toMatchObject({ id, state: "running", exitCode: null });
    expect(ptys.length).toBe(2);
    expect(ptys[1]!.opts.cwd).toBe("/tmp");
    await settle();
    const last = client.of("terminal.snapshot").at(-1)!;
    expect(last.data).toContain("before crash");
    ptys[1]!.emit("after\r\n");
    await settle();
    expect(client.of("terminal.output").at(-1)!.data).toContain("after");
    expect(events.filter((e) => e.kind === "terminal.updated").at(-1)).toMatchObject({ terminal: { id, state: "running" } });
    // The dead shell's late exit report must not end the new one.
    ptys[0]!.exit(1);
    expect(registry.get(id)?.state).toBe("running");
    registry.shutdown();
  });

  test("a running terminal can't be restarted, an unknown one is a 404", () => {
    const { registry } = setup();
    const { id } = registry.create();
    expect(() => registry.restart(id)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => registry.restart("t-nope")).toThrow(expect.objectContaining({ status: 404 }));
    registry.shutdown();
  });

  test("a restart that can't spawn throws and leaves the terminal exited, so it can be tried again", () => {
    let fail = false;
    const { spawn, ptys } = fakeSpawn();
    const registry = new TerminalRegistry({
      bus: new EventBus(),
      spawn: (...args) => {
        if (fail) throw new Error("EAGAIN");
        return spawn(...args);
      },
      env: {},
      home: "/h",
      isDirectory: () => true,
    });
    const { id } = registry.create();
    ptys[0]!.exit(1);
    fail = true;
    expect(() => registry.restart(id)).toThrow("EAGAIN");
    expect(registry.get(id)?.state).toBe("exited");
    fail = false;
    expect(registry.restart(id).state).toBe("running");
    registry.shutdown();
  });

  test("an exception thrown while handling shell output is logged, not thrown into the PTY", () => {
    const logged: string[] = [];
    const { registry, ptys, clock } = setup({
      log: (m) => logged.push(m),
      createEmulator: () => ({
        write() {
          throw new Error("emulator exploded");
        },
        idle: async () => {},
        resize() {},
        serialize: () => ({ data: "", truncated: false }),
        dispose() {},
      }),
    });
    registry.create();
    ptys[0]!.emit("x");
    expect(() => clock.advance(10)).not.toThrow(); // the flush timer runs the throwing emulator
    expect(logged.join("\n")).toContain("emulator exploded");
    registry.shutdown();
  });
});

describe("a slow client", () => {
  test("never stalls the shell or the other client, and resyncs from a snapshot once it drains", async () => {
    const { registry, ptys, settle, clock } = setup({ highWater: 1000 });
    const { id } = registry.create();
    const fast = new FakeClient("fast");
    const slow = new FakeClient("slow");
    await registry.attach(fast, id, "f", 80, 24);
    await registry.attach(slow, id, "s", 80, 24);
    ptys[0]!.emit("one\r\n");
    await settle();
    slow.queued = 5000; // its socket backs up
    ptys[0]!.emit("two\r\n");
    await settle();
    ptys[0]!.emit("three\r\n");
    await settle();
    expect(fast.of("terminal.output").map((m) => m.data)).toEqual(["one\r\n", "two\r\n", "three\r\n"]);
    expect(slow.of("terminal.output").map((m) => m.data)).toEqual(["one\r\n"]);
    slow.queued = 0; // drained: resync once its socket has emptied
    for (let i = 0; i < 4; i++) {
      await settle();
      clock.advance(50);
    }
    await Bun.sleep(20);
    const snaps = slow.of("terminal.snapshot");
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.data).toContain("three");
    expect(snaps[1]!.offset).toBe(fast.of("terminal.output").at(-1)!.offset);
    registry.shutdown();
  });

  test("a snapshot bigger than the high-water mark doesn't make the client resync forever", async () => {
    const { registry, ptys, settle } = setup({ highWater: 1000 });
    const { id } = registry.create();
    const client = new FakeClient("c");
    const send = client.send.bind(client);
    client.send = (m) => {
      send(m);
      if (m.type === "terminal.snapshot") client.queued = 5000; // the snapshot is still draining
    };
    await registry.attach(client, id, "c", 80, 24);
    ptys[0]!.emit("one\r\n");
    await settle();
    ptys[0]!.emit("two\r\n");
    await settle();
    expect(client.of("terminal.snapshot")).toHaveLength(1);
    expect(client.of("terminal.output").map((m) => m.data)).toEqual(["one\r\n", "two\r\n"]);
    registry.shutdown();
  });

  test("a resize serializes the screen once for every attached client", async () => {
    let serializations = 0;
    const { createEmulator } = await import("./emulator");
    const { registry, clock } = setup({
      createEmulator: (cols, rows, ev) => {
        const emu = createEmulator(cols, rows, ev);
        return { ...emu, serialize: () => (serializations++, emu.serialize()) };
      },
    });
    const { id } = registry.create({ cols: 120, rows: 40 });
    const a = new FakeClient("a");
    const b = new FakeClient("b");
    await registry.attach(a, id, "a", 120, 40);
    await registry.attach(b, id, "b", 120, 40);
    serializations = 0;
    registry.resize("b", id, 60, 20);
    clock.advance(200);
    await Bun.sleep(20);
    expect(a.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 60, rows: 20 });
    expect(b.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 60, rows: 20 });
    expect(serializations).toBe(1);
    registry.shutdown();
  });
});

describe("resources", () => {
  test("a failed spawn disposes the emulator and leaves no terminal behind", () => {
    let disposed = 0;
    const { registry } = setup({
      spawn: () => {
        throw new Error("no pty");
      },
      createEmulator: () => ({ write() {}, idle: async () => {}, resize() {}, serialize: () => ({ data: "", truncated: false }), dispose: () => void disposed++ }),
    });
    expect(() => registry.create()).toThrow("no pty");
    expect(disposed).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  test("only the newest exited terminals are kept", () => {
    const { registry, ptys, clock } = setup();
    const ids = Array.from({ length: 10 }, () => registry.create().id);
    ptys.forEach((p) => {
      clock.advance(10);
      p.exit(0);
    });
    expect(registry.list().map((t) => t.id)).toEqual(ids.slice(2));
    registry.shutdown();
  });

  test("a flood of output neither throws nor wedges the emulator, and the snapshot says it is truncated", async () => {
    const { registry, ptys, settle } = setup();
    const { id } = registry.create();
    const client = new FakeClient("c");
    await registry.attach(client, id, "c", 80, 24);
    const chunk = "x".repeat(1024 * 1024) + "\r\n";
    for (let i = 0; i < 70; i++) {
      ptys[0]!.emit(chunk);
      await settle();
    }
    ptys[0]!.emit("tail\r\n");
    await settle();
    const late = new FakeClient("late");
    await registry.attach(late, id, "l", 80, 24); // completing at all means the emulator went idle
    expect(late.of("terminal.snapshot")[0]!.truncated).toBe(true);
    expect(client.of("terminal.output").at(-1)!.data).toBe("tail\r\n");
    registry.shutdown();
  });
});
