// A chief of staff's window tool (DESIGN.md "Chief of staff panes"): arrange the splits of the Mac
// app's window, so the tickets and terminals it is talking about sit side by side. The layout lives
// in the Mac app alone; HarnessOps.arrangePanes carries one op there and the answer back.

import type { PaneOp, PaneRef, PaneZone } from "@harness/shared";
import { errorResult, defineTool, schema } from "./util";

const ZONES: PaneZone[] = ["left", "right", "above", "below"];
const OPS = ["get_layout", "open", "split", "move", "resize", "close", "focus"] as const;

const refSchema = (what: string) => ({
  type: "object",
  description: `${what}, named by what it shows: {"ticket": "KEY", "tab"?: "spec"|"activity"|"children"|"transcript"|"agents"|"browser"|"details"|"changes"}, {"terminal": "ID"} (from list_terminals), or {"board": true}.`,
  properties: {
    ticket: { type: "string", minLength: 1 },
    tab: { type: "string" },
    terminal: { type: "string", minLength: 1 },
    board: { type: "boolean" },
  },
});

/** A ref from the model's JSON: exactly one of ticket, terminal or board; null (with why) otherwise. */
function parseRef(raw: unknown, name: string): PaneRef | string {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return `${name} must be an object: {"ticket": "KEY"}, {"terminal": "ID"} or {"board": true}.`;
  const named = ["ticket", "terminal", "board"].filter((k) => r[k] !== undefined);
  if (named.length !== 1) return `${name} must name exactly one of ticket, terminal or board.`;
  if (typeof r.ticket === "string" && r.ticket) return typeof r.tab === "string" ? { ticket: r.ticket, tab: r.tab } : { ticket: r.ticket };
  if (typeof r.terminal === "string" && r.terminal) return { terminal: r.terminal };
  if (r.board === true) return { board: true };
  return `${name} has an empty or invalid ${named[0]}.`;
}

export interface ArrangePanesInput {
  op: (typeof OPS)[number];
  pane?: unknown;
  target?: unknown;
  zone?: string;
  width?: number;
}

/** The wire op for a call, or the problem with it. */
export function parsePaneOp(input: ArrangePanesInput): PaneOp | string {
  if (input.op === "get_layout") return { op: "get_layout" };
  const pane = parseRef(input.pane, "pane");
  if (typeof pane === "string") return pane;
  switch (input.op) {
    case "open":
    case "close":
    case "focus":
      return { op: input.op, pane };
    case "resize":
      return typeof input.width === "number" ? { op: "resize", pane, width: input.width } : "resize needs width, a fraction of the window (0.1 to 0.9).";
    case "split":
    case "move": {
      const target = parseRef(input.target, "target");
      if (typeof target === "string") return target;
      if (!ZONES.includes(input.zone as PaneZone)) return `${input.op} needs zone: one of ${ZONES.join(", ")}.`;
      return { op: input.op, pane, target, zone: input.zone as PaneZone };
    }
    default:
      return `Unknown op: ${String(input.op)}. Use one of ${OPS.join(", ")}.`;
  }
}

export const arrangePanes = defineTool<ArrangePanesInput>({
  name: "arrange_panes",
  description:
    "Arrange the window splits in the Mac app the person is looking at (Mac only; with no Mac connected it fails and changes nothing). One change per call. " +
    "get_layout: where the panes are now. open: show a ticket or terminal (an open one is just focused). split: show it in a new split on a zone (left, right, above, below) of `target`, moving it if it is open. move: put an open pane on a zone of `target`. " +
    "resize: give an open pane `width`, a fraction of the window (0.1 to 0.9), the board taking the difference. close, focus. " +
    "Only tickets you cover and terminals in their worktrees can be named; anything else behaves as not found. " +
    "The result says whether the window changed (a pane that is already where you asked is reported as unchanged) and the layout after: your panes with their position as fractions of the window, and a count of the other panes you can't see. " +
    "A timeout means the outcome is unknown: call get_layout before trying again. It rearranges the window while the person may be using it, so do it when asked or when it plainly helps what they are doing.",
  inputSchema: schema(
    {
      op: { type: "string", enum: [...OPS] },
      pane: refSchema("The pane to act on"),
      target: refSchema("For split and move, the open pane to place it beside"),
      zone: { type: "string", enum: ZONES, description: "For split and move, which side of the target." },
      width: { type: "number", minimum: 0.1, maximum: 0.9, description: "For resize, the fraction of the window." },
    },
    ["op"],
  ),
  async run(input, ctx) {
    const op = parsePaneOp(input);
    if (typeof op === "string") return errorResult(op);
    const r = await ctx.ops.arrangePanes(ctx, op);
    return JSON.stringify({ outcome: r.outcome, message: r.message, board: r.scope, layout: r.layout }, null, 2);
  },
});

export const paneTools = [arrangePanes];
