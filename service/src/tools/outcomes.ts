// A chief of staff's per-event account of a wake (DESIGN.md "Events"): what the Inbox shows for an event it was woken for.

import { COS_OUTCOME_KINDS } from "@harness/shared";
import { defineTool, schema } from "./util";

export const recordEventOutcomes = defineTool<{ outcomes: { event_id: string; kind: string; text: string }[] }>({
  name: "record_event_outcomes",
  description:
    'Record what you did about each event of this wake, in one call, before you finish: the Inbox shows it next to the event. kind is "acted" (text says what you did), "no_action" (text says why nothing was needed) or "needs_user" (text says what the user must do). One entry per event id listed in the wake, text a plain sentence or two. Write it for the user to read in the Inbox; it is not a message to them. Each entry is checked alone: one that names an event that isn\'t part of this wake is refused and the rest are saved. An event you record nothing for shows as "Reviewed, no outcome recorded".',
  inputSchema: schema(
    {
      outcomes: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            event_id: { type: "string", minLength: 1, description: "The event's id, as listed in the wake." },
            kind: { type: "string", enum: [...COS_OUTCOME_KINDS] },
            text: { type: "string", minLength: 1, description: "What you did, why nothing was needed, or what the user must do." },
          },
          required: ["event_id", "kind", "text"],
          additionalProperties: false,
        },
      },
    },
    ["outcomes"],
  ),
  async run({ outcomes }, ctx) {
    const results = await ctx.ops.recordEventOutcomes(ctx, outcomes.map((o) => ({ eventId: o.event_id, kind: o.kind, text: o.text })));
    const refused = results.filter((r) => r.error);
    const saved = results.length - refused.length;
    return [`Recorded ${saved} of ${results.length} outcome${results.length === 1 ? "" : "s"}.`, ...refused.map((r) => `- ${r.eventId}: ${r.error}`)].join("\n");
  },
});

export const outcomeTools = [recordEventOutcomes];
