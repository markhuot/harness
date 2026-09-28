// Board tools (write): work and conductor runs change other cards the way a person does on the
// board: create, edit, move and reorder, start, message, cancel and re-open. The orchestrator
// enforces the guard rails (never the caller's own ticket, no way around a review or a tool
// approval); see DESIGN.md "Board changes by agents".

import { PERMISSION_MODES, TICKET_STATUSES, type PermissionMode, type TicketStatus } from "@harness/shared";
import { defineTool, json, schema, ticketView } from "./util";

const keyProp = { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\". Never your own ticket." };
const depsProp = { type: "array", items: { type: "string" }, description: "Keys of tickets that must be done before this one starts." };
const driverProp = { type: "string", minLength: 1, description: "Driver id, e.g. \"claude-code\". Defaults to the project's (a conductor's children: the conductor's)." };
const modelProp = { type: "string", description: "Model id for that driver. An empty string uses the driver's default." };

const modelInput = (m: string | undefined) => (m === undefined ? undefined : m.trim() || null);

export const createTicket = defineTool<{
  title: string;
  description: string;
  project_key?: string;
  depends_on?: string[];
  start?: boolean;
  auto_start?: boolean;
  conductor?: boolean;
  driver?: string;
  model?: string;
}>({
  name: "create_ticket",
  description:
    "Create a ticket. In a conductor run it is a child of this conductor (it starts on its own once its depends_on are done unless auto_start is false). In a work run it is a new top-level ticket in this project (or project_key) that lands in planning, where an agent drafts a plan for a human, unless start is true. Another agent does the work, so the description must be a self-contained brief: goal, relevant files or context, acceptance criteria. Returns the new ticket's key; pass keys from earlier create_ticket calls in depends_on to order work.",
  inputSchema: schema(
    {
      title: { type: "string", minLength: 1, description: "Short ticket title." },
      description: { type: "string", minLength: 1, description: "Self-contained brief for the agent that will do the work." },
      project_key: { type: "string", minLength: 1, description: "Project key (see list_projects). Defaults to this ticket's project." },
      depends_on: depsProp,
      start: { type: "boolean", description: "Start work now (or as soon as depends_on are done) instead of planning. Default false." },
      auto_start: { type: "boolean", description: "Start automatically once dependencies are done. Default true for a conductor's children, false otherwise." },
      conductor: { type: "boolean", description: "Make it a conductor ticket that splits its goal into children. Default false." },
      driver: driverProp,
      model: modelProp,
    },
    ["title", "description"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.createTicket(ctx, {
      title: input.title,
      description: input.description,
      projectKey: input.project_key,
      dependsOn: input.depends_on,
      start: input.start,
      autoStart: input.auto_start,
      conductor: input.conductor,
      driver: input.driver,
      model: modelInput(input.model),
    });
    return `Created ${ticket.key}.\n${json(ticketView(ticket))}`;
  },
});

export const updateTicket = defineTool<{
  key: string;
  title?: string;
  description?: string;
  driver?: string;
  model?: string;
  permission_mode?: PermissionMode | "inherit";
  depends_on?: string[];
}>({
  name: "update_ticket",
  description:
    "Edit another ticket's card, like a person editing it in the app: title, description (its brief or plan), driver, model, permission mode or dependencies. Only the fields you pass change; depends_on replaces the whole list. A permission mode can be made stricter (auto → ask → read_only) but never looser. Use move_ticket to change its column.",
  inputSchema: schema(
    {
      key: keyProp,
      title: { type: "string", minLength: 1, description: "New title." },
      description: { type: "string", description: "New description (replaces it)." },
      driver: driverProp,
      model: modelProp,
      permission_mode: { type: "string", enum: [...PERMISSION_MODES, "inherit"], description: "\"inherit\" uses the project's mode." },
      depends_on: depsProp,
    },
    ["key"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.updateTicket(ctx, input.key, {
      title: input.title,
      description: input.description,
      driver: input.driver,
      model: modelInput(input.model),
      permissionMode: input.permission_mode === undefined ? undefined : input.permission_mode === "inherit" ? null : input.permission_mode,
      dependsOn: input.depends_on,
    });
    return `Updated ${ticket.key}.\n${json({ ...ticketView(ticket), driver: ticket.driver, model: ticket.model, permissionMode: ticket.permissionMode })}`;
  },
});

export const moveTicket = defineTool<{ key: string; status: TicketStatus; position?: number }>({
  name: "move_ticket",
  description:
    "Move another ticket to a column, or reorder it within one, exactly like dragging its card. Moving to in_progress starts its work (re-opens it when done); moving to planning or blocked pauses it for a human. You can't move a ticket into or out of review (its own agent submits it, reviewers decide), move one to done unless it's still in planning (closing a ticket that isn't needed), or move one waiting on a tool approval. position is the 0-based slot in the target column (0 = top); omit it to keep the card's place.",
  inputSchema: schema(
    {
      key: keyProp,
      status: { type: "string", enum: [...TICKET_STATUSES], description: "Target column. Pass the current one with position to reorder." },
      position: { type: "integer", minimum: 0, description: "0-based slot in the target column." },
    },
    ["key", "status"],
  ),
  async run({ key, status, position }, ctx) {
    const ticket = await ctx.ops.moveTicket(ctx, key, status, position);
    return `Moved ${ticket.key} (status: ${ticket.status}).`;
  },
});

export const startTicket = defineTool<{ key: string }>({
  name: "start_ticket",
  description:
    "Start work on a ticket in planning or blocked (for example one created with auto_start false, or to start one before its dependencies finish), as if a person pressed Start.",
  inputSchema: schema({ key: keyProp }, ["key"]),
  async run({ key }, ctx) {
    const ticket = await ctx.ops.startTicket(ctx, key);
    return `Started ${ticket.key} (status: ${ticket.status}).`;
  },
});

export const messageTicket = defineTool<{ key: string; text: string }>({
  name: "message_ticket",
  description:
    "Send a message to the agent working on another ticket, as if a human had written it: answer a blocked ticket's question, give extra direction, or correct course. A blocked ticket resumes work and a done one re-opens when messaged. Tickets waiting on a tool approval can't be messaged (only a human answers approvals), and neither can tickets in review unless you are their conductor.",
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

export const cancelTicket = defineTool<{ key: string }>({
  name: "cancel_ticket",
  description: "Stop another ticket's agent: aborts its active run and drops its queued runs. The ticket stays in its column; message or start it to resume.",
  inputSchema: schema({ key: keyProp }, ["key"]),
  async run({ key }, ctx) {
    const ticket = await ctx.ops.cancelTicket(ctx, key);
    return `Cancelled ${ticket.key}'s runs (status: ${ticket.status}).`;
  },
});

export const reopenTicket = defineTool<{ key: string; notes: string }>({
  name: "reopen_ticket",
  description:
    "Send a done ticket back to in progress with notes for its agent (what's wrong or what's missing). Both of its reviews start over.",
  inputSchema: schema(
    {
      key: keyProp,
      notes: { type: "string", minLength: 1, description: "What the ticket's agent should change." },
    },
    ["key", "notes"],
  ),
  async run({ key, notes }, ctx) {
    const ticket = await ctx.ops.reopenTicket(ctx, key, notes);
    return `Re-opened ${ticket.key} (status: ${ticket.status}).`;
  },
});
