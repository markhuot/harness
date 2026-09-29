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

import type { CompletionAction, Project, RunKind, Session, Summary, SummaryAttachment, Ticket, TicketStatus } from "@harness/shared";
import { harnessBranch, plannedBranch, resolveBaseBranch } from "@harness/shared";
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

function ticketLabel(t: Pick<Ticket, "key" | "title">): string {
  return `${t.key} ${quote(t.title)}`;
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n");
}

/** A backtick fence longer than any backtick run in `text`, so the text can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function briefOf(ticket: Ticket): string {
  return ticket.description.trim() || "(no description; the title is the whole brief)";
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
  const reviews = t.status === "review" ? `, agent review ${t.agentReview}, your review ${t.humanReview}` : t.skipAgentReview ? ", skips the agent review" : "";
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
    case "work":
      return renderPrompt(
        "system.work",
        { branch: ticket?.branch ?? "", skipAgentReview: !!ticket?.skipAgentReview, canSkipReview: project?.requireHumanReview !== false },
        o,
      );
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
        { status: status ?? "", planning: status === "planning", blocked: status === "blocked", review: status === "review", done: status === "done" },
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
  return renderPrompt("system.files", { ...t, canEdit: kind === "work" || kind === "complete" }, o);
}

/**
 * Summaries, with attachments for showing the work. Only work and conductor runs have
 * submit_for_review; complete runs have no browser.
 */
function summariesSection(kind: RunKind, browser: boolean, o: PromptOverrides | null | undefined): string {
  return renderPrompt(
    "system.summaries",
    {
      submits: kind === "work" || kind === "conductor",
      // Mirrors fileOutputScope: these run kinds may only save into their scratch folder.
      readOnly: kind === "plan" || kind === "review" || kind === "chat",
      browser,
    },
    o,
  );
}

export function systemPrompt(info: PromptInfo): string {
  const { kind, ticket } = info;
  const o = info.overrides;
  const ticketRun = kind !== "triage";
  const browser = kind === "plan" || kind === "work" || kind === "review" || kind === "conductor" || kind === "chat";
  const changes = kind === "work" || kind === "conductor";
  return join(
    renderPrompt("system.intro", {}, o),
    contextSection(info, o),
    ticketRun && renderPrompt("system.lifecycle", {}, o),
    instructionsSection(info, o),
    // A task ticket that has taken children conducts them too; conductor runs list theirs in their instructions.
    kind === "work" &&
      !!info.children?.length &&
      renderPrompt("system.children", { children: info.children.map(childLine).join("\n"), branch: ticket?.branch ?? "" }, o),
    // update_branch (tools/ticket.ts): work and conductor runs of a ticket with a worktree.
    changes &&
      !!ticket?.branch &&
      renderPrompt("system.branches", { branch: ticket.branch, baseBranch: branchesOf(ticket, info.project, info.branches).base }, o),
    ticketRun && filesSection(kind, info.builtinTools ?? true, o),
    ticketRun && summariesSection(kind, browser, o),
    // Read-only board tools, given to every run kind (tools/board.ts).
    renderPrompt("system.board", {}, o),
    // Board tools that change other tickets (tools/board-write.ts).
    changes && renderPrompt("system.board_changes", { conductor: kind === "conductor" }, o),
    // Config tools (tools/config.ts): reads for every run; the gated writes where a human can approve them.
    renderPrompt("system.config", { canChange: changes }, o),
    (kind === "work" || kind === "complete" || kind === "conductor") && renderPrompt("system.approvals", { canBlock: kind === "work" }, o),
    browser && renderPrompt("system.browser", {}, o),
  );
}

// ---------------------------------------------------------------------------
// Run prompts (the "user" message of a run)
// ---------------------------------------------------------------------------

/** First work (or conductor) run after the plan is approved. */
export function workStartPrompt(ticket: Ticket, overrides?: PromptOverrides | null): string {
  const id = ticket.kind === "conductor" ? "run.conductor_start" : "run.work_start";
  return renderPrompt(id, { ticket: ticketLabel(ticket), brief: briefOf(ticket) }, overrides);
}

const AUTHOR_LABEL: Record<Summary["author"], string> = { agent: "agent", human: "human", system: "system" };

/** A summary's attachments as lines naming the stored copy, for agents to open with a file tool. */
function attachmentLines(s: Summary, pathOf: (a: SummaryAttachment) => string): string {
  if (!s.attachments?.length) return "";
  return `\nAttachments:\n${s.attachments.map((a) => `* ${a.name} (${a.kind}): ${pathOf(a)}`).join("\n")}`;
}

export function reviewPrompt(
  ticket: Ticket,
  summaries: Summary[],
  attachmentPath: (a: SummaryAttachment) => string = (a) => a.id,
  overrides?: PromptOverrides | null,
): string {
  const ordered = [...summaries].sort((a, b) => a.createdAt - b.createdAt);
  const log = ordered
    .map((s, i) => `${i + 1}. [${AUTHOR_LABEL[s.author]}, ${new Date(s.createdAt).toISOString()}]\n${s.body.trim()}${attachmentLines(s, attachmentPath)}`)
    .join("\n\n");
  return renderPrompt("run.review", { ticket: ticketLabel(ticket), brief: briefOf(ticket), summaries: log.trim() }, overrides);
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
    case "custom":
      return renderPrompt("run.complete_custom", { ticket: label, branch: v.branch, instructions: text }, overrides);
    case "merge":
      return renderPrompt("run.complete_merge", { ticket: label, ...v, instructions: text }, overrides);
  }
}

export function conductorUpdatePrompt(
  changes: { key: string; title: string; from: TicketStatus; to: TicketStatus; summary?: string }[],
  overrides?: PromptOverrides | null,
): string {
  const lines = changes.map((c, i) => {
    const head = `${i + 1}. ${c.key} ${quote(c.title)}: ${c.from} → ${c.to}`;
    return c.summary?.trim() ? `${head}\n   Summary: ${c.summary.trim().replace(/\n/g, "\n   ")}` : head;
  });
  return renderPrompt("run.conductor_update", { changes: lines.join("\n") }, overrides);
}

export function changesRequestedPrompt(notes: string, by: "agent" | "human" | "conductor", overrides?: PromptOverrides | null): string {
  return renderPrompt(
    "run.changes_requested",
    { notes: notes.trim(), byAgent: by === "agent", byHuman: by === "human", byConductor: by === "conductor" },
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
    /** Local tickets whose keys appear in the output */
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
      existingTickets: existingTickets.map((t) => `* ${ticketLabel(t)}, status ${t.status}`).join("\n"),
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
    reviewPrompt: (ticket: Ticket, summaries: Summary[], attachmentPath?: (a: SummaryAttachment) => string) =>
      reviewPrompt(ticket, summaries, attachmentPath, overrides),
    completePrompt: (ticket: Ticket, instructions?: string, branches?: BranchContext, project: Project | null = null) =>
      completePrompt(ticket, instructions, branches, project, overrides),
    conductorUpdatePrompt: (changes: Parameters<typeof conductorUpdatePrompt>[0]) => conductorUpdatePrompt(changes, overrides),
    changesRequestedPrompt: (notes: string, by: "agent" | "human" | "conductor") => changesRequestedPrompt(notes, by, overrides),
    reopenPrompt: (ticket: Ticket, notes: string, base?: string) => reopenPrompt(ticket, notes, base, overrides),
    triagePrompt: (input: Parameters<typeof triagePrompt>[0]) => triagePrompt(input, overrides),
  };
}
