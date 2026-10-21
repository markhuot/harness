import { expect, test } from "bun:test";
import type { PermissionMode } from "@harness/shared";
import { planCopilotPermissions } from "../../../service/src/drivers/github-copilot";

const plan = (kind: "work" | "cos", permissionMode: PermissionMode) => planCopilotPermissions({ kind, permissionMode }, { permissionMode: "auto" }).args;

test("a chief of staff on Copilot has every built-in denied and is never allowed everything, in any permission mode", () => {
  for (const mode of ["auto", "ask", "read_only"] as const) {
    const args = plan("cos", mode);
    expect(args).not.toContain("--allow-all");
    for (const tool of ["shell", "write", "read", "url"]) expect(args.join(" ")).toContain(`--deny-tool ${tool}`);
  }
});

test("a work run in auto mode still gets --allow-all", () => {
  expect(plan("work", "auto")).toContain("--allow-all");
});
