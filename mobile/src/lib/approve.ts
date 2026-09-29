// The Approve button and its menu, and the Complete sheet's action choice: which request each
// choice sends. The choices themselves come from completionOptions (@harness/shared).

import {
  APPROVE_NO_ACTION_LABEL,
  approveMenuActions,
  COMPLETION_ACTION_LABELS,
  type CompleteBody,
  type CompletionAction,
  type CompletionOptions,
  type HumanReviewBody,
  type Ticket,
} from "@harness/shared";
import type { SelectOption } from "./selectOptions";

/** A row of the Approve menu: a completion action, or approving without one. */
export type ApproveChoice = CompletionAction | "none";

/** The menu's rows, in order: the offered actions, then "Approve and take no action". */
export function approveMenuChoices(opts: CompletionOptions): { value: ApproveChoice; label: string }[] {
  return [...approveMenuActions(opts).map((a) => ({ value: a as ApproveChoice, label: COMPLETION_ACTION_LABELS[a] })), { value: "none", label: APPROVE_NO_ACTION_LABEL }];
}

export type ApproveRequest = { via: "review"; body: HumanReviewBody } | { via: "complete"; body: CompleteBody };

/**
 * What a menu row sends. "none" completes without a run (which records the human approval too);
 * an action approves with it. Custom carries the instructions from the "Approve and…" sheet.
 */
export function approveRequest(choice: ApproveChoice, instructions?: string): ApproveRequest {
  if (choice === "none") return { via: "complete", body: { skipAgent: true } };
  const text = instructions?.trim();
  return { via: "review", body: { decision: "approve", action: choice, ...(choice === "custom" && text ? { instructions: text } : {}) } };
}

/**
 * The primary button's request: the preselected action. A custom one repeats the instructions the
 * ticket was approved with before (a re-approval after changes), so a plain "Approve" doesn't drop them.
 */
export function primaryApproveRequest(opts: CompletionOptions, ticket: Pick<Ticket, "completionAction" | "completionInstructions">): ApproveRequest {
  const earlier = opts.defaultAction === "custom" && ticket.completionAction === "custom" ? ticket.completionInstructions ?? undefined : undefined;
  return approveRequest(opts.defaultAction, earlier);
}

/** "Approve and merge" → "Complete and merge", for the Complete button's menu. */
function asComplete(label: string): string {
  return label.replace(/^Approve/, "Complete");
}

/**
 * The Complete button's menu, once the human review is approved: the offered actions while the
 * ticket is ready to complete (`canRun`: both reviews passed, no run in progress), then "Complete and
 * take no action", which is always there: it's how an approved ticket waiting on its agent review,
 * or on a project that doesn't complete on its own, gets done without an agent run.
 */
export function completeMenuChoices(opts: CompletionOptions, canRun: boolean): { value: ApproveChoice; label: string }[] {
  const actions = canRun ? approveMenuActions(opts).map((a) => ({ value: a as ApproveChoice, label: asComplete(COMPLETION_ACTION_LABELS[a]) })) : [];
  return [...actions, { value: "none", label: asComplete(APPROVE_NO_ACTION_LABEL) }];
}

/** What a Complete menu row sends: an action completes with it; "none" marks the ticket done without a run. */
export function completeMenuRequest(choice: ApproveChoice): CompleteBody {
  return choice === "none" ? { skipAgent: true } : { action: choice };
}

/** Toast after an approval. */
export function approveToast(choice: ApproveChoice, key: string): string {
  return choice === "none" ? `${key} approved and marked done` : "Approved";
}

/** Short names for a completion action, in the project's "When approved" select and the Complete sheet. */
export const COMPLETION_ACTION_NAMES: Record<CompletionAction, string> = {
  merge: "Merge",
  pr: "Open PR",
  custom: "Custom",
};

/** Options for a select of completion actions. A child on its parent's branch names the branch. */
export function completionActionOptions(actions: CompletionAction[], parentBranch: string | null = null): SelectOption<CompletionAction>[] {
  return actions.map((a) => ({ value: a, label: a === "merge" && parentBranch ? `Merge into ${parentBranch}` : COMPLETION_ACTION_NAMES[a] }));
}

/**
 * The Complete sheet's request. `choose` is whether the sheet offered the action choice (both reviews
 * passed and the project doesn't complete on its own); otherwise the service keeps the choice made at
 * approval.
 */
export function completeBody(choose: boolean, action: CompletionAction, instructions: string): CompleteBody {
  const text = instructions.trim();
  return { ...(choose ? { action } : {}), ...(text ? { instructions: text } : {}) };
}
