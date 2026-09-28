// Conductor tools: create and steer child tickets (reading the board is in board.ts).

import { defineTool, json, schema, ticketView } from "./util";

const keyProp = { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\"." };

export const createTicket = defineTool<{ title: string; description: string; depends_on?: string[]; auto_start?: boolean }>({
  name: "create_ticket",
  description:
    "Create a child ticket for a sub-task of this conductor ticket. Another agent will do the work in the ticket, so the description must be a self-contained brief: goal, relevant files or context, acceptance criteria. Returns the new ticket's key. Use depends_on with keys returned by earlier create_ticket calls to order work; a child with auto_start (default true) starts as soon as all its dependencies are done.",
  inputSchema: schema(
    {
      title: { type: "string", minLength: 1, description: "Short ticket title." },
      description: { type: "string", minLength: 1, description: "Self-contained brief for the agent that will do the work." },
      depends_on: { type: "array", items: { type: "string" }, description: "Keys of tickets that must be done before this one starts." },
      auto_start: { type: "boolean", description: "Start automatically once dependencies are done. Default true." },
    },
    ["title", "description"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.createTicket(ctx, {
      title: input.title,
      description: input.description,
      dependsOn: input.depends_on,
      autoStart: input.auto_start,
    });
    return `Created ${ticket.key}.\n${json(ticketView(ticket))}`;
  },
});

export const startTicket = defineTool<{ key: string }>({
  name: "start_ticket",
  description: "Start work on a ticket that is still in planning (for children created with auto_start false, or to start one before its dependencies finish).",
  inputSchema: schema({ key: keyProp }, ["key"]),
  async run({ key }, ctx) {
    const ticket = await ctx.ops.startTicket(ctx, key);
    return `Started ${ticket.key} (status: ${ticket.status}).`;
  },
});

export const messageTicket = defineTool<{ key: string; text: string }>({
  name: "message_ticket",
  description:
    "Send a message to the agent working on a ticket, as if a human had written it: answer a blocked ticket's question, give extra direction, or correct course. A blocked ticket resumes work when messaged.",
  inputSchema: schema(
    {
      key: keyProp,
      text: { type: "string", minLength: 1, description: "The message for that ticket's agent." },
    },
    ["key", "text"],
  ),
  async run({ key, text }, ctx) {
    await ctx.ops.messageTicket(ctx, key, text);
    return `Message sent to ${key}.`;
  },
});

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
