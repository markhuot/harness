// The global pane commands (state/keys.ts "Panes"): moving between panes and the sidebar, closing,
// zooming, and Escape. Registered once by the shell for the board scope on screen (null off the
// board, where only the sidebar and the window are left to act on).

import { boardLeaf, escapePanes, findLeaf, focusPane, layoutPanes, paneInDirection, toggleZoom, getPanes, type PaneDir } from "../state/panes";
import { GLOBAL_OWNER, useCommands } from "./commands";
import { hasDraftCloser, requestClosePane } from "./draftClose";
import { focusPaneBy, focusSidebar } from "./paneFocus";
import { popOutToWindow } from "./paneHeader";


const inSidebar = () => !!document.activeElement?.closest("#app-sidebar");

/** Off the board: the main area's current list item, or its first focusable element. */
function focusMain(): boolean {
  const main = document.querySelector<HTMLElement>(".main");
  const el =
    main?.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]') ??
    main?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex="0"]');
  el?.focus();
  return !!el;
}

/** Close the window (⌘W with no pane to close). Electron lets the page close its own window. */
const closeWindow = () => window.harness && window.close();

export function usePaneCommands(scope: string | null, sidebarOpen: boolean) {
  const move = (dir: PaneDir) => {
    if (inSidebar()) {
      if (dir === "right") scope ? focusPaneBy(scope, (s) => s) : focusMain();
      return;
    }
    if (!scope) {
      if (dir === "left" && sidebarOpen) focusSidebar();
      return;
    }
    const s = getPanes(scope);
    const from = s.focusedId ?? boardLeaf(s.root)?.id;
    if (!from) return;
    const to = paneInDirection(layoutPanes(s), from, dir, { sidebar: sidebarOpen });
    if (to === "sidebar") focusSidebar();
    else if (to) focusPaneBy(scope, (st) => focusPane(st, to));
    // Nothing that way: stay, but make sure the focus is in the pane the keyboard acts on.
    else focusPaneBy(scope, (st) => (st.focusedId ? st : focusPane(st, from)));
  };

  useCommands(GLOBAL_OWNER, {
    "pane.left": () => move("left"),
    "pane.right": () => move("right"),
    "pane.up": () => move("up"),
    "pane.down": () => move("down"),
    "pane.close": () => {
      const s = scope ? getPanes(scope) : null;
      const leaf = s?.focusedId ? findLeaf(s.root, s.focusedId) : null;
      if (scope && leaf && leaf.content.kind !== "board") requestClosePane(scope, leaf.id, true);
      else closeWindow();
    },
    "pane.zoom": !!scope && (() => focusPaneBy(scope!, (s) => toggleZoom(s))),
    // The focused ticket or terminal into a window of its own (in that window, ⇧⌘O puts it back:
    // components/PopoutWindow.tsx).
    "pane.popout":
      !!scope &&
      !!window.harness &&
      (() => {
        const id = getPanes(scope!).focusedId;
        if (id) popOutToWindow(scope!, id);
      }),
    "pane.escape":
      !!scope &&
      (() => {
        // A draft's pane asks before it closes (a zoom still just ends).
        const s = getPanes(scope!);
        if (!s.zoomedId && s.focusedId && hasDraftCloser(s.focusedId)) return requestClosePane(scope!, s.focusedId, true);
        focusPaneBy(scope!, escapePanes);
      }),
  });
}
