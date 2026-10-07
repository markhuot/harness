// System notifications through Apple Push (DESIGN.md "Notifications"): the Mac's install id, the
// APNs registration the service sends pushes to, and the ticket a clicked notification opens.
// Electron-free, so it's tested on its own; main.ts wires it to pushNotifications and Notification.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isTicketKey, PUSH_TICKET_KEY, type ApnsEnvironment, type RegisterDeviceBody } from "@harness/shared";
import type { ConnectionResult } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * This install's device id: the one stored at `path`, else a new one written there. Every window
 * reports presence under it and the push registration uses it, so the service sees one Mac.
 */
export function loadDeviceId(path: string, uuid: () => string = () => crypto.randomUUID()): string {
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (UUID_RE.test(stored)) return stored.toLowerCase();
  } catch {}
  const id = uuid();
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id + "\n");
  } catch (e) {
    console.error("could not save the device id", e);
  }
  return id;
}

/** A key as the service writes it (HARNESS-342), upper-cased; null for anything else. */
function validKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const key = v.trim().toUpperCase();
  return isTicketKey(key) ? key : null;
}

/**
 * The ticket a push names: its custom `ticketKey`, else `aps.thread-id` (also the ticket key).
 * Takes the userInfo itself (received-apns-notification) or the launch info of a click that
 * opened the app, which wraps it as `{ userInfo }` (a UNNotificationResponse).
 */
export function ticketKeyFromPush(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const o = info as Record<string, unknown>;
  if (o.userInfo && typeof o.userInfo === "object" && !(PUSH_TICKET_KEY in o) && !("aps" in o)) return ticketKeyFromPush(o.userInfo);
  const aps = o.aps && typeof o.aps === "object" ? (o.aps as Record<string, unknown>) : null;
  return validKey(o[PUSH_TICKET_KEY]) ?? validKey(aps?.["thread-id"]);
}

/**
 * The ticket of a notification still in Notification Center (Notification.getHistory()): its
 * group (the push's thread-id), else the key the title starts with ("HARNESS-342 · Title").
 */
export function ticketKeyFromDelivered(n: { groupId?: string | null; title?: string | null }): string | null {
  return validKey(n.groupId) ?? validKey(n.title?.split(" · ")[0]);
}

/** The main window's route for a ticket (the same one harness://ticket/<key> takes). */
export const ticketRoute = (key: string) => `#/board/all/ticket/${encodeURIComponent(key)}`;

/** Developer ID builds talk to production APNs; HARNESS_APNS_ENVIRONMENT=sandbox for a development-signed build. */
export const apnsEnvironment = (env: Record<string, string | undefined>): ApnsEnvironment => (env.HARNESS_APNS_ENVIRONMENT === "sandbox" ? "sandbox" : "production");

export interface PushDeps {
  /** pushNotifications.registerForAPNSNotifications(): the hex device token */
  token: () => Promise<string>;
  /** POST /devices on `conn` */
  register: (conn: { baseUrl: string; token: string }, body: RegisterDeviceBody) => Promise<unknown>;
  deviceId: string;
  name: () => Promise<string>;
  environment: ApnsEnvironment;
  log?: (message: string) => void;
}

/**
 * Keeps this Mac registered with the service it's connected to. `sync(conn)` registers once per
 * connection, token and name; it's called at launch and whenever the connection changes, and
 * again (with the same connection) to pick up a token APNs changed. Failures (an unsigned build
 * has no push entitlement, a service without /devices) are logged, never thrown, and the next
 * sync tries again.
 */
export class PushRegistrar {
  private done = "";
  private running: Promise<void> | null = null;
  private again: ConnectionResult | null = null;

  constructor(private deps: PushDeps) {}

  sync(conn: ConnectionResult): Promise<void> {
    if (this.running) {
      // One at a time; the latest connection wins once the current one settles.
      this.again = conn;
      return this.running;
    }
    this.running = this.run(conn).finally(() => {
      this.running = null;
      const next = this.again;
      this.again = null;
      if (next) void this.sync(next);
    });
    return this.running;
  }

  private async run(conn: ConnectionResult) {
    if ("error" in conn) return;
    const log = this.deps.log ?? ((m: string) => console.warn(m));
    let apnsToken: string;
    try {
      apnsToken = await this.deps.token();
    } catch (e) {
      return log(`push: APNs registration failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const name = await this.deps.name().catch(() => "Mac");
    const body: RegisterDeviceBody = { id: this.deps.deviceId, platform: "mac", name, apnsToken, environment: this.deps.environment };
    const sig = JSON.stringify([conn.baseUrl, conn.token, body]);
    if (sig === this.done) return;
    try {
      await this.deps.register(conn, body);
      this.done = sig;
    } catch (e) {
      log(`push: couldn't register this Mac with the service: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
