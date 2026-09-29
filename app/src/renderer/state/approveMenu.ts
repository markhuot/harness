// The Approve (and Complete) split button: its primary choice and its menu, from the shared
// completion options (shared/src/completion.ts). The component only renders these and runs them.

import {
  APPROVE_NO_ACTION_LABEL,
  approveLabel,
  approveMenuActions,
  COMPLETION_ACTION_LABELS,
  completionOptions,
  type CompletionAction,
  type CompletionOptions,
  type Project,
  type Ticket,
} from "@harness/shared";

/** "approve": the human review isn't in yet. "complete": both reviews passed, completion is manual. */
export type LandMode = "approve" | "complete";

/**
 * What picking a choice does: `run` sends the action right away (no instructions); `sheet` opens the
 * instructions sheet for the action first (`required`: the sheet can't submit empty); `none`
 * finishes the ticket with no completion run ("Approve and take no action").
 */
export type LandChoice =
  | { kind: "run"; action: CompletionAction; label: string }
  | { kind: "sheet"; action: CompletionAction; required: boolean; label: string }
  | { kind: "none"; label: string };

export interface LandMenu {
  opts: CompletionOptions;
  primary: LandChoice;
  /** The menu's action choices, before its separator */
  items: LandChoice[];
  /** The menu's last choice, after the separator */
  noAction: LandChoice;
}

/** An Approve… label for the Complete button: "Approve and merge" → "Complete and merge". */
const asComplete = (label: string) => label.replace(/^Approve\b/, "Complete");

/**
 * The split button for `ticket`. Approving: the primary runs the preselected action, and a plain
 * "Approve" (custom preselected) runs custom without instructions, a light wrap-up; in the menu
 * "Approve and…" asks for them. Completing: the primary opens the sheet (optional instructions for
 * the preselected action), as the Complete button always did.
 */
export function landMenu(mode: LandMode, ticket: Parameters<typeof completionOptions>[0], project: Parameters<typeof completionOptions>[1], parent?: Parameters<typeof completionOptions>[2]): LandMenu {
  const opts = completionOptions(ticket, project, parent);
  const label = (l: string) => (mode === "complete" ? asComplete(l) : l);
  const primaryLabel = mode === "complete" && opts.defaultAction === "custom" && !opts.parentBranch ? "Complete" : label(approveLabel(opts));
  const primary: LandChoice =
    mode === "complete"
      ? { kind: "sheet", action: opts.defaultAction, required: false, label: primaryLabel }
      : { kind: "run", action: opts.defaultAction, label: primaryLabel };
  const items = approveMenuActions(opts).map((action): LandChoice =>
    action === "custom" ? { kind: "sheet", action, required: true, label: label(COMPLETION_ACTION_LABELS.custom) } : { kind: "run", action, label: label(COMPLETION_ACTION_LABELS[action]) },
  );
  return { opts, primary, items, noAction: { kind: "none", label: label(APPROVE_NO_ACTION_LABEL) } };
}

/** A pull request link's short label: "PR #42" from a …/pull/42 (GitHub) or …/merge_requests/42 URL, else "PR". */
export function pullRequestLabel(url: string): string {
  const n = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return n ? `PR #${n}` : "PR";
}
