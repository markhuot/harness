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
