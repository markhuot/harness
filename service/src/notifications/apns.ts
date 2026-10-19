// Apple Push Notification service client (DESIGN.md "Notifications"): token-based auth (an ES256
// JWT signed with the team's APNs key, one key per environment) over HTTP/2.

import { connect, constants, type ClientHttp2Session } from "node:http2";
import { chmodSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApnsEnvironment } from "@harness/shared";

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Where the keys are when Settings doesn't say: beside the App Store Connect API keys. */
export const DEFAULT_APNS_KEY_DIR = join(homedir(), ".appstoreconnect", "private_keys");

/** `AuthKey_<keyId>_APN_Sandbox.p8` / `AuthKey_<keyId>_APN_Production.p8` */
const KEY_FILE = /^AuthKey_([A-Z0-9]{10})_APN_(Sandbox|Production)\.p8$/i;

export interface ApnsKeyFile {
  environment: ApnsEnvironment;
  keyId: string;
  path: string;
}

/** The APNs key for each environment found in `dir` (the first by name when there are several). */
export function findApnsKeys(dir: string): Record<ApnsEnvironment, ApnsKeyFile | null> {
  const out: Record<ApnsEnvironment, ApnsKeyFile | null> = { sandbox: null, production: null };
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const m = KEY_FILE.exec(name);
    if (!m) continue;
    const environment: ApnsEnvironment = m[2]!.toLowerCase() === "sandbox" ? "sandbox" : "production";
    out[environment] ??= { environment, keyId: m[1]!.toUpperCase(), path: join(dir, name) };
  }
  return out;
}

const b64url = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

/** An APNs provider token: ES256 JWT with the key id in the header and the team as issuer. */
export async function apnsJwt(keyId: string, teamId: string, pem: string, now = Date.now()): Promise<string> {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const body = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  // WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * Apple refuses tokens older than an hour and throttles ones refreshed more often than every 20
 * minutes, so each is reused for 40.
 */
export const JWT_TTL_MS = 40 * 60_000;

/** A key's token is never replaced sooner than this, even after Apple rejects it. */
export const JWT_MIN_REFRESH_MS = 20 * 60_000;

interface SignedToken {
  jwt: string;
  at: number;
}

/**
 * One provider token per key. Concurrent sends share a single in-flight signing (several tokens for
 * one key within moments is what Apple answers with 429 TooManyProviderTokenUpdates), and with a
 * `file` the tokens survive a restart.
 */
export class ApnsTokens {
  private cache = new Map<string, SignedToken>();
  private signing = new Map<string, Promise<SignedToken>>();
  private loaded = false;
  constructor(
    private readKey: (path: string) => string = (p) => readFileSync(p, "utf8"),
    private now: () => number = Date.now,
    private opts: { file?: string; log?: (msg: string) => void } = {},
  ) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.opts.file) return;
    try {
      const stored = JSON.parse(readFileSync(this.opts.file, "utf8")) as Record<string, Partial<SignedToken>>;
      for (const [id, v] of Object.entries(stored)) {
        if (typeof v?.jwt === "string" && typeof v.at === "number") this.cache.set(id, { jwt: v.jwt, at: v.at });
      }
    } catch {
      // Missing, unreadable or corrupt: sign afresh.
    }
  }

  private save() {
    const file = this.opts.file;
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache)), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      this.opts.log?.(`notifications: couldn't save the APNs tokens: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sign(id: string, key: ApnsKeyFile, teamId: string): Promise<SignedToken> {
    const inflight = this.signing.get(id);
    if (inflight) return inflight;
    const t = this.now();
    const p = (async () => {
      const jwt = await apnsJwt(key.keyId, teamId, this.readKey(key.path), t);
      const token = { jwt, at: t };
      this.cache.set(id, token);
      this.save();
      this.opts.log?.(`notifications: signed a new APNs token for the ${key.environment} key ${key.keyId}`);
      return token;
    })();
    // A failed signing isn't remembered: the next send tries again.
    const done = () => this.signing.delete(id);
    p.then(done, done);
    this.signing.set(id, p);
    return p;
  }

  async get(key: ApnsKeyFile, teamId: string): Promise<string> {
    this.load();
    const id = `${teamId}:${key.keyId}:${key.path}`;
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < JWT_TTL_MS) return hit.jwt;
    return (await this.sign(id, key, teamId)).jwt;
  }

  /**
   * A new token to replace `rejected`, which Apple refused (403 ExpiredProviderToken /
   * InvalidProviderToken). Null when signing again can't help: the current token is younger than
   * the refresh floor, so a wrong key or team is likelier than an expired token. When another send
   * already replaced it, that token is returned.
   */
  async renew(key: ApnsKeyFile, teamId: string, rejected: string): Promise<string | null> {
    this.load();
    const id = `${teamId}:${key.keyId}:${key.path}`;
    const hit = this.cache.get(id);
    if (hit && hit.jwt !== rejected) return hit.jwt;
    if (hit && this.now() - hit.at < JWT_MIN_REFRESH_MS) return null;
    return (await this.sign(id, key, teamId)).jwt;
  }
}

export interface ApnsHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Sends one HTTP/2 POST; swapped for a fake in tests. */
export interface ApnsTransport {
  post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsHttpResponse>;
  close(): void;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** One HTTP/2 connection per origin, reopened when Apple closes it (GOAWAY, idle, errors). */
export class Http2Transport implements ApnsTransport {
  private sessions = new Map<string, ClientHttp2Session>();

  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origin);
    const drop = () => {
      if (this.sessions.get(origin) === s) this.sessions.delete(origin);
    };
    // Close what Apple has given up on rather than leaving it half open, so the next request opens a new connection.
    s.on("error", () => {
      drop();
      s.destroy();
    });
    s.on("goaway", () => {
      drop();
      s.close();
    });
    s.on("close", drop);
    // An idle connection mustn't keep the service's event loop alive.
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  private drop(origin: string) {
    const s = this.sessions.get(origin);
    if (!s) return;
    this.sessions.delete(origin);
    s.close();
  }

  post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsHttpResponse> {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = this.session(origin).request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: path,
          "content-type": "application/json",
          ...headers,
        });
      } catch (err) {
        return reject(err);
      }
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(constants.NGHTTP2_CANCEL);
        // No answer: the connection is suspect, so the retry gets a new one.
        this.drop(origin);
      });
      let status = 0;
      let responseHeaders: ApnsHttpResponse["headers"] = {};
      const chunks: Buffer[] = [];
      req.on("response", (h) => {
        status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0;
        responseHeaders = h as ApnsHttpResponse["headers"];
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      const unanswered = () => reject(new Error(`No answer from ${origin}`));
      req.on("end", () => (status ? resolve({ status, body: Buffer.concat(chunks).toString("utf8"), headers: responseHeaders }) : unanswered()));
      req.on("close", () => {
        if (!status) unanswered();
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  close() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

export interface ApnsSend {
  environment: ApnsEnvironment;
  deviceToken: string;
  topic: string;
  payload: unknown;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** Apple's reason (BadDeviceToken, Unregistered, …), or a local error message; null on success */
  reason: string | null;
}

/** How long Apple keeps a notification for a device that's off or out of reach. */
const EXPIRATION_S = 24 * 60 * 60;

/** Waits before each retry of a send that failed at the connection (or with a 500/503). */
const TRANSIENT_BACKOFF_MS = [250, 1_000];

/** Apple's throttle on provider tokens clears fast; one retry after this wait, with the same token. */
const THROTTLE_WAIT_MS = 2_000;

export class ApnsClient {
  private tokens: ApnsTokens;

  constructor(
    private opts: {
      transport: ApnsTransport;
      tokens?: ApnsTokens;
      origins?: Record<ApnsEnvironment, string>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      log?: (msg: string) => void;
    },
  ) {
    this.tokens = opts.tokens ?? new ApnsTokens();
  }

  async send(key: ApnsKeyFile, teamId: string, n: ApnsSend): Promise<ApnsResult> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const label = `notifications: apns ${n.environment}`;
    let jwt: string;
    try {
      jwt = await this.tokens.get(key, teamId);
    } catch (err) {
      return { ok: false, status: 0, reason: `Couldn't sign with ${key.path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const origin = (this.opts.origins ?? APNS_ORIGINS)[n.environment];
    let renewed = false;
    let throttled = false;
    let transient = 0;
    let retries = 0;
    const retry = async (why: string, wait: number) => {
      retries++;
      this.opts.log?.(`${label}: retrying in ${wait}ms (${why})`);
      await sleep(wait);
    };
    const finish = (r: ApnsResult): ApnsResult => {
      if (retries > 0) this.opts.log?.(r.ok ? `${label}: retry succeeded after ${retries}` : `${label}: gave up after ${retries} ${retries === 1 ? "retry" : "retries"}: ${r.status} ${r.reason ?? ""}`.trim());
      return r;
    };
    for (;;) {
      const now = this.opts.now?.() ?? Date.now();
      const headers: Record<string, string> = {
        authorization: `bearer ${jwt}`,
        "apns-topic": n.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(now / 1000) + EXPIRATION_S),
      };
      let res: ApnsHttpResponse;
      try {
        res = await this.opts.transport.post(origin, `/3/device/${n.deviceToken}`, headers, JSON.stringify(n.payload));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // A reset, refused or unanswered stream: the transport opens a new connection for the retry.
        if (transient < TRANSIENT_BACKOFF_MS.length) {
          await retry(reason, TRANSIENT_BACKOFF_MS[transient++]!);
          continue;
        }
        return finish({ ok: false, status: 0, reason });
      }
      if (res.status === 200) return finish({ ok: true, status: 200, reason: null });
      let reason: string | null = null;
      try {
        reason = (JSON.parse(res.body) as { reason?: string }).reason ?? null;
      } catch {}
      const failure: ApnsResult = { ok: false, status: res.status, reason: reason ?? (res.body.trim() || null) };
      if (res.status === 429 && reason === "TooManyProviderTokenUpdates" && !throttled) {
        // Never mint another token for this: that is what Apple is throttling.
        throttled = true;
        await retry(reason, THROTTLE_WAIT_MS);
        continue;
      }
      // A token Apple stopped accepting (it expired, or the key was revoked and replaced): sign anew once.
      if (res.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") && !renewed) {
        renewed = true;
        let next: string | null = null;
        try {
          next = await this.tokens.renew(key, teamId, jwt);
        } catch {}
        if (next) {
          jwt = next;
          await retry(reason, 0);
          continue;
        }
      }
      if ((res.status === 500 || res.status === 503) && transient < TRANSIENT_BACKOFF_MS.length) {
        await retry(`${res.status} ${reason ?? ""}`.trim(), TRANSIENT_BACKOFF_MS[transient++]!);
        continue;
      }
      return finish(failure);
    }
  }

  close() {
    this.opts.transport.close();
  }
}

/** The device token is gone for good: delete the device. */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";
}
