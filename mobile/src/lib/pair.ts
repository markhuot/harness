// Pairing links and manual server entry. The desktop app shows a QR code of exactly
//   harness://pair?url=<encodeURIComponent(baseUrl)>&token=<encodeURIComponent(token)>
// (buildPairUrl / parsePairUrl in @harness/shared), which the iPhone Camera opens in this app
// through the "harness" URL scheme, or the in-app scanner reads. Pure: no URL polyfill needed,
// so it behaves the same in Hermes and in bun tests.

import { buildPairUrl, PAIR_SCHEME, parsePairUrl } from "@harness/shared";

export interface ServerAddress {
  /** http(s)://host[:port][/path], no trailing slash */
  baseUrl: string;
  token: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Normalize a typed or scanned service URL: trims, adds http:// when no scheme is given (the
 * service speaks plain http on the LAN / tailnet), lower-cases scheme and host, drops a trailing
 * slash, query and fragment. Only http and https are accepted.
 */
export function normalizeBaseUrl(input: string): ParseResult<string> {
  let s = input.trim();
  if (!s) return fail("Enter the service URL, e.g. http://100.64.0.2:7717");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return fail("Only http:// and https:// URLs are supported");
    s = "http://" + s;
  }
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(s);
  if (!m) return fail("That doesn't look like a URL");
  const scheme = m[1]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return fail("Only http:// and https:// URLs are supported");
  const authority = m[2]!;
  if (authority.includes("@")) return fail("The URL can't contain a user name or password");
  const hm = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d*))?$/i.exec(authority);
  if (!hm) return fail("That doesn't look like a host name or IP address");
  const host = hm[1]!.toLowerCase();
  if (!/^\[/.test(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i.test(host)) return fail("That doesn't look like a host name or IP address");
  const port = hm[2];
  if (port !== undefined) {
    if (port === "" || Number(port) < 1 || Number(port) > 65535) return fail("The port must be between 1 and 65535");
  }
  const path = m[3]!.replace(/\/+$/, "");
  return { ok: true, value: `${scheme}://${host}${port ? `:${Number(port)}` : ""}${path}` };
}

/** Manual token entry: trimmed, non-empty. */
export function checkToken(token: string): ParseResult<string> {
  const t = token.trim();
  if (!t) return fail("Enter the token");
  return { ok: true, value: t };
}

/** Why a link isn't a usable pairing link (the shared parser only says null). */
function diagnose(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith(`${PAIR_SCHEME}?`)) return "Not a Harness pairing code";
  const has = (k: string) => new RegExp(`[?&]${k}=[^&]`).test(s);
  if (!has("url")) return "The pairing code has no service URL";
  if (!has("token")) return "The pairing code has no token";
  if (/%(?![0-9a-f]{2})/i.test(s)) return "The pairing code is damaged (bad encoding). Show a fresh QR code on the Mac.";
  return "The pairing code's service URL isn't an http(s) address";
}

/**
 * harness://pair?url=…&token=… → the server address. The format is defined once, by
 * parsePairUrl in @harness/shared (the desktop builds its QR with buildPairUrl); this adds
 * reasons for failures and normalizes the URL the same way manual entry does.
 */
export function parsePairLink(raw: string): ParseResult<ServerAddress> {
  const parsed = parsePairUrl(raw);
  if (!parsed) return fail(diagnose(raw));
  const base = normalizeBaseUrl(parsed.url);
  if (!base.ok) return base;
  return { ok: true, value: { baseUrl: base.value, token: parsed.token } };
}

/** The deep-link route's params (expo-router has already decoded them): re-encoded and parsed like a scanned link. */
export function pairParams(p: { url?: string | string[] | null; token?: string | string[] | null }): ParseResult<ServerAddress> {
  const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const url = one(p.url);
  const token = one(p.token);
  if (!url) return fail("The pairing code has no service URL");
  if (!token) return fail("The pairing code has no token");
  return parsePairLink(buildPairUrl(url, token));
}

/** "http://100.64.0.2:7717" → "100.64.0.2:7717" for compact display. */
export const displayHost = (baseUrl: string) => baseUrl.replace(/^https?:\/\//, "");
