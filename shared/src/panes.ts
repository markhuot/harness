// The arrange_panes tool's wire shapes (DESIGN.md "Chief of staff panes"): what the service asks a Mac
// to do to its window splits (app.request) and what the Mac answers (app.reply). Only the Mac knows the
// layout, so the service carries the request and the answer without reading either.

/**
 * A pane named by what it shows, never by an id: leaf ids aren't stable across a relaunch, a
 * normalize or a drag. `tab` picks a ticket's tab (spec, activity, …), `board` the board itself.
 */
export type PaneRef = { ticket: string; tab?: string } | { terminal: string } | { board: true };

export type PaneZone = "left" | "right" | "above" | "below";

/** One change to the window per call, so there is nothing to order and nothing half applied. */
export type PaneOp =
  | { op: "get_layout" }
  /** Show the pane (focus it when it's open already). */
  | { op: "open"; pane: PaneRef }
  /** Show the pane in a new split on `zone` of `target`; an open pane moves there. */
  | { op: "split"; pane: PaneRef; target: PaneRef; zone: PaneZone }
  /** Move an open pane to `zone` of `target`. */
  | { op: "move"; pane: PaneRef; target: PaneRef; zone: PaneZone }
  /** Give an open pane `width` of the window (a fraction, 0.1 to 0.9), the board taking the difference. */
  | { op: "resize"; pane: PaneRef; width: number }
  | { op: "close"; pane: PaneRef }
  | { op: "focus"; pane: PaneRef };

/** What a chief of staff covers: the only content its ops may name or see. */
export interface PaneAllowed {
  tickets: string[];
  terminals: string[];
}

export interface PaneLayoutPane {
  pane: PaneRef;
  focused: boolean;
  /** Where it sits in the window, as fractions of the pane area. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneLayoutView {
  panes: PaneLayoutPane[];
  /** Panes of something else (a ticket the chief doesn't cover, a file, a New session), named only by how many. */
  others: number;
  zoomed: boolean;
}

export interface PaneArrangeResult {
  /** "applied" changed the window; "unchanged" found it as asked already (an open pane re-focused, a pane already closed). */
  outcome: "applied" | "unchanged";
  message: string;
  /** The board the op landed on, the one in the Mac's window. */
  scope: string;
  layout: PaneLayoutView;
}

/** Service → Mac: do something in the app and answer with the same `id`. */
export type AppRequest = { kind: "panes.arrange"; op: PaneOp; allowed: PaneAllowed };

/** Mac → service: `error` is a refusal the agent can act on (not found, not open, can't fit). */
export type AppReply = { ok: true; result: PaneArrangeResult } | { ok: false; error: string };

/** The op with each pane it names passed through `fn` (the service canonicalizes ticket keys this way). */
export function mapPaneRefs(op: PaneOp, fn: (ref: PaneRef) => PaneRef): PaneOp {
  if (op.op === "get_layout") return op;
  if (op.op === "split" || op.op === "move") return { ...op, pane: fn(op.pane), target: fn(op.target) };
  return { ...op, pane: fn(op.pane) };
}
