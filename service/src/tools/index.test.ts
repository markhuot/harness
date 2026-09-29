import { describe, expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { toolsForRun } from "./index";

const BROWSER = ["browser_open", "browser_content", "browser_click", "browser_type", "browser_eval", "browser_screenshot"];
const NATIVE_FULL = ["bash", "read_file", "write_file", "edit_file", "list_files"];
const NATIVE_READ = ["read_file", "list_files", "bash"];
const BOARD = ["list_tickets", "get_ticket", "search_tickets", "list_projects", "list_inbox"];
const BOARD_WRITE = ["create_ticket", "update_ticket", "move_ticket", "start_ticket", "message_ticket", "cancel_ticket", "reopen_ticket"];
const CONDUCTOR = ["review_ticket", "complete_ticket"];

const CONFIG_READ = ["list_watchers", "get_settings", "list_drivers"];
const CONFIG_WRITE = [
  "create_watcher",
  "update_watcher",
  "delete_watcher",
  "run_watcher",
  "create_project",
  "update_project",
  "delete_project",
  "update_settings",
  "delete_ticket",
];

const builtin = { hasBuiltinTools: true };
const bare = { hasBuiltinTools: false };
const names = (kind: RunKind, driver: { hasBuiltinTools: boolean; usesPermissionPromptTool?: boolean }) => toolsForRun(kind, driver).map((t) => t.name);

describe("toolsForRun", () => {
  const harnessByKind: Record<RunKind, string[]> = {
    plan: ["post_summary", "update_plan", ...BOARD, ...CONFIG_READ, ...BROWSER],
    work: ["post_summary", "block", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    review: ["post_summary", "review_decision", ...BOARD, ...CONFIG_READ, ...BROWSER],
    complete: ["post_summary", "record_pull_request", ...BOARD, ...CONFIG_READ],
    conductor: ["post_summary", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    triage: [...BOARD, "dispatch_ticket", "decline_work", ...CONFIG_READ],
    chat: ["post_summary", ...BOARD, ...CONFIG_READ, ...BROWSER],
  };
  const nativeByKind: Record<RunKind, string[]> = {
    plan: NATIVE_READ,
    work: NATIVE_FULL,
    review: NATIVE_READ,
    complete: NATIVE_FULL,
    conductor: NATIVE_READ,
    triage: [],
    chat: NATIVE_READ,
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

  test("review and chat runs can never write files", () => {
    for (const kind of ["review", "chat"] as RunKind[]) {
      const tools = names(kind, bare);
      expect(tools).not.toContain("write_file");
      expect(tools).not.toContain("edit_file");
      expect(tools).toContain("read_file");
    }
  });

  test("ticket-state tools are only offered to the run kinds that may use them", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
    const who = (tool: string) => kinds.filter((k) => names(k, builtin).includes(tool));
    expect(who("block")).toEqual(["work"]);
    expect(who("submit_for_review")).toEqual(["work", "conductor"]);
    expect(who("update_plan")).toEqual(["plan"]);
    expect(who("review_decision")).toEqual(["review"]);
    expect(who("post_summary")).toEqual(["plan", "work", "review", "complete", "conductor", "chat"]);
    expect(who("dispatch_ticket")).toEqual(["triage"]);
    expect(who("browser_open")).toEqual(["plan", "work", "review", "conductor", "chat"]);
    for (const read of BOARD) expect(who(read)).toEqual(kinds);
    for (const change of BOARD_WRITE) expect(who(change)).toEqual(["work", "conductor"]);
    for (const steer of CONDUCTOR) expect(who(steer)).toEqual(["work", "conductor"]);
  });

  test("config reads go to every run kind; config writes only to work and conductor runs", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
    const who = (tool: string) => kinds.filter((k) => names(k, bare).includes(tool));
    for (const tool of CONFIG_READ) expect(who(tool)).toEqual(kinds);
    for (const tool of CONFIG_WRITE) expect(who(tool)).toEqual(["work", "conductor"]);
  });

  test("permission_prompt is added for every kind when the driver uses it, and only then", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
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
