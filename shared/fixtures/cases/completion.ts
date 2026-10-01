// How an approved ticket's work lands (shared/src/completion.ts) for HarnessKit's Completion.swift.
import {
  APPROVE_NO_ACTION_LABEL,
  approveLabel,
  approveMenuActions,
  COMPLETION_ACTION_LABELS,
  completionOptions,
  isCompletionAction,
  offeredCompletionActions,
  projectCompletionDefault,
  resolveCompletionAction,
} from "../../src/completion";
import type { CompletionAction } from "../../src/protocol";
import { cases } from "../case";

type ProjectIn = { isGit?: boolean; completionAction?: CompletionAction; completionActions?: CompletionAction[]; pullRequestHost?: string | null } | null;
type TicketIn = { completionAction?: CompletionAction | null; pullRequestUrl?: string | null; baseBranch?: string | null } | null;
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
}

const optionInputs: Record<string, OptionsIn> = {
  "nothing at all": { ticket: null, project: null },
  "earlier custom beats an open PR": { ticket: { completionAction: "custom", pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "merge" } },
  "an open PR preselects pr": { ticket: { completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, project: { ...gh, completionAction: "merge" } },
  "no earlier choice: the project default": { ticket: { completionAction: null, pullRequestUrl: null }, project: { ...gh, completionAction: "merge" } },
  "an earlier pr the project no longer offers doesn't stick": { ticket: { completionAction: "pr", pullRequestUrl: "x" }, project: { ...git, completionAction: "merge" } },
  "an open PR without a PR host": { ticket: { pullRequestUrl: "https://github.com/a/b/pull/1" }, project: git },
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
};

export const completionOptionsCases = cases(({ ticket, project, parent }: OptionsIn) => completionOptions(ticket, project, parent), optionInputs);

export const approveLabelCases = cases(({ ticket, project, parent }: OptionsIn) => approveLabel(completionOptions(ticket, project, parent)), optionInputs);

export const approveMenuActionsCases = cases(({ ticket, project, parent }: OptionsIn) => approveMenuActions(completionOptions(ticket, project, parent)), optionInputs);

interface ResolveIn extends OptionsIn {
  requested: CompletionAction | null;
}

export const resolveCompletionActionCases = cases(({ requested, ticket, project, parent }: ResolveIn) => resolveCompletionAction(requested, ticket, project, parent), {
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
} as Record<string, ResolveIn>);

export const labels = { COMPLETION_ACTION_LABELS, APPROVE_NO_ACTION_LABEL };
