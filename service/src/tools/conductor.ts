// Conductor tools: stand in for the human reviewer of child tickets and complete them
// (creating and steering tickets is in board-write.ts, reading the board in board.ts).

import { defineTool, json, schema, ticketView } from "./util";

const keyProp = { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\"." };

export const reviewTicket = defineTool<{ key: string; decision: "approve" | "request_changes"; notes: string }>({
  name: "review_ticket",
  description:
    "Act as the human reviewer for a child ticket that is in review. \"approve\" signs it off; \"request_changes\" sends it back to its agent with your notes. Check the ticket's summaries (get_ticket) before deciding.",
  inputSchema: schema(
    {
      key: keyProp,
      decision: { type: "string", enum: ["approve", "request_changes"], description: "Your verdict." },
      notes: { type: "string", description: "Rationale, or specific changes to make." },
    },
    ["key", "decision", "notes"],
  ),
  async run({ key, decision, notes }, ctx) {
    const ticket = await ctx.ops.reviewTicket(ctx, key, decision, notes);
    return `Review recorded for ${ticket.key}: ${decision}. Status: ${ticket.status}, agent review: ${ticket.agentReview}, human review: ${ticket.humanReview}.`;
  },
});

export const completeTicket = defineTool<{ key: string; instructions?: string }>({
  name: "complete_ticket",
  description:
    "Complete a child ticket whose agent and human reviews are both approved. Its agent runs a finalization step (for example merging its worktree branch) and the ticket moves to done, which may start tickets that depend on it.",
  inputSchema: schema(
    {
      key: keyProp,
      instructions: { type: "string", description: "Optional extra instructions for the finalization run, e.g. \"merge into main\"." },
    },
    ["key"],
  ),
  async run({ key, instructions }, ctx) {
    const ticket = await ctx.ops.completeTicket(ctx, key, instructions);
    return `Completing ${ticket.key} (status: ${ticket.status}).`;
  },
});
