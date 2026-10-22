// The chiefs of staff in the world: one for All projects, one for the Work group and its Inbox and
// chat. Mac renders only (the iPhone world.json has no chiefs until its own Inbox lands), so these
// are not part of `world`.

import type { Cos, CosChatEntry, CosEvent } from "@harness/shared";
import { minutesAgo } from "./time";

export const chiefs: Cos[] = [
  { ticketId: "cos-all", key: "COS-1", scope: "all", groupId: null, enabled: true, createdAt: minutesAgo(60 * 24 * 7) },
  { ticketId: "cos-work", key: "COS-2", scope: "group:group-work", groupId: "group-work", enabled: true, createdAt: minutesAgo(60 * 24 * 3) },
];

const event = (id: string, patch: Partial<CosEvent>): CosEvent => ({
  id,
  cosId: "cos-all",
  projectKey: "HARNESS",
  sourceKind: "activity",
  title: id,
  summary: "",
  actor: "agent",
  status: "pending",
  verdict: "pending",
  reason: null,
  model: null,
  ticketKey: null,
  wakeId: null,
  handledBy: null,
  createdAt: minutesAgo(10),
  ...patch,
});

/** An Inbox with every state: waiting, ignored (with its reason), escalated, handling and handled, a watcher item and a schedule. */
export const cosEvents: CosEvent[] = [
  event("ev-waiting", { title: "HARNESS-201 moved to in progress", ticketKey: "HARNESS-201", createdAt: minutesAgo(1) }),
  event("ev-handling", { title: "HARNESS-202 is blocked", summary: "Needs a decision on the migration order", ticketKey: "HARNESS-202", status: "handling", verdict: "escalate", reason: "A blocked ticket waiting on the human", model: "claude-haiku-5-5", wakeId: "wake-2", createdAt: minutesAgo(4) }),
  event("ev-ignored", { title: "HARNESS-203 moved to review", summary: "An agent finished its work", ticketKey: "HARNESS-203", status: "ignored", verdict: "ignore", reason: "Routine move; the agent review is already running", model: "claude-haiku-5-5", createdAt: minutesAgo(12) }),
  event("ev-escalated", { title: "New comment on FOO-17", sourceKind: "watcher", actor: "watcher:jira", projectKey: null, status: "escalated", verdict: "escalate", reason: "A customer is waiting on an answer", model: "claude-haiku-5-5", createdAt: minutesAgo(20) }),
  event("ev-handled", { title: "HARNESS-190 landed on main", ticketKey: "HARNESS-190", status: "handled", verdict: "escalate", reason: "Done tickets are worth a summary", model: "claude-haiku-5-5", wakeId: "wake-1", handledBy: "run-9", createdAt: minutesAgo(90) }),
  event("ev-schedule", { title: "Friday review of open tickets", sourceKind: "schedule", actor: "system", projectKey: null, status: "handled", verdict: "escalate", reason: "A schedule the chief set", wakeId: "wake-1", handledBy: "run-9", createdAt: minutesAgo(100) }),
];

const m = (id: string, minutes: number, role: "user" | "assistant", text: string): CosChatEntry => ({ id, cosId: "cos-all", createdAt: minutesAgo(minutes), kind: "message", role, text });

/** A short conversation: a question, an answer, a ticket the chief made and moved, and a wake. */
export const cosChat: CosChatEntry[] = [
  m("chat-1", 200, "user", "What did the agents get done yesterday?"),
  m("chat-2", 199, "assistant", "Three tickets landed on **HARNESS**: the sidebar counts, the palette fix and the settings reorder. One is still in review."),
  { id: "chat-3", cosId: "cos-all", createdAt: minutesAgo(120), kind: "ticket_created", key: "HARNESS-204", title: "Follow up on the flaky palette test", status: "planning" },
  { id: "chat-4", cosId: "cos-all", createdAt: minutesAgo(30), kind: "ticket_moved", key: "HARNESS-203", title: "Reorder the settings sections", from: "in_progress", to: "review" },
  { id: "chat-5", cosId: "cos-all", createdAt: minutesAgo(5), kind: "event_batch", wakeId: "wake-2", eventIds: ["ev-handling"], digest: "ignored 3 routine moves" },
  m("chat-6", 4, "assistant", "HARNESS-202 is blocked on a decision about the migration order. I can answer it the way you did last week if you'd like."),
];
