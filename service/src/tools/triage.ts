// Triage tools: route an incoming external work item to a project, or decline it.

import { defineTool, json, schema } from "./util";

export const listProjects = defineTool<Record<string, never>>({
  name: "list_projects",
  description:
    "List the local projects with their ticket key prefix, name, directory and settings (default driver and models, worktrees, human review, auto-complete, permission mode; null means the settings default).",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const projects = await ctx.ops.listProjects(ctx);
    if (projects.length === 0) return "No projects are configured.";
    return json(projects);
  },
});

export const dispatchTicket = defineTool<{
  project_key: string;
  key?: string;
  title: string;
  description: string;
  start?: boolean;
  conductor?: boolean;
}>({
  name: "dispatch_ticket",
  description:
    "Create a local ticket for the incoming work item in the chosen project. Pass the external item's key as key so the local ticket mirrors it (e.g. \"FOO-123\"); if a ticket with that key already exists, the update is posted to it as a message instead. The description is the brief the working agent receives: restate the request with its link and any context you gathered. Set start true to begin work immediately, false to leave it in planning. Set conductor true for large jobs that should be split into several child tickets.",
  inputSchema: schema(
    {
      project_key: { type: "string", minLength: 1, description: "Key prefix of the target project, as returned by list_projects." },
      key: { type: "string", description: "External ticket key to mirror, e.g. \"FOO-123\"." },
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
      title: input.title,
      description: input.description,
      start: input.start,
      conductor: input.conductor,
    });
    return `Dispatched as ${ticket.key} (${ticket.kind}, status: ${ticket.status}). Triage is done. Stop here.`;
  },
});

export const declineWork = defineTool<{ reason: string }>({
  name: "decline_work",
  description:
    "Decline the incoming work item: it doesn't map to any local project, isn't actionable, or is out of scope. The reason is shown to the human in the inbox.",
  inputSchema: schema({ reason: { type: "string", minLength: 1, description: "Why this item is not being dispatched." } }, ["reason"]),
  async run({ reason }, ctx) {
    await ctx.ops.declineWork(ctx, reason);
    return "Work item declined. Triage is done. Stop here.";
  },
});
