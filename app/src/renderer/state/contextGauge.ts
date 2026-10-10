import {
  contextTokens,
  DEFAULT_CONTEXT_GAUGE_LIMIT,
  MAX_CONTEXT_GAUGE_LIMIT,
  MIN_CONTEXT_GAUGE_LIMIT,
  type ContextUsage,
  type DriverInfo,
  type Ticket,
} from "@harness/shared";

/** Pure state behind the ticket header's context gauge (views/TicketDetail.tsx, components/ContextGauge.tsx). */

/** "82k", "1.2M", "950", "0": a token count as the gauge writes it. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    // 999_500 and up round to 1000k: that's "1M", not "1000k".
    const k = Math.round(v / 1000);
    if (k < 1000) return `${k}k`;
  }
  const m = Math.round(v / 100_000) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

export interface GaugeView {
  /** True when the ticket has no session to show (null/absent context): the grey "New" dial. */
  empty: boolean;
  total: number;
  limit: number;
  /** The needle: total ÷ limit, clamped to 0..1. */
  fraction: number;
  /** Total is past the limit: the dial turns red and the needle clamps at the end. */
  over: boolean;
  estimated: boolean;
  /** Fill split as fractions of the dial (cached + fresh = fraction); a single tone when estimated. */
  cachedFraction: number;
  freshFraction: number;
  /** The prefix tick's position on the dial, or null when unknown. */
  prefixFraction: number | null;
  /** "82k", "~82k*", or "New". */
  label: string;
  /** Tooltip and accessibility label. */
  title: string;
  misses: number;
  missTokens: number;
  /** "3 misses", or null when there are none. */
  missBadge: string | null;
  /** The menu's top row: "3 cache misses (377k tokens re-written)", or null. */
  missRow: string | null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function missBadgeText(misses: number): string | null {
  if (misses <= 0) return null;
  return `${misses} ${misses === 1 ? "miss" : "misses"}`;
}

export function missRowText(misses: number, missTokens: number): string | null {
  if (misses <= 0) return null;
  return `${misses} cache ${misses === 1 ? "miss" : "misses"} (${formatTokens(missTokens)} tokens re-written)`;
}

/** What the gauge draws for a ticket's `context` against the limit (a missing/invalid limit falls back to the default). */
export function gaugeView(context: ContextUsage | null | undefined, limit: number | undefined): GaugeView {
  const lim = limit && limit > 0 ? limit : DEFAULT_CONTEXT_GAUGE_LIMIT;
  if (!context) {
    return {
      empty: true,
      total: 0,
      limit: lim,
      fraction: 0,
      over: false,
      estimated: false,
      cachedFraction: 0,
      freshFraction: 0,
      prefixFraction: null,
      label: "New",
      title: "New session: nothing for the next run to resume",
      misses: 0,
      missTokens: 0,
      missBadge: null,
      missRow: null,
    };
  }
  const total = contextTokens(context);
  const fraction = clamp01(total / lim);
  const over = total > lim;
  const estimated = context.estimated;
  // An estimate has no cached/fresh split: all of it is one tone ("fresh" slot, drawn single-tone).
  const cached = estimated ? 0 : context.cacheRead;
  const cachedFraction = total > 0 ? fraction * clamp01(cached / total) : 0;
  const freshFraction = estimated ? fraction : Math.max(0, fraction - cachedFraction);
  const prefixFraction = context.prefix > 0 ? clamp01(context.prefix / lim) : null;
  const misses = estimated ? 0 : context.misses;
  const missTokens = estimated ? 0 : context.missTokens;
  const title = estimated
    ? `Context about ${formatTokens(total)} of ${formatTokens(lim)} (estimated from word count)`
    : `Context ${formatTokens(total)} of ${formatTokens(lim)}: ${formatTokens(context.cacheRead)} cached, ${formatTokens(context.input + context.cacheWrite)} fresh`;
  return {
    empty: false,
    total,
    limit: lim,
    fraction,
    over,
    estimated,
    cachedFraction,
    freshFraction,
    prefixFraction,
    label: estimated ? `~${formatTokens(total)}*` : formatTokens(total),
    title: over ? `${title}. Over the limit.` : title,
    misses,
    missTokens,
    missBadge: missBadgeText(misses),
    missRow: missRowText(misses, missTokens),
  };
}

export const BUSY_HINT = "Available when the run ends";

export interface GaugeMenu {
  /** The gauge shows at all: the driver reports context usage (or the driver list hasn't loaded). */
  visible: boolean;
  /** The trigger is disabled: the session is compacting. */
  disabled: boolean;
  compact: { shown: boolean; enabled: boolean; hint: string | null };
  newSession: { shown: boolean; enabled: boolean; hint: string | null };
  /** Limit… is always available while the menu is. */
  limit: boolean;
}

/**
 * The gauge's menu for a ticket. `driver` is the ticket's driver from GET /drivers, or undefined while
 * the list hasn't loaded (or doesn't know the driver): the gauge shows, with no session actions.
 */
export function gaugeMenu(ticket: Partial<Pick<Ticket, "busy" | "compacting">>, driver: Pick<DriverInfo, "sessionActions" | "reportsContextUsage"> | undefined): GaugeMenu {
  const busy = !!ticket.busy;
  const compacting = !!ticket.compacting;
  const actions = driver?.sessionActions;
  const item = (shown: boolean) => ({ shown, enabled: shown && !busy && !compacting, hint: shown && busy ? BUSY_HINT : null });
  return {
    visible: driver?.reportsContextUsage !== false,
    disabled: compacting,
    compact: item(!!actions?.compact),
    newSession: item(!!actions?.newSession),
    limit: true,
  };
}

/** Why a limit value is rejected, or null when it's good. Whole tokens between 10k and 2M. */
export function limitError(value: number): string | null {
  if (!Number.isInteger(value)) return "Enter a whole number of tokens";
  if (value < MIN_CONTEXT_GAUGE_LIMIT || value > MAX_CONTEXT_GAUGE_LIMIT) {
    return `Between ${formatTokens(MIN_CONTEXT_GAUGE_LIMIT)} and ${formatTokens(MAX_CONTEXT_GAUGE_LIMIT)} tokens`;
  }
  return null;
}

/** Parses what's typed in a limit field: "250000", "250,000", "250k", "1.5m". NaN when it isn't a number. */
export function parseLimit(text: string): number {
  const m = /^\s*([\d,]*\.?\d+)\s*([km]?)\s*$/i.exec(text);
  if (!m) return NaN;
  const n = Number(m[1]!.replace(/,/g, ""));
  const unit = m[2]!.toLowerCase();
  return Math.round(n * (unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1));
}

export const GAUGE_INFO =
  "How much conversation the next run of this ticket re-reads on every model call. Large contexts make each call slower and more expensive, and old context can steer the agent wrong. Slate is read from the prompt cache (cheap); amber was sent fresh or written to the cache (about 20× the price). The tick marks where every run starts: the system prompt, tools and project instructions. Compact or start a new session when it gets large.";
export const ESTIMATED_INFO = "Estimated from the conversation's word count; Copilot doesn't report tokens.";
export const MISS_INFO =
  "A cache miss is a model call that had to write the whole conversation back into the prompt cache because the cache expired, usually after the agent waited more than 5 minutes (a long build or a simulator run). Each miss costs about 20× what reading it would have. Harness counts them so you can see when that's happening: setting `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in the Claude Code driver's environment variables keeps the cache for an hour.";

/** The gauge's info popover text: the estimate note replaces the explanation for an estimated gauge. */
export function gaugeInfo(estimated: boolean): string {
  return estimated ? ESTIMATED_INFO : GAUGE_INFO;
}

export const COMPACTING_PLACEHOLDER = "Compacting…";
