// Plugin UI side of the host bridge (DESIGN.md "Plugins"). Bundle this into your plugin UI:
//
//   import { connect } from "@harness/plugin-sdk";
//   const h = await connect();
//   const changes = await h.api("changes?ticket=" + h.ticketKey);   // → /plugins/<id>/api/changes
//   h.onTheme((t, info) => …); h.onTicket((ticket) => …);
//   // CSS: var(--harness-bg), var(--harness-text-2), var(--harness-accent), … (the app theme's tokens)
//
// The UI is served by the service (/plugins/<id>/ui/), so its origin is the service origin and API
// calls are same-origin; they just need the bearer token from harness:init. Two hosts, one API:
//   - Desktop: an iframe. Messages are accepted only from window.parent, first only from an allowed
//     host origin, and replies go to window.parent.postMessage.
//   - iOS: a WKWebView (detected by window.ReactNativeWebView.postMessage, a name kept from the
//     1.x React Native app). The host
//     injects `window.postMessage(msg, serviceOrigin)` into the page, so messages are accepted only
//     when event.source is this window and event.origin is this page's own origin; replies go to
//     ReactNativeWebView.postMessage(JSON.stringify(msg)).
// In both, after init only the origin that sent init is trusted. Don't assume window.parent exists.

import type { PluginFrameMessage, PluginHostMessage, Ticket } from "@harness/shared";
import { CSS_VAR, type ThemeTokens } from "@harness/shared/themes/types";

export type Theme = "light" | "dark";

/**
 * The app's full color theme. Hosts older than color themes send only light/dark: then themeId,
 * syntaxTheme and tokens are null and themeName is "".
 */
export interface ThemeInfo {
  appearance: Theme;
  /** e.g. "catppuccin-mocha" */
  themeId: string | null;
  themeName: string;
  /** Shiki theme matching the app theme (e.g. "dracula"), or null */
  syntaxTheme: string | null;
  /** Semantic color tokens (bg, text, text2, accent, planning, diffAdd, …), or null */
  tokens: Partial<ThemeTokens> | null;
}

/** Token name → the custom property the SDK sets on <html> ("bg" → "--harness-bg", "text2" → "--harness-text-2"). */
export function tokenCssVar(token: string): string | null {
  const v = (CSS_VAR as Record<string, string>)[token];
  return v ? `--harness-${v.slice(2)}` : null;
}

const TOKEN_VALUE = /^[#(),.%\w\s-]{1,200}$/;

/** Pull the theme fields out of a harness:init / harness:theme message, dropping anything malformed. */
export function readThemeInfo(msg: Record<string, unknown>): ThemeInfo {
  const appearance: Theme = msg.theme === "dark" ? "dark" : "light";
  let tokens: Partial<ThemeTokens> | null = null;
  if (msg.tokens && typeof msg.tokens === "object" && !Array.isArray(msg.tokens)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.tokens as Record<string, unknown>)) {
      if (typeof v === "string" && tokenCssVar(k) && TOKEN_VALUE.test(v)) out[k] = v;
    }
    tokens = Object.keys(out).length ? (out as Partial<ThemeTokens>) : null;
  }
  const str = (v: unknown) => (typeof v === "string" && v.length <= 100 ? v : null);
  return { appearance, themeId: str(msg.themeId), themeName: str(msg.themeName) ?? "", syntaxTheme: str(msg.syntaxTheme), tokens };
}

const infoKey = (i: ThemeInfo) => JSON.stringify([i.appearance, i.themeId, i.themeName, i.syntaxTheme, i.tokens]);

export interface HarnessPlugin {
  baseUrl: string;
  token: string;
  ticketKey: string;
  tabId: string;
  pluginId: string;
  /** Current theme; kept up to date as harness:theme messages arrive */
  readonly theme: Theme;
  /** Same as theme */
  readonly appearance: Theme;
  /** The app's color theme id ("catppuccin-mocha"), or null from hosts without color themes */
  readonly themeId: string | null;
  readonly themeName: string;
  /** Shiki theme matching the app theme, or null */
  readonly syntaxTheme: string | null;
  /** The app theme's color tokens (also set as --harness-* custom properties on <html>), or null */
  readonly tokens: Partial<ThemeTokens> | null;
  /**
   * Call the service. A path without a leading slash is relative to this plugin's API
   * (/plugins/<id>/api/<path>); a leading slash addresses the service root ("/tickets/X").
   * Resolves to the `data` of the `{ data }` envelope; throws HarnessPluginError otherwise.
   */
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  /** Called when the theme changes: light/dark, or (with a newer host) the color theme / its tokens */
  onTheme(cb: (theme: Theme, info: ThemeInfo) => void): () => void;
  onTicket(cb: (ticket: Ticket) => void): () => void;
  openExternal(url: string): void;
  navigate(ticketKey: string): void;
  close(): void;
}

export class HarnessPluginError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The subset of `window` the bridge uses (injectable for tests and non-browser hosts). */
export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  location: { pathname: string; search: string; origin?: string };
  /** Injected before the page loads when hosted in the iOS app (a WKWebView; the name is historical) */
  ReactNativeWebView?: { postMessage(data: string): void };
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  document?: {
    documentElement: {
      dataset: Record<string, string | undefined>;
      style: { colorScheme?: string; setProperty?(name: string, value: string): void; removeProperty?(name: string): unknown };
    };
  };
}

export interface ConnectOptions {
  window?: BridgeWindow;
  fetch?: typeof fetch;
  /** Reject if no harness:init arrives in time (default 10s) */
  timeoutMs?: number;
  /** Extra host origins to trust besides the Electron file:// renderer and local http(s) origins */
  allowedOrigins?: string[];
  /**
   * On init and every theme change, set <html data-theme>, color-scheme, data-theme-id and the
   * tokens as --harness-* custom properties (default true)
   */
  applyTheme?: boolean;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Host origins a plugin iframe accepts messages from by default. */
export function isAllowedHostOrigin(origin: string, extra: string[] = []): boolean {
  return origin === "null" || origin === "file://" || LOCAL_ORIGIN.test(origin) || extra.includes(origin);
}

/** "/plugins/<id>/ui/…" → "<id>" */
export function pluginIdFromPath(pathname: string): string | null {
  const m = /\/plugins\/([^/]+)\/ui(\/|$)/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function connect(opts: ConnectOptions = {}): Promise<HarnessPlugin> {
  const win = opts.window ?? (globalThis as unknown as { window: BridgeWindow }).window;
  const doFetch = opts.fetch ?? fetch.bind(globalThis);
  const pluginId = pluginIdFromPath(win.location.pathname) ?? "";
  const applyTheme = opts.applyTheme ?? true;
  const themeCbs = new Set<(t: Theme, info: ThemeInfo) => void>();
  const ticketCbs = new Set<(t: Ticket) => void>();
  let hostOrigin: string | null = null;
  type Mutable = { -readonly [K in keyof HarnessPlugin]: HarnessPlugin[K] };
  let plugin: Mutable | null = null;
  let info: ThemeInfo | null = null;
  let applied: string[] = [];

  const setTheme = (i: ThemeInfo) => {
    if (!applyTheme || !win.document) return;
    const el = win.document.documentElement;
    el.dataset.theme = i.appearance;
    el.style.colorScheme = i.appearance;
    if (i.themeId) el.dataset.themeId = i.themeId;
    else delete el.dataset.themeId;
    const next = Object.entries(i.tokens ?? {}).map(([k, v]) => [tokenCssVar(k)!, v as string] as const);
    const keep = new Set(next.map(([k]) => k));
    for (const k of applied) if (!keep.has(k)) el.style.removeProperty?.(k);
    for (const [k, v] of next) el.style.setProperty?.(k, v);
    applied = [...keep];
  };
  /** Adopt a new theme; notify only when something changed. */
  const updateTheme = (next: ThemeInfo) => {
    if (!plugin || !info) return;
    if (infoKey(next) === infoKey(info)) return;
    info = next;
    Object.assign(plugin, { theme: next.appearance, appearance: next.appearance, themeId: next.themeId, themeName: next.themeName, syntaxTheme: next.syntaxTheme, tokens: next.tokens });
    setTheme(next);
    for (const cb of themeCbs) cb(next.appearance, next);
  };
  const native = typeof win.ReactNativeWebView?.postMessage === "function" ? win.ReactNativeWebView : null;
  const post = (msg: PluginFrameMessage) => {
    if (native) return native.postMessage(JSON.stringify(msg));
    // Opaque/file origins can't be named as a targetOrigin; these messages carry no secrets.
    const target = hostOrigin && hostOrigin !== "null" && hostOrigin !== "file://" ? hostOrigin : "*";
    win.parent?.postMessage(msg, target);
  };
  /** Is this event from our host? (source + origin rules for the iframe or WebView transport) */
  const fromHost = (e: MessageEvent): boolean => {
    if (native) {
      // The WebView host injects window.postMessage(msg, serviceOrigin) into this page.
      if (e.source !== win) return false;
      const own = win.location.origin;
      if (!own || own === "null") return false;
      return hostOrigin ? e.origin === hostOrigin : e.origin === own;
    }
    if (!win.parent || e.source !== win.parent) return false;
    return hostOrigin ? e.origin === hostOrigin : isAllowedHostOrigin(e.origin, opts.allowedOrigins);
  };

  return new Promise<HarnessPlugin>((resolve, reject) => {
    const timer = setTimeout(() => {
      win.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for harness:init from the host"));
    }, opts.timeoutMs ?? 10_000);

    function onMessage(e: MessageEvent) {
      if (!fromHost(e)) return;
      const msg = e.data as PluginHostMessage;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (msg.type === "harness:init") {
        if (plugin) {
          // Re-init (e.g. token rotated after a reconnect): refresh credentials in place.
          plugin.baseUrl = msg.baseUrl;
          plugin.token = msg.token;
          if (msg.theme === "light" || msg.theme === "dark") updateTheme(readThemeInfo(msg as unknown as Record<string, unknown>));
          return;
        }
        if (typeof msg.baseUrl !== "string" || typeof msg.token !== "string" || typeof msg.ticketKey !== "string") return;
        hostOrigin = e.origin;
        clearTimeout(timer);
        info = readThemeInfo(msg as unknown as Record<string, unknown>);
        const self: Mutable = {
          baseUrl: msg.baseUrl.replace(/\/$/, ""),
          token: msg.token,
          ticketKey: msg.ticketKey,
          tabId: msg.tabId,
          pluginId,
          theme: info.appearance,
          appearance: info.appearance,
          themeId: info.themeId,
          themeName: info.themeName,
          syntaxTheme: info.syntaxTheme,
          tokens: info.tokens,
          async api<T>(path: string, init: RequestInit = {}) {
            const url = path.startsWith("/") ? self.baseUrl + path : `${self.baseUrl}/plugins/${encodeURIComponent(pluginId)}/api/${path}`;
            const headers = new Headers(init.headers);
            headers.set("authorization", `Bearer ${self.token}`);
            if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
            const res = await doFetch(url, { ...init, headers });
            const text = await res.text();
            let json: { data?: T; error?: string } = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              if (!res.ok) throw new HarnessPluginError(res.status, text || res.statusText);
              throw new HarnessPluginError(res.status, "Response was not JSON");
            }
            if (!res.ok) throw new HarnessPluginError(res.status, json.error ?? res.statusText);
            return json.data as T;
          },
          onTheme(cb) {
            themeCbs.add(cb);
            return () => void themeCbs.delete(cb);
          },
          onTicket(cb) {
            ticketCbs.add(cb);
            return () => void ticketCbs.delete(cb);
          },
          openExternal: (url) => post({ type: "harness:openExternal", url }),
          navigate: (ticketKey) => post({ type: "harness:navigate", ticketKey }),
          close() {
            win.removeEventListener("message", onMessage);
            themeCbs.clear();
            ticketCbs.clear();
          },
        };
        plugin = self;
        setTheme(info);
        resolve(self);
        return;
      }
      if (!plugin) return;
      if (msg.type === "harness:theme" && (msg.theme === "light" || msg.theme === "dark")) {
        updateTheme(readThemeInfo(msg as unknown as Record<string, unknown>));
      } else if (msg.type === "harness:ticket" && msg.ticket?.key === plugin.ticketKey) {
        for (const cb of ticketCbs) cb(msg.ticket);
      }
    }

    win.addEventListener("message", onMessage);
    post({ type: "harness:ready" });
  });
}
