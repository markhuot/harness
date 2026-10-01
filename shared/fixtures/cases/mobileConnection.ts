// Connection probe and error messages (mobile/src/lib/connection.ts) for HarnessKit's Connection.swift.
// probeServer runs against a scripted fake fetch: each input says how /health answers (a status and
// body, or a throw) and, when the probe gets that far, how /settings answers. The output is what the
// real probeServer returned plus every request it made, so the Swift test can check both.
import { HarnessApiError } from "@harness/shared";
import { describeError, isUnauthorized, probeServer, UNAUTHORIZED_MESSAGE, unreachableMessage } from "../../../mobile/src/lib/connection";
import { asyncCases, cases } from "../case";

/** network: fetch rejects (TypeError "Network request failed"); abort: the timeout fired (AbortError); other: any other error. */
type Throw = { throw: "network" | "abort" | "other" };
type Reply = { status: number; body?: string } | Throw;

interface ProbeInput {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  health: Reply;
  settings?: Reply;
}

interface Call {
  url: string;
  authorization: string | null;
}

function fakeFetch(input: ProbeInput) {
  const calls: Call[] = [];
  const replies = [input.health, input.settings];
  const f = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, authorization: init?.headers?.authorization ?? null });
    const r = replies[calls.length - 1];
    if (!r) throw new Error(`unscripted request ${calls.length}: ${url}`);
    if ("throw" in r) {
      if (r.throw === "network") throw new TypeError("Network request failed");
      if (r.throw === "abort") throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      throw new Error("something else");
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "" };
  };
  return { f, calls };
}

const health = (data: unknown, status = 200): Reply => ({ status, body: JSON.stringify({ data }) });
const healthy = health({ ok: true, version: "0.1.0", pid: 1 });
const settingsOk: Reply = { status: 200, body: '{"data":{}}' };

export const probeServerCases = asyncCases(
  async (input: ProbeInput) => {
    const { f, calls } = fakeFetch(input);
    const result = await probeServer(input.baseUrl, input.token, { fetch: f, timeoutMs: input.timeoutMs });
    return { result, calls };
  },
  {
    "healthy service and good token": { baseUrl: "http://100.64.0.2:7717/", token: "tok", health: healthy, settings: settingsOk },
    "no trailing slash": { baseUrl: "http://h:7717", token: "t", health: healthy, settings: settingsOk },
    "only one trailing slash is dropped": { baseUrl: "http://h//", token: "t", health: healthy, settings: settingsOk },
    "base with a path": { baseUrl: "https://mac.local/harness/", token: "t", health: healthy, settings: settingsOk },
    "token with spaces and symbols": { baseUrl: "http://h", token: "a b+c/=", health: healthy, settings: settingsOk },
    "missing version": { baseUrl: "http://h", token: "t", health: health({ ok: true }), settings: settingsOk },
    "null version": { baseUrl: "http://h", token: "t", health: health({ ok: true, version: null }), settings: settingsOk },
    "health 204 is ok status but no body": { baseUrl: "http://h", token: "t", health: { status: 204 }, settings: settingsOk },
    "health 299 with good body": { baseUrl: "http://h", token: "t", health: health({ ok: true, version: "9" }, 299), settings: settingsOk },
    "settings 204": { baseUrl: "http://h", token: "t", health: healthy, settings: { status: 204 } },
    "settings 401": { baseUrl: "http://h:7717", token: "old", health: healthy, settings: { status: 401, body: '{"error":"unauthorized"}' } },
    "settings 403": { baseUrl: "http://h:7717", token: "old", health: healthy, settings: { status: 403 } },
    "settings 404": { baseUrl: "http://h", token: "t", health: healthy, settings: { status: 404 } },
    "settings 500": { baseUrl: "http://h", token: "t", health: healthy, settings: { status: 500, body: "oops" } },
    "settings 302": { baseUrl: "http://h", token: "t", health: healthy, settings: { status: 302 } },
    "settings 199": { baseUrl: "http://h", token: "t", health: healthy, settings: { status: 199 } },
    "settings network failure": { baseUrl: "http://h:1", token: "t", health: healthy, settings: { throw: "network" } },
    "settings timeout": { baseUrl: "http://h:1", token: "t", health: healthy, settings: { throw: "abort" } },
    "settings other error": { baseUrl: "http://h:1", token: "t", health: healthy, settings: { throw: "other" } },
    "health network failure": { baseUrl: "http://100.64.0.2:7717", token: "t", health: { throw: "network" } },
    "health other error": { baseUrl: "http://h", token: "t", health: { throw: "other" } },
    "health timeout, default 6s": { baseUrl: "http://h:1", token: "t", health: { throw: "abort" } },
    "health timeout 2.5s rounds up": { baseUrl: "http://h:1", token: "t", timeoutMs: 2500, health: { throw: "abort" } },
    "health timeout 1.499s rounds down": { baseUrl: "http://h:1", token: "t", timeoutMs: 1499, health: { throw: "abort" } },
    "health timeout 0.4s rounds to 0": { baseUrl: "http://h:1", token: "t", timeoutMs: 400, health: { throw: "abort" } },
    "health timeout https base": { baseUrl: "https://mac.local/harness", token: "t", health: { throw: "abort" } },
    "router login page": { baseUrl: "http://h:80", token: "t", health: { status: 200, body: "<html>router login</html>" } },
    "404 with empty body": { baseUrl: "http://h:80", token: "t", health: { status: 404, body: "" } },
    "data.ok false": { baseUrl: "http://h:80", token: "t", health: health({ ok: false }) },
    "data.ok is the string true": { baseUrl: "http://h", token: "t", health: health({ ok: "true" }) },
    "data.ok is 1": { baseUrl: "http://h", token: "t", health: health({ ok: 1 }) },
    "data is null": { baseUrl: "http://h", token: "t", health: health(null) },
    "data is a string": { baseUrl: "http://h", token: "t", health: health("ok") },
    "ok at the top level": { baseUrl: "http://h", token: "t", health: { status: 200, body: '{"ok":true}' } },
    "healthy body but HTTP 500": { baseUrl: "http://h", token: "t", health: health({ ok: true, version: "1" }, 500) },
    "body is a number": { baseUrl: "http://h", token: "t", health: { status: 200, body: "5" } },
    "body is an array": { baseUrl: "http://h", token: "t", health: { status: 200, body: "[]" } },
    // JSON.parse("null") makes `json` null, and `json.data` then throws inside the try: unreachable.
    "body is null with 200": { baseUrl: "http://h", token: "t", health: { status: 200, body: "null" } },
    "body is null with 500": { baseUrl: "http://h", token: "t", health: { status: 500, body: "null" } },
    "truncated JSON": { baseUrl: "http://h", token: "t", health: { status: 200, body: '{"data":{"ok":true' } },
  } satisfies Record<string, ProbeInput>,
);

type ErrorInput = { kind: "api"; status: number; message: string } | { kind: "error"; message: string };

const makeError = (e: ErrorInput) => (e.kind === "api" ? new HarnessApiError(e.status, e.message) : new Error(e.message));

export const describeErrorCases = cases(({ error, baseUrl }: { error: ErrorInput; baseUrl?: string }) => describeError(makeError(error), baseUrl), {
  "api 401": { error: { kind: "api", status: 401, message: "unauthorized" } },
  "api 401 with no message": { error: { kind: "api", status: 401, message: "" } },
  "api 403 keeps its message": { error: { kind: "api", status: 403, message: "Forbidden here" } },
  "api 409": { error: { kind: "api", status: 409, message: "Key taken" } },
  "api 500 with no message": { error: { kind: "api", status: 500, message: "" } },
  "api message naming a network failure is still the api message": { error: { kind: "api", status: 502, message: "Network request failed" }, baseUrl: "http://h:1" },
  "network request failed with base": { error: { kind: "error", message: "Network request failed" }, baseUrl: "http://h:1" },
  "network request failed without base": { error: { kind: "error", message: "Network request failed" } },
  "network request failed with empty base": { error: { kind: "error", message: "Network request failed" }, baseUrl: "" },
  "failed to fetch": { error: { kind: "error", message: "TypeError: Failed to fetch" }, baseUrl: "https://mac.local/harness" },
  "could not connect": { error: { kind: "error", message: "Could not connect to the server." }, baseUrl: "http://100.64.0.2:7717" },
  "load failed": { error: { kind: "error", message: "Load failed" } },
  "upper case": { error: { kind: "error", message: "NETWORK REQUEST FAILED" } },
  "other message": { error: { kind: "error", message: "boom" } },
  "empty message": { error: { kind: "error", message: "" } },
  "near miss": { error: { kind: "error", message: "network request" } },
});

export const isUnauthorizedCases = cases((e: ErrorInput) => isUnauthorized(makeError(e)), {
  "api 401": { kind: "api", status: 401, message: "x" },
  "api 403": { kind: "api", status: 403, message: "x" },
  "plain error mentioning 401": { kind: "error", message: "401" },
});

export const unreachableMessageCases = cases(unreachableMessage, {
  http: "http://100.64.0.2:7717",
  https: "https://mac.local/harness",
});

export const unauthorizedMessage = UNAUTHORIZED_MESSAGE;
