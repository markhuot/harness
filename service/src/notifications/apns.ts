// Apple Push Notification service client (DESIGN.md "Notifications"): token-based auth (an ES256
// JWT signed with the team's APNs key, one key per environment) over HTTP/2.

import { connect, constants, type ClientHttp2Session } from "node:http2";
import { readdirSync, readFileSync } from "node:fs";
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

export class ApnsTokens {
  private cache = new Map<string, { jwt: string; at: number }>();
  constructor(
    private readKey: (path: string) => string = (p) => readFileSync(p, "utf8"),
    private now: () => number = Date.now,
  ) {}

  async get(key: ApnsKeyFile, teamId: string): Promise<string> {
    const id = `${teamId}:${key.keyId}:${key.path}`;
    const hit = this.cache.get(id);
    const t = this.now();
    if (hit && t - hit.at < JWT_TTL_MS) return hit.jwt;
    const jwt = await apnsJwt(key.keyId, teamId, this.readKey(key.path), t);
    this.cache.set(id, { jwt, at: t });
    return jwt;
  }

  /** Drop a token Apple refused (403 ExpiredProviderToken / InvalidProviderToken) so the next send signs a new one. */
  forget(key: ApnsKeyFile, teamId: string) {
    this.cache.delete(`${teamId}:${key.keyId}:${key.path}`);
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
    s.on("error", drop);
    s.on("goaway", drop);
    s.on("close", drop);
    // An idle connection mustn't keep the service's event loop alive.
    s.unref();
    this.sessions.set(origin, s);
    return s;
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
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(constants.NGHTTP2_CANCEL));
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

export class ApnsClient {
  private tokens: ApnsTokens;

  constructor(
    private opts: {
      transport: ApnsTransport;
      tokens?: ApnsTokens;
      origins?: Record<ApnsEnvironment, string>;
      now?: () => number;
    },
  ) {
    this.tokens = opts.tokens ?? new ApnsTokens();
  }

  async send(key: ApnsKeyFile, teamId: string, n: ApnsSend, retried = false): Promise<ApnsResult> {
    let jwt: string;
    try {
      jwt = await this.tokens.get(key, teamId);
    } catch (err) {
      return { ok: false, status: 0, reason: `Couldn't sign with ${key.path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const now = this.opts.now?.() ?? Date.now();
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": n.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(now / 1000) + EXPIRATION_S),
    };
    const origin = (this.opts.origins ?? APNS_ORIGINS)[n.environment];
    let res: ApnsHttpResponse;
    try {
      res = await this.opts.transport.post(origin, `/3/device/${n.deviceToken}`, headers, JSON.stringify(n.payload));
    } catch (err) {
      return { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 200) return { ok: true, status: 200, reason: null };
    let reason: string | null = null;
    try {
      reason = (JSON.parse(res.body) as { reason?: string }).reason ?? null;
    } catch {}
    // A token Apple stopped accepting (it expired, or the key was revoked and replaced): sign anew once.
    if (res.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") && !retried) {
      this.tokens.forget(key, teamId);
      return this.send(key, teamId, n, true);
    }
    return { ok: false, status: res.status, reason: reason ?? (res.body.trim() || null) };
  }

  close() {
    this.opts.transport.close();
  }
}

/** The device token is gone for good: delete the device. */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";
}
