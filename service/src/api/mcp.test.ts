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
  test("tools/list exposes the core tools plus tool_search and call_tool, with read-only hints for harness tools", async () => {
    const r = await rpc("tools/list");
    const tools = r.result.tools as any[];
    expect(tools.map((t) => t.name)).toEqual([
      "post_note",
      "read_spec",
      "edit_spec",
      "update_spec",
      "block",
      "unblock",
      "resume_work",
      "submit_for_review",
      "permission_prompt",
      "writer",
      "tool_search",
      "call_tool",
    ]);
    const submit = tools.find((t) => t.name === "submit_for_review");
    expect(submit.inputSchema.required).toEqual(["note", "spec_is_up_to_date"]);
    expect(submit.annotations.readOnlyHint).toBe(true);
    // must stay callable under --permission-mode plan
    expect(tools.find((t) => t.name === "permission_prompt").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "tool_search").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "call_tool").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "writer").annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
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
const listFor = async (kind: RunKind) => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { tools: toolsForRun(kind, claudeCode), ctx: fakeContext({ ops: fakeOps() }) });
  return ((await res.json()) as any).result.tools.map((t: any) => t.name) as string[];
};
const callTool = (name: string, input?: unknown, r: typeof run = run) =>
  post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool", arguments: input === undefined ? { name } : { name, input } } }, r).then(
    async (res) => ((await res.json()) as any).result as { content: any[]; isError: boolean },
  );
const searchTools = async (query: string) => (await rpc("tools/call", { name: "tool_search", arguments: { query } })).result.content[0].text as string;

describe("dispatcher", () => {
  test("tools/list for each run kind is its core tools, then tool_search and call_tool", async () => {
    const dispatch = ["tool_search", "call_tool"];
    const SPEC = ["read_spec", "edit_spec", "update_spec"];
    const expected: Record<RunKind, string[]> = {
      plan: ["post_note", ...SPEC, "permission_prompt", ...dispatch],
      work: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "permission_prompt", ...dispatch],
      review: ["post_note", "read_spec", "edit_spec", "review_decision", "permission_prompt", ...dispatch],
      complete: ["post_note", ...SPEC, "record_pull_request", "permission_prompt", ...dispatch],
      conductor: ["post_note", ...SPEC, "unblock", "resume_work", "submit_for_review", "permission_prompt", ...dispatch],
      triage: ["dispatch_ticket", "decline_work", "permission_prompt", ...dispatch],
      chat: ["post_note", ...SPEC, "block", "unblock", "resume_work", "submit_for_review", "permission_prompt", ...dispatch],
    };
    for (const kind of Object.keys(expected) as RunKind[]) expect(await listFor(kind)).toEqual(expected[kind]);
    // Browser tools stay hidden, the common ones included.
    for (const hidden of ["browser_open", "browser_content", "browser_screenshot", "update_branch", "list_tickets", "create_watcher"]) {
      expect(await listFor("work")).not.toContain(hidden);
    }
  });

  test("tool_search's description names the run's hidden tools, and only those", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { tools: toolsForRun("review", claudeCode), ctx: fakeContext({ ops }) });
    const search = ((await res.json()) as any).result.tools.find((t: any) => t.name === "tool_search");
    expect(search.description).toContain("browser_open");
    expect(search.description).toContain("list_tickets");
    expect(search.description).not.toContain("create_watcher");
    expect(search.description).not.toContain("submit_for_review");
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

  test("call_tool runs a hidden tool and passes its result through", async () => {
    const r = await callTool("browser_screenshot", {});
    expect(r).toEqual({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], isError: false });
    const note = await callTool("post_note", { note: "via call_tool" });
    expect(note.isError).toBe(false);
    expect(ops.calls.at(-1)).toEqual({ method: "postNote", args: ["via call_tool"] });
    // Input sent as a JSON string is accepted; omitted input is {}.
    expect((await callTool("post_note", JSON.stringify({ note: "stringified" }))).isError).toBe(false);
    expect((await callTool("browser_screenshot")).isError).toBe(false);
    // An inner tool's thrown error comes back in-band, unchanged.
    expect(await callTool("explode", {})).toEqual({ content: [{ type: "text", text: "kaboom" }], isError: true });
  });

  test("call_tool refuses unknown tools and tools outside the run's allowed set", async () => {
    const unknown = await callTool("nope_tool", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("Unknown tool: nope_tool");
    // review_decision exists, but not in a work run.
    const outside = await callTool("review_decision", { decision: "approve", notes: "x" });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toContain("review_decision isn't available in this run");
    expect(ops.calls.some((c) => c.method === "reviewDecision")).toBe(false);
    // A review run can't reach config writes either.
    const review = { tools: toolsForRun("review", claudeCode), ctx: fakeContext({ ops }) };
    expect((await callTool("create_watcher", { name: "w", command: "true" }, review as typeof run)).content[0].text).toContain("isn't available in this run");
    expect((await callTool("call_tool", { name: "post_note" })).content[0].text).toContain("called directly");
  });

  test("invalid input is refused before the tool runs, with the tool's schema", async () => {
    const before = ops.calls.length;
    const missing = await callTool("post_note", {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('"note" is required');
    expect(missing.content[0].text).toContain(`post_note input schema: ${JSON.stringify(toolsForRun("work", claudeCode).find((t) => t.name === "post_note")!.inputSchema)}`);
    const nested = await callTool("browser_click", { selector: "#a", wait_for: { bogus: 1 } });
    expect(nested.content[0].text).toContain('"wait_for.bogus" is not a known property');
    expect(nested.content[0].text).toContain("browser_click input schema:");
    const wrongType = await callTool("edit_spec", { base_revision: 1, note: "n", edits: [{ start_line: "one" }] });
    expect(wrongType.content[0].text).toContain('"edits[0].start_line" must be an integer');
    const tooFew = await callTool("edit_spec", { base_revision: 1, note: "n", edits: [] });
    expect(tooFew.content[0].text).toContain('"edits" must have at least 1 item');
    expect((await callTool("post_note", "{not json")).content[0].text).toContain("post_note input schema:");
    expect(ops.calls.length).toBe(before);
  });

  test("a human-gated tool through call_tool still asks a human, and runs once allowed", async () => {
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
