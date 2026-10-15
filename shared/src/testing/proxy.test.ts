import { describe, expect, test } from "bun:test";
import { startDaemonProxy } from "./proxy";

/** A stand-in daemon: GET /x answers its own path, /ws echoes every message back. */
function backend() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      return Response.json({ data: { from: "daemon", path: new URL(req.url).pathname, auth: req.headers.get("authorization") } });
    },
    websocket: { message: (ws, m) => void ws.send(`echo:${m}`) },
  });
}

const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket failed"));
  });

describe("startDaemonProxy", () => {
  test("forwards requests it doesn't intercept, with the caller's headers", async () => {
    const be = backend();
    const proxy = startDaemonProxy(`http://127.0.0.1:${be.port}`, { intercept: (req) => (new URL(req.url).pathname === "/usage" ? Response.json({ data: { from: "proxy" } }) : undefined) });
    try {
      expect(await (await fetch(`${proxy.base}/usage`)).json()).toEqual({ data: { from: "proxy" } });
      expect(await (await fetch(`${proxy.base}/tickets`, { headers: { authorization: "Bearer t" } })).json()).toEqual({ data: { from: "daemon", path: "/tickets", auth: "Bearer t" } });
    } finally {
      proxy.stop();
      be.stop(true);
    }
  });

  test("drops or rewrites what the daemon sends a client, and passes the rest", async () => {
    const be = backend();
    const proxy = startDaemonProxy(`http://127.0.0.1:${be.port}`, { onUpstreamMessage: (m) => (m === "echo:drop" ? null : m === "echo:swap" ? "swapped" : m) });
    try {
      const ws = await open(`${proxy.base.replace("http", "ws")}/ws`);
      const got: string[] = [];
      ws.onmessage = (e) => got.push(String(e.data));
      await Bun.sleep(150); // the upstream socket is open once the proxy has relayed
      for (const m of ["drop", "swap", "keep"]) ws.send(m);
      await Bun.sleep(250);
      expect(got).toEqual(["swapped", "echo:keep"]);
      ws.close();
    } finally {
      proxy.stop();
      be.stop(true);
    }
  });

  test("passes socket traffic both ways, reports what clients send and pushes events to them", async () => {
    const be = backend();
    const seen: string[] = [];
    const proxy = startDaemonProxy(`http://127.0.0.1:${be.port}`, { onClientMessage: (m) => seen.push(m) });
    try {
      const ws = await open(`${proxy.base.replace("http", "ws")}/ws`);
      const got: string[] = [];
      ws.onmessage = (e) => got.push(String(e.data));
      // Sent before the upstream socket opens: it queues, then flows.
      ws.send("one");
      await Bun.sleep(150);
      ws.send("two");
      await Bun.sleep(150);
      expect(seen).toEqual(["one", "two"]);
      expect(got).toEqual(["echo:one", "echo:two"]);
      expect(proxy.clients).toBe(1);
      proxy.push({ kind: "usage.updated", n: 1 });
      await Bun.sleep(50);
      expect(JSON.parse(got.at(-1)!)).toEqual({ type: "event", event: { kind: "usage.updated", n: 1 } });
      ws.close();
      await Bun.sleep(100);
      expect(proxy.clients).toBe(0);
    } finally {
      proxy.stop();
      be.stop(true);
    }
  });
});
