// Branch fields in the apps (the branch pickers on New session and ticket details, base-branch
// fields in settings, project settings and ticket details): the rows a picker shows for a query,
// the predicted harness/<key> branch, what a chosen name will do, and the "inherits" label. The
// service filters the branch list itself (GET /projects/:id/branches?q=); these only arrange what
// it returns. The rules themselves live in ../branches.

import { branchNameError, harnessBranch, type BaseBranchSource } from "../branches";
import type { BranchInfo, Project, Ticket } from "../protocol";
import { tildify } from "./format";

/**
 * The key the project's next native ticket will get: <KEY>-<nextSeq>, skipping keys already taken
 * (the service does the same). A prediction: another client may create a ticket first.
 */
export function predictedTicketKey(project: Pick<Project, "key" | "nextSeq">, isTaken: (key: string) => boolean = () => false): string {
  let n = project.nextSeq;
  while (isTaken(`${project.key}-${n}`)) n++;
  return `${project.key}-${n}`;
}

/** The default ticket-branch option: "New branch harness/<key>". */
export function newTicketBranchLabel(key: string): string {
  return `New branch ${harnessBranch(key)}`;
}

const SOURCE_LABEL: Record<BaseBranchSource, string> = { ticket: "ticket", parent: "parent ticket's branch", project: "project default", settings: "app default" };

/** What an empty base-branch field inherits, e.g. "main (app default)" or "develop (project default)". */
export function inheritedBaseLabel(resolved: { branch: string; source: BaseBranchSource }): string {
  return `${resolved.branch} (${SOURCE_LABEL[resolved.source]})`;
}

export type BranchRow =
  /** The null pick: harness/<key> for a ticket branch, the inherited value for a base branch */
  | { kind: "default"; value: null; label: string }
  | { kind: "branch"; value: string; label: string; info: BranchInfo }
  /** A typed name the list doesn't have */
  | { kind: "new"; value: string; label: string }
  /** A typed name git wouldn't accept (not pickable) */
  | { kind: "invalid"; value: null; label: string };

/**
 * A picker's rows for `query`: the default first (hidden while a query is typed unless every word
 * of it is in the default's label), then the service's matches in its order, then the typed name
 * itself when the list doesn't have it exactly: a "new" row (labelled by `newLabel`) or, when git
 * would refuse the name, an "invalid" row saying why.
 */
export function branchRows(branches: readonly BranchInfo[], query: string, defaultLabel: string, newLabel: (name: string) => string): BranchRow[] {
  const q = query.trim();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: BranchRow[] = [];
  const def = defaultLabel.toLowerCase();
  if (words.every((w) => def.includes(w))) rows.push({ kind: "default", value: null, label: defaultLabel });
  for (const b of branches) rows.push({ kind: "branch", value: b.name, label: b.name, info: b });
  if (q && !branches.some((b) => b.name === q)) {
    const error = branchNameError(q);
    rows.push(error ? { kind: "invalid", value: null, label: `Not a valid branch name: ${error}` } : { kind: "new", value: q, label: newLabel(q) });
  }
  return rows;
}

/** A row's id for keyboard focus: the default is "", a branch or new name its name. Invalid rows have none. */
export function rowId(row: BranchRow): string | null {
  if (row.kind === "invalid") return null;
  return row.value ?? "";
}

/** The pickable rows' ids, in order. */
export function pickableIds(rows: readonly BranchRow[]): string[] {
  return rows.flatMap((r) => {
    const id = rowId(r);
    return id === null ? [] : [id];
  });
}

/** What a branch name picked or typed for a ticket will do when its worktree is made. */
export type BranchChoice =
  /** Nothing picked: a new harness/<key> branch from the base */
  | { kind: "default"; name: string }
  /** An existing local branch, checked out as is (blocks while another worktree has it) */
  | { kind: "existing"; name: string; checkedOutAt: string | null }
  /** A name no branch has yet: created from the base */
  | { kind: "new"; name: string }
  | { kind: "invalid"; name: string; error: string }
  /**
   * The branch the project directory itself has checked out: a draft that picks it works right
   * there, with no worktree (only offered while the ticket is a draft; see `branchChoice`).
   */
  | { kind: "checkout"; name: string; path: string };

/** Paths compared as the same directory: trailing slashes don't count. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
}

/** The branch the project directory has checked out, from a branch list (null when it isn't listed). */
export function checkoutBranch(branches: readonly BranchInfo[], projectPath: string | null | undefined): BranchInfo | null {
  return branches.find((b) => samePath(b.checkedOutAt, projectPath)) ?? null;
}

/**
 * Classify `name` (null or blank → the default branch) against the branches the service listed.
 * `known` only needs to include the branch itself when it exists, e.g. the row it was picked from.
 */
export function branchChoice(name: string | null | undefined, defaultName: string, known: readonly BranchInfo[], checkoutPath?: string | null): BranchChoice {
  const n = name?.trim() || defaultName;
  const hit = known.find((b) => b.name === n);
  // `checkoutPath` (the project path) is passed only for a draft: there the project directory's own
  // branch means "no worktree" rather than "blocks on the main checkout".
  if (hit && checkoutPath && samePath(hit.checkedOutAt, checkoutPath)) return { kind: "checkout", name: n, path: hit.checkedOutAt! };
  if (hit) return { kind: "existing", name: n, checkedOutAt: hit.checkedOutAt };
  if (n === defaultName) return { kind: "default", name: n };
  const error = branchNameError(n);
  return error ? { kind: "invalid", name: n, error } : { kind: "new", name: n };
}

/**
 * The line under a ticket's branch field. `base` is the resolved base branch. `tone` is "warn" when
 * the ticket would block (the branch is checked out in another worktree), "error" for a bad name.
 */
export function branchChoiceHint(choice: BranchChoice, base: string): { text: string; tone: "plain" | "warn" | "error" } {
  switch (choice.kind) {
    case "default":
      return { text: `A new branch, created from ${base} when work starts.`, tone: "plain" };
    case "new":
      return { text: `${choice.name} doesn't exist yet. It will be created from ${base} when work starts.`, tone: "plain" };
    case "invalid":
      return { text: `Not a valid branch name: ${choice.error}.`, tone: "error" };
    case "checkout":
      return { text: `Works directly in ${tildify(choice.path)} on ${choice.name}, with no worktree.`, tone: "plain" };
    case "existing":
      return choice.checkedOutAt
        ? { text: `Checked out in ${tildify(choice.checkedOutAt)}. The ticket will block when it starts unless that worktree lets go of it.`, tone: "warn" }
        : { text: "An existing branch: the ticket's worktree checks it out as is.", tone: "plain" };
  }
}

/** Whether the ticket works (or will work) in a worktree of its own, so it has a branch to show. */
export function ticketHasBranch(ticket: Pick<Ticket, "branch" | "useWorktree">, project: Pick<Project, "isGit" | "useWorktrees"> | null | undefined): boolean {
  if (ticket.branch) return true;
  return !!project && project.isGit !== false && (ticket.useWorktree ?? project.useWorktrees);
}

/**
 * Whether the ticket's branch can still be picked (PATCH /tickets/:key `branch`): only before its
 * worktree exists. Afterwards its agent moves it with the update_branch tool.
 */
export function canChangeBranch(ticket: Pick<Ticket, "branch" | "useWorktree" | "workdir" | "status">, project: Pick<Project, "isGit" | "useWorktrees"> | null | undefined): boolean {
  return ticket.status !== "done" && !ticket.workdir && ticketHasBranch(ticket, project);
}
