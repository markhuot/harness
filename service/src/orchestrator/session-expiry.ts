// When a ticket's agent conversation outlives the driver's prompt cache (DESIGN.md "Driver state
// and sessions"). Pure: the orchestrator reads the last call and the clock and asks here.

/**
 * A conversation smaller than this is cheap to read uncached and keeps its continuity, so an
 * expired cache alone doesn't start a new session (most sessions begin around 50k tokens).
 */
export const SESSION_EXPIRY_MIN_TOKENS = 100_000;

export interface SessionExpiryInput {
  /** When the session's newest model call was made; null: none recorded */
  lastCallAt: number | null;
  now: number;
  /** The driver's prompt-cache lifetime (Driver.cacheTtlMs); undefined: it never expires a session */
  ttlMs: number | undefined;
  /** The last call's prefix: input + cache read + cache write */
  contextTokens: number;
}

/**
 * The idle time that expired the session's cache (so a new session starts), or null to resume.
 * The gap must be strictly past the TTL and the conversation at least SESSION_EXPIRY_MIN_TOKENS.
 */
export function sessionExpiry({ lastCallAt, now, ttlMs, contextTokens }: SessionExpiryInput): number | null {
  if (lastCallAt == null || ttlMs == null) return null;
  const idle = now - lastCallAt;
  if (idle <= ttlMs || contextTokens < SESSION_EXPIRY_MIN_TOKENS) return null;
  return idle;
}

/** "3h 12m", "1h", "45m": a duration as the Activity note writes it. */
export function idleLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m || !h ? `${m}m` : ""].filter(Boolean).join(" ");
}
