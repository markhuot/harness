// Pure derivations for conductor tickets and their children (Children tab, board rollup,
// board dimming / hiding). No React, no I/O.

import { TICKET_STATUSES, type Ticket, type TicketStatus } from "../index";

export const isChild = (t: Ticket) => t.parentId !== null;

/** Why a ticket needs the human right now, or null. Order = urgency. */
export type Attention = "approval" | "blocked" | "review";

/**
 * A pending human review is the human's job only on top-level tickets. A conductor child's
 * human review belongs to its conductor (it calls review_ticket), so a child needs the human
 * only when it is blocked or waiting on a tool approval.
 */
export function attentionOf(t: Ticket): Attention | null {
  if (t.pendingApproval) return "approval";
  if (t.status === "blocked") return "blocked";
  if (t.status === "review" && t.humanReview === "pending" && !isChild(t)) return "review";
  return null;
}

export const needsHuman = (t: Ticket) => attentionOf(t) !== null;

/**
 * Children are downplayed on the board so the conductor stays the focus, except when they
 * need the human: those keep full weight wherever they are.
 */
export const dimOnBoard = (t: Ticket) => isChild(t) && !needsHuman(t);

/** "Hide child tickets" never hides a child the human has to act on. */
export const hideOnBoard = (t: Ticket, hideChildren: boolean) => hideChildren && dimOnBoard(t);

export function childrenOfTicket(tickets: Record<string, Ticket>, conductorId: string): Ticket[] {
  return Object.values(tickets)
    .filter((t) => t.parentId === conductorId)
    .sort((a, b) => a.createdAt - b.createdAt || a.position - b.position);
}

/**
 * Whether a ticket's card shows the working spinner: its own agent has a run going, or (rolled up
 * for a conductor) any ticket below it does, children and their children alike. A conductor whose
 * children are all blocked, stopped or crashed stops spinning like any idle ticket. Walks up from
 * each busy ticket rather than down from this one, since few tickets are busy at once.
 */
export function isWorking(tickets: Record<string, Ticket>, t: Ticket): boolean {
  if (t.busy) return true;
  for (const b of Object.values(tickets)) {
    if (!b.busy) continue;
    const seen = new Set<string>([b.id]);
    for (let id = b.parentId; id && !seen.has(id); id = tickets[id]?.parentId ?? null) {
      if (id === t.id) return true;
      seen.add(id);
    }
  }
  return false;
}

/** The spinner's tooltip: whose work it stands for. */
export const workingTitle = (t: Ticket) => (t.busy ? "Agent working" : "A child ticket is working");

export interface Progress {
  total: number;
  byStatus: Record<TicketStatus, number>;
  /** Children needing the human (approval / blocked; their reviews are the conductor's) */
  attention: number;
}

export function progressOf(children: Ticket[]): Progress {
  const byStatus: Record<TicketStatus, number> = { planning: 0, in_progress: 0, blocked: 0, review: 0, done: 0 };
  let attention = 0;
  for (const c of children) {
    byStatus[c.status]++;
    if (needsHuman(c)) attention++;
  }
  return { total: children.length, byStatus, attention };
}

/** "4/10 done · 2 in progress · 1 blocked · 1 review" (zero counts omitted, planning = "up next"). */
export function progressLabel(p: Progress): string {
  const parts = [`${p.byStatus.done}/${p.total} done`];
  if (p.byStatus.in_progress) parts.push(`${p.byStatus.in_progress} in progress`);
  if (p.byStatus.blocked) parts.push(`${p.byStatus.blocked} blocked`);
  if (p.byStatus.review) parts.push(`${p.byStatus.review} review`);
  if (p.byStatus.planning) parts.push(`${p.byStatus.planning} up next`);
  return parts.join(" · ");
}

/** Bar segments, left to right: done, review, in progress, blocked, planning. Empty ones dropped. */
export const SEGMENT_ORDER: TicketStatus[] = ["done", "review", "in_progress", "blocked", "planning"];
export function progressSegments(p: Progress): { status: TicketStatus; count: number; pct: number }[] {
  if (!p.total) return [];
  return SEGMENT_ORDER.filter((s) => p.byStatus[s] > 0).map((s) => ({ status: s, count: p.byStatus[s], pct: (p.byStatus[s] / p.total) * 100 }));
}

export interface DepState {
  key: string;
  done: boolean;
  /**
   * done / pending (loaded, not done) / unknown (not loaded: done tickets page in, so an unloaded
   * dependency is usually an older done one; clients resolve it and the state settles). Render
   * unknown neutrally, never as "waiting".
   */
  state: "done" | "pending" | "unknown";
  ticket?: Ticket;
  /** The service said this key doesn't exist */
  missing?: boolean;
}

/** `aliases`: old key (upper-case) → ticket id, for keys from before a project rename. */
export function depStates(tickets: Record<string, Ticket>, t: Ticket, aliases: Record<string, string> = {}): DepState[] {
  const byKey = new Map<string, Ticket>();
  for (const x of Object.values(tickets)) byKey.set(x.key.toUpperCase(), x);
  return t.dependsOn.map((key) => {
    const upper = key.toUpperCase();
    const dep = byKey.get(upper) ?? (aliases[upper] ? tickets[aliases[upper]!] : undefined);
    const state: DepState["state"] = !dep ? "unknown" : dep.status === "done" ? "done" : "pending";
    return { key, done: state === "done", state, ticket: dep };
  });
}

/** Chip tooltip: done, waiting, or not loaded / not found (never "waiting" for an unloaded key). */
export function depChipTitle(d: DepState): string {
  if (d.state === "done") return `${d.key} is done`;
  if (d.state === "pending") return `Waiting on ${d.key}`;
  return d.missing ? `${d.key} wasn't found` : `Looking up ${d.key}…`;
}

/** Keys still holding this ticket back (unknown keys count: gating must be conservative). */
export const waitingOn = (deps: DepState[]) => deps.filter((d) => !d.done).map((d) => d.key);

/**
 * Dependencies an auto-start ticket is waiting on: it was started (or created to start on its
 * own) while they were open, so it sits in planning and the service starts it once they're done.
 * Empty when it isn't waiting. Only loaded, unfinished dependencies count: an unknown key is
 * usually an older done ticket, and the service treats a deleted one as done, so neither holds it.
 */
export function autoStartWaitingOn(t: Ticket, deps: DepState[]): string[] {
  if (t.draft || !(t.autoStart || t.startAfterPlan) || t.status !== "planning") return [];
  // An approved plan waits for the planning run first: that wait has its own state (`startState`).
  if (t.startAfterPlan && t.busy) return [];
  return deps.filter((d) => d.state === "pending").map((d) => d.key);
}

/**
 * What the Start button (and its palette command and the board card's clock) means for a ticket:
 *  - "start": a planning ticket with nothing running; Start begins the work,
 *  - "approve": a planning run is queued or running; Approve plan records the approval and the
 *    work starts when the run ends,
 *  - "approved": the plan is approved (the planning run is still going, or the work is about to start); nothing left to press,
 *  - "waiting": it starts on its own once its open dependencies are done; nothing left to press,
 *  - "none": not a planning ticket (or a draft).
 */
export type StartState = "start" | "approve" | "approved" | "waiting" | "none";

export function startState(t: Ticket, deps: DepState[]): StartState {
  if (t.draft || t.status !== "planning") return "none";
  if (autoStartWaitingOn(t, deps).length) return "waiting";
  if (t.startAfterPlan) return "approved"; // (idle with open dependencies is "waiting", above)
  return t.busy ? "approve" : "start";
}

/** The Start button's label (and the ⌘K command's): "Approve plan" while a planning run is going, "Start work" otherwise. */
export function startLabel(state: StartState): string {
  return state === "approve" ? "Approve plan" : "Start work";
}

/** The disabled button and the card's clock while the plan is approved and still being written. */
export const APPROVED_TITLE = "Plan approved: the work starts when planning finishes";

/** The waiting card's clock and the disabled Start button: "Starts on its own once A and B are done". */
export function autoStartTitle(keys: string[]): string {
  if (keys.length === 0) return "Starts on its own once its dependencies are done";
  const list = keys.length > 1 ? `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}` : keys[0];
  return `Starts on its own once ${list} ${keys.length > 1 ? "are" : "is"} done`;
}

/**
 * When a blocked ticket restarts on its own (ms): a run stopped on a usage limit, and the service
 * restarts it five minutes after the limit resets (`Ticket.resumeAt`). null when it won't: not
 * blocked, or blocked on anything else.
 */
export function restartsAt(t: Ticket): number | null {
  return t.status === "blocked" && !t.draft && t.resumeAt ? t.resumeAt : null;
}

/** The restarting card's clock: "Restarts on its own at 2:35 PM" (`time` already formatted). */
export function restartTitle(time: string): string {
  return `Restarts on its own at ${time}, after the usage limit resets`;
}

/**
 * Depth in the sibling dependency graph: 0 = depends on no sibling, n = 1 + deepest sibling dep.
 * Deps outside the set are ignored; cycles are cut (a ticket revisited mid-walk counts as 0).
 */
export function dependencyDepths(children: Ticket[]): Map<string, number> {
  const byKey = new Map(children.map((c) => [c.key.toUpperCase(), c]));
  const depth = new Map<string, number>();
  const walking = new Set<string>();
  const visit = (t: Ticket): number => {
    const k = t.key.toUpperCase();
    const known = depth.get(k);
    if (known !== undefined) return known;
    if (walking.has(k)) return 0;
    walking.add(k);
    let d = 0;
    for (const dep of t.dependsOn) {
      const sib = byKey.get(dep.toUpperCase());
      if (sib) d = Math.max(d, visit(sib) + 1);
    }
    walking.delete(k);
    depth.set(k, d);
    return d;
  };
  for (const c of children) visit(c);
  return depth;
}

export interface ChildGroup {
  status: TicketStatus;
  tickets: Ticket[];
}

/**
 * Children grouped by status in lifecycle (board) order, empty groups dropped. Within a group,
 * attention first, then dependency order (a ticket after the siblings it waits on), then age.
 */
export function groupChildren(children: Ticket[]): ChildGroup[] {
  const depth = dependencyDepths(children);
  const rank = (t: Ticket) => (needsHuman(t) ? 0 : 1);
  return TICKET_STATUSES.map((status) => ({
    status,
    tickets: children
      .filter((c) => c.status === status)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (depth.get(a.key.toUpperCase()) ?? 0) - (depth.get(b.key.toUpperCase()) ?? 0) ||
          a.createdAt - b.createdAt,
      ),
  })).filter((g) => g.tickets.length > 0);
}

// ---------------------------------------------------------------------------
// Board preference: child tickets are hidden unless the user shows them ("Show child tickets"),
// per machine: localStorage on desktop, injected storage elsewhere. Stored "1" = hide, "0" = show;
// nothing stored (first run) = hide.
// ---------------------------------------------------------------------------

// v2: the default flipped to hidden. Older builds stored "0" (shown), so a new key lets every
// install pick up the new default once; toggling afterwards is remembered as before.
export const HIDE_CHILDREN_KEY = "harness.board.hideChildren.v2";
export const HIDE_CHILDREN_DEFAULT = true;

/** The slice of Web Storage the preference needs (localStorage on desktop; any sync KV elsewhere). */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const defaultStorage = (): KV | undefined => (globalThis as { localStorage?: KV }).localStorage;

export function readHideChildren(storage: KV | undefined = defaultStorage()): boolean {
  try {
    const v = storage?.getItem(HIDE_CHILDREN_KEY);
    return v === "1" ? true : v === "0" ? false : HIDE_CHILDREN_DEFAULT;
  } catch {
    return HIDE_CHILDREN_DEFAULT;
  }
}

export function writeHideChildren(value: boolean, storage: KV | undefined = defaultStorage()): void {
  try {
    storage?.setItem(HIDE_CHILDREN_KEY, value ? "1" : "0");
  } catch {
    // Private mode / blocked storage: the toggle still works for this session.
  }
}
