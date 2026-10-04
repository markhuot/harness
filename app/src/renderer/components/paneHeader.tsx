// Pieces every pane header shares (ticket panes in views/TicketDetail.tsx, terminals in
// views/TerminalPane.tsx): the drag grip, the More menu's "Move pane" rows, and the button that
// pops a pane out into its own window (or, in that window, puts it back on the board).

import { canPopOut, findLeaf, leaves, movePane, paneLabel, updatePanes, usePanes, type DropZone } from "../state/panes";
import { commandKeys } from "../state/keys";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { useBoardScope, usePaneScope, usePopout } from "./paneContext";
import { dragProps } from "./paneDrag";
import { popBackIn, popOutToWindow } from "./popoutOpen";

const keyHint = (id: string) => {
  const keys = commandKeys(id);
  return keys.length ? ` (${keys[0]})` : "";
};

/**
 * The header button beside Maximize: "Pop out" opens the pane in its own window; in a pop-out
 * window it's "Put back on the board". Every pane but the board pops out (canPopOut), only in the app.
 */
export function PaneWindowButton({ paneId }: { paneId: string }) {
  const scope = usePaneScope();
  const popout = usePopout();
  const { state } = useStore();
  const leaf = findLeaf(usePanes(scope).root, paneId);
  if (!window.harness || !leaf || !canPopOut(leaf.content)) return null;
  if (popout) {
    return (
      <button className="btn btn-ghost btn-icon" data-testid="pane-popin" onClick={() => popBackIn(popout, state.projects)} title={`Put back on the board${keyHint("pane.popout")}`} aria-label="Put back on the board">
        <Icon name="popin" />
      </button>
    );
  }
  return (
    <button className="btn btn-ghost btn-icon" data-testid="pane-popout" onClick={() => popOutToWindow(scope, paneId)} title={`Pop out to a window${keyHint("pane.popout")}`} aria-label="Pop out to a window">
      <Icon name="popout" />
    </button>
  );
}

const MOVES: [DropZone, string, string][] = [
  ["left", "←", "left of"],
  ["right", "→", "right of"],
  ["top", "↑", "above"],
  ["bottom", "↓", "below"],
];

/**
 * "Move pane" in a pane header's More menu: a row per other pane (the board, open tickets, terminals)
 * with left/right/above/below buttons that re-dock this pane there (movePane), the keyboard way to
 * do what dragging the header grip does. The board is always a target, so there's always a row.
 */
export function MovePaneItems({ paneId, onDone }: { paneId: string; onDone: () => void }) {
  const scope = usePaneScope();
  const targets = leaves(usePanes(scope).root).filter((l) => l.id !== paneId);
  // A pop-out window has no other pane to move beside.
  if (!targets.length) return null;
  return (
    <>
      <div className="menu-caption">Move pane</div>
      {targets.map((t) => {
        const name = paneLabel(t.content);
        return (
          <div key={t.id} className="menu-move" role="group" aria-label={`Move beside ${name}`}>
            <span className="menu-move-label">{t.content.kind === "board" ? "Board" : name}</span>
            {MOVES.map(([zone, glyph, word]) => (
              <button
                key={zone}
                data-testid={`move-pane-${zone}-${t.id}`}
                aria-label={`Move pane ${word} ${name}`}
                title={`Move pane ${word} ${name}`}
                onClick={() => (onDone(), updatePanes(scope, (s) => movePane(s, paneId, t.id, zone)))}
              >
                {glyph}
              </button>
            ))}
          </div>
        );
      })}
      <hr />
    </>
  );
}

/** Drag a pane by this onto a half of another pane to move it there. `chip`/`title` label the drag image. */
export function PaneGrip({ paneId, chip, title, label = chip }: { paneId: string; chip: string; title: string; /** The drag image's key text, when it isn't `chip` */ label?: string }) {
  const boardScope = useBoardScope();
  // A pop-out window's pane has nowhere to be dragged to.
  if (usePopout()) return null;
  return (
    <span
      className="pane-grip"
      data-testid="pane-grip"
      title="Drag onto another pane to move this one, or out of the window to pop it out (or use More → Move pane)"
      aria-hidden
      {...dragProps({ kind: "pane", leafId: paneId }, { chip: label, title }, boardScope)}
    >
      <Icon name="grip" size={13} />
    </span>
  );
}
