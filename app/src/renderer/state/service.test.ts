import { describe, expect, test } from "bun:test";
import { isServiceStale, serviceCodeOf } from "./service";

describe("isServiceStale", () => {
  test("unknown until /health answers", () => {
    expect(isServiceStale(null)).toBe(false);
  });

  test("a service from before build tracking (no build in /health) is older than this app", () => {
    expect(isServiceStale(serviceCodeOf({ ok: true, version: "0.1.0", pid: 1 }))).toBe(true);
  });

  test("a tracking service is stale only when it says so", () => {
    expect(isServiceStale(serviceCodeOf({ ok: true, version: "0.1.0", pid: 1, build: "abc", stale: false }))).toBe(false);
    expect(isServiceStale(serviceCodeOf({ ok: true, version: "0.1.0", pid: 1, build: "abc", stale: true }))).toBe(true);
    expect(isServiceStale(serviceCodeOf({ build: "abc", stale: true }))).toBe(true);
  });

  test("a service that doesn't track its source (build null) is never stale", () => {
    expect(isServiceStale(serviceCodeOf({ ok: true, version: "0.1.0", pid: 1, build: null, stale: false }))).toBe(false);
  });
});
