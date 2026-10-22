// What a chief of staff's arrange_panes does to one board's panes (DESIGN.md "Chief of staff panes"),
// as pure functions over a PaneState: resolve a pane named by its content, apply one op, and describe
// the layout. The service sends the ops (service/src/tools/panes.ts) and the store applies them
// (state/store.tsx). Content outside `allowed` behaves as if it didn't exist: an op naming it is
// refused as not found, and the layout counts it without naming it.

import { TICKET_TABS, type TicketTab } from "@harness/shared/state";
import type { PaneAllowed, PaneLayoutView, PaneOp, PaneRef, PaneZone } from "@harness/shared";
import {
  boardLeaf,
  closePane,
  dropContent,
  findLeaf,
  focusPane,
  layoutPanes,
  leaves,
  movePane,
  openTerminal,
  openTicket,
  setPaneWidth,
  terminalContent,
  terminalLeafBySession,
  ticketLeafByKey,
  type DropZone,
  type PaneArea,
  type PaneContent,
  type PaneLeaf,
  type PaneState,
  type TerminalContent,
} from "./paneModel";

export type ArrangeOutcome = { state: PaneState; outcome: "applied" | "unchanged"; message: string } | { error: string };

/** What applyPaneOp needs besides the panes: the covered content, the window's size and the terminals this Mac knows. */
export interface ArrangeEnv {
  allowed: PaneAllowed;
  area: PaneArea;
  /** The shell a terminal id names (its folder and title make the pane), or undefined for an id the service doesn't have. */
  terminal: (id: string) => { id: string; cwd: string; title?: string } | undefined;
}

const ZONES: Record<PaneZone, DropZone> = { left: "left", right: "right", above: "top", below: "bottom" };
const TABS: readonly string[] = [...TICKET_TABS, "changes"];
/** A resize is a fraction of the window; outside these a pane or the board would be unusable. */
export const MIN_WIDTH_FRACTION = 0.1;
export const MAX_WIDTH_FRACTION = 0.9;
/** Widths within this many px count as the one asked for. */
const WIDTH_TOLERANCE_PX = 3;

const describeRef = (ref: PaneRef): string => ("ticket" in ref ? `ticket ${ref.ticket}` : "terminal" in ref ? `terminal ${ref.terminal}` : "the board");

/** The ref a leaf's content answers to, or null for content a chief never names (files, New sessions, chief panes, a torn-off browser tab). */
export function refOf(content: PaneContent): PaneRef | null {
  if (content.kind === "board") return { board: true };
  if (content.kind === "ticket") return { ticket: content.ticketKey, tab: content.tab };
  if (content.kind === "ticketTab") return content.browserTab === undefined ? { ticket: content.ticketKey, tab: content.tab } : null;
  if (content.kind === "terminal") return { terminal: content.sessionId };
  return null;
}

/** Is this content one the chief covers? The board is everyone's. */
function covered(content: PaneContent, allowed: PaneAllowed): boolean {
  if (content.kind === "board") return true;
  if (content.kind === "ticket" || content.kind === "ticketTab") return allowed.tickets.includes(content.ticketKey);
  if (content.kind === "terminal") return allowed.terminals.includes(content.sessionId);
  return false;
}

/** The pane showing `ref`, or null. A ticket named with a tab finds that tab's torn-off pane, else the ticket's pane only while it shows that tab; without a tab, the ticket's pane. */
export function resolveRef(state: PaneState, ref: PaneRef): PaneLeaf | null {
  if ("board" in ref) return boardLeaf(state.root);
  if ("terminal" in ref) return terminalLeafBySession(state.root, ref.terminal);
  if (!ref.tab) return ticketLeafByKey(state.root, ref.ticket);
  const torn = leaves(state.root).find((l) => l.content.kind === "ticketTab" && l.content.ticketKey === ref.ticket && l.content.tab === ref.tab && l.content.browserTab === undefined);
  if (torn) return torn;
  const main = ticketLeafByKey(state.root, ref.ticket);
  return main && main.content.kind === "ticket" && main.content.tab === ref.tab ? main : null;
}

/** Why this ref can't be used: it names content outside the chief's cover (indistinguishable from content that doesn't exist), or a tab that doesn't exist. */
function refError(ref: PaneRef, allowed: PaneAllowed): string | null {
  if ("ticket" in ref) {
    if (!allowed.tickets.includes(ref.ticket)) return `Unknown ticket: ${ref.ticket}`;
    if (ref.tab !== undefined && !TABS.includes(ref.tab)) return `Unknown tab "${ref.tab}". Use one of: ${TABS.join(", ")}.`;
  } else if ("terminal" in ref && !allowed.terminals.includes(ref.terminal)) return `Unknown terminal: ${ref.terminal}`;
  return null;
}

const sameState = (a: PaneState, b: PaneState) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Where the covered panes are, in reading order of the tree; everything else is only counted. */
export function describeLayout(state: PaneState, allowed: PaneAllowed, area?: PaneArea): PaneLayoutView {
  const round = (n: number) => Math.round(n * 100) / 100;
  const panes: PaneLayoutView["panes"] = [];
  let others = 0;
  for (const { leaf, rect } of layoutPanes(state, area).leaves) {
    const ref = refOf(leaf.content);
    if (!ref || !covered(leaf.content, allowed)) {
      others += 1;
      continue;
    }
    panes.push({ pane: ref, focused: state.focusedId === leaf.id, x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) });
  }
  return { panes, others, zoomed: state.zoomedId !== null };
}

/** The pane content that showing `ref` makes, or an error (a terminal this Mac can't see). */
function contentFor(ref: PaneRef, env: ArrangeEnv): { content: PaneContent } | { error: string } {
  if ("board" in ref) return { content: { kind: "board" } };
  if ("ticket" in ref) return { content: { kind: "ticket", ticketKey: ref.ticket, tab: (ref.tab as TicketTab | undefined) ?? "spec" } };
  const info = env.terminal(ref.terminal);
  return info ? { content: terminalContent(info) } : { error: `Unknown terminal: ${ref.terminal}` };
}

/** Apply one op to `state`. Never throws: a refusal comes back as `{ error }` and leaves the panes alone. */
export function applyPaneOp(state: PaneState, op: PaneOp, env: ArrangeEnv): ArrangeOutcome {
  const { allowed, area } = env;
  const done = (next: PaneState, applied: string, already: string): ArrangeOutcome =>
    sameState(state, next) ? { state, outcome: "unchanged", message: already } : { state: next, outcome: "applied", message: applied };

  if (op.op === "get_layout") return { state, outcome: "unchanged", message: "The current layout." };

  const bad = refError(op.pane, allowed) ?? (op.op === "split" || op.op === "move" ? refError(op.target, allowed) : null);
  if (bad) return { error: bad };
  const name = describeRef(op.pane);
  const leaf = resolveRef(state, op.pane);

  switch (op.op) {
    case "open": {
      if ("ticket" in op.pane) return done(openTicket(state, op.pane.ticket, op.pane.tab as TicketTab | undefined), `Opened ${name}.`, `${name} is already open and focused.`);
      if ("board" in op.pane) return done(focusPane(state, leaf!.id), "Focused the board.", "The board is already focused.");
      const made = contentFor(op.pane, env);
      if ("error" in made) return made;
      return done(openTerminal(state, made.content as TerminalContent, area.width), `Opened ${name}.`, `${name} is already open and focused.`);
    }
    case "focus":
      if (!leaf) return { error: `${name} isn't open. Use open to show it.` };
      return done(focusPane(state, leaf.id), `Focused ${name}.`, `${name} is already focused.`);
    case "close":
      if (!leaf) return { state, outcome: "unchanged", message: `${name} wasn't open.` };
      if (leaf.content.kind === "board") return { error: "The board can't be closed." };
      return done(closePane(state, leaf.id), `Closed ${name}.`, `${name} wasn't open.`);
    case "split":
    case "move": {
      const target = resolveRef(state, op.target);
      if (!target) return { error: `${describeRef(op.target)} isn't open, so there's nothing to place ${name} beside.` };
      // The pane split would move: for a ticket, the one already showing it (whatever its tab), so the self-check and the drop agree.
      const keep = leaf ?? ("ticket" in op.pane ? ticketLeafByKey(state.root, op.pane.ticket) : null);
      if (keep?.id === target.id) return { error: `A pane can't be placed beside itself (${name}).` };
      if (op.op === "move") {
        if (!leaf) return { error: `${name} isn't open. Use split to show it beside ${describeRef(op.target)}.` };
        if (leaf.content.kind === "board") return { error: "The board can't be moved." };
        return done(movePane(state, leaf.id, target.id, ZONES[op.zone]), `Moved ${name} ${op.zone} of ${describeRef(op.target)}.`, `${name} is already there.`);
      }
      if ("board" in op.pane) return { error: "The board is always open; use move to place it." };
      const made = contentFor(op.pane, env);
      if ("error" in made) return made;
      const next = dropContent(state, target.id, ZONES[op.zone], keep && (!("ticket" in op.pane) || !op.pane.tab || keep.content.kind === "ticketTab") ? keep.content : made.content);
      return done(next, `Put ${name} ${op.zone} of ${describeRef(op.target)}.`, `${name} is already there.`);
    }
    case "resize": {
      if (!leaf) return { error: `${name} isn't open. Use open to show it.` };
      if (!(op.width >= MIN_WIDTH_FRACTION && op.width <= MAX_WIDTH_FRACTION)) return { error: `width is a fraction of the window between ${MIN_WIDTH_FRACTION} and ${MAX_WIDTH_FRACTION}.` };
      if (leaf.content.kind === "board") return { error: "The board takes whatever the other panes leave: resize one of them instead." };
      const px = op.width * area.width;
      const focused = focusPane(state, leaf.id);
      const have = layoutPanes(focused, area).leaves.find((l) => l.leaf.id === leaf.id)!.rect.w * area.width;
      if (Math.abs(have - px) < WIDTH_TOLERANCE_PX) return done(focused, `Focused ${name}; it is already that wide.`, `${name} is already that wide.`);
      const next = setPaneWidth(focused, area, px);
      if (next === focused) return { error: `${name} can't be ${Math.round(op.width * 100)}% wide: the board or a neighbour would drop below its minimum, or nothing beside it can give the room (zoomed, or stacked with the board).` };
      return { state: next, outcome: "applied", message: `${name} is now ${Math.round(op.width * 100)}% of the window wide.` };
    }
  }
}

export { findLeaf };
