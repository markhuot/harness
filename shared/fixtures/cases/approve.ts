// The Approve button, its menu and the Complete sheet (mobile/src/lib/approve.ts) for HarnessKit's
// Approve.swift. Inputs carry the computed CompletionOptions so the Swift side tests Approve alone.
import {
  approveMenuChoices,
  approveRequest,
  approveToast,
  completeBody,
  completeMenuChoices,
  completeMenuRequest,
  COMPLETION_ACTION_NAMES,
  completionActionOptions,
  primaryApproveRequest,
  type ApproveChoice,
} from "../../../mobile/src/lib/approve";
import { completionOptions, type CompletionOptions } from "../../src/completion";
import type { CompletionAction } from "../../src/protocol";
import { cases } from "../case";

const gh = { isGit: true, pullRequestHost: "github.com" };
const git = { isGit: true, pullRequestHost: null };
const plain = { isGit: false };
const deploy = "deploy" as CompletionAction;

const opts: Record<string, CompletionOptions> = {
  "git with a PR host": completionOptions({}, gh),
  "git without a PR host": completionOptions({}, git),
  "outside git": completionOptions({}, plain),
  "child on its parent's branch": completionOptions({}, gh, { branch: "harness/web-1" }),
  "open PR preselects pr": completionOptions({ pullRequestUrl: "https://github.com/o/r/pull/1" }, gh),
  "service list with an unknown action": completionOptions({}, { completionActions: ["merge", deploy, "custom"] }),
  "service sent an empty list": completionOptions({}, { ...gh, completionActions: [] }),
  "on its base branch": completionOptions({ branch: "feature/pr-head" }, gh, null, "feature/pr-head"),
  "earlier cleanup": completionOptions({ completionAction: "cleanup" }, gh),
};

export const approveMenuChoicesCases = cases(approveMenuChoices, opts);

export const approveRequestCases = cases(({ choice, instructions }: { choice: ApproveChoice; instructions?: string }) => approveRequest(choice, instructions), {
  "no action completes without a run": { choice: "none", instructions: "ignored" },
  "custom sends trimmed instructions": { choice: "custom", instructions: "  squash it  " },
  "custom with blank instructions": { choice: "custom", instructions: "   " },
  "custom without instructions": { choice: "custom" },
  "custom trims NBSP but not NEL": { choice: "custom", instructions: " deploy\u0085 " },
  "merge never carries instructions": { choice: "merge", instructions: "stray" },
  "pr never carries instructions": { choice: "pr", instructions: "stray" },
  "cleanup never carries instructions": { choice: "cleanup", instructions: "stray" },
  "an unknown action passes through": { choice: deploy, instructions: "x" },
});

type TicketIn = { completionAction?: CompletionAction | null; completionInstructions?: string | null };
const primaryInputs: Record<string, { opts: CompletionOptions; ticket: TicketIn }> = {
  "the preselected pr": { opts: opts["open PR preselects pr"]!, ticket: {} },
  "a child on its parent's branch merges": { opts: completionOptions({ completionAction: "pr" }, gh, { branch: "harness/web-1" }), ticket: { completionAction: "pr" } },
  "a custom re-approval keeps its instructions": {
    opts: completionOptions({ completionAction: "custom" }, gh),
    ticket: { completionAction: "custom", completionInstructions: "  deploy to staging " },
  },
  "a custom re-approval with null instructions": { opts: completionOptions({ completionAction: "custom" }, gh), ticket: { completionAction: "custom", completionInstructions: null } },
  "plain no-git Approve drops stale instructions": { opts: completionOptions({}, plain), ticket: { completionInstructions: "stale" } },
  "earlier merge with instructions, preselected custom": { opts: completionOptions({}, plain), ticket: { completionAction: "merge", completionInstructions: "stale" } },
  "earlier custom, but the default is merge": { opts: completionOptions({}, gh), ticket: { completionAction: "custom", completionInstructions: "x" } },
};
export const primaryApproveRequestCases = cases(({ opts, ticket }: { opts: CompletionOptions; ticket: TicketIn }) => primaryApproveRequest(opts, ticket), primaryInputs);

const completeMenuInputs: Record<string, { opts: CompletionOptions; canRun: boolean }> = {};
for (const [name, o] of Object.entries(opts)) {
  // An unknown action has no label, and TS's asComplete would throw on it when the actions show.
  if (name !== "service list with an unknown action") completeMenuInputs[`${name}, ready`] = { opts: o, canRun: true };
  completeMenuInputs[`${name}, not ready`] = { opts: o, canRun: false };
}
export const completeMenuChoicesCases = cases(({ opts, canRun }: { opts: CompletionOptions; canRun: boolean }) => completeMenuChoices(opts, canRun), completeMenuInputs);

export const completeMenuRequestCases = cases(completeMenuRequest, {
  none: "none",
  merge: "merge",
  pr: "pr",
  cleanup: "cleanup",
  custom: "custom",
  unknown: deploy,
} as Record<string, ApproveChoice>);

export const approveToastCases = cases(({ choice, key }: { choice: ApproveChoice; key: string }) => approveToast(choice, key), {
  "no action names the ticket": { choice: "none", key: "MH-12" },
  "an action says Approved": { choice: "merge", key: "MH-12" },
  custom: { choice: "custom", key: "MH-12" },
});

export const completionActionOptionsCases = cases(
  ({ actions }: { actions: CompletionAction[] }) => completionActionOptions(actions),
  {
    "merge alone": { actions: ["merge"] },
    "every action": { actions: ["merge", "pr", "cleanup", "custom"] },
    "order is kept": { actions: ["pr", "custom", "merge"] },
    "unknown action has no label": { actions: [deploy, "merge"] },
    "no actions": { actions: [] },
  },
);

export const completeBodyCases = cases(({ choose, action, instructions }: { choose: boolean; action: CompletionAction; instructions: string }) => completeBody(choose, action, instructions), {
  "choice offered, no instructions": { choose: true, action: "pr", instructions: "" },
  "choice not offered, trimmed instructions": { choose: false, action: "pr", instructions: " note " },
  "choice offered with instructions": { choose: true, action: "custom", instructions: "ship it\n" },
  "nothing to send": { choose: false, action: "merge", instructions: " \t　" },
});

export const names = COMPLETION_ACTION_NAMES;
