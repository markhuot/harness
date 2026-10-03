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
  /** Base branch and worktree ownership. Omitted: resolved from the ticket and project alone, worktree owned. */
  branches?: BranchContext;
  /** The user's prompt overrides (settings.prompts). Omitted: the built-in prompts. */
  overrides?: PromptOverrides | null;
  /** The ticket's last few Activity entries, oldest first (system.spec shows them) */
  activity?: ActivityEntry[];
  /** A human message logged to Activity started this run, so its answer is logged too (chat and plan runs) */
  logged?: boolean;
}

/** What a review run reads (Orchestrator.reviewContext). */
export interface ReviewContext {
  /** 1 for the first agent review of the ticket */
  round: number;
  /** Earlier agent review rounds, oldest first */
  earlier: { round: number; decision: "approve" | "request_changes"; notes: string; commit: string | null }[];
  /** The approved baseline revision (null: the ticket never went through Start) */
  baselineRevision: number | null;
  /** Unified diff from the baseline to the current spec; "" when unchanged or there's no baseline */
  baselineDiff: string;
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
      const text = oneLine(e.body);
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
      return renderPrompt("system.plan", { logged: !!info.logged }, o);
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
          logged: !!info.logged,
        },
        o,
      );
    }
  }
}

/**
 * File tools over the shell. Claude Code's auto mode tells the model shell edits (sed, heredocs)
 * are fine; in ask mode those need a human's approval where Edit/Write in the workdir don't, and
 * they read worse on the board. Read-only runs (plan, review, conductor) get the read half.
 */
function filesSection(kind: RunKind, builtinTools: boolean, o: PromptOverrides | null | undefined): string {
  const t = builtinTools
    ? { readTool: "`Read`", searchTools: "`Grep` and `Glob`", editTool: "`Edit`", writeTool: "`Write`", shell: "Bash" }
    : { readTool: "`read_file`", searchTools: "`list_files`", editTool: "`edit_file`", writeTool: "`write_file`", shell: "bash" };
  return renderPrompt("system.files", { ...t, canEdit: kind === "work" || kind === "complete" || kind === "chat" }, o);
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

export function systemPrompt(info: PromptInfo): string {
  const { kind, ticket } = info;
  const o = info.overrides;
  const ticketRun = kind !== "triage";
  const browser = kind === "plan" || kind === "work" || kind === "review" || kind === "conductor" || kind === "chat";
  // A chat is the ticket's agent with its work tools (tools/index.ts toolsForRun).
  const changes = kind === "work" || kind === "conductor" || kind === "chat";
  const conductor = kind === "conductor" || (kind === "chat" && ticket?.kind === "conductor");
  return join(
    renderPrompt("system.intro", {}, o),
    contextSection(info, o),
    ticketRun && renderPrompt("system.lifecycle", {}, o),
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
    ticketRun && filesSection(kind, info.builtinTools ?? true, o),
    ticketRun && specSection(info, browser, o),
    // harness://file links (shared/src/fileLinks.ts) open the file pane from any message, note or spec.
    ticketRun && renderPrompt("system.file_links", {}, o),
    // Read-only board tools, given to every run kind (tools/board.ts).
    renderPrompt("system.board", {}, o),
    // Board tools that change other tickets (tools/board-write.ts).
    changes && renderPrompt("system.board_changes", { conductor }, o),
    // Config tools (tools/config.ts): reads for every run; the gated writes where a human can approve them.
    renderPrompt("system.config", { canChange: changes }, o),
    (changes || kind === "complete") && renderPrompt("system.approvals", { canBlock: kind === "work" || (kind === "chat" && !conductor) }, o),
    browser && renderPrompt("system.browser", {}, o),
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
 * The review run's message: the spec, its changes since the approved baseline, the earlier review
 * rounds and the Activity since the last one. A re-review (round 2 on) is told to look at what
 * changed since the commit the last round reviewed.
 */
export function reviewPrompt(ticket: Ticket, ctx: ReviewContext, overrides?: PromptOverrides | null): string {
  const last = ctx.earlier.at(-1);
  const diffFence = fenceFor(ctx.baselineDiff);
  return renderPrompt(
    "run.review",
    {
      ticket: ticketLabel(ticket),
      key: ticket.key,
      spec: specOf(ticket),
      specRevision: String(ticket.specRevision ?? 1),
      baselineRevision: ctx.baselineRevision ? String(ctx.baselineRevision) : "",
      baselineDiff: ctx.baselineDiff ? `${diffFence}diff\n${ctx.baselineDiff}\n${diffFence}` : "",
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
        { ticket: label, branch: v.branch, baseBranch: v.baseBranch, onBase: v.onBase, ownsWorktree: v.ownsWorktree, isHarnessBranch: v.isHarnessBranch, instructions: text },
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
