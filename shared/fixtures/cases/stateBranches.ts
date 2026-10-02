// Branch-picker helpers (shared/src/state/branches.ts) for HarnessKit's State/BranchRows.swift.
// Covers every case in shared/src/state/branches.test.ts plus JS-semantics edges: code-unit string
// equality (NFC vs NFD names), JS whitespace (NBSP trims, NEL doesn't), trailing-slash paths.
import type { BaseBranchSource } from "../../src/branches";
import type { BranchInfo, Project, Ticket, TicketStatus } from "../../src/protocol";
import {
  branchChoice,
  branchChoiceHint,
  branchRows,
  canChangeBranch,
  checkoutBranch,
  inheritedBaseLabel,
  newTicketBranchLabel,
  pickableIds,
  predictedTicketKey,
  rowId,
  samePath,
  ticketHasBranch,
  type BranchChoice,
} from "../../src/state/branches";
import { blankDraftTicket } from "../../src/state/drafts";
import { cases } from "../case";

const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 1, checkedOutAt });
const nfc = "café";
const nfd = "café";

export const predictedTicketKeyCases = cases(
  ({ key, nextSeq, taken }: { key: string; nextSeq: number; taken: string[] }) => predictedTicketKey({ key, nextSeq }, (k) => taken.includes(k)),
  {
    "nothing taken": { key: "WEB", nextSeq: 4, taken: [] },
    "skips taken keys up to the first gap": { key: "WEB", nextSeq: 4, taken: ["WEB-4", "WEB-5", "WEB-7"] },
    "other projects' keys don't count": { key: "WEB", nextSeq: 1, taken: ["API-1", "WEB-2"] },
  },
);

export const newTicketBranchLabelCases = cases(newTicketBranchLabel, {
  "lower-cases the key": "WEB-4",
  "already lower": "web-12",
});

export const inheritedBaseLabelCases = cases(inheritedBaseLabel, {
  settings: { branch: "main", source: "settings" as BaseBranchSource },
  project: { branch: "develop", source: "project" as BaseBranchSource },
  ticket: { branch: "release", source: "ticket" as BaseBranchSource },
  parent: { branch: "harness/web-1", source: "parent" as BaseBranchSource },
});

type RowsInput = { branches: BranchInfo[]; query: string; defaultLabel: string; newPrefix: string };
const rows = ({ branches, query, defaultLabel, newPrefix }: RowsInput) => branchRows(branches, query, defaultLabel, (n) => `${newPrefix}${n}`);

const rowInputs: Record<string, RowsInput> = {
  "no query: the default, then every branch, no new row": { branches: [b("main"), b("develop")], query: "", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "a query hides the default and offers the typed name last": { branches: [b("medl-1223-ai-app")], query: "medl", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "a query in the default's label keeps it": { branches: [], query: "harness", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "every word must be in the default's label": { branches: [], query: "new web", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "a word missing from the label hides it; spaces make it invalid": { branches: [], query: "new zzz", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "an exact match (after trimming) isn't offered again": { branches: [b("develop"), b("develop-2")], query: " develop ", defaultLabel: "x", newPrefix: "Create " },
  "a name git refuses is an invalid row": { branches: [], query: "feat..x", defaultLabel: "x", newPrefix: "Create " },
  "upper-case query matches the label case-insensitively": { branches: [], query: "HARNESS", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "whitespace-only query is no query": { branches: [b("main")], query: " \t ", defaultLabel: "Default", newPrefix: "Create " },
  "NEL is not whitespace in JS": { branches: [], query: "\u0085", defaultLabel: "Default", newPrefix: "Create " },
  "tab-separated words": { branches: [], query: "new\tbranch", defaultLabel: "New branch harness/web-4", newPrefix: "Create " },
  "NFD query isn't the NFC branch": { branches: [b(nfc)], query: nfd, defaultLabel: "Default", newPrefix: "Create " },
  "NFC query matches the NFC branch": { branches: [b(nfc)], query: nfc, defaultLabel: "Default", newPrefix: "Create " },
  "branch info passes through": { branches: [b("main", "/Users/me/web"), b("feat")], query: "", defaultLabel: "Default", newPrefix: "+ " },
  "pickable ids with a query": { branches: [b("main")], query: "ma", defaultLabel: "Default", newPrefix: "Create " },
};

export const branchRowsCases = cases(rows, rowInputs);

export const pickableIdsCases = cases(
  pickableIds,
  Object.fromEntries(Object.entries(rowInputs).map(([name, input]) => [name, rows(input)])),
);

export const rowIdCases = cases(rowId, {
  default: { kind: "default", value: null, label: "Default" },
  branch: { kind: "branch", value: "main", label: "main", info: b("main") },
  new: { kind: "new", value: "feat", label: "Create feat" },
  invalid: { kind: "invalid", value: null, label: "Not a valid branch name: x" },
} as const);

export const samePathCases = cases(({ a, b }: { a?: string | null; b?: string | null }) => samePath(a, b), {
  "trailing slash doesn't count": { a: "/Users/me/web/", b: "/Users/me/web" },
  "many trailing slashes": { a: "/Users/me/web///", b: "/Users/me/web" },
  "a prefix isn't the same": { a: "/Users/me/web2", b: "/Users/me/web" },
  "root and slashes": { a: "/", b: "///" },
  "empty is never the same": { a: "", b: "" },
  "null": { a: null, b: "/x" },
  "missing": { b: "/x" },
  "inner double slash counts": { a: "/a//b", b: "/a/b" },
  "NFC vs NFD": { a: `/Users/me/${nfc}`, b: `/Users/me/${nfd}` },
});

export const checkoutBranchCases = cases(({ branches, projectPath }: { branches: BranchInfo[]; projectPath?: string | null }) => checkoutBranch(branches, projectPath), {
  "the branch the project directory has": { branches: [b("dev", "/tmp/wt"), b("main", "/Users/me/web/")], projectPath: "/Users/me/web" },
  "first match wins": { branches: [b("a", "/w"), b("b", "/w/")], projectPath: "/w" },
  "none listed": { branches: [b("dev", "/tmp/wt"), b("main")], projectPath: "/Users/me/web" },
  "no project path": { branches: [b("main", "/Users/me/web")], projectPath: null },
});

type ChoiceInput = { name?: string | null; defaultName: string; known: BranchInfo[]; checkoutPath?: string | null };
const known = [b("main", "/Users/me/app"), b("feature/x")];
export const branchChoiceCases = cases(({ name, defaultName, known, checkoutPath }: ChoiceInput) => branchChoice(name, defaultName, known, checkoutPath), {
  "null is the default": { name: null, defaultName: "harness/web-4", known },
  "missing is the default": { defaultName: "harness/web-4", known },
  "blank is the default": { name: "  ", defaultName: "harness/web-4", known },
  "NBSP-only is the default": { name: " ", defaultName: "harness/web-4", known },
  "a listed name is existing": { name: "feature/x", defaultName: "harness/web-4", known },
  "a listed checked-out name is existing with its path": { name: "main", defaultName: "harness/web-4", known },
  "unlisted, trimmed: new": { name: " feature/y ", defaultName: "harness/web-4", known },
  "a bad name is invalid": { name: "bad name", defaultName: "harness/web-4", known },
  "a stale harness branch is checked out as is": { name: null, defaultName: "harness/web-4", known: [b("harness/web-4")] },
  "the default name typed out is still the default": { name: "harness/web-4", defaultName: "harness/web-4", known },
  "a draft picking the project directory's branch: checkout": { name: "main", defaultName: "harness/web-4", known, checkoutPath: "/Users/me/app/" },
  "a draft picking a branch checked out elsewhere: existing": { name: "main", defaultName: "harness/web-4", known, checkoutPath: "/Users/me/other" },
  "a draft picking an unchecked-out branch: existing": { name: "feature/x", defaultName: "harness/web-4", known, checkoutPath: "/Users/me/app" },
  "NFD name isn't the NFC branch": { name: nfd, defaultName: "harness/web-4", known: [b(nfc)] },
  "NEL isn't trimmed, and git takes it": { name: "\u0085x", defaultName: "harness/web-4", known },
});

const hint = ({ choice, base }: { choice: BranchChoice; base: string }) => branchChoiceHint(choice, base);
export const branchChoiceHintCases = cases(hint, {
  default: { choice: { kind: "default", name: "harness/web-4" }, base: "develop" },
  new: { choice: { kind: "new", name: "feature/y" }, base: "main" },
  "existing, checked out elsewhere warns with a tildified path": { choice: { kind: "existing", name: "x", checkedOutAt: "/Users/me/wt/x" }, base: "main" },
  "existing, checked out outside /Users": { choice: { kind: "existing", name: "x", checkedOutAt: "/tmp/wt/x" }, base: "main" },
  "existing, free": { choice: { kind: "existing", name: "x", checkedOutAt: null }, base: "main" },
  "existing, empty path is free": { choice: { kind: "existing", name: "x", checkedOutAt: "" }, base: "main" },
  invalid: { choice: { kind: "invalid", name: "a b", error: "no spaces" }, base: "main" },
  "checkout tildifies the home directory itself": { choice: { kind: "checkout", name: "main", path: "/Users/me" }, base: "main" },
  "checkout under /Usersx isn't home": { choice: { kind: "checkout", name: "main", path: "/Usersx/me/web" }, base: "main" },
  "checkout in a home dir": { choice: { kind: "checkout", name: "main", path: "/Users/me/web/" }, base: "main" },
});

const proj = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", key: "WEB", name: "web", path: "/Users/me/web", nextSeq: 4, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null, skipAgentReview: false, skipHumanReview: false, createdAt: 0, updatedAt: 0, ...over }) as Project;
const ticket = (over: Partial<Ticket> = {}): Ticket => ({ ...blankDraftTicket(proj(), null, "WEB-4", 1), draft: false, ...over });
const git = proj();
const noGit = proj({ isGit: false });
const noWt = proj({ useWorktrees: false });
const { isGit: _drop, ...gitUnknownProject } = proj();
const gitUnknown = gitUnknownProject as Project;

type BranchTicketInput = { ticket: Ticket; project: Project | null };
const branchTicketInputs: Record<string, BranchTicketInput> = {
  "fresh worktree ticket": { ticket: ticket(), project: git },
  "worktree exists": { ticket: ticket({ workdir: "/wt/WEB-4", branch: "harness/web-4", status: "in_progress" }), project: git },
  done: { ticket: ticket({ status: "done" as TicketStatus }), project: git },
  "opted out of a worktree": { ticket: ticket({ useWorktree: false }), project: git },
  "not git": { ticket: ticket(), project: noGit },
  "project doesn't use worktrees": { ticket: ticket(), project: noWt },
  "opted into a worktree": { ticket: ticket({ useWorktree: true }), project: noWt },
  "has a branch, project stopped using worktrees": { ticket: ticket({ branch: "x" }), project: noWt },
  "no project": { ticket: ticket(), project: null },
  "no project but a branch": { ticket: ticket({ branch: "x" }), project: null },
  "empty branch is no branch": { ticket: ticket({ branch: "" }), project: noWt },
  "isGit unknown counts as git": { ticket: ticket(), project: gitUnknown },
  "workdir without a branch (project checkout)": { ticket: ticket({ workdir: "/Users/me/web", useWorktree: true }), project: noWt },
  "empty workdir doesn't count": { ticket: ticket({ workdir: "" }), project: git },
};

export const ticketHasBranchCases = cases(({ ticket, project }: BranchTicketInput) => ticketHasBranch(ticket, project), branchTicketInputs);
export const canChangeBranchCases = cases(({ ticket, project }: BranchTicketInput) => canChangeBranch(ticket, project), branchTicketInputs);
