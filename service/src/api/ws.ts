// WebSocket: forwards every HarnessEvent to every client, except browser.frame/state,
// which only go to clients subscribed to that session (via BrowserService.subscribe).
//
// A socket can hold several browser viewers of one session (two torn-off browser tabs in one
// window), each named by the client's `viewerId`. The manager's subscriber id is
// `<socket id>:<viewerId>`, or the bare socket id for a viewer without one (older clients).
//
// A socket's `presence` (what it shows) is kept in the PresenceRegistry until it closes, so the
// notification dispatcher can hold back notifications for tickets on screen.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { randomUUID } from "node:crypto";
import type { ClientMessage, HarnessEvent, ServerMessage } from "@harness/shared";
import type { BrowserService } from "../browser/types";
import type { EventBus } from "../events";
import { VERSION } from "../config";
import { parsePresence, type PresenceRegistry } from "../notifications/presence";
import { HarnessError } from "../orchestrator/errors";
import type { TerminalRegistry } from "../terminals/registry";
import type { MacRequests } from "./mac-requests";

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

export function createWsHandlers(opts: { bus: EventBus; browser: BrowserService; presence?: PresenceRegistry; terminals?: TerminalRegistry; macRequests?: MacRequests }) {
  const { bus, browser, presence, terminals, macRequests } = opts;
  const sockets = new Set<ServerWebSocket<WsData>>();

  /** One socket per Mac device (windows of one app share a device id), the visible one when there is one, and only sockets connected right now. */
  const macSockets = (): ServerWebSocket<WsData>[] => {
    const byDevice = new Map<string, ServerWebSocket<WsData>>();
    for (const ws of sockets) {
      const p = presence?.get(ws.data.id);
      if (!p || p.platform !== "mac") continue;
      const best = byDevice.get(p.deviceId);
      if (!best || (p.visible && !presence?.get(best.data.id)?.visible)) byDevice.set(p.deviceId, ws);
    }
    return [...byDevice.values()];
  };

  // A request goes to one Mac: the visible one, else the first. Nothing is queued for a Mac that isn't connected.
  macRequests?.bind((id, request) => {
    const macs = macSockets();
    const ws = macs.find((w) => presence?.get(w.data.id)?.visible) ?? macs[0];
    if (!ws) return null;
    send(ws, { type: "app.request", id, request });
    return ws.data.id;
  });

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
      ws.data.off = bus.on((busEvent) => {
        // The chief-of-staff events ride the same socket; clients that don't know a kind ignore it.
        const event = busEvent as HarnessEvent;
        if (event.kind === "browser.frame" || event.kind === "browser.state") {
          if (!ws.data.subs.has(event.sessionId)) return;
        }
        send(ws, { type: "event", event });
      });
    },
    async message(ws, raw) {
      terminals?.touch(ws.data.id);
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
        case "presence": {
          const p = parsePresence(msg);
          if (!p) return send(ws, { type: "error", message: "presence needs deviceId, platform (mac or ios), visible and tickets" });
          presence?.set(ws.data.id, p);
          terminals?.setPresence(ws.data.id, p);
          return;
        }
        case "app.reply":
          if (typeof msg.id === "string" && msg.reply && typeof msg.reply === "object" && typeof msg.reply.ok === "boolean" && (msg.reply.ok ? msg.reply.result !== undefined : typeof msg.reply.error === "string")) macRequests?.reply(ws.data.id, msg.id, msg.reply);
          return;
        case "terminal.attach": {
          if (!terminals || typeof msg.id !== "string") return;
          try {
            await terminals.attach(
              { id: ws.data.id, send: (m) => send(ws, m), buffered: () => ws.getBufferedAmount() },
              msg.id,
              typeof msg.deviceId === "string" ? msg.deviceId.slice(0, 128) : "",
              msg.cols,
              msg.rows,
            );
          } catch (err) {
            // A terminal that is gone (the service restarted, it was closed) reads as ended.
            send(ws, { type: "terminal.exit", id: msg.id, exitCode: null });
            if (!(err instanceof HarnessError && err.status === 404)) send(ws, { type: "error", message: `terminal.attach failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        }
        case "terminal.detach":
          if (typeof msg.id === "string") terminals?.detach(ws.data.id, msg.id);
          return;
        case "terminal.resize":
          if (typeof msg.id === "string") terminals?.resize(ws.data.id, msg.id, msg.cols, msg.rows);
          return;
        case "terminal.write":
          if (typeof msg.id !== "string") return;
          try {
            terminals?.write(ws.data.id, msg.id, msg.data);
          } catch (err) {
            if (err instanceof HarnessError && err.status === 404) send(ws, { type: "terminal.exit", id: String(msg.id), exitCode: null });
            else send(ws, { type: "error", message: `terminal.write failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
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
      presence?.drop(ws.data.id);
      terminals?.dropClient(ws.data.id);
      macRequests?.socketClosed(ws.data.id);
      ws.data.off?.();
      ws.data.off = null;
      for (const [sid, viewers] of [...ws.data.subs]) for (const v of [...viewers]) unsubscribe(ws, sid, v);
    },
  };

  // A rejection from the async handler would end a Bun process with nothing to catch it: nothing a
  // client sends may take the service down, so whatever escapes is logged and the socket carries on.
  const handleMessage = websocket.message!;
  websocket.message = (ws, raw) => {
    const swallow = (err: unknown) => console.error("websocket message failed:", err);
    try {
      return Promise.resolve(handleMessage.call(websocket, ws, raw)).catch(swallow);
    } catch (err) {
      swallow(err);
    }
  };

  return {
    websocket,
    connected: () => sockets.size,
    /**
     * Ask a Mac to open a pane for a terminal: one socket per Mac device (windows of one app share
     * a device id), the visible one when there is one, and only sockets connected right now. Nothing
     * is queued for a Mac that isn't. Returns how many sockets were asked.
     */
    openOnMac(terminal: { id: string; projectId: string | null }): number {
      const macs = macSockets();
      for (const ws of macs) send(ws, { type: "terminal.open", id: terminal.id, projectId: terminal.projectId });
      return macs.length;
    },
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
