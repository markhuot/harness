// Runs a ticket's actions (state/ticketActions.ts) for whoever offers them: the ticket pane's
// buttons and More menu, the ⌘K palette and the board card's right-click menu. An action that needs
// input (notes, instructions, a confirmation) opens its dialog through `modals`, which the caller
// renders once: the board hosts one for every card, a ticket pane one of its own.

import { useState, type ReactNode } from "react";
import { keyLabel, type CompletionAction, type Ticket } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import type { LandChoice } from "../state/approveMenu";
import type { TicketAction } from "../state/ticketActions";
import { MOD, Modal } from "./bits";
import { LandSheet, type LandSheetState } from "./LandButton";

type Dialog = { kind: "changes" | "reopen" | "unblock"; ticketId: string } | { kind: "land"; ticketId: string; sheet: LandSheetState };

export interface TicketActionRunner {
  /** Run `action` on `ticket`. Approve takes `choice` (a way to approve), else its primary one. `onDeleted` runs after a confirmed delete went through. */
  run: (ticket: Ticket, action: Pick<TicketAction, "id" | "land">, opts?: { choice?: LandChoice; onDeleted?: () => void }) => void;
  /** One of the Approve split button's choices. */
  choose: (ticket: Ticket, choice: LandChoice) => void;
  /** The dialogs the actions open: render them once, anywhere. */
  modals: ReactNode;
}

export function useTicketActionRunner(): TicketActionRunner {
  const { state, client } = useStore();
  const act = useAction();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const approveWith = (ticket: Ticket, action: CompletionAction, instructions?: string) =>
    act(() => client.humanReview(ticket.key, { decision: "approve", action, ...(instructions ? { instructions } : {}) }), "Approved");
  const choose = (ticket: Ticket, c: LandChoice) => {
    if (c.kind === "none") return void act(() => client.completeTicket(ticket.key, { skipAgent: true }), `${keyLabel(ticket)} approved, no action taken`);
    if (c.kind === "sheet") return setDialog({ kind: "land", ticketId: ticket.id, sheet: { action: c.action, required: c.required } });
    void approveWith(ticket, c.action);
  };
  const run: TicketActionRunner["run"] = (ticket, action, opts) => {
    const k = ticket.key;
    // What confirms and toasts call it: "MH-62 · MH-124" for a linked ticket (its remote ID first).
    const label = keyLabel(ticket);
    switch (action.id) {
      case "start":
        return void act(() => client.startTicket(k));
      case "approve": {
        const c = opts?.choice ?? action.land?.primary;
        return c ? choose(ticket, c) : undefined;
      }
      case "requestChanges":
        return setDialog({ kind: "changes", ticketId: ticket.id });
      case "unblock":
        return setDialog({ kind: "unblock", ticketId: ticket.id });
      case "reopen":
        return setDialog({ kind: "reopen", ticketId: ticket.id });
      case "rerunReview":
        return void act(() => client.rerunAgentReview(k), "Agent review queued");
      case "markDone":
        return void act(() => client.completeTicket(k, { skipAgent: true }), `${label} marked done`);
      case "cancelStart":
        return void act(() => client.cancelStart(k), "Automatic start cancelled");
      case "withdrawApproval":
        return void act(() => client.withdrawApproval(k), "Waiting on a human review");
      case "cancelRun":
        return void act(() => client.cancelTicket(k), "Run cancelled");
      case "delete": {
        if (!confirm(`Delete ${label}? Its transcript, spec history and activity are removed too.`)) return;
        void act(() => client.deleteTicket(k), `${label} deleted`).then((ok) => ok && opts?.onDeleted?.());
      }
    }
  };

  // The ticket as it is now: gone (deleted elsewhere) closes the dialog.
  const ticket = dialog ? state.tickets[dialog.ticketId] : undefined;
  const close = () => setDialog(null);
  const modals = (
    <>
      {ticket && dialog?.kind === "changes" && <RequestChangesModal ticket={ticket} onClose={close} />}
      {ticket && dialog?.kind === "unblock" && <RequestChangesModal unblock ticket={ticket} onClose={close} />}
      {ticket && dialog?.kind === "reopen" && <RequestChangesModal reopen ticket={ticket} onClose={close} />}
      {ticket && dialog?.kind === "land" && (
        <LandSheet key={dialog.sheet.action} ticket={ticket} sheet={dialog.sheet} onSubmit={(instructions) => approveWith(ticket, dialog.sheet.action, instructions)} onClose={close} />
      )}
    </>
  );
  return { run, choose, modals };
}

/** Notes for the agent that send the ticket back to In progress: request changes (review) or re-open (done). */
export function RequestChangesModal({ ticket, onClose, reopen = false, unblock = false }: { ticket: Ticket; onClose: () => void; reopen?: boolean; unblock?: boolean }) {
  const { client } = useStore();
  const act = useAction();
  const [notes, setNotes] = useState("");
  const submit = async () => {
    if (!unblock && !notes.trim()) return;
    const ok = unblock
      ? await act(() => client.unblockTicket(ticket.key, { notes }), "Unblocked")
      : reopen
      ? await act(() => client.reopenTicket(ticket.key, { notes }), "Re-opened")
      : await act(() => client.humanReview(ticket.key, { decision: "request_changes", notes }), "Changes requested");
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>{unblock ? "Unblock" : reopen ? "Re-open" : "Request changes"}</strong>
        <span className="muted mono">{keyLabel(ticket)}</span>
      </div>
      <div className="modal-body">
        <textarea
          autoFocus
          className="textarea"
          rows={6}
          placeholder={unblock ? "Answer the block, or leave empty to let the agent carry on" : reopen ? "What should the agent do now?" : "What should the agent change?"}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        />
        <div className="field-hint" style={{ marginTop: 6 }}>
          {unblock
            ? "The ticket moves from Blocked to In progress and the agent gets your notes, if any."
            : reopen
            ? "The ticket moves from Done back to In progress and the agent gets your notes. If its worktree was removed, it's recreated."
            : "The ticket moves back to In progress and the agent gets your notes."}
        </div>
      </div>
      <div className="modal-foot">
        <div className="grow" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!unblock && !notes.trim()} onClick={submit}>
          {unblock ? "Unblock" : "Send to agent"} <span className="kbd">{MOD}↩</span>
        </button>
      </div>
    </Modal>
  );
}

