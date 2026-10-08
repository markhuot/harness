// Draft helpers (shared/src/state/drafts.ts) for HarnessKit's State/Drafts.swift. Covers every
// case in shared/src/state/drafts.test.ts, plus PATCHes with null vs absent fields, JS whitespace
// (NBSP trims, NEL doesn't) and code-unit string equality (NFC vs NFD).
import type { Attachment, BranchInfo, PermissionMode, Project, Ticket, TicketKind, UpdateTicketBody } from "../../src/protocol";
import {
  applyTicketPatch,
  blankDraftTicket,
  draftBranchPatch,
  draftBranchPick,
  draftBranchValue,
  draftCreateBody,
  draftDefaultBranchLabel,
  draftIsEmpty,
  draftPatch,
  draftReviewSkipsPatch,
  draftUsesWorktree,
  newSessionOptionsSummary,
  optionsNeedAttention,
  ticketBranchChoice,
  ticketBranchHint,
  ticketSettingsRows,
  type DraftBranchPick,
} from "../../src/state/drafts";
import { cases } from "../case";

const SHOT: Attachment = { id: "a1", path: "/Users/me/Desktop/shot.png", name: "shot.png", source: "file", kind: "image", mimeType: "image/png" };
const PASTE: Attachment = { id: "a2", path: "/Users/me/.harness/uploads/u1/Pasted image.png", name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png" };

type Settings = { defaultDriver: string; defaultModels: Record<string, string | null>; baseBranch?: string };

const project = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", key: "WEB", name: "web", path: "/Users/me/web", nextSeq: 4, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null, skipAgentReview: false, skipHumanReview: false, createdAt: 0, updatedAt: 0, ...over }) as Project;
const settings: Settings = { defaultDriver: "claude-code", defaultModels: {}, baseBranch: "main" };
const blank = (p = project()) => blankDraftTicket(p, settings, "WEB-4", 1);
const launched = (over: Partial<Ticket> = {}): Ticket => ({ ...blank(), key: "WEB-4", draft: false, ...over });
const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 1, checkedOutAt });
const main = b("main", "/Users/me/web/");
const nfc = "café";
const nfd = "café";

export const blankDraftTicketCases = cases(
  ({ project, settings, key, now }: { project: Project; settings: Settings | null; key: string; now: number }) => blankDraftTicket(project, settings, key, now),
  {
    "the settings' driver": { project: project(), settings, key: "WEB-4", now: 1 },
    "the project's own driver": { project: project({ id: "p2", defaultDriver: "codex" }), settings, key: "API-9", now: 1_700_000_000_000 },
    "an empty project driver falls back to settings": { project: project({ defaultDriver: "" }), settings, key: "WEB-4", now: 5 },
    "no settings and no project driver: empty": { project: project(), settings: null, key: "WEB-4", now: 5 },
    "the project's review defaults": { project: project({ skipAgentReview: true, skipHumanReview: true }), settings, key: "WEB-4", now: 5 },
    "an older service's project: no review skipped": { project: (({ skipAgentReview: _a, skipHumanReview: _h, ...rest }) => rest)(project()) as Project, settings, key: "WEB-4", now: 5 },
  },
);

const skipping = project({ skipAgentReview: true, skipHumanReview: true });
type SkipsInput = { ticket: Ticket; from: Project | null; to: Project | null };
export const draftReviewSkipsPatchCases = cases(({ ticket, from, to }: SkipsInput) => draftReviewSkipsPatch(ticket, from, to), {
  "on the old defaults: follows the new project's": { ticket: blank(skipping), from: skipping, to: project({ id: "p2" }) },
  "into a skipping project": { ticket: blank(), from: project(), to: skipping },
  "a flipped switch stays": { ticket: { ...blank(), skipHumanReview: true }, from: project(), to: skipping },
  "the same defaults: nothing": { ticket: blank(), from: project(), to: project({ id: "p2" }) },
  "one default differs": { ticket: blank(), from: project(), to: project({ id: "p2", skipHumanReview: true }) },
  "no old project counts as skipping nothing": { ticket: blank(), from: null, to: skipping },
  "no new project counts as skipping nothing": { ticket: blank(skipping), from: skipping, to: null },
});

type PatchInput = { ticket: Ticket; patch: UpdateTicketBody };
const withModel = { ...blank(), model: "opus" };
const full = { ...blank(), model: "opus", permissionMode: "ask" as PermissionMode, baseBranch: "develop", requestedBranch: "feat", useWorktree: true, skipAgentReview: true, skipHumanReview: true, dependsOn: ["WEB-1"] };
export const applyTicketPatchCases = cases(({ ticket, patch }: PatchInput) => applyTicketPatch(ticket, patch), {
  "a driver change clears the model": { ticket: withModel, patch: { driver: "codex" } },
  "a phase pick sets that phase, and Work the legacy driver and model": { ticket: withModel, patch: { phaseModels: { work: { driver: "codex", model: "luna" }, complete: { driver: "claude-code", model: "haiku" } } } },
  "clearing Work clears the legacy model": { ticket: { ...withModel, phaseModels: { work: { driver: "claude-code", model: "opus" } } }, patch: { phaseModels: { work: null } } },
  "a driver change keeps a model that comes with it": { ticket: withModel, patch: { driver: "codex", model: "luna" } },
  "a driver change with a null model": { ticket: withModel, patch: { driver: "codex", model: null } },
  "the same driver keeps the model": { ticket: withModel, patch: { driver: "claude-code" } },
  "an empty model is null": { ticket: withModel, patch: { model: "" } },
  "a null model clears it": { ticket: withModel, patch: { model: null } },
  "blank branch names mean the default, and draft-only fields apply": { ticket: blank(), patch: { branch: " ", baseBranch: "", kind: "conductor", useWorktree: false, projectId: "p2" } },
  "branch names are trimmed": { ticket: blank(), patch: { branch: " feat ", baseBranch: " develop " } },
  "NEL isn't trimmed": { ticket: blank(), patch: { branch: "\u0085" } },
  "null clears every nullable field": { ticket: full, patch: { model: null, permissionMode: null, baseBranch: null, branch: null, useWorktree: null } },
  "absent leaves every field alone": { ticket: full, patch: {} },
  "explicit values": { ticket: blank(), patch: { title: "T", spec: "D", permissionMode: "read_only", skipAgentReview: true, skipHumanReview: true, dependsOn: ["WEB-1", "WEB-2"], position: 3.5, useWorktree: true } },
  "false and empty values still apply": { ticket: full, patch: { skipAgentReview: false, skipHumanReview: false, dependsOn: [], title: "", spec: "" } },
  "status isn't applied locally": { ticket: blank(), patch: { status: "done" } },
  "attachments: names default to the file's, source to file": { ticket: blank(), patch: { promptAttachments: [{ path: "/Users/me/a b/notes.pdf" }, { path: "/x/y.png", name: " " }, PASTE] } },
  "attachments cleared": { ticket: { ...blank(), promptAttachments: [SHOT] }, patch: { promptAttachments: [] } },
});

export const draftUsesWorktreeCases = cases(({ ticket, project }: { ticket: Ticket; project: Project | null }) => draftUsesWorktree(ticket, project), {
  "inherits the project's worktrees": { ticket: blank(), project: project() },
  "opted out": { ticket: { ...blank(), useWorktree: false }, project: project() },
  "opted in on a project without": { ticket: { ...blank(), useWorktree: true }, project: project({ useWorktrees: false }) },
  "not git": { ticket: { ...blank(), useWorktree: true }, project: project({ isGit: false }) },
  "no project": { ticket: { ...blank(), useWorktree: true }, project: null },
});

type EmptyInput = { ticket: Ticket; project: Project | null; settings: Settings | null };
const emptyCase = (over: Partial<Ticket>, p: Project | null = project(), s: Settings | null = settings): EmptyInput => ({ ticket: { ...blank(), ...over }, project: p, settings: s });
export const draftIsEmptyCases = cases(({ ticket, project, settings }: EmptyInput) => draftIsEmpty(ticket, project, settings), {
  blank: emptyCase({}),
  "whitespace spec": emptyCase({ spec: "  " }),
  "NBSP spec is whitespace": emptyCase({ spec: " \n" }),
  "NEL spec isn't whitespace": emptyCase({ spec: "\u0085" }),
  spec: emptyCase({ spec: "Fix it" }),
  conductor: emptyCase({ kind: "conductor" as TicketKind }),
  "another driver": emptyCase({ driver: "codex" }),
  model: emptyCase({ model: "sonnet" }),
  "empty model": emptyCase({ model: "" }),
  "permission mode": emptyCase({ permissionMode: "ask" as PermissionMode }),
  "no worktree": emptyCase({ useWorktree: false }),
  "worktree": emptyCase({ useWorktree: true }),
  "requested branch": emptyCase({ requestedBranch: "feat" }),
  "empty requested branch": emptyCase({ requestedBranch: "" }),
  "base branch": emptyCase({ baseBranch: "develop" }),
  "skip review": emptyCase({ skipAgentReview: true }),
  "skip human review": emptyCase({ skipHumanReview: true }),
  "on a skipping project's defaults": { ticket: blank(skipping), project: skipping, settings },
  "a skipping project's review turned back on": { ticket: { ...blank(skipping), skipAgentReview: false }, project: skipping, settings },
  "no project: a skip is an override": emptyCase({ skipHumanReview: true }, null),
  dependencies: emptyCase({ dependsOn: ["WEB-1"] }),
  attachment: emptyCase({ promptAttachments: [SHOT] }),
  "no attachments": emptyCase({ promptAttachments: [] }),
  "attachments missing (older service)": { ticket: (({ promptAttachments: _p, ...rest }) => rest)(blank()) as Ticket, project: project(), settings },
  "no project: the settings' driver": emptyCase({}, null),
  "no project or settings: any driver is an override": emptyCase({}, null, null),
  "project's own driver": emptyCase({ driver: "codex" }, project({ defaultDriver: "codex" })),
});

type CreateInput = { ticket: Ticket; project: Project };
export const draftCreateBodyCases = cases(({ ticket, project }: CreateInput) => draftCreateBody(ticket, project), {
  "a worktree draft sends its branch and base": { ticket: { ...blank(), spec: "Go", requestedBranch: "feat", baseBranch: "develop" }, project: project() },
  "a worktree draft with no branch picks sends nulls": { ticket: { ...blank(), spec: "Go" }, project: project() },
  "no worktree drops branch and base": { ticket: { ...blank(), requestedBranch: "feat", baseBranch: "develop", useWorktree: false }, project: project() },
  "a non-git project sends no worktree choice": { ticket: { ...blank(), useWorktree: true }, project: project({ isGit: false }) },
  "a project without worktrees: no branch keys": { ticket: { ...blank(), requestedBranch: "feat" }, project: project({ useWorktrees: false }) },
  "opting into a worktree sends the branch": { ticket: { ...blank(), useWorktree: true, requestedBranch: "feat" }, project: project({ useWorktrees: false }) },
  "skip review always, dependencies only when set": { ticket: { ...blank(), skipAgentReview: true, dependsOn: ["WEB-1"] }, project: project() },
  "skip human review": { ticket: { ...blank(), skipHumanReview: true }, project: project() },
  "a skipping project's review turned back on is sent as false": { ticket: { ...blank(skipping), skipHumanReview: false }, project: skipping },
  "skip flags missing are sent as false": { ticket: (({ skipAgentReview: _a, skipHumanReview: _h, ...rest }) => rest)(blank()) as Ticket, project: project() },
  "an empty driver is left out": { ticket: { ...blank(), driver: "" }, project: project() },
  "model, permission mode and kind": { ticket: { ...blank(), model: "sonnet", permissionMode: "read_only" as PermissionMode, kind: "conductor" as TicketKind }, project: project() },
  "attachments go as path and name": { ticket: { ...blank(), promptAttachments: [SHOT, PASTE] }, project: project() },
});

type DiffInput = { prev: Ticket; next: Ticket };
const prev = { ...blank(), spec: "a" };
const diff = (over: Partial<Ticket>, base: Ticket = prev): DiffInput => ({ prev: base, next: { ...base, ...over } });
export const draftPatchCases = cases(({ prev, next }: DiffInput) => draftPatch(prev, next), {
  "nothing changed": diff({}),
  "only the changed fields, with branch names mapped": diff({ spec: "ab", requestedBranch: "feat" }),
  "dependencies": diff({ dependsOn: ["WEB-1"] }),
  "same dependencies": { prev: { ...prev, dependsOn: ["WEB-1"] }, next: { ...prev, dependsOn: ["WEB-1"] } },
  "reordered dependencies": { prev: { ...prev, dependsOn: ["WEB-1", "WEB-2"] }, next: { ...prev, dependsOn: ["WEB-2", "WEB-1"] } },
  "a driver change sends the model along": diff({ driver: "codex" }, { ...prev, model: "luna" }),
  "a driver change without a model sends none": diff({ driver: "codex" }),
  "a cleared model is sent as null": diff({ model: null }, { ...prev, model: "luna" }),
  "a phase change sends the per-phase patch instead of driver and model": diff({ driver: "codex", model: "luna", phaseModels: { work: { driver: "codex", model: "luna" } } }),
  "a cleared phase is sent as null": diff({ phaseModels: {} }, { ...prev, phaseModels: { complete: { driver: "claude-code", model: "haiku" } } }),
  "a cleared branch is sent as null": diff({ requestedBranch: null }, { ...prev, requestedBranch: "feat" }),
  "a cleared base is sent as null": diff({ baseBranch: null }, { ...prev, baseBranch: "develop" }),
  "a cleared permission mode is sent as null": diff({ permissionMode: null }, { ...prev, permissionMode: "ask" }),
  "useWorktree back to inherit is sent as null": diff({ useWorktree: null }, { ...prev, useWorktree: false }),
  "useWorktree false": diff({ useWorktree: false }),
  "a missing useWorktree equals null": { prev: (({ useWorktree: _u, ...rest }) => rest)(prev) as Ticket, next: prev },
  "a missing requestedBranch equals null": { prev: (({ requestedBranch: _r, baseBranch: _b, ...rest }) => rest)(prev) as Ticket, next: prev },
  "skipAgentReview missing equals false": { prev: (({ skipAgentReview: _s, ...rest }) => rest)(prev) as Ticket, next: prev },
  "skipAgentReview off": diff({ skipAgentReview: false }, { ...prev, skipAgentReview: true }),
  "skipHumanReview missing equals false": { prev: (({ skipHumanReview: _s, ...rest }) => rest)(prev) as Ticket, next: prev },
  "skipHumanReview on": diff({ skipHumanReview: true }),
  "a new project and kind": diff({ projectId: "p2", kind: "conductor" }),
  "the title isn't sent": diff({ title: "New title" }),
  "NFD spec differs from NFC": { prev: { ...prev, spec: nfc }, next: { ...prev, spec: nfd } },
  "an attachment added sends the whole list": diff({ promptAttachments: [SHOT, PASTE] }, { ...prev, promptAttachments: [SHOT] }),
  "attachments reordered": { prev: { ...prev, promptAttachments: [SHOT, PASTE] }, next: { ...prev, promptAttachments: [PASTE, SHOT] } },
  "same attachments": { prev: { ...prev, promptAttachments: [SHOT] }, next: { ...prev, promptAttachments: [SHOT] } },
  "a renamed attachment": diff({ promptAttachments: [{ ...SHOT, name: "after.png" }] }, { ...prev, promptAttachments: [SHOT] }),
  "missing attachments equal none": { prev: (({ promptAttachments: _p, ...rest }) => rest)(prev) as Ticket, next: prev },
  "all attachments removed": diff({ promptAttachments: [] }, { ...prev, promptAttachments: [SHOT] }),
});

type RowsInput = { ticket: Ticket; project: Project | null };
export const ticketSettingsRowsCases = cases(({ ticket, project }: RowsInput) => ticketSettingsRows(ticket, project), {
  "a draft without a worktree still shows Branch, not Base": { ticket: { ...blank(), useWorktree: false }, project: project() },
  "a worktree draft shows Base": { ticket: blank(), project: project() },
  "no Branch or Base outside git": { ticket: blank(), project: project({ isGit: false }) },
  "no project": { ticket: blank(), project: null },
  "a launched ticket's branch is editable before its worktree": { ticket: launched(), project: project() },
  "and not after": { ticket: launched({ status: "in_progress", workdir: "/w", branch: "harness/web-4" }), project: project() },
  "done: nothing editable": { ticket: launched({ status: "done" }), project: project() },
  "busy: still editable": { ticket: launched({ busy: true, driver: "codex" }), project: project() },
  "a done draft": { ticket: { ...blank(), status: "done" }, project: project() },
  "a launched ticket in the project checkout": { ticket: launched({ useWorktree: false }), project: project() },
  "draft flag missing counts as launched": { ticket: (({ draft: _d, ...rest }) => rest)(blank()) as Ticket, project: project() },
});

export const draftBranchPickCases = cases(({ name, checkout }: { name: string | null; checkout: BranchInfo | null }) => draftBranchPick(name, checkout), {
  "the checkout": { name: "main", checkout: main },
  "another branch": { name: "dev", checkout: main },
  default: { name: null, checkout: main },
  "checkout unknown": { name: "main", checkout: null },
  "empty name is a branch": { name: "", checkout: main },
  "NFD isn't the NFC checkout": { name: nfd, checkout: b(nfc, "/Users/me/web") },
});

export const draftBranchPatchCases = cases(({ pick, project }: { pick: DraftBranchPick; project: Project }) => draftBranchPatch(pick, project), {
  "default": { pick: { kind: "default" }, project: project() },
  "checkout on a worktree project": { pick: { kind: "checkout" }, project: project() },
  "checkout on a direct project": { pick: { kind: "checkout" }, project: project({ useWorktrees: false }) },
  "branch on a worktree project": { pick: { kind: "branch", name: "dev" }, project: project() },
  "branch on a direct project": { pick: { kind: "branch", name: "dev" }, project: project({ useWorktrees: false }) },
});

type ValueInput = { ticket: Ticket; project: Project; checkout: BranchInfo | null };
export const draftBranchValueCases = cases(({ ticket, project, checkout }: ValueInput) => draftBranchValue(ticket, project, checkout), {
  "the checkout picked over worktrees": { ticket: { ...blank(), useWorktree: false }, project: project(), checkout: main },
  "the checkout picked, branch unknown": { ticket: { ...blank(), useWorktree: false }, project: project(), checkout: null },
  "direct project, nothing picked": { ticket: blank(), project: project({ useWorktrees: false }), checkout: main },
  "direct project, useWorktree false": { ticket: { ...blank(), useWorktree: false, requestedBranch: "dev" }, project: project({ useWorktrees: false }), checkout: main },
  "a requested branch": { ticket: { ...blank(), requestedBranch: "dev" }, project: project(), checkout: main },
  "requested branch missing": { ticket: (({ requestedBranch: _r, ...rest }) => rest)(blank()) as Ticket, project: project(), checkout: main },
});

export const draftDefaultBranchLabelCases = cases(
  ({ key, project, checkout }: { key: string; project: Project; checkout: BranchInfo | null }) => draftDefaultBranchLabel(key, project, checkout),
  {
    "a direct project with its checkout": { key: "WEB-4", project: project({ useWorktrees: false }), checkout: main },
    "a direct project, checkout unknown": { key: "WEB-4", project: project({ useWorktrees: false }), checkout: null },
    "a worktree project": { key: "WEB-4", project: project(), checkout: main },
  },
);

type ChoiceInput = { ticket: Ticket; project: Project; known: BranchInfo[]; checkout: BranchInfo | null };
const choiceInputs: Record<string, ChoiceInput> = {
  "a draft on the checkout works in place": { ticket: { ...blank(), useWorktree: false }, project: project(), known: [main], checkout: main },
  "a draft without worktree, checkout unknown": { ticket: { ...blank(), useWorktree: false }, project: project(), known: [], checkout: null },
  "a draft on a non-git project": { ticket: blank(), project: project({ isGit: false }), known: [], checkout: null },
  "a draft picking the checked-out branch by name": { ticket: { ...blank(), requestedBranch: "main" }, project: project(), known: [main], checkout: main },
  "a launched ticket on a branch checked out elsewhere warns": { ticket: launched({ requestedBranch: "main" }), project: project(), known: [main], checkout: main },
  "a draft's default branch": { ticket: blank(), project: project(), known: [main], checkout: main },
  "a launched ticket's new branch": { ticket: launched({ requestedBranch: "feat/y" }), project: project(), known: [main], checkout: main },
  "an invalid requested branch": { ticket: launched({ requestedBranch: "bad name" }), project: project(), known: [], checkout: null },
  "a draft whose base branch is set": { ticket: { ...blank(), baseBranch: "develop" }, project: project({ baseBranch: "staging" }), known: [], checkout: null },
  "project base branch": { ticket: blank(), project: project({ baseBranch: "staging" }), known: [], checkout: null },
};
export const ticketBranchChoiceCases = cases(({ ticket, project, known, checkout }: ChoiceInput) => ticketBranchChoice(ticket, project, known, checkout), choiceInputs);

type HintInput = ChoiceInput & { settings: Settings | null };
export const ticketBranchHintCases = cases(
  ({ ticket, project, settings, known, checkout }: HintInput) => ticketBranchHint(ticket, project, settings, known, checkout),
  {
    ...Object.fromEntries(Object.entries(choiceInputs).map(([name, input]) => [name, { ...input, settings }])),
    "no settings: the built-in base": { ...choiceInputs["a draft's default branch"]!, settings: null },
  },
);

export const optionsNeedAttentionCases = cases(optionsNeedAttention, {
  plain: { tone: "plain" as const },
  warn: { tone: "warn" as const },
  error: { tone: "error" as const },
});

type SummaryInput = {
  ticket: Ticket;
  project: Project;
  settings: Settings | null;
  /** labels.model as a lookup by "<driver>:<model>"; absent → no model labels */
  models?: Record<string, string>;
  /** labels.driver as a lookup; absent → no driver labels */
  drivers?: Record<string, string>;
  checkoutName?: string | null;
};
const summary = ({ ticket, project, settings, models, drivers, checkoutName }: SummaryInput) =>
  newSessionOptionsSummary(ticket, project, settings, {
    ...(models ? { model: (d: string, m: string | null) => models[`${d}:${m}`] ?? null } : {}),
    ...(drivers ? { driver: (d: string) => drivers[d] ?? d } : {}),
    ...(checkoutName !== undefined ? { checkoutName } : {}),
  });
const labels = { models: { "claude-code:sonnet": "Sonnet 5" }, checkoutName: "main" };
export const newSessionOptionsSummaryCases = cases(summary, {
  "defaults: nothing": { ticket: blank(), project: project(), settings, ...labels },
  "each override, in row order": {
    ticket: { ...blank(), model: "sonnet", permissionMode: "read_only", requestedBranch: "feat", baseBranch: "develop", skipAgentReview: true, skipHumanReview: true, dependsOn: ["WEB-1"] },
    project: project(),
    settings,
    ...labels,
  },
  "a skipping project's defaults show nothing": { ticket: blank(skipping), project: skipping, settings, ...labels },
  "reviews turned back on in a skipping project": { ticket: { ...blank(skipping), skipAgentReview: false, skipHumanReview: false }, project: skipping, settings, ...labels },
  "the checkout pick reads as no worktree and hides the base": { ticket: { ...blank(), useWorktree: false, baseBranch: "develop" }, project: project(), settings, ...labels },
  "no checkout name: Project directory": { ticket: { ...blank(), useWorktree: false }, project: project(), settings },
  "a null checkout name: Project directory": { ticket: { ...blank(), useWorktree: false }, project: project(), settings, checkoutName: null },
  "a worktree on a project that doesn't use them": { ticket: { ...blank(), useWorktree: true }, project: project({ useWorktrees: false }), settings, ...labels },
  "a direct project's own default shows nothing": { ticket: blank(), project: project({ useWorktrees: false }), settings, ...labels },
  "a model without a label shows its id": { ticket: { ...blank(), model: "opus" }, project: project(), settings, ...labels },
  "an empty label falls through to the id": { ticket: { ...blank(), model: "opus" }, project: project(), settings, models: { "claude-code:opus": "" } },
  "a driver override with no model: its label": { ticket: { ...blank(), driver: "codex" }, project: project(), settings, drivers: { codex: "Codex" } },
  "a driver override with no labels: its id": { ticket: { ...blank(), driver: "codex" }, project: project(), settings },
  "a driver override with a model label": { ticket: { ...blank(), driver: "codex", model: "luna" }, project: project(), settings, models: { "codex:luna": "Luna" }, drivers: { codex: "Codex" } },
  "an unknown permission mode shows its id": { ticket: { ...blank(), permissionMode: "yolo" as PermissionMode }, project: project(), settings },
  "a non-git project shows no branch or base": { ticket: { ...blank(), requestedBranch: "feat", baseBranch: "develop", useWorktree: false }, project: project({ isGit: false }), settings, ...labels },
  "several dependencies": { ticket: { ...blank(), dependsOn: ["WEB-1", "API-2"] }, project: project(), settings },
  "base only": { ticket: { ...blank(), baseBranch: "develop" }, project: project(), settings },
  "no settings: the ticket's driver is an override": { ticket: blank(), project: project(), settings: null, drivers: { "claude-code": "Claude Code" } },
});
