// Subscription tools: a work, conductor or chief of staff run asks to be woken when another ticket changes,
// instead of waiting with a shell sleep. See DESIGN.md "Ticket subscriptions".

import { SUBSCRIPTION_EVENTS } from "../store/subscriptions";
import { defineTool, json, schema } from "./util";

export const subscribeTicket = defineTool<{ key: string; mode?: "once" | "forever"; events?: ("status" | "note" | "spec")[] }>({
  name: "subscribe_ticket",
  description:
    "Get woken when another ticket changes, instead of waiting or polling. After subscribing, finish what you can and end your turn (or keep working): Harness delivers a message to you when the ticket changes, into your run if it is still going, otherwise as a new run. Never wait with a shell sleep. mode \"once\" (default) wakes you for the first change and then drops the subscription; \"forever\" keeps waking you until you unsubscribe or your ticket leaves in progress. events picks what counts: \"status\" (moves between columns, review approvals; the default), \"note\" (progress notes) and \"spec\" (spec revisions). Your children's status changes already wake you without a subscription. Changes you cause yourself don't wake you, and a ticket subscribed to others isn't auto-submitted when you end your turn: call submit_for_review when you are done. Subscribing again to the same ticket replaces the earlier subscription.",
  inputSchema: schema(
    {
      key: { type: "string", minLength: 1, description: 'Key of the ticket to follow, e.g. "NYTIMES-12". Never your own ticket.' },
      mode: { type: "string", enum: ["once", "forever"], description: 'Default "once".' },
      events: { type: "array", items: { type: "string", enum: [...SUBSCRIPTION_EVENTS] }, description: 'Default ["status"].' },
    },
    ["key"],
  ),
  async run({ key, mode, events }, ctx) {
    const sub = ctx.ops.subscribeTicket(ctx, key, mode ?? "once", events);
    return `Subscribed to ${sub.key} (${sub.mode}, events: ${sub.events.join(", ")}). You'll be woken when it changes; don't wait with sleep.`;
  },
});

export const unsubscribeTicket = defineTool<{ key: string }>({
  name: "unsubscribe_ticket",
  description: "Stop being woken by another ticket's changes (see subscribe_ticket).",
  inputSchema: schema({ key: { type: "string", minLength: 1, description: "Key of the ticket you subscribed to." } }, ["key"]),
  async run({ key }, ctx) {
    return ctx.ops.unsubscribeTicket(ctx, key) ? `Unsubscribed from ${key}.` : `You weren't subscribed to ${key}.`;
  },
});

export const listSubscriptions = defineTool<Record<string, never>>({
  name: "list_subscriptions",
  description: "List the tickets you are subscribed to, with each one's mode, events and current status.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const subs = ctx.ops.listSubscriptions(ctx);
    return subs.length ? json(subs) : "You have no subscriptions.";
  },
});
