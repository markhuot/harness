import { describe, expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { fakeContext, fakeOps } from "../tools/fakes";
import { CORE_TOOL_NAMES, rankTools, TOOL_SEARCH_MAX_RESULTS, toolsForRun } from "../tools/index";
import type { ToolDefinition } from "../tools/types";
import { handleMcpRequest, MCP_LATEST_PROTOCOL_VERSION } from "./mcp";

const ops = fakeOps();
const throwing: ToolDefinition = {
  name: "explode",
  description: "always throws",
  group: "harness",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    throw new Error("kaboom");
  },
};
const writer: ToolDefinition = {
  name: "writer",
  description: "native tool with explicit annotations",
  group: "native",
  annotations: { destructiveHint: true },
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};
const run = { tools: [...toolsForRun("work", { hasBuiltinTools: true, usesPermissionPromptTool: true }), throwing, writer], ctx: fakeContext({ ops }) };

function post(body: unknown, r: typeof run | null = run) {
  return handleMcpRequest(
    new Request("http://x/mcp/tok", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    r,
  );
}
async function rpc(method: string, params?: unknown, id: number | string = 1) {
  const res = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as any;
}

describe("MCP transport", () => {
  test("GET and DELETE are 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcpRequest(new Request("http://x/mcp/tok", { method }), run);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("unknown run token → 404 with a JSON-RPC error", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
  });

  test("malformed JSON → 400 parse error", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });

  test("notifications get 202 with an empty body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("client responses (no method) are accepted with 202", async () => {
    const res = await post({ jsonrpc: "2.0", id: 9, result: {} });
    expect(res.status).toBe(202);
  });

  test("invalid request objects get -32600", async () => {
    expect((await (await post({ id: 1, method: "ping" })).json() as any).error.code).toBe(-32600);
    expect((await (await post({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" })).json() as any).error.code).toBe(-32600);
  });
});

describe("initialize", () => {
  test("echoes a supported protocol version", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo.name).toBe("harness");
  });

  test("falls back to the latest supported version for unknown or missing versions", async () => {
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect((await rpc("initialize")).result.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  test("ping returns an empty result; unknown methods are -32601", async () => {
    expect((await rpc("ping", undefined, "p")).result).toEqual({});
    const r = await rpc("sampling/createMessage");
    expect(r.error.code).toBe(-32601);
  });
});

describe("tools", () => {
  test("tools/list exposes the core tools in full, tool_search, and every other tool as a stub, with read-only hints for harness tools", async () => {
    const r = await rpc("tools/list");
    const tools = r.result.tools as any[];
    const core = ["post_note", "read_spec", "edit_spec", "update_spec", "block", "unblock", "resume_work", "submit_for_review", "permission_prompt", "writer"];
    const stubbed = run.tools.map((t) => t.name).filter((n) => !core.includes(n));
    expect(tools.map((t) => t.name)).toEqual([...core, "tool_search", ...stubbed]);
    const submit = tools.find((t) => t.name === "submit_for_review");
    expect(submit.inputSchema.required).toEqual(["note", "spec_is_up_to_date"]);
    expect(submit.annotations.readOnlyHint).toBe(true);
    // must stay callable under --permission-mode plan
    expect(tools.find((t) => t.name === "permission_prompt").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "tool_search").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "browser_open").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "writer").annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.map((t) => t.name)).not.toContain("call_tool");
  });

  test("tools/list is identical on every request of a run", async () => {
    expect((await rpc("tools/list")).result).toEqual((await rpc("tools/list")).result);
  });

  test("tools/call runs the tool against the run context", async () => {
    const r = await rpc("tools/call", { name: "post_note", arguments: { note: "progress" } });
    expect(r.result).toEqual({ content: [{ type: "text", text: "Note added to Activity." }], isError: false });
    expect(ops.calls.at(-1)).toEqual({ method: "postNote", args: ["progress"] });
  });

  test("validation failures and thrown errors come back in-band as isError", async () => {
    const invalid = await rpc("tools/call", { name: "post_note", arguments: {} });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0].text).toContain('"note" is required');
    const boom = await rpc("tools/call", { name: "explode", arguments: {} });
    expect(boom.result).toEqual({ content: [{ type: "text", text: "kaboom" }], isError: true });
  });

  test("image results map to MCP image content", async () => {
    const r = await rpc("tools/call", { name: "browser_screenshot", arguments: {} });
    expect(r.result.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  });

  test("unknown tools, a missing name and non-object arguments are -32602", async () => {
    expect((await rpc("tools/call", { name: "write_file", arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "post_note", arguments: [1] })).error.code).toBe(-32602);
  });

  test("omitted arguments are treated as {}", async () => {
    const r = await rpc("tools/call", { name: "browser_screenshot" });
    expect(r.result.isError).toBe(false);
  });
});

const claudeCode = { hasBuiltinTools: true, usesPermissionPromptTool: true };
const listFor = async (kind: RunKind, tools = toolsForRun(kind, claudeCode)) => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { tools, ctx: fakeContext({ ops: fakeOps() }) });
  return ((await res.json()) as any).result.tools as any[];
};
const callTool = (name: string, input?: unknown, r: typeof run = run) =>
  post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, ...(input === undefined ? {} : { arguments: input }) } }, r).then(async (res) => {
    const body = (await res.json()) as any;
    return (body.result ?? body) as { content: any[]; isError: boolean; error?: { code: number; message: string } };
  });
const searchTools = async (query: string) => (await rpc("tools/call", { name: "tool_search", arguments: { query } })).result.content[0].text as string;

describe("stubs and tool_search", () => {
  test("tools/list for each run kind: core tools in full, tool_search, every other tool in the run as a stub", async () => {
    const SPEC = ["read_spec", "edit_spec", "update_spec"];
    const core: Record<RunKind, string[]> = {
      plan: ["post_note", ...SPEC, "permission_prompt"],
      work: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "permission_prompt"],
      review: ["post_note", "read_spec", "edit_spec", "review_decision", "permission_prompt"],
      complete: ["post_note", ...SPEC, "record_pull_request", "permission_prompt"],
      conductor: ["post_note", ...SPEC, "unblock", "resume_work", "submit_for_review", "permission_prompt"],
      triage: ["dispatch_ticket", "decline_work", "permission_prompt"],
      chat: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "permission_prompt"],
    };
    for (const kind of Object.keys(core) as RunKind[]) {
      const allowed = toolsForRun(kind, claudeCode);
      const listed = await listFor(kind, allowed);
      const rest = allowed.filter((t) => !core[kind].includes(t.name));
      expect(listed.map((t) => t.name)).toEqual([...core[kind], "tool_search", ...rest.map((t) => t.name)]);
      for (const name of core[kind]) {
        const real = allowed.find((t) => t.name === name)!;
        expect(listed.find((t) => t.name === name)).toMatchObject({ description: real.description, inputSchema: real.inputSchema });
      }
      for (const real of rest) {
        const stub = listed.find((t) => t.name === real.name);
        expect(stub.description).toBe("");
        expect(JSON.stringify(stub.inputSchema).length).toBeLessThan(JSON.stringify(real.inputSchema).length + 1);
        expect(JSON.stringify(stub.inputSchema)).not.toContain('"description":"');
      }
      expect(listed.map((t) => t.name)).not.toContain("call_tool");
    }
  });

  test("HARNESS_TOOL_STUBS switches the stub shape; none leaves the description field out", async () => {
    const before = process.env.HARNESS_TOOL_STUBS;
    try {
      process.env.HARNESS_TOOL_STUBS = "none";
      const none = (await listFor("work")).find((t) => t.name === "browser_open");
      expect(none).not.toHaveProperty("description");
      expect(none.inputSchema).toEqual({ type: "object" });
      process.env.HARNESS_TOOL_STUBS = "line";
      const line = (await listFor("work")).find((t) => t.name === "browser_open");
      expect(line.description.length).toBeGreaterThan(0);
      expect(line.description.length).toBeLessThanOrEqual(80);
      process.env.HARNESS_TOOL_STUBS = "full";
      const full = (await listFor("work")).find((t) => t.name === "browser_open");
      expect(full.description).toBe(toolsForRun("work", claudeCode).find((t) => t.name === "browser_open")!.description);
    } finally {
      if (before === undefined) delete process.env.HARNESS_TOOL_STUBS;
      else process.env.HARNESS_TOOL_STUBS = before;
    }
  });

  test("tool_search's description says how to use it and doesn't repeat the tool names", async () => {
    const search = (await listFor("review")).find((t: any) => t.name === "tool_search");
    expect(search.description).toContain("listed by name only");
    expect(search.description).not.toContain("browser_open");
    expect(search.description).not.toContain("call_tool");
  });

  test("tool_search by exact name returns that tool first with its description and schema", async () => {
    const text = await searchTools("browser_open");
    expect(text.startsWith("## browser_open\n")).toBe(true);
    expect(text).toContain(`Input schema: ${JSON.stringify(toolsForRun("work", claudeCode).find((t) => t.name === "browser_open")!.inputSchema)}`);
    const two = await searchTools("get_ticket update_branch");
    expect(two.match(/^## \w+/gm)!.slice(0, 2).sort()).toEqual(["## get_ticket", "## update_branch"]);
  });

  test("tool_search by keyword ranks name matches first and caps the results", async () => {
    const watcher = await searchTools("watcher");
    const names = watcher.match(/^## (\w+)/gm)!.map((h) => h.slice(3));
    expect(names.slice(0, 5).sort()).toEqual(["create_watcher", "delete_watcher", "list_watchers", "run_watcher", "update_watcher"]);
    const browser = await searchTools("browser");
    const shown = browser.match(/^## (\w+)/gm)!.map((h) => h.slice(3));
    expect(shown).toHaveLength(TOOL_SEARCH_MAX_RESULTS);
    expect(shown.every((n) => n.startsWith("browser_"))).toBe(true);
    expect(browser).toMatch(/\d+ more matched, not shown: browser_\w+/);
    expect(browser).toContain("narrow the query");
  });

  test("tool_search with no match or an empty query lists what's available", async () => {
    expect(await searchTools("zzqx")).toContain('No tool matches "zzqx"');
    const all = await searchTools("");
    expect(all).toContain("- browser_open: ");
    expect(all).not.toContain("Input schema");
  });

  test("ranking is by name, then description", () => {
    const work = toolsForRun("work", claudeCode).filter((t) => !CORE_TOOL_NAMES.has(t.name));
    const ranked = rankTools(work, "move ticket").map((t) => t.name);
    expect(ranked[0]).toBe("move_ticket");
  });

  test("a stubbed tool called by its own name runs and passes its result through", async () => {
    const r = await callTool("browser_screenshot", {});
    expect(r).toEqual({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], isError: false });
    // Omitted arguments are {}.
    expect((await callTool("browser_screenshot")).isError).toBe(false);
    const listed = await callTool("list_tickets", {});
    expect(listed.isError).toBe(false);
    // A stubbed tool's thrown error comes back in-band, unchanged.
    expect(await callTool("explode", {})).toEqual({ content: [{ type: "text", text: "kaboom" }], isError: true });
  });

  test("tools outside the run's allowed set, and call_tool, are refused", async () => {
    expect((await callTool("nope_tool", {})).error!.code).toBe(-32602);
    // review_decision exists, but not in a work run.
    expect((await callTool("review_decision", { decision: "approve", notes: "x" })).error!.message).toContain("Unknown tool: review_decision");
    expect(ops.calls.some((c) => c.method === "reviewDecision")).toBe(false);
    // A review run can't reach config writes either.
    const review = { tools: toolsForRun("review", claudeCode), ctx: fakeContext({ ops }) };
    expect((await callTool("create_watcher", { name: "w", command: "true" }, review as typeof run)).error!.code).toBe(-32602);
    expect((await callTool("call_tool", { name: "post_note", input: { note: "x" } })).error!.code).toBe(-32602);
  });

  test("invalid input to a stubbed tool is refused before it runs, with its full description and schema", async () => {
    const before = ops.calls.length;
    const real = (name: string) => toolsForRun("work", claudeCode).find((t) => t.name === name)!;
    const missing = await callTool("get_ticket", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"key" is required');
    expect(missing.content[0].text).toContain(real("get_ticket").description);
    expect(missing.content[0].text).toContain(`Input schema: ${JSON.stringify(real("get_ticket").inputSchema)}`);
    const nested = await callTool("browser_click", { selector: "#a", wait_for: { bogus: 1 } });
    expect(nested.content[0].text).toContain('"wait_for.bogus" is not a known property');
    expect(nested.content[0].text).toContain("## browser_click");
    const wrongType = await callTool("create_ticket", { title: "t", spec: "s", depends_on: [1] });
    expect(wrongType.content[0].text).toContain('"depends_on[0]" must be a string');
    expect(ops.calls.length).toBe(before);
  });

  test("a human-gated tool called directly still asks a human, and runs once allowed", async () => {
    const approvals: { tool: string; input: unknown }[] = [];
    let allow = false;
    const gatedOps = fakeOps({
      requestApproval: async (_ctx, tool, input) => {
        approvals.push({ tool, input });
        return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Waiting for a human to approve delete_ticket." };
      },
    });
    const gated = { tools: toolsForRun("work", claudeCode), ctx: fakeContext({ ops: gatedOps }) };
    const denied = await callTool("delete_ticket", { key: "T-9" }, gated as typeof run);
    expect(denied).toEqual({ content: [{ type: "text", text: "Waiting for a human to approve delete_ticket." }], isError: true });
    expect(approvals).toEqual([{ tool: "delete_ticket", input: { key: "T-9" } }]);
    expect(gatedOps.calls.filter((c) => c.method === "deleteTicket").map((c) => c.args.at(-1))).toEqual([true]); // only the dry-run check
    allow = true;
    const ran = await callTool("delete_ticket", { key: "T-9" }, gated as typeof run);
    expect(ran.isError).toBe(false);
    expect(gatedOps.calls.filter((c) => c.method === "deleteTicket")).toHaveLength(3);
    const watcher = await callTool("create_watcher", { name: "w", command: "echo hi" }, gated as typeof run);
    expect(watcher.isError).toBe(false);
    expect(approvals.at(-1)!.tool).toBe("create_watcher");
  });
});

describe("batches", () => {
  test("answers requests in order and drops notifications", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "post_note", arguments: { note: "x" } } },
      { jsonrpc: "2.0", id: "c", method: "nope" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(body[1].result.isError).toBe(false);
    expect(body[2].error.code).toBe(-32601);
  });

  test("a batch of only notifications is 202; an empty batch is invalid", async () => {
    expect((await post([{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202);
    const empty = await post([]);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as any).error.code).toBe(-32600);
  });
});
