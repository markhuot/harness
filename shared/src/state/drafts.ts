// Drafts (DESIGN.md "Drafts") and the ticket settings both apps render in ticket details and in a
// draft's Options: a draft is a planning ticket with `draft` set, edited through the same
// TicketSettings rows as any ticket. These are the pure pieces: the blank draft a New session
// starts from, applying a settings PATCH locally, the POST / PATCH bodies a draft editor sends,
// which settings rows show (and can change), the branch pick's meaning, and the collapsed Options
// summary. Platform-independent: no React, DOM or native APIs.

import { harnessBranch, resolveBaseBranch } from "../branches";
import type { BranchInfo, CreateTicketBody, Project, PublicSettings, Ticket, UpdateTicketBody } from "../protocol";
import { promptAttachmentFromInput, promptAttachmentInputs, samePromptAttachments } from "./promptAttachments";
import { branchChoice, branchChoiceHint, canChangeBranch, ticketHasBranch, type BranchChoice } from "./branches";
import { permissionModeLabel } from "./format";
import { projectDriver, ticketChoice } from "./models";

type DraftProject = Pick<Project, "id" | "path" | "isGit" | "useWorktrees" | "defaultDriver" | "defaultModels" | "baseBranch" | "skipAgentReview" | "skipHumanReview">;
type DraftSettings = Pick<PublicSettings, "defaultDriver" | "defaultModels" | "baseBranch">;
type ReviewDefaults = Pick<Project, "skipAgentReview" | "skipHumanReview">;

/** The review switches a new ticket of `project` starts with (Project.skipAgentReview / skipHumanReview). */
export function projectReviewSkips(project: ReviewDefaults | null | undefined): { skipAgentReview: boolean; skipHumanReview: boolean } {
  return { skipAgentReview: !!project?.skipAgentReview, skipHumanReview: !!project?.skipHumanReview };
}

/**
 * The review switches for a draft moving from project `from` to `to`: a switch still on its old
 * project's default follows the new project's, and one the user flipped stays flipped. Only the
 * switches that change, so it merges into the move's PATCH.
 */
export function draftReviewSkipsPatch(t: Pick<Ticket, "skipAgentReview" | "skipHumanReview">, from: ReviewDefaults | null | undefined, to: ReviewDefaults | null | undefined): UpdateTicketBody {
  const was = projectReviewSkips(from);
  const next = projectReviewSkips(to);
  const p: UpdateTicketBody = {};
  if (!!t.skipAgentReview === was.skipAgentReview && was.skipAgentReview !== next.skipAgentReview) p.skipAgentReview = next.skipAgentReview;
  if (!!t.skipHumanReview === was.skipHumanReview && was.skipHumanReview !== next.skipHumanReview) p.skipHumanReview = next.skipHumanReview;
  return p;
}

/**
 * The ticket a New session edits before anything is saved: a draft in planning with every setting
 * inherited, and the project's review switches. `key` is the predicted key (predictedTicketKey),
 * used only for the harness/<key> label.
 */
export function blankDraftTicket(project: DraftProject, settings: DraftSettings | null | undefined, key: string, now = Date.now()): Ticket {
  return {
    id: "",
    key,
    projectId: project.id,
    kind: "task",
    title: "",
    spec: "",
    specRevision: 1,
    specBaselineRevision: null,
    status: "planning",
    sessionId: "",
    driver: projectDriver(project, settings),
    parentId: null,
    childCount: 0,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    requestedBranch: null,
    baseBranch: null,
    useWorktree: null,
    ...projectReviewSkips(project),
    draft: true,
    promptAttachments: [],
    blockedReason: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    permissionMode: null,
    model: null,
    position: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const blankToNull = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * `patch` (what TicketSettings asks the service for) applied to a local ticket, the way the
 * service applies it: a driver change clears the model unless one comes with it, "" branches mean
 * the default. A draft editor keeps its unsaved state this way.
 */
export function applyTicketPatch(t: Ticket, patch: UpdateTicketBody): Ticket {
  const next: Ticket = { ...t };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.spec !== undefined) next.spec = patch.spec;
  if (patch.driver !== undefined && patch.driver !== t.driver) {
    next.driver = patch.driver;
    if (patch.model === undefined) next.model = null;
  }
  if (patch.model !== undefined) next.model = patch.model || null;
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.baseBranch !== undefined) next.baseBranch = blankToNull(patch.baseBranch);
  if (patch.branch !== undefined) next.requestedBranch = blankToNull(patch.branch);
  if (patch.skipAgentReview !== undefined) next.skipAgentReview = patch.skipAgentReview;
  if (patch.skipHumanReview !== undefined) next.skipHumanReview = patch.skipHumanReview;
  if (patch.dependsOn !== undefined) next.dependsOn = [...patch.dependsOn];
  if (patch.position !== undefined) next.position = patch.position;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.useWorktree !== undefined) next.useWorktree = patch.useWorktree;
  if (patch.projectId !== undefined) next.projectId = patch.projectId;
  if (patch.promptAttachments !== undefined) next.promptAttachments = patch.promptAttachments.map(promptAttachmentFromInput);
  return next;
}

/** Whether the ticket will work in a worktree of its own (a git project, and its pick or the project's says so). */
export function draftUsesWorktree(t: Pick<Ticket, "useWorktree">, project: Pick<Project, "isGit" | "useWorktrees"> | null | undefined): boolean {
  return !!project && project.isGit !== false && (t.useWorktree ?? project.useWorktrees);
}

/**
 * Nothing worth keeping: no spec or attachments, every setting still inherited and the review switches on the
 * project's defaults. A New session isn't saved until this turns false, and closing one that's
 * still empty doesn't ask.
 */
export function draftIsEmpty(t: Ticket, project: DraftProject | null | undefined, settings: DraftSettings | null | undefined): boolean {
  const choice = ticketChoice(t, project, settings);
  const skips = projectReviewSkips(project);
  return (
    !t.spec.trim() &&
    !t.promptAttachments?.length &&
    t.kind === "task" &&
    choice.driver === null &&
    t.permissionMode === null &&
    (t.useWorktree ?? null) === null &&
    !t.requestedBranch &&
    !t.baseBranch &&
    !!t.skipAgentReview === skips.skipAgentReview &&
    !!t.skipHumanReview === skips.skipHumanReview &&
    t.dependsOn.length === 0
  );
}

/**
 * POST /tickets for a draft's first save. Branch and base go only with a worktree (the service
 * refuses a branch without one), and useWorktree only for a git project. Both review switches
 * always go: the service would fill in its own copy of the project's defaults otherwise.
 */
export function draftCreateBody(t: Ticket, project: DraftProject): CreateTicketBody {
  const worktree = draftUsesWorktree(t, project);
  return {
    projectId: t.projectId,
    spec: t.spec,
    draft: true,
    start: false,
    kind: t.kind,
    driver: t.driver || undefined,
    model: t.model,
    permissionMode: t.permissionMode,
    useWorktree: project.isGit === false ? null : (t.useWorktree ?? null),
    ...(worktree ? { branch: t.requestedBranch ?? null, baseBranch: t.baseBranch ?? null } : {}),
    skipAgentReview: !!t.skipAgentReview,
    skipHumanReview: !!t.skipHumanReview,
    ...(t.dependsOn.length ? { dependsOn: t.dependsOn } : {}),
    ...(t.promptAttachments?.length ? { promptAttachments: promptAttachmentInputs(t.promptAttachments) } : {}),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The PATCH taking a saved draft from `prev` (what the service has) to `next` (the editor's
 * state): only the fields that changed, or null when nothing did. The title isn't sent: the
 * service re-derives a draft's title from its spec.
 */
export function draftPatch(prev: Ticket, next: Ticket): UpdateTicketBody | null {
  const p: UpdateTicketBody = {};
  if (next.projectId !== prev.projectId) p.projectId = next.projectId;
  if (next.spec !== prev.spec) p.spec = next.spec;
  if (next.kind !== prev.kind) p.kind = next.kind;
  if (next.driver !== prev.driver) p.driver = next.driver;
  if (next.model !== prev.model || (p.driver !== undefined && next.model)) p.model = next.model;
  if (next.permissionMode !== prev.permissionMode) p.permissionMode = next.permissionMode;
  if ((next.useWorktree ?? null) !== (prev.useWorktree ?? null)) p.useWorktree = next.useWorktree ?? null;
  if ((next.requestedBranch ?? null) !== (prev.requestedBranch ?? null)) p.branch = next.requestedBranch ?? null;
  if ((next.baseBranch ?? null) !== (prev.baseBranch ?? null)) p.baseBranch = next.baseBranch ?? null;
  if (!!next.skipAgentReview !== !!prev.skipAgentReview) p.skipAgentReview = !!next.skipAgentReview;
  if (!!next.skipHumanReview !== !!prev.skipHumanReview) p.skipHumanReview = !!next.skipHumanReview;
  if (!sameList(next.dependsOn, prev.dependsOn)) p.dependsOn = next.dependsOn;
  if (!samePromptAttachments(next.promptAttachments ?? [], prev.promptAttachments ?? [])) p.promptAttachments = promptAttachmentInputs(next.promptAttachments ?? []);
  return Object.keys(p).length ? p : null;
}

/** Which TicketSettings rows show, and which can change, for a ticket (a draft or not). */
export interface TicketSettingsRows {
  /** Anything can change: the ticket isn't done */
  editable: boolean;
  /** The driver can't change mid-run: the Model menu offers only this driver's models */
  onlyDriver: string | undefined;
  /** The ticket works (or will work) in a worktree of its own */
  worktree: boolean;
  /**
   * The Branch row. A draft always shows it on a git project, since picking the project directory's
   * own branch (`offerCheckout`) is how it chooses to run without a worktree.
   */
  branch: { show: boolean; editable: boolean; offerCheckout: boolean };
  /** The Base branch row: only with a worktree (nothing merges otherwise) */
  base: { show: boolean; editable: boolean };
}

export function ticketSettingsRows(t: Ticket, project: Pick<Project, "isGit" | "useWorktrees"> | null | undefined): TicketSettingsRows {
  const editable = t.status !== "done";
  const draft = !!t.draft;
  const worktree = draft ? draftUsesWorktree(t, project) : ticketHasBranch(t, project);
  const gitProject = !!project && project.isGit !== false;
  return {
    editable,
    onlyDriver: t.busy ? t.driver : undefined,
    worktree,
    branch: draft ? { show: gitProject, editable, offerCheckout: true } : { show: worktree, editable: canChangeBranch(t, project), offerCheckout: false },
    base: { show: worktree, editable },
  };
}

/** A pick in a draft's Branch row: the default, the project directory's own branch, or any other. */
export type DraftBranchPick = { kind: "default" } | { kind: "checkout" } | { kind: "branch"; name: string };

/** What a pick in the Branch row picked, given the project directory's branch (null while unknown). */
export function draftBranchPick(name: string | null, checkout: BranchInfo | null): DraftBranchPick {
  if (name === null) return { kind: "default" };
  if (checkout && name === checkout.name) return { kind: "checkout" };
  return { kind: "branch", name };
}

/**
 * The PATCH for a pick in a draft's Branch row. The project directory's own branch means no
 * worktree; any other branch means a worktree on it. useWorktree stays null whenever the pick is
 * what the project does anyway, so the draft keeps following the project.
 */
export function draftBranchPatch(pick: DraftBranchPick, project: Pick<Project, "useWorktrees">): UpdateTicketBody {
  switch (pick.kind) {
    case "default":
      return { branch: null, useWorktree: null };
    case "checkout":
      return { branch: null, useWorktree: project.useWorktrees ? false : null };
    case "branch":
      return { branch: pick.name, useWorktree: project.useWorktrees ? null : true };
  }
}

/**
 * The Branch row's value for a draft: its requested branch, or the project directory's branch when
 * it picked that over the project's worktree default. null shows the default row.
 */
export function draftBranchValue(t: Pick<Ticket, "requestedBranch" | "useWorktree">, project: Pick<Project, "useWorktrees">, checkout: BranchInfo | null): string | null {
  if (t.useWorktree === false && project.useWorktrees) return checkout?.name ?? null;
  return t.requestedBranch ?? null;
}

/** The Branch row's default option for a draft: the project's own choice between a new branch and the project directory. */
export function draftDefaultBranchLabel(key: string, project: Pick<Project, "useWorktrees">, checkout: BranchInfo | null): string {
  if (project.useWorktrees) return `New branch ${harnessBranch(key)}`;
  return checkout ? `${checkout.name} · project directory` : "Project directory";
}

/**
 * What the ticket's branch pick will do (the line under the Branch row). A draft without a worktree
 * works in the project directory on its branch.
 */
export function ticketBranchChoice(t: Ticket, project: Pick<Project, "path" | "isGit" | "useWorktrees">, known: readonly BranchInfo[], checkout: BranchInfo | null): BranchChoice {
  if (t.draft && !draftUsesWorktree(t, project)) return { kind: "checkout", name: checkout?.name ?? "its current branch", path: checkout?.checkedOutAt ?? project.path };
  return branchChoice(t.requestedBranch, harnessBranch(t.key), known, t.draft ? project.path : null);
}

/** The branch hint for a ticket, with its resolved base branch. */
export function ticketBranchHint(
  t: Ticket,
  project: Pick<Project, "path" | "isGit" | "useWorktrees" | "baseBranch">,
  settings: Pick<PublicSettings, "baseBranch"> | null | undefined,
  known: readonly BranchInfo[],
  checkout: BranchInfo | null,
) {
  return branchChoiceHint(ticketBranchChoice(t, project, known, checkout), resolveBaseBranch(t, project, settings).branch);
}

/** A branch hint that shouldn't sit hidden in a collapsed Options: the pick would block, or isn't valid. */
export function optionsNeedAttention(hint: { tone: "plain" | "warn" | "error" }): boolean {
  return hint.tone !== "plain";
}

export interface OptionsSummaryLabels {
  /** A model's display name ("Sonnet 5"); the id is shown without it */
  model?: (driver: string, model: string | null) => string | null | undefined;
  /** A driver's display name */
  driver?: (driver: string) => string;
  /** The project directory's branch, for "main · no worktree" */
  checkoutName?: string | null;
}

/**
 * The collapsed Options line: only what differs from the project's defaults, in row order, e.g.
 * ["Sonnet 5", "Read only", "main · no worktree", "Skip agent review"]. Empty when nothing does.
 */
export function newSessionOptionsSummary(t: Ticket, project: DraftProject, settings: DraftSettings | null | undefined, labels: OptionsSummaryLabels = {}): string[] {
  const out: string[] = [];
  const choice = ticketChoice(t, project, settings);
  if (choice.driver) out.push(labels.model?.(choice.driver, choice.model) || choice.model || labels.driver?.(choice.driver) || choice.driver);
  if (t.permissionMode) out.push(permissionModeLabel(t.permissionMode));
  if (project.isGit !== false) {
    const worktree = draftUsesWorktree(t, project);
    if (!worktree && t.useWorktree === false) out.push(`${labels.checkoutName ?? "Project directory"} · no worktree`);
    else if (worktree && t.requestedBranch) out.push(t.requestedBranch);
    else if (worktree && t.useWorktree === true) out.push(harnessBranch(t.key));
    if (worktree && t.baseBranch) out.push(`into ${t.baseBranch}`);
  }
  const skips = projectReviewSkips(project);
  if (!!t.skipAgentReview !== skips.skipAgentReview) out.push(t.skipAgentReview ? "Skip agent review" : "With agent review");
  if (!!t.skipHumanReview !== skips.skipHumanReview) out.push(t.skipHumanReview ? "Skip human review" : "With human review");
  if (t.dependsOn.length) out.push(`After ${t.dependsOn.join(", ")}`);
  return out;
}
