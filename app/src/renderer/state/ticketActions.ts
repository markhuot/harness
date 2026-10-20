// The actions a ticket offers right now, as data: the ticket pane's buttons and its More menu and
// the board card's right-click menu all read this list, so their gates (status, conductor-managed,
// dependencies, busy, compacting) can't drift apart. The iPhone and iPad keep the same list in
// HarnessKit's TicketActions.swift.
//
// Disabled placeholders ("Working…", "Starts automatically", "Restarts at …") aren't actions and
// aren't here: the pane draws those itself.

import { conductorManagedReason, managingConductor, reviewPassed, type Ticket } from "@harness/shared";
import { autoStartWaitingOn, startLabel, startState, type DepState } from "@harness/shared/state";
import { landCommands, landMenu, type LandChoice, type LandMenu } from "./approveMenu";

export type TicketActionId = "start" | "unblock" | "approve" | "requestChanges" | "reopen" | "rerunReview" | "markDone" | "cancelRun" | "cancelStart" | "withdrawApproval" | "delete";

export interface TicketAction {
  id: TicketActionId;
  label: string;
  /** A disabled one is drawn greyed out in the pane and left out of a card's menu. */
  enabled: boolean;
  destructive?: boolean;
  /** Approve: the split button's choices. */
  land?: LandMenu;
  /** Approve, when a conductor approves in the human's place (the action is then disabled). */
  managedReason?: string;
}

export interface TicketActionSet {
  /** The status action and Approve / Request changes / Re-open: the pane's button row. */
  primary: TicketAction[];
  /** The More (…) menu's items, in order. */
  more: TicketAction[];
  /** What's offered and enabled, primary first: a card menu. */
  enabled: TicketAction[];
}

export interface TicketActionContext {
  project: Parameters<typeof landMenu>[1];
  parent?: Ticket;
  /** The ticket's effective base branch: a ticket working on it offers no merge or pull request. */
  base: string | null;
  /** The ticket's dependencies' states (`dependencyStates`) */
  deps: DepState[];
}

export function ticketActions(ticket: Ticket, ctx: TicketActionContext): TicketActionSet {
  // A draft isn't launched: it offers nothing here (its card offers Discard).
  if (ticket.draft) return { primary: [], more: [], enabled: [] };
  // While the session compacts the service refuses ticket actions; Cancel run stays.
  const compacting = !!ticket.compacting;
  const primary: TicketAction[] = [];
  const more: TicketAction[] = [];

  const start = startState(ticket, ctx.deps);
  if (start === "start" || start === "approve") primary.push({ id: "start", label: startLabel(start), enabled: !compacting });

  // A block that waits on the human: no restart time, no run going, no tool approval to answer.
  if (ticket.status === "blocked" && !ticket.resumeAt && !ticket.busy && !ticket.pendingApproval) {
    primary.push({ id: "unblock", label: "Unblock", enabled: !compacting });
  }

  // Approving lands the work once both reviews pass; there's no separate Complete step. A
  // conductor's child keeps its (turned off) Approve once approved: the conductor lands it.
  const conductor = managingConductor(ticket, ctx.parent);
  const managedReason = conductor ? conductorManagedReason(conductor) : undefined;
  if (ticket.status === "review" && (ticket.humanReview !== "approved" || conductor)) {
    const land = landMenu(ticket, ctx.project, ctx.parent, ctx.base);
    primary.push({ id: "approve", label: land.primary.label, enabled: !conductor && !compacting, land, managedReason });
  }
  if (ticket.status === "review" && ticket.humanReview !== "approved") primary.push({ id: "requestChanges", label: "Request changes", enabled: !compacting });
  if (ticket.status === "done") primary.push({ id: "reopen", label: "Re-open", enabled: !compacting });

  if (ticket.status === "review") {
    more.push({ id: "rerunReview", label: ticket.agentReview === "skipped" ? "Run agent review" : "Re-run agent review", enabled: !ticket.busy && !compacting });
  }
  // Not in review, where Approve and take no action does it (and records the approval).
  if (ticket.status !== "done" && ticket.status !== "review") more.push({ id: "markDone", label: "Move to done", enabled: !compacting });
  // A planning ticket that will start by itself (approved plan, or queued behind a dependency).
  // A conductor's child starts by its conductor's plan: it isn't the human's to stop.
  if (ticket.status === "planning" && (ticket.autoStart || ticket.startAfterPlan) && !conductor) {
    more.push({ id: "cancelStart", label: "Cancel auto start", enabled: !compacting });
  }
  // Until the complete run starts: both reviews passed means it is queued or running (the service's `completing`).
  const completing = ticket.status === "review" && (!!ticket.completing || reviewPassed(ticket.agentReview));
  const standing = ticket.status === "in_progress" && !!ticket.skipHumanReview;
  if ((standing || (ticket.status === "review" && ticket.humanReview === "approved")) && !completing && !conductor) {
    more.push({ id: "withdrawApproval", label: standing ? "Require human review" : "Withdraw approval", enabled: !compacting });
  }
  if (ticket.busy) more.push({ id: "cancelRun", label: "Cancel run", enabled: true, destructive: true });
  more.push({ id: "delete", label: "Delete ticket", enabled: !compacting, destructive: true });

  return { primary, more, enabled: [...primary, ...more].filter((a) => a.enabled) };
}

/** One ⌘K palette command: the action it runs, and for an Approve way the choice. */
export interface PaletteEntry {
  label: string;
  action: TicketAction;
  choice?: LandChoice;
}

/**
 * The palette's ticket-action commands, from the same list the buttons and the card menu read:
 * one per enabled action in the set, keyed by command id. Approve is the primary way to land, then
 * one command per other way (merge, pull request, clean up, custom) and "take no action".
 */
export function paletteEntries(set: TicketActionSet): Record<string, PaletteEntry> {
  const out: Record<string, PaletteEntry> = {};
  for (const a of set.enabled) {
    if (a.id !== "approve" || !a.land) {
      out[`ticket.${a.id}`] = { label: a.label, action: a };
      continue;
    }
    const commands = landCommands(a.land);
    out["ticket.approve"] = { label: commands.primary, action: a, choice: a.land.primary };
    for (const [kind, c] of Object.entries(commands.others)) out[`ticket.land.${kind}`] = { label: c.label, action: a, choice: c };
    out["ticket.approveNoAction"] = { label: a.land.noAction.label, action: a, choice: a.land.noAction };
  }
  return out;
}

/** A native context-menu entry: what the main process's menu takes (main/types.ts `ContextMenuItem`). */
export type ActionMenuEntry = { id: string; label: string; submenu?: ActionMenuEntry[] } | { type: "separator" };

const ID_PREFIX = "action:";

/** `actions` (a card's enabled ones) as a context menu. Approve is a submenu of the ways to approve, the last of which takes no action. */
export function actionMenuItems(actions: TicketAction[]): ActionMenuEntry[] {
  return actions.map((a): ActionMenuEntry => {
    if (a.id !== "approve" || !a.land) return { id: ID_PREFIX + a.id, label: a.label };
    const choices = approveChoices(a.land);
    return {
      id: ID_PREFIX + a.id,
      label: "Approve",
      submenu: choices.flatMap((c, i): ActionMenuEntry[] => [
        // The no-action choice sits after a separator, as in the pane's split button.
        ...(c === a.land!.noAction && i > 0 ? [{ type: "separator" as const }] : []),
        { id: `${ID_PREFIX}approve:${i}`, label: c.label },
      ]),
    };
  });
}

/** What a picked menu id runs: the action, and for an Approve choice the choice. Null for an id that isn't one of `actions`'. */
export function pickedAction(actions: TicketAction[], id: string | null): { action: TicketAction; choice?: LandChoice } | null {
  if (!id?.startsWith(ID_PREFIX)) return null;
  const [action, index] = id.slice(ID_PREFIX.length).split(":");
  const hit = actions.find((a) => a.id === action);
  if (!hit) return null;
  if (index === undefined) return { action: hit };
  const choice = hit.land && approveChoices(hit.land)[Number(index)];
  return choice ? { action: hit, choice } : null;
}

function approveChoices(land: LandMenu): LandChoice[] {
  return [...land.items, land.noAction];
}
