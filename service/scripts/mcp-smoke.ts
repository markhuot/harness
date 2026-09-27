// One-off manual verification: expose a trivial echo tool through handleMcpRequest and have the
// real `claude` CLI call it. Not part of `bun test` (needs a logged-in claude + network).
//   bun service/scripts/mcp-smoke.ts [--raw out.ndjson] [--permission-mode plan] [--system "..."] [--prompt "..."]
// Harness-group tools are advertised with readOnlyHint (see api/mcp.ts), which is what lets
// them run under --permission-mode plan.
import { handleMcpRequest } from "../src/api/mcp";
import type { ToolContext, ToolDefinition } from "../src/tools/types";
import { cleanClaudeEnv, resolveClaudeBin } from "../src/drivers/claude-code";

const args = process.argv.slice(2);
const rawOut = args.includes("--raw") ? args[args.indexOf("--raw") + 1] : null;
const mode = args.includes("--permission-mode") ? args[args.indexOf("--permission-mode") + 1]! : "bypassPermissions";
const system = args.includes("--system") ? args[args.indexOf("--system") + 1]! : null;
const prompt = args.includes("--prompt") ? args[args.indexOf("--prompt") + 1]! : "Call the echo tool with text hi and report its output verbatim.";

const calls: unknown[] = [];
const echo: ToolDefinition<{ text: string }> = {
  name: "echo",
  description: "Echo text back, prefixed with ECHO:",
  group: "harness",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(input) {
    calls.push(input);
    return { content: [{ type: "text", text: `ECHO:${input.text}` }] };
  },
};
const run = { tools: [echo as ToolDefinition], ctx: {} as ToolContext };
const server = Bun.serve({ port: 0, fetch: (req) => handleMcpRequest(req, run) });
const url = `http://127.0.0.1:${server.port}/mcp/test`;
const mcpConfig = JSON.stringify({ mcpServers: { harness: { type: "http", url, headers: { "x-test": "1" }, ...(args.includes("--always-load") ? { alwaysLoad: true } : {}) } } });

const argv = [
  resolveClaudeBin(),
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--mcp-config", mcpConfig,
  "--allowedTools", "mcp__harness",
  "--permission-mode", mode,
  "--model", "haiku",
  ...(system ? ["--append-system-prompt", system] : []),
];
const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cleanClaudeEnv(process.env), cwd: process.cwd() });
proc.stdin.write(prompt);
proc.stdin.end();
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
await proc.exited;
if (rawOut) await Bun.write(rawOut, out);
const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const init = lines.find((l) => l.type === "system" && l.subtype === "init");
const result = lines.find((l) => l.type === "result");
console.log("mcp_servers:", JSON.stringify(init?.mcp_servers));
console.log("harness tools:", init?.tools?.filter((t: string) => t.startsWith("mcp__harness")));
console.log("tool_use sequence:", lines.filter((l) => l.type === "assistant").flatMap((l) => l.message.content).filter((b: any) => b.type === "tool_use").map((b: any) => b.name).join(" → "));
console.log("echo calls:", JSON.stringify(calls));
console.log("result:", result?.subtype, result?.is_error, JSON.stringify(result?.result));
if (err.trim()) console.log("stderr:", err.trim().slice(0, 2000));
server.stop(true);
const ok = calls.length > 0 && (system !== null || String(result?.result ?? "").includes("ECHO:hi"));
console.log(ok ? "OK: claude called the echo tool over MCP" : "FAIL");
process.exit(ok ? 0 : 1);
