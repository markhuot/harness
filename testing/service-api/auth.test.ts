import { afterEach, expect, test } from "bun:test";
import { boot, stopRigs } from "./boot";
import { WsClient } from "./ws-client";

afterEach(stopRigs);

/** One route per way the handler authenticates: the router, an attachment file, the two legacy file routes, a plugin's API. */
const GUARDED: [string, string][] = [
  ["GET", "/projects"],
  ["POST", "/tickets"],
  ["GET", "/attachments/nope"],
  ["GET", "/tickets/ACME-1/prompt-attachments/0"],
  ["GET", "/transcript/nope/attachments/0"],
  ["GET", "/plugins/nope/api/x"],
  ["GET", "/ws"],
];

test("every guarded route class answers 401 {error} to a missing or wrong token, whatever the method", async () => {
  const rig = await boot();
  for (const [method, path] of GUARDED) {
    for (const auth of [null, "wrong", ""]) {
      const res = await rig.call(method, path, undefined, { auth });
      expect([method, path, auth, res.status]).toEqual([method, path, auth, 401]);
      expect(res.body).toEqual({ error: "Unauthorized" });
    }
  }
});

test("/health needs no token and says the service is up", async () => {
  const rig = await boot();
  const res = await rig.call<{ ok: boolean; pid: number }>("GET", "/health", undefined, { auth: null });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ ok: true, pid: process.pid });
});

test("the token goes in the Authorization header for the API and in ?token= only where a header can't be set", async () => {
  const rig = await boot();
  const { token } = rig.harness;
  // The router takes the bearer only: a query token doesn't open it.
  expect((await fetch(`${rig.harness.url}/projects?token=${token}`)).status).toBe(401);
  // Attachment files take either, because <img> and <video> can't send headers.
  const viaQuery = await fetch(`${rig.harness.url}/attachments/nope?token=${token}`);
  expect(viaQuery.status).toBe(404);
  const viaHeader = await fetch(`${rig.harness.url}/attachments/nope`, { headers: { authorization: `Bearer ${token}` } });
  expect(viaHeader.status).toBe(404);
  // A bearer without the scheme, or another scheme, is no token.
  expect((await fetch(`${rig.harness.url}/projects`, { headers: { authorization: token } })).status).toBe(401);
  expect((await fetch(`${rig.harness.url}/projects`, { headers: { authorization: `Basic ${token}` } })).status).toBe(401);
});

test("/ws refuses a bad token before upgrading, and a plain request with the right token is told to upgrade", async () => {
  const rig = await boot();
  expect((await fetch(`${rig.harness.url}/ws?token=wrong`)).status).toBe(401);
  expect((await fetch(`${rig.harness.url}/ws`)).status).toBe(401);
  const plain = await fetch(`${rig.harness.url}/ws?token=${rig.harness.token}`);
  expect(plain.status).toBe(400);
  expect(await plain.json()).toEqual({ error: "WebSocket upgrade required" });

  const refused = new WsClient(`${rig.harness.url.replace(/^http/, "ws")}/ws?token=wrong`);
  await expect(refused.ready).rejects.toThrow(/closed/);
  expect(refused.messages).toEqual([]);
});

test("/mcp is run-scoped, not bearer-scoped: it answers a loopback caller with no bearer, and a token no run holds gets an error body", async () => {
  const rig = await boot();
  const res = await fetch(`${rig.harness.url}/mcp/not-a-run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).not.toBe(401);
  expect(res.status).not.toBe(403);
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("rotating the token locks the old one out of HTTP and /ws, lets the new one in, and closes sockets opened with the old one (4001)", async () => {
  const rig = await boot();
  const oldToken = rig.harness.token;
  const open = await rig.socket();
  const rotated = await rig.ok<{ token: string }>("POST", "/token/rotate");
  expect(rotated.token).not.toBe(oldToken);
  expect(rig.harness.token).toBe(rotated.token);

  expect(await open.waitClosed()).toMatchObject({ code: 4001 });
  expect((await rig.call("GET", "/projects", undefined, { auth: oldToken })).status).toBe(401);
  expect((await rig.call("GET", "/projects")).status).toBe(200);
  const stale = new WsClient(`${rig.harness.url.replace(/^http/, "ws")}/ws?token=${oldToken}`);
  await expect(stale.ready).rejects.toThrow(/closed/);

  const fresh = await rig.socket();
  expect(fresh.closed).toBeNull();
});

test("a rotated token is the one on disk, so a restart of the service on the same home keeps it", async () => {
  const rig = await boot();
  const { token } = await rig.ok<{ token: string }>("POST", "/token/rotate");
  const { readFileSync, readdirSync } = await import("node:fs");
  const file = readdirSync(rig.harness.paths.home).find((f) => /token/.test(f));
  expect(file).toBeDefined();
  expect(readFileSync(`${rig.harness.paths.home}/${file}`, "utf8").trim()).toBe(token);
});
