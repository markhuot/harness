// Branch helpers (shared/src/branches.ts) for HarnessKit's Branches.swift.
import type * as P from "../../src/protocol";
import { branchNameError, DEFAULT_BASE_BRANCH, harnessBranch, parentLandingBranch, plannedBranch, resolveBaseBranch } from "../../src/branches";
import { cases } from "../case";
import { Project as projectSamples, Settings as settingsSamples, Ticket as ticketSamples } from "./protocol";

export const defaultBaseBranch = DEFAULT_BASE_BRANCH;

type BaseRef = { baseBranch?: string | null } | null;
type ParentRef = { branch?: string | null; status?: string } | null;

export const parentLandingBranchCases = cases(
  ({ ticket, parent }: { ticket: BaseRef; parent: ParentRef }) => parentLandingBranch(ticket, parent),
  {
    "parent's branch": { ticket: { baseBranch: null }, parent: { branch: "harness/web-1", status: "in_progress" } },
    "parent without status": { ticket: {}, parent: { branch: "harness/web-1" } },
    "no ticket at all": { ticket: null, parent: { branch: "harness/web-1", status: "review" } },
    "empty base branch inherits": { ticket: { baseBranch: "" }, parent: { branch: "harness/web-1" } },
    "ticket's own base branch wins": { ticket: { baseBranch: "release" }, parent: { branch: "harness/web-1" } },
    "parent without a worktree": { ticket: { baseBranch: null }, parent: { branch: null, status: "in_progress" } },
    "parent with empty branch": { ticket: { baseBranch: null }, parent: { branch: "", status: "in_progress" } },
    "done parent": { ticket: { baseBranch: null }, parent: { branch: "harness/web-1", status: "done" } },
    "unknown parent status still counts": { ticket: {}, parent: { branch: "harness/web-1", status: "archived" } },
    "no parent": { ticket: { baseBranch: null }, parent: null },
  },
);

export const resolveBaseBranchCases = cases(
  ({ ticket, project, settings, parent }: { ticket: BaseRef; project: BaseRef; settings: BaseRef; parent?: ParentRef }) =>
    resolveBaseBranch(ticket, project, settings, parent),
  {
    "ticket beats project": { ticket: { baseBranch: "release" }, project: { baseBranch: "staging" }, settings: { baseBranch: "develop" } },
    "null ticket inherits project": { ticket: { baseBranch: null }, project: { baseBranch: "staging" }, settings: { baseBranch: "develop" } },
    "empty strings inherit settings": { ticket: { baseBranch: "" }, project: { baseBranch: "" }, settings: { baseBranch: "develop" } },
    "built-in default": { ticket: null, project: null, settings: {} },
    "null settings": { ticket: null, project: null, settings: null },
    "empty settings branch falls to default": { ticket: {}, project: {}, settings: { baseBranch: "" } },
    "child lands on parent's branch": { ticket: { baseBranch: null }, project: { baseBranch: "develop" }, settings: {}, parent: { branch: "harness/web-1" } },
    "ticket beats parent": { ticket: { baseBranch: "release" }, project: { baseBranch: "develop" }, settings: {}, parent: { branch: "harness/web-1" } },
    "parent without worktree skipped": { ticket: { baseBranch: null }, project: { baseBranch: "develop" }, settings: {}, parent: { branch: null } },
    "parent with empty branch skipped": { ticket: {}, project: { baseBranch: "develop" }, settings: {}, parent: { branch: "" } },
    "done parent skipped": { ticket: { baseBranch: null }, project: { baseBranch: "develop" }, settings: {}, parent: { branch: "harness/web-1", status: "done" } },
    "review parent still counts": { ticket: {}, project: {}, settings: { baseBranch: "trunk" }, parent: { branch: "harness/web-1", status: "review" } },
    "done parent, no project: settings": { ticket: {}, project: null, settings: { baseBranch: "trunk" }, parent: { branch: "harness/web-1", status: "done" } },
  },
);

// The same resolution over real protocol entities, so the Ticket/Project/Settings overloads are
// checked against how those types decode (Patch fields, explicit nulls, missing keys).
const [fullTicket, plainTicket, nullTicket] = ticketSamples as [P.Ticket, P.Ticket, P.Ticket];
const [fullProject, plainProject] = projectSamples as [P.Project, P.Project];
const [fullSettings, plainSettings] = settingsSamples as [P.Settings, P.Settings];

type EntityInput = { ticket: P.Ticket | null; project: P.Project | null; settings: P.Settings | null; parent: P.Ticket | null };

export const resolveBaseBranchEntityCases = cases(
  ({ ticket, project, settings, parent }: EntityInput) => resolveBaseBranch(ticket, project, settings, parent),
  {
    "ticket override": { ticket: fullTicket, project: fullProject, settings: fullSettings, parent: null },
    "plain ticket, project override": { ticket: plainTicket, project: fullProject, settings: fullSettings, parent: null },
    "null-field ticket, plain project, settings": { ticket: nullTicket, project: plainProject, settings: { ...fullSettings, baseBranch: "trunk" }, parent: null },
    "old settings without baseBranch": { ticket: plainTicket, project: plainProject, settings: plainSettings, parent: null },
    "child of a working parent": { ticket: plainTicket, project: fullProject, settings: fullSettings, parent: { ...fullTicket, status: "in_progress" } },
    "child of a done parent": { ticket: plainTicket, project: fullProject, settings: fullSettings, parent: { ...fullTicket, status: "done" } },
    "parent without a worktree": { ticket: plainTicket, project: plainProject, settings: fullSettings, parent: plainTicket },
    "nothing at all": { ticket: null, project: null, settings: null, parent: null },
  },
);

export const parentLandingBranchEntityCases = cases(({ ticket, parent }: { ticket: P.Ticket | null; parent: P.Ticket | null }) => parentLandingBranch(ticket, parent), {
  "plain child of a working parent": { ticket: plainTicket, parent: fullTicket },
  "child with its own base": { ticket: fullTicket, parent: { ...fullTicket, key: "NYTIMES-30" } },
  "done parent": { ticket: plainTicket, parent: { ...fullTicket, status: "done" } },
  "parent without a worktree": { ticket: nullTicket, parent: plainTicket },
  "no parent": { ticket: plainTicket, parent: null },
});

export const harnessBranchCases = cases(harnessBranch, {
  "lower-cased": "WEB-3",
  "already lower": "web-3",
  "mixed case": "MyApp-12",
  "non-ASCII upper case": "ÉCOLE-1",
  "final sigma": "ΟΔΟΣ-1",
  "lone sigma isn't final": "Σ-1",
  "inner sigma isn't final": "ΑΣΑ-1",
  "sigma then a case-ignorable mark": "ΑΣ́-1",
  "sigma after a case-ignorable mark": "ΆΣ",
  "sigma before a mark then a letter": "ΑΣ́Α",
  "dotted capital I": "İ-1",
  empty: "",
});

type PlannedInput = { key: string; branch: string | null; requestedBranch?: string | null };

export const plannedBranchCases = cases((t: PlannedInput) => plannedBranch(t), {
  "worktree branch wins": { key: "WEB-3", branch: "feature/x", requestedBranch: "other" },
  "requested branch": { key: "WEB-3", branch: null, requestedBranch: "medl-1223-ai-app" },
  "harness default": { key: "WEB-3", branch: null, requestedBranch: null },
  "requested branch missing": { key: "WEB-3", branch: null },
  // ?? only skips null/undefined: an empty branch is used as is.
  "empty worktree branch kept": { key: "WEB-3", branch: "", requestedBranch: "other" },
  "empty requested branch kept": { key: "WEB-3", branch: null, requestedBranch: "" },
});

export const plannedBranchEntityCases = cases(plannedBranch, {
  "full ticket": fullTicket,
  "plain ticket": plainTicket,
  "requested branch only": { ...plainTicket, requestedBranch: "feature/y" },
  "explicit null requested branch": nullTicket,
});

export const branchNameErrorCases = cases(branchNameError, {
  // Valid (from branches.test.ts plus a few more)
  main: "main",
  "feature/login": "feature/login",
  "medl-1223-ai-app": "medl-1223-ai-app",
  "harness/web-3": "harness/web-3",
  "v1.2": "v1.2",
  "a@b": "a@b",
  "x.locked": "x.locked",
  "trailing @": "a@",
  "inner dash": "a-",
  "non-ASCII": "café/naïve",
  emoji: "feat/🚀",
  "lock in the middle": "x.lockfile/y",
  "lone dot inside a name": "a.b/c.d",
  "DEL-adjacent ASCII": "a}b|c",
  "NEL is not a control char here": "a\u0085b",
  // Invalid
  empty: "",
  "@": "@",
  HEAD: "HEAD",
  "lower-case head is fine": "head",
  "starts with -": "-x",
  "starts with /": "/x",
  "ends with /": "x/",
  "ends with .": "x.",
  "//": "a//b",
  "..": "a..b",
  "@{": "a@{1}",
  space: "a b",
  tilde: "a~1",
  caret: "a^",
  colon: "a:b",
  question: "a?",
  star: "a*",
  bracket: "a[b",
  backslash: "a\\b",
  tab: "a\tb",
  nul: "a\u0000b",
  del: "a\u007fb",
  "unit separator": "a\u001fb",
  ".hidden": ".hidden",
  "x/.y": "x/.y",
  "x.lock": "x.lock",
  "x.lock/y": "x.lock/y",
  ".lock alone": ".lock",
  // Combining marks attach to the previous character in Swift; JS checks code units.
  "dash then combining mark": "-́x",
  "dot then combining mark ends the name": "x́.",
  "slash then combining mark": "a/́",
  "dot-led part with combining mark": "x/.́y",
  "double slash before combining mark": "a//́b",
  "trailing dot after combining mark": "a.́",
  "CRLF": "a\r\nb",
  "rule order: leading dash beats space": "-a b",
  "rule order: .. beats bad char": "a..b c",
});
