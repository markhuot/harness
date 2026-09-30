// A pop-out window: one ticket or terminal pane on its own, opened from the pane header's pop-out
// button (or ⇧⌘O). Its pane is the pane store's `popout:<id>` scope (state/panes.ts "Pop-out
// windows"), so the pane works as it does on a board: tabs, links to other tickets, a terminal
// re-attaching to its shell. Closing the pane closes the window, and closing the window closes the
// pane (the main process tells the main window, which drops it). "Put back on the board" docks the
// pane on the board it came from and brings the main window forward there.

import { useEffect, useRef, useState } from "react";
import { ticketByKey } from "@harness/shared/state";
import { getPopoutPanes, leaves, paneLabel, popoutScope, reloadPanes, usePopoutPanes } from "../state/panes";
import { useStore } from "../state/store";
import { GLOBAL_OWNER, commandOrigin, useCommands, useKeyboardDispatcher } from "./commands";
import { requestClosePane } from "./draftClose";
import { PopoutContext, PaneScopeContext, type PopoutInfo } from "./paneContext";
import { popBackIn } from "./paneHeader";
import { Pane } from "./PaneWorkspace";
import { CommandPalette } from "../views/CommandPalette";
import { ShortcutsOverlay } from "../views/Shortcuts";
import "./panes.css";

const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
/** How long a window that opens before its pane reaches this window's store waits for it. */
const ARRIVAL_MS = 1500;

export function PopoutWindow({ id, fromScope }: PopoutInfo) {
  const { state } = useStore();
  const panes = usePopoutPanes(id);
  const leaf = panes ? leaves(panes.root)[0] : undefined;
  const scope = popoutScope(id);
  const info = useRef<PopoutInfo>({ id, fromScope }).current;
  const [palette, setPalette] = useState<Element | null>(null);
  const [shortcuts, setShortcuts] = useState(false);

  // No pane: it closed or went back to a board, so the window goes too. One that hasn't arrived
  // yet (the write that popped it out still on its way) gets a moment, and a fresh read.
  const seen = useRef(false);
  useEffect(() => {
    if (leaf) return void (seen.current = true);
    const close = () => void window.harness?.popout.close(id);
    if (seen.current) return close();
    const t = setTimeout(() => {
      reloadPanes();
      if (!getPopoutPanes(id)) close();
    }, ARRIVAL_MS);
    return () => clearTimeout(t);
  }, [!!leaf, id]);

  // The window's title (the Window menu, Mission Control): the ticket, or the terminal's title.
  const c = leaf?.content;
  const ticket = c?.kind === "ticket" ? ticketByKey(state, c.ticketKey) : undefined;
  const title = !c ? "Harness" : c.kind === "ticket" ? (ticket?.title ? `${c.ticketKey} · ${ticket.title}` : c.ticketKey) : paneLabel(c);
  useEffect(() => void (document.title = title), [title]);

  useKeyboardDispatcher();
  useCommands(GLOBAL_OWNER, {
    palette: () => setPalette((open) => (open ? null : commandOrigin() ?? document.body)),
    shortcuts: () => setShortcuts((open) => !open),
    // ⌘W closes the pane (a draft asks first), and the window with it.
    "pane.close": () => (leaf ? requestClosePane(scope, leaf.id, true) : window.close()),
    "pane.popout": () => popBackIn(info, state.projects),
  });

  return (
    <div className={`app popout-window ${window.harness?.platform === "darwin" ? "has-traffic-lights" : ""}`}>
      <main className="main">
        <PaneScopeContext.Provider value={scope}>
          <PopoutContext.Provider value={info}>
            <div className="pane-workspace" data-testid="pane-workspace">
              {leaf && <Pane leaf={leaf} rect={WHOLE} hidden={false} focused={false} active corner zoomed={false} />}
            </div>
          </PopoutContext.Provider>
        </PaneScopeContext.Provider>
      </main>
      {palette && <CommandPalette origin={palette} onClose={() => setPalette(null)} onShortcuts={() => setShortcuts(true)} />}
      {shortcuts && <ShortcutsOverlay onClose={() => setShortcuts(false)} />}
    </div>
  );
}
