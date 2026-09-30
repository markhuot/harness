// Remote IDs (DESIGN.md "Remote IDs"): the tickets that share one. A ticket's detail carries
// `relatedTickets` (other tickets linked to the remote ID it was asked for or carries), and a
// remote ID that no local key matches 404s with RemoteKeyMatches. The fetched list is a snapshot;
// relatedOf folds in the loaded tickets so a link made or removed since shows right away. Pure for
// bun.

import { HarnessApiError, keyLabel, type RelatedTicket, type RemoteKeyMatches, type Ticket } from "@harness/shared";

const up = (k: string) => k.toUpperCase();

function asRelated(t: Ticket): RelatedTicket {
  return { key: t.key, title: t.title, status: t.status, projectId: t.projectId, externalKey: t.externalRef!.key };
}

/**
 * The tickets sharing a remote ID with `ticket`: linked to its own remote ID, or to its key (a
 * native MH-62 lists the tickets linked to Jira MH-62). Never the ticket itself or a draft. A
 * loaded ticket wins over its fetched entry (it may have been relinked or unlinked since), and
 * loaded ones the fetch didn't know about come first (they're the newest).
 */
export function relatedOf(tickets: Record<string, Ticket>, ticket: Ticket, fetched: RelatedTicket[] | undefined): RelatedTicket[] {
  const ids = new Set([up(ticket.key), ...(ticket.externalRef?.key ? [up(ticket.externalRef.key)] : [])]);
  const self = up(ticket.key);
  const matches = (t: Ticket) => !t.draft && up(t.key) !== self && !!t.externalRef?.key && ids.has(up(t.externalRef.key));
  const loaded = new Map<string, Ticket>();
  for (const t of Object.values(tickets)) loaded.set(up(t.key), t);

  const out = new Map<string, RelatedTicket>();
  const live = Object.values(tickets)
    .filter(matches)
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = new Set((fetched ?? []).map((r) => up(r.key)));
  for (const t of live) if (!known.has(up(t.key))) out.set(up(t.key), asRelated(t));
  for (const r of fetched ?? []) {
    const k = up(r.key);
    if (k === self || out.has(k)) continue;
    const t = loaded.get(k);
    if (t) {
      if (matches(t)) out.set(k, asRelated(t));
    } else out.set(k, r);
  }
  return [...out.values()];
}

/** "MH-62 · MH-124" for a related ticket (it always carries a remote ID). */
export function relatedLabel(r: RelatedTicket): string {
  return keyLabel({ key: r.key, externalRef: { key: r.externalKey } });
}

/** The RemoteKeyMatches a ticket lookup's 404 carries, when the key asked for is only a remote ID. */
export function remoteMatchesOf(e: unknown): RemoteKeyMatches | null {
  if (!(e instanceof HarnessApiError) || e.status !== 404) return null;
  const d = e.data as Partial<RemoteKeyMatches> | null | undefined;
  if (!d || typeof d.requested !== "string" || !Array.isArray(d.relatedTickets) || !d.relatedTickets.length) return null;
  return { requested: d.requested, relatedTickets: d.relatedTickets };
}

/**
 * What the Remote ID field saves: the typed key upper-cased (and a URL, when given), null to
 * unlink, or an error. `undefined` when nothing changed. `valid` is isTicketKey, injected so the
 * rule stays the dependency field's.
 */
export function remoteIdPatch(
  current: { key: string; url: string | null } | null,
  input: { key: string; url: string },
  valid: (key: string) => boolean,
): { externalRef: { key: string; url: string | null } | null } | { error: string } | undefined {
  const key = input.key.trim().toUpperCase();
  const url = input.url.trim() || null;
  if (!key) {
    if (url) return { error: "Add the remote ID the link points to" };
    return current ? { externalRef: null } : undefined;
  }
  if (!valid(key)) return { error: `Not a ticket key: ${key}` };
  if (url && !/^https?:\/\/\S+$/i.test(url)) return { error: "The link must start with http:// or https://" };
  if (current && up(current.key) === key && (current.url ?? null) === url) return undefined;
  return { externalRef: { key, url } };
}

/**
 * Whether a dependency chip opens something: a key the service 404'd doesn't, unless it's a remote
 * ID some tickets carry (it opens the Remote ID screen listing them).
 */
export function depOpens(d: { key: string; missing?: boolean }, byRemoteKey: Record<string, RelatedTicket[]>): boolean {
  return !d.missing || !!byRemoteKey[up(d.key)]?.length;
}
