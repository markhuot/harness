// The ticket composer's "Move to in progress" switch. On (the default), a message acts on the
// ticket: a blocked or review ticket goes back to in progress, a planning ticket gets its plan
// revised. Off, the message is a chat: the agent answers and the ticket keeps its status.
//
// Turning it off is remembered per ticket for as long as the ticket is open, and for
// CHAT_MODE_TTL_MS after it's closed. Re-opening the ticket within that window keeps chatting
// (and the timer starts over the next time it closes).

import type { Ticket, TicketStatus } from "../protocol";

export const CHAT_MODE_TTL_MS = 5 * 60 * 1000;

/** ticket key → when chat mode lapses (null: the ticket is open, it never lapses while it is) */
export type ChatModes = Map<string, number | null>;

export function isChatMode(modes: ChatModes, key: string, now: number): boolean {
  if (!modes.has(key)) return false;
  const until = modes.get(key)!;
  return until === null || until > now;
}

/** The ticket was opened: an unexpired chat mode holds for as long as it stays open. */
export function openChatMode(modes: ChatModes, key: string, now: number): void {
  if (!modes.has(key)) return;
  if (isChatMode(modes, key, now)) modes.set(key, null);
  else modes.delete(key);
}

/** The ticket was closed: its chat mode lapses CHAT_MODE_TTL_MS from now. */
export function closeChatMode(modes: ChatModes, key: string, now: number): void {
  if (modes.has(key)) modes.set(key, now + CHAT_MODE_TTL_MS);
}

/** The switch was flipped on an open ticket (chat: true = "Move to in progress" off). */
export function setChatMode(modes: ChatModes, key: string, chat: boolean): void {
  if (chat) modes.set(key, null);
  else modes.delete(key);
}

/** The app-wide chat modes (module state: both apps keep one per process). */
export const chatModes: ChatModes = new Map();

/**
 * The switch's label when the ticket's composer offers it, else null: a message to an in-progress
 * ticket moves nothing, and one to a ticket waiting on a tool approval answers the approval.
 */
export function moveSwitchLabel(t: Pick<Ticket, "status" | "pendingApproval">): string | null {
  if (t.pendingApproval) return null;
  switch (t.status) {
    case "planning":
      return "Revise the plan";
    case "blocked":
    case "review":
      return "Move to in progress";
    default:
      return null;
  }
}

/** Composer placeholder while chatting (the switch off). */
export const CHAT_PLACEHOLDER = "Ask the agent about this ticket…";

/** Hint under the composer while chatting. */
export function chatHint(t: { busy: boolean; status: TicketStatus }): string {
  return t.busy ? "Queued behind the current run" : `Chat only: the ticket stays ${STATUS_WORDS[t.status]}`;
}

const STATUS_WORDS: Record<TicketStatus, string> = {
  planning: "in planning",
  in_progress: "in progress",
  blocked: "blocked",
  review: "in review",
  done: "done",
};
