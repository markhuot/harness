// The context gauge's numbers (DESIGN.md "Context gauge"): what each model call of a run read and
// wrote, folded into the session's saved context size and its cache-miss count.

import type { ContextUsage } from "@harness/shared";

/** One model call's token counts. `estimated`: counted from the conversation's words, not reported. */
export interface CallUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  estimated?: boolean;
}

/** A call that writes more than this to the cache may have lost it (a normal turn writes a few thousand). */
export const MISS_MIN_WRITE = 30_000;
/** ...and it lost the cache when it read back less than this share of the previous call's context. */
export const MISS_READ_SHARE = 0.5;

/** What sessions.context stores: the last call, the first call's total, and the miss tally. */
export interface StoredContext extends CallUsage {
  at: number;
  prefix: number;
  misses: number;
  missTokens: number;
}

const total = (c: Pick<CallUsage, "input" | "cacheRead" | "cacheWrite">) => c.input + c.cacheRead + c.cacheWrite;

/**
 * Whether `call` is a cache miss: a call in the middle of a run that wrote the conversation back
 * into the prompt cache because it had expired. It writes more than MISS_MIN_WRITE and reads back
 * under half of the previous call's context. A run's first call is never one (it starts from
 * whatever cache the last run left), and neither is an estimate (no cache split).
 */
export function isCacheMiss(prev: CallUsage | null, call: CallUsage, firstOfRun: boolean): boolean {
  if (firstOfRun || !prev || prev.estimated || call.estimated) return false;
  return call.cacheWrite > MISS_MIN_WRITE && call.cacheRead < MISS_READ_SHARE * total(prev);
}

/** The session's context after `call`: it becomes the last call, and the first one sets the prefix. */
export function applyCall(prev: StoredContext | null, call: CallUsage, at: number, firstOfRun: boolean): StoredContext {
  const miss = isCacheMiss(prev, call, firstOfRun);
  return {
    input: call.input,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    output: call.output,
    estimated: !!call.estimated,
    at,
    prefix: prev ? prev.prefix : total(call),
    misses: (prev?.misses ?? 0) + (miss ? 1 : 0),
    missTokens: (prev?.missTokens ?? 0) + (miss ? call.cacheWrite : 0),
  };
}

/** Ticket.context for a stored one (null: fresh). */
export function toContextUsage(c: StoredContext | null): ContextUsage | null {
  if (!c) return null;
  return { input: c.input, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, output: c.output, prefix: c.prefix, at: c.at, estimated: !!c.estimated, misses: c.misses, missTokens: c.missTokens };
}

/**
 * The context right after a compaction: the conversation is `tokens` big and the next call reads
 * it as fresh input (it's re-cached by then), with the miss tally restarted and the prefix kept.
 */
export function compactedContext(prev: StoredContext | null, tokens: number, at: number): StoredContext {
  return { input: 0, cacheRead: 0, cacheWrite: tokens, output: 0, estimated: false, at, prefix: Math.min(prev?.prefix ?? tokens, tokens), misses: 0, missTokens: 0 };
}
