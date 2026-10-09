// Board tools (write): work and conductor runs change other cards the way a person does on the
// board: create, edit, move and reorder, start, message, cancel and re-open. The orchestrator
// enforces the guard rails (never the caller's own ticket, no way around a tool approval); a plan
// run gets update_ticket for its own ticket only. See DESIGN.md "Board changes by agents".

import { PERMISSION_MODES, TICKET_STATUSES, type PermissionMode, type PhaseModelsPatch, type TicketStatus } from "@harness/shared";
import { defineTool, json, phaseModelsProp, schema, ticketView } from "./util";

const keyProp = { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\". Never your own ticket." };
const depsProp = { type: "array", items: { type: "string" }, description: "Keys of tickets that must be done before this one starts." };
const driverProp = { type: "string", minLength: 1, description: "Driver id, e.g. \"claude-code\", for its Planning, Work and Review runs. Defaults to the project's (a child: its parent's)." };
const modelProp = { type: "string", description: "Model id for that driver, for its Planning, Work and Review runs. An empty string uses the driver's default." };
const ticketPhaseModelsProp = phaseModelsProp("The ticket's own driver + model per run phase, applied after driver/model; a phase it doesn't choose inherits the project's, then the settings'.");

const baseBranchProp = {
  type: "string",
  description: "Branch its work merges into when it completes (and a new branch starts from). \"inherit\" or \"\" uses the project's base branch.",
};
const branchProp = {
  type: "string",
  description:
    "Branch for its worktree: an existing local branch is checked out as is (the ticket blocks if another worktree has it checked out); a new name is created from the base branch. \"\" means harness/<key>, the default.",
};

const skipAgentReviewProp = {
  type: "boolean",
  description:
    "Skip the agent review when its agent submits, so it waits only on the human (or you, for a child). With skip_human_review too, its work lands as soon as it's submitted: only when the human asked for that. Omitted on create: the project's default.",
};

const skipHumanReviewProp = {
  type: "boolean",
  description:
    "Skip the human review (yours, for a child), so the work lands as soon as its agent review approves it (or as soon as it's submitted, when it skips the agent review too). Only when the human asked for it. Omitted on create: the project's default.",
};

const remoteIdProp = {
  type: "string",
  description:
    "The external item's key this ticket is for (its remote ID), e.g. the Jira issue \"FOO-123\". The board shows it in place of the local key, but tools and links still take the local key.",
};
const remoteUrlProp = { type: "string", description: "Link to the external item, e.g. https://example.atlassian.net/browse/FOO-123." };

const modelInput = (m: string | undefined) => (m === undefined ? undefined : m.trim() || null);
/** "" → null (unlink / no link); undefined → unchanged. */
const remoteInput = (s: string | undefined) => (s === undefined ? undefined : s.trim() || null);
/** "inherit" / "" → null (inherit); undefined → unchanged. */
const baseBranchInput = (b: string | undefined) => (b === undefined ? undefined : b.trim() === "inherit" ? null : b.trim() || null);
const branchInput = (b: string | undefined) => (b === undefined ? undefined : b.trim() || null);

export const createTicket = defineTool<{
  title: string;
  spec: string;
  project_key?: string;
  depends_on?: string[];
  start?: boolean;
  auto_start?: boolean;
  conductor?: boolean;
  child?: boolean;
  driver?: string;
  model?: string;
  phase_models?: PhaseModelsPatch;
  use_worktree?: boolean;
  base_branch?: string;
  branch?: string;
  skip_agent_review?: boolean;
  skip_human_review?: boolean;
  remote_id?: string;
  remote_url?: string;
  attachments?: string[];
}>({
  name: "create_ticket",
  description:
    "Create a ticket. With child true (the default for a conductor ticket) it is a child of this ticket: it starts on its own once its depends_on are done unless auto_start is false, and this ticket becomes its conductor, reviewing it with review_ticket and finalizing it with complete_ticket. Otherwise it is a new top-level ticket in this project (or project_key) that lands in planning, where an agent drafts a plan for a human, unless start is true. Another agent does the work, so the spec must be self-contained: the goal, relevant files or context, and acceptance criteria. When the ticket is for an external item with a key (a Jira issue \"FOO-123\", say), pass it as remote_id and its link as remote_url. The new ticket's permission mode is never looser than this ticket's. Returns the new ticket's local key: use it, not the remote ID, in depends_on, in other tools and as the target of links to the ticket; pass keys from earlier create_ticket calls in depends_on to order work.",
  inputSchema: schema(
    {
      title: { type: "string", minLength: 1, description: "Short ticket title." },
      spec: { type: "string", minLength: 1, description: "The new ticket's spec in markdown: a self-contained brief for the agent that will do the work." },
      project_key: { type: "string", minLength: 1, description: "Project key (see list_projects). Defaults to this ticket's project." },
      depends_on: depsProp,
      start: { type: "boolean", description: "Start work now (or as soon as depends_on are done) instead of planning. Default false." },
      auto_start: { type: "boolean", description: "Start automatically once dependencies are done. Default true for a child, false otherwise." },
      conductor: { type: "boolean", description: "Make it a conductor ticket that splits its goal into children. Default false." },
      child: {
        type: "boolean",
        description: "Make it a child of this ticket, which then reviews and completes it like a conductor. Use it when the human asks for child tickets. Default true for a conductor ticket, false otherwise.",
      },
      driver: driverProp,
      model: modelProp,
      phase_models: ticketPhaseModelsProp,
      use_worktree: {
        type: "boolean",
        description:
          "Give the ticket its own git worktree and branch (true) or run it in the project directory (false). Omit to follow the project's setting, which is right almost always, a conductor's children included.",
      },
      base_branch: baseBranchProp,
      branch: branchProp,
      skip_agent_review: skipAgentReviewProp,
      skip_human_review: skipHumanReviewProp,
      remote_id: remoteIdProp,
      remote_url: remoteUrlProp,
      attachments: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 20,
        description:
          "Files to attach to the new ticket's first message, such as screenshots it should look at: paths (absolute, or relative to your working directory) that exist now. They're referenced where they are, not copied, so don't attach files you're about to delete. Images also go to its agent inline.",
      },
    },
    ["title", "spec"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.createTicket(ctx, {
      title: input.title,
      spec: input.spec,
      projectKey: input.project_key,
      dependsOn: input.depends_on,
      start: input.start,
      autoStart: input.auto_start,
      conductor: input.conductor,
      child: input.child,
      driver: input.driver,
      model: modelInput(input.model),
      phaseModels: input.phase_models,
      useWorktree: input.use_worktree,
      baseBranch: baseBranchInput(input.base_branch),
      branch: branchInput(input.branch),
      skipAgentReview: input.skip_agent_review,
      skipHumanReview: input.skip_human_review,
      remoteId: remoteInput(input.remote_id) ?? undefined,
      remoteUrl: remoteInput(input.remote_url),
      attachments: input.attachments,
    });
    return `Created ${ticket.key}.\n${json(ticketView(ticket))}`;
  },
});

export const updateTicket = defineTool<{
  key: string;
  title?: string;
  spec?: string;
  base_revision?: number;
  driver?: string;
  model?: string;
  phase_models?: PhaseModelsPatch;
  permission_mode?: PermissionMode | "inherit";
  depends_on?: string[];
  base_branch?: string;
  branch?: string;
  skip_agent_review?: boolean;
  skip_human_review?: boolean;
  remote_id?: string;
  remote_url?: string;
}>({
  name: "update_ticket",
  description:
    "Edit another ticket's card, like a person editing it in the app (in a planning run, your own ticket instead, and only yours: apply the settings the human asked for in the spec, with full access to every field): title, spec (a new revision of it; pass base_revision, the specRevision get_ticket showed, and a spec that changed since is refused so nobody's edit is overwritten), driver, model, permission mode, dependencies, base branch, branch, remote ID and its link, or whether it skips the agent or human review. Only the fields you pass change; depends_on replaces the whole list. key is always the ticket's local key, even when it carries a remote ID. remote_id links the ticket to an external item (\"\" unlinks it); remote_url alone changes the link of the remote ID it already carries (\"\" clears it). branch can only change before the ticket has a worktree; after that, ask its agent (message_ticket), which moves it with update_branch. On another ticket, a permission mode can be made stricter (auto → ask → read_only) but never looser, and a ticket whose mode is looser than yours can't be edited, except by a call that only tightens its permission_mode. Use move_ticket to change its column.",
  inputSchema: schema(
    {
      key: { ...keyProp, description: "Ticket key, e.g. \"NYTIMES-12\". Never your own ticket, except in a planning run, where it's only your own." },
      title: { type: "string", minLength: 1, description: "New title." },
      spec: { type: "string", description: "The ticket's whole new spec (a new revision; its history keeps the old one). Needs base_revision." },
      base_revision: { type: "integer", minimum: 1, description: "Required with spec: the specRevision get_ticket showed. If the spec changed since, the call fails with the current revision." },
      driver: driverProp,
      model: modelProp,
      phase_models: ticketPhaseModelsProp,
      permission_mode: { type: "string", enum: [...PERMISSION_MODES, "inherit"], description: "\"inherit\" uses the project's mode." },
      depends_on: depsProp,
      base_branch: baseBranchProp,
      branch: branchProp,
      skip_agent_review: skipAgentReviewProp,
      skip_human_review: skipHumanReviewProp,
      remote_id: { ...remoteIdProp, description: `${remoteIdProp.description} "" unlinks it.` },
      remote_url: { ...remoteUrlProp, description: `${remoteUrlProp.description} "" clears it.` },
    },
    ["key"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.updateTicket(ctx, input.key, {
      title: input.title,
      spec: input.spec,
      baseRevision: input.base_revision,
      driver: input.driver,
      model: modelInput(input.model),
      phaseModels: input.phase_models,
      permissionMode: input.permission_mode === undefined ? undefined : input.permission_mode === "inherit" ? null : input.permission_mode,
      dependsOn: input.depends_on,
      baseBranch: baseBranchInput(input.base_branch),
      branch: branchInput(input.branch),
      skipAgentReview: input.skip_agent_review,
      skipHumanReview: input.skip_human_review,
      remoteId: remoteInput(input.remote_id),
      remoteUrl: remoteInput(input.remote_url),
    });
    return `Updated ${ticket.key}.\n${json({ ...ticketView(ticket), driver: ticket.driver, model: ticket.model, phaseModels: ticket.phaseModels ?? {}, permissionMode: ticket.permissionMode })}`;
  },
});

export const moveTicket = defineTool<{ key: string; status: TicketStatus; position?: number }>({
  name: "move_ticket",
  description:
    "Move another ticket to a column, or reorder it within one. Moving to planning or blocked pauses it for a human. It never starts work: start_ticket does, and resume_work re-opens reviewed work. You can't move a ticket into or out of review or to in_progress, move one whose permission mode is looser than yours to planning (its own agent submits it, reviewers decide), move one to done unless it's still in planning (closing a ticket that isn't needed), or move one waiting on a tool approval. position is the 0-based slot in the target column (0 = top); omit it to keep the card's place.",
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
    "Start work on a ticket in planning or blocked (for example one created with auto_start false, or to start one before its dependencies finish), as if a person pressed Start. While the ticket's planning run is still going, this approves the plan instead: the ticket stays in planning and its work starts when the planning run ends.",
  inputSchema: schema({ key: keyProp }, ["key"]),
  async run({ key }, ctx) {
    const ticket = await ctx.ops.startTicket(ctx, key);
    return `Started ${ticket.key} (status: ${ticket.status}).`;
  },
});

export const messageTicket = defineTool<{ key: string; text: string }>({
  name: "message_ticket",
  description:
    "Send a message to the agent working on another ticket, as if a human had written it: answer a blocked ticket's question, give extra direction, or correct course. The ticket stays in its column: its agent moves it on itself (a blocked one unblocks once your message resolves its question; one in review goes back to in progress while its agent changes the work, then is submitted again). Tickets waiting on a tool approval can't be messaged (only a human answers approvals), nor can tickets whose permission mode is looser than yours.",
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
  description: "Stop another ticket's agent: aborts its active run and drops its queued runs. The ticket stays in its column; message or start it to resume. Refused for a ticket waiting on a tool approval.",
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
