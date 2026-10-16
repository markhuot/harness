// The real thing: a PTY from Bun.spawn({ terminal }), a real shell, and the system's ps and lsof.

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { EventBus } from "../events";
import { spawnBunPty } from "./pty";
import { TerminalRegistry } from "./registry";
import { FakeClient } from "./testing";

let registry: TerminalRegistry | null = null;
afterEach(() => {
  registry?.shutdown();
  registry = null;
});

function make() {
  registry = new TerminalRegistry({ bus: new EventBus(), spawn: spawnBunPty, env: { SHELL: "/bin/sh", PATH: process.env.PATH, HOME: "/tmp", PS1: "$ " }, home: "/tmp", flushMs: 1 });
  return registry;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

const text = (c: FakeClient) => c.of("terminal.snapshot").map((m) => m.data).join("") + c.of("terminal.output").map((m) => m.data).join("");

describe("real PTY", () => {
  test("cd /tmp && sleep reports the cwd and the foreground process", async () => {
    const reg = make();
    const { id } = reg.create({ cwd: "/" });
    const client = new FakeClient("s1");
    await reg.attach(client, id, "d", 100, 30);
    reg.write("s1", id, "cd /tmp && sleep 30\r");
    await until(async () => {
      await reg.poll(false);
      return reg.get(id)!.process === "sleep";
    });
    expect(realpathSync(reg.get(id)!.cwd)).toBe(realpathSync("/tmp"));
  });

  test("stty size follows attaches and detaches", async () => {
    const reg = make();
    const { id } = reg.create({ cols: 100, rows: 30 });
    const mac = new FakeClient("mac");
    await reg.attach(mac, id, "mac", 100, 30);
    reg.write("mac", id, "stty size\r");
    await until(() => text(mac).includes("30 100"));
    const phone = new FakeClient("phone");
    await reg.attach(phone, id, "phone", 50, 20);
    await Bun.sleep(300);
    reg.write("mac", id, "stty size\r");
    await until(() => text(mac).includes("20 50"));
    // the phone is sent the screen at the size it is drawn at
    expect(phone.of("terminal.snapshot").at(-1)).toMatchObject({ cols: 50, rows: 20 });
    reg.detach("phone", id);
    await until(() => reg.get(id)!.cols === 100, 4000);
    reg.write("mac", id, "stty size\r");
    await until(() => (text(mac).match(/30 100/g) ?? []).length >= 2);
  });

  test("a second client attached later sees the earlier output in its snapshot", async () => {
    const reg = make();
    const { id } = reg.create({});
    const first = new FakeClient("a");
    await reg.attach(first, id, "a", 80, 24);
    reg.write("a", id, "echo marker-$((6*7))\r");
    await until(() => text(first).includes("marker-42"));
    const second = new FakeClient("b");
    await reg.attach(second, id, "b", 80, 24);
    expect(second.of("terminal.snapshot")[0]!.data).toContain("marker-42");
  });

  test("exiting the shell marks the terminal exited with its code", async () => {
    const reg = make();
    const { id } = reg.create({});
    const client = new FakeClient("a");
    await reg.attach(client, id, "a", 80, 24);
    reg.write("a", id, "exit 7\r");
    await until(() => reg.get(id)!.state === "exited");
    expect(reg.get(id)!.exitCode).toBe(7);
    expect(client.of("terminal.exit").at(-1)!.exitCode).toBe(7);
  });

  test("close ends a shell that is running a program", async () => {
    const reg = make();
    const { id } = reg.create({});
    const client = new FakeClient("a");
    await reg.attach(client, id, "a", 80, 24);
    reg.write("a", id, "sleep 60\r");
    await Bun.sleep(300);
    reg.close(id);
    expect(reg.get(id)).toBeNull();
  });
});
