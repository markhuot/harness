import { describe, expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { fakeContext, fakeOps } from "./fakes";
import { advertisedDescription, advertisedTools, CORE_TOOL_NAMES, DEFAULT_TOOL_STUB_VARIANT, rankTools, stripSchemaDescriptions, type ToolStubVariant, toolStubVariant, toolsForRun } from "./index";
import type { ToolDefinition } from "./types";

const BROWSER = [
  "browser_open",
  "browser_tabs",
  "browser_resize",
  "browser_close_tab",
  "browser_content",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_keys",
  "browser_select",
  "browser_upload",
  "browser_eval",
  "browser_screenshot",
  "browser_wait",
  "browser_run",
  "browser_run_status",
  "browser_run_stop",
];
const NATIVE_FULL = ["bash", "read_file", "write_file", "edit_file", "list_files"];
const NATIVE_READ = ["read_file", "list_files", "bash"];
const BOARD = ["list_tickets", "get_ticket", "get_ticket_agent", "search_tickets", "list_projects", "list_inbox"];
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
  const harnessByKind: Record<Exclude<RunKind, "compact">, string[]> = {
    // update_ticket edits only the plan run's own ticket (the orchestrator checks).
    plan: ["post_note", ...SPEC, "update_notes", "update_ticket", ...BOARD, ...CONFIG_READ, ...BROWSER],
    work: ["post_note", ...SPEC, "update_notes", "block", "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    review: ["post_note", "read_spec", "edit_spec", "review_decision", ...BOARD, ...CONFIG_READ, ...BROWSER],
    complete: ["post_note", ...SPEC, "record_pull_request", ...BOARD, ...CONFIG_READ],
    conductor: ["post_note", ...SPEC, "update_notes", "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
    triage: [...BOARD, "dispatch_ticket", "decline_work", ...CONFIG_READ],
    // A chat (a message to a blocked, review or done task ticket) gets the work run's tools.
    chat: ["post_note", ...SPEC, "update_notes", "block", "unblock", "resume_work", "submit_for_review", "update_branch", ...BOARD, ...BOARD_WRITE, ...CONDUCTOR, ...CONFIG_READ, ...CONFIG_WRITE, ...BROWSER],
  };
  const nativeByKind: Record<Exclude<RunKind, "compact">, string[]> = {
    plan: NATIVE_READ,
    work: NATIVE_FULL,
    review: NATIVE_READ,
    complete: NATIVE_FULL,
    conductor: NATIVE_READ,
    triage: [],
    chat: NATIVE_FULL,
  };

  for (const kind of Object.keys(harnessByKind) as Exclude<RunKind, "compact">[]) {
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

describe("advertisedTools", () => {
  const kinds: RunKind[] = ["plan", "work", "review", "complete", "conductor", "triage", "chat"];
  const view = (kind: RunKind, driver: { hasBuiltinTools: boolean; usesPermissionPromptTool?: boolean }, variant: ToolStubVariant = "schema") =>
    advertisedTools(toolsForRun(kind, driver), variant);
  const isCore = (t: ToolDefinition) => t.group === "native" || CORE_TOOL_NAMES.has(t.name);

  test("each run kind advertises its core and native tools in full, tool_search, then every other tool as a stub", () => {
    for (const kind of kinds) {
      for (const driver of [builtin, bare, { hasBuiltinTools: true, usesPermissionPromptTool: true }]) {
        const all = toolsForRun(kind, driver);
        const shown = view(kind, driver);
        expect(shown.map((t) => t.name)).toEqual([...all.filter(isCore).map((t) => t.name), "tool_search", ...all.filter((t) => !isCore(t)).map((t) => t.name)]);
        for (const t of all.filter(isCore)) expect(shown.find((s) => s.name === t.name)).toBe(t);
        for (const t of all.filter((t) => !isCore(t))) {
          const stub = shown.find((s) => s.name === t.name)!;
          expect(stub).not.toBe(t);
          expect(stub.description).toBe("");
          expect(stub.group).toBe(t.group);
        }
        expect(shown.map((t) => t.name)).not.toContain("call_tool");
      }
    }
    expect(view("triage", builtin).map((t) => t.name)).toEqual(["dispatch_ticket", "decline_work", "tool_search", ...BOARD, ...CONFIG_READ]);
  });

  test("stub variants: line keeps a short first sentence, schema drops descriptions, bare and none drop the schema", () => {
    const real = toolsForRun("work", builtin).find((t) => t.name === "create_ticket")!;
    const of = (variant: ToolStubVariant) => view("work", builtin, variant).find((t) => t.name === "create_ticket")!;
    expect(of("full")).toBe(real);
    const line = of("line");
    expect(line.description.length).toBeLessThanOrEqual(80);
    expect(real.description.startsWith(line.description.replace(/…$/, ""))).toBe(true);
    const schema = of("schema").inputSchema as any;
    expect(Object.keys(schema.properties)).toEqual(Object.keys((real.inputSchema as any).properties));
    expect(schema.required).toEqual((real.inputSchema as any).required);
    expect(JSON.stringify(schema)).not.toContain('"description":"');
    expect(line.inputSchema).toEqual(schema);
    for (const v of ["bare", "none"] as const) expect(of(v).inputSchema as unknown).toEqual({ type: "object" });
    expect(advertisedDescription(of("bare"))).toBe("");
    expect(advertisedDescription(of("none"))).toBeUndefined();
    expect(advertisedDescription(real)).toBe(real.description);
  });

  test("stripSchemaDescriptions keeps a property named description", () => {
    const s = { type: "object", description: "x", properties: { description: { type: "string", description: "y" }, n: { type: "array", items: { type: "string", enum: ["a"], description: "z" } } }, required: ["description"] };
    expect(stripSchemaDescriptions(s)).toEqual({ type: "object", properties: { description: { type: "string" }, n: { type: "array", items: { type: "string", enum: ["a"] } } }, required: ["description"] });
  });

  test("HARNESS_TOOL_STUBS picks the variant; anything else is the default", () => {
    expect(toolStubVariant("bare")).toBe("bare");
    expect(toolStubVariant(" LINE ")).toBe("line");
    expect(toolStubVariant("nope")).toBe(DEFAULT_TOOL_STUB_VARIANT);
    expect(toolStubVariant(undefined)).toBe(DEFAULT_TOOL_STUB_VARIANT);
  });

  test("the view is the same objects for the same tools array, so it never changes mid-run", () => {
    const tools = toolsForRun("work", builtin);
    expect(advertisedTools(tools, "bare")).toBe(advertisedTools(tools, "bare"));
  });

  test("a run with nothing to stub gets its tools as they are", () => {
    const tools = toolsForRun("work", builtin).filter((t) => CORE_TOOL_NAMES.has(t.name));
    expect(advertisedTools(tools).map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  test("tool_search is a harness tool (advertised read-only)", () => {
    expect(view("review", builtin).find((t) => t.name === "tool_search")!.group).toBe("harness");
  });

  test("a stub validates against the real schema and answers a bad call with the full description and schema", async () => {
    const stub = view("work", builtin, "bare").find((t) => t.name === "browser_open")!;
    const real = toolsForRun("work", builtin).find((t) => t.name === "browser_open")!;
    const bad = await stub.execute({ url: 42 }, fakeContext());
    expect(bad.isError).toBe(true);
    const text = (bad.content[0] as { text: string }).text;
    expect(text).toContain('"url" must be a string');
    expect(text).toContain(real.description);
    expect(text).toContain(JSON.stringify(real.inputSchema));
    // Nested objects are checked too (the tool itself leaves them to its own code).
    const nested = await stub.execute({ url: "https://x.test", wait_for: { timeout: "soon" } }, fakeContext());
    expect((nested.content[0] as { text: string }).text).toContain('"wait_for.timeout" must be a number');
  });

  test("a stub coerces string-encoded booleans, numbers and arrays before validating (HARNESS-329, HARNESS-333)", async () => {
    const stub = view("work", builtin, "bare").find((t) => t.name === "create_ticket")!;
    const ok = await stub.execute({ title: "t", spec: "s", start: "true", depends_on: '["ABC-1","ABC-2"]' }, fakeContext());
    expect(ok.isError).not.toBe(true);
    const bad = await stub.execute({ title: "t", spec: "s", start: "soon" }, fakeContext());
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain('"start" must be a boolean');
  });

  test("a stub coerces a JSON-object string into a nested object before validating (HARNESS-329: RFACOM-8)", async () => {
    const stub = view("work", builtin, "bare").find((t) => t.name === "browser_open")!;
    const ok = await stub.execute({ url: "https://x.test", wait_for: '{"idle":true,"timeout":30}' }, fakeContext());
    expect(ok.isError).not.toBe(true);
    // A string that doesn't parse as an object is left alone, so validation still reports it clearly.
    const bad = await stub.execute({ url: "https://x.test", wait_for: "soon" }, fakeContext());
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain('"wait_for" must be a object');
  });

  test("a stubbed gated tool still asks a human", async () => {
    const ops = fakeOps({
      checkPermission: async () => ({ behavior: "deny", message: "no" }),
      requestApproval: async () => ({ behavior: "deny", message: "awaiting approval" }),
    });
    const ctx = fakeContext({ ops });
    const watcher = view("work", bare).find((t) => t.name === "create_watcher")!;
    expect((await watcher.execute({ name: "w", command: "echo hi" }, ctx)).isError).toBe(true);
    const judged = ops.calls.filter((c) => c.method === "requestApproval");
    expect(judged.map((c) => c.args[0])).toEqual(["create_watcher"]);
    expect(judged[0]!.args[2]).toMatchObject({ onceOnly: true });
  });

  test("tool_search returns the full description and schema of a stubbed tool", async () => {
    const search = view("work", builtin).find((t) => t.name === "tool_search")!;
    const real = toolsForRun("work", builtin).find((t) => t.name === "browser_open")!;
    const text = ((await search.execute({ query: "browser_open" }, fakeContext())).content[0] as { text: string }).text;
    expect(text).toStartWith("## browser_open\n");
    expect(text).toContain(real.description);
    expect(text).toContain(JSON.stringify(real.inputSchema));
    expect(text).not.toContain("call_tool");
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
