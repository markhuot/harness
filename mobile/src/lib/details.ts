// Ticket details the board and ticket screens need but the snapshot doesn't carry: done tickets
// page in, so a dependency, a dependent, a conductor's done children or the ticket a deep link
// opens may not be loaded. The shared selectors say what's missing (unresolvedKeys,
// conductorsNeedingChildren); this fetches each once per snapshot, a few at a time, and records
// 404s so they aren't asked for again. Pure (client + dispatch injected) for bun.

import { HarnessApiError, type TicketDetail } from "@harness/shared";
import { conductorsNeedingChildren, unresolvedKeys, type Action, type State } from "@harness/shared/state";

export interface DetailClient {
  getTicket(key: string): Promise<TicketDetail>;
}

export const DETAIL_CONCURRENCY = 4;

export class DetailFetcher {
  private inflight = new Map<string, Promise<TicketDetail>>();
  /** Keys fetched (or failed) since the last snapshot */
  private done = new Set<string>();
  private queue: string[] = [];
  private running = 0;

  constructor(
    private deps: { client: DetailClient; dispatch: (a: Action) => void; concurrency?: number },
  ) {}

  /** A snapshot reset aliases, children and missing keys: everything may be asked for again. */
  reset() {
    this.done.clear();
    this.queue = [];
  }

  /**
   * One ticket's detail, merged into the store. Concurrent asks for the same key share a
   * request. Rejects on failure (a 404 is also recorded as a missing key).
   */
  load(key: string): Promise<TicketDetail> {
    const k = key.toUpperCase();
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const p = this.deps.client
      .getTicket(key)
      .then((detail) => {
        this.deps.dispatch({ type: "detail", detail, requestedKey: key });
        return detail;
      })
      .catch((e: unknown) => {
        if (e instanceof HarnessApiError && e.status === 404) this.deps.dispatch({ type: "missingKeys", keys: [key] });
        throw e;
      })
      .finally(() => {
        this.inflight.delete(k);
        this.done.add(k);
      });
    this.inflight.set(k, p);
    return p;
  }

  /** What the state says is missing (plus `extra` keys a screen is showing), not yet asked for. */
  wanted(state: State, extra: string[] = []): string[] {
    const keys = [...unresolvedKeys(state, extra), ...conductorsNeedingChildren(state).map((t) => t.key)];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const k = key.toUpperCase();
      if (seen.has(k) || this.done.has(k) || this.inflight.has(k) || this.queue.includes(k)) continue;
      seen.add(k);
      out.push(key);
    }
    return out;
  }

  /** Fetch whatever is wanted, at most `concurrency` at a time. */
  sync(state: State, extra: string[] = []) {
    for (const key of this.wanted(state, extra)) this.queue.push(key.toUpperCase());
    this.pump();
  }

  private pump() {
    const max = this.deps.concurrency ?? DETAIL_CONCURRENCY;
    while (this.running < max && this.queue.length) {
      const key = this.queue.shift()!;
      if (this.done.has(key) || this.inflight.has(key)) continue;
      this.running++;
      void this.load(key)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
