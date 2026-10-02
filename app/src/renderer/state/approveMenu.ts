// The Approve split button: its primary choice and its menu, from the shared completion options
// (shared/src/completion.ts). The component only renders these and runs them.

import {
  APPROVE_NO_ACTION_LABEL,
  approveLabel,
  COMPLETION_ACTION_LABELS,
  completionOptions,
  type CompletionAction,
  type CompletionOptions,
} from "@harness/shared";

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

/**
 * The split button for `ticket`. The primary runs the preselected action, and a plain "Approve"
 * (custom preselected) runs custom without instructions, a light wrap-up; in the menu "Approve
 * and…" asks for them. `base` is the ticket's effective base branch: a ticket working on it offers
 * no merge or pull request.
 */
export function landMenu(
  ticket: Parameters<typeof completionOptions>[0],
  project: Parameters<typeof completionOptions>[1],
  parent?: Parameters<typeof completionOptions>[2],
  base?: string | null,
): LandMenu {
  const opts = completionOptions(ticket, project, parent, base);
  const primary: LandChoice = { kind: "run", action: opts.defaultAction, label: approveLabel(opts) };
  const items = opts.actions.map((action): LandChoice =>
    action === "custom" ? { kind: "sheet", action, required: true, label: COMPLETION_ACTION_LABELS.custom } : { kind: "run", action, label: COMPLETION_ACTION_LABELS[action] },
  );
  return { opts, primary, items, noAction: { kind: "none", label: APPROVE_NO_ACTION_LABEL } };
}

/**
 * The split button as palette commands: the primary (ticket.approve, labeled as the button reads),
 * then each menu choice by action (ticket.land.merge, .pr, .cleanup, .custom), leaving out the one
 * the primary already names. "Take no action" is ticket.approveNoAction.
 */
export function landCommands(menu: LandMenu): { primary: string; others: Partial<Record<CompletionAction, LandChoice>> } {
  const others: Partial<Record<CompletionAction, LandChoice>> = {};
  for (const c of menu.items) if (c.kind !== "none" && c.label !== menu.primary.label) others[c.action] = c;
  return { primary: menu.primary.label, others };
}

/** A pull request link's short label: "PR #42" from a …/pull/42 (GitHub) or …/merge_requests/42 URL, else "PR". */
export function pullRequestLabel(url: string): string {
  const n = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return n ? `PR #${n}` : "PR";
}
