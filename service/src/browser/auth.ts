// HTTP Basic Auth helpers for the integrated browser (DESIGN.md "Browser"). Credentials live in
// memory only, per session and origin + realm; nothing here logs, persists or broadcasts them.

export interface BasicCredentials {
  username: string;
  password: string;
}

/** What a credential applies to: the server's origin and the realm it named. */
export const authKey = (origin: string, realm: string) => `${origin}\n${realm}`;

/** The realm of a `WWW-Authenticate` header's Basic challenge; null when none of its challenges is Basic. */
export function basicRealm(header: string | undefined): string | null {
  if (!header) return null;
  // Headers with several challenges are joined with newlines (CDP) or commas; find the Basic one.
  const m = /(?:^|[\n,]\s*)basic\b([^\n]*)/i.exec(header);
  if (!m) return null;
  const realm = /realm\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/i.exec(m[1]!);
  return realm ? (realm[1] ?? realm[2] ?? "").replace(/\\(.)/g, "$1") : "";
}

/** A response header from CDP's headers object, which keeps the server's own capitalisation. */
export function headerOf(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name && typeof v === "string") return v;
  return undefined;
}

/** The URL without `user:password@`, for anywhere a URL is stored, listed or broadcast. */
export function stripUserinfo(url: string): string {
  if (!url.includes("@")) return url;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return url;
  }
}

/** The origin of a request URL, or null for one without (about:blank, data:). */
export function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
