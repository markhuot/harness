// The ticket's Approve split button (how the approved work lands) and the sheet that asks for
// completion instructions. The choices come from state/approveMenu.ts.

import { useState } from "react";
import { keyLabel, type CompletionAction, type Ticket } from "@harness/shared";
import { Icon } from "./Icon";
import { MenuButton, MOD, Modal } from "./bits";
import type { LandChoice, LandMenu } from "../state/approveMenu";

export function LandButton({
  menu,
  locked = false,
  title,
  onChoose,
}: {
  menu: LandMenu;
  /** Everything disabled, the menu too: a conductor approves and lands the ticket (`title` says so). */
  locked?: boolean;
  title?: string;
  onChoose: (choice: LandChoice) => void;
}) {
  return (
    <div className="split-btn" role="group" aria-label="Approve" title={locked ? title : undefined} data-testid="approve-split">
      <button className="btn btn-primary split-btn-main" disabled={locked} title={title} onClick={() => onChoose(menu.primary)} data-testid="approve-primary">
        <Icon name="check" strokeWidth={2.25} /> {menu.primary.label}
      </button>
      <MenuButton
        className="split-btn-more"
        menuClassName="land-menu land-menu-approve"
        align="left"
        trigger={(toggle, open) => (
          <button
            className="btn btn-primary split-btn-chevron"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Other ways to approve"
            title={locked ? title : "Other ways to approve"}
            disabled={locked}
            data-testid="approve-menu"
            onClick={toggle}
          >
            <Icon name="chevronDown" strokeWidth={2.25} />
          </button>
        )}
      >
        {(close) => (
          <>
            {menu.items.map((c) => (
              <button key={c.label} role="menuitem" data-action={c.kind === "none" ? "none" : c.action} onClick={() => (close(), onChoose(c))}>
                <Icon name={c.kind !== "none" && c.action === "pr" ? "branch" : c.kind !== "none" && c.action === "cleanup" ? "trash" : c.kind === "sheet" ? "edit" : "check"} /> {c.label}
              </button>
            ))}
            {menu.items.length > 0 && <hr />}
            <button role="menuitem" data-action="none" onClick={() => (close(), onChoose(menu.noAction))}>
              <Icon name="checkCircle" /> {menu.noAction.label}
            </button>
          </>
        )}
      </MenuButton>
    </div>
  );
}

/** The sheet a `sheet` choice opens. */
export interface LandSheetState {
  action: CompletionAction;
  required: boolean;
}

const SHEET_COPY: Record<CompletionAction, string> = {
  merge: "The agent merges the worktree branch, cleans up, and marks the ticket done.",
  pr: "The agent pushes the branch and opens a pull request (or updates the one it opened), then marks the ticket done.",
  cleanup: "The agent checks the work is already pushed or merged, removes the worktree and the harness branch, and marks the ticket done. Anything that would be lost leaves the ticket blocked instead.",
  custom: "The agent lands the work the way you describe, then marks the ticket done.",
};

export function LandSheet({
  ticket,
  sheet,
  onSubmit,
  onClose,
}: {
  ticket: Ticket;
  sheet: LandSheetState;
  /** Resolves truthy when the request went through (the sheet closes). */
  onSubmit: (instructions: string | undefined) => Promise<unknown>;
  onClose: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const text = instructions.trim();
  const blocked = (sheet.required && !text) || busy;
  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    const ok = await onSubmit(text || undefined);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>
          Approve {keyLabel(ticket)}
        </strong>
      </div>
      <div className="modal-body" data-testid="land-sheet" data-action={sheet.action}>
        <p className="dim" style={{ marginTop: 0 }}>
          {SHEET_COPY[sheet.action]}
        </p>
        <textarea
          autoFocus
          className="textarea"
          rows={4}
          placeholder={sheet.required ? "How should the work land? e.g. “cherry-pick onto release/2.4 and tag it”" : "Optional instructions, e.g. “squash-merge and delete the branch”"}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        />
      </div>
      <div className="modal-foot">
        <div className="grow" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={blocked} onClick={submit}>
          Approve <span className="kbd">{MOD}↩</span>
        </button>
      </div>
    </Modal>
  );
}
