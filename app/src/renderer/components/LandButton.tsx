// The ticket's Approve / Complete split button (how the approved work lands) and the sheet that
// asks for completion instructions. The choices come from state/approveMenu.ts.

import { useState } from "react";
import type { CompletionAction, Ticket } from "@harness/shared";
import { Icon, type IconName } from "./Icon";
import { MenuButton, MOD, Modal } from "./bits";
import type { LandChoice, LandMenu, LandMode } from "../state/approveMenu";

export function LandButton({
  menu,
  mode,
  icon,
  primaryClass = "btn-primary",
  disabled = false,
  title,
  onChoose,
}: {
  menu: LandMenu;
  mode: LandMode;
  icon: IconName;
  primaryClass?: string;
  /** The primary half and the menu's action choices; the take-no-action choice stays available. */
  disabled?: boolean;
  title?: string;
  onChoose: (choice: LandChoice) => void;
}) {
  const noun = mode === "approve" ? "approve" : "complete";
  return (
    <div className="split-btn" role="group" aria-label={mode === "approve" ? "Approve" : "Complete"} data-testid={`${mode}-split`}>
      <button className={`btn ${primaryClass} split-btn-main`} disabled={disabled} title={title} onClick={() => onChoose(menu.primary)} data-testid={`${mode}-primary`}>
        <Icon name={icon} strokeWidth={mode === "approve" ? 2.25 : undefined} /> {menu.primary.label}
      </button>
      <MenuButton
        className="split-btn-more"
        menuClassName={`land-menu land-menu-${mode}`}
        align="left"
        trigger={(toggle, open) => (
          <button
            className={`btn ${primaryClass} split-btn-chevron`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Other ways to ${noun}`}
            title={`Other ways to ${noun}`}
            data-testid={`${mode}-menu`}
            onClick={toggle}
          >
            <Icon name="chevronDown" strokeWidth={2.25} />
          </button>
        )}
      >
        {(close) => (
          <>
            {menu.items.map((c) => (
              <button key={c.label} role="menuitem" disabled={disabled} data-action={c.kind === "none" ? "none" : c.action} onClick={() => (close(), onChoose(c))}>
                <Icon name={c.kind !== "none" && c.action === "pr" ? "branch" : c.kind === "sheet" ? "edit" : "check"} /> {c.label}
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
  mode: LandMode;
  action: CompletionAction;
  required: boolean;
}

const SHEET_COPY: Record<CompletionAction, string> = {
  merge: "The agent merges the worktree branch, cleans up, and marks the ticket done.",
  pr: "The agent pushes the branch and opens a pull request (or updates the one it opened), then marks the ticket done.",
  custom: "The agent lands the work the way you describe, then marks the ticket done.",
};

export function LandSheet({
  ticket,
  sheet,
  parentBranch,
  onSubmit,
  onClose,
}: {
  ticket: Ticket;
  sheet: LandSheetState;
  parentBranch: string | null;
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
  const verb = sheet.mode === "approve" ? "Approve" : "Complete";
  const copy = parentBranch ? `The agent merges the worktree branch into ${parentBranch}, cleans up, and marks the ticket done.` : SHEET_COPY[sheet.action];
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>
          {verb} {ticket.key}
        </strong>
      </div>
      <div className="modal-body" data-testid="land-sheet" data-action={sheet.action}>
        <p className="dim" style={{ marginTop: 0 }}>
          {copy}
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
          {verb} <span className="kbd">{MOD}↩</span>
        </button>
      </div>
    </Modal>
  );
}
