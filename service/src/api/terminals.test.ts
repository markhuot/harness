import { afterEach, describe, expect, test } from "bun:test";
import { HarnessClient, type ClientMessage, type ServerMessage } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { stubBrowser, tempHome } from "../testing/fakes";
import { fakeSpawn } from "../terminals/testing";

let harness: Harness | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await harness?.stop();
  harness = null;
});

async function boot() {
  const spawned = fakeSpawn();
  harness = await createHarness({ home: tempHome("harness-term-"), port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, spawnPty: spawned.spawn, log: () => {} });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  return { h: harness, client, ...spawned };
}

async function socket(h: Harness, presence?: { deviceId: string; platform: "mac" | "ios"; visible: boolean }) {
  const ws = new WebSocket(`${h.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(h.token)}`);
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
  if (presence) {
    send({ type: "presence", ...presence, tickets: [] });
    await Bun.sleep(30);
  }
  return { ws, messages, send };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("/terminals", () => {
  test("create, list and close over HTTP", async () => {
    const { client, ptys } = await boot();
    const t = await client.createTerminal({ projectId: "prj_1", deviceId: "dev" });
    expect(await client.terminals()).toEqual([t]);
    expect(ptys).toHaveLength(1);
    await client.closeTerminal(t.id);
    expect(await client.terminals()).toEqual([]);
    expect(ptys[0]!.kills).toEqual(["SIGHUP"]);
    await expect(client.closeTerminal(t.id)).rejects.toMatchObject({ status: 404 });
  });

  test("refresh looks up every terminal, attached or not", async () => {
    const { client } = await boot();
    await client.createTerminal();
    // the real ps/lsof run against a fake pid: nothing to report, but the call must work
    expect(await client.terminals(true)).toHaveLength(1);
  });
});

describe("terminal messages over the WebSocket", () => {
  test("attach answers with a snapshot, then output; write reaches the shell; detach stops the stream", async () => {
    const { client, ptys } = await boot();
    const t = await client.createTerminal();
    const s = await socket(harness!);
    s.send({ type: "terminal.attach", id: t.id, deviceId: "d", cols: 80, rows: 24 });
    await until(() => s.messages.some((m) => m.type === "terminal.snapshot"));
    ptys[0]!.emit("hi\r\n");
    await until(() => s.messages.some((m) => m.type === "terminal.output"));
    expect(s.messages.find((m) => m.type === "terminal.output")).toMatchObject({ data: "hi\r\n", offset: 4 });
    s.send({ type: "terminal.write", id: t.id, data: "ls\r" });
    await until(() => ptys[0]!.writes.length === 1);
    expect(ptys[0]!.writes).toEqual(["ls\r"]);
    s.send({ type: "terminal.detach", id: t.id });
    await Bun.sleep(30);
    const before = s.messages.length;
    ptys[0]!.emit("more");
    await Bun.sleep(30);
    expect(s.messages.length).toBe(before);
  });

  test("attaching to a terminal that is gone reads as ended, and a closed socket detaches", async () => {
    const { client } = await boot();
    const s = await socket(harness!);
    s.send({ type: "terminal.attach", id: "t-gone", deviceId: "d", cols: 80, rows: 24 });
    await until(() => s.messages.some((m) => m.type === "terminal.exit"));
    const t = await client.createTerminal({ cols: 120, rows: 40 });
    const phone = await socket(harness!);
    phone.send({ type: "terminal.attach", id: t.id, deviceId: "p", cols: 50, rows: 20 });
    await until(() => phone.messages.some((m) => m.type === "terminal.snapshot"));
    await until(async () => (await client.terminals())[0]!.cols === 50);
    phone.ws.close();
    // the phone's socket closed: after the grow delay the shell is back to what the rest fit,
    // which is nobody, so it keeps the last size (nothing is killed either)
    await Bun.sleep(50);
    expect(await client.terminals()).toHaveLength(1);
  });
});

describe("terminal.open", () => {
  const mac = (deviceId: string, visible = true) => ({ deviceId, platform: "mac" as const, visible });
  const opened = (s: { messages: ServerMessage[] }) => s.messages.filter((m) => m.type === "terminal.open");

  test("only Mac sockets get it, once per Mac even with several windows, preferring a visible window", async () => {
    const { client } = await boot();
    const win1 = await socket(harness!, mac("mac-1", false));
    const win2 = await socket(harness!, mac("mac-1", true));
    const otherMac = await socket(harness!, mac("mac-2"));
    const phone = await socket(harness!, { deviceId: "ios-1", platform: "ios", visible: true });
    const anonymous = await socket(harness!);
    const t = await client.createTerminal({ projectId: "prj_1", openOnMac: true });
    await until(() => opened(win2).length === 1 && opened(otherMac).length === 1);
    await Bun.sleep(30);
    expect(opened(win1)).toEqual([]);
    expect(opened(phone)).toEqual([]);
    expect(opened(anonymous)).toEqual([]);
    expect(opened(win2)[0]).toEqual({ type: "terminal.open", id: t.id, projectId: "prj_1" });
  });

  test("without openOnMac nothing is sent, and a Mac that connects later isn't told", async () => {
    const { client } = await boot();
    const early = await socket(harness!, mac("mac-1"));
    await client.createTerminal();
    await client.createTerminal({ openOnMac: true });
    await until(() => opened(early).length === 1);
    const late = await socket(harness!, mac("mac-2"));
    await Bun.sleep(50);
    expect(opened(late)).toEqual([]);
    early.ws.close();
    // no Mac connected right now: creating still works and nothing queues
    await client.createTerminal({ openOnMac: true });
    const newcomer = await socket(harness!, mac("mac-3"));
    await Bun.sleep(50);
    expect(opened(newcomer)).toEqual([]);
  });
});
