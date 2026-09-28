// Triage tools: route a watcher's output to a project, or decline it
// (list_projects is a board tool, see board.ts).

import { defineTool, schema } from "./util";

export const dispatchTicket = defineTool<{
  project_key: string;
  key?: string;
  url?: string;
  title: string;
  description: string;
  start?: boolean;
  conductor?: boolean;
}>({
  name: "dispatch_ticket",
  description:
    "Create a local ticket for the watcher output in the chosen project. When the output is about an item with a ticket-style key (e.g. \"FOO-123\"), pass it as key so the local ticket mirrors it; if a local ticket with that key already exists, the description is posted to it as a message instead of creating a new one. Leave key out to get the project's next key. The title also becomes the Inbox title. The description is the brief the working agent receives: restate the request with its link and any context you gathered. Set start true to begin work immediately, false to leave it in planning. Set conductor true for large jobs that should be split into several child tickets.",
  inputSchema: schema(
    {
      project_key: { type: "string", minLength: 1, description: "Key prefix of the target project, as returned by list_projects." },
      key: { type: "string", description: "External ticket key to mirror, or the key of an existing local ticket to update, e.g. \"FOO-123\"." },
      url: { type: "string", description: "Link to the external item, when the output has one." },
      title: { type: "string", minLength: 1, description: "Ticket title." },
      description: { type: "string", minLength: 1, description: "Brief for the agent that will do the work." },
      start: { type: "boolean", description: "Start work immediately (default false: leave in planning)." },
      conductor: { type: "boolean", description: "Create a conductor ticket that splits the work into child tickets." },
    },
    ["project_key", "title", "description"],
  ),
  async run(input, ctx) {
    const ticket = await ctx.ops.dispatchTicket(ctx, {
      projectKey: input.project_key,
      key: input.key,
      url: input.url,
      title: input.title,
      description: input.description,
      start: input.start,
      conductor: input.conductor,
    });
    return `Dispatched as ${ticket.key} (${ticket.kind}, status: ${ticket.status}). If the output holds other separate items that qualify, dispatch each of them; otherwise triage is done. Stop here.`;
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
