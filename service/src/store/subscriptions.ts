import type { Database } from "bun:sqlite";
import { type Clock, systemClock } from "../clock";

export const SUBSCRIPTION_EVENTS = ["status", "note", "spec"] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];
export type SubscriptionMode = "once" | "forever";
/** The longest reason kept: a condition, not an essay. */
export const SUBSCRIPTION_REASON_MAX = 300;

export interface Subscription {
  subscriberId: string;
  targetId: string;
  mode: SubscriptionMode;
  events: SubscriptionEvent[];
  /** Why the subscriber follows the target, in its own words (required of a chief of staff); null when none was given */
  reason: string | null;
  createdAt: number;
}

interface SubscriptionRow {
  subscriber_id: string;
  target_id: string;
  mode: string;
  events: string;
  reason: string | null;
  created_at: number;
}

const toSubscription = (r: SubscriptionRow): Subscription => ({
  subscriberId: r.subscriber_id,
  targetId: r.target_id,
  mode: r.mode as SubscriptionMode,
  events: r.events.split(",").filter((e): e is SubscriptionEvent => (SUBSCRIPTION_EVENTS as readonly string[]).includes(e)),
  reason: r.reason,
  createdAt: r.created_at,
});

/** Ticket subscriptions (DESIGN.md "Ticket subscriptions"): who is woken when another ticket changes. */
export class SubscriptionRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  /** Subscribe `subscriberId` to `targetId`; a second call for the same pair replaces the first. */
  upsert(subscriberId: string, targetId: string, mode: SubscriptionMode, events: SubscriptionEvent[], reason: string | null = null): Subscription {
    this.db
      .query(
        `INSERT INTO ticket_subscriptions (subscriber_id, target_id, mode, events, reason, created_at) VALUES ($subscriberId, $targetId, $mode, $events, $reason, $t)
         ON CONFLICT (subscriber_id, target_id) DO UPDATE SET mode = $mode, events = $events, reason = $reason`,
      )
      .run({ subscriberId, targetId, mode, events: events.join(","), reason, t: this.now() });
    return this.get(subscriberId, targetId)!;
  }

  get(subscriberId: string, targetId: string): Subscription | null {
    const r = this.db.query("SELECT * FROM ticket_subscriptions WHERE subscriber_id = $subscriberId AND target_id = $targetId").get({ subscriberId, targetId }) as SubscriptionRow | null;
    return r ? toSubscription(r) : null;
  }

  listBySubscriber(subscriberId: string): Subscription[] {
    return (this.db.query("SELECT * FROM ticket_subscriptions WHERE subscriber_id = $subscriberId ORDER BY created_at, rowid").all({ subscriberId }) as SubscriptionRow[]).map(toSubscription);
  }

  listByTarget(targetId: string): Subscription[] {
    return (this.db.query("SELECT * FROM ticket_subscriptions WHERE target_id = $targetId ORDER BY created_at, rowid").all({ targetId }) as SubscriptionRow[]).map(toSubscription);
  }

  /** Whether a row was there to delete. */
  delete(subscriberId: string, targetId: string): boolean {
    return this.db.query("DELETE FROM ticket_subscriptions WHERE subscriber_id = $subscriberId AND target_id = $targetId").run({ subscriberId, targetId }).changes > 0;
  }

  deleteBySubscriber(subscriberId: string): void {
    this.db.query("DELETE FROM ticket_subscriptions WHERE subscriber_id = $subscriberId").run({ subscriberId });
  }

  deleteByTarget(targetId: string): void {
    this.db.query("DELETE FROM ticket_subscriptions WHERE target_id = $targetId").run({ targetId });
  }
}
