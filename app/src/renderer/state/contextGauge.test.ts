import { describe, expect, test } from "bun:test";
import type { ContextUsage } from "@harness/shared";
import { BUSY_HINT, formatTokens, gaugeInfo, gaugeMenu, gaugeView, limitError, missBadgeText, missRowText, parseLimit, ESTIMATED_INFO, GAUGE_INFO } from "./contextGauge";

const ctx = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  input: 1000,
  cacheRead: 61_000,
  cacheWrite: 20_000,
  output: 500,
  prefix: 50_000,
  at: 0,
  estimated: false,
  misses: 0,
  missTokens: 0,
  ...over,
});

describe("formatTokens", () => {
  test("rounds thousands and millions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(82_000)).toBe("82k");
    expect(formatTokens(82_499)).toBe("82k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
  test("a value that rounds up to 1000k is 1M", () => {
    expect(formatTokens(999_600)).toBe("1M");
    expect(formatTokens(999_400)).toBe("999k");
  });
  test("negative and fractional input never leaks a sign or decimals", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(10.6)).toBe("11");
  });
});

describe("gaugeView", () => {
  test("null and undefined context is the empty New state", () => {
    for (const c of [null, undefined]) {
      const v = gaugeView(c, 250_000);
      expect(v.empty).toBe(true);
      expect(v.label).toBe("New");
      expect(v.fraction).toBe(0);
      expect(v.prefixFraction).toBeNull();
      expect(v.missBadge).toBeNull();
    }
  });

  test("splits the fill into cached and fresh and titles it", () => {
    const v = gaugeView(ctx(), 250_000);
    expect(v.total).toBe(82_000);
    expect(v.label).toBe("82k");
    expect(v.fraction).toBeCloseTo(0.328);
    expect(v.cachedFraction).toBeCloseTo(61_000 / 250_000);
    expect(v.freshFraction).toBeCloseTo(21_000 / 250_000);
    expect(v.cachedFraction + v.freshFraction).toBeCloseTo(v.fraction);
    expect(v.prefixFraction).toBeCloseTo(0.2);
    expect(v.title).toBe("Context 82k of 250k: 61k cached, 21k fresh");
    expect(v.over).toBe(false);
  });

  test("exactly at the limit is full but not over; one token past is over and clamped", () => {
    const at = gaugeView(ctx({ input: 0, cacheRead: 200_000, cacheWrite: 50_000 }), 250_000);
    expect(at.fraction).toBe(1);
    expect(at.over).toBe(false);
    const past = gaugeView(ctx({ input: 1, cacheRead: 200_000, cacheWrite: 50_000 }), 250_000);
    expect(past.over).toBe(true);
    expect(past.fraction).toBe(1);
    expect(past.cachedFraction + past.freshFraction).toBeCloseTo(1);
    expect(past.title).toContain("Over the limit");
  });

  test("a far-over-limit session keeps both tones inside the dial", () => {
    const v = gaugeView(ctx({ input: 0, cacheRead: 900_000, cacheWrite: 100_000 }), 250_000);
    expect(v.fraction).toBe(1);
    expect(v.cachedFraction).toBeCloseTo(0.9);
    expect(v.freshFraction).toBeCloseTo(0.1);
    expect(v.label).toBe("1M");
  });

  test("a prefix past the limit clamps to the end of the dial; no prefix has no tick", () => {
    expect(gaugeView(ctx({ prefix: 500_000 }), 250_000).prefixFraction).toBe(1);
    expect(gaugeView(ctx({ prefix: 0 }), 250_000).prefixFraction).toBeNull();
  });

  test("estimated shows ~82k*, one tone, and the word-count title, with no misses", () => {
    const v = gaugeView(ctx({ input: 82_000, cacheRead: 0, cacheWrite: 0, estimated: true, misses: 4, missTokens: 9000 }), 250_000);
    expect(v.label).toBe("~82k*");
    expect(v.cachedFraction).toBe(0);
    expect(v.freshFraction).toBeCloseTo(v.fraction);
    expect(v.title).toBe("Context about 82k of 250k (estimated from word count)");
    expect(v.missBadge).toBeNull();
    expect(v.missRow).toBeNull();
  });

  test("a zero or missing limit falls back to the default 250k", () => {
    expect(gaugeView(ctx(), 0).limit).toBe(250_000);
    expect(gaugeView(ctx(), undefined).limit).toBe(250_000);
    expect(gaugeView(ctx(), 100_000).limit).toBe(100_000);
  });

  test("a zero-token context doesn't divide by zero", () => {
    const v = gaugeView(ctx({ input: 0, cacheRead: 0, cacheWrite: 0 }), 250_000);
    expect(v.fraction).toBe(0);
    expect(v.cachedFraction).toBe(0);
    expect(v.freshFraction).toBe(0);
  });

  test("misses: none shows no badge, one is singular, many plural", () => {
    expect(gaugeView(ctx({ misses: 0 }), 250_000).missBadge).toBeNull();
    expect(gaugeView(ctx({ misses: 1, missTokens: 40_000 }), 250_000).missBadge).toBe("1 miss");
    const v = gaugeView(ctx({ misses: 3, missTokens: 377_000 }), 250_000);
    expect(v.missBadge).toBe("3 misses");
    expect(v.missRow).toBe("3 cache misses (377k tokens re-written)");
  });
});

describe("miss text", () => {
  test("badge and row agree on singular/plural", () => {
    expect(missBadgeText(0)).toBeNull();
    expect(missBadgeText(1)).toBe("1 miss");
    expect(missRowText(1, 31_000)).toBe("1 cache miss (31k tokens re-written)");
    expect(missRowText(0, 0)).toBeNull();
  });
});

describe("gaugeMenu", () => {
  const both = { sessionActions: { compact: true, newSession: true }, reportsContextUsage: true };

  test("idle ticket on a driver with both actions enables both", () => {
    const m = gaugeMenu({ busy: false }, both);
    expect(m.visible).toBe(true);
    expect(m.disabled).toBe(false);
    expect(m.compact).toEqual({ shown: true, enabled: true, hint: null });
    expect(m.newSession).toEqual({ shown: true, enabled: true, hint: null });
    expect(m.limit).toBe(true);
  });

  test("busy greys Compact and New session with the hint; Limit stays", () => {
    const m = gaugeMenu({ busy: true }, both);
    expect(m.compact).toEqual({ shown: true, enabled: false, hint: BUSY_HINT });
    expect(m.newSession).toEqual({ shown: true, enabled: false, hint: BUSY_HINT });
    expect(m.limit).toBe(true);
    expect(m.disabled).toBe(false);
  });

  test("compacting disables the whole menu and the actions", () => {
    const m = gaugeMenu({ busy: true, compacting: true }, both);
    expect(m.disabled).toBe(true);
    expect(m.compact.enabled).toBe(false);
    expect(m.newSession.enabled).toBe(false);
  });

  test("each capability combination hides what the driver can't do", () => {
    expect(gaugeMenu({}, { sessionActions: { compact: false, newSession: true }, reportsContextUsage: true }).compact.shown).toBe(false);
    expect(gaugeMenu({}, { sessionActions: { compact: false, newSession: true }, reportsContextUsage: true }).newSession.shown).toBe(true);
    expect(gaugeMenu({}, { sessionActions: { compact: true, newSession: false }, reportsContextUsage: true }).newSession.shown).toBe(false);
    const none = gaugeMenu({ busy: true }, { sessionActions: { compact: false, newSession: false }, reportsContextUsage: true });
    expect(none.compact).toEqual({ shown: false, enabled: false, hint: null });
    expect(none.newSession).toEqual({ shown: false, enabled: false, hint: null });
  });

  test("a driver list that hasn't loaded shows the gauge without actions", () => {
    const m = gaugeMenu({ busy: false }, undefined);
    expect(m.visible).toBe(true);
    expect(m.compact.shown).toBe(false);
    expect(m.newSession.shown).toBe(false);
    expect(m.limit).toBe(true);
  });

  test("a driver that reports no context usage hides the gauge; unspecified keeps it", () => {
    expect(gaugeMenu({}, { reportsContextUsage: false }).visible).toBe(false);
    expect(gaugeMenu({}, {}).visible).toBe(true);
  });
});

describe("limit parsing and validation", () => {
  test("parses plain, comma, k and m forms", () => {
    expect(parseLimit("250000")).toBe(250_000);
    expect(parseLimit(" 250,000 ")).toBe(250_000);
    expect(parseLimit("300k")).toBe(300_000);
    expect(parseLimit("1.5M")).toBe(1_500_000);
    expect(parseLimit("abc")).toBeNaN();
    expect(parseLimit("")).toBeNaN();
    expect(parseLimit("12 tokens")).toBeNaN();
  });

  test("bounds are inclusive: 10k and 2M pass, a token outside fails", () => {
    expect(limitError(10_000)).toBeNull();
    expect(limitError(2_000_000)).toBeNull();
    expect(limitError(9_999)).not.toBeNull();
    expect(limitError(2_000_001)).not.toBeNull();
    expect(limitError(NaN)).not.toBeNull();
    expect(limitError(250_000.5)).not.toBeNull();
  });
});

describe("gaugeInfo", () => {
  test("estimated gauges explain the estimate instead", () => {
    expect(gaugeInfo(true)).toBe(ESTIMATED_INFO);
    expect(gaugeInfo(false)).toBe(GAUGE_INFO);
  });
});
