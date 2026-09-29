// Git branches, shared by the service and the apps (DESIGN.md "Branches"): the base branch a
// ticket's work merges into, the branch a ticket works on, and branch-name validation.

import type { Ticket } from "./protocol";

/** Where an effective base branch came from. */
export type BaseBranchSource = "ticket" | "parent" | "project" | "settings";

/** The built-in default for settings.baseBranch. */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Resolve the base branch: ticket override → the parent ticket's branch (a child of a parent
 * working in a worktree of its own lands on that branch, so a conductor stays on one branch) →
 * project override → the global setting (default "main"). null and "" inherit. Same shape as
 * resolvePermissionMode.
 */
export function resolveBaseBranch(
  ticket: { baseBranch?: string | null } | null | undefined,
  project: { baseBranch?: string | null } | null | undefined,
  settings: { baseBranch?: string | null } | null | undefined,
  parent?: { branch?: string | null } | null,
): { branch: string; source: BaseBranchSource } {
  if (ticket?.baseBranch) return { branch: ticket.baseBranch, source: "ticket" };
  if (parent?.branch) return { branch: parent.branch, source: "parent" };
  if (project?.baseBranch) return { branch: project.baseBranch, source: "project" };
  return { branch: settings?.baseBranch || DEFAULT_BASE_BRANCH, source: "settings" };
}

/** The branch the harness creates for a ticket when none is chosen: harness/<key, lower-case>. */
export function harnessBranch(key: string): string {
  return `harness/${key.toLowerCase()}`;
}

/**
 * The branch a ticket uses (once its worktree exists: `branch`) or will use when work starts
 * (`requestedBranch`, else harness/<key>). Only meaningful when the ticket gets a worktree.
 */
export function plannedBranch(t: Pick<Ticket, "key" | "branch"> & { requestedBranch?: string | null }): string {
  return t.branch ?? t.requestedBranch ?? harnessBranch(t.key);
}

/**
 * Why `name` isn't a valid branch name, or null when it is. The rules of
 * `git check-ref-format --branch`: no component starts with "." or ends with ".lock"; no "..",
 * "@{", "//", backslash, space, control characters or any of ~ ^ : ? * [; doesn't start with "-"
 * or "/", or end with "/" or "."; isn't "@" or "HEAD".
 */
export function branchNameError(name: string): string | null {
  if (!name) return "a branch name can't be empty";
  if (name === "@" || name === "HEAD") return `"${name}" isn't a branch name`;
  if (name.startsWith("-")) return "a branch name can't start with -";
  if (name.startsWith("/") || name.endsWith("/")) return "a branch name can't start or end with /";
  if (name.endsWith(".")) return "a branch name can't end with .";
  if (name.includes("//")) return "a branch name can't contain //";
  if (name.includes("..")) return "a branch name can't contain ..";
  if (name.includes("@{")) return "a branch name can't contain @{";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "a branch name can't contain spaces, control characters or any of ~ ^ : ? * [ \\";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "no part of a branch name can start with .";
    if (part.endsWith(".lock")) return "no part of a branch name can end with .lock";
  }
  return null;
}
