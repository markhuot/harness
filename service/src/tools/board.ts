// Board tools (read-only): every run kind can look around the board for context — list and
// search tickets in any project, read one ticket in full, list the projects and the Inbox.

import { TICKET_STATUSES, type TicketStatus, type TriageStatus } from "@harness/shared";
import type { BoardRelatedTicket, BoardScope, BoardTicket, BoardTicketDetail } from "./types";
import { defineTool, json, RemoteIdError, schema, ticketView } from "./util";

/** list_tickets page size when no limit is given (the ops cap it at 200). */
export const LIST_TICKETS_DEFAULT_LIMIT = 50;

const boardView = (t: BoardTicket) => ({ ...ticketView(t), project: t.projectKey });
const relatedView = (r: BoardRelatedTicket) => ({ key: r.key, title: r.title, status: r.status, project: r.projectKey, externalKey: r.externalKey });

export const listTickets = defineTool<{ scope?: BoardScope; project_key?: string; status?: TicketStatus[]; limit?: number }>({
  name: "list_tickets",
  description:
    "List tickets with their status and review state (no specs; use get_ticket for one ticket's detail). scope \"children\" lists this conductor's child tickets, \"project\" one project's tickets, \"all\" every project's. The default is \"children\" for conductor runs, otherwise \"project\" (the current ticket's project, or project_key), or \"all\" when the run has no ticket. Filter with status, e.g. [\"blocked\", \"review\"]. Results are in board order (done newest first) and capped by limit.",
  inputSchema: schema({
    scope: { type: "string", enum: ["children", "project", "all"], description: "Which tickets to list." },
    project_key: { type: "string", minLength: 1, description: "Project key prefix (see list_projects). Defaults to the current ticket's project." },
    status: { type: "array", items: { type: "string", enum: [...TICKET_STATUSES] }, description: "Only tickets in these statuses." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: `Most tickets to return. Default ${LIST_TICKETS_DEFAULT_LIMIT}.` },
  }),
  async run(input, ctx) {
    const { tickets, total, scope } = await ctx.ops.listTickets(ctx, {
      scope: input.scope,
      projectKey: input.project_key,
      statuses: input.status,
      limit: input.limit ?? LIST_TICKETS_DEFAULT_LIMIT,
    });
    if (tickets.length === 0) {
      if (input.status?.length) return `No tickets match (scope "${scope}", status ${input.status.join(", ")}).`;
      return scope === "children" ? "This ticket has no child tickets yet." : scope === "project" ? "The project has no tickets." : "There are no tickets.";
    }
    const out = json(tickets.map(boardView));
    return tickets.length < total
      ? `Showing ${tickets.length} of ${total} tickets. Narrow with status or project_key, raise limit, or use search_tickets.\n${out}`
      : out;
  },
});

export const getTicket = defineTool<{ key: string; include_transcript?: number }>({
  name: "get_ticket",
  description:
    "Get one ticket's full detail from any project: its spec (the living document with the goal, plan, status and open questions) with its revision and the approved baseline revision, status, review state, blocked reason, parent and child keys, dependencies, driver and model, branches (branch: its worktree's; requestedBranch: the one chosen for it; baseBranch: its override; effectiveBaseBranch: what it merges into on completion), its Activity (notes, submits, blocks, review decisions with their round and reviewed commit, and messages, oldest first), and its attachments (the images and videos its spec shows as attachment:<id>, with each one's stored file path, which you can open with a file tool). Old keys from before a project rename work too. Only local keys find a ticket: a remote ID (the external item's key a ticket is linked to, shown as externalKey) doesn't. relatedTickets lists the other tickets linked to the same remote ID, or to the key you asked for. When no local ticket has the key but tickets carry it as their remote ID, the result is { ticket: null, requested, relatedTickets }: call get_ticket again with one of those local keys. Set include_transcript to N to also see the last N messages and status lines of its agent's transcript (text only, long entries clipped).",
  inputSchema: schema(
    {
      key: { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\"." },
      include_transcript: { type: "integer", minimum: 1, maximum: 50, description: "Also return the last N transcript entries (max 50)." },
    },
    ["key"],
  ),
  async run({ key, include_transcript }, ctx) {
    let d: BoardTicketDetail;
    try {
      d = await ctx.ops.getTicket(ctx, key, include_transcript ? { transcript: include_transcript } : undefined);
    } catch (err) {
      if (!(err instanceof RemoteIdError)) throw err;
      const m = err.matches;
      return json({ ticket: null, requested: m.requested, relatedTickets: m.relatedTickets.map(relatedView) });
    }
    const t = d.ticket;
    return json({
      ...boardView(t),
      ...(d.resolvedFrom ? { resolvedFrom: d.resolvedFrom } : {}),
      relatedTickets: d.relatedTickets.map(relatedView),
      spec: t.spec,
      specRevision: d.specRevision,
      specBaselineRevision: d.specBaselineRevision,
      parent: d.parent,
      children: d.children,
      driver: t.driver,
      model: t.model,
      // baseBranch is the ticket's own override (null inherits); this is what it merges into.
      effectiveBaseBranch: d.base.branch,
      baseBranchSource: d.base.source,
      activity: d.activity,
      attachments: d.attachments,
      ...(d.transcript ? { transcript: d.transcript } : {}),
    });
  },
});

export const searchTickets = defineTool<{ query: string; project_key?: string; limit?: number; cursor?: string }>({
  name: "search_tickets",
  description:
    "Full-text search over every ticket in every status: key (exact or prefix, including old keys), remote ID (the external item's key a ticket is linked to), title, spec and latest Activity note. Every word must match, as a prefix. Best matches come first (exact key, key prefix, exact remote ID, remote ID prefix, title hits, then the rest; newest first within each). Returns key, externalKey (its remote ID, when it has one), title, status, project and a snippet per hit; when there are more, pass the returned nextCursor back as cursor.",
  inputSchema: schema(
    {
      query: { type: "string", minLength: 1, description: "Words or a ticket key to search for." },
      project_key: { type: "string", minLength: 1, description: "Only search this project (see list_projects)." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most hits per page. Default 20." },
      cursor: { type: "string", minLength: 1, description: "nextCursor from the previous page of the same search." },
    },
    ["query"],
  ),
  async run(input, ctx) {
    const page = await ctx.ops.searchTickets(ctx, { query: input.query, projectKey: input.project_key, limit: input.limit, cursor: input.cursor });
    if (page.hits.length === 0) return input.cursor ? "No more matches." : `No tickets match "${input.query}".`;
    return json({
      total: page.total,
      hits: page.hits.map(({ ticket: t, snippet }) => ({
        key: t.key,
        ...(t.externalRef?.key ? { externalKey: t.externalRef.key } : {}),
        title: t.title,
        status: t.status,
        project: t.projectKey,
        snippet,
      })),
      nextCursor: page.nextCursor,
    });
  },
});

export const listProjects = defineTool<Record<string, never>>({
  name: "list_projects",
  description:
    "List the local projects with their ticket key prefix, name, directory and settings (default driver and models, worktrees, human review, permission mode, base branch, what approving does by default and which completion actions it offers, and the host pull requests open on; null means the settings default).",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const projects = await ctx.ops.listProjects(ctx);
    if (projects.length === 0) return "No projects are configured.";
    return json(projects);
  },
});

const TRIAGE_STATUSES = ["triaging", "dispatched", "declined", "failed"] as const;

/** list_inbox page size when no limit is given (the ops cap it at 100). */
export const LIST_INBOX_DEFAULT_LIMIT = 20;

export const listInbox = defineTool<{ status?: TriageStatus[]; source?: string; key?: string; limit?: number; include_output?: boolean }>({
  name: "list_inbox",
  description:
    "List the Inbox, newest first: one item per piece of watcher output, with the triage agent's decision. status is \"triaging\", \"dispatched\" (outcome names the ticket), \"declined\" (outcome says why) or \"failed\". Filter by status, by source (the watcher's name) or by key for one item (e.g. \"TRIAGE-12\": Inbox keys aren't tickets, so get_ticket can't read them); include_output adds the output each item was triaged from (truncated). Use it to check that a watcher you set up is producing items and how they were handled.",
  inputSchema: schema({
    status: { type: "array", items: { type: "string", enum: [...TRIAGE_STATUSES] }, description: "Only items in these states." },
    source: { type: "string", minLength: 1, description: "Only items from this watcher (its name)." },
    key: { type: "string", minLength: 1, description: "Only the item with this key, e.g. \"TRIAGE-12\"." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: `Most items to return. Default ${LIST_INBOX_DEFAULT_LIMIT}.` },
    include_output: { type: "boolean", description: "Include each item's watcher output. Default false." },
  }),
  async run(input, ctx) {
    const { items, total } = await ctx.ops.listInbox(ctx, {
      statuses: input.status,
      source: input.source,
      key: input.key,
      limit: input.limit ?? LIST_INBOX_DEFAULT_LIMIT,
      output: input.include_output ?? false,
    });
    if (items.length === 0) return input.status?.length || input.source || input.key ? "No Inbox items match." : "The Inbox is empty.";
    const out = json(
      items.map((i) => ({
        key: i.key,
        title: i.title,
        source: i.source,
        status: i.status,
        outcome: i.outcome,
        ...(i.prompt ? { prompt: i.prompt } : {}),
        ...(i.output !== undefined ? { output: i.output } : {}),
        created_at: new Date(i.createdAt).toISOString(),
      })),
    );
    return items.length < total ? `Showing ${items.length} of ${total} items. Narrow with status, source or key, or raise limit.\n${out}` : out;
  },
});
