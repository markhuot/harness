// A draft's editing session (views/DraftEditor.tsx): the editor's local ticket, what the service
// has, and the saving in between. It lives outside React, keyed by pane, so it survives the editor
// remounting when a New session pane turns into the draft's ticket pane (and the draft moving to
// another project, which gives it another key).
//
// The rules (DESIGN.md "Drafts"):
//   • nothing is sent while the draft is empty (draftIsEmpty); the first edit that isn't creates it;
//   • after that, edits go out as debounced PATCHes of what changed (draftPatch);
//   • local edits win while they're unsent; the service's copy (another device's edit) is taken only
//     when nothing is waiting to go out, so the last write wins;
//   • one request at a time: edits made while one is out are sent after it, rebased on its answer.

import type { CreateTicketBody, SubmitTicketBody, Ticket, UpdateTicketBody } from "@harness/shared";
import { applyTicketPatch, draftCreateBody, draftIsEmpty, draftPatch } from "@harness/shared/state";

type DraftProject = Parameters<typeof draftCreateBody>[1];
type DraftSettings = Parameters<typeof draftIsEmpty>[2];

export interface DraftClient {
  createTicket(body: CreateTicketBody): Promise<Ticket>;
  updateTicket(key: string, body: UpdateTicketBody): Promise<Ticket>;
  submitTicket(key: string, body: SubmitTicketBody): Promise<Ticket>;
  deleteTicket(key: string): Promise<unknown>;
}

export interface DraftDeps {
  client: DraftClient;
  project(id: string): DraftProject | undefined;
  settings(): DraftSettings;
  /** The service answered with this ticket: put it in the store, so every view has it at once. */
  upsert(t: Ticket): void;
  /** The draft got its key (first save: `from` is null) or another one (it moved to another project). */
  rekeyed(from: string | null, to: string): void;
  error(message: string): void;
  /**
   * A request that outlives the page (fetch keepalive), for the page going away mid-debounce. Without
   * it, unload() falls back to the client (which a closing page may cut off).
   */
  keepalive?(method: "POST" | "PATCH", path: string, body: unknown): void;
}

/** The fields a draft editor changes. The rest (title, status, ids) are the service's. */
const EDITABLE = ["projectId", "description", "kind", "driver", "model", "permissionMode", "useWorktree", "requestedBranch", "baseBranch", "skipAgentReview", "dependsOn"] as const;

const same = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : (a ?? null) === (b ?? null));

/**
 * The service's answer `server` to a request sent from `sent`, with the edits made to `local`
 * since then kept on top: a field the editor changed while the request was out keeps the editor's
 * value, every other field takes the service's.
 */
export function rebase(server: Ticket, sent: Ticket, local: Ticket): Ticket {
  const out: Ticket = { ...server };
  for (const f of EDITABLE) if (!same(local[f], sent[f])) (out as unknown as Record<string, unknown>)[f] = local[f];
  return out;
}

export const DRAFT_SAVE_DELAY = 400;

export class DraftSession {
  local: Ticket;
  /** What the service has: null until the first save */
  saved: Ticket | null;
  /** Options stays open across the editor remounting (New session → draft pane), never across panes. */
  optionsOpen = false;
  /** The Close this draft? prompt is showing */
  closing = false;
  /** A submit or discard is on its way */
  busy = false;
  /** Bumped on every change, for useSyncExternalStore */
  version = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private failed = false;

  constructor(
    initial: Ticket,
    saved: Ticket | null,
    public deps: DraftDeps,
    /** The New session pane it started in (null: opened as a saved draft) */
    public readonly composeId: string | null = null,
    private delay = DRAFT_SAVE_DELAY,
  ) {
    this.local = initial;
    this.saved = saved;
  }

  get key(): string | null {
    return this.saved?.key ?? null;
  }

  isEmpty(): boolean {
    return draftIsEmpty(this.local, this.deps.project(this.local.projectId), this.deps.settings());
  }

  /** Edits the service doesn't have yet (or, before the first save, anything worth saving). */
  get unsent(): boolean {
    return this.saved ? !!this.timer || !!this.inflight || !!draftPatch(this.saved, this.local) : !this.isEmpty();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** UI-only state (Options, the close prompt). */
  set(ui: Partial<Pick<DraftSession, "optionsOpen" | "closing" | "busy">>) {
    Object.assign(this, ui);
    this.changed();
  }

  /** A change in the editor (TicketSettings' PATCH, the prompt, the kind, the project). */
  edit(patch: UpdateTicketBody) {
    this.local = applyTicketPatch(this.local, patch);
    this.changed();
    this.schedule();
  }

  /** Before the first save: the predicted key moves with the project (only labels use it). */
  setPredictedKey(key: string) {
    if (this.saved || this.local.key === key) return;
    this.local = { ...this.local, key };
    this.changed();
  }

  /**
   * The store's copy of the draft changed (a socket event, another device's edit). Taken only while
   * nothing is waiting to go out; otherwise the editor's edits win when they're sent.
   */
  receive(t: Ticket) {
    if (!this.saved || t.id !== this.saved.id || t === this.saved) return;
    if (this.timer || this.inflight || draftPatch(this.saved, this.local)) return;
    this.saved = t;
    this.local = t;
    this.changed();
  }

  private schedule() {
    if (!this.saved) {
      if (!this.inflight && !this.isEmpty()) void this.flush();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  private async run(op: () => Promise<void>) {
    this.failed = false;
    const p = op().catch((e: unknown) => {
      this.failed = true;
      this.deps.error(e instanceof Error ? e.message : String(e));
    });
    this.inflight = p;
    await p;
    this.inflight = null;
    this.changed();
  }

  /**
   * Send everything that's waiting: the first save (unless it's still empty), then PATCHes until
   * the service has what the editor has. False when a request failed.
   */
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (;;) {
      if (this.inflight) {
        await this.inflight;
        if (this.failed) return false;
        continue;
      }
      if (!this.saved) {
        if (this.isEmpty()) return true;
        await this.run(() => this.create());
        if (this.failed || !this.saved) return false;
        continue;
      }
      const patch = draftPatch(this.saved, this.local);
      if (!patch) return true;
      await this.run(() => this.patch(patch));
      if (this.failed) return false;
    }
  }

  private async create() {
    const project = this.deps.project(this.local.projectId);
    if (!project) throw new Error("Pick a project first");
    const sent = this.local;
    const t = await this.deps.client.createTicket(draftCreateBody(sent, project));
    this.saved = t;
    this.local = rebase(t, sent, this.local);
    this.deps.upsert(t);
    this.deps.rekeyed(null, t.key);
    // Edits made while it was being created go out as the first PATCH.
    if (draftPatch(t, this.local)) this.schedule();
  }

  private async patch(patch: UpdateTicketBody) {
    const from = this.saved!.key;
    const sent = this.local;
    const t = await this.deps.client.updateTicket(from, patch);
    this.saved = t;
    this.local = rebase(t, sent, this.local);
    this.deps.upsert(t);
    if (t.key !== from) this.deps.rekeyed(from, t.key);
  }

  /**
   * The page is going away (a reload, the window closing): send what's waiting now, without waiting
   * for the debounce or an answer. A draft whose first save is already out isn't created twice.
   * Returns whether anything was sent.
   */
  unload(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const send = (method: "POST" | "PATCH", path: string, body: unknown) => {
      if (this.deps.keepalive) this.deps.keepalive(method, path, body);
      else if (method === "POST") void this.deps.client.createTicket(body as CreateTicketBody).catch(() => {});
      else void this.deps.client.updateTicket(this.saved!.key, body as UpdateTicketBody).catch(() => {});
    };
    if (!this.saved) {
      const project = this.deps.project(this.local.projectId);
      if (this.inflight || !project || this.isEmpty()) return false;
      send("POST", "/tickets", draftCreateBody(this.local, project));
      return true;
    }
    const patch = draftPatch(this.saved, this.local);
    if (!patch) return false;
    send("PATCH", `/tickets/${encodeURIComponent(this.saved.key)}`, patch);
    // What was sent counts as saved, so a second unload event (pagehide after beforeunload) doesn't resend it.
    this.saved = { ...this.saved, ...this.local };
    return true;
  }

  /** Launch it: save what's waiting (creating it if need be), then submit. The launched ticket, or null. */
  async submit(start: boolean): Promise<Ticket | null> {
    if (this.busy) return null;
    this.set({ busy: true });
    try {
      if (!(await this.flush()) || !this.saved) return null;
      const t = await this.deps.client.submitTicket(this.saved.key, { start });
      this.saved = t;
      this.local = t;
      this.deps.upsert(t);
      return t;
    } catch (e) {
      this.deps.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Throw it away: nothing more is sent, and a saved draft is deleted. False when the delete failed. */
  async discard(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.set({ busy: true });
    try {
      while (this.inflight) await this.inflight;
      if (this.saved) await this.deps.client.deleteTicket(this.saved.key);
      return true;
    } catch (e) {
      this.deps.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      this.set({ busy: false });
    }
  }
}

// ---------------------------------------------------------------------------
// One session per pane
// ---------------------------------------------------------------------------

const sessions = new Map<string, DraftSession>();

/**
 * The session for pane `leafId`: the one it has if it's editing the same draft (`matches`), else a
 * new one from `make`. A session left behind by other content (the pane now shows another ticket)
 * saves what it still has, and goes.
 */
export function paneDraftSession(leafId: string, matches: (s: DraftSession) => boolean, make: () => DraftSession): DraftSession {
  const had = sessions.get(leafId);
  if (had && matches(had)) return had;
  if (had) void had.flush();
  const s = make();
  sessions.set(leafId, s);
  return s;
}

/** The pane no longer shows the session's draft (closed, or showing something else): save what's waiting, and forget it. */
export function releaseDraftSession(leafId: string, s: DraftSession, stillShown: boolean) {
  if (stillShown || sessions.get(leafId) !== s) return;
  sessions.delete(leafId);
  void s.flush();
}

/** The page is going away: every pane's draft sends what it hasn't yet (DraftSession.unload). How many did. */
export function unloadDraftSessions(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.unload()) n++;
  return n;
}

/** Forget a session outright (discarded or submitted). */
export function dropDraftSession(leafId: string, s: DraftSession) {
  if (sessions.get(leafId) === s) sessions.delete(leafId);
}
