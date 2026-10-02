// Pieces every pane header shares (ticket panes in views/TicketDetail.tsx, terminals in
// views/TerminalPane.tsx): the drag grip, the More menu's "Move pane" rows, and the button that
// pops a pane out into its own window (or, in that window, puts it back on the board).

import type { Project } from "@harness/shared";
import { ALL_SCOPE, scopeProject } from "@harness/shared/state";
import { canPopOut, findLeaf, getPanes, isPopoutScope, leaves, movePane, paneLabel, popInPane, popOutPane, updatePanes, usePanes, type DropZone } from "../state/panes";
import { formatRoute } from "../state/route";
import { commandKeys } from "../state/keys";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { usePaneScope, usePopout, type PopoutInfo } from "./paneContext";
import { dragProps } from "./paneDrag";
import { paneElement } from "./paneFocus";

/**
 * Pop the pane `paneId` of `scope` out into a window of its own, opened over the spot the pane
 * had. False when there's nothing to pop out (the board, a New session, no desktop app).
 */
export function popOutToWindow(scope: string, paneId: string): boolean {
  const bridge = window.harness?.popout;
  const leaf = findLeaf(getPanes(scope).root, paneId);
  if (!bridge || !leaf || !canPopOut(leaf.content) || isPopoutScope(scope)) return false;
  const r = paneElement(paneId)?.getBoundingClientRect();
  const id = crypto.randomUUID();
  if (!popOutPane(scope, paneId, id)) return false;
  const bounds = r && { x: Math.round(window.screenX + r.left), y: Math.round(window.screenY + r.top), width: Math.round(r.width), height: Math.round(r.height) };
  // No window came up: put the pane back where it was, rather than leave it nowhere.
  bridge.open({ id, route: formatRoute({ view: "popout", id, fromScope: scope }), bounds }).catch(() => popInPane(id, scope));
  return true;
}

/**
 * Put a pop-out's pane back on the board it came from (All projects if that project is gone), and
 * bring the main window forward on that board. The pop-out window closes once its pane is gone.
 */
export function popBackIn({ id, fromScope }: PopoutInfo, projects: Readonly<Record<string, Project>>) {
  const to = fromScope === ALL_SCOPE || projects[fromScope] ? fromScope : ALL_SCOPE;
  popInPane(id, to);
  void window.harness?.popout.showMain(formatRoute({ view: "board", projectId: scopeProject(to) ?? null, ticketKey: null, tab: "spec" }));
}

const keyHint = (id: string) => {
  const keys = commandKeys(id);
  return keys.length ? ` (${keys[0]})` : "";
};

/**
 * The header button beside Maximize: "Pop out" opens the pane in its own window; in a pop-out
 * window it's "Put back on the board". Only tickets and terminals pop out, and only in the app.
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
  // A pop-out window's pane has nowhere to be dragged to.
  if (usePopout()) return null;
  return (
    <span className="pane-grip" data-testid="pane-grip" title="Drag onto another pane to move this one (or use More → Move pane)" aria-hidden {...dragProps(chip, title, paneId, label)}>
      <Icon name="grip" size={13} />
    </span>
  );
}
