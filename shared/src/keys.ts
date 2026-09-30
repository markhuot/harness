// Ticket-key helpers shared by the service and clients.

/** Derive a project key from a directory path: ~/work/nytimes → NYTIMES, my-app → MYAPP. */
export function projectKeyFromPath(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const key = base.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!key) return "PROJ";
  // Keys must start with a letter so they can't be confused with numbers.
  return /^[A-Z]/.test(key) ? key.slice(0, 16) : ("P" + key).slice(0, 16);
}

const KEY_RE = /^([A-Z][A-Z0-9_]*)-(\d+)$/;

/** Parse "NYTIMES-12" → { prefix: "NYTIMES", number: 12 }; null when not a ticket key. */
export function parseTicketKey(key: string): { prefix: string; number: number } | null {
  const m = KEY_RE.exec(key.trim().toUpperCase());
  return m ? { prefix: m[1]!, number: Number(m[2]) } : null;
}

export function isTicketKey(key: string): boolean {
  return parseTicketKey(key) !== null;
}

/** Valid project key: an upper-case letter followed by up to 15 letters/digits (HEL, NYTIMES, P37). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,15}$/;

/** Prefixes the service reserves for its own session keys (TRIAGE-n). */
export const RESERVED_PROJECT_KEYS = ["TRIAGE"] as const;

/**
 * Validate a user-typed project key. Input is trimmed and upper-cased first, so "hel" is HEL.
 * Returns the normalized key, or an error message explaining what's wrong.
 */
export function checkProjectKey(raw: string): { key: string; error: null } | { key: string; error: string } {
  const key = String(raw ?? "").trim().toUpperCase();
  if (!key) return { key, error: "Enter a key" };
  if (!/^[A-Z]/.test(key)) return { key, error: "Must start with a letter" };
  if (/[^A-Z0-9]/.test(key)) return { key, error: "Letters and digits only" };
  if (key.length > 16) return { key, error: "16 characters at most" };
  if ((RESERVED_PROJECT_KEYS as readonly string[]).includes(key)) return { key, error: `${key} is reserved` };
  return { key, error: null };
}

// ---------------------------------------------------------------------------
// Remote IDs (DESIGN.md "Remote IDs"). A ticket's `key` is its only identity; a linked remote
// item's key (externalRef.key, e.g. a Jira issue) is what the board shows in its place.
// ---------------------------------------------------------------------------

type Keyed = { key: string; externalRef?: { key: string } | null };

/** The identifier to show for a ticket: its remote ID when it's linked to one, else its key. */
export function displayKey(t: Keyed): string {
  return t.externalRef?.key || t.key;
}

/**
 * The local key to show next to `displayKey` ("MH-62 · MH-124"), or null when the two are the
 * same (an unlinked ticket, or one created before remote IDs had their own field, whose key is
 * its remote ID). Shown wherever a display key is, so tickets sharing a remote ID stay apart.
 */
export function secondaryKey(t: Keyed): string | null {
  const shown = displayKey(t);
  return shown === t.key ? null : t.key;
}

/** "MH-62 · MH-124" (or just the key): one-line label for toasts, titles and menus. */
export function keyLabel(t: Keyed): string {
  const local = secondaryKey(t);
  return local ? `${displayKey(t)} · ${local}` : t.key;
}

/**
 * A ticket created before remote IDs had their own field: triage gave it its remote ID as its
 * key. It keeps that key through project renames (it isn't the project's numbering).
 */
export function isLegacyMirror(t: Keyed): boolean {
  return !!t.externalRef && t.externalRef.key === t.key;
}
