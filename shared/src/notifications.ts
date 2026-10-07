// System notifications for card activity (DESIGN.md "Notifications"): which activity kinds
// notify, the settings that switch them, and the device and presence shapes clients send.

import type { ActivityAuthor, ActivityEntry, ActivityKind, ActivityMeta } from "./protocol";

/** The switchable groups of activity. Every ActivityKind belongs to exactly one. */
export const NOTIFICATION_CATEGORIES = ["status", "review", "notes", "spec", "other"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Settings → Notifications: the label and description of each category. */
export const NOTIFICATION_CATEGORY_INFO: Record<NotificationCategory, { label: string; description: string }> = {
  status: { label: "Status changes", description: "Moves between columns, submitted for review, blocked, unblocked and reopened" },
  review: { label: "Review decisions", description: "Approvals and requested changes by an agent or a conductor" },
  notes: { label: "Agent notes", description: "Progress notes an agent posts to a ticket" },
  spec: { label: "Spec revisions", description: "An agent revised a ticket's spec" },
  other: { label: "Other", description: "Failed runs, tool approvals and other service entries" },
};

/** Which category each activity kind notifies under. A Record, so a new kind fails the typecheck until it's mapped. */
export const ACTIVITY_CATEGORY: Record<ActivityKind, NotificationCategory> = {
  moved: "status",
  blocked: "status",
  unblocked: "status",
  reopened: "status",
  submitted: "status",
  review_approved: "review",
  changes_requested: "review",
  approved: "review",
  note: "notes",
  spec_revised: "spec",
  message: "other",
  answer: "other",
  failed: "other",
  permission: "other",
  system: "other",
};

export interface NotificationSettings {
  /** Master switch: false sends nothing. */
  enabled: boolean;
  /** One switch per category; a missing one counts as on. */
  categories: Record<NotificationCategory, boolean>;
  /**
   * Folder holding the APNs token-auth keys, named `AuthKey_<keyId>_APN_Sandbox.p8` and
   * `AuthKey_<keyId>_APN_Production.p8`. null → `~/.appstoreconnect/private_keys`.
   */
  apnsKeyDir: string | null;
  /** The Apple developer team that owns the keys (the JWT issuer). */
  apnsTeamId: string;
}

/** PATCH /settings `notifications`: any of the fields, merged over the stored block (categories per category). */
export type NotificationSettingsPatch = Partial<Omit<NotificationSettings, "categories">> & {
  categories?: Partial<NotificationSettings["categories"]>;
};

export const DEFAULT_APNS_TEAM_ID = "47P4ZSALX4";
/** The APNs topic every device uses: the Mac and iPhone/iPad apps share this bundle ID. */
export const APNS_TOPIC = "com.markhuot.harness";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  categories: { status: true, review: true, notes: true, spec: true, other: true },
  apnsKeyDir: null,
  apnsTeamId: DEFAULT_APNS_TEAM_ID,
};

/** "sandbox" for development builds, "production" for TestFlight and Developer ID builds. */
export type ApnsEnvironment = "sandbox" | "production";
export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ["sandbox", "production"];
export type DevicePlatform = "mac" | "ios";

/** A device registered for pushes (GET /devices). The APNs token itself isn't sent back. */
export interface Device {
  /** Stable per-install UUID the client picks */
  id: string;
  platform: DevicePlatform;
  /** Shown in Settings, e.g. "Mark's iPhone" */
  name: string;
  topic: string;
  environment: ApnsEnvironment;
  /** Last 8 characters of the token, to tell registrations apart */
  tokenSuffix: string;
  createdAt: number;
  lastSeen: number;
}

/** POST /devices: register a device, or update its token, name or environment. */
export interface RegisterDeviceBody {
  id: string;
  platform: DevicePlatform;
  name: string;
  /** Hex APNs device token */
  apnsToken: string;
  environment: ApnsEnvironment;
  /** Defaults to APNS_TOPIC */
  topic?: string;
}

/** One environment's signing key, as GET /notifications reports it. */
export interface ApnsKeyStatus {
  environment: ApnsEnvironment;
  /** The key id from the file name, or null when no key was found */
  keyId: string | null;
  path: string | null;
  /** The last push sent with this key: when, and Apple's answer (null before the first) */
  lastResult: { at: number; ok: boolean; status: number; reason: string | null } | null;
}

/** GET /notifications: what the service can send and to whom. */
export interface NotificationStatus {
  keyDir: string;
  keys: ApnsKeyStatus[];
  devices: Device[];
}

/** POST /notifications/test: how many devices it went to, and per-device results. */
export interface TestNotificationResult {
  sent: number;
  results: { deviceId: string; ok: boolean; status: number; reason: string | null }[];
}

/**
 * WebSocket `presence` (client → service): what this socket shows. Each Mac window and each iOS
 * scene connection sends its own. `tickets` lists every ticket key on screen: the cards on the
 * board it shows and its open ticket panes, sheets or windows. `visible` is false while it's
 * hidden (minimized, covered, app hidden, iOS in the background); a hidden presence suppresses
 * nothing. Sent again whenever any of it changes, and after each reconnect.
 */
export interface Presence {
  deviceId: string;
  platform: DevicePlatform;
  visible: boolean;
  tickets: string[];
}

/** The custom key in the APNs payload that carries the ticket key, for the tap's deep link. */
export const PUSH_TICKET_KEY = "ticketKey";

/** Who wrote an entry, for the notification's subtitle. */
export function activityAuthorLabel(author: ActivityAuthor, meta: Pick<ActivityMeta, "by">): string {
  if (meta.by === "conductor") return "Conductor";
  return author === "agent" ? "Agent" : author === "human" ? "You" : "System";
}

const KIND_LABEL: Record<ActivityKind, string> = {
  note: "Note",
  submitted: "Submitted for review",
  spec_revised: "Spec revised",
  blocked: "Blocked",
  unblocked: "Unblocked",
  review_approved: "Review approved",
  changes_requested: "Changes requested",
  approved: "Approved",
  message: "Message",
  answer: "Answer",
  reopened: "Reopened",
  moved: "Moved",
  failed: "Run failed",
  permission: "Tool approval",
  system: "Service",
};

const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

/** The alert APNs shows for one activity entry. */
export function notificationAlert(entry: Pick<ActivityEntry, "kind" | "author" | "body" | "meta">, ticket: { key: string; title: string }) {
  const moved = entry.kind === "moved" && entry.meta.to ? `Moved to ${STATUS_LABEL[entry.meta.to] ?? entry.meta.to}` : null;
  const kind = moved ?? KIND_LABEL[entry.kind];
  const body = entry.body.trim() || entry.meta.question?.trim() || kind;
  return {
    title: `${ticket.key} · ${ticket.title}`,
    subtitle: `${activityAuthorLabel(entry.author, entry.meta)} · ${kind}`,
    body,
  };
}
