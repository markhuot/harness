import { describe, expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { fakeContext, fakeOps } from "./fakes";
import { CORE_TOOL_NAMES, dispatcherTools, rankTools, toolsForRun } from "./index";

const BROWSER = ["browser_open", "browser_tabs", "browser_resize", "browser_close_tab", "browser_content", "browser_click", "browser_type", "browser_eval", "browser_screenshot", "browser_wait", "browser_run", "browser_run_status", "browser_run_stop"];
const NATIVE_FULL = ["bash", "read_file", "write_file", "edit_file", "list_files"];
const NATIVE_READ = ["read_file", "list_files", "bash"];
const BOARD = ["list_tickets", "get_ticket", "search_tickets", "list_projects", "list_inbox"];
const BOARD_WRITE = ["create_ticket", "update_ticket", "move_ticket", "start_ticket", "message_ticket", "cancel_ticket", "reopen_ticket"];
const CONDUCTOR = ["review_ticket", "complete_ticket"];
const SPEC = ["read_spec", "edit_spec", "update_spec"];

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
    // update_ticket edits only the plan run's own ticket (the orchestrator checks).
    plan: ["post_note", ...SPEC, "update_ticket", ...BOARD, ...CONFIG_READ, ...BROWSER],
    work: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    review: ["post_note", "read_spec", "edit_spec", "review_decision", ...BOARD, ...CONFIG_READ, ...BROWSER],
    complete: ["post_note", ...SPEC, "record_pull_request", ...BOARD, ...CONFIG_READ],
    conductor: ["post_note", ...SPEC, "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    triage: [...BOARD, "dispatch_ticket", "decline_work", ...CONFIG_READ],
    // A chat (a message to a blocked, review or done task ticket) gets the work run's tools.
    chat: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
  };
  const nativeByKind: Record<RunKind, string[]> = {
    plan: NATIVE_READ,
    work: NATIVE_FULL,
    review: NATIVE_READ,
    complete: NATIVE_FULL,
    conductor: NATIVE_READ,
    triage: [],
    chat: NATIVE_FULL,
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
    for (const kind of ["review"] as RunKind[]) {
      const tools = names(kind, bare);
      expect(tools).not.toContain("write_file");
      expect(tools).not.toContain("edit_file");
      expect(tools).toContain("read_file");
    }
  });

  test("ticket-state tools are only offered to the run kinds that may use them", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
    const who = (tool: string) => kinds.filter((k) => names(k, builtin).includes(tool));
    expect(who("block")).toEqual(["work", "chat"]);
    expect(who("unblock")).toEqual(["work", "conductor", "chat"]);
    expect(who("resume_work")).toEqual(["work", "conductor", "chat"]);
    expect(who("submit_for_review")).toEqual(["work", "conductor", "chat"]);
    expect(who("read_spec")).toEqual(["plan", "work", "review", "complete", "conductor", "chat"]);
    // Review runs record findings with edit_spec but never replace the spec; triage never sees it.
    expect(who("edit_spec")).toEqual(["plan", "work", "review", "complete", "conductor", "chat"]);
    expect(who("update_spec")).toEqual(["plan", "work", "complete", "conductor", "chat"]);
    expect(who("review_decision")).toEqual(["review"]);
    expect(who("post_note")).toEqual(["plan", "work", "review", "complete", "conductor", "chat"]);
    expect(who("dispatch_ticket")).toEqual(["triage"]);
    expect(who("browser_open")).toEqual(["plan", "work", "review", "conductor", "chat"]);
    for (const read of BOARD) expect(who(read)).toEqual(kinds);
    for (const change of BOARD_WRITE) expect(who(change)).toEqual(change === "update_ticket" ? ["plan", "work", "conductor", "chat"] : ["work", "conductor", "chat"]);
    for (const steer of CONDUCTOR) expect(who(steer)).toEqual(["work", "conductor", "chat"]);
    expect(who("update_branch")).toEqual(["work", "conductor", "chat"]);
  });

  test("config reads go to every run kind; config writes only to work, conductor and chat runs", () => {
    const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
    const who = (tool: string) => kinds.filter((k) => names(k, bare).includes(tool));
    for (const tool of CONFIG_READ) expect(who(tool)).toEqual(kinds);
    for (const tool of CONFIG_WRITE) expect(who(tool)).toEqual(["work", "conductor", "chat"]);
  });

  test("a chat gets its ticket's work tools: a conductor ticket's are the conductor's", () => {
    expect(toolsForRun("chat", bare, { kind: "task" }).map((t) => t.name)).toEqual(names("work", bare));
    expect(toolsForRun("chat", bare, { kind: "conductor" }).map((t) => t.name)).toEqual(names("conductor", bare));
    // A conductor ticket's chat can't block (conductors never do) and keeps the read-only native set.
    expect(toolsForRun("chat", bare, { kind: "conductor" }).map((t) => t.name)).not.toContain("block");
    expect(toolsForRun("chat", bare, { kind: "conductor" }).map((t) => t.name)).not.toContain("write_file");
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

describe("dispatcherTools", () => {
  const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
  const view = (kind: RunKind, driver: { hasBuiltinTools: boolean; usesPermissionPromptTool?: boolean }) => dispatcherTools(toolsForRun(kind, driver));

  test("each run kind advertises its core tools, its native tools, then tool_search and call_tool", () => {
    for (const kind of kinds) {
      for (const driver of [builtin, bare, { hasBuiltinTools: true, usesPermissionPromptTool: true }]) {
        const all = toolsForRun(kind, driver);
        const direct = all.filter((t) => t.group === "native" || CORE_TOOL_NAMES.has(t.name)).map((t) => t.name);
        expect(view(kind, driver).map((t) => t.name)).toEqual([...direct, "tool_search", "call_tool"]);
      }
    }
    expect(view("work", bare).map((t) => t.name)).toEqual(["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", ...NATIVE_FULL, "tool_search", "call_tool"]);
    expect(view("triage", builtin).map((t) => t.name)).toEqual(["dispatch_ticket", "decline_work", "tool_search", "call_tool"]);
  });

  test("toolsForRun still returns the whole allowed set; the view hides the rest", () => {
    const work = toolsForRun("work", builtin).map((t) => t.name);
    const shown = view("work", builtin).map((t) => t.name);
    for (const hidden of [...BROWSER, ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, "update_branch"]) {
      expect(work).toContain(hidden);
      expect(shown).not.toContain(hidden);
    }
  });

  test("the view is the same objects for the same tools array, so it never changes mid-run", () => {
    const tools = toolsForRun("work", builtin);
    expect(dispatcherTools(tools)).toBe(dispatcherTools(tools));
  });

  test("a run with nothing to search gets its tools as they are", () => {
    const tools = toolsForRun("work", builtin).filter((t) => CORE_TOOL_NAMES.has(t.name));
    expect(dispatcherTools(tools).map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  test("tool_search and call_tool are harness tools (advertised read-only)", () => {
    const tools = view("review", builtin);
    for (const name of ["tool_search", "call_tool"]) expect(tools.find((t) => t.name === name)!.group).toBe("harness");
  });

  test("call_tool is judged as the tool it runs: a native tool asks the gate, a gated tool asks a human", async () => {
    const callTool = view("work", bare).find((t) => t.name === "call_tool")!;
    const ops = fakeOps({
      checkPermission: async () => ({ behavior: "deny", message: "no" }),
      requestApproval: async () => ({ behavior: "deny", message: "awaiting approval" }),
    });
    const ctx = fakeContext({ ops });
    const bash = await callTool.execute({ name: "bash", input: { command: "rm -rf /tmp/x" } }, ctx);
    expect(bash.isError).toBe(true);
    const watcher = await callTool.execute({ name: "create_watcher", input: { name: "w", command: "echo hi" } }, ctx);
    expect(watcher.isError).toBe(true);
    const judged = ops.calls.filter((c) => c.method === "checkPermission" || c.method === "requestApproval");
    expect(judged.map((c) => [c.method, c.args[0]])).toEqual([
      ["checkPermission", "bash"],
      ["requestApproval", "create_watcher"],
    ]);
    expect(judged[0]!.args[1]).toEqual({ command: "rm -rf /tmp/x" });
    expect(judged[1]!.args[2]).toMatchObject({ onceOnly: true });
  });

  test("rankTools: exact names first, then whole-word name matches, then descriptions", () => {
    const hidden = toolsForRun("work", builtin).filter((t) => !CORE_TOOL_NAMES.has(t.name));
    const rank = (q: string) => rankTools(hidden, q).map((t) => t.name);
    expect(rank("browser_run_stop")[0]).toBe("browser_run_stop");
    expect(rank("inbox")[0]).toBe("list_inbox");
    expect(rank("watcher").slice(0, 5).sort()).toEqual(["create_watcher", "delete_watcher", "list_watchers", "run_watcher", "update_watcher"]);
    expect(rank("branch")[0]).toBe("update_branch");
    expect(rank("the of")).toEqual([]);
  });
});
