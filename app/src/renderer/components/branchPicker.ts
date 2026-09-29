// Pure parts of the branch combobox (BranchSelect.tsx) and the branch fields around it: the rows
// its popover shows for a query, the key a new ticket will get, what an inherited base branch reads
// like, and the hint under a picked ticket branch. The service filters the branch list itself
// (GET /projects/:id/branches?q=); these only arrange what it returns.

import type { BranchInfo, Project } from "@harness/shared";
import { branchNameError, harnessBranch, type BaseBranchSource } from "@harness/shared";

export type BranchRow =
  /** The null pick: harness/<key> for a ticket branch, the inherited value for a base branch */
  | { kind: "default"; value: null; label: string }
  | { kind: "branch"; value: string; label: string; info: BranchInfo }
  /** A typed name the list doesn't have */
  | { kind: "new"; value: string; label: string }
  /** A typed name git wouldn't accept (not pickable) */
  | { kind: "invalid"; value: null; label: string };

/**
 * The popover's rows for `query`: the default first (hidden while a query is typed unless every
 * word of it is in the default's label), then the service's matches, then the typed name itself
 * when the list doesn't have it exactly: a "new" row (labelled by `newLabel`) or, when git would
 * refuse the name, an "invalid" row saying why.
 */
export function branchRows(branches: BranchInfo[], query: string, defaultLabel: string, newLabel: (name: string) => string): BranchRow[] {
  const q = query.trim();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: BranchRow[] = [];
  const def = defaultLabel.toLowerCase();
  if (words.every((w) => def.includes(w))) rows.push({ kind: "default", value: null, label: defaultLabel });
  for (const b of branches) rows.push({ kind: "branch", value: b.name, label: b.name, info: b });
  if (q && !branches.some((b) => b.name === q)) {
    const error = branchNameError(q);
    rows.push(error ? { kind: "invalid", value: null, label: `Not a branch name: ${error}` } : { kind: "new", value: q, label: newLabel(q) });
  }
  return rows;
}

/** Row ids for the active option: the default is "", a branch its name. Invalid rows have none. */
export function rowId(row: BranchRow): string | null {
  if (row.kind === "invalid") return null;
  return row.value ?? "";
}

/** The pickable rows' ids, in order. */
export function pickableIds(rows: BranchRow[]): string[] {
  return rows.flatMap((r) => {
    const id = rowId(r);
    return id === null ? [] : [id];
  });
}

/**
 * The key the next native ticket of `project` gets: KEY-nextSeq, skipping keys already taken (the
 * service does the same in takeNextKey). A prediction: another ticket created first takes it.
 */
export function predictedTicketKey(project: Pick<Project, "key" | "nextSeq">, isTaken: (key: string) => boolean = () => false): string {
  let seq = project.nextSeq;
  while (isTaken(`${project.key}-${seq}`)) seq++;
  return `${project.key}-${seq}`;
}

/** The default ticket-branch option: "New branch harness/<key>". */
export function newTicketBranchLabel(key: string): string {
  return `New branch ${harnessBranch(key)}`;
}

const SOURCE_LABEL: Record<BaseBranchSource, string> = { ticket: "ticket", project: "project default", settings: "app default" };

/** What an empty base-branch field inherits, e.g. "main (app default)" or "develop (project default)". */
export function inheritedBaseLabel(resolved: { branch: string; source: BaseBranchSource }): string {
  return `${resolved.branch} (${SOURCE_LABEL[resolved.source]})`;
}

/**
 * The line under a picked ticket branch. `info` is the picked branch's list entry (undefined for a
 * typed name the list didn't have); `path` shortens a worktree path for display.
 */
export function ticketBranchHint(branch: string | null, info: BranchInfo | undefined, base: string, path: (p: string) => string = (p) => p): { text: string; warn: boolean } {
  if (branch === null) return { text: `A new branch, created from ${base} when work starts.`, warn: false };
  if (!info) return { text: `A new branch, created from ${base} when work starts.`, warn: false };
  if (info.checkedOutAt) return { text: `Checked out at ${path(info.checkedOutAt)}. The ticket will block when it starts unless that worktree lets go of it.`, warn: true };
  return { text: "An existing branch: the ticket's worktree checks it out as is.", warn: false };
}
