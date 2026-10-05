// Message drafts (DESIGN.md "Message drafts"): the message the human is writing to a ticket's
// agent lives on the ticket (Ticket.messageDraft), so it can be started on one device and finished
// on another. The composers save it as it's typed (debounced PUTs of the whole draft, each tagged
// with the editor's origin) and decide here when the saved copy replaces what they show:
//   • never their own save coming back (same origin), however late it arrives;
//   • never while the field has focus: what's under the caret is the user's (an uncontrolled input),
//     and their next save wins (last write wins);
//   • never over edits that haven't gone out yet;
// otherwise, the saved copy (another device's edit, or its send clearing it) is shown.

import type { Attachment, MessageDraft, MessageDraftBody } from "../protocol";
import { attachmentInputs, sameAttachments } from "./promptAttachments";

/** What a composer shows and saves. */
export interface MessageDraftValue {
  text: string;
  attachments: Attachment[];
}

export const EMPTY_MESSAGE_DRAFT: MessageDraftValue = { text: "", attachments: [] };

/** The saved draft as a composer shows it (none: empty). */
export function messageDraftValue(d: MessageDraft | null | undefined): MessageDraftValue {
  return d ? { text: d.text, attachments: d.attachments } : EMPTY_MESSAGE_DRAFT;
}

export function sameMessageDraft(a: MessageDraftValue, b: MessageDraftValue): boolean {
  return a.text === b.text && sameAttachments(a.attachments, b.attachments);
}

/** The PUT that saves `v` from the editor `origin` (empty clears the saved draft). */
export function messageDraftBody(v: MessageDraftValue, origin: string): MessageDraftBody {
  return { text: v.text, attachments: attachmentInputs(v.attachments), origin };
}

export interface AdoptMessageDraftInput {
  /** Ticket.messageDraft as the store has it now */
  saved: MessageDraft | null | undefined;
  /** This editor's origin */
  origin: string;
  /** The field has focus */
  focused: boolean;
  /** Edits this editor hasn't saved yet (waiting on the debounce, or on their way) */
  dirty: boolean;
  /** What the editor shows now */
  shown: MessageDraftValue;
}

/**
 * What the editor should show instead of `shown` now that the store has `saved`, or null to keep
 * what it shows (see the rules at the top).
 */
export function adoptMessageDraft({ saved, origin, focused, dirty, shown }: AdoptMessageDraftInput): MessageDraftValue | null {
  if (focused || dirty) return null;
  if (saved && saved.origin !== null && saved.origin === origin) return null;
  const next = messageDraftValue(saved);
  return sameMessageDraft(next, shown) ? null : next;
}

/** A new editor's origin: unique per open composer, so two windows on one Mac don't echo-match. */
export function newDraftOrigin(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
