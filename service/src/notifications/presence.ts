// What each connected client has on screen (DESIGN.md "Notifications"), one entry per WebSocket.
// A socket's presence goes when the socket closes. Bun pings idle sockets and closes one that stops
// answering (the server's idleTimeout), so a client that vanished without closing (a suspended
// iPhone, a dropped network) can't hold notifications back for more than a couple of minutes.

import type { DevicePlatform, Presence } from "@harness/shared";

const MAX_TICKETS = 2000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A presence message from the wire, cleaned up; null when it isn't one. */
export function parsePresence(raw: unknown): Presence | null {
  if (!raw || typeof raw !== "object") return null;
  const { deviceId, platform, visible, tickets } = raw as Record<string, unknown>;
  if (typeof deviceId !== "string" || !deviceId || deviceId.length > 128) return null;
  if (platform !== "mac" && platform !== "ios") return null;
  if (typeof visible !== "boolean" || !Array.isArray(tickets)) return null;
  const keys = tickets.filter((k): k is string => typeof k === "string" && KEY.test(k)).slice(0, MAX_TICKETS);
  return { deviceId, platform: platform as DevicePlatform, visible, tickets: [...new Set(keys.map((k) => k.toUpperCase()))] };
}

export class PresenceRegistry {
  private bySocket = new Map<string, Presence>();

  /** Replace a socket's presence. */
  set(socketId: string, presence: Presence) {
    this.bySocket.set(socketId, presence);
  }

  /** Forget a socket (it closed). */
  drop(socketId: string) {
    this.bySocket.delete(socketId);
  }

  /** Whether a visible client has this ticket on screen. */
  isOnScreen(ticketKey: string): boolean {
    const key = ticketKey.toUpperCase();
    for (const p of this.bySocket.values()) if (p.visible && p.tickets.includes(key)) return true;
    return false;
  }

  all(): Presence[] {
    return [...this.bySocket.values()];
  }
}
