// A ticket's message draft as its composer edits it (DESIGN.md "Message drafts"): the text and
// files the human is writing, saved to the ticket as they type so another device can finish them.
// It lives outside React, one per ticket in this window, so the composer remounting (a tab switch,
// tearing it off into a pane of its own) keeps what's typed and the save on its way.
//
// The rules (shared/src/state/messageDrafts.ts):
//   • edits go out as debounced PUTs of the whole draft, one at a time, tagged with this session's
//     origin; empty clears the saved draft;
//   • the store's copy replaces what's shown only when it's another editor's, the field doesn't
//     have focus, and nothing typed here is still unsaved (adoptMessageDraft). While the field has
//     focus the composer is uncontrolled: nothing from the service touches it.

import type { MessageDraft, MessageDraftBody, Ticket } from "@harness/shared";
import { adoptMessageDraft, EMPTY_MESSAGE_DRAFT, messageDraftBody, messageDraftValue, newDraftOrigin, sameMessageDraft, type MessageDraftValue } from "@harness/shared/state";

export interface MessageDraftDeps {
  save(key: string, body: MessageDraftBody): Promise<Ticket>;
  /** The service answered with this ticket: put it in the store. */
  upsert(t: Ticket): void;
  error(message: string): void;
  /** A PUT that outlives the page (fetch keepalive), for the window going away mid-debounce. */
  keepalive?(path: string, body: unknown): void;
}

export const MESSAGE_DRAFT_SAVE_DELAY = 500;

export class MessageDraftSession {
  /** What the composer shows */
  value: MessageDraftValue;
  /** This editor's origin: its own saves coming back are skipped. */
  readonly origin = newDraftOrigin();
  /** Bumped on every change, for useSyncExternalStore */
  version = 0;
  private focused = false;
  /** What the service has from this session (or had when the session started) */
  private saved: MessageDraftValue;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private failed = false;
  /** A send is on its way: nothing is saved until it's done (sent or failed). */
  private sending = false;

  constructor(
    /** The ticket's current key (a project rename changes it) */
    public key: string,
    stored: MessageDraft | null | undefined,
    public deps: MessageDraftDeps,
    private delay = MESSAGE_DRAFT_SAVE_DELAY,
  ) {
    this.value = messageDraftValue(stored);
    this.saved = this.value;
  }

  /** Edits the service doesn't have yet. */
  get dirty(): boolean {
    return !!this.timer || !!this.inflight || !sameMessageDraft(this.value, this.saved);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** The human changed the text or the files. */
  edit(next: Partial<MessageDraftValue>) {
    const value = { ...this.value, ...next };
    if (sameMessageDraft(value, this.value)) return;
    this.value = value;
    this.changed();
    if (this.timer) clearTimeout(this.timer);
    if (this.sending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** The field gained or lost focus; on blur, catch up with `stored` (another device's edit). */
  focus(focused: boolean, stored: MessageDraft | null | undefined) {
    this.focused = focused;
    if (!focused) this.sync(stored);
  }

  /** The store's copy changed: show it when the rules allow (adoptMessageDraft). */
  sync(stored: MessageDraft | null | undefined) {
    const next = adoptMessageDraft({ saved: stored, origin: this.origin, focused: this.focused, dirty: this.dirty, shown: this.value });
    if (!next) return;
    this.value = next;
    this.saved = next;
    this.changed();
  }

  /** Save whatever hasn't gone out, one PUT at a time. False when one failed. */
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (;;) {
      if (this.inflight) {
        await this.inflight;
        if (this.failed) return false;
        continue;
      }
      if (this.sending || sameMessageDraft(this.value, this.saved)) return true;
      const sent = this.value;
      this.failed = false;
      const p = this.deps
        .save(this.key, messageDraftBody(sent, this.origin))
        .then((t) => {
          this.saved = sent;
          this.deps.upsert(t);
        })
        .catch((e: unknown) => {
          this.failed = true;
          this.deps.error(`Couldn't save the message draft: ${e instanceof Error ? e.message : String(e)}`);
        });
      this.inflight = p;
      await p;
      this.inflight = null;
      this.changed();
      if (this.failed) return false;
    }
  }

  /**
   * Before a send: no save goes out after it (the service clears the draft when the message goes,
   * and a late PUT would bring it back). Waits for one already on its way.
   */
  async beforeSend() {
    this.sending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.inflight) await this.inflight;
  }

  /** The send failed: the draft is still the human's, and saving picks up again. */
  sendFailed() {
    this.sending = false;
    void this.flush();
  }

  /**
   * The message went with `sentFiles`: the service cleared the saved draft. The text goes; files
   * attached while it was sending stay, and are saved as the new draft.
   */
  sent(sentFiles: MessageDraftValue["attachments"]) {
    this.sending = false;
    const rest = this.value.attachments.filter((a) => !sentFiles.includes(a));
    this.saved = EMPTY_MESSAGE_DRAFT;
    this.value = EMPTY_MESSAGE_DRAFT;
    if (rest.length) this.edit({ attachments: rest });
    else this.changed();
  }

  /** The window is going away: send what's waiting now, as a request that outlives the page. */
  unload(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (sameMessageDraft(this.value, this.saved)) return false;
    const body = messageDraftBody(this.value, this.origin);
    if (this.deps.keepalive) this.deps.keepalive(`/tickets/${encodeURIComponent(this.key)}/message-draft`, body);
    else void this.deps.save(this.key, body).catch(() => {});
    this.saved = this.value;
    return true;
  }
}

// ---------------------------------------------------------------------------
// One session per ticket
// ---------------------------------------------------------------------------

const sessions = new Map<string, MessageDraftSession>();

/** The ticket's session in this window, made the first time its composer shows. */
export function messageDraftSession(ticket: Pick<Ticket, "id" | "key" | "messageDraft">, deps: MessageDraftDeps): MessageDraftSession {
  let s = sessions.get(ticket.id);
  if (!s) {
    s = new MessageDraftSession(ticket.key, ticket.messageDraft, deps);
    sessions.set(ticket.id, s);
  }
  s.key = ticket.key;
  s.deps = deps;
  return s;
}

/** Every session sends what it hasn't yet (the window is closing or reloading). */
export function unloadMessageDrafts(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.unload()) n++;
  return n;
}
