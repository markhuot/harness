// permission_prompt: answers Claude Code's --permission-prompt-tool calls.
// The CLI (not the model) calls it whenever its permission mode doesn't auto-allow a tool.
//
// Verified against claude 2.1.283:
//   input  { tool_name: "Bash", input: { command, description }, tool_use_id: "toolu_..." }
//   output one text block whose text is JSON:
//          {"behavior":"allow","updatedInput":{...}}  → the tool runs with updatedInput
//          {"behavior":"deny","message":"..."}        → the model gets an is_error tool_result
//                                                       whose text is the message

import { defineTool, schema } from "./util";

type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

function answer(decision: Decision) {
  // Never isError: the CLI must always get a parseable decision.
  return { content: [{ type: "text" as const, text: JSON.stringify(decision) }] };
}

export const permissionPrompt = defineTool<{ tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string }>({
  name: "permission_prompt",
  description:
    "Internal: answers tool-permission prompts on behalf of the human. Called by the client itself, not by you; don't call it directly.",
  inputSchema: schema({
    tool_name: { type: "string", description: "Tool that needs permission, e.g. \"Bash\"." },
    input: { type: "object", description: "The input the tool would run with." },
    tool_use_id: { type: "string", description: "Id of the pending tool call." },
  }),
  async run({ tool_name, input }, ctx) {
    if (!tool_name) return answer({ behavior: "deny", message: "permission_prompt was called without a tool_name." });
    const toolInput = input ?? {};
    try {
      const decision = await ctx.ops.requestApproval(ctx, tool_name, toolInput, { viaPromptTool: true });
      if (decision.behavior === "allow") {
        const updated = decision.updatedInput;
        return answer({
          behavior: "allow",
          updatedInput: updated && typeof updated === "object" && !Array.isArray(updated) ? (updated as Record<string, unknown>) : toolInput,
        });
      }
      return answer({ behavior: "deny", message: decision.message });
    } catch (err) {
      return answer({ behavior: "deny", message: `Permission check failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
});
