// How an approved ticket's work lands (shared/src/completion.ts) for HarnessKit's Completion.swift.
import {
  APPROVE_NO_ACTION_LABEL,
  approveLabel,
  COMPLETION_ACTION_LABELS,
  completionOptions,
  conductorManagedReason,
  hasNoBranch,
  isCompletionAction,
  managingConductor,
  offeredCompletionActions,
  projectCompletionDefault,
  resolveCompletionAction,
  worksOnBase,
} from "../../src/completion";
import type { CompletionAction } from "../../src/protocol";
import { cases } from "../case";

type ProjectIn = { isGit?: boolean; completionAction?: CompletionAction; completionActions?: CompletionAction[]; pullRequestHost?: string | null } | null;
type TicketIn = { completionAction?: CompletionAction | null; pullRequestUrl?: string | null; baseBranch?: string | null; branch?: string | null; hasChanges?: boolean | null } | null;
type ParentIn = { branch?: string | null; status?: string } | null;

const git = { isGit: true, pullRequestHost: null } as const;
const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const plain = { isGit: false, pullRequestHost: null } as const;
// A newer service may offer an action this build doesn't know.
const deploy = "deploy" as CompletionAction;

const projects: Record<string, ProjectIn> = {
  "no project": null,
  "empty project (older payload)": {},
  "outside git": plain,
  "git without a PR host": git,
  "git with a gh host": gh,
  "empty PR host is falsy": { isGit: true, pullRequestHost: "" },
  "isGit missing but PR host set": { pullRequestHost: "github.com" },
  "the service's list wins": { ...gh, completionActions: ["merge", "custom"] },
  "the service sent an empty list": { ...gh, completionActions: [] },
  "the service offers an unknown action": { ...git, completionActions: [deploy, "custom"] },
};

export const offeredCompletionActionsCases = cases(offeredCompletionActions, projects);

export const isCompletionActionCases = cases(isCompletionAction, {
  merge: "merge",
  pr: "pr",
  cleanup: "cleanup",
  custom: "custom",
  "unknown string": "deploy",
  "upper case": "MERGE",
  empty: "",
  null: null,
  number: 1,
  array: ["merge"],
});

export const projectCompletionDefaultCases = cases(projectCompletionDefault, {
  ...projects,
  "stored pr with a gh host": { ...gh, completionAction: "pr" },
  "stored pr without a host falls back to merge": { ...git, completionAction: "pr" },
  "stored pr outside git falls back to custom": { ...plain, completionAction: "pr" },
  "stored merge outside git falls back to custom": { ...plain, completionAction: "merge" },
  "stored custom in git": { ...git, completionAction: "custom" },
  "stored unknown action the service offers": { ...git, completionAction: deploy, completionActions: [deploy, "custom"] },
  "stored unknown action not offered": { ...git, completionAction: deploy },
  "only an unknown action offered": { completionActions: [deploy] },
} as Record<string, ProjectIn>);

interface OptionsIn {
  ticket: TicketIn;
  project: ProjectIn;
  parent?: ParentIn;
  /** The effective base branch, when the caller knows it */
  base?: string | null;
}

const optionInputs: Record<string, OptionsIn> = {
  "nothing at all": { ticket: null, project: null },
  "earlier custom beats an open PR": { ticket: { completionAction: "custom", pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "merge" } },
  "an open PR preselects cleanup": { ticket: { completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "merge" } },
  "an earlier pr the project still offers beats an open PR": { ticket: { completionAction: "pr", pullRequestUrl: "https://github.com/a/b/pull/1" }, project: gh },
  "no earlier choice: the project default": { ticket: { completionAction: null, pullRequestUrl: null }, project: { ...gh, completionAction: "merge" } },
  "an earlier pr the project no longer offers doesn't stick": { ticket: { completionAction: "pr", pullRequestUrl: "x" }, project: { ...git, completionAction: "merge" } },
  "an open PR without a PR host": { ticket: { pullRequestUrl: "https://github.com/a/b/pull/1" }, project: git },
  "an open PR, project default custom": { ticket: { pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "custom" } },
  "an open PR when the service offers no cleanup": { ticket: { pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionActions: ["merge", "pr"] } },
  "an empty pull request url is falsy": { ticket: { pullRequestUrl: "" }, project: gh },
  "child of a parent on a branch only merges": { ticket: { completionAction: "pr" }, project: { ...gh, completionAction: "pr" }, parent: { branch: "harness/web-1" } },
  "child of a parent in review still merges into its branch": { ticket: {}, project: gh, parent: { branch: "harness/web-1", status: "review" } },
  "parent without a branch changes nothing": { ticket: null, project: gh, parent: { branch: null } },
  "parent with an empty branch changes nothing": { ticket: null, project: gh, parent: { branch: "" } },
  "a finished parent releases the child": { ticket: null, project: { ...gh, completionAction: "pr" }, parent: { branch: "harness/web-1", status: "done" } },
  "a child with its own base branch": { ticket: { baseBranch: "release" }, project: { ...gh, completionAction: "pr" }, parent: { branch: "harness/web-1", status: "in_progress" } },
  "a child with a null base branch": { ticket: { baseBranch: null }, project: { ...gh, completionAction: "pr" }, parent: { branch: "harness/web-1", status: "in_progress" } },
  "a child with an empty base branch": { ticket: { baseBranch: "" }, project: gh, parent: { branch: "harness/web-1", status: "in_progress" } },
  "outside git: custom only": { ticket: {}, project: plain },
  "earlier unknown action the service offers": { ticket: { completionAction: deploy }, project: { ...git, completionActions: [deploy, "custom"] } },
  "earlier unknown action not offered": { ticket: { completionAction: deploy }, project: git },
  "only an unknown action offered": { ticket: null, project: { completionActions: [deploy] } },
  "the service sent an empty list": { ticket: null, project: { ...gh, completionActions: [] } },
  "on its base branch: no merge or pr": { ticket: { branch: "feature/pr-head" }, project: { ...gh, completionAction: "merge" }, base: "feature/pr-head" },
  "on its base branch, project default pr: first action left": { ticket: { branch: "feature/pr-head" }, project: { ...gh, completionAction: "pr" }, base: "feature/pr-head" },
  "on its base branch with an earlier merge": { ticket: { branch: "x", completionAction: "merge" }, project: git, base: "x" },
  "on its base branch outside git": { ticket: { branch: "x" }, project: plain, base: "x" },
  "a different base branch changes nothing": { ticket: { branch: "harness/web-2" }, project: gh, base: "main" },
  "an empty branch is never on base": { ticket: { branch: "" }, project: gh, base: "" },
  "no base known": { ticket: { branch: "x" }, project: gh, base: null },
  "a child on its parent's branch ignores base": { ticket: { branch: "harness/web-1" }, project: gh, parent: { branch: "harness/web-1" }, base: "harness/web-1" },
  "earlier cleanup sticks": { ticket: { completionAction: "cleanup", pullRequestUrl: "https://github.com/a/b/pull/1" }, project: gh },
  "on base, only merge and pr offered": { ticket: { branch: "x" }, project: { ...gh, completionActions: ["merge", "pr"] }, base: "x" },
  "no branch of its own: no merge or pr": { ticket: { branch: null }, project: { ...gh, completionAction: "merge" } },
  "no branch of its own with an earlier merge: clean up": { ticket: { branch: null, completionAction: "merge" }, project: git },
  "no branch of its own with an open PR": { ticket: { branch: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, project: gh },
  "no branch of its own outside git": { ticket: { branch: null }, project: plain },
  "a branch left out changes nothing": { ticket: {}, project: { ...gh, completionAction: "merge" } },
  "no changes to land: no merge or pr": { ticket: { branch: "harness/web-2", hasChanges: false }, project: { ...gh, completionAction: "merge" } },
  "no changes to land, project default pr, open PR": { ticket: { branch: "harness/web-2", hasChanges: false, pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "pr" } },
  "changes to land keep every choice": { ticket: { branch: "harness/web-2", hasChanges: true }, project: gh },
  "not checked yet keeps every choice": { ticket: { branch: "harness/web-2", hasChanges: null }, project: gh },
  "a child on its parent's branch with no changes still merges": { ticket: { branch: "harness/web-2", hasChanges: false }, project: gh, parent: { branch: "harness/web-1" } },
};

export const completionOptionsCases = cases(({ ticket, project, parent, base }: OptionsIn) => completionOptions(ticket, project, parent, base), optionInputs);

export const approveLabelCases = cases(({ ticket, project, parent, base }: OptionsIn) => approveLabel(completionOptions(ticket, project, parent, base)), optionInputs);

export const worksOnBaseCases = cases(({ ticket, base }: { ticket: TicketIn; base?: string | null }) => worksOnBase(ticket, base), {
  "same branch": { ticket: { branch: "feature/x" }, base: "feature/x" },
  "different branch": { ticket: { branch: "harness/web-1" }, base: "main" },
  "no ticket": { ticket: null, base: "main" },
  "no branch": { ticket: {}, base: "main" },
  "null branch": { ticket: { branch: null }, base: null },
  "empty both": { ticket: { branch: "" }, base: "" },
  "no base": { ticket: { branch: "main" }, base: null },
  "case matters": { ticket: { branch: "Main" }, base: "main" },
});

export const hasNoBranchCases = cases(hasNoBranch, {
  "null branch": { branch: null },
  "branch left out": {},
  "a branch": { branch: "harness/web-1" },
  "empty branch": { branch: "" },
  "no ticket": null,
} as Record<string, TicketIn>);

type ConductorIn = { key: string; status?: string };
export const managingConductorCases = cases(({ ticket, parent }: { ticket: { parentId?: string | null } | null; parent: ConductorIn | null }) => managingConductor(ticket, parent), {
  "a child of a running conductor": { ticket: { parentId: "t1" }, parent: { key: "WEB-1", status: "in_progress" } },
  "a child of a conductor in review": { ticket: { parentId: "t1" }, parent: { key: "WEB-1", status: "review" } },
  "a done parent hands the child back": { ticket: { parentId: "t1" }, parent: { key: "WEB-1", status: "done" } },
  "a parent with no status still manages": { ticket: { parentId: "t1" }, parent: { key: "WEB-1" } },
  "no parent id": { ticket: { parentId: null }, parent: { key: "WEB-1", status: "in_progress" } },
  "empty parent id": { ticket: { parentId: "" }, parent: { key: "WEB-1", status: "in_progress" } },
  "parent not loaded": { ticket: { parentId: "t1" }, parent: null },
  "no ticket": { ticket: null, parent: { key: "WEB-1", status: "in_progress" } },
});

export const conductorManagedReasonCases = cases(conductorManagedReason, {
  plain: { key: "WEB-1" },
  "a remote key": { key: "JIRA-62" },
});

interface ResolveIn extends OptionsIn {
  requested: CompletionAction | null;
}

export const resolveCompletionActionCases = cases(({ requested, ticket, project, parent, base }: ResolveIn) => resolveCompletionAction(requested, ticket, project, parent, base), {
  "nothing requested: the preselected one": { requested: null, ticket: null, project: { ...gh, completionAction: "pr" } },
  "empty request: the preselected one": { requested: "" as CompletionAction, ticket: null, project: git },
  "an offered action passes": { requested: "custom", ticket: null, project: git },
  "pr without a PR host": { requested: "pr", ticket: null, project: git },
  "merge outside git": { requested: "merge", ticket: null, project: plain },
  "pr on a child of a parent with a branch": { requested: "pr", ticket: null, project: gh, parent: { branch: "harness/web-1" } },
  "custom on a child of a parent with a branch": { requested: "custom", ticket: null, project: gh, parent: { branch: "harness/web-1" } },
  "merge on a child of a parent with a branch": { requested: "merge", ticket: null, project: gh, parent: { branch: "harness/web-1" } },
  "custom not offered by the service's list": { requested: "custom", ticket: null, project: { ...gh, completionActions: ["merge", "pr"] } },
  "an unknown action": { requested: deploy, ticket: null, project: gh },
  "an unknown action the service offers": { requested: deploy, ticket: null, project: { completionActions: [deploy] } },
  "cleanup in git": { requested: "cleanup", ticket: null, project: git },
  "cleanup outside git": { requested: "cleanup", ticket: null, project: plain },
  "merge on its base branch": { requested: "merge", ticket: { branch: "x" }, project: gh, base: "x" },
  "pr on its base branch": { requested: "pr", ticket: { branch: "x" }, project: gh, base: "x" },
  "pr on its base branch without a PR host": { requested: "pr", ticket: { branch: "x" }, project: git, base: "x" },
  "cleanup on its base branch": { requested: "cleanup", ticket: { branch: "x" }, project: gh, base: "x" },
  "nothing requested on its base branch": { requested: null, ticket: { branch: "x" }, project: gh, base: "x" },
  "merge with no branch of its own": { requested: "merge", ticket: { branch: null }, project: gh },
  "pr with no branch of its own": { requested: "pr", ticket: { branch: null }, project: gh },
  "cleanup with no branch of its own": { requested: "cleanup", ticket: { branch: null }, project: gh },
  "nothing requested with no branch of its own": { requested: null, ticket: { branch: null }, project: { ...gh, completionAction: "pr" } },
  "merge with no changes to land": { requested: "merge", ticket: { branch: "x", hasChanges: false }, project: gh },
  "pr with no changes to land": { requested: "pr", ticket: { branch: "x", hasChanges: false }, project: gh },
  "pr with no changes to land but no PR host": { requested: "pr", ticket: { branch: "x", hasChanges: false }, project: git },
  "custom with no changes to land": { requested: "custom", ticket: { branch: "x", hasChanges: false }, project: gh },
} as Record<string, ResolveIn>);

export const labels = { COMPLETION_ACTION_LABELS, APPROVE_NO_ACTION_LABEL };
