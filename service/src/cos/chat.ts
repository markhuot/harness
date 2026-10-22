// A chief's chat (GET /cos/:id/transcript): a projection, with no table of its own, over its
// session's messages, the board changes it made (activity stamped with its actor) and the event
// batches that woke it. Newest first, so older entries load as the reader scrolls up.

import type { CosChatEntry, CosChatPage } from "@harness/shared";
import type { Store } from "../store";

/** The prompt Harness hands a chief on a wake starts like this; the chat shows it as an event batch instead. */
export const WAKE_PROMPT_PREFIX = "[Harness:";

/** What a chief replies when a wake has nothing to tell the user. */
export const QUIET_REPLY = "[quiet]";

/** A reply that says nothing (empty, or the quiet sentinel, bare or in backticks): the chat leaves it out. */
export function isSilentReply(text: string): boolean {
  const t = text.trim().replace(/^`+|`+$/g, "").trim().toLowerCase();
  return t === "" || t === QUIET_REPLY;
}

const CREATED_NOTE = /^Chief of staff \(.+\) created it$/;

const cursorOf = (e: { createdAt: number; id: string }) => `${e.createdAt}:${e.id}`;

function parseCursor(raw: string | null): { createdAt: number; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  const createdAt = Number(raw.slice(0, i));
  return i > 0 && Number.isFinite(createdAt) ? { createdAt, id: raw.slice(i + 1) } : null;
}

export function cosChat(store: Store, cosId: string, rawCursor: string | null, limit: number): CosChatPage {
  const cos = store.cos.get(cosId);
  const ticket = cos ? store.tickets.get(cos.ticketId) : null;
  if (!cos || !ticket) return { entries: [], nextCursor: null };
  const cursor = parseCursor(rawCursor);
  const fetch = limit + 1;
  const found: CosChatEntry[] = [];

  for (const m of store.transcript.messagesBefore(ticket.sessionId, cursor, fetch, WAKE_PROMPT_PREFIX)) {
    if (m.content.type !== "text") continue;
    if (m.role !== "user" && isSilentReply(m.content.text)) continue;
    found.push({ id: m.id, cosId, createdAt: m.createdAt, kind: "message", role: m.role === "user" ? "user" : "assistant", text: m.content.text });
  }

  for (const a of store.activity.listByActor(`cos:${cosId}`, cursor, fetch)) {
    const t = a.ticketId ? store.tickets.get(a.ticketId) : null;
    if (!t) continue;
    if (a.kind === "moved" && a.meta.from && a.meta.to) found.push({ id: a.id, cosId, createdAt: a.createdAt, kind: "ticket_moved", key: t.key, title: t.title, from: a.meta.from, to: a.meta.to });
    else if (a.kind === "note" && CREATED_NOTE.test(a.body)) found.push({ id: a.id, cosId, createdAt: a.createdAt, kind: "ticket_created", key: t.key, title: t.title, status: t.status });
  }

  for (const w of store.cosEvents.wakesBefore(cosId, cursor, fetch)) {
    found.push({ id: `wake:${w.id}`, cosId, createdAt: w.startedAt, kind: "event_batch", wakeId: w.id, eventIds: store.cosEvents.byWake(w.id).map((e) => e.id), digest: w.digest });
  }

  const older = found.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const entries = older.slice(0, limit);
  return { entries, nextCursor: older.length > limit ? cursorOf(entries[entries.length - 1]!) : null };
}
