// Conductor tools: stand in for the human reviewer of child tickets and complete them
// (creating and steering tickets is in board-write.ts, reading the board in board.ts).

import type { CompletionAction } from "@harness/shared";
import { COMPLETION_ACTIONS } from "@harness/shared";
import { defineTool, json, schema, ticketView } from "./util";

const keyProp = { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\"." };

const actionProp = {
  type: "string",
  enum: [...COMPLETION_ACTIONS],
  description:
    "How the child's work lands when it completes: \"merge\" into its base branch, \"pr\" (push and open a GitHub pull request; only when its project offers it), \"cleanup\" (the work already landed: only remove its worktree and branch), or \"custom\" (follow `instructions`). A ticket working on its base branch can't merge or open a pull request. A child of a ticket with its own branch always merges into that branch. Omit for the choice made earlier, else its project's default.",
};

export const reviewTicket = defineTool<{ key: string; decision: "approve" | "request_changes"; notes: string; action?: CompletionAction }>({
  name: "review_ticket",
  description:
    "Act as the human reviewer for a child ticket that is in review. \"approve\" signs it off; \"request_changes\" sends it back to its agent with your notes. Check the ticket's summaries (get_ticket) before deciding.",
  inputSchema: schema(
    {
      key: keyProp,
      decision: { type: "string", enum: ["approve", "request_changes"], description: "Your verdict." },
      notes: { type: "string", description: "Rationale, or specific changes to make." },
      action: { ...actionProp, description: `With approve: ${actionProp.description}` },
    },
    ["key", "decision", "notes"],
  ),
  async run({ key, decision, notes, action }, ctx) {
    const ticket = await ctx.ops.reviewTicket(ctx, key, decision, notes, action);
    return `Review recorded for ${ticket.key}: ${decision}. Status: ${ticket.status}, agent review: ${ticket.agentReview}, human review: ${ticket.humanReview}.`;
  },
});

export const completeTicket = defineTool<{ key: string; instructions?: string; action?: CompletionAction }>({
  name: "complete_ticket",
  description:
    "Complete a child ticket whose agent and human reviews are both approved. Its agent runs a finalization step that lands the work (a child of a ticket with its own branch merges into that branch, so the whole goal stays on one branch) and the ticket moves to done, which may start tickets that depend on it.",
  inputSchema: schema(
    {
      key: keyProp,
      instructions: { type: "string", description: "Optional extra instructions for the finalization run." },
      action: actionProp,
    },
    ["key"],
  ),
  async run({ key, instructions, action }, ctx) {
    const ticket = await ctx.ops.completeTicket(ctx, key, instructions, action);
    return `Completing ${ticket.key} (status: ${ticket.status}).`;
  },
});
