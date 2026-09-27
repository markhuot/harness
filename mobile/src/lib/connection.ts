// Reachability + token check before a server is saved, and plain-language errors for the
// failures people actually hit (Mac asleep / service only on localhost / stale token).

import { HarnessApiError } from "@harness/shared";
import { displayHost } from "./pair";

export type ProbeFailure = { ok: false; kind: "unreachable" | "timeout" | "unauthorized" | "not-harness" | "error"; message: string };
export type ProbeResult = { ok: true; version: string } | ProbeFailure;

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function unreachableMessage(baseUrl: string): string {
  return `Couldn't reach ${displayHost(baseUrl)}. Check that the Mac is awake and on the same network or tailnet, and that Harness → Settings → Network lets the service listen beyond localhost.`;
}

export const UNAUTHORIZED_MESSAGE = "The service rejected the token (401). Show the pairing QR code on the Mac again and rescan it.";

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /health (no auth) then an authenticated GET /settings. */
export async function probeServer(baseUrl: string, token: string, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const doFetch: Fetch = opts.fetch ?? (fetch as unknown as Fetch);
  const timeoutMs = opts.timeoutMs ?? 6000;
  const base = baseUrl.replace(/\/$/, "");
  let version = "";
  try {
    const res = await withTimeout(timeoutMs, (signal) => doFetch(`${base}/health`, { signal }));
    const body = await res.text();
    let json: { data?: { ok?: boolean; version?: string } } = {};
    try {
      json = JSON.parse(body);
    } catch {}
    if (!res.ok || json.data?.ok !== true) {
      return { ok: false, kind: "not-harness", message: `${displayHost(baseUrl)} answered, but it isn't a Harness service (HTTP ${res.status}).` };
    }
    version = json.data.version ?? "";
  } catch (e) {
    return (e as Error)?.name === "AbortError"
      ? { ok: false, kind: "timeout", message: `${displayHost(baseUrl)} didn't answer within ${Math.round(timeoutMs / 1000)}s. ${unreachableMessage(baseUrl).split(". ").slice(1).join(". ")}` }
      : { ok: false, kind: "unreachable", message: unreachableMessage(baseUrl) };
  }
  try {
    const res = await withTimeout(timeoutMs, (signal) => doFetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` }, signal }));
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized", message: UNAUTHORIZED_MESSAGE };
    if (!res.ok) return { ok: false, kind: "error", message: `The service answered HTTP ${res.status}.` };
  } catch (e) {
    return (e as Error)?.name === "AbortError" ? { ok: false, kind: "timeout", message: `${displayHost(baseUrl)} stopped answering.` } : { ok: false, kind: "unreachable", message: unreachableMessage(baseUrl) };
  }
  return { ok: true, version };
}

/** A toast-friendly message for a failed request. */
export function describeError(e: unknown, baseUrl?: string): string {
  if (e instanceof HarnessApiError) return e.status === 401 ? UNAUTHORIZED_MESSAGE : e.message || `HTTP ${e.status}`;
  const msg = (e as Error)?.message ?? String(e);
  if (/network request failed|failed to fetch|could not connect|load failed/i.test(msg)) return baseUrl ? unreachableMessage(baseUrl) : "Couldn't reach the service.";
  return msg;
}

export const isUnauthorized = (e: unknown) => e instanceof HarnessApiError && e.status === 401;
