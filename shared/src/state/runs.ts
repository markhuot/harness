// The Runs list on a ticket's Details tab: how one run's row reads (DESIGN.md "What a run
// records"). Pure, so the desktop and iOS clients (HarnessKit's RunRows) show the same thing.

import { inheritedPhaseModels, runPhase } from "../phases";
import type { PhaseChoice, PhaseModels, Run, RunKind } from "../protocol";
import { relativeTime } from "./format";

/** 42s, 3m 5s, 1h 2m: a span in milliseconds, rounded to the second. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 850, 12.3k, 1.2M (one decimal, dropped when it's .0). Integer maths, so Swift matches it. */
export function formatTokens(n: number): string {
  const count = Math.max(0, Math.round(n));
  if (count < 1000) return String(count);
  const kTenths = Math.round(count / 100);
  if (kTenths < 10000) return `${tenths(kTenths)}k`;
  return `${tenths(Math.round(count / 100000))}M`;
}

const tenths = (t: number) => (t % 10 === 0 ? String(t / 10) : `${Math.floor(t / 10)}.${t % 10}`);

/** $0.42, $12.30, or <$0.01 for a cost under a cent that isn't zero. */
export function formatCost(usd: number): string {
  const cents = Math.round(Math.max(0, usd) * 100);
  if (cents === 0 && usd > 0) return "<$0.01";
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * What a ticket's run of this kind uses unless something else was chosen for it: the choice its
 * phase inherits from the project and Settings (so a ticket-level override shows on its runs).
 * null for triage, which has no phase, and for a run outside a ticket (pass hasTicket false).
 */
export function runPhaseDefault(
  kind: RunKind,
  ctx: { hasTicket: boolean; project?: PhaseModels | null; settings?: PhaseModels | null },
): PhaseChoice | null {
  const phase = runPhase(kind);
  if (!phase || !ctx.hasTicket) return null;
  return inheritedPhaseModels("ticket", ctx.project, ctx.settings)?.[phase] ?? null;
}

export interface RunRowInfo {
  /** When it started ("5m ago"); null while it still waits in the queue. */
  start: string | null;
  /** How long it ran, so far while running; "waiting 12s" while queued; null when it never started. */
  elapsed: string | null;
  /** "48.2k tokens"; null when the driver reported none. */
  tokens: string | null;
  /** The input/output split behind `tokens`, for a tooltip or the row's detail. */
  tokensDetail: string | null;
  /** "$0.42"; null when the driver reported no cost. */
  cost: string | null;
  /** The driver id, only when it isn't the phase default (or there is none). */
  driver: string | null;
  /** The model, only when it isn't the phase default (or there is none) and the run recorded one. */
  model: string | null;
}

export function runRowInfo(run: Run, phaseDefault: PhaseChoice | null, now: number): RunRowInfo {
  const queued = run.status === "queued";
  const running = run.status === "running";
  const started = run.startedAt || null;
  const ended = run.endedAt || null;
  let elapsed: string | null = null;
  if (queued) elapsed = `waiting ${formatDuration(now - run.createdAt)}`;
  else if (started && (ended || running)) elapsed = formatDuration(Math.max(1000, (ended ?? now) - started));

  const hasTokens = run.inputTokens != null || run.outputTokens != null;
  const input = run.inputTokens ?? 0;
  const output = run.outputTokens ?? 0;

  const sameDriver = !!phaseDefault && phaseDefault.driver === run.driver;
  const model = run.model || null;
  return {
    start: queued ? null : relativeTime(started ?? run.createdAt, now),
    elapsed,
    tokens: hasTokens ? `${formatTokens(input + output)} tokens` : null,
    tokensDetail: hasTokens ? `${formatTokens(input)} in · ${formatTokens(output)} out` : null,
    cost: run.costUsd != null ? formatCost(run.costUsd) : null,
    driver: sameDriver ? null : run.driver,
    model: model && !(sameDriver && model === (phaseDefault?.model || null)) ? model : null,
  };
}
