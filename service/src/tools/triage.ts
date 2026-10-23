// The one tool only a triage run has: it records the verdict for an event (DESIGN.md "Events"). The
// run's other tools are the board reads, and Bash and the user's MCP servers under a read-only policy.

import { defineTool, schema } from "./util";

export const triageVerdict = defineTool<{ id?: string; verdict?: string; reason?: string; brief?: string; project?: string }>({
  name: "triage_verdict",
  description:
    "Record your verdict for one event: call it once per event id, as soon as you can tell. Always pass id, verdict and reason; a call without them is refused. Escalating wakes the chief of staff, ignoring lets the event pass. Reason: one short sentence for the person reading the Inbox. Brief (escalations only): one or two sentences for the chief on what you found, including the key of the ticket it belongs to when you found one. Project (escalations only, for an event with no project): the key of the project it belongs to.",
  inputSchema: schema(
    {
      id: { type: "string", description: "The event's id, exactly as listed." },
      verdict: { type: "string", enum: ["ignore", "escalate"] },
      reason: { type: "string", description: "One short sentence for the person reading the Inbox." },
      brief: { type: "string", description: "Escalations only: what you found, for the chief." },
      project: { type: "string", description: "Escalations only, for an event with no project: its key." },
    },
    ["id", "verdict", "reason"],
  ),
  async run(input, ctx) {
    return { content: [{ type: "text", text: ctx.ops.recordTriageVerdict(ctx, input) }] };
  },
});
