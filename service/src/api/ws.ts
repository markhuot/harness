// WebSocket: forwards every HarnessEvent to every client, except browser.frame/state,
// which only go to clients subscribed to that session (via BrowserService.subscribe).

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { randomUUID } from "node:crypto";
import type { ClientMessage, HarnessEvent, ServerMessage } from "@harness/shared";
import type { BrowserService } from "../browser/types";
import type { EventBus } from "../events";
import { VERSION } from "../config";

export interface WsData {
  id: string;
  subs: Set<string>;
  off: (() => void) | null;
}

function send(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

export function createWsHandlers(opts: { bus: EventBus; browser: BrowserService }) {
  const { bus, browser } = opts;
  const sockets = new Set<ServerWebSocket<WsData>>();

  const unsubscribe = (ws: ServerWebSocket<WsData>, sessionId: string) => {
    if (!ws.data.subs.delete(sessionId)) return;
    browser.unsubscribe(sessionId, ws.data.id).catch(() => {});
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
          if (typeof sid !== "string" || ws.data.subs.has(sid)) return;
          ws.data.subs.add(sid);
          try {
            await browser.subscribe(
              sid,
              ws.data.id,
              (f) => send(ws, { type: "event", event: { kind: "browser.frame", sessionId: sid, data: f.data, width: f.width, height: f.height } }),
              (state) => send(ws, { type: "event", event: { kind: "browser.state", sessionId: sid, state } }),
            );
          } catch (err) {
            ws.data.subs.delete(sid);
            send(ws, { type: "error", message: `browser.subscribe failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        }
        case "browser.unsubscribe":
          return unsubscribe(ws, msg.sessionId);
        case "browser.input":
          try {
            await browser.input(msg.sessionId, msg.input);
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
      for (const sid of [...ws.data.subs]) unsubscribe(ws, sid);
    },
  };

  return {
    websocket,
    newData: (): WsData => ({ id: randomUUID(), subs: new Set(), off: null }),
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
