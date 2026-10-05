// WebSocket: forwards every HarnessEvent to every client, except browser.frame/state,
// which only go to clients subscribed to that session (via BrowserService.subscribe).
//
// A socket can hold several browser viewers of one session (two torn-off browser tabs in one
// window), each named by the client's `viewerId`. The manager's subscriber id is
// `<socket id>:<viewerId>`, or the bare socket id for a viewer without one (older clients).

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { randomUUID } from "node:crypto";
import type { ClientMessage, HarnessEvent, ServerMessage } from "@harness/shared";
import type { BrowserService } from "../browser/types";
import type { EventBus } from "../events";
import { VERSION } from "../config";

export interface WsData {
  id: string;
  /** sessionId → the viewer ids watching it on this socket ("" for a client that sends none). */
  subs: Map<string, Set<string>>;
  off: (() => void) | null;
}

/** A viewer id from the wire: a short id, or "" when missing or malformed. */
export function viewerIdOf(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : "";
}

/** The BrowserService subscriber id for one viewer on one socket. */
export function subscriberIdOf(socketId: string, viewerId: string): string {
  return viewerId ? `${socketId}:${viewerId}` : socketId;
}

function send(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

export function createWsHandlers(opts: { bus: EventBus; browser: BrowserService }) {
  const { bus, browser } = opts;
  const sockets = new Set<ServerWebSocket<WsData>>();

  const unsubscribe = (ws: ServerWebSocket<WsData>, sessionId: string, viewerId: string) => {
    const viewers = ws.data.subs.get(sessionId);
    if (!viewers?.delete(viewerId)) return;
    if (viewers.size === 0) ws.data.subs.delete(sessionId);
    browser.unsubscribe(sessionId, subscriberIdOf(ws.data.id, viewerId)).catch(() => {});
  };

  const websocket: WebSocketHandler<WsData> = {
    idleTimeout: 120,
    open(ws) {
      sockets.add(ws);
      send(ws, { type: "welcome", version: VERSION });
      ws.data.off = bus.on((event: HarnessEvent) => {
        if (event.kind === "browser.frame" || event.kind === "browser.state") {
          if (!ws.data.subs.has(event.sessionId)) return;
        }
        send(ws, { type: "event", event });
      });
    },
    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return send(ws, { type: "error", message: "Invalid JSON" });
      }
      switch (msg?.type) {
        case "hello":
          return;
        case "ping":
          return send(ws, { type: "pong" });
        case "browser.subscribe": {
          const sid = msg.sessionId;
          if (typeof sid !== "string") return;
          const tab = typeof msg.tabId === "number" ? msg.tabId : undefined;
          const viewer = viewerIdOf(msg.viewerId);
          const tag = viewer ? { viewerId: viewer } : {};
          const viewers = ws.data.subs.get(sid) ?? new Set<string>();
          // Subscribing again is a tab switch; without a tab it changes nothing.
          if (viewers.has(viewer) && tab === undefined) return;
          viewers.add(viewer);
          ws.data.subs.set(sid, viewers);
          try {
            await browser.subscribe(
              sid,
              subscriberIdOf(ws.data.id, viewer),
              (f) =>
                send(ws, {
                  type: "event",
                  event: { kind: "browser.frame", sessionId: sid, tabId: f.tabId, data: f.data, width: f.width, height: f.height, ...tag },
                }),
              (state) => send(ws, { type: "event", event: { kind: "browser.state", sessionId: sid, state, ...tag } }),
              { tab },
            );
          } catch (err) {
            viewers.delete(viewer);
            if (viewers.size === 0) ws.data.subs.delete(sid);
            send(ws, { type: "error", message: `browser.subscribe failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        }
        case "browser.unsubscribe":
          return unsubscribe(ws, msg.sessionId, viewerIdOf(msg.viewerId));
        case "browser.input":
          try {
            await browser.input(msg.sessionId, msg.input, {
              tab: typeof msg.tabId === "number" ? msg.tabId : undefined,
              subscriberId: subscriberIdOf(ws.data.id, viewerIdOf(msg.viewerId)),
            });
          } catch (err) {
            send(ws, { type: "error", message: `browser.input failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        default:
          return send(ws, { type: "error", message: `Unknown message type: ${(msg as { type?: unknown })?.type}` });
      }
    },
    close(ws) {
      sockets.delete(ws);
      ws.data.off?.();
      ws.data.off = null;
      for (const [sid, viewers] of [...ws.data.subs]) for (const v of [...viewers]) unsubscribe(ws, sid, v);
    },
  };

  return {
    websocket,
    newData: (): WsData => ({ id: randomUUID(), subs: new Map(), off: null }),
    /** Close every open socket (token rotation: they authenticated with the old token). */
    closeAll(code = 4001, reason = "token rotated") {
      for (const ws of [...sockets]) {
        try {
          ws.close(code, reason);
        } catch {}
      }
    },
  };
}
