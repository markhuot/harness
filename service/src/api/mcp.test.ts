import { describe, expect, test } from "bun:test";
import { fakeContext, fakeOps } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
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
  test("tools/list exposes the run's tools with schemas and read-only hints for harness tools", async () => {
    const r = await rpc("tools/list");
    const tools = r.result.tools as any[];
    expect(tools.map((t) => t.name)).toEqual(run.tools.map((t) => t.name));
    const submit = tools.find((t) => t.name === "submit_for_review");
    expect(submit.inputSchema.required).toEqual(["note", "spec_is_up_to_date"]);
    expect(submit.annotations.readOnlyHint).toBe(true);
    // must stay callable under --permission-mode plan
    expect(tools.find((t) => t.name === "permission_prompt").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "writer").annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
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
