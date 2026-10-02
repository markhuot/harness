// How an approved ticket's work lands (DESIGN.md "Completion"), shared by the service (which
// validates a choice and picks the completion prompts) and the apps (which build the Approve menu).

import { parentLandingBranch } from "./branches";
import { COMPLETION_ACTIONS, type CompletionAction, type Project, type Ticket } from "./protocol";

type ProjectLike = Pick<Project, "isGit" | "completionAction" | "completionActions" | "pullRequestHost">;
type TicketLike = Pick<Ticket, "completionAction" | "pullRequestUrl" | "hasChanges"> & { baseBranch?: string | null; branch?: string | null };
type ParentLike = { branch?: string | null; status?: string } | null | undefined;

/**
 * The actions a project offers from what its checkout supports: custom only outside git; merge,
 * cleanup and custom in a git repo; pr as well when a pull request can be opened
 * (`pullRequestHost`). Uses the service's list when it sent one.
 */
export function offeredCompletionActions(project: Pick<Project, "isGit" | "completionActions" | "pullRequestHost"> | null | undefined): CompletionAction[] {
  if (project?.completionActions) return project.completionActions;
  if (project?.isGit === false) return ["custom"];
  return project?.pullRequestHost ? ["merge", "pr", "cleanup", "custom"] : ["merge", "cleanup", "custom"];
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

/**
 * Whether the ticket works on its base branch itself (`branch` is the effective base, as on a
 * ticket made to push to an existing pull request's branch): there's nothing to merge or open a
 * pull request from.
 */
export function worksOnBase(ticket: Pick<TicketLike, "branch"> | null | undefined, base: string | null | undefined): boolean {
  return !!ticket?.branch && !!base && ticket.branch === base;
}

/**
 * Whether the ticket has no branch of its own: `branch` is null (not just left out), so it never
 * got a worktree. It worked in the project checkout, or outside git, and there's nothing to merge
 * or open a pull request from.
 */
export function hasNoBranch(ticket: Pick<TicketLike, "branch"> | null | undefined): boolean {
  return ticket?.branch === null;
}

/**
 * Why approving `ticket` has nothing to merge or open a pull request from, or null when it may:
 * it works on its base branch, it has no branch of its own, or the service found no changes in
 * its worktree (`hasChanges` false).
 */
export function nothingToLand(ticket: TicketLike | null | undefined, base: string | null | undefined): string | null {
  if (worksOnBase(ticket, base)) return `this ticket works on its base branch ${base}`;
  if (hasNoBranch(ticket)) return "this ticket has no branch of its own";
  if (ticket?.hasChanges === false) return "this ticket has no changes to land";
  return null;
}

export interface CompletionOptions {
  /** The actions this ticket may complete with, in menu order */
  actions: CompletionAction[];
  /** The one preselected (the Approve button's primary action) */
  defaultAction: CompletionAction;
  /**
   * Set when the ticket is a child that lands on its parent's branch (`parentLandingBranch`: the
   * parent works on a branch of its own and isn't done, and the child sets no base branch of its
   * own): it always merges into that branch (so a conductor stays on one branch), and this is the
   * branch's name.
   */
  parentBranch: string | null;
}

/**
 * What approving `ticket` can do. A child whose parent has a branch only merges into it.
 * Otherwise the project's offered actions; cleanup always among them, since even a worktree with no
 * commits (the work was a database or config change outside git) is worth removing. A ticket on
 * its base branch (`base`, the effective base branch, when the caller knows it), one with no
 * branch of its own, or one with no changes in its worktree (`nothingToLand`) has nothing to merge
 * or open a pull request from, so those two drop out. Preselects
 * the ticket's earlier choice, then pr when the ticket already opened a pull request (so a
 * re-approval updates it), then the project default, then the first action left.
 */
export function completionOptions(ticket: TicketLike | null | undefined, project: ProjectLike | null | undefined, parent?: ParentLike, base?: string | null): CompletionOptions {
  const parentBranch = parentLandingBranch(ticket, parent);
  if (parentBranch) return { actions: ["merge"], defaultAction: "merge", parentBranch };
  const nothing = nothingToLand(ticket, base) !== null;
  const actions = offeredCompletionActions(project).filter((a) => !(nothing && (a === "merge" || a === "pr")));
  const earlier = ticket?.completionAction;
  const projectDefault = projectCompletionDefault(project);
  let defaultAction = actions.includes(projectDefault) ? projectDefault : actions[0] ?? "custom";
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
  base?: string | null,
): { action: CompletionAction; error: null } | { action: null; error: string } {
  const opts = completionOptions(ticket, project, parent, base);
  if (!requested) return { action: opts.defaultAction, error: null };
  if (opts.actions.includes(requested)) return { action: requested, error: null };
  return { action: null, error: completionRefusal(requested, opts, ticket, project, base) };
}

function completionRefusal(action: CompletionAction, opts: CompletionOptions, ticket: TicketLike | null | undefined, project: ProjectLike | null | undefined, base?: string | null): string {
  if (opts.parentBranch) return `this ticket merges into its parent's branch ${opts.parentBranch}, so it can't complete with "${action}"`;
  const offered = offeredCompletionActions(project).includes(action);
  const why = offered ? nothingToLand(ticket, base) : null;
  if (why) return `${why}, so there is nothing to ${action === "pr" ? "open a pull request from" : "merge"}: complete it with "cleanup" or "custom"`;
  if (action === "pr") return `"pr" needs a git remote on a host gh is logged into (run gh auth login)`;
  if (action === "merge" || action === "cleanup") return `"${action}" needs a git repository`;
  return `"${action}" isn't offered here (offered: ${opts.actions.join(", ")})`;
}

/** Menu and button labels for each choice. */
export const COMPLETION_ACTION_LABELS: Record<CompletionAction, string> = {
  merge: "Approve and merge",
  pr: "Approve and open PR",
  cleanup: "Approve and clean up",
  custom: "Approve and…",
};

/** The last, separate choice: approve and mark done without a completion run. */
export const APPROVE_NO_ACTION_LABEL = "Approve and take no action";

/**
 * The Approve button's primary label for the preselected action: a plain "Approve" when custom is
 * the choice (no git: a light wrap-up), else the action's label.
 */
export function approveLabel(opts: CompletionOptions): string {
  if (opts.defaultAction === "custom") return "Approve";
  return COMPLETION_ACTION_LABELS[opts.defaultAction];
}

/**
 * The conductor that approves and lands `ticket` in the human's place: its parent, until the parent
 * is done (a done parent runs no more, so the human takes its children back). The apps disable the
 * Approve button for such a ticket, with `conductorManagedReason` as the tooltip.
 */
export function managingConductor<P extends { key: string; status?: string }>(ticket: { parentId?: string | null } | null | undefined, parent: P | null | undefined): P | null {
  return ticket?.parentId && parent && parent.status !== "done" ? parent : null;
}

/** Why the Approve button is disabled on a conductor-managed ticket. */
export function conductorManagedReason(conductor: { key: string }): string {
  return `Conductor managed: ${conductor.key} approves and lands this ticket`;
}
