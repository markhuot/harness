import { describe, expect, test } from "bun:test";
import type { Run } from "../protocol";
import { formatDuration } from "./format";
import { formatCost, formatTokens, runPhaseDefault, runRowInfo } from "./runs";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r",
  sessionId: "s",
  kind: "work",
  status: "succeeded",
  driver: "claude-code",
  prompt: "Do it",
  error: null,
  createdAt: 0,
  startedAt: 1000,
  endedAt: 13_400,
  ...over,
});

describe("formatDuration", () => {
  test("seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(59_500)).toBe("1m 0s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("formatTokens", () => {
  test("plain, k and M with a dropped .0", () => {
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(48_250)).toBe("48.3k");
    expect(formatTokens(999_949)).toBe("999.9k");
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});

describe("formatCost", () => {
  test("dollars, sub-cent and zero", () => {
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(12.3)).toBe("$12.30");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.005)).toBe("$0.01");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("runPhaseDefault", () => {
  const settings = { work: { driver: "claude-code", model: "opus" }, review: { driver: "anthropic-api", model: null } };
  test("inherits project over settings, ignoring the ticket's own override", () => {
    expect(runPhaseDefault("work", { hasTicket: true, settings })).toEqual({ driver: "claude-code", model: "opus" });
    expect(runPhaseDefault("work", { hasTicket: true, project: { work: { driver: "dummy", model: null } }, settings })).toEqual({ driver: "dummy", model: null });
    expect(runPhaseDefault("review", { hasTicket: true, settings })).toEqual({ driver: "anthropic-api", model: null });
  });
  test("chat and conductor follow work", () => {
    expect(runPhaseDefault("chat", { hasTicket: true, settings })?.model).toBe("opus");
  });
  test("triage and runs outside a ticket have no default", () => {
    expect(runPhaseDefault("triage", { hasTicket: true, settings })).toBeNull();
    expect(runPhaseDefault("work", { hasTicket: false, settings })).toBeNull();
  });
});

describe("runRowInfo", () => {
  const def = { driver: "claude-code", model: "opus" };
  test("a run on the default shows neither driver nor model", () => {
    const i = runRowInfo(run({ model: "opus" }), def, 20_000);
    expect(i.driver).toBeNull();
    expect(i.model).toBeNull();
  });
  test("another model on the same driver shows only the model", () => {
    const i = runRowInfo(run({ model: "haiku" }), def, 20_000);
    expect(i.driver).toBeNull();
    expect(i.model).toBe("haiku");
  });
  test("another driver shows both, even when the model text matches", () => {
    const i = runRowInfo(run({ driver: "anthropic-api", model: "opus" }), def, 20_000);
    expect(i.driver).toBe("anthropic-api");
    expect(i.model).toBe("opus");
  });
  test("a run with no recorded model shows no model chip", () => {
    expect(runRowInfo(run({ model: null }), def, 20_000).model).toBeNull();
    expect(runRowInfo(run(), def, 20_000).model).toBeNull();
  });
  test("with no default (triage, standalone) driver and known model always show", () => {
    const i = runRowInfo(run({ model: "opus" }), null, 20_000);
    expect(i.driver).toBe("claude-code");
    expect(i.model).toBe("opus");
  });
  test("a default model of null matches a run that recorded none", () => {
    expect(runRowInfo(run({ model: null }), { driver: "claude-code", model: null }, 0).model).toBeNull();
  });
  test("tokens and cost appear only when reported", () => {
    const none = runRowInfo(run(), def, 20_000);
    expect(none.tokens).toBeNull();
    expect(none.tokensDetail).toBeNull();
    expect(none.cost).toBeNull();
    const some = runRowInfo(run({ inputTokens: 40_000, outputTokens: 8200, costUsd: 0.416 }), def, 20_000);
    expect(some.tokens).toBe("48.2k tokens");
    expect(some.tokensDetail).toBe("40k in · 8.2k out");
    expect(some.cost).toBe("$0.42");
    expect(runRowInfo(run({ inputTokens: 500 }), def, 0).tokens).toBe("500 tokens");
    expect(runRowInfo(run({ costUsd: 0 }), def, 0).cost).toBe("$0.00");
  });
  test("elapsed: finished, running, queued and never started", () => {
    expect(runRowInfo(run(), def, 99_000).elapsed).toBe("12s");
    expect(runRowInfo(run({ startedAt: 1000, endedAt: 1100 }), def, 0).elapsed).toBe("1s");
    const running = runRowInfo(run({ status: "running", endedAt: null }), def, 66_000);
    expect(running.elapsed).toBe("1m 5s");
    expect(running.start).toBe("1m ago");
    const queued = runRowInfo(run({ status: "queued", startedAt: null, endedAt: null, createdAt: 10_000 }), def, 25_000);
    expect(queued.elapsed).toBe("waiting 15s");
    expect(queued.start).toBeNull();
    const cancelled = runRowInfo(run({ status: "cancelled", startedAt: null, endedAt: 5000, createdAt: 1000 }), def, 400_000);
    expect(cancelled.elapsed).toBeNull();
    expect(cancelled.start).toBe("7m ago");
  });
});
