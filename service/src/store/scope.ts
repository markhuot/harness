import type { ActivityEntry, CosScope, Group, Project, Ticket, TicketPage, Watcher } from "@harness/shared";
import type { Store } from "./index";
import type { ActivityHit, ActivityQuery } from "./activity";

/**
 * What a chief of staff may see and act on (DESIGN.md "Chief of staff"): `all` is everything, a
 * `{ group }` scope only the projects of that group. It is worked out by the service from the chief's
 * ticket for each operation, never taken from a tool argument.
 */
export type Scope = CosScope;

/** What every out-of-scope lookup answers with, so a ticket outside the scope can't be told from one that doesn't exist. */
export const OUT_OF_SCOPE = null;

/**
 * The store as one scope sees it. Every read a chief of staff's tools make goes through here, so
 * scope is enforced in one place: an out-of-scope id behaves as not found, lists leave
 * out-of-scope rows, and a ticket's parent, dependency and dependent edges that leave the scope are
 * dropped. Under `all` nothing is filtered.
 *
 * The scope is a required constructor argument and the full `Store` is private, so code holding a
 * ScopedStore can't reach the unscoped repos.
 */
export class ScopedStore {
  constructor(private store: Store, readonly scope: Scope) {}

  private get group(): string | null {
    return this.scope === "all" ? null : this.scope.group;
  }

  /** The hidden internal project that hosts the chiefs of staff is in no scope, not even all. */
  projectInScope(projectId: string): boolean {
    if (this.store.projects.isInternal(projectId)) return false;
    if (this.scope === "all") return true;
    return this.store.projects.get(projectId)?.groupId === this.group;
  }

  /** A chief of staff's own ticket is never on the board: no scope sees one, not even all. */
  inScope(t: Ticket): boolean {
    return t.kind !== "cos" && this.projectInScope(t.projectId);
  }

  /** The ticket as this scope sees it: edges to tickets outside the scope are dropped. */
  view(t: Ticket): Ticket {
    if (this.scope === "all") return t;
    const parentOk = t.parentId ? this.keep(this.store.tickets.get(t.parentId)) : true;
    const dependsOn = t.dependsOn.filter((k) => this.keep(this.store.tickets.getByKey(k)));
    return { ...t, parentId: parentOk ? t.parentId : null, dependsOn };
  }

  private keep(t: Ticket | null): boolean {
    return !!t && this.inScope(t);
  }

  readonly tickets = {
    get: (id: string): Ticket | null => {
      const t = this.store.tickets.get(id);
      return t && this.inScope(t) ? this.view(t) : OUT_OF_SCOPE;
    },
    getByKey: (key: string): Ticket | null => this.tickets.lookup(key)?.ticket ?? null,
    lookup: (key: string): { ticket: Ticket; alias: string | null } | null => {
      const found = this.store.tickets.lookup(key);
      return found && this.inScope(found.ticket) ? { ticket: this.view(found.ticket), alias: found.alias } : OUT_OF_SCOPE;
    },
    list: (filter: { projectId?: string; parentId?: string; statuses?: Ticket["status"][]; drafts?: boolean } = {}): Ticket[] => {
      // A project outside the scope has no tickets here; the group filter keeps the rest apart.
      if (filter.projectId && !this.projectInScope(filter.projectId)) return [];
      return this.store.tickets.list({ ...filter, ...(this.group ? { groupId: this.group } : {}) }).map((t) => this.view(t));
    },
    page: (opts: Parameters<Store["tickets"]["page"]>[0]): TicketPage => {
      if (opts.projectId && !this.projectInScope(opts.projectId)) return { tickets: [], nextCursor: null, total: 0 };
      const page = this.store.tickets.page({ ...opts, ...(this.group ? { groupId: this.group } : {}) });
      return { ...page, tickets: page.tickets.map((t) => this.view(t)) };
    },
    search: (opts: Parameters<Store["tickets"]["search"]>[0]): TicketPage => {
      if (opts.projectId && !this.projectInScope(opts.projectId)) return { tickets: [], nextCursor: null, total: 0 };
      const page = this.store.tickets.search({ ...opts, ...(this.group ? { groupId: this.group } : {}) });
      return { ...page, tickets: page.tickets.map((t) => this.view(t)) };
    },
    dependents: (key: string): Ticket[] => {
      const t = this.tickets.getByKey(key);
      return t ? this.store.tickets.dependents(t.key).filter((d) => this.inScope(d)).map((d) => this.view(d)) : [];
    },
    byExternalKey: (key: string, opts: { drafts?: boolean } = {}): Ticket[] =>
      this.store.tickets.byExternalKey(key, opts).filter((t) => this.inScope(t)).map((t) => this.view(t)),
  };

  readonly projects = {
    list: (): Project[] => this.store.projects.list().filter((p) => this.scope === "all" || p.groupId === this.group),
    get: (id: string): Project | null => {
      const p = this.store.projects.get(id);
      return p && (this.scope === "all" || p.groupId === this.group) && !this.store.projects.isInternal(p.id) ? p : OUT_OF_SCOPE;
    },
    getByKey: (key: string): Project | null => {
      const p = this.store.projects.getByKey(key);
      return p && (this.scope === "all" || p.groupId === this.group) ? p : OUT_OF_SCOPE;
    },
  };

  readonly groups = {
    list: (): Group[] => this.store.groups.list().filter((g) => this.scope === "all" || g.id === this.group),
  };

  /**
   * Watchers belong to no project and carry commands and environments: the all scope sees every one,
   * a group's chief only the watchers it owns.
   */
  readonly watchers = {
    list: (): Watcher[] => this.store.watchers.list().filter((w) => this.ownsWatcher(w)),
    get: (id: string): Watcher | null => {
      const w = this.store.watchers.get(id);
      return w && this.ownsWatcher(w) ? w : OUT_OF_SCOPE;
    },
  };

  private ownsWatcher(w: Watcher): boolean {
    if (this.scope === "all") return true;
    const own = this.store.cos.getByScope(this.scope);
    return !!own && w.cosId === own.ticketId;
  }

  /** Activity across the tickets this scope covers (a ticket outside it matches nothing). */
  queryActivity(q: Omit<ActivityQuery, "groupId">): { hits: ActivityHit[]; nextCursor: string | null } {
    return this.store.activity.query({ ...q, groupId: this.group });
  }

  /** The Activity of a ticket this scope can see; nothing for one it can't. */
  activity(ticket: Ticket): ActivityEntry[] {
    return this.inScope(ticket) ? this.store.activity.listBySession(ticket.sessionId) : [];
  }
}
