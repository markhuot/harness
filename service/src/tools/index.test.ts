import { describe, expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { toolsForRun } from "./index";

const BROWSER = ["browser_open", "browser_content", "browser_click", "browser_type", "browser_eval", "browser_screenshot"];
const NATIVE_FULL = ["bash", "read_file", "write_file", "edit_file", "list_files"];
const NATIVE_READ = ["read_file", "list_files", "bash"];
const CONDUCTOR = ["create_ticket", "list_tickets", "get_ticket", "start_ticket", "message_ticket", "review_ticket", "complete_ticket"];

const builtin = { hasBuiltinTools: true };
const bare = { hasBuiltinTools: false };
const names = (kind: RunKind, driver: { hasBuiltinTools: boolean; usesPermissionPromptTool?: boolean }) => toolsForRun(kind, driver).map((t) => t.name);

describe("toolsForRun", () => {
  const harnessByKind: Record<RunKind, string[]> = {
    plan: ["post_summary", "update_plan", ...BROWSER],
    work: ["post_summary", "block", "submit_for_review", ...BROWSER],
    review: ["post_summary", "review_decision", ...BROWSER],
    complete: ["post_summary"],
    conductor: ["post_summary", "submit_for_review", ...CONDUCTOR, ...BROWSER],
    triage: ["list_projects", "dispatch_ticket", "decline_work"],
  };
  const nativeByKind: Record<RunKind, string[]> = {
    plan: NATIVE_READ,
    work: NATIVE_FULL,
    review: NATIVE_READ,
    complete: NATIVE_FULL,
    conductor: NATIVE_READ,
    triage: [],
  };

  for (const kind of Object.keys(harnessByKind) as RunKind[]) {
    test(`${kind}: drivers with built-in tools get only harness tools`, () => {
      expect(names(kind, builtin)).toEqual(harnessByKind[kind]);
      expect(toolsForRun(kind, builtin).every((t) => t.group === "harness")).toBe(true);
    });
    test(`${kind}: native-loop drivers also get the ${nativeByKind[kind].length === 5 ? "full" : nativeByKind[kind].length ? "read-only" : "empty"} native set`, () => {
      expect(names(kind, bare)).toEqual([...harnessByKind[kind], ...nativeByKind[kind]]);
    });
  }

  test("review runs can never write files", () => {
    const review = names("review", bare);
    expect(review).not.toContain("write_file");
    expect(review).not.toContain("edit_file");
    expect(review).toContain("read_file");
  });

  test("ticket-state tools are only offered to the run kinds that may use them", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage"];
    const who = (tool: string) => kinds.filter((k) => names(k, builtin).includes(tool));
    expect(who("block")).toEqual(["work"]);
    expect(who("submit_for_review")).toEqual(["work", "conductor"]);
    expect(who("update_plan")).toEqual(["plan"]);
    expect(who("review_decision")).toEqual(["review"]);
    expect(who("post_summary")).toEqual(["plan", "work", "review", "complete", "conductor"]);
    expect(who("dispatch_ticket")).toEqual(["triage"]);
    expect(who("browser_open")).toEqual(["plan", "work", "review", "conductor"]);
  });

  test("permission_prompt is added for every kind when the driver uses it, and only then", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage"];
    for (const kind of kinds) {
      expect(names(kind, { hasBuiltinTools: true, usesPermissionPromptTool: true })).toEqual([...names(kind, builtin), "permission_prompt"]);
      expect(names(kind, builtin)).not.toContain("permission_prompt");
      expect(names(kind, bare)).not.toContain("permission_prompt");
    }
  });

  test("returns a fresh array each call", () => {
    const a = toolsForRun("work", builtin);
    a.pop();
    expect(toolsForRun("work", builtin)).toHaveLength(a.length + 1);
  });

  test("unknown run kind throws", () => {
    expect(() => toolsForRun("nope" as RunKind, builtin)).toThrow("Unknown run kind");
  });
});
