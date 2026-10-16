import { expect, test } from "bun:test";
import { applyCall, compactedContext, isCacheMiss, MISS_MIN_WRITE, toContextUsage, type CallUsage } from "../../../service/src/orchestrator/context-usage";

const call = (over: Partial<CallUsage> = {}): CallUsage => ({ input: 10, cacheRead: 100_000, cacheWrite: 500, output: 20, ...over });

test("a call is a cache miss only when it re-wrote a big context it failed to read back", () => {
  const prev = call({ cacheRead: 100_000 });
  expect(isCacheMiss(prev, call({ cacheRead: 0, cacheWrite: MISS_MIN_WRITE + 1 }), false)).toBe(true);
  expect(isCacheMiss(prev, call({ cacheRead: 49_999, cacheWrite: MISS_MIN_WRITE + 1 }), false)).toBe(true);
  expect(isCacheMiss(prev, call({ cacheRead: 100_000, cacheWrite: MISS_MIN_WRITE + 1 }), false)).toBe(false); // read it back
  expect(isCacheMiss(prev, call({ cacheRead: 0, cacheWrite: MISS_MIN_WRITE }), false)).toBe(false); // a normal write
});

test("the first call of a run, a run with no history and estimated counts are never misses", () => {
  const big = call({ cacheRead: 0, cacheWrite: 90_000 });
  expect(isCacheMiss(call(), big, true)).toBe(false);
  expect(isCacheMiss(null, big, false)).toBe(false);
  expect(isCacheMiss(call({ estimated: true }), big, false)).toBe(false);
  expect(isCacheMiss(call(), { ...big, estimated: true }, false)).toBe(false);
});

test("applyCall keeps the first call's total as the prefix and tallies misses with their tokens", () => {
  const first = applyCall(null, call({ input: 5, cacheRead: 0, cacheWrite: 1000 }), 1, true);
  expect(first).toMatchObject({ prefix: 1005, misses: 0, missTokens: 0, at: 1, estimated: false });
  const second = applyCall(first, call({ cacheRead: 2000, cacheWrite: 100 }), 2, false);
  expect(second.prefix).toBe(1005);
  const third = applyCall(second, call({ input: 1, cacheRead: 0, cacheWrite: 40_000 }), 3, false);
  expect(third).toMatchObject({ misses: 1, missTokens: 40_000, prefix: 1005, cacheWrite: 40_000 });
  expect(applyCall(third, call({ cacheRead: 41_000, cacheWrite: 10 }), 4, false)).toMatchObject({ misses: 1, missTokens: 40_000 });
});

test("compaction sets the context to the new size as fresh input, restarts the miss tally and never grows the prefix", () => {
  const prev = applyCall(null, call({ input: 0, cacheRead: 0, cacheWrite: 800 }), 1, true);
  expect(compactedContext(prev, 300, 9)).toMatchObject({ input: 0, cacheRead: 0, cacheWrite: 300, prefix: 300, misses: 0, at: 9 });
  expect(compactedContext(prev, 5000, 9).prefix).toBe(800);
  expect(compactedContext(null, 300, 9).prefix).toBe(300);
});

test("toContextUsage is null for a fresh session and drops nothing the client shows", () => {
  expect(toContextUsage(null)).toBeNull();
  const c = applyCall(null, call(), 7, true);
  expect(toContextUsage(c)).toEqual({ input: 10, cacheRead: 100_000, cacheWrite: 500, output: 20, prefix: 100_510, at: 7, estimated: false, misses: 0, missTokens: 0 });
});
