import { expect, test } from "bun:test";
import { Socket } from "./daemon";

/** A /ws server that sends `welcome`, then every message the test pushes. */
function server() {
  const clients = new Set<{ send(s: string): void }>();
  const s = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "welcome" }));
      },
      message() {},
    },
  });
  return { url: `ws://localhost:${s.port}`, push: (m: object) => clients.forEach((c) => c.send(JSON.stringify(m))), stop: () => s.stop(true) };
}

test("waiting for B after A doesn't lose B when B arrived before A", async () => {
  const srv = server();
  try {
    const sock = new Socket(srv.url);
    await sock.ready;
    srv.push({ type: "terminal.output", id: "b" });
    srv.push({ type: "terminal.output", id: "a" });
    const a = await sock.message("A", (m) => (m as { id?: string }).id === "a", 2000);
    const b = await sock.message("B", (m) => (m as { id?: string }).id === "b", 2000);
    expect([(a as { id: string }).id, (b as { id: string }).id]).toEqual(["a", "b"]);
    // A message a wait took is not handed to the next wait with the same predicate.
    await expect(sock.message("A again", (m) => (m as { id?: string }).id === "a", 100)).rejects.toThrow(/timed out/);
    sock.close();
  } finally {
    srv.stop();
  }
});
