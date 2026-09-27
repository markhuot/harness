// The pairing link a phone scans: harness://pair?url=<encodeURIComponent(baseUrl)>&token=<encodeURIComponent(token)>

export const PAIR_SCHEME = "harness://pair";

/** Build the pairing link. Both values are percent-encoded with encodeURIComponent. */
export function buildPairUrl(baseUrl: string, token: string): string {
  return `${PAIR_SCHEME}?url=${encodeURIComponent(baseUrl)}&token=${encodeURIComponent(token)}`;
}

/** Parse a pairing link; null when it isn't one or a value is missing / not http(s). */
export function parsePairUrl(link: string): { url: string; token: string } | null {
  const trimmed = link.trim();
  if (!trimmed.startsWith(`${PAIR_SCHEME}?`)) return null;
  const params: Record<string, string> = {};
  for (const part of trimmed.slice(PAIR_SCHEME.length + 1).split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    try {
      params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
  }
  const { url, token } = params;
  if (!url || !token || !/^https?:\/\/[^/]+/i.test(url)) return null;
  return { url, token };
}
