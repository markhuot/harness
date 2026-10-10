// Prompts for every run kind. These are instructions real models follow, so they are
// written to be short, concrete and consistent with the tool names in DESIGN.md.
//
// The text lives in prompt-templates.ts as templates the user can override (settings.prompts,
// DESIGN.md "Prompt overrides"). This file works out each template's variables from the run,
// decides which system prompt sections a run gets, and joins them in order.
//
// Two constraints from the dummy driver (DESIGN.md → "Dummy driver script"):
//  * The triage prompt puts the watcher's prompt under a `## What the human wants` heading and
//    the output in a fenced `## Output` section; dummy triage reads its markers from the former.
//  * Run prompts never contain `- ` bullets or slash directives of our own; the dummy
//    conductor turns `- ` bullets into child tickets and the dummy work run reacts to
//    slash-prefixed directives. System prompts use `*` bullets for the same reason.

import type { ActivityEntry, CompletionAction, Project, RunKind, Session, Ticket, TicketStatus } from "@harness/shared";
import { displayKey, harnessBranch, plannedBranch, resolveBaseBranch, secondaryKey } from "@harness/shared";
import { toolsForRun } from "../tools/index";
import { type PromptOverrides, renderPrompt } from "./prompt-templates";

export type { PromptOverrides } from "./prompt-templates";

/** What the prompts say about branches (DESIGN.md "Branches"); the orchestrator works it out. */
export interface BranchContext {
  /** The effective base branch: what the ticket's work merges into when it completes */
  base: string;
  /** Where it came from: "ticket", "project", "settings", or "checkout" (the setting's branch isn't in the repo) */
  baseSource: string;
  /** The ticket's worktree is inside the harness worktrees dir, so the harness created it and may remove it */
  ownsWorktree: boolean;
  /** The harness worktrees folder, named in the completion rules */
  worktreesDir?: string;
  /** An earlier harness worktree of this ticket left on disk after update_branch moved it elsewhere */
  leftover?: { path: string; branch: string | null } | null;
  /** Where a "pr" completion pushes and opens its pull request (null: nowhere gh can reach) */
  pullRequest?: { host: string; remote: string; repo: string } | null;
  /** Where a "cleanup" completion pushes the ticket's branch (null: the repo has no remote to push to) */
  pushRemote?: string | null;
}

/** The completion prompts a complete run of `ticket` uses: the action chosen at approval (default merge). */
export function completionActionOf(ticket: Pick<Ticket, "completionAction"> | null | undefined): CompletionAction {
  return ticket?.completionAction ?? "merge";
}

export interface PromptInfo {
  kind: RunKind;
  project: Project | null;
  ticket: Ticket | null;
  session: Session;
  parent?: Ticket | null;
  children?: Ticket[];
  /** The driver brings its own file tools (claude-code's Read/Edit/Write); false → harness native tools. Default true. */
  builtinTools?: boolean;
  /** The driver's sub-agent tool for exploring (Driver.subagentTool); unset → no explore rule */
  subagentTool?: string;
  /** Base branch and worktree ownership. Omitted: resolved from the ticket and project alone, worktree owned. */
  branches?: BranchContext;
  /** The user's prompt overrides (settings.prompts). Omitted: the built-in prompts. */
  overrides?: PromptOverrides | null;
  /** The ticket's last few Activity entries, oldest first (system.spec shows them) */
  activity?: ActivityEntry[];
}

/** What a review run reads (Orchestrator.reviewContext). */
export interface ReviewContext {
  /** 1 for the first agent review of the ticket */
  round: number;
  /** Earlier agent review rounds, oldest first */
  earlier: { round: number; decision: "approve" | "request_changes"; notes: string; commit: string | null }[];
  /** The approved baseline revision (null: the ticket never went through Start) */
  baselineRevision: number | null;
  /** Activity since the last agent review (all of it on the first), oldest first */
  activity: ActivityEntry[];
}

function branchesOf(ticket: Ticket | null, project: Project | null, branches?: BranchContext): BranchContext {
  if (branches) return branches;
  const r = resolveBaseBranch(ticket, project, null);
  return { base: r.branch, baseSource: r.source, ownsWorktree: true };
}

const BASE_SOURCE: Record<string, string> = {
  ticket: "set on this ticket",
  parent: "the parent ticket's branch: children land on it",
  project: "the project's base branch",
  settings: "the default from Settings",
  checkout: "the branch checked out in the main checkout, since the Settings default isn't in this repository",
};

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function quote(s: string): string {
  return `"${oneLine(s)}"`;
}

/**
 * `KEY "title"`, or `MH-62 (local MH-124) "title"` for a ticket linked to a remote ID: the remote
 * ID is what people call it, the local key is what every tool takes.
 */
function ticketLabel(t: Pick<Ticket, "key" | "title"> & { externalRef?: Ticket["externalRef"] }): string {
  const local = secondaryKey(t);
  return local ? `${displayKey(t)} (local ${local}) ${quote(t.title)}` : `${t.key} ${quote(t.title)}`;
}

/** An "Existing tickets" line for triage: the local key first (what ticket_key takes), then its remote ID. */
function existingTicketLine(t: Ticket): string {
  const remote = t.externalRef?.key ? `, remote ID ${t.externalRef.key}` : ", no remote ID";
  return `* ${t.key} ${quote(t.title)}, status ${t.status}${remote}`;
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n");
}

/** A backtick fence longer than any backtick run in `text`, so the text can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function specOf(ticket: Ticket): string {
  return ticket.spec.trim() || "(the spec is empty; the title is the whole spec)";
}

/** Activity entries as `* ` lines: kind, author and the body on one line (clipped). */
export function activityLines(entries: readonly ActivityEntry[], max = 400): string {
  return entries
    .map((e) => {
      // A permission entry's detail (the calls the classifier denied) is on record for the reviewer.
      const text = oneLine(e.kind === "permission" && e.meta.detail ? e.meta.detail : e.body);
      const extra = e.kind === "review_approved" || e.kind === "changes_requested" ? ` (round ${e.meta.round ?? "?"}${e.meta.commit ? `, commit ${e.meta.commit.slice(0, 12)}` : ""})` : "";
      return `* ${e.kind}${extra}, ${e.author}: ${text.length > max ? text.slice(0, max - 1) + "…" : text}`;
    })
    .join("\n");
}

/** Variables every template about a ticket's branch shares. */
function branchVars(ticket: Ticket | null, b: BranchContext) {
  const branch = ticket?.branch ?? "";
  return {
    branch,
    baseBranch: b.base,
    onBase: !!branch && branch === b.base,
    workdir: ticket?.workdir ?? "",
    ownsWorktree: b.ownsWorktree,
    isHarnessBranch: !!ticket && !!branch && branch === harnessBranch(ticket.key),
  };
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

function contextSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  const { ticket, project, session, parent } = info;
  const b = ticket ? branchesOf(ticket, project, info.branches) : null;
  const planned =
    !!ticket && !ticket.branch && !ticket.workdir && project?.isGit !== false && (ticket.useWorktree ?? project?.useWorktrees ?? true);
  return renderPrompt(
    "system.context",
    {
      ticket: ticket ? ticketLabel(ticket) : "",
      ticketKind: ticket?.kind ?? "",
      ticketStatus: ticket?.status ?? "",
      triage: !ticket && info.kind === "triage",
      sessionKey: session.key,
      sessionTitle: session.title ? quote(session.title) : "",
      project: project ? (project.name === project.key ? project.key : `${project.name} (${project.key})`) : "",
      projectPath: project?.path ?? "",
      workdir: ticket?.workdir ?? session.cwd ?? project?.path ?? "(unknown)",
      branch: ticket?.branch ?? "",
      ownsWorktree: b?.ownsWorktree ?? true,
      plannedBranch: planned ? plannedBranch(ticket!) : "",
      isGit: project?.isGit !== false,
      baseBranch: b?.base ?? "",
      baseSource: b ? (BASE_SOURCE[b.baseSource] ?? b.baseSource) : "",
      dependsOn: ticket?.dependsOn.join(", ") ?? "",
      externalKey: ticket?.externalRef?.key ?? "",
      externalSource: ticket?.externalRef?.source ?? "",
      externalUrl: ticket?.externalRef?.url ?? "",
      parent: parent ? ticketLabel(parent) : "",
    },
    o,
  );
}

function childLine(t: Ticket): string {
  const deps = t.dependsOn.length ? `, depends on ${t.dependsOn.join(", ")}` : "";
  const skips = [t.skipAgentReview && "the agent review", t.skipHumanReview && "your review"].filter(Boolean).join(" and ");
  const reviews = t.status === "review" ? `, agent review ${t.agentReview}, your review ${t.humanReview}` : skips ? `, skips ${skips}` : "";
  const blocked = t.status === "blocked" && t.blockedReason ? `, asks: ${quote(t.blockedReason)}` : "";
  return `* ${ticketLabel(t)}: ${t.status}${reviews}${deps}${blocked}`;
}

/** Ticket lookup tools, named only when triage runs actually have them. */
function triageLookupTools(): string {
  const triageTools = toolsForRun("triage", { hasBuiltinTools: true, usesPermissionPromptTool: false });
  const lookup = ["search_tickets", "get_ticket"].filter((n) => triageTools.some((t) => t.name === n)).map((n) => `\`${n}\``);
  return lookup.join(" or ");
}

function instructionsSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  const { kind, ticket, project } = info;
  switch (kind) {
    case "plan":
      return renderPrompt("system.plan", {}, o);
    case "work": {
      const v = branchVars(ticket, branchesOf(ticket, project, info.branches));
      return renderPrompt(
        "system.work",
        {
          branch: v.branch,
          onBase: v.onBase,
          skipAgentReview: !!ticket?.skipAgentReview,
          skipHumanReview: !!ticket?.skipHumanReview,
          canSkipReview: !ticket?.skipHumanReview,
        },
        o,
      );
    }
    case "review": {
      const v = branchVars(ticket, branchesOf(ticket, project, info.branches));
      return renderPrompt("system.review", { branch: v.branch, baseBranch: v.baseBranch, onBase: v.onBase }, o);
    }
    case "complete": {
      const b = branchesOf(ticket, project, info.branches);
      const { branch, baseBranch, onBase, workdir, ownsWorktree, isHarnessBranch } = branchVars(ticket, b);
      const harness = ticket ? harnessBranch(ticket.key) : "";
      const mainCheckout = project?.path ?? "the main project checkout";
      const action = completionActionOf(ticket);
      if (action === "pr") {
        const pr = b.pullRequest;
        return renderPrompt(
          "system.complete_pr",
          {
            branch,
            baseBranch,
            onBase,
            workdir,
            mainCheckout,
            ownsWorktree,
            worktreesDir: b.worktreesDir ?? "",
            prHost: pr?.host ?? "github.com",
            remoteName: pr?.remote ?? "origin",
            repo: pr?.repo ?? "<host>/<owner>/<repo>",
            pullRequestUrl: ticket?.pullRequestUrl ?? "",
          },
          o,
        );
      }
      if (action === "cleanup") {
        return renderPrompt(
          "system.complete_cleanup",
          {
            branch,
            baseBranch,
            onBase,
            workdir,
            mainCheckout,
            ownsWorktree,
            harnessBranch: harness,
            isHarnessBranch,
            worktreesDir: b.worktreesDir ?? "",
            leftoverPath: b.leftover?.path ?? "",
            leftoverBranch: b.leftover?.branch ?? "",
            leftoverIsHarness: !!b.leftover?.branch && b.leftover.branch === harness,
            remoteName: b.pushRemote ?? "",
            pullRequestUrl: ticket?.pullRequestUrl ?? "",
          },
          o,
        );
      }
      if (action === "custom") {
        return renderPrompt(
          "system.complete_custom",
          {
            branch,
            baseBranch,
            workdir,
            mainCheckout,
            ownsWorktree,
            harnessBranch: harness,
            worktreesDir: b.worktreesDir ?? "",
            hasInstructions: !!ticket?.completionInstructions?.trim(),
          },
          o,
        );
      }
      return renderPrompt(
        "system.complete_merge",
        {
          branch,
          baseBranch,
          onBase,
          workdir,
          mainCheckout,
          ownsWorktree,
          harnessBranch: harness,
          isHarnessBranch,
          worktreesDir: b.worktreesDir ?? "",
          leftoverPath: b.leftover?.path ?? "",
          leftoverBranch: b.leftover?.branch ?? "",
          leftoverIsHarness: !!b.leftover?.branch && b.leftover.branch === harness,
        },
        o,
      );
    }
    case "conductor":
      return renderPrompt(
        "system.conductor",
        {
          children: (info.children ?? []).map(childLine).join("\n"),
          branch: ticket?.branch ?? "",
          baseBranch: branchesOf(ticket, project, info.branches).base,
        },
        o,
      );
    case "compact":
      return ""; // a compact run sends no instructions
    case "triage":
      return renderPrompt("system.triage", { lookupTools: triageLookupTools() }, o);
    case "chat": {
      const status = ticket?.status;
      return renderPrompt(
        "system.chat",
        {
          status: status ?? "",
          blocked: status === "blocked",
          blockedReason: ticket?.blockedReason ?? "",
          review: status === "review",
          done: status === "done",
        },
        o,
      );
    }
  }
}

/** The driver's file tools as the Files and Working efficiently sections name them. */
function fileTools(builtinTools: boolean) {
  return builtinTools
    ? { readTool: "`Read`", searchTools: "`Grep` and `Glob`", editTool: "`Edit`", writeTool: "`Write`", shell: "Bash" }
    : { readTool: "`read_file`", searchTools: "`list_files`", editTool: "`edit_file`", writeTool: "`write_file`", shell: "bash" };
}

/**
 * The run kind whose tools a run has (tools/index.ts toolsForRun): a chat gets its ticket's work
 * tools, or a conductor ticket's conductor tools. The system prompt's capability sections go by
 * this, so a chat and the work (or conductor) runs that share its session read the same prompt.
 */
function toolKind(kind: RunKind, ticket: Ticket | null): Exclude<RunKind, "chat"> {
  return kind === "chat" ? (ticket?.kind === "conductor" ? "conductor" : "work") : kind;
}

/** Runs that change files (work, completion, and chat runs of a task ticket). */
function editsFiles(kind: RunKind): boolean {
  return kind === "work" || kind === "complete" || kind === "chat";
}

/**
 * File tools over the shell. Claude Code's auto mode tells the model shell edits (sed, heredocs)
 * are fine; in ask mode those need a human's approval where Edit/Write in the workdir don't, and
 * they read worse on the board. Read-only runs (plan, review, conductor) get the read half.
 * Exploring the codebase in the agent's own context fills it with whole files that every later
 * turn re-reads, so runs that explore (plan, work, conductor, chat) must hand that to the driver's
 * sub-agent when it has one (Driver.subagentTool).
 */
function filesSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  const kind = toolKind(info.kind, info.ticket);
  const explores = kind === "plan" || kind === "work" || kind === "conductor";
  return renderPrompt(
    "system.files",
    { ...fileTools(info.builtinTools ?? true), canEdit: editsFiles(kind), subagentTool: explores ? (info.subagentTool ?? "") : "" },
    o,
  );
}

/**
 * Fewer, bigger turns: every API call re-reads the whole context, so cost grows with calls ×
 * context size. Every run kind gets it; the edit rule only where the run changes files.
 */
function turnsSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  return renderPrompt("system.turns", { canEdit: editsFiles(toolKind(info.kind, info.ticket)) }, o);
}

/**
 * The spec and Activity: how to keep the spec current and how short notes are. Only work,
 * conductor and chat runs have submit_for_review; review runs only read the spec (toolsForRun);
 * complete runs have no browser.
 */
function specSection(info: PromptInfo, browser: boolean, o: PromptOverrides | null | undefined): string {
  const { kind, ticket } = info;
  return renderPrompt(
    "system.spec",
    {
      specRevision: String(ticket?.specRevision ?? 1),
      baselineRevision: ticket?.specBaselineRevision ? String(ticket.specBaselineRevision) : "",
      canEdit: kind !== "review",
      plan: kind === "plan",
      submits: kind === "work" || kind === "conductor" || kind === "chat",
      // Mirrors fileOutputScope: these run kinds may only save into their scratch folder.
      readOnly: kind === "plan" || kind === "review",
      browser,
      activity: activityLines(info.activity ?? [], 200),
    },
    o,
  );
}

/**
 * The ticket's agent notes (update_notes), for every ticket run; the runs that write them
 * (tools/index.ts) also learn when the next run starts fresh and where past context lives.
 */
function notesSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  const { kind, ticket } = info;
  const canWrite = kind === "plan" || kind === "work" || kind === "conductor" || kind === "chat";
  const git = !!ticket?.branch;
  const notes = ticket?.agentNotes?.trim() ?? "";
  if (!canWrite && !notes) return "";
  return renderPrompt(
    "system.notes",
    {
      notes,
      canWrite,
      plan: kind === "plan",
      git,
      baseBranch: git && ticket ? branchesOf(ticket, info.project, info.branches).base : "",
    },
    o,
  );
}

/**
 * The stable part of the run's context (system.session): what can't change while the agent's
 * session lives, so it can sit in the system prompt.
 */
function sessionSection(info: PromptInfo, o: PromptOverrides | null | undefined): string {
  const { ticket, project, session } = info;
  return renderPrompt(
    "system.session",
    {
      ticket: ticket?.key ?? "",
      ticketKind: ticket?.kind ?? "",
      triage: !ticket && info.kind === "triage",
      sessionKey: session.key,
      project: project ? (project.name === project.key ? project.key : `${project.name} (${project.key})`) : "",
      projectPath: project?.path ?? "",
      workdir: ticket?.workdir ?? session.cwd ?? project?.path ?? "(unknown)",
    },
    o,
  );
}

/**
 * The run's system prompt: only what stays the same for every run that resumes the agent's
 * session (DESIGN.md "System prompt and run context"). The system prompt sits ahead of the
 * conversation, so anything here that changed between runs would make a resumed run write the
 * whole conversation to the prompt cache again (and Claude Code keeps a resumed conversation's
 * first system prompt anyway). Runs that share a session (plan; work and chat; conductor and chat)
 * get the same text here: the capability sections go by the run's tool set (toolKind), and
 * everything about this run (status, instructions, spec revision, Activity, notes) is in
 * runContext, which goes in the run's first message.
 */
export function systemPrompt(info: PromptInfo): string {
  const { ticket } = info;
  const kind = toolKind(info.kind, ticket);
  const o = info.overrides;
  const ticketRun = kind !== "triage";
  const browser = kind === "plan" || kind === "work" || kind === "review" || kind === "conductor";
  const changes = kind === "work" || kind === "conductor";
  const conductor = kind === "conductor";
  return join(
    renderPrompt("system.intro", {}, o),
    sessionSection(info, o),
    ticketRun && renderPrompt("system.lifecycle", {}, o),
    ticketRun && filesSection(info, o),
    turnsSection(info, o),
    // harness://file links (shared/src/fileLinks.ts) open the file pane from any message, note or spec.
    ticketRun && renderPrompt("system.file_links", {}, o),
    // Read-only board tools, given to every run kind (tools/board.ts).
    renderPrompt("system.board", {}, o),
    // Board tools that change other tickets (tools/board-write.ts).
    changes && renderPrompt("system.board_changes", { conductor }, o),
    // Config tools (tools/config.ts): reads for every run; the gated writes where a human can approve them.
    renderPrompt("system.config", { canChange: changes }, o),
    (changes || kind === "complete") && renderPrompt("system.approvals", { canBlock: kind === "work" }, o),
    browser && renderPrompt("system.browser", {}, o),
  );
}

/**
 * What this run reads about the ticket and itself: its current context, the run kind's
 * instructions ("This run: …"), children, branches, the spec's revision with recent Activity, and
 * the agent notes. It changes from run to run, so it goes at the front of the run's first user
 * message (drivers wrap it in <harness_run>, drivers/types.ts withRunContext) rather than in the
 * system prompt.
 */
export function runContext(info: PromptInfo): string {
  const { kind, ticket } = info;
  const o = info.overrides;
  const ticketRun = kind !== "triage";
  const browser = kind === "plan" || kind === "work" || kind === "review" || kind === "conductor" || kind === "chat";
  const changes = kind === "work" || kind === "conductor" || kind === "chat";
  return join(
    contextSection(info, o),
    instructionsSection(info, o),
    // A task ticket that has taken children conducts them too; conductor runs list theirs in their instructions.
    // A chat (conductor tickets too) gets the same child-steering notes, since its instructions don't list them.
    (kind === "work" || kind === "chat") &&
      !!info.children?.length &&
      renderPrompt("system.children", { children: info.children.map(childLine).join("\n"), branch: ticket?.branch ?? "" }, o),
    // update_branch (tools/ticket.ts): work, conductor and chat runs of a ticket with a worktree.
    changes &&
      !!ticket?.branch &&
      renderPrompt("system.branches", { branch: ticket.branch, baseBranch: branchesOf(ticket, info.project, info.branches).base }, o),
    ticketRun && specSection(info, browser, o),
    ticketRun && notesSection(info, o),
  );
}

// ---------------------------------------------------------------------------
// Run prompts (the "user" message of a run)
// ---------------------------------------------------------------------------

/** First work (or conductor) run after the plan is approved. */
export function workStartPrompt(ticket: Ticket, overrides?: PromptOverrides | null): string {
  const id = ticket.kind === "conductor" ? "run.conductor_start" : "run.work_start";
  return renderPrompt(id, { ticket: ticketLabel(ticket), spec: specOf(ticket), specRevision: String(ticket.specRevision ?? 1) }, overrides);
}

/**
 * The review run's message: the spec revision to read, the approved baseline revision, the
 * earlier review rounds and the Activity since the last one. Neither the spec nor its diff from the
 * baseline is inlined: revisions never change once written, so the revision numbers pin exactly
 * what was submitted and approved, and the reviewer reads them with read_spec. A re-review
 * (round 2 on) is told to look at what changed since the commit the last round reviewed.
 */
export function reviewPrompt(ticket: Ticket, ctx: ReviewContext, overrides?: PromptOverrides | null): string {
  const last = ctx.earlier.at(-1);
  const specRevision = ticket.specRevision ?? 1;
  return renderPrompt(
    "run.review",
    {
      ticket: ticketLabel(ticket),
      key: ticket.key,
      specEmpty: !ticket.spec.trim(),
      specRevision: String(specRevision),
      baselineRevision: ctx.baselineRevision ? String(ctx.baselineRevision) : "",
      baselineChanged: !!ctx.baselineRevision && ctx.baselineRevision !== specRevision,
      round: String(ctx.round),
      rereview: ctx.earlier.length > 0,
      earlierRounds: ctx.earlier
        .map((r) => `Round ${r.round}: ${r.decision === "approve" ? "approved" : "changes requested"}${r.commit ? ` at commit ${r.commit}` : " (no commit recorded)"}.\n${r.notes.trim()}`)
        .join("\n\n"),
      lastCommit: last?.commit ?? "",
      activity: activityLines(ctx.activity),
    },
    overrides,
  );
}

export function completePrompt(
  ticket: Ticket,
  instructions?: string,
  branches?: BranchContext,
  project: Project | null = null,
  overrides?: PromptOverrides | null,
): string {
  const b = branchesOf(ticket, project, branches);
  const v = branchVars(ticket, b);
  const label = ticketLabel(ticket);
  const text = instructions?.trim() ?? "";
  switch (completionActionOf(ticket)) {
    case "pr":
      return renderPrompt(
        "run.complete_pr",
        {
          ticket: label,
          branch: v.branch,
          baseBranch: v.baseBranch,
          onBase: v.onBase,
          remoteName: b.pullRequest?.remote ?? "origin",
          pullRequestUrl: ticket.pullRequestUrl ?? "",
          instructions: text,
        },
        overrides,
      );
    case "cleanup":
      return renderPrompt(
        "run.complete_cleanup",
        { ticket: label, branch: v.branch, baseBranch: v.baseBranch, onBase: v.onBase, ownsWorktree: v.ownsWorktree, isHarnessBranch: v.isHarnessBranch, remoteName: b.pushRemote ?? "", pullRequestUrl: ticket.pullRequestUrl ?? "", instructions: text },
        overrides,
      );
    case "custom":
      return renderPrompt("run.complete_custom", { ticket: label, branch: v.branch, instructions: text }, overrides);
    case "merge":
      return renderPrompt("run.complete_merge", { ticket: label, ...v, instructions: text }, overrides);
  }
}

export function conductorUpdatePrompt(
  changes: { key: string; title: string; from: TicketStatus; to: TicketStatus; note?: string; specRevision?: number }[],
  overrides?: PromptOverrides | null,
): string {
  const lines = changes.map((c, i) => {
    const rev = c.specRevision ? ` (spec revision ${c.specRevision})` : "";
    const head = `${i + 1}. ${c.key} ${quote(c.title)}: ${c.from} → ${c.to}${rev}`;
    return c.note?.trim() ? `${head}\n   Note: ${c.note.trim().replace(/\n/g, "\n   ")}` : head;
  });
  return renderPrompt("run.conductor_update", { changes: lines.join("\n") }, overrides);
}

export function changesRequestedPrompt(notes: string, by: "agent" | "human" | "conductor", specRevision = 1, overrides?: PromptOverrides | null): string {
  return renderPrompt(
    "run.changes_requested",
    { notes: notes.trim(), byAgent: by === "agent", byHuman: by === "human", byConductor: by === "conductor", specRevision: String(specRevision) },
    overrides,
  );
}

/** A done ticket sent back to in progress by the human. */
export function reopenPrompt(ticket: Ticket, notes: string, base?: string, overrides?: PromptOverrides | null): string {
  return renderPrompt(
    "run.reopen",
    {
      ticket: ticketLabel(ticket),
      notes: notes.trim(),
      specRevision: String(ticket.specRevision ?? 1),
      branch: ticket.branch ?? "",
      baseBranch: base ?? "",
      isHarnessBranch: !!ticket.branch && ticket.branch === harnessBranch(ticket.key),
      pullRequestUrl: ticket.pullRequestUrl ?? "",
    },
    overrides,
  );
}

export function triagePrompt(
  input: {
    source: string;
    /** Inbox title derived from the output */
    title: string;
    text: string;
    truncated: boolean;
    /** The watcher's prompt ("" → none) */
    prompt: string;
    projects: Project[];
    /** Local tickets a key in the output names: by local key (or alias), or linked to it as a remote ID */
    existingTickets: Ticket[];
  },
  overrides?: PromptOverrides | null,
): string {
  const { source, title, text, truncated, prompt, projects, existingTickets } = input;
  const fence = fenceFor(text);
  return renderPrompt(
    "run.triage",
    {
      source: oneLine(source),
      title: oneLine(title),
      prompt: prompt.trim(),
      existingTickets: existingTickets.map(existingTicketLine).join("\n"),
      output: `${fence}\n${text}\n${fence}`,
      truncated,
      projects: projects.map((p) => `* ${p.key}: ${p.name} (${p.path})`).join("\n"),
    },
    overrides,
  );
}

/** The prompt builders with the user's overrides bound, for callers that have the settings. */
export function promptsWith(overrides: PromptOverrides | null | undefined) {
  return {
    systemPrompt: (info: Omit<PromptInfo, "overrides">) => systemPrompt({ ...info, overrides }),
    runContext: (info: Omit<PromptInfo, "overrides">) => runContext({ ...info, overrides }),
    workStartPrompt: (ticket: Ticket) => workStartPrompt(ticket, overrides),
    reviewPrompt: (ticket: Ticket, ctx: ReviewContext) => reviewPrompt(ticket, ctx, overrides),
    completePrompt: (ticket: Ticket, instructions?: string, branches?: BranchContext, project: Project | null = null) =>
      completePrompt(ticket, instructions, branches, project, overrides),
    conductorUpdatePrompt: (changes: Parameters<typeof conductorUpdatePrompt>[0]) => conductorUpdatePrompt(changes, overrides),
    changesRequestedPrompt: (notes: string, by: "agent" | "human" | "conductor", specRevision?: number) => changesRequestedPrompt(notes, by, specRevision, overrides),
    reopenPrompt: (ticket: Ticket, notes: string, base?: string) => reopenPrompt(ticket, notes, base, overrides),
    triagePrompt: (input: Parameters<typeof triagePrompt>[0]) => triagePrompt(input, overrides),
  };
}
