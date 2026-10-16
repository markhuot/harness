import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApnsClient, ApnsTokens, apnsJwt, findApnsKeys, isDeadToken, type ApnsHttpResponse, type ApnsKeyFile, type ApnsTransport } from "../../../service/src/notifications/apns";
import { fakeClock } from "../../builders/clock";
import { tempDir } from "../../builders/tmp";

/** A throwaway P-256 key: its PEM for signing and its public half for checking the signature. */
async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`, pub: pair.publicKey };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

test("apnsJwt carries the key id and team, stamps iat from the given clock, and verifies against the public key", async () => {
  const { pem, pub } = await makeKey();
  const jwt = await apnsJwt("KEYID12345", "TEAM123456", pem, 1_700_000_123_999);
  const [head, body, sig] = jwt.split(".") as [string, string, string];
  expect(decode(head)).toEqual({ alg: "ES256", kid: "KEYID12345" });
  expect(decode(body)).toEqual({ iss: "TEAM123456", iat: 1_700_000_123 });
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${head}.${body}`));
  expect(ok).toBe(true);
});

test("findApnsKeys picks the first key per environment by name and ignores other files", () => {
  const dir = tempDir();
  for (const name of ["AuthKey_BBBBBBBBBB_APN_Sandbox.p8", "AuthKey_AAAAAAAAAA_APN_Sandbox.p8", "AuthKey_CCCCCCCCCC_APN_Production.p8", "AuthKey_DDDDDDDDDD.p8", "notes.txt"]) {
    writeFileSync(join(dir, name), "");
  }
  const keys = findApnsKeys(dir);
  expect(keys.sandbox).toEqual({ environment: "sandbox", keyId: "AAAAAAAAAA", path: join(dir, "AuthKey_AAAAAAAAAA_APN_Sandbox.p8") });
  expect(keys.production?.keyId).toBe("CCCCCCCCCC");
  expect(findApnsKeys(join(dir, "missing"))).toEqual({ sandbox: null, production: null });
});

test("a signed token is reused for 40 minutes and signed anew after, by the injected clock", async () => {
  const { pem } = await makeKey();
  const clock = fakeClock(1_000_000);
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const first = await tokens.get(key, "TEAM123456");
  // Apple refuses tokens older than an hour and throttles refreshes under 20 minutes: reused for 40.
  const FORTY_MINUTES = 40 * 60_000;
  clock.advance(FORTY_MINUTES - 1);
  expect(await tokens.get(key, "TEAM123456")).toBe(first);
  expect(reads).toBe(1);
  clock.advance(1);
  const second = await tokens.get(key, "TEAM123456");
  expect(second).not.toBe(first);
  expect(reads).toBe(2);
});

test("forget drops the cached token; another team gets its own", async () => {
  const { pem } = await makeKey();
  const clock = fakeClock();
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  await tokens.get(key, "TEAM123456");
  await tokens.get(key, "OTHERTEAM1");
  expect(reads).toBe(2);
  tokens.forget(key, "TEAM123456");
  await tokens.get(key, "TEAM123456");
  expect(reads).toBe(3);
});

/** A transport answering from a script, recording what it was asked. */
function transport(...answers: (ApnsHttpResponse | Error)[]) {
  const calls: { origin: string; path: string; headers: Record<string, string>; body: string }[] = [];
  const t: ApnsTransport = {
    async post(origin, path, headers, body) {
      calls.push({ origin, path, headers, body });
      const next = answers.shift();
      if (!next) throw new Error("unscripted request");
      if (next instanceof Error) throw next;
      return next;
    },
    close() {},
  };
  return { t, calls };
}
const res = (status: number, body = ""): ApnsHttpResponse => ({ status, body, headers: {} });
const send = { environment: "sandbox" as const, deviceToken: "ab".repeat(32), topic: "com.x.app", payload: { aps: {} } };

async function client(...answers: (ApnsHttpResponse | Error)[]) {
  const { pem } = await makeKey();
  const { t, calls } = transport(...answers);
  const clock = fakeClock(2_000_000_000_000);
  const tokens = new ApnsTokens(() => pem, clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  return { apns: new ApnsClient({ transport: t, tokens, now: clock }), calls, key, clock };
}

test("a 200 posts to the right origin and path with bearer, topic and a 24-hour expiry from the clock", async () => {
  const { apns, calls, key } = await client(res(200));
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: true, status: 200, reason: null });
  const call = calls[0]!;
  expect(call.origin).toBe("https://api.sandbox.push.apple.com");
  expect(call.path).toBe(`/3/device/${send.deviceToken}`);
  expect(call.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  expect(call.headers["apns-topic"]).toBe("com.x.app");
  expect(call.headers["apns-expiration"]).toBe(String(2_000_000_000 + 86_400));
  expect(JSON.parse(call.body)).toEqual({ aps: {} });
});

test("an expired provider token is signed anew and the send retried once", async () => {
  const { apns, calls, key } = await client(res(403, '{"reason":"ExpiredProviderToken"}'), res(200));
  expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
  expect(calls).toHaveLength(2);
});

test("a second 403 isn't retried again; the reason comes from Apple's body", async () => {
  const { apns, calls, key } = await client(res(403, '{"reason":"InvalidProviderToken"}'), res(403, '{"reason":"InvalidProviderToken"}'));
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: false, status: 403, reason: "InvalidProviderToken" });
  expect(calls).toHaveLength(2);
});

test("failures keep their reason: non-JSON body, empty body, transport error, unreadable key", async () => {
  const a = await client(res(500, " upstream down "));
  expect(await a.apns.send(a.key, "T", send)).toEqual({ ok: false, status: 500, reason: "upstream down" });
  const b = await client(res(502, ""));
  expect((await b.apns.send(b.key, "T", send)).reason).toBeNull();
  const c = await client(new Error("socket hang up"));
  expect(await c.apns.send(c.key, "T", send)).toEqual({ ok: false, status: 0, reason: "socket hang up" });
  const bad = new ApnsClient({ transport: transport().t, tokens: new ApnsTokens(() => "not a key") });
  const r = await bad.send({ environment: "sandbox", keyId: "K", path: "/bad.p8" }, "T", send);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("Couldn't sign with /bad.p8");
});

test("isDeadToken is true for 410, BadDeviceToken and Unregistered only", () => {
  expect(isDeadToken({ ok: false, status: 410, reason: null })).toBe(true);
  expect(isDeadToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(isDeadToken({ ok: false, status: 400, reason: "Unregistered" })).toBe(true);
  expect(isDeadToken({ ok: false, status: 429, reason: "TooManyRequests" })).toBe(false);
  expect(isDeadToken({ ok: false, status: 0, reason: "socket hang up" })).toBe(false);
});
