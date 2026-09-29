// New session's draft saving (DESIGN.md "Drafts"): the editor's state is a Ticket; nothing reaches
// the service while it's still empty, the first worthwhile edit POSTs the draft, and later edits go
// out as debounced PATCHes of only what changed. One request at a time, in order. A change from
// another device (an upsert for the saved key) replaces the editor's state only while it has no
// unsent edits: the last write wins. Moving the draft to another project re-keys it; the editor
// adopts the key the service answers with.

import type { CreateTicketBody, Project, PublicSettings, Ticket, UpdateTicketBody } from "@harness/shared";
import { draftCreateBody, draftIsEmpty, draftPatch } from "@harness/shared/state";

type DraftProject = Pick<Project, "id" | "path" | "isGit" | "useWorktrees" | "defaultDriver" | "defaultModels" | "baseBranch">;
type DraftSettings = Pick<PublicSettings, "defaultDriver" | "defaultModels" | "baseBranch">;

export interface DraftApi {
  create(body: CreateTicketBody): Promise<Ticket>;
  update(key: string, patch: UpdateTicketBody): Promise<Ticket>;
  remove(key: string): Promise<unknown>;
  submit(key: string, start: boolean): Promise<Ticket>;
}

export interface DraftSyncOptions {
  api: DraftApi;
  /** The editor's starting state: a blank draft, or the saved draft being reopened */
  local: Ticket;
  /** The draft as the service has it, when reopening one */
  saved?: Ticket | null;
  project: (id: string) => DraftProject | undefined;
  settings: () => DraftSettings | null | undefined;
  /** The editor's state changed other than by `edit`: a key adopted, another device's change */
  onChange: (local: Ticket) => void;
  /** The service answered a save with this ticket */
  onSaved?: (t: Ticket) => void;
  onError: (e: unknown) => void;
  delayMs?: number;
}

export class DraftSync {
  local: Ticket;
  saved: Ticket | null;
  private seq = 0;
  private sentSeq = 0;
  private inflight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;
  private ending: Promise<void> | null = null;

  constructor(private readonly o: DraftSyncOptions) {
    this.local = o.local;
    this.saved = o.saved ?? null;
  }

  /** The saved draft's key, null until the first save */
  get key(): string | null {
    return this.saved?.key ?? null;
  }

  /** No edits waiting to go out (and none on their way) */
  get clean(): boolean {
    return !this.timer && !this.inflight && this.seq === this.sentSeq;
  }

  get empty(): boolean {
    return draftIsEmpty(this.local, this.o.project(this.local.projectId), this.o.settings());
  }

  /** The editor changed: remember it and save it (the first save at once, later ones debounced). */
  edit(next: Ticket) {
    if (this.closed) return;
    this.local = this.saved ? { ...next, key: this.saved.key } : next;
    this.seq++;
    if (!this.saved && !this.inflight) {
      this.clearTimer();
      if (!this.empty) void this.flush();
      else this.sentSeq = this.seq;
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.o.delayMs ?? 400);
  }

  /**
   * The store's copy of the saved draft changed (an upsert). Taken as the editor's state only
   * while nothing is unsent and it isn't older than what we have. Returns whether it was taken.
   */
  incoming(t: Ticket): boolean {
    if (this.closed || !this.saved || !this.clean) return false;
    if (t === this.saved || t.updatedAt < this.saved.updatedAt) return false;
    this.saved = t;
    this.local = t;
    this.o.onChange(t);
    return true;
  }

  /** Send whatever hasn't gone out yet; resolves once the service has it (or it failed). */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.sync());
    return this.chain;
  }

  private async sync() {
    if (this.closed) return;
    const target = this.local;
    const seq = this.seq;
    const project = this.o.project(target.projectId);
    this.inflight++;
    try {
      let t: Ticket | null = null;
      if (!this.saved) {
        if (project && !draftIsEmpty(target, project, this.o.settings())) t = await this.o.api.create(draftCreateBody(target, project));
      } else {
        const patch = draftPatch(this.saved, target);
        if (patch) t = await this.o.api.update(this.saved.key, patch);
      }
      this.sentSeq = seq;
      this.failed = false;
      if (t) {
        this.saved = t;
        this.o.onSaved?.(t);
        if (this.local.key !== t.key) {
          this.local = { ...this.local, key: t.key };
          this.o.onChange(this.local);
        }
      }
    } catch (e) {
      this.failed = true;
      this.o.onError(e);
    } finally {
      this.inflight--;
    }
    // Edits that came in while the request was out go next.
    if (!this.failed && this.seq !== this.sentSeq && !this.timer && !this.closed) void this.flush();
  }

  /** Everything saved, or throws when the last save failed. */
  private async settle() {
    await this.flush();
    while (!this.failed && this.seq !== this.sentSeq) await this.flush();
    if (this.failed) throw new Error("The draft couldn't be saved.");
  }

  /** Save and stop (Save draft, a swipe down). A saved draft that's empty again is deleted. */
  close(): Promise<void> {
    if (this.ending) return this.ending;
    if (this.closed) return Promise.resolve();
    if (this.saved && this.empty) return this.discard();
    this.ending = this.settle().finally(() => {
      this.closed = true;
    });
    return this.ending;
  }

  /** Delete the saved draft (if any) and stop. */
  discard(): Promise<void> {
    if (this.ending) return this.ending;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.clearTimer();
    this.ending = this.chain.then(async () => {
      if (this.saved) await this.o.api.remove(this.saved.key);
    });
    return this.ending;
  }

  /** Save what's left, then launch it: start work now, or plan first. */
  async submit(start: boolean): Promise<Ticket> {
    if (this.isClosed) throw new Error("This draft is closed.");
    // The brief launches trimmed (a picked @mention leaves a trailing space).
    const brief = this.local.description.trim();
    if (brief !== this.local.description) this.edit({ ...this.local, description: brief });
    await this.settle();
    if (!this.saved) throw new Error("Write a prompt first.");
    const t = await this.o.api.submit(this.saved.key, start);
    this.closed = true;
    return t;
  }

  /** Stop without saving (the screen is going away after a submit or discard, or failed). */
  dispose() {
    this.closed = true;
    this.clearTimer();
  }

  /** Closed, discarded, submitted or on its way to one of those */
  get isClosed() {
    return this.closed || !!this.ending;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
