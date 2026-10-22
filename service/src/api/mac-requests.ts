// Requests from the service to a Mac app that wait for its answer (app.request / app.reply on the
// WebSocket). Only the Mac knows some things (its window layout), so a chief of staff's tool asks
// and waits here. The socket layer (ws.ts) binds how a request reaches one Mac and feeds replies
// back; this class keeps the pending ids, the timeout and the distinct ways a request fails.

import { randomUUID } from "node:crypto";
import type { AppReply, AppRequest } from "@harness/shared";

export const MAC_REQUEST_TIMEOUT_MS = 5000;

/** Why a request got no answer: no Mac connected (nothing happened), the Mac went away or never answered (the outcome is unknown). */
export class MacRequestError extends Error {
  constructor(
    readonly reason: "no_mac" | "disconnected" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

/** Sends one app.request to one Mac socket and returns that socket's id, or null when no Mac is connected. */
export type MacSender = (id: string, request: AppRequest) => string | null;

export class MacRequests {
  private send: MacSender | null = null;
  private readonly pending = new Map<string, { socketId: string; settle: (r: AppReply | MacRequestError) => void }>();

  /** Called by the socket layer: how a request reaches a Mac. */
  bind(send: MacSender) {
    this.send = send;
  }

  async request(request: AppRequest, timeoutMs = MAC_REQUEST_TIMEOUT_MS): Promise<AppReply> {
    const id = randomUUID();
    return new Promise<AppReply>((resolve, reject) => {
      const done = (r: AppReply | MacRequestError) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (r instanceof MacRequestError) reject(r);
        else resolve(r);
      };
      const timer = setTimeout(
        () => done(new MacRequestError("timeout", "The Mac didn't answer in time, so it is unknown whether the change was applied. Read the layout with get_layout before trying again.")),
        timeoutMs,
      );
      const socketId = this.send?.(id, request) ?? null;
      if (!socketId) return done(new MacRequestError("no_mac", "No Mac app is connected, so there is no window to arrange. Nothing was changed."));
      this.pending.set(id, { socketId, settle: done });
    });
  }

  /** An answer from `socketId`; one from any socket the request wasn't sent to is ignored. */
  reply(socketId: string, id: string, reply: AppReply) {
    const p = this.pending.get(id);
    if (p && p.socketId === socketId) p.settle(reply);
  }

  /** A socket closed: its pending requests will never be answered. */
  socketClosed(socketId: string) {
    for (const p of [...this.pending.values()]) {
      if (p.socketId === socketId) p.settle(new MacRequestError("disconnected", "The Mac disconnected before it answered, so it is unknown whether the change was applied. Read the layout with get_layout before trying again."));
    }
  }
}
