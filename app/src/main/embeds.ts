// Page attachments in the Mac app (DESIGN.md "Embedded pages"). A spec's page embeds as a sandboxed
// iframe at harness-embed://<id>/<path>; main answers that scheme by fetching
// <service>/embeds/<id>/<path> with the bearer token, so the web view never sees the token or the
// service's address. Also the rules that keep an embed inside its frame: what may navigate where,
// which origins get permissions, where popups go. Pure, so the mac tests and
// scripts/check-embeds.ts can hold them to account; main.ts wires them up.

export const EMBED_SCHEME = "harness-embed";

/** An attachment id as the markdown parser accepts it (shared/src/state/markdown.ts ATTACHMENT_SRC), lowercased: the scheme is standard, so its host is. */
const EMBED_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The service URL a harness-embed: request maps to, or null for one that isn't a page's file (a
 * bad id, or a path that would climb out of /embeds/<id>/). The query is kept: a page may use one.
 */
export function embedUpstream(requestUrl: string, baseUrl: string): { id: string; path: string; url: string } | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${EMBED_SCHEME}:` || !EMBED_ID.test(u.hostname)) return null;
  const id = u.hostname;
  const path = u.pathname.replace(/^\/+/, "");
  const prefix = `/embeds/${id}/`;
  let up: URL;
  try {
    up = new URL(`${baseUrl.replace(/\/+$/, "")}${prefix}${path}${u.search}`);
  } catch {
    return null;
  }
  // URL parsing folds `..` and `%2e%2e` segments, so check where the result really points.
  if (!up.pathname.startsWith(prefix) || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path) || /%2f|%5c/i.test(path)) return null;
  return { id, path, url: up.toString() };
}

/** Response headers a page's file is served with: the service's, filtered to what the embed needs. */
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"];

export function embedResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const h of PASS_HEADERS) {
    const v = upstream.get(h);
    if (v !== null) out.set(h, v);
  }
  out.set("x-content-type-options", "nosniff");
  out.set("access-control-allow-origin", "*");
  return out;
}

/**
 * What a page's entry answers when it can't load (not found, the token refused, the service down):
 * a blank page that tells the embed so (`harnessEmbedFailed`), which then shows its placeholder.
 */
export function embedFailurePage(status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><script>parent.postMessage({ harnessEmbedFailed: ${Number(status) || 0} }, "*")</script>`;
  return new Response(body, {
    status: status >= 400 && status < 600 ? status : 502,
    headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" },
  });
}

/** Request headers passed on to the service: the byte range, for media a page plays. */
export function embedRequestHeaders(req: Headers, token: string): Headers {
  const out = new Headers({ authorization: `Bearer ${token}` });
  const range = req.get("range");
  if (range) out.set("range", range);
  return out;
}

/** The app's own pages (the renderer, file://) and its service's plugin frames (127.0.0.1). */
export function isAppOrigin(url: string): boolean {
  return url.startsWith("file://") || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
}

/**
 * Whether a permission request (camera, microphone, geolocation, notifications, clipboard,
 * USB/serial/HID, MIDI…) is granted: only to the app's own pages, as before; never to an embedded
 * page or anything else.
 */
export function permissionAllowed(requestingUrl: string | undefined): boolean {
  return !!requestingUrl && isAppOrigin(requestingUrl);
}

/**
 * Whether a frame may navigate to `url`. The app window stays on its file:// page. An embed stays on
 * its own page's files (a link in it to the web opens in the browser instead); other frames
 * (plugins) keep their own rules.
 */
export function frameNavigation(f: { isMainFrame: boolean; frameUrl: string; url: string }): "allow" | "deny" {
  if (f.isMainFrame) return f.url.startsWith("file://") ? "allow" : "deny";
  const from = embedHost(f.frameUrl);
  const to = embedHost(f.url);
  if (from === null) return "allow";
  return to === from ? "allow" : "deny";
}

/** The attachment id of a harness-embed: URL, or null for any other URL. */
function embedHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === `${EMBED_SCHEME}:` ? u.hostname : null;
  } catch {
    return null;
  }
}

/** A window.open or target=_blank from any frame: http(s) opens in the system browser, and no window opens in the app. */
export const opensExternally = (url: string) => /^https?:\/\//.test(url);

/** How many pages a frame (an embed, a plugin) may open in the system browser within OPEN_WINDOW_MS. */
export const MAX_EXTERNAL_OPENS = 3;
export const OPEN_WINDOW_MS = 10_000;

/**
 * Whether a frame's popup or navigation may open the system browser now, given when the earlier
 * ones did (`opened`, kept and pruned in place). A hostile page looping `location = "https://…"`
 * would otherwise open browser tabs without end; a person following links never hits the limit.
 */
export function externalOpenAllowed(opened: number[], now: number): boolean {
  while (opened.length && now - opened[0]! >= OPEN_WINDOW_MS) opened.shift();
  if (opened.length >= MAX_EXTERNAL_OPENS) return false;
  opened.push(now);
  return true;
}
