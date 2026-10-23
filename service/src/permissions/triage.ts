// What a triage run may do (DESIGN.md "Events"). Triage reads outside text an attacker can write, so
// it is read-only: Bash only for commands isTriageCommand accepts, and the user's MCP servers only
// for tools whose names say they read. The CLI asks the harness (the permission prompt tool) about
// everything it doesn't allow itself, and this module answers.

import { isTriageCommand } from "./bash";

export type TriageDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** MCP tool names (after the server's prefix) that read: get-issue, listComments, search_issues, find-users... */
export const READ_TOOL_NAME = /^(get|list|search|find|read)([-_A-Z0-9]|$)/;
/** A verb after the read prefix that says the tool also writes or runs something: get_or_create, find-and-replace, search_and_run. */
const WRITING_VERB = /(^|[-_])(or|and|create|add|set|update|delete|remove|run|exec|execute|send|post|write|edit|transition|assign|move)([-_]|$)|(And|Or|Create|Update|Delete|Remove|Run|Exec|Send|Write)([A-Z]|$)/;

/** The tool's own name from `mcp__<server>__<tool>` ("get-issue"); null for anything that isn't an MCP tool. */
export function mcpToolName(name: string): string | null {
  const m = /^mcp__(?:.+?)__(.+)$/.exec(name);
  return m ? m[1]! : null;
}

export function triageDecision(tool: string, input: unknown): TriageDecision {
  if (tool === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    if (isTriageCommand(command)) return { behavior: "allow" };
    return { behavior: "deny", message: "Triage is read-only: only gh reads (pr view, pr diff, pr checks, issue view, api GETs, api graphql queries) piped through jq, grep, head, tail, wc, sort, cut, tr or uniq run here. Don't retry this one; escalate if you can't tell without it." };
  }
  const mcp = mcpToolName(tool);
  if (mcp !== null) {
    if (READ_TOOL_NAME.test(mcp) && !WRITING_VERB.test(mcp)) return { behavior: "allow" };
    return { behavior: "deny", message: `${tool} isn't a read tool, and triage is read-only. Don't retry it; escalate if you can't tell without it.` };
  }
  return { behavior: "deny", message: `${tool} isn't available in triage. Use the board tools, read-only gh and the read tools of the MCP servers; escalate if you can't tell.` };
}
