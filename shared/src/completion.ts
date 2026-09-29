// How an approved ticket's work lands (DESIGN.md "Completion"), shared by the service (which
// validates a choice and picks the completion prompts) and the apps (which build the Approve menu).

import { COMPLETION_ACTIONS, type CompletionAction, type Project, type Ticket } from "./protocol";

type ProjectLike = Pick<Project, "isGit" | "completionAction" | "completionActions" | "pullRequestHost">;
type TicketLike = Pick<Ticket, "completionAction" | "pullRequestUrl">;
type ParentLike = { branch?: string | null } | null | undefined;

/**
 * The actions a project offers from what its checkout supports: custom only outside git; merge and
 * custom in a git repo; pr as well when a pull request can be opened (`pullRequestHost`). Uses the
 * service's list when it sent one.
 */
export function offeredCompletionActions(project: Pick<Project, "isGit" | "completionActions" | "pullRequestHost"> | null | undefined): CompletionAction[] {
  if (project?.completionActions) return project.completionActions;
  if (project?.isGit === false) return ["custom"];
  return project?.pullRequestHost ? ["merge", "pr", "custom"] : ["merge", "custom"];
}

/** Whether a string from a request is a completion action at all. */
export function isCompletionAction(value: unknown): value is CompletionAction {
  return (COMPLETION_ACTIONS as readonly unknown[]).includes(value);
}

/**
 * A project's effective default: its stored choice while it still offers it, else merge, else
 * custom (a project that lost its gh login or its remote doesn't break).
 */
export function projectCompletionDefault(project: ProjectLike | null | undefined): CompletionAction {
  const offered = offeredCompletionActions(project);
  const stored = project?.completionAction ?? "merge";
  if (offered.includes(stored)) return stored;
  return offered.includes("merge") ? "merge" : offered[0] ?? "custom";
}

export interface CompletionOptions {
  /** The actions this ticket may complete with, in menu order */
  actions: CompletionAction[];
  /** The one preselected (the Approve button's primary action) */
  defaultAction: CompletionAction;
  /**
   * Set when the ticket is a child of a parent working on a branch of its own: it always merges
   * into that branch (so a conductor stays on one branch), and this is the branch's name.
   */
  parentBranch: string | null;
}

/**
 * What approving `ticket` can do. A child whose parent has a branch only merges into it. Otherwise
 * the project's offered actions, preselecting the ticket's earlier choice, then pr when the ticket
 * already opened a pull request (so a re-approval updates it), then the project default.
 */
export function completionOptions(ticket: TicketLike | null | undefined, project: ProjectLike | null | undefined, parent?: ParentLike): CompletionOptions {
  if (parent?.branch) return { actions: ["merge"], defaultAction: "merge", parentBranch: parent.branch };
  const actions = offeredCompletionActions(project);
  const earlier = ticket?.completionAction;
  let defaultAction = projectCompletionDefault(project);
  if (earlier && actions.includes(earlier)) defaultAction = earlier;
  else if (ticket?.pullRequestUrl && actions.includes("pr")) defaultAction = "pr";
  return { actions, defaultAction, parentBranch: null };
}

/**
 * The action a completion uses: `requested` when given (null plus the reason when the ticket
 * doesn't offer it), else the preselected one.
 */
export function resolveCompletionAction(
  requested: CompletionAction | null | undefined,
  ticket: TicketLike | null | undefined,
  project: ProjectLike | null | undefined,
  parent?: ParentLike,
): { action: CompletionAction; error: null } | { action: null; error: string } {
  const opts = completionOptions(ticket, project, parent);
  if (!requested) return { action: opts.defaultAction, error: null };
  if (opts.actions.includes(requested)) return { action: requested, error: null };
  return { action: null, error: completionRefusal(requested, opts) };
}

function completionRefusal(action: CompletionAction, opts: CompletionOptions): string {
  if (opts.parentBranch) return `this ticket merges into its parent's branch ${opts.parentBranch}, so it can't complete with "${action}"`;
  if (action === "pr") return `"pr" needs a git remote on a host gh is logged into (run gh auth login)`;
  if (action === "merge") return `"merge" needs a git repository`;
  return `"${action}" isn't offered here (offered: ${opts.actions.join(", ")})`;
}

/** Menu and button labels for each choice. */
export const COMPLETION_ACTION_LABELS: Record<CompletionAction, string> = {
  merge: "Approve and merge",
  pr: "Approve and open PR",
  custom: "Approve and…",
};

/** The last, separate choice: approve and mark done without a completion run. */
export const APPROVE_NO_ACTION_LABEL = "Approve and take no action";

/**
 * The Approve button's primary label for the preselected action: "Approve and merge into
 * harness/web-1" for a child on its parent's branch, a plain "Approve" when custom is the only
 * choice (no git: a light wrap-up), else the action's label.
 */
export function approveLabel(opts: CompletionOptions): string {
  if (opts.parentBranch) return `Approve and merge into ${opts.parentBranch}`;
  if (opts.defaultAction === "custom") return "Approve";
  return COMPLETION_ACTION_LABELS[opts.defaultAction];
}

/**
 * The Approve menu's choices, in order (merge, pr, then custom as "Approve and…", which asks for
 * instructions). Empty for a child on its parent's branch: it only merges. "Approve and take no
 * action" always follows them, after a separator.
 */
export function approveMenuActions(opts: CompletionOptions): CompletionAction[] {
  return opts.parentBranch ? [] : opts.actions;
}
