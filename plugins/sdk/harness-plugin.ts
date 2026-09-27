// Plugin UI side of the host bridge (DESIGN.md "Plugins"). Bundle this into your plugin UI:
//
//   import { connect } from "@harness/plugin-sdk";
//   const h = await connect();
//   const changes = await h.api("changes?ticket=" + h.ticketKey);   // → /plugins/<id>/api/changes
//   h.onTheme((t) => …); h.onTicket((ticket) => …);
//
// The UI is served by the service (/plugins/<id>/ui/), so its origin is the service origin and API
// calls are same-origin; they just need the bearer token from harness:init. Two hosts, one API:
//   - Desktop: an iframe. Messages are accepted only from window.parent, first only from an allowed
//     host origin, and replies go to window.parent.postMessage.
//   - iOS: a React Native WebView (detected by window.ReactNativeWebView.postMessage). The host
//     injects `window.postMessage(msg, serviceOrigin)` into the page, so messages are accepted only
//     when event.source is this window and event.origin is this page's own origin; replies go to
//     ReactNativeWebView.postMessage(JSON.stringify(msg)).
// In both, after init only the origin that sent init is trusted. Don't assume window.parent exists.

import type { PluginFrameMessage, PluginHostMessage, Ticket } from "@harness/shared";

export type Theme = "light" | "dark";

export interface HarnessPlugin {
  baseUrl: string;
  token: string;
  ticketKey: string;
  tabId: string;
  pluginId: string;
  /** Current theme; kept up to date as harness:theme messages arrive */
  readonly theme: Theme;
  /**
   * Call the service. A path without a leading slash is relative to this plugin's API
   * (/plugins/<id>/api/<path>); a leading slash addresses the service root ("/tickets/X").
   * Resolves to the `data` of the `{ data }` envelope; throws HarnessPluginError otherwise.
   */
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  onTheme(cb: (theme: Theme) => void): () => void;
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
  /** Injected by react-native-webview before the page loads when hosted in the iOS app */
  ReactNativeWebView?: { postMessage(data: string): void };
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  document?: { documentElement: { dataset: Record<string, string | undefined>; style: { colorScheme?: string } } };
}

export interface ConnectOptions {
  window?: BridgeWindow;
  fetch?: typeof fetch;
  /** Reject if no harness:init arrives in time (default 10s) */
  timeoutMs?: number;
  /** Extra host origins to trust besides the Electron file:// renderer and local http(s) origins */
  allowedOrigins?: string[];
  /** Set <html data-theme> and color-scheme on init and on every theme change (default true) */
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
  const themeCbs = new Set<(t: Theme) => void>();
  const ticketCbs = new Set<(t: Ticket) => void>();
  let hostOrigin: string | null = null;
  let plugin: (HarnessPlugin & { theme: Theme }) | null = null;

  const setTheme = (t: Theme) => {
    if (!applyTheme || !win.document) return;
    win.document.documentElement.dataset.theme = t;
    win.document.documentElement.style.colorScheme = t;
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
          if (msg.theme !== plugin.theme) {
            plugin.theme = msg.theme;
            setTheme(msg.theme);
            for (const cb of themeCbs) cb(msg.theme);
          }
          return;
        }
        if (typeof msg.baseUrl !== "string" || typeof msg.token !== "string" || typeof msg.ticketKey !== "string") return;
        hostOrigin = e.origin;
        clearTimeout(timer);
        const self: HarnessPlugin & { theme: Theme } = {
          baseUrl: msg.baseUrl.replace(/\/$/, ""),
          token: msg.token,
          ticketKey: msg.ticketKey,
          tabId: msg.tabId,
          pluginId,
          theme: msg.theme === "dark" ? "dark" : "light",
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
        setTheme(self.theme);
        resolve(self);
        return;
      }
      if (!plugin) return;
      if (msg.type === "harness:theme" && (msg.theme === "light" || msg.theme === "dark")) {
        plugin.theme = msg.theme;
        setTheme(msg.theme);
        for (const cb of themeCbs) cb(msg.theme);
      } else if (msg.type === "harness:ticket" && msg.ticket?.key === plugin.ticketKey) {
        for (const cb of ticketCbs) cb(msg.ticket);
      }
    }

    win.addEventListener("message", onMessage);
    post({ type: "harness:ready" });
  });
}
