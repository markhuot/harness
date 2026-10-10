import { describe, expect, test } from "bun:test";
import { applyCall, compactedContext, isCacheMiss, MISS_MIN_WRITE, type CallUsage, type StoredContext } from "./context-usage";

const call = (input: number, cacheRead: number, cacheWrite: number, output = 100): CallUsage => ({ input, cacheRead, cacheWrite, output });
/** A conversation of `size` tokens whose last call read most of it from the cache. */
const prev = (size: number): CallUsage => call(3, size - 2000 - 3, 2000);

describe("isCacheMiss", () => {
  test("a call that re-writes the conversation after the cache expired is a miss", () => {
    expect(isCacheMiss(prev(200_000), call(3, 40_000, 160_000), false)).toBe(true);
  });

  test("a large write that still reads the conversation back isn't (a big tool result, not a lost cache)", () => {
    // Wrote 35k of new file contents, but read the previous 200k back from the cache.
    expect(isCacheMiss(prev(200_000), call(3, 200_000, 35_000), false)).toBe(false);
  });

  test("a write at the threshold isn't a miss, one token over (with the cache gone) is", () => {
    expect(isCacheMiss(prev(100_000), call(3, 0, MISS_MIN_WRITE), false)).toBe(false);
    expect(isCacheMiss(prev(100_000), call(3, 0, MISS_MIN_WRITE + 1), false)).toBe(true);
  });

  test("reading half or more of the previous context back is a hit, just under half is a miss", () => {
    expect(isCacheMiss(prev(100_000), call(3, 50_000, 50_000), false)).toBe(false);
    expect(isCacheMiss(prev(100_000), call(3, 49_000, 51_000), false)).toBe(true);
  });

  test("a run's first call is never a miss: it starts from whatever cache the last run left", () => {
    expect(isCacheMiss(prev(200_000), call(3, 0, 200_000), true)).toBe(false);
  });

  test("with nothing before it, or an estimate on either side, there's nothing to compare", () => {
    expect(isCacheMiss(null, call(3, 0, 200_000), false)).toBe(false);
    expect(isCacheMiss({ ...prev(200_000), estimated: true }, call(3, 0, 200_000), false)).toBe(false);
    expect(isCacheMiss(prev(200_000), { ...call(200_000, 0, 0), estimated: true }, false)).toBe(false);
  });
});

describe("applyCall", () => {
  const at = (n: number) => 1_000 + n;

  test("the first call sets the prefix; later calls move the context but not the prefix", () => {
    let c: StoredContext | null = applyCall(null, call(3, 0, 47_000), at(0), true);
    expect(c).toMatchObject({ prefix: 47_003, cacheWrite: 47_000, misses: 0 });
    c = applyCall(c, call(3, 47_000, 5_000), at(1), false);
    expect(c).toMatchObject({ prefix: 47_003, cacheRead: 47_000, cacheWrite: 5_000, at: 1_001 });
  });

  test("misses and the tokens they re-wrote add up across a session, including a second run", () => {
    let c = applyCall(null, call(3, 0, 50_000), at(0), true);
    c = applyCall(c, call(3, 50_000, 60_000), at(1), false); // hit: wrote 60k but read the 50k back
    c = applyCall(c, call(3, 20_000, 140_000), at(2), false); // miss: 160k context, read 20k
    c = applyCall(c, call(3, 160_000, 1_000), at(3), false);
    c = applyCall(c, call(3, 10_000, 151_000), at(4), true); // next run's first call: not counted
    c = applyCall(c, call(3, 10_000, 156_000), at(5), false); // miss: read 10k of 161k
    expect(c).toMatchObject({ misses: 2, missTokens: 140_000 + 156_000 });
  });

  test("an estimate never counts misses and says so", () => {
    let c = applyCall(null, { input: 80_000, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true }, at(0), true);
    c = applyCall(c, { input: 120_000, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true }, at(1), false);
    expect(c).toMatchObject({ estimated: true, misses: 0, input: 120_000, prefix: 80_000 });
  });
});

describe("compactedContext", () => {
  test("restarts the miss tally and keeps the prefix, with the new size as the whole context", () => {
    const before = applyCall(applyCall(null, call(3, 0, 50_000), 1, true), call(3, 0, 300_000), 2, false);
    expect(before.misses).toBe(1);
    expect(compactedContext(before, 61_000, 9)).toMatchObject({ misses: 0, missTokens: 0, prefix: 50_003, cacheWrite: 61_000, cacheRead: 0, at: 9 });
  });
});
