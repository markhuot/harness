// The advertised view of a run's tools (DESIGN.md "Tools"): the core tools go to the model with
// their full descriptions and schemas; every other tool in the run's allowed set is a stub (its
// real name, a minimal description and schema), and tool_search returns the full ones. The view
// is fixed for the whole run, so the prompt cache holds.

import type { JsonSchema, ToolContext, ToolDefinition, ToolResult } from "./types";
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

/** The first sentence of a description's first line, cut at a word boundary to `max` characters. */
export function firstSentence(text: string, max = 160): string {
  const line = text.split("\n")[0] ?? "";
  const m = line.match(/^.*?[.!?](?=\s|$)/);
  const sentence = (m ? m[0] : line).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

function toolSearchTool(searchable: ToolDefinition[]): ToolDefinition<{ query?: string }> {
  return {
    name: TOOL_SEARCH,
    group: "harness",
    description: `Get the full description and JSON input schema of harness tools. Tools beyond the core ones are listed by name only, with a minimal schema: search a tool's name (several names separated by spaces work) or words such as "browser", "watcher", "ticket" or "branch" before calling it the first time, then call it by its own name. Results are ranked over names and descriptions, at most ${TOOL_SEARCH_MAX_RESULTS} with schemas.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: 'Tool names or words to search for, e.g. "browser_open" or "create watcher". Empty lists every tool with a one-line summary.' } },
      required: ["query"],
    },
    async execute(input) {
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (!searchable.length) return textResult("Every harness tool in this run is listed in full already.");
      if (!query) return textResult(`Tools listed by name only (search a name for its schema):\n${searchable.map((t) => `- ${t.name}: ${firstSentence(t.description)}`).join("\n")}`);
      const ranked = rankTools(searchable, query);
      if (!ranked.length) return textResult(`No tool matches "${query}". Tools listed by name only: ${searchable.map((t) => t.name).join(", ")}.`);
      const shown = ranked.slice(0, TOOL_SEARCH_MAX_RESULTS);
      const rest = ranked.slice(TOOL_SEARCH_MAX_RESULTS);
      const more = rest.length ? `\n\n${rest.length} more matched, not shown: ${rest.map((t) => t.name).join(", ")}. Search one of those names, or narrow the query.` : "";
      return textResult(`${shown.map(describeTool).join("\n\n")}${more}\n\nCall a tool by its own name with input matching its schema.`);
    },
  };
}

/**
 * How much of a non-core tool's description and schema its stub keeps (HARNESS_TOOL_STUBS):
 * - "full": everything (no stubs; tool_search is still added)
 * - "line": the description's first sentence (at most 80 characters), the schema without descriptions
 * - "schema": an empty description, the schema without descriptions
 * - "bare": an empty description, `{ "type": "object" }`
 * - "none": no description field at all, `{ "type": "object" }`
 */
export const TOOL_STUB_VARIANTS = ["full", "line", "schema", "bare", "none"] as const;
export type ToolStubVariant = (typeof TOOL_STUB_VARIANTS)[number];
export const DEFAULT_TOOL_STUB_VARIANT: ToolStubVariant = "schema";
const STUB_LINE_MAX = 80;

export function toolStubVariant(env: string | undefined = process.env.HARNESS_TOOL_STUBS): ToolStubVariant {
  const v = env?.trim().toLowerCase();
  return (TOOL_STUB_VARIANTS as readonly string[]).includes(v ?? "") ? (v as ToolStubVariant) : DEFAULT_TOOL_STUB_VARIANT;
}

/** A JSON schema with every `description` keyword removed; property names, types, enums and `required` stay. */
export function stripSchemaDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaDescriptions);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "description" && typeof value === "string") continue;
    if (key === "enum" || key === "const" || key === "default" || key === "examples" || key === "required") out[key] = value;
    else if ((key === "properties" || key === "$defs" || key === "definitions") && typeof value === "object" && value !== null) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripSchemaDescriptions(v)]));
    } else out[key] = stripSchemaDescriptions(value);
  }
  return out;
}

function schemaError(tool: ToolDefinition, message: string): ToolResult {
  return errorResult(`${message}\n\n## ${tool.name}\n${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`);
}

/** Stubs advertised with no description field at all (the "none" variant). */
const descriptionless = new WeakSet<ToolDefinition>();

/** The description to advertise for a tool, or undefined to leave the field out. */
export function advertisedDescription(t: ToolDefinition): string | undefined {
  return descriptionless.has(t) ? undefined : t.description;
}

/**
 * A tool's stub: its real name with a minimal description and schema. The client can't check
 * input against a loose schema, so every call is validated here against the real one (nested
 * objects included); a failure returns the tool's full description and schema, so the agent can
 * fix the call in one step.
 */
export function stubTool(tool: ToolDefinition, variant: Exclude<ToolStubVariant, "full">): ToolDefinition {
  const stripped = stripSchemaDescriptions(tool.inputSchema) as JsonSchema;
  const stub: ToolDefinition = {
    name: tool.name,
    group: tool.group,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    description: variant === "line" ? firstSentence(tool.description, STUB_LINE_MAX) : "",
    inputSchema: variant === "bare" || variant === "none" ? ({ type: "object" } as JsonSchema) : stripped,
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      let input: unknown = raw ?? {};
      // Some models send the input as a JSON string.
      if (typeof input === "string") {
        try {
          input = input.trim() ? JSON.parse(input) : {};
        } catch {
          return schemaError(tool, `Invalid input for ${tool.name}: expected an object, got a string that isn't JSON.`);
        }
      }
      try {
        validateInput(tool.name, tool.inputSchema, input, true);
      } catch (err) {
        if (err instanceof ToolInputError) return schemaError(tool, err.message);
        throw err;
      }
      return tool.execute(input, ctx);
    },
  };
  if (variant === "none") descriptionless.add(stub);
  return stub;
}

const views = new WeakMap<ToolDefinition[], Map<ToolStubVariant, ToolDefinition[]>>();

/**
 * The tools a run advertises: its core tools (in run order) with full schemas, tool_search, then
 * every other tool in `tools` as a stub (see stubTool). When nothing is left to stub, the view is
 * just `tools`. Cached per `tools` array (and variant) so every request of a run sees the same
 * definitions.
 */
export function advertisedTools(tools: ToolDefinition[], variant: ToolStubVariant = toolStubVariant()): ToolDefinition[] {
  let byVariant = views.get(tools);
  if (!byVariant) views.set(tools, (byVariant = new Map()));
  const cached = byVariant.get(variant);
  if (cached) return cached;
  const core = tools.filter(isCoreTool);
  const rest = tools.filter((t) => !isCoreTool(t));
  const view = !rest.length ? [...tools] : [...core, toolSearchTool(rest), ...(variant === "full" ? rest : rest.map((t) => stubTool(t, variant)))];
  byVariant.set(variant, view);
  return view;
}
