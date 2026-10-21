import { expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { toolsForRun } from "../../../service/src/tools/index";

const RUN_KINDS: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat", "compact", "cos"];
const names = (kind: RunKind, driver = { hasBuiltinTools: true, usesPermissionPromptTool: false }, ticket: { kind: "task" | "conductor" | "cos" } | null = null) => toolsForRun(kind, driver, ticket).map((t) => t.name);

test("a compact run has no tools", () => {
  expect(names("compact")).toEqual([]);
});

test("every tool in every run's set has a unique name, a description and an object schema", () => {
  for (const kind of RUN_KINDS) {
    for (const builtin of [true, false]) {
      const tools = toolsForRun(kind, { hasBuiltinTools: builtin, usesPermissionPromptTool: true }, null);
      const seen = new Set<string>();
      for (const t of tools) {
        expect(seen.has(t.name), `${kind}: ${t.name} listed twice`).toBe(false);
        seen.add(t.name);
        expect(t.description.length, `${t.name} needs a description`).toBeGreaterThan(20);
        expect(t.inputSchema.type, t.name).toBe("object");
        for (const required of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties ?? {}), `${t.name} requires ${required}`).toContain(required);
      }
    }
  }
});

test("only a work-like run can submit, only a review run can decide, and only a complete run can record a pull request", () => {
  const has = (kind: RunKind, tool: string) => names(kind).includes(tool);
  for (const kind of ["work", "conductor", "chat"] as const) expect(has(kind, "submit_for_review")).toBe(true);
  for (const kind of ["plan", "review", "complete", "triage"] as const) expect(has(kind, "submit_for_review")).toBe(false);
  expect(RUN_KINDS.filter((k) => has(k, "review_decision"))).toEqual(["review"]);
  expect(RUN_KINDS.filter((k) => has(k, "record_pull_request"))).toEqual(["complete"]);
  expect(RUN_KINDS.filter((k) => has(k, "dispatch_ticket")).sort()).toEqual(["triage"]);
});

test("a plan run can't write other tickets or the board; a work run can", () => {
  expect(names("plan")).not.toContain("create_ticket");
  expect(names("plan")).not.toContain("move_ticket");
  expect(names("work")).toContain("create_ticket");
  expect(names("work")).toContain("move_ticket");
});

test("every run reads the board and a spec-writing run has the spec tools", () => {
  for (const kind of ["plan", "work", "review", "complete", "conductor", "triage", "chat"] as const) expect(names(kind)).toContain("list_tickets");
  for (const kind of ["plan", "work", "complete", "conductor", "chat"] as const) expect(names(kind)).toEqual(expect.arrayContaining(["read_spec", "edit_spec", "update_spec"]));
  expect(names("review")).toContain("edit_spec");
  expect(names("review")).not.toContain("update_spec");
});

test("a chat gets its ticket's work tools, a conductor ticket's chat gets the conductor's", () => {
  expect(names("chat", undefined, { kind: "task" })).toEqual(names("work"));
  expect(names("chat", undefined, { kind: "conductor" })).toEqual(names("conductor"));
});

test("the permission prompt tool is added only for drivers that ask through it", () => {
  for (const kind of ["work", "review", "plan", "triage"] as const) {
    expect(names(kind, { hasBuiltinTools: true, usesPermissionPromptTool: true })).toContain("permission_prompt");
    expect(names(kind)).not.toContain("permission_prompt");
  }
});

test("a driver with no built-in tools gets native file and shell tools, read-only ones for plan, review and conductor, none for triage", () => {
  const driver = { hasBuiltinTools: false, usesPermissionPromptTool: false };
  expect(names("work", driver)).toEqual(expect.arrayContaining(["bash", "read_file", "write_file", "edit_file", "list_files"]));
  expect(names("complete", driver)).toContain("write_file");
  for (const kind of ["plan", "review", "conductor"] as const) {
    expect(names(kind, driver)).toContain("read_file");
    expect(names(kind, driver)).not.toContain("write_file");
    expect(names(kind, driver)).not.toContain("edit_file");
  }
  expect(names("triage", driver)).not.toContain("bash");
  expect(names("work")).not.toContain("bash");
});

test("a chief of staff reads and changes the board and keeps notes, with no sub-agent, spec, lifecycle, config-write, file or shell tool", () => {
  for (const driver of [{ hasBuiltinTools: true, usesPermissionPromptTool: false }, { hasBuiltinTools: false, usesPermissionPromptTool: false }]) {
    const tools = names("cos", driver);
    expect(tools).toEqual(expect.arrayContaining(["list_tickets", "get_ticket", "search_tickets", "list_projects", "create_ticket", "update_ticket", "move_ticket", "start_ticket", "message_ticket", "cancel_ticket", "reopen_ticket", "post_note", "read_memory", "update_memory_section", "query_activity", "schedule_create", "schedule_list", "schedule_cancel"]));
    expect(tools.filter((t) => ["Agent", "Task", "bash", "read_file", "write_file", "edit_file", "list_files"].includes(t))).toEqual([]);
    for (const absent of ["read_spec", "edit_spec", "update_spec", "block", "unblock", "submit_for_review", "resume_work", "return_to_planning", "update_branch", "review_ticket", "complete_ticket", "dispatch_ticket", "update_settings", "create_project", "create_watcher", "delete_ticket", "browser_open"]) {
      expect(tools, absent).not.toContain(absent);
    }
  }
  expect(names("cos", { hasBuiltinTools: true, usesPermissionPromptTool: true })).toContain("permission_prompt");
});

test("a chief of staff's ticket gets the chief's tools in a chat run too, whatever the driver", () => {
  const chief = { kind: "cos" } as const;
  for (const driver of [{ hasBuiltinTools: true, usesPermissionPromptTool: false }, { hasBuiltinTools: false, usesPermissionPromptTool: false }]) {
    expect(names("chat", driver, chief)).toEqual(names("cos", driver));
    for (const absent of ["bash", "edit_spec", "update_settings", "submit_for_review"]) expect(names("chat", driver, chief)).not.toContain(absent);
  }
});

test("only a chief of staff gets the memory and activity tools, and it has no update_notes to overwrite its memory with", () => {
  for (const kind of RUN_KINDS) {
    for (const t of ["read_memory", "update_memory_section", "query_activity"]) expect(names(kind).includes(t), `${kind}: ${t}`).toBe(kind === "cos");
  }
  expect(names("cos")).not.toContain("update_notes");
});

test("only a chief of staff gets the schedule tools", () => {
  for (const kind of RUN_KINDS) {
    for (const t of ["schedule_create", "schedule_list", "schedule_cancel"]) {
      expect(names(kind).includes(t), `${kind}: ${t}`).toBe(kind === "cos");
    }
  }
  expect(names("chat", { hasBuiltinTools: true, usesPermissionPromptTool: false }, { kind: "task" })).not.toContain("schedule_create");
});

test("only a chief of staff gets the terminal tools", () => {
  for (const kind of RUN_KINDS) {
    for (const t of ["list_terminals", "read_terminal", "write_terminal"]) expect(names(kind).includes(t), `${kind}: ${t}`).toBe(kind === "cos");
  }
  expect(names("chat", { hasBuiltinTools: true, usesPermissionPromptTool: false }, { kind: "task" })).not.toContain("write_terminal");
});

test("an unknown run kind still throws", () => {
  expect(() => toolsForRun("nope" as RunKind, { hasBuiltinTools: true, usesPermissionPromptTool: false })).toThrow(/Unknown run kind/);
});
