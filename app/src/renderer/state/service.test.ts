import { describe, expect, test } from "bun:test";
import { isServiceStale, serviceCodeOf, serviceNotice, UNREACHABLE_AFTER_MS } from "./service";

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

describe("serviceNotice", () => {
  const base = { stale: false, deferred: false, downSince: null, now: 100_000 };

  test("a dropped socket is only unreachable once it has stayed down long enough", () => {
    expect(serviceNotice({ ...base, downSince: base.now - UNREACHABLE_AFTER_MS + 1 })).toBeNull();
    expect(serviceNotice({ ...base, downSince: base.now - UNREACHABLE_AFTER_MS })).toBe("unreachable");
  });

  test("unreachable outranks deferred, which outranks stale", () => {
    const down = base.now - UNREACHABLE_AFTER_MS;
    expect(serviceNotice({ ...base, stale: true, deferred: true, downSince: down })).toBe("unreachable");
    expect(serviceNotice({ ...base, stale: true, deferred: true })).toBe("deferred");
    expect(serviceNotice({ ...base, stale: true })).toBe("stale");
  });
});
