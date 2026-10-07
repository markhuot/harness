// System notifications for card activity (DESIGN.md "Notifications"). Every activity entry is
// checked once, when it's written: it notifies unless a human wrote it, Settings turns its category
// off, it's quiet activity on a conductor's child, or a visible client has the ticket on screen.
// A notification goes to APNs once per registered device; Apple delivers it, and each device's
// own settings decide how it shows.

import {
  ACTIVITY_CATEGORY,
  APNS_ENVIRONMENTS,
  APNS_TOPIC,
  DEFAULT_NOTIFICATION_SETTINGS,
  PUSH_TICKET_KEY,
  notificationAlert,
  type ActivityEntry,
  type ApnsEnvironment,
  type ApnsKeyStatus,
  type Device,
  type DevicePlatform,
  type NotificationSettings,
  type NotificationStatus,
  type RegisterDeviceBody,
  type TestNotificationResult,
  type Ticket,
} from "@harness/shared";
import type { EventBus } from "../events";
import type { Store } from "../store";
import { publicDevice, type DeviceRecord } from "../store/devices";
import { badRequest, notFound } from "../orchestrator/errors";
import { DEFAULT_APNS_KEY_DIR, findApnsKeys, isDeadToken, type ApnsClient, type ApnsResult } from "./apns";
import type { PresenceRegistry } from "./presence";

/** Why an entry doesn't notify, or null when it does. */
export type SkipReason = "no_ticket" | "human" | "disabled" | "category" | "conductor_child" | "on_screen";

/** A conductor's child notifies only when it moves to blocked; its conductor handles the rest. */
export function isMoveToBlocked(entry: Pick<ActivityEntry, "kind" | "meta">): boolean {
  return entry.kind === "blocked" || (entry.kind === "moved" && entry.meta.to === "blocked");
}

/** The decision for one entry, without side effects. */
export function skipReason(
  entry: Pick<ActivityEntry, "kind" | "author" | "meta">,
  ticket: Pick<Ticket, "key" | "parentId"> | null,
  settings: NotificationSettings,
  onScreen: (key: string) => boolean,
): SkipReason | null {
  if (!ticket) return "no_ticket";
  if (entry.author === "human") return "human";
  if (!settings.enabled) return "disabled";
  if (settings.categories[ACTIVITY_CATEGORY[entry.kind]] === false) return "category";
  if (ticket.parentId && !isMoveToBlocked(entry)) return "conductor_child";
  if (onScreen(ticket.key)) return "on_screen";
  return null;
}

/** The APNs payload for one entry: the alert, grouped per ticket, and the ticket key for the deep link. */
export function pushPayload(entry: Pick<ActivityEntry, "kind" | "author" | "body" | "meta">, ticket: Pick<Ticket, "key" | "title">) {
  const alert = notificationAlert(entry, ticket);
  return {
    aps: {
      alert: { title: clip(alert.title, 180), subtitle: clip(alert.subtitle, 120), body: clip(alert.body, 1000) },
      "thread-id": ticket.key,
      sound: "default",
    },
    [PUSH_TICKET_KEY]: ticket.key,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const HEX_TOKEN = /^[0-9a-f]{32,400}$/i;
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Validate a POST /devices body. */
export function validateDeviceBody(body: unknown): RegisterDeviceBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("device body must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !DEVICE_ID.test(b.id)) throw badRequest("id must be the device's install id (letters, digits, _ . : -)");
  if (b.platform !== "mac" && b.platform !== "ios") throw badRequest("platform must be mac or ios");
  if (typeof b.apnsToken !== "string" || !HEX_TOKEN.test(b.apnsToken.trim())) throw badRequest("apnsToken must be the hex APNs device token");
  if (!(APNS_ENVIRONMENTS as readonly unknown[]).includes(b.environment)) throw badRequest("environment must be sandbox or production");
  if (b.name !== undefined && typeof b.name !== "string") throw badRequest("name must be a string");
  if (b.topic !== undefined && (typeof b.topic !== "string" || !/^[A-Za-z0-9.-]{1,200}$/.test(b.topic))) throw badRequest("topic must be a bundle id");
  return {
    id: b.id,
    platform: b.platform as DevicePlatform,
    name: ((b.name as string | undefined) ?? "").trim().slice(0, 100) || (b.platform === "mac" ? "Mac" : "iPhone"),
    apnsToken: b.apnsToken.trim().toLowerCase(),
    environment: b.environment as ApnsEnvironment,
    topic: (b.topic as string | undefined) ?? APNS_TOPIC,
  };
}

export interface NotificationServiceOptions {
  store: Store;
  bus: EventBus;
  settings: () => NotificationSettings | undefined;
  presence: PresenceRegistry;
  apns: Pick<ApnsClient, "send" | "close">;
  log?: (msg: string) => void;
}

export class NotificationService {
  private off: (() => void) | null = null;
  private pending = new Set<Promise<unknown>>();
  private lastResult = new Map<ApnsEnvironment, ApnsKeyStatus["lastResult"]>();

  constructor(private opts: NotificationServiceOptions) {}

  private get settings(): NotificationSettings {
    return this.opts.settings() ?? DEFAULT_NOTIFICATION_SETTINGS;
  }

  private keyDir(): string {
    return this.settings.apnsKeyDir || DEFAULT_APNS_KEY_DIR;
  }

  start() {
    this.off ??= this.opts.bus.onKind("activity.added", (e) => this.onActivity(e.entry));
  }

  stop() {
    this.off?.();
    this.off = null;
    this.opts.apns.close();
  }

  /** Wait for the pushes already started (tests). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Decide at write time; a notification that's gone out is never taken back. */
  onActivity(entry: ActivityEntry) {
    const ticket = entry.ticketId ? this.opts.store.tickets.get(entry.ticketId) : null;
    if (skipReason(entry, ticket, this.settings, (key) => this.opts.presence.isOnScreen(key))) return;
    this.track(this.deliver(pushPayload(entry, ticket!)));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** Send one payload to every registered device. Devices whose environment has no key are skipped. */
  private async deliver(payload: unknown): Promise<TestNotificationResult> {
    const devices = this.opts.store.devices.list();
    const keys = findApnsKeys(this.keyDir());
    const teamId = this.settings.apnsTeamId;
    const results: TestNotificationResult["results"] = [];
    let removed = false;
    await Promise.all(
      devices.map(async (d) => {
        const key = keys[d.environment];
        if (!key) {
          results.push({ deviceId: d.id, ok: false, status: 0, reason: `No ${d.environment} APNs key in ${this.keyDir()}` });
          return;
        }
        let r: ApnsResult;
        try {
          r = await this.opts.apns.send(key, teamId, { environment: d.environment, deviceToken: d.apnsToken, topic: d.topic, payload });
        } catch (err) {
          r = { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err) };
        }
        this.lastResult.set(d.environment, { at: Date.now(), ok: r.ok, status: r.status, reason: r.reason });
        results.push({ deviceId: d.id, ...r });
        if (r.ok) return;
        this.opts.log?.(`notifications: push to ${d.name} (${d.environment}) failed: ${r.status} ${r.reason ?? ""}`.trim());
        if (isDeadToken(r) && this.opts.store.devices.deleteByToken(d.apnsToken)) removed = true;
      }),
    );
    if (removed) this.opts.bus.emit({ kind: "devices.changed" });
    return { sent: results.filter((r) => r.ok).length, results };
  }

  status(): NotificationStatus {
    const dir = this.keyDir();
    const keys = findApnsKeys(dir);
    return {
      keyDir: dir,
      keys: APNS_ENVIRONMENTS.map((environment) => ({
        environment,
        keyId: keys[environment]?.keyId ?? null,
        path: keys[environment]?.path ?? null,
        lastResult: this.lastResult.get(environment) ?? null,
      })),
      devices: this.opts.store.devices.list().map(publicDevice),
    };
  }

  devices(): Device[] {
    return this.opts.store.devices.list().map(publicDevice);
  }

  registerDevice(body: unknown): Device {
    const d = validateDeviceBody(body);
    const before = this.opts.store.devices.get(d.id);
    const saved = this.opts.store.devices.upsert({ ...d, topic: d.topic ?? APNS_TOPIC });
    if (!before || changed(before, saved)) this.opts.bus.emit({ kind: "devices.changed" });
    return publicDevice(saved);
  }

  removeDevice(id: string) {
    if (!this.opts.store.devices.delete(id)) throw notFound(`No device ${id}`);
    this.opts.bus.emit({ kind: "devices.changed" });
    return { ok: true as const };
  }

  /** Settings → Send test notification: to every device, ignoring the switches and presence. */
  sendTest(): Promise<TestNotificationResult> {
    return this.track(
      this.deliver({
        aps: { alert: { title: "Harness", subtitle: "Test notification", body: "Notifications from this Mac reach this device." }, sound: "default" },
      }),
    );
  }
}

function changed(a: DeviceRecord, b: DeviceRecord): boolean {
  return a.apnsToken !== b.apnsToken || a.name !== b.name || a.environment !== b.environment || a.platform !== b.platform || a.topic !== b.topic;
}
