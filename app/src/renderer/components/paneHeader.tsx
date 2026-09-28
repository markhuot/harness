// Pieces every pane header shares (ticket panes in views/TicketDetail.tsx, terminals in
// views/TerminalPane.tsx): the drag grip and the More menu's "Move pane" rows.

import { leaves, movePane, paneLabel, updatePanes, usePanes, type DropZone } from "../state/panes";
import { Icon } from "./Icon";
import { usePaneScope } from "./paneContext";
import { dragProps } from "./paneDrag";

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
export function PaneGrip({ paneId, chip, title }: { paneId: string; chip: string; title: string }) {
  return (
    <span className="pane-grip" data-testid="pane-grip" title="Drag onto another pane to move this one (or use More → Move pane)" aria-hidden {...dragProps(chip, title, paneId)}>
      <Icon name="grip" size={13} />
    </span>
  );
}
