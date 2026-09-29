// Branch fields in the apps (the new-session branch picker, base-branch fields in settings, project
// settings and ticket details): the predicted harness/<key> branch, what a chosen name will do,
// the picker's rows and the "inherits" placeholder. The rules themselves live in ../branches.

import { branchNameError, harnessBranch, type BaseBranchSource } from "../branches";
import type { BranchInfo, Project, Ticket } from "../protocol";
import { tildify } from "./format";

/**
 * The key the project's next native ticket will get: <KEY>-<nextSeq>, skipping keys already taken
 * (the service does the same). A prediction: another client may create a ticket first.
 */
export function predictedTicketKey(project: Pick<Project, "key" | "nextSeq">, takenKeys: Iterable<string> = []): string {
  const taken = new Set(takenKeys);
  let n = project.nextSeq;
  while (taken.has(`${project.key}-${n}`)) n++;
  return `${project.key}-${n}`;
}

/** The branch a new ticket gets when none is picked: harness/<predicted key>. */
export function predictedBranch(project: Pick<Project, "key" | "nextSeq">, takenKeys: Iterable<string> = []): string {
  return harnessBranch(predictedTicketKey(project, takenKeys));
}

/** Placeholder for an empty base-branch field: the value it inherits and where that comes from. */
export function inheritedBaseLabel(resolved: { branch: string; source: BaseBranchSource }): string {
  if (resolved.source === "settings") return `${resolved.branch} (app default)`;
  if (resolved.source === "project") return `${resolved.branch} (project)`;
  return resolved.branch;
}

/** What a branch name picked or typed for a ticket will do when its worktree is made. */
export type BranchChoice =
  /** Nothing picked: a new harness/<key> branch from the base */
  | { kind: "default"; name: string }
  /** An existing local branch, checked out as is (blocks while another worktree has it) */
  | { kind: "existing"; name: string; checkedOutAt: string | null }
  /** A name no branch has yet: created from the base */
  | { kind: "new"; name: string }
  | { kind: "invalid"; name: string; error: string };

/**
 * Classify `name` (null or blank → the default branch) against the branches the service listed.
 * `known` only needs to include the branch itself when it exists, e.g. the row it was picked from.
 */
export function branchChoice(name: string | null | undefined, defaultName: string, known: readonly BranchInfo[]): BranchChoice {
  const n = name?.trim() || defaultName;
  const hit = known.find((b) => b.name === n);
  if (hit) return { kind: "existing", name: n, checkedOutAt: hit.checkedOutAt };
  if (n === defaultName) return { kind: "default", name: n };
  const error = branchNameError(n);
  return error ? { kind: "invalid", name: n, error } : { kind: "new", name: n };
}

/** One line under the branch field explaining the choice. `base` is the resolved base branch. */
export function branchChoiceHint(choice: BranchChoice, base: string): string {
  switch (choice.kind) {
    case "default":
      return `A new branch from ${base}.`;
    case "new":
      return `${choice.name} doesn't exist yet. It will be created from ${base}.`;
    case "invalid":
      return `Not a valid branch name: ${choice.error}.`;
    case "existing":
      return choice.checkedOutAt
        ? `Checked out in ${tildify(choice.checkedOutAt)}. The ticket blocks until that worktree lets go of it.`
        : `Works on the existing branch and merges it into ${base}.`;
  }
}

/** A row in the branch picker. `value` is what the ticket's `branch` becomes (null → the default). */
export interface BranchOption {
  value: string | null;
  label: string;
  kind: "default" | "new" | "existing";
  branch?: BranchInfo;
}

/**
 * The picker's rows for `query`: "New branch harness/<key>" first (while the query matches it),
 * then "Create <query>" when the query is a valid name no listed branch has, then the service's
 * matches in its order. `matches` are GET /projects/:id/branches?q=<query> results.
 */
export function branchOptions(query: string, defaultName: string, matches: readonly BranchInfo[]): BranchOption[] {
  const q = query.trim();
  const defaultLabel = `New branch ${defaultName}`;
  const rows: BranchOption[] = [];
  const defaultTaken = matches.some((b) => b.name === defaultName);
  if (!defaultTaken && (!q || defaultLabel.toLowerCase().includes(q.toLowerCase()))) rows.push({ value: null, label: defaultLabel, kind: "default" });
  if (q && q !== defaultName && !matches.some((b) => b.name === q) && !branchNameError(q)) rows.push({ value: q, label: `Create ${q}`, kind: "new" });
  for (const b of matches) rows.push({ value: b.name, label: b.name, kind: "existing", branch: b });
  return rows;
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
