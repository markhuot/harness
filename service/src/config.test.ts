import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureHome, ensureToken, readServiceJson, resolveHome, resolvePort, writeServiceJson } from "./config";
import { tempHome } from "./testing/fakes";

describe("config", () => {
  test("HARNESS_HOME / HARNESS_PORT resolution", () => {
    expect(resolveHome({})).toBe(join(homedir(), ".harness"));
    expect(resolveHome({ HARNESS_HOME: "~/x" })).toBe(join(homedir(), "x"));
    expect(resolveHome({ HARNESS_HOME: "/tmp/h" })).toBe("/tmp/h");
    expect(resolvePort({})).toBe(7717);
    expect(resolvePort({ HARNESS_PORT: "0" })).toBe(0);
    expect(() => resolvePort({ HARNESS_PORT: "70000" })).toThrow(/Invalid/);
    expect(() => resolvePort({ HARNESS_PORT: "abc" })).toThrow(/Invalid/);
  });

  test("token is 64 hex chars, mode 0600, stable across calls, and permissions are repaired", () => {
    const paths = ensureHome(tempHome());
    const a = ensureToken(paths);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
    chmodSync(paths.tokenPath, 0o644);
    expect(ensureToken(paths)).toBe(a);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
    writeFileSync(paths.tokenPath, "  \n");
    const b = ensureToken(paths);
    expect(b).not.toBe(a);
    expect(readFileSync(paths.tokenPath, "utf8").trim()).toBe(b);
  });

  test("service.json round-trip rejects garbage", () => {
    const paths = ensureHome(tempHome());
    expect(readServiceJson(paths)).toBeNull();
    writeServiceJson(paths, { port: 1234, pid: 99, startedAt: 1 });
    expect(readServiceJson(paths)).toEqual({ port: 1234, pid: 99, startedAt: 1 });
    writeFileSync(paths.serviceJsonPath, "{nope");
    expect(readServiceJson(paths)).toBeNull();
  });
});
