import { describe, expect, test } from "bun:test";
import { resolvePermissionMode } from "../../../shared/src/permissions";

describe("resolvePermissionMode", () => {
  const settings = { permissionMode: "auto" as const };
  test("ticket beats project beats settings", () => {
    expect(resolvePermissionMode({ permissionMode: "ask" }, { permissionMode: "read_only" }, settings)).toEqual({ mode: "ask", source: "ticket" });
    expect(resolvePermissionMode({ permissionMode: null }, { permissionMode: "read_only" }, settings)).toEqual({ mode: "read_only", source: "project" });
    expect(resolvePermissionMode({ permissionMode: null }, { permissionMode: null }, settings)).toEqual({ mode: "auto", source: "settings" });
  });
  test("a missing ticket or project is skipped, not an error", () => {
    expect(resolvePermissionMode(null, undefined, settings)).toEqual({ mode: "auto", source: "settings" });
    expect(resolvePermissionMode(undefined, { permissionMode: "ask" }, settings)).toEqual({ mode: "ask", source: "project" });
  });
});
