import { expect, test } from "bun:test";
import { resolvePermissionMode } from "./permissions";

test("ticket override beats project, project beats settings; null inherits", () => {
  const settings = { permissionMode: "auto" as const };
  expect(resolvePermissionMode({ permissionMode: "read_only" }, { permissionMode: "ask" }, settings)).toEqual({ mode: "read_only", source: "ticket" });
  expect(resolvePermissionMode({ permissionMode: null }, { permissionMode: "ask" }, settings)).toEqual({ mode: "ask", source: "project" });
  expect(resolvePermissionMode({ permissionMode: null }, { permissionMode: null }, settings)).toEqual({ mode: "auto", source: "settings" });
  expect(resolvePermissionMode(null, undefined, { permissionMode: "ask" })).toEqual({ mode: "ask", source: "settings" });
});
