// The dispatcher view of a run's tools (DESIGN.md "Tools"): the core tools go to the model with
// their full schemas; everything else in the run's allowed set is found with tool_search and run
// with call_tool. The view is fixed for the whole run, so the prompt cache holds.

import { allTools } from "./index";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { errorResult, textResult, ToolInputError, validateInput } from "./util";

/** Harness tools advertised directly (when the run kind has them). Native tools are always direct. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "post_note",
  "read_spec",
  "edit_spec",
  "update_spec",
  "submit_for_review",
  "block",
  "unblock",
  "resume_work",
  "review_decision",
  "record_pull_request",
  "permission_prompt",
  // Triage's terminal calls, the way submit_for_review is a work run's: every triage makes one.
  "dispatch_ticket",
  "decline_work",
]);

export const TOOL_SEARCH = "tool_search";
export const CALL_TOOL = "call_tool";
/** Most tools one tool_search returns with their schemas; the rest are named. */
export const TOOL_SEARCH_MAX_RESULTS = 8;

export function isCoreTool(t: ToolDefinition): boolean {
  return t.group === "native" || CORE_TOOL_NAMES.has(t.name);
}

const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "and", "or", "for", "in", "on", "with", "tool", "tools", "how", "do", "i", "is", "it", "my", "me"]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

/**
 * Rank tools for a query: an exact tool name wins outright, then each query word scores where it
 * appears (a whole word of the name, part of the name, a word of the description). Tools that
 * match no word are dropped.
 */
export function rankTools(tools: ToolDefinition[], query: string): ToolDefinition[] {
  const raw = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const terms = [...new Set(words(query).filter((w) => !STOP_WORDS.has(w)))];
  const scored = tools.map((t, index) => {
    let score = 0;
    if (raw.includes(t.name)) score += 1000;
    const nameWords = words(t.name);
    const descWords = words(t.description);
    for (const term of terms) {
      if (nameWords.includes(term)) score += 20;
      else if (t.name.includes(term)) score += 8;
      const hits = descWords.filter((w) => w === term).length;
      if (hits) score += Math.min(hits, 5) + 2;
    }
    return { t, score, index };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.t);
}

function describeTool(t: ToolDefinition): string {
  return `## ${t.name}\n${t.description}\nInput schema: ${JSON.stringify(t.inputSchema)}`;
}

function firstSentence(text: string): string {
  const line = text.split("\n")[0] ?? "";
  const m = line.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : line).slice(0, 160);
}

function toolSearchTool(searchable: ToolDefinition[]): ToolDefinition<{ query?: string }> {
  const names = searchable.map((t) => t.name).join(", ");
  return {
    name: TOOL_SEARCH,
    group: "harness",
    description: `Find the harness tools this run can use beyond the ones listed directly, and get their full description and JSON input schema, then run one with ${CALL_TOOL}. Search by exact name (several names separated by spaces work) or by words such as "browser", "watcher", "ticket" or "branch"; results are ranked over names and descriptions, at most ${TOOL_SEARCH_MAX_RESULTS} with schemas. Where the instructions name a tool you don't see directly, it's one of these. Tools available through ${CALL_TOOL} in this run: ${names || "none"}.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: 'Tool names or words to search for, e.g. "browser_open" or "create watcher". Empty lists every tool with a one-line summary.' } },
      required: ["query"],
    },
    async execute(input) {
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (!searchable.length) return textResult(`No tools are available through ${CALL_TOOL} in this run.`);
      if (!query) return textResult(`Tools available through ${CALL_TOOL} (search a name for its schema):\n${searchable.map((t) => `- ${t.name}: ${firstSentence(t.description)}`).join("\n")}`);
      const ranked = rankTools(searchable, query);
      if (!ranked.length) return textResult(`No tool matches "${query}". Tools available through ${CALL_TOOL}: ${names}.`);
      const shown = ranked.slice(0, TOOL_SEARCH_MAX_RESULTS);
      const rest = ranked.slice(TOOL_SEARCH_MAX_RESULTS);
      const more = rest.length ? `\n\n${rest.length} more matched, not shown: ${rest.map((t) => t.name).join(", ")}. Search one of those names, or narrow the query.` : "";
      return textResult(`${shown.map(describeTool).join("\n\n")}${more}\n\nRun one with ${CALL_TOOL} { name, input }.`);
    },
  };
}

/** call_tool runs any tool in the run's allowed set (core ones too) and nothing else. */
function callToolTool(allowed: ToolDefinition[]): ToolDefinition<{ name?: unknown; input?: unknown }> {
  const byName = new Map(allowed.map((t) => [t.name, t]));
  return {
    name: CALL_TOOL,
    group: "harness",
    description: `Run a harness tool found with ${TOOL_SEARCH}: pass its name and its input as an object matching its input schema. The result is that tool's own result. A tool the instructions name but that isn't listed directly is run this way; search for it first if you don't know its input schema.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: `The tool's name, e.g. "browser_open" (from ${TOOL_SEARCH}).` },
        input: { type: "object", description: "The tool's input, matching its input schema. Omit or {} for none." },
      },
      required: ["name"],
    },
    async execute(raw, ctx: ToolContext): Promise<ToolResult> {
      const name = typeof raw?.name === "string" ? raw.name.trim() : "";
      if (!name) return errorResult(`${CALL_TOOL} needs the tool's name. Find it with ${TOOL_SEARCH}.`);
      const tool = byName.get(name);
      if (!tool) {
        if (name === TOOL_SEARCH || name === CALL_TOOL) return errorResult(`${name} is called directly, not through ${CALL_TOOL}.`);
        if (allTools.some((t) => t.name === name)) return errorResult(`${name} isn't available in this run. Find the tools it has with ${TOOL_SEARCH}.`);
        return errorResult(`Unknown tool: ${name}. Find tools with ${TOOL_SEARCH}.`);
      }
      let input: unknown = raw?.input ?? {};
      // Some models send the input as a JSON string.
      if (typeof input === "string") {
        try {
          input = input.trim() ? JSON.parse(input) : {};
        } catch {
          return schemaError(tool, `Invalid input for ${name}: expected an object, got a string that isn't JSON.`);
        }
      }
      try {
        validateInput(name, tool.inputSchema, input, true);
      } catch (err) {
        if (err instanceof ToolInputError) return schemaError(tool, err.message);
        throw err;
      }
      return tool.execute(input, ctx);
    },
  };
}

function schemaError(tool: ToolDefinition, message: string): ToolResult {
  return errorResult(`${message}\n${tool.name} input schema: ${JSON.stringify(tool.inputSchema)}`);
}

const views = new WeakMap<ToolDefinition[], ToolDefinition[]>();

/**
 * The tools a run advertises: its core tools (in run order), then tool_search and call_tool over
 * the rest of `tools`. When nothing is left to search, the view is just `tools`. Cached per
 * `tools` array so every request of a run sees the same definitions.
 */
export function dispatcherTools(tools: ToolDefinition[]): ToolDefinition[] {
  const cached = views.get(tools);
  if (cached) return cached;
  const core = tools.filter(isCoreTool);
  const searchable = tools.filter((t) => !isCoreTool(t));
  const view = searchable.length ? [...core, toolSearchTool(searchable), callToolTool(tools)] : [...tools];
  views.set(tools, view);
  return view;
}
