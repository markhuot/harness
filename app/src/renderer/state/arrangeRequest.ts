// A chief of staff's arrange_panes arriving at this Mac (app.request, kind panes.arrange): apply it
// to the board on screen and build the app.reply. The pane rules are in paneArrange.ts; this is
// the part that touches the pane store.

import type { AppReply, AppRequest } from "@harness/shared";
import { applyPaneOp, describeLayout, type ArrangeEnv } from "./paneArrange";
import { getPanes, updatePanes, type PaneArea } from "./panes";

export function arrangeOnBoard(request: AppRequest, scope: string, area: PaneArea, terminal: ArrangeEnv["terminal"]): AppReply {
  const { allowed, op } = request;
  try {
    const result = applyPaneOp(getPanes(scope), op, { allowed, area, terminal });
    if ("error" in result) return { ok: false, error: result.error };
    if (result.outcome === "applied") updatePanes(scope, () => result.state);
    // The layout is read back from the store, so it is what the window now holds.
    return { ok: true, result: { outcome: result.outcome, message: result.message, scope, layout: describeLayout(getPanes(scope), allowed, area) } };
  } catch (e) {
    return { ok: false, error: `The Mac couldn't apply that: ${(e as Error).message}` };
  }
}
