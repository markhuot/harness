// Remote IDs in the ticket pane (DESIGN.md "Remote IDs"): the tickets linked to a remote ID, from
// a detail's relatedTickets (or a remote-only 404's), kept current with the live store.

import { HarnessApiError, isTicketKey, type ExternalRefInput, type RelatedTicket, type RemoteKeyMatches, type Ticket } from "@harness/shared";
import { ticketByKey, type State } from "@harness/shared/state";

type Store = Pick<State, "tickets" | "keyAliases">;

/**
 * The RemoteKeyMatches a failed GET /tickets/:key carried: the key isn't a local ticket, but
 * tickets carry it as their remote ID. Null for any other failure (a plain not-found, a network
 * error, a 404 whose data isn't a non-empty list of related tickets).
 */
export function remoteKeyMatches(err: unknown): RemoteKeyMatches | null {
  if (!(err instanceof HarnessApiError) || err.status !== 404) return null;
  const d = err.data as Partial<RemoteKeyMatches> | null | undefined;
  if (!d || typeof d.requested !== "string" || !Array.isArray(d.relatedTickets) || d.relatedTickets.length === 0) return null;
  return { requested: d.requested, relatedTickets: d.relatedTickets };
}

/**
 * The tickets linked to any of `ids` (a ticket's own key and its remote ID, or a requested remote
 * ID), for the External row and the remote-ID pane. It starts from what the service sent
 * (`fetched`, newest first) and follows the store: a loaded ticket's title and status replace the
 * fetched ones, one that has since been unlinked (or linked elsewhere) drops out, and a loaded
 * ticket that has since been linked to one of `ids` joins at the front. `self` (the ticket being
 * shown) and drafts are left out.
 */
export function liveRelatedTickets(state: Store, ids: readonly (string | null | undefined)[], fetched: readonly RelatedTicket[] | undefined, self?: Pick<Ticket, "id"> | null): RelatedTicket[] {
  const wanted = new Set(ids.filter((k): k is string => !!k).map((k) => k.toUpperCase()));
  if (!wanted.size) return [];
  const linked = (t: Ticket) => !t.draft && t.id !== self?.id && !!t.externalRef && wanted.has(t.externalRef.key.toUpperCase());
  const toRelated = (t: Ticket): RelatedTicket => ({ key: t.key, title: t.title, status: t.status, projectId: t.projectId, externalKey: t.externalRef!.key });

  const seen = new Set<string>();
  const out: RelatedTicket[] = [];
  for (const r of fetched ?? []) {
    const live = ticketByKey(state as State, r.key);
    if (live) {
      if (!linked(live) || seen.has(live.id)) continue;
      seen.add(live.id);
      out.push(toRelated(live));
    } else if (!seen.has(r.key.toUpperCase())) {
      // Not loaded (an older done ticket, another board's): as the service sent it.
      seen.add(r.key.toUpperCase());
      out.push(r);
    }
  }
  const joined = Object.values(state.tickets)
    .filter((t) => linked(t) && !seen.has(t.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toRelated);
  return [...joined, ...out];
}

/**
 * What the Remote ID inputs (components/TicketSettings.tsx) would save: `input` (key upper-cased,
 * URL trimmed, null when empty) when they're valid, else an `error` to show; `dirty` when they
 * differ from the current link. An empty key is never a change (Unlink removes a link), and only
 * an error when a link was typed without one.
 */
export function remoteIdCheck(
  rawKey: string,
  rawUrl: string,
  current: { key: string; url: string | null } | null,
): { input: ExternalRefInput | null; error: string | null; dirty: boolean } {
  const key = rawKey.trim().toUpperCase();
  const url = rawUrl.trim() || null;
  const dirty = key !== (current?.key ?? "") || url !== (current?.url ?? null);
  if (!key) return { input: null, error: url && !current ? "Add the remote ID the link is for" : null, dirty: false };
  if (!isTicketKey(key)) return { input: null, error: `Not an ID like FOO-123: ${key}`, dirty };
  if (url && !/^https?:\/\//i.test(url)) return { input: null, error: "The link must start with http:// or https://", dirty };
  return { input: { key, url }, error: null, dirty };
}
