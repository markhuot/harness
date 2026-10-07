import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { tempDir } from "@harness/shared/testing";
import { ApnsClient, ApnsTokens, Http2Transport, JWT_TTL_MS, findApnsKeys, isDeadToken, type ApnsKeyFile } from "./apns";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TOKEN = "c0ffee".repeat(10) + "abcd";

interface Seen {
  host: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A plaintext HTTP/2 server per fake origin; answers with `reply`. */
async function fakeApns(reply: (seen: Seen) => { status: number; body?: string } = () => ({ status: 200 })) {
  const seen: Seen[] = [];
  const server: Http2Server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      const s = { host: String(headers[":authority"]), headers, body };
      seen.push(s);
      const r = reply(s);
      stream.respond({ ":status": r.status, "apns-id": "11111111-2222-3333-4444-555555555555" });
      stream.end(r.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  servers.push(server);
  return { seen, origin: `http://127.0.0.1:${port}` };
}

const servers: Http2Server[] = [];
const transports: Http2Transport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.close();
  for (const s of servers.splice(0)) s.close();
});

function keyFile(environment: "sandbox" | "production", keyId: string): ApnsKeyFile {
  const dir = tempDir();
  const path = join(dir, `AuthKey_${keyId}_APN_${environment === "sandbox" ? "Sandbox" : "Production"}.p8`);
  writeFileSync(path, PEM);
  return { environment, keyId, path };
}

function decodeJwt(jwt: string) {
  const [h, b, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(b!, "base64url").toString()),
    valid: verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")),
  };
}

describe("ApnsClient over HTTP/2", () => {
  test("posts to the environment's host with the JWT, topic, push type and thread-id", async () => {
    const prod = await fakeApns();
    const sandbox = await fakeApns();
    const transport = new Http2Transport();
    transports.push(transport);
    const client = new ApnsClient({ transport, origins: { production: prod.origin, sandbox: sandbox.origin }, now: () => 1_800_000_000_000 });
    const payload = { aps: { alert: { title: "SPEC-1 · Login", body: "hi" }, "thread-id": "SPEC-1" }, ticketKey: "SPEC-1" };

    const r1 = await client.send(keyFile("production", "D2RG5FFJC5"), "47P4ZSALX4", { environment: "production", deviceToken: TOKEN, topic: "com.markhuot.harness", payload });
    const r2 = await client.send(keyFile("sandbox", "FBUNLH99K7"), "47P4ZSALX4", { environment: "sandbox", deviceToken: TOKEN, topic: "com.markhuot.harness", payload });
    expect(r1).toEqual({ ok: true, status: 200, reason: null });
    expect(r2.ok).toBe(true);
    expect(prod.seen.length).toBe(1);
    expect(sandbox.seen.length).toBe(1);

    for (const [seen, kid] of [
      [prod.seen[0]!, "D2RG5FFJC5"],
      [sandbox.seen[0]!, "FBUNLH99K7"],
    ] as const) {
      expect(seen.headers[":method"]).toBe("POST");
      expect(seen.headers[":path"]).toBe(`/3/device/${TOKEN}`);
      expect(seen.headers["apns-topic"]).toBe("com.markhuot.harness");
      expect(seen.headers["apns-push-type"]).toBe("alert");
      expect(seen.headers["apns-priority"]).toBe("10");
      expect(seen.headers["apns-expiration"]).toBe(String(1_800_000_000 + 86400));
      expect(JSON.parse(seen.body)).toEqual(payload);
      const auth = String(seen.headers.authorization);
      expect(auth.startsWith("bearer ")).toBe(true);
      const jwt = decodeJwt(auth.slice(7));
      expect(jwt.header).toEqual({ alg: "ES256", kid });
      expect(jwt.claims.iss).toBe("47P4ZSALX4");
      expect(typeof jwt.claims.iat).toBe("number");
      expect(jwt.valid).toBe(true);
    }
  });

  test("returns Apple's reason, and a dead token is recognised", async () => {
    const apns = await fakeApns(() => ({ status: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 1 }) }));
    const transport = new Http2Transport();
    transports.push(transport);
    const client = new ApnsClient({ transport, origins: { production: apns.origin, sandbox: apns.origin } });
    const r = await client.send(keyFile("production", "D2RG5FFJC5"), "47P4ZSALX4", { environment: "production", deviceToken: TOKEN, topic: "t", payload: {} });
    expect(r).toEqual({ ok: false, status: 410, reason: "Unregistered" });
    expect(isDeadToken(r)).toBe(true);
    expect(isDeadToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadToken({ ok: false, status: 400, reason: "BadTopic" })).toBe(false);
    expect(isDeadToken({ ok: false, status: 500, reason: null })).toBe(false);
  });

  test("an expired provider token is re-signed and retried once", async () => {
    let calls = 0;
    const apns = await fakeApns(() => (++calls === 1 ? { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) } : { status: 200 }));
    let t = 1_000_000;
    const tokens = new ApnsTokens(undefined, () => (t += 1000));
    const transport = new Http2Transport();
    transports.push(transport);
    const client = new ApnsClient({ transport, tokens, origins: { production: apns.origin, sandbox: apns.origin } });
    const r = await client.send(keyFile("production", "D2RG5FFJC5"), "47P4ZSALX4", { environment: "production", deviceToken: TOKEN, topic: "t", payload: {} });
    expect(r.ok).toBe(true);
    expect(apns.seen.length).toBe(2);
    expect(apns.seen[0]!.headers.authorization).not.toBe(apns.seen[1]!.headers.authorization);
  });

  test("an unreachable host is a failed result, not a throw", async () => {
    const transport = new Http2Transport();
    transports.push(transport);
    const client = new ApnsClient({ transport, origins: { production: "http://127.0.0.1:9", sandbox: "http://127.0.0.1:9" } });
    const r = await client.send(keyFile("production", "D2RG5FFJC5"), "47P4ZSALX4", { environment: "production", deviceToken: TOKEN, topic: "t", payload: {} });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.reason).toBeTruthy();
  });
});

describe("ApnsTokens", () => {
  test("reuses a token until it's 40 minutes old, then signs a new one", async () => {
    let t = 1_700_000_000_000;
    let reads = 0;
    const tokens = new ApnsTokens(() => (reads++, PEM), () => t);
    const key: ApnsKeyFile = { environment: "production", keyId: "D2RG5FFJC5", path: "/k.p8" };
    const a = await tokens.get(key, "47P4ZSALX4");
    t += JWT_TTL_MS - 1;
    expect(await tokens.get(key, "47P4ZSALX4")).toBe(a);
    t += 1;
    const b = await tokens.get(key, "47P4ZSALX4");
    expect(b).not.toBe(a);
    expect(decodeJwt(b).claims.iat).toBe(Math.floor(t / 1000));
    expect(reads).toBe(2);
    // Each key, and each team, has its own token.
    expect(await tokens.get({ ...key, keyId: "FBUNLH99K7", environment: "sandbox" }, "47P4ZSALX4")).not.toBe(b);
  });
});

describe("findApnsKeys", () => {
  test("finds one key per environment by the AuthKey_<id>_APN_<Env>.p8 naming, ignoring other keys", () => {
    const dir = tempDir();
    for (const name of ["AuthKey_FBUNLH99K7_APN_Sandbox.p8", "AuthKey_D2RG5FFJC5_APN_Production.p8", "AuthKey_ABCDEFGHIJ.p8", "notes.txt"]) writeFileSync(join(dir, name), "");
    const keys = findApnsKeys(dir);
    expect(keys.sandbox).toEqual({ environment: "sandbox", keyId: "FBUNLH99K7", path: join(dir, "AuthKey_FBUNLH99K7_APN_Sandbox.p8") });
    expect(keys.production?.keyId).toBe("D2RG5FFJC5");
  });

  test("a missing folder or a missing environment is null", () => {
    expect(findApnsKeys("/nonexistent/keys")).toEqual({ sandbox: null, production: null });
    const dir = tempDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "AuthKey_D2RG5FFJC5_APN_Production.p8"), "");
    expect(findApnsKeys(dir).sandbox).toBeNull();
  });
});
