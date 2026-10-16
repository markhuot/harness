import { describe, expect, test } from "bun:test";
import type { ContextUsage } from "@harness/shared";
import { formatTokens, gaugeInfo, gaugeMenu, gaugeView, limitError, missBadgeText, missRowText, parseLimit, BUSY_HINT, ESTIMATED_INFO, GAUGE_INFO } from "../../../app/src/renderer/state/contextGauge";

const usage = (o: Partial<ContextUsage> = {}): ContextUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, prefix: 0, at: 0, estimated: false, misses: 0, missTokens: 0, ...o });

describe("formatTokens", () => {
  test("under 1000 is the plain number; negatives and fractions clamp and round", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(999.4)).toBe("999");
  });
  test("thousands round to k", () => {
    expect(formatTokens(82_000)).toBe("82k");
    expect(formatTokens(1_500)).toBe("2k");
    expect(formatTokens(999_499)).toBe("999k");
  });
  test("999_500 and up is 1M, never 1000k", () => {
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(999_999)).toBe("1M");
  });
  test("millions keep one decimal only when needed", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("miss texts", () => {
  test("none is null; one is singular", () => {
    expect(missBadgeText(0)).toBeNull();
    expect(missBadgeText(-1)).toBeNull();
    expect(missBadgeText(1)).toBe("1 miss");
    expect(missBadgeText(3)).toBe("3 misses");
    expect(missRowText(0, 500)).toBeNull();
    expect(missRowText(1, 1000)).toBe("1 cache miss (1k tokens re-written)");
    expect(missRowText(3, 377_000)).toBe("3 cache misses (377k tokens re-written)");
  });
});

describe("gaugeView", () => {
  test("no context is the empty New dial, whatever the limit", () => {
    for (const c of [null, undefined]) {
      expect(gaugeView(c, 100_000)).toMatchObject({ empty: true, label: "New", fraction: 0, over: false, prefixFraction: null, missBadge: null, limit: 100_000 });
    }
  });
  test("a missing, zero or negative limit falls back to the default", () => {
    expect(gaugeView(null, undefined).limit).toBe(250_000);
    expect(gaugeView(usage({ input: 1 }), 0).limit).toBe(250_000);
    expect(gaugeView(usage({ input: 1 }), -5).limit).toBe(250_000);
  });
  test("splits the fill into cached and fresh", () => {
    const v = gaugeView(usage({ input: 10_000, cacheRead: 60_000, cacheWrite: 0, prefix: 25_000 }), 100_000);
    expect(v.total).toBe(70_000);
    expect(v.fraction).toBeCloseTo(0.7);
    expect(v.cachedFraction).toBeCloseTo(0.6);
    expect(v.freshFraction).toBeCloseTo(0.1);
    expect(v.prefixFraction).toBeCloseTo(0.25);
    expect(v.label).toBe("70k");
    expect(v.title).toBe("Context 70k of 100k: 60k cached, 10k fresh");
  });
  test("cache writes count as fresh in the title", () => {
    expect(gaugeView(usage({ input: 1_000, cacheWrite: 4_000, cacheRead: 5_000 }), 100_000).title).toContain("5k cached, 5k fresh");
  });
  test("over the limit clamps the needle and says so", () => {
    const v = gaugeView(usage({ input: 150_000 }), 100_000);
    expect(v).toMatchObject({ over: true, fraction: 1 });
    expect(v.title.endsWith(". Over the limit.")).toBe(true);
    expect(gaugeView(usage({ input: 100_000 }), 100_000).over).toBe(false);
  });
  test("an estimate is one tone, with a ~ label and no miss data", () => {
    const v = gaugeView(usage({ input: 50_000, cacheRead: 40_000, estimated: true, misses: 4, missTokens: 9_000 }), 100_000);
    expect(v).toMatchObject({ estimated: true, cachedFraction: 0, label: "~90k*", misses: 0, missTokens: 0, missBadge: null, missRow: null });
    expect(v.freshFraction).toBeCloseTo(0.9);
    expect(v.title).toBe("Context about 90k of 100k (estimated from word count)");
  });
  test("misses show on a real measurement", () => {
    expect(gaugeView(usage({ input: 1_000, misses: 2, missTokens: 5_000 }), 100_000)).toMatchObject({ missBadge: "2 misses", missRow: "2 cache misses (5k tokens re-written)" });
  });
  test("a zero-token context draws an empty dial without dividing by zero", () => {
    const v = gaugeView(usage(), 100_000);
    expect(v).toMatchObject({ empty: false, fraction: 0, cachedFraction: 0, freshFraction: 0, prefixFraction: null });
  });
  test("an absurd prefix clamps to the dial", () => {
    expect(gaugeView(usage({ input: 1, prefix: 900_000 }), 100_000).prefixFraction).toBe(1);
  });
});

describe("gaugeMenu", () => {
  const driver = (compact: boolean, newSession: boolean, reports = true) => ({ sessionActions: { compact, newSession }, reportsContextUsage: reports }) as never;
  test("an unknown driver shows the gauge with no session actions", () => {
    const m = gaugeMenu({}, undefined);
    expect(m).toMatchObject({ visible: true, disabled: false, limit: true });
    expect(m.compact).toEqual({ shown: false, enabled: false, hint: null });
    expect(m.newSession.shown).toBe(false);
  });
  test("a driver that doesn't report usage hides the gauge", () => {
    expect(gaugeMenu({}, driver(true, true, false)).visible).toBe(false);
  });
  test("idle: the actions the driver has are shown and enabled", () => {
    const m = gaugeMenu({}, driver(true, false));
    expect(m.compact).toEqual({ shown: true, enabled: true, hint: null });
    expect(m.newSession).toEqual({ shown: false, enabled: false, hint: null });
  });
  test("busy: shown but disabled with a hint; an unshown action gets no hint", () => {
    const m = gaugeMenu({ busy: true }, driver(true, false));
    expect(m.compact).toEqual({ shown: true, enabled: false, hint: BUSY_HINT });
    expect(m.newSession.hint).toBeNull();
  });
  test("compacting disables the trigger and the actions without the busy hint", () => {
    const m = gaugeMenu({ compacting: true }, driver(true, true));
    expect(m.disabled).toBe(true);
    expect(m.compact).toEqual({ shown: true, enabled: false, hint: null });
  });
});

describe("limitError", () => {
  test("accepts the bounds", () => {
    expect(limitError(10_000)).toBeNull();
    expect(limitError(2_000_000)).toBeNull();
  });
  test("rejects fractions, NaN and out-of-range values", () => {
    expect(limitError(1.5)).toBe("Enter a whole number of tokens");
    expect(limitError(NaN)).toBe("Enter a whole number of tokens");
    expect(limitError(9_999)).toBe("Between 10k and 2M tokens");
    expect(limitError(2_000_001)).toBe("Between 10k and 2M tokens");
  });
});

describe("parseLimit", () => {
  test("plain, comma-grouped and suffixed numbers", () => {
    expect(parseLimit("250000")).toBe(250_000);
    expect(parseLimit("250,000")).toBe(250_000);
    expect(parseLimit("250k")).toBe(250_000);
    expect(parseLimit(" 1.5M ")).toBe(1_500_000);
    expect(parseLimit(".5k")).toBe(500);
  });
  test("rounds to a whole token", () => {
    expect(parseLimit("1.0005k")).toBe(1_001);
  });
  test("anything else is NaN", () => {
    for (const s of ["", "abc", "-5", "1e3", "1.2.3", "5.", "10 kk", "k"]) expect(parseLimit(s)).toBeNaN();
  });
});

describe("gaugeInfo", () => {
  test("estimated gauges get the estimate note instead", () => {
    expect(gaugeInfo(true)).toBe(ESTIMATED_INFO);
    expect(gaugeInfo(false)).toBe(GAUGE_INFO);
  });
});
