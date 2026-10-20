import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { constants, createServer, type Http2Session } from "node:http2";
import { join } from "node:path";
import { ApnsClient, ApnsTokens, Http2Transport, apnsJwt, findApnsKeys, isDeadToken, type ApnsHttpResponse, type ApnsKeyFile, type ApnsTransport } from "../../../service/src/notifications/apns";
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

test("another team gets its own token", async () => {
  const { pem } = await makeKey();
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), fakeClock());
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  await tokens.get(key, "TEAM123456");
  await tokens.get(key, "OTHERTEAM1");
  expect(reads).toBe(2);
});

test("concurrent sends on a cold cache share one signing", async () => {
  const { pem } = await makeKey();
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), fakeClock());
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const all = await Promise.all(Array.from({ length: 6 }, () => tokens.get(key, "TEAM123456")));
  expect(reads).toBe(1);
  expect(new Set(all).size).toBe(1);
});

test("a failed signing isn't remembered: the next send signs again", async () => {
  const { pem } = await makeKey();
  let reads = 0;
  const tokens = new ApnsTokens(() => {
    if (reads++ === 0) throw new Error("no such file");
    return pem;
  }, fakeClock());
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  await expect(tokens.get(key, "TEAM123456")).rejects.toThrow("no such file");
  expect(await tokens.get(key, "TEAM123456")).toContain(".");
});

test("a token persisted by one process is reused by the next, 0600, until 40 minutes old", async () => {
  const { pem } = await makeKey();
  const file = join(tempDir(), "apns-tokens.json");
  const clock = fakeClock(5_000_000);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  let reads = 0;
  const first = await new ApnsTokens(() => (reads++, pem), clock, { file }).get(key, "TEAM123456");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  clock.advance(39 * 60_000);
  const restarted = new ApnsTokens(() => (reads++, pem), clock, { file });
  expect(await restarted.get(key, "TEAM123456")).toBe(first);
  expect(reads).toBe(1);
  clock.advance(2 * 60_000);
  expect(await new ApnsTokens(() => (reads++, pem), clock, { file }).get(key, "TEAM123456")).not.toBe(first);
  expect(reads).toBe(2);
});

test("a persisted token dated in the future is signed afresh", async () => {
  const { pem } = await makeKey();
  const file = join(tempDir(), "apns-tokens.json");
  const clock = fakeClock(5_000_000);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const first = await new ApnsTokens(() => pem, clock, { file }).get(key, "TEAM123456");
  // The clock moves back an hour: the stored token's age would be negative.
  const back = fakeClock(5_000_000 - 60 * 60_000);
  let reads = 0;
  const next = await new ApnsTokens(() => (reads++, pem), back, { file }).get(key, "TEAM123456");
  expect(reads).toBe(1);
  expect(next).not.toBe(first);
});

test("a refused renewal is logged", async () => {
  const { apns, key, log } = await client(res(403, '{"reason":"InvalidProviderToken"}'));
  await apns.send(key, "TEAM123456", send);
  expect(log.some((l) => l.includes("not signing a new token"))).toBe(true);
});

test("a corrupt token file means a fresh signing", async () => {
  const { pem } = await makeKey();
  const file = join(tempDir(), "apns-tokens.json");
  writeFileSync(file, "{not json");
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  let reads = 0;
  await new ApnsTokens(() => (reads++, pem), fakeClock(), { file }).get(key, "TEAM123456");
  expect(reads).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy();
});

test("signing is logged with the environment and key id, never the token", async () => {
  const { pem } = await makeKey();
  const lines: string[] = [];
  const key: ApnsKeyFile = { environment: "production", keyId: "KEYID12345", path: "/k.p8" };
  const jwt = await new ApnsTokens(() => pem, fakeClock(), { log: (m) => lines.push(m) }).get(key, "TEAM123456");
  expect(lines).toEqual(["notifications: signed a new APNs token for the production key KEYID12345"]);
  expect(lines.join()).not.toContain(jwt);
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
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const sleeps: number[] = [];
  const log: string[] = [];
  const apns = new ApnsClient({ transport: t, tokens, now: clock, sleep: async (ms) => void sleeps.push(ms), log: (m) => log.push(m) });
  return { apns, calls, key, clock, sleeps, log, reads: () => reads };
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

const auth = (c: { headers: Record<string, string> }) => c.headers.authorization;

test("a 403 on a token under 20 minutes old isn't answered with a new signing", async () => {
  const { apns, calls, key, reads } = await client(res(403, '{"reason":"ExpiredProviderToken"}'));
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: false, status: 403, reason: "ExpiredProviderToken" });
  expect(calls).toHaveLength(1);
  expect(reads()).toBe(1);
});

test("a token Apple refuses after 20 minutes is replaced once, and the send succeeds with the new one", async () => {
  const { pem } = await makeKey();
  const clock = fakeClock(2_000_000_000_000);
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const old = await tokens.get(key, "TEAM123456");
  clock.advance(25 * 60_000);
  const { t, calls } = transport(res(403, '{"reason":"ExpiredProviderToken"}'), res(200));
  const apns = new ApnsClient({ transport: t, tokens, now: clock, sleep: async () => {} });
  expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
  expect(reads).toBe(2);
  expect(auth(calls[0]!)).toBe(`bearer ${old}`);
  expect(auth(calls[1]!)).not.toBe(auth(calls[0]!));
});

test("a second 403 isn't retried again; the reason comes from Apple's body", async () => {
  const { pem } = await makeKey();
  const clock = fakeClock(2_000_000_000_000);
  const tokens = new ApnsTokens(() => pem, clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  await tokens.get(key, "TEAM123456");
  clock.advance(25 * 60_000);
  const { t, calls } = transport(res(403, '{"reason":"InvalidProviderToken"}'), res(403, '{"reason":"InvalidProviderToken"}'));
  const apns = new ApnsClient({ transport: t, tokens, now: clock, sleep: async () => {} });
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: false, status: 403, reason: "InvalidProviderToken" });
  expect(calls).toHaveLength(2);
});

test("concurrent 403s on one expired token sign once between them", async () => {
  const { pem } = await makeKey();
  const clock = fakeClock(2_000_000_000_000);
  let reads = 0;
  const tokens = new ApnsTokens(() => (reads++, pem), clock);
  const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
  const old = await tokens.get(key, "TEAM123456");
  clock.advance(25 * 60_000);
  const calls: string[] = [];
  const t: ApnsTransport = {
    async post(_o, _p, headers) {
      calls.push(headers.authorization!);
      return headers.authorization === `bearer ${old}` ? res(403, '{"reason":"ExpiredProviderToken"}') : res(200);
    },
    close() {},
  };
  const apns = new ApnsClient({ transport: t, tokens, now: clock, sleep: async () => {} });
  const results = await Promise.all([1, 2, 3].map(() => apns.send(key, "TEAM123456", send)));
  expect(results.every((r) => r.ok)).toBe(true);
  expect(reads).toBe(2);
});

test("a 429 TooManyProviderTokenUpdates retries once after a wait with the same token and never signs", async () => {
  const { apns, calls, key, sleeps, reads, log } = await client(res(429, '{"reason":"TooManyProviderTokenUpdates"}'), res(200));
  expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
  expect(calls).toHaveLength(2);
  expect(auth(calls[1]!)).toBe(auth(calls[0]!));
  expect(reads()).toBe(1);
  expect(sleeps).toEqual([2000]);
  expect(log).toEqual(["notifications: apns sandbox: retrying in 2000ms (TooManyProviderTokenUpdates)", "notifications: apns sandbox: retry succeeded after 1"]);
});

test("a second 429 gives up and reports it", async () => {
  const { apns, calls, key, log } = await client(res(429, '{"reason":"TooManyProviderTokenUpdates"}'), res(429, '{"reason":"TooManyProviderTokenUpdates"}'));
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: false, status: 429, reason: "TooManyProviderTokenUpdates" });
  expect(calls).toHaveLength(2);
  expect(log.at(-1)).toBe("notifications: apns sandbox: gave up after 1 retry: 429 TooManyProviderTokenUpdates");
});

test("another 429 reason isn't retried", async () => {
  const { apns, calls, key } = await client(res(429, '{"reason":"TooManyRequests"}'));
  expect((await apns.send(key, "TEAM123456", send)).status).toBe(429);
  expect(calls).toHaveLength(1);
});

test("a dropped connection is retried with backoff, then succeeds", async () => {
  const { apns, calls, key, sleeps, log } = await client(new Error("NGHTTP2_REFUSED_STREAM"), new Error("NGHTTP2_PROTOCOL_ERROR"), res(200));
  expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([250, 1000]);
  expect(log.at(-1)).toBe("notifications: apns sandbox: retry succeeded after 2");
});

test("a send that keeps failing stops after two retries and reports the last error", async () => {
  const { apns, calls, key, log } = await client(new Error("a"), new Error("b"), new Error("socket hang up"));
  expect(await apns.send(key, "TEAM123456", send)).toEqual({ ok: false, status: 0, reason: "socket hang up" });
  expect(calls).toHaveLength(3);
  expect(log.at(-1)).toBe("notifications: apns sandbox: gave up after 2 retries: 0 socket hang up");
});

test("500 and 503 get the same bounded retry", async () => {
  const a = await client(res(503, '{"reason":"ServiceUnavailable"}'), res(200));
  expect((await a.apns.send(a.key, "T", send)).ok).toBe(true);
  const b = await client(res(500, "x"), res(500, "x"), res(500, "x"), res(200));
  expect((await b.apns.send(b.key, "T", send)).status).toBe(500);
  expect(b.calls).toHaveLength(3);
});

test("400, 410 and BadDeviceToken aren't retried", async () => {
  for (const [status, reason] of [[400, "BadDeviceToken"], [410, "Unregistered"], [400, "PayloadTooLarge"]] as const) {
    const { apns, calls, key, sleeps } = await client(res(status, JSON.stringify({ reason })), res(200));
    expect(await apns.send(key, "T", send)).toEqual({ ok: false, status, reason });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  }
});

test("failures keep their reason: non-JSON body, empty body, transport error, unreadable key", async () => {
  const a = await client(res(502, " upstream down "));
  expect(await a.apns.send(a.key, "T", send)).toEqual({ ok: false, status: 502, reason: "upstream down" });
  const b = await client(res(502, ""));
  expect((await b.apns.send(b.key, "T", send)).reason).toBeNull();
  const bad = new ApnsClient({ transport: transport().t, tokens: new ApnsTokens(() => "not a key") });
  const r = await bad.send({ environment: "sandbox", keyId: "K", path: "/bad.p8" }, "T", send);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("Couldn't sign with /bad.p8");
});

/** The real HTTP/2 transport against a local server that refuses or drops what a script says. */
test("Http2Transport opens a new connection after the server refuses a stream or sends GOAWAY", async () => {
  const sessions: Http2Session[] = [];
  const acts: ("refuse" | "goaway" | "ok")[] = ["refuse", "goaway", "ok"];
  const server = createServer();
  server.on("session", (s) => sessions.push(s));
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.session?.on("error", () => {});
    const act = acts.shift() ?? "ok";
    if (act === "refuse") stream.close(constants.NGHTTP2_REFUSED_STREAM);
    else if (act === "goaway") {
      stream.session?.goaway();
      stream.session?.destroy();
    } else {
      stream.respond({ ":status": 200 });
      stream.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new Http2Transport();
  try {
    const { pem } = await makeKey();
    const apns = new ApnsClient({
      transport,
      tokens: new ApnsTokens(() => pem, fakeClock()),
      origins: { sandbox: origin, production: origin },
      sleep: async () => {},
    });
    const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
    expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  } finally {
    transport.close();
    for (const s of sessions) s.destroy();
    server.close();
  }
});

test("Http2Transport retries a reset stream on a new connection even though the session never errored", async () => {
  const sessions: Http2Session[] = [];
  const acts: ("reset" | "ok")[] = ["reset", "ok"];
  const server = createServer();
  server.on("session", (s) => sessions.push(s));
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    if (acts.shift() === "reset") stream.close(constants.NGHTTP2_CANCEL);
    else {
      stream.respond({ ":status": 200 });
      stream.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new Http2Transport();
  try {
    const { pem } = await makeKey();
    const apns = new ApnsClient({ transport, tokens: new ApnsTokens(() => pem, fakeClock()), origins: { sandbox: origin, production: origin }, sleep: async () => {} });
    const key: ApnsKeyFile = { environment: "sandbox", keyId: "KEYID12345", path: "/k.p8" };
    expect((await apns.send(key, "TEAM123456", send)).ok).toBe(true);
    expect(sessions).toHaveLength(2);
  } finally {
    transport.close();
    for (const s of sessions) s.destroy();
    server.close();
  }
});

test("isDeadToken is true for 410, BadDeviceToken and Unregistered only", () => {
  expect(isDeadToken({ ok: false, status: 410, reason: null })).toBe(true);
  expect(isDeadToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(isDeadToken({ ok: false, status: 400, reason: "Unregistered" })).toBe(true);
  expect(isDeadToken({ ok: false, status: 429, reason: "TooManyRequests" })).toBe(false);
  expect(isDeadToken({ ok: false, status: 0, reason: "socket hang up" })).toBe(false);
});
