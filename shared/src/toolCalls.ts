// The harness MCP server runs most of its tools through one dispatcher, `call_tool { name, input }`
// (DESIGN.md "Tools"). Everything that shows or judges a tool call looks through it with this
// helper, so a call made that way reads and is judged exactly like the inner tool called directly.

/** The dispatcher tool's name (service/src/tools/dispatch.ts CALL_TOOL). */
export const CALL_TOOL_NAME = "call_tool";

const CALL_TOOL_RE = /^(mcp__[^_]+__)?call_tool$/;

/**
 * call_tool { name, input } → the inner tool's name and input; any other call as it is. The
 * client's MCP prefix is kept (mcp__harness__call_tool → mcp__harness__browser_open). Input is
 * read the way call_tool reads it: missing or null is {}, and a string holding JSON is parsed.
 * A call_tool call without a usable name is left as it is.
 */
export function unwrapToolCall(name: string, input: unknown): { name: string; input: unknown } {
  const m = CALL_TOOL_RE.exec(name);
  if (!m || !input || typeof input !== "object" || Array.isArray(input)) return { name, input };
  const o = input as Record<string, unknown>;
  const inner = typeof o.name === "string" ? o.name.trim() : "";
  if (!inner) return { name, input };
  let innerInput: unknown = o.input ?? {};
  if (typeof innerInput === "string") {
    try {
      innerInput = innerInput.trim() ? JSON.parse(innerInput) : {};
    } catch {
      // Shown as the string it is; call_tool rejects it.
    }
  }
  return { name: `${m[1] ?? ""}${inner}`, input: innerInput };
}

/** The name a call is shown and judged by: call_tool's inner tool, else the name itself. */
export function toolCallName(name: string, input: unknown): string {
  return unwrapToolCall(name, input).name;
}
