// The keyboard shortcuts overlay (? or ⌘/): every command with a key, from the registry
// (state/keys.ts), by group. Actions have no keys; they're run from the palette.

import "./palette.css";
import { useEffect, useRef } from "react";
import { COMMANDS, commandKeys, type CommandGroup } from "../state/keys";
import { Modal } from "../components/bits";

const GROUPS: CommandGroup[] = ["General", "Panes", "Board", "Ticket", "Lists"];

interface Row {
  id: string;
  label: string;
  keys: string[];
}

/** The rows for a group, in registry order; tab.1 … tab.9 are one row. */
export function shortcutRows(group: CommandGroup): Row[] {
  const rows: Row[] = [];
  for (const c of COMMANDS) {
    if (c.group !== group || !c.keys.length) continue;
    if (/^tab\.\d$/.test(c.id)) {
      if (c.id === "tab.1") rows.push({ id: "tab.n", label: "Jump to tab 1–9", keys: ["1–9"] });
      continue;
    }
    rows.push({ id: c.id, label: c.label, keys: commandKeys(c.id) });
  }
  return rows;
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  // Put the focus back where it was (the close button has it while open).
  const origin = useRef(document.activeElement);
  useEffect(
    () => () => {
      const el = origin.current;
      if (el instanceof HTMLElement && el.isConnected && (!document.activeElement || document.activeElement === document.body)) el.focus();
    },
    [],
  );
  return (
    <Modal onClose={onClose} width={720}>
      <div className="modal-head" data-testid="shortcuts">
        <strong>Keyboard Shortcuts</strong>
      </div>
      <div className="modal-body shortcuts-body">
        {GROUPS.map((g) => {
          const rows = shortcutRows(g);
          if (!rows.length) return null;
          return (
            <section key={g} className="shortcuts-group" aria-label={g}>
              <h3>{g}</h3>
              {rows.map((r) => (
                <div key={r.id} className="shortcuts-row" data-testid="shortcuts-row" data-id={r.id}>
                  <span>{r.label}</span>
                  <span className="shortcuts-keys">
                    {r.keys.map((k) => (
                      <span key={k} className="kbd">
                        {k}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="modal-foot">
        <span className="shortcuts-note">Ticket actions (Approve, Start work, Delete…) are in the command palette: {commandKeys("palette")[0]}</span>
        <div className="grow" />
        <button className="btn btn-ghost" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
