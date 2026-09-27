import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { CdpClient, CdpClosedError, CdpError, CdpTimeoutError } from "./cdp.ts";

type Msg = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Handler = (msg: Msg, ws: ServerWebSocket<unknown>) => void;

let server: Server<unknown>;
let handler: Handler = () => {};
let lastSocket: ServerWebSocket<unknown> | undefined;
const received: Msg[] = [];
const clients: CdpClient[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        lastSocket = ws;
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Msg;
        received.push(msg);
        handler(msg, ws);
      },
    },
  });
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  received.length = 0;
  handler = () => {};
});

afterAll(() => {
  void server.stop(true);
});

async function connect(timeoutMs?: number): Promise<CdpClient> {
  const c = await CdpClient.connect(`ws://127.0.0.1:${server.port}/devtools/browser/x`, { timeoutMs });
  clients.push(c);
  return c;
}

const reply = (ws: ServerWebSocket<unknown>, body: Record<string, unknown>) => ws.send(JSON.stringify(body));

describe("CdpClient", () => {
  test("routes out-of-order responses to the right request by id", async () => {
    const held: Msg[] = [];
    handler = (msg, ws) => {
      held.push(msg);
      if (held.length === 2) {
        // Answer the second request first.
        reply(ws, { id: held[1]!.id, result: { which: held[1]!.method } });
        reply(ws, { id: held[0]!.id, result: { which: held[0]!.method } });
      }
    };
    const c = await connect();
    const [a, b] = await Promise.all([c.send("A.first"), c.send("B.second")]);
    expect(a).toEqual({ which: "A.first" });
    expect(b).toEqual({ which: "B.second" });
    expect(received[0]!.id).not.toBe(received[1]!.id);
  });

  test("protocol errors reject with CdpError carrying code and message", async () => {
    handler = (msg, ws) => reply(ws, { id: msg.id, error: { code: -32000, message: "No target with given id", data: "extra" } });
    const c = await connect();
    const err = await c.send("Target.closeTarget", { targetId: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect(err.code).toBe(-32000);
    expect(err.method).toBe("Target.closeTarget");
    expect(err.message).toContain("No target with given id");
    expect(err.message).toContain("extra");
  });

  test("commands time out and a late reply is ignored", async () => {
    let late: Msg | undefined;
    handler = (msg) => {
      late = msg;
    };
    const c = await connect();
    const err = await c.send("Slow.method", {}, undefined, 50).catch((e) => e);
    expect(err).toBeInstanceOf(CdpTimeoutError);
    expect(err.message).toContain("Slow.method");
    // The late reply must not resolve anything or throw; the client keeps working.
    reply(lastSocket!, { id: late!.id, result: { tooLate: true } });
    handler = (msg, ws) => reply(ws, { id: msg.id, result: { ok: true } });
    expect(await c.send("Fast.method")).toEqual({ ok: true });
  });

  test("session commands carry sessionId and session events only reach that session", async () => {
    handler = (msg, ws) => {
      reply(ws, { id: msg.id, sessionId: msg.sessionId, result: { from: msg.sessionId ?? "browser" } });
    };
    const c = await connect();
    const s1 = c.session("S1");
    const s2 = c.session("S2");
    expect(await s1.send("Page.enable")).toEqual({ from: "S1" });
    expect(await c.send("Browser.getVersion")).toEqual({ from: "browser" });
    expect(received.map((m) => m.sessionId)).toEqual(["S1", undefined]);

    const got1: unknown[] = [];
    const got2: unknown[] = [];
    const gotAll: [unknown, string | undefined][] = [];
    s1.on("Page.loadEventFired", (p) => got1.push(p));
    s2.on("Page.loadEventFired", (p) => got2.push(p));
    c.on("Page.loadEventFired", (p, sid) => gotAll.push([p, sid]));
    reply(lastSocket!, { method: "Page.loadEventFired", sessionId: "S2", params: { timestamp: 2 } });
    reply(lastSocket!, { method: "Page.loadEventFired", sessionId: "S1", params: { timestamp: 1 } });
    reply(lastSocket!, { method: "Page.loadEventFired", params: { timestamp: 0 } });
    await c.send("Sync.barrier"); // events before a reply are delivered in order
    expect(got1).toEqual([{ timestamp: 1 }]);
    expect(got2).toEqual([{ timestamp: 2 }]);
    expect(gotAll).toEqual([
      [{ timestamp: 2 }, "S2"],
      [{ timestamp: 1 }, "S1"],
      [{ timestamp: 0 }, undefined],
    ]);
  });

  test("unsubscribing stops delivery", async () => {
    handler = (msg, ws) => reply(ws, { id: msg.id, result: {} });
    const c = await connect();
    const seen: unknown[] = [];
    const off = c.on("X.event", (p) => seen.push(p));
    reply(lastSocket!, { method: "X.event", params: { n: 1 } });
    await c.send("Sync.barrier");
    off();
    reply(lastSocket!, { method: "X.event", params: { n: 2 } });
    await c.send("Sync.barrier");
    expect(seen).toEqual([{ n: 1 }]);
  });

  test("Target.detachedFromTarget rejects only that session's in-flight commands", async () => {
    handler = (msg, ws) => {
      if (msg.method === "Other.ping") reply(ws, { id: msg.id, sessionId: msg.sessionId, result: { pong: true } });
      // Everything else is left hanging.
    };
    const c = await connect();
    const doomed = c.session("DEAD").send("Runtime.evaluate", { expression: "1" }).catch((e) => e);
    const survivor = c.session("ALIVE").send("Runtime.evaluate", { expression: "2" }, 300).catch((e) => e);
    await Bun.sleep(10);
    reply(lastSocket!, { method: "Target.detachedFromTarget", params: { sessionId: "DEAD" } });
    const err = await doomed;
    expect(err).toBeInstanceOf(CdpClosedError);
    expect(err.message).toContain("detached");
    // The other session's command was not rejected by the detach — it times out instead.
    expect(await survivor).toBeInstanceOf(CdpTimeoutError);
    expect(await c.session("ALIVE").send("Other.ping")).toEqual({ pong: true });
  });

  test("server close rejects pending commands, fires onClose, and blocks further sends", async () => {
    handler = () => {};
    const c = await connect();
    let closeReason = "";
    c.onClose((r) => (closeReason = r));
    const pending = c.send("Never.answered").catch((e) => e);
    await Bun.sleep(10);
    lastSocket!.close(1011, "bye");
    const err = await pending;
    expect(err).toBeInstanceOf(CdpClosedError);
    expect(c.closed).toBe(true);
    expect(closeReason).toContain("closed");
    expect(await c.send("After.close").catch((e) => e)).toBeInstanceOf(CdpClosedError);
  });

  test("waitFor honours sessionId and predicate, and times out", async () => {
    handler = (msg, ws) => reply(ws, { id: msg.id, result: {} });
    const c = await connect();
    const w = c.waitFor("Page.lifecycleEvent", { sessionId: "S", predicate: (p) => p.name === "load" });
    reply(lastSocket!, { method: "Page.lifecycleEvent", sessionId: "OTHER", params: { name: "load" } });
    reply(lastSocket!, { method: "Page.lifecycleEvent", sessionId: "S", params: { name: "init" } });
    reply(lastSocket!, { method: "Page.lifecycleEvent", sessionId: "S", params: { name: "load", n: 3 } });
    expect(await w).toEqual({ name: "load", n: 3 });
    expect(await c.waitFor("Never.happens", { timeoutMs: 30 }).catch((e) => e)).toBeInstanceOf(CdpTimeoutError);
  });

  test("connect rejects when nothing is listening", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    await expect(CdpClient.connect(`ws://127.0.0.1:${port}/`, { connectTimeoutMs: 2000 })).rejects.toThrow();
  });
});
