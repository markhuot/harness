// Host side of the plugin bridge (DESIGN.md "Plugins"). Pure logic, no React/Electron/DOM, shared by the
// desktop iframe host and the iOS WebView host, which both follow the same rules:
//   - the token only ever goes to the service origin (postMessage targetOrigin = serviceOrigin)
//   - only messages from our own iframe's window, at the service origin, are accepted
//   - openExternal is limited to http(s)/mailto; navigate to well-formed ticket keys

import type { PluginFrameMessage, PluginHostMessage, Ticket } from "../protocol";

export type ResolvedTheme = "light" | "dark";

export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** What the bridge reads from a message event (a DOM MessageEvent, or a WebView message adapted to it). */
export interface HostMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

export interface PluginHostBridgeOptions {
  /** Service base URL, e.g. http://127.0.0.1:7717 */
  baseUrl: string;
  token: string;
  ticketKey: string;
  tabId: string;
  /** The iframe's current contentWindow (null before it exists) */
  frame: () => FrameWindow | null;
  theme: () => ResolvedTheme;
  onNavigate: (ticketKey: string) => void;
  onOpenExternal: (url: string) => void;
  /** First harness:ready from the frame (the plugin connected) */
  onReady?: () => void;
}

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const EXTERNAL = /^(https?:\/\/|mailto:)/i;

export function pluginUiUrl(baseUrl: string, pluginId: string, tabId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/plugins/${encodeURIComponent(pluginId)}/ui/index.html?tab=${encodeURIComponent(tabId)}`;
}

export function createPluginHostBridge(opts: PluginHostBridgeOptions) {
  const serviceOrigin = new URL(opts.baseUrl).origin;
  let ready = false;

  const post = (msg: PluginHostMessage) => opts.frame()?.postMessage(msg, serviceOrigin);
  const sendInit = () =>
    post({ type: "harness:init", baseUrl: opts.baseUrl.replace(/\/$/, ""), token: opts.token, ticketKey: opts.ticketKey, tabId: opts.tabId, theme: opts.theme() });

  return {
    serviceOrigin,
    /** iframe load event: offer init right away (plugins not using the SDK never send ready). */
    onLoad: sendInit,
    /** window "message" listener. Returns true when the message was accepted. */
    onMessage(e: HostMessageEvent): boolean {
      const frame = opts.frame();
      if (!frame || e.source !== frame || e.origin !== serviceOrigin) return false;
      const msg = e.data as PluginFrameMessage;
      if (!msg || typeof msg !== "object") return false;
      switch (msg.type) {
        case "harness:ready":
          sendInit();
          if (!ready) {
            ready = true;
            opts.onReady?.();
          }
          return true;
        case "harness:openExternal":
          if (typeof msg.url !== "string" || !EXTERNAL.test(msg.url)) return false;
          opts.onOpenExternal(msg.url);
          return true;
        case "harness:navigate":
          if (typeof msg.ticketKey !== "string" || !KEY.test(msg.ticketKey)) return false;
          opts.onNavigate(msg.ticketKey);
          return true;
        default:
          return false;
      }
    },
    sendTheme: (theme: ResolvedTheme) => post({ type: "harness:theme", theme }),
    sendTicket: (ticket: Ticket) => {
      if (ticket.key === opts.ticketKey) post({ type: "harness:ticket", ticket });
    },
  };
}
