// Triage tools: route a watcher's output to a project, or decline it
// (list_projects is a board tool, see board.ts).

import { defineTool, schema } from "./util";

export const dispatchTicket = defineTool<{
  project_key: string;
  key?: string;
  ticket_key?: string;
  url?: string;
  title: string;
  spec: string;
  start?: boolean;
  conductor?: boolean;
  branch?: string;
  base_branch?: string;
}>({
  name: "dispatch_ticket",
  description:
    "Create a local ticket for the watcher output in the chosen project, or send an update to an existing one. When the output is about an item with a ticket-style key (e.g. \"FOO-123\"), pass it as key: that's the ticket's remote ID, shown on the board in place of its local key. Without ticket_key this always creates a new ticket with the project's next local key, linked to that remote ID, even when other tickets already carry it or a local ticket has the same key. To update an existing ticket instead, pass its local key as ticket_key: the spec text is posted to it as a message (a done ticket is re-opened with it, so its agent does the work in a fresh worktree and it goes through review again), and with key too, a ticket that has no remote ID yet is linked to it. The title also becomes the Inbox title. The spec is what the working agent receives as the ticket's spec (revision 1): restate the request with its link, the acceptance criteria and any context you gathered. Set start true to begin work immediately, false to leave it in planning. Set conductor true for large jobs that should be split into several child tickets. When the work belongs on a branch that already exists (the head branch of an open pull request, say), set branch and base_branch both to it: the agent commits there directly, and approving only cleans up, with nothing to merge.",
  inputSchema: schema(
    {
      project_key: { type: "string", minLength: 1, description: "Key prefix of the target project, as returned by list_projects." },
      key: { type: "string", description: "The external item's key (its remote ID), e.g. \"FOO-123\". Never picks an existing ticket by itself." },
      ticket_key: {
        type: "string",
        description: "Local key of an existing ticket to send this update to (from the Existing tickets list or search_tickets), e.g. \"WEB-12\". Leave it out to create a new ticket.",
      },
      url: { type: "string", description: "Link to the external item, when the output has one." },
      title: { type: "string", minLength: 1, description: "Ticket title." },
      spec: { type: "string", minLength: 1, description: "The ticket's spec for the agent that will do the work (or, with ticket_key, the message to that ticket's agent)." },
      start: { type: "boolean", description: "Start work immediately (default false: leave in planning)." },
      conductor: { type: "boolean", description: "Create a conductor ticket that splits the work into child tickets." },
      branch: {
        type: "string",
        description:
          "Branch the new ticket's worktree checks out: an existing branch as is (the ticket blocks if another worktree has it checked out), a new name created from the base branch. Leave it out for a branch of its own (harness/<key>).",
      },
      base_branch: { type: "string", description: "Branch the new ticket's work merges into when it completes. Leave it out for the project's base branch." },
    },
    ["project_key", "title", "spec"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.dispatchTicket(ctx, {
      projectKey: input.project_key,
      key: input.key,
      ticketKey: input.ticket_key,
      url: input.url,
      title: input.title,
      spec: input.spec,
      start: input.start,
      conductor: input.conductor,
      branch: input.branch?.trim() || undefined,
      baseBranch: input.base_branch?.trim() || undefined,
    });
    const what = input.ticket_key ? `Sent the update to ${ticket.key}` : `Dispatched as ${ticket.key}`;
    const remote = ticket.externalRef?.key && ticket.externalRef.key !== ticket.key ? `, remote ID ${ticket.externalRef.key}` : "";
    return `${what} (${ticket.kind}, status: ${ticket.status}${remote}). If the output holds other separate items that qualify, dispatch each of them; otherwise triage is done. Stop here.`;
  },
});

export const declineWork = defineTool<{ reason: string; title?: string }>({
  name: "decline_work",
  description:
    "Decline the watcher output: the user's prompt says to skip it, it isn't actionable, it doesn't map to any local project, or it is out of scope. The reason is shown to the human in the Inbox. Pass title to replace the Inbox title (the output's first line) with a short description of what the output was.",
  inputSchema: schema(
    {
      reason: { type: "string", minLength: 1, description: "Why this output is not being dispatched." },
      title: { type: "string", description: "Short Inbox title for the output, e.g. \"Deploy finished on staging\"." },
    },
    ["reason"],
  ),
  async run({ reason, title }, ctx) {
    await ctx.ops.declineWork(ctx, reason, title);
    return "Work item declined. Triage is done. Stop here.";
  },
});
