// Minimal MCP server (Streamable HTTP transport, JSON responses only) exposing a run's tools.
// Mounted at POST /mcp/:runToken; the caller resolves the token to the run (or null).

import type { ToolResultContent } from "@harness/shared";
import { advertisedDescription, advertisedTools } from "../tools/dispatch";
import type { ToolAnnotations, ToolContext, ToolDefinition, ToolResult } from "../tools/types";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** Server-defined: the run token doesn't map to an active run. */
export const MCP_UNKNOWN_RUN = -32001;

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export interface McpRun {
  tools: ToolDefinition[];
  ctx: ToolContext;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return data === undefined ? { jsonrpc: "2.0", id, error: { code, message } } : { jsonrpc: "2.0", id, error: { code, message, data } };
}

function isValidId(id: unknown): id is string | number {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

/** Map a harness ToolResult to the MCP CallToolResult shape. */
export function toMcpToolResult(result: ToolResult) {
  const content = result.content.map((c: ToolResultContent) =>
    c.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType } : { type: "text" as const, text: c.text },
  );
  return { content, isError: result.isError === true };
}

/**
 * Harness-group tools never touch the workspace (they change ticket state or drive the
 * session browser), so they are advertised as read-only. Claude Code refuses non-read-only
 * MCP tools in `--permission-mode plan` ("Cannot call mcp__harness__x while in plan mode"),
 * which would make update_plan unusable in plan runs.
 */
export function toolAnnotations(t: ToolDefinition): ToolAnnotations {
  return { readOnlyHint: t.group === "harness", ...t.annotations };
}

async function callTool(run: McpRun, id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== "string") return rpcError(id, JSONRPC_INVALID_PARAMS, "tools/call requires params.name");
  // The advertised view: core tools as they are, tool_search, and the stubs that validate input
  // against the real schema before running the tool. Nothing outside the run's allowed set runs.
  const tool = advertisedTools(run.tools).find((t) => t.name === p.name);
  if (!tool) return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${p.name}`);
  if (p.arguments !== undefined && (typeof p.arguments !== "object" || p.arguments === null || Array.isArray(p.arguments))) {
    return rpcError(id, JSONRPC_INVALID_PARAMS, "tools/call params.arguments must be an object");
  }
  let result: ToolResult;
  try {
    result = await tool.execute(p.arguments ?? {}, run.ctx);
  } catch (err) {
    // Tool execution failures are reported in-band so the model can react to them.
    result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
  return { jsonrpc: "2.0", id, result: toMcpToolResult(result) };
}

/** Handle one JSON-RPC message. Returns null for notifications and client responses (no reply). */
async function handleMessage(run: McpRun, msg: unknown): Promise<JsonRpcResponse | null> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid JSON-RPC message");
  }
  const m = msg as JsonRpcMessage;
  const hasId = "id" in m && m.id !== undefined;
  // A response from the client to a server request (we never send any) — accept and ignore.
  if (m.method === undefined && hasId && ("result" in m || "error" in m)) return null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcError(hasId && isValidId(m.id) ? m.id : null, JSONRPC_INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  if (!hasId) return null; // notification (notifications/initialized, notifications/cancelled, ...)
  if (!isValidId(m.id)) return rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid request id");
  const id = m.id;

  switch (m.method) {
    case "initialize": {
      const requested = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : MCP_LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "harness", version: "0.1.0" },
          instructions:
            "Harness tools for the current ticket run: report progress, change ticket state, and drive the session browser. Tools beyond the core ones are listed by name only: call tool_search with a tool's name or a keyword for its description and parameters before calling it the first time.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: advertisedTools(run.tools).map((t) => ({
            name: t.name,
            ...(advertisedDescription(t) === undefined ? {} : { description: t.description }),
            inputSchema: t.inputSchema,
            annotations: toolAnnotations(t),
          })),
        },
      };
    case "tools/call":
      return callTool(run, id, m.params);
    // Capabilities we don't advertise, answered with empty lists so probing clients don't error out.
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}

export async function handleMcpRequest(req: Request, run: McpRun | null): Promise<Response> {
  if (req.method !== "POST") {
    // No server-initiated SSE stream (GET) and no sessions to DELETE.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (!run) {
    return jsonResponse(rpcError(null, MCP_UNKNOWN_RUN, "Unknown or expired run token"), 404);
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return jsonResponse(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    if (body.length === 0) return jsonResponse(rpcError(null, JSONRPC_INVALID_REQUEST, "Empty batch"), 400);
    const responses = (await Promise.all(body.map((msg) => handleMessage(run, msg)))).filter((r): r is JsonRpcResponse => r !== null);
    return responses.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(responses);
  }

  const response = await handleMessage(run, body);
  return response === null ? new Response(null, { status: 202 }) : jsonResponse(response);
}
