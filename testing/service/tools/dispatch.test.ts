import { expect, test } from "bun:test";
import { advertisedDescription, advertisedTools, CORE_TOOL_NAMES, firstSentence, isCoreTool, rankTools, stripSchemaDescriptions, stubTool, TOOL_SEARCH, TOOL_SEARCH_MAX_RESULTS, toolStubVariant } from "../../../service/src/tools/dispatch";
import type { ToolContext, ToolDefinition } from "../../../service/src/tools/types";
import { defineTool, schema } from "../../../service/src/tools/util";

const tool = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = [], group: "harness" | "native" = "harness") =>
  defineTool<Record<string, unknown>>({ name, description, group, inputSchema: schema(props, required), async run(input) { return JSON.stringify(input); } });

const ctx = {} as ToolContext;
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

test("core tools and native tools are advertised directly; anything else is stubbed", () => {
  expect(isCoreTool(tool("submit_for_review", ""))).toBe(true);
  expect(isCoreTool(tool("bash", "", {}, [], "native"))).toBe(true);
  expect(isCoreTool(tool("browser_open", ""))).toBe(false);
  expect(CORE_TOOL_NAMES.has("dispatch_ticket")).toBe(true);
});

test("firstSentence takes the first line's first sentence and cuts a long one at a word with an ellipsis", () => {
  expect(firstSentence("Does a thing. Then more.\nSecond line.")).toBe("Does a thing.");
  expect(firstSentence("No full stop here\nnext")).toBe("No full stop here");
  expect(firstSentence("one two three four five six seven", 15)).toBe("one two three…");
  expect(firstSentence("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
});

test("stripSchemaDescriptions drops description text but keeps names, types, enums and required", () => {
  const out = stripSchemaDescriptions({ type: "object", description: "top", required: ["a"], properties: { a: { type: "string", description: "A", enum: ["x"] }, description: { type: "string", description: "a property called description" } } });
  expect(out).toEqual({ type: "object", required: ["a"], properties: { a: { type: "string", enum: ["x"] }, description: { type: "string" } } });
});

test("tools are ranked by an exact name first, then by name words, name parts and description words; non-matches drop out", () => {
  const tools = [tool("browser_open", "Open a URL in the browser."), tool("create_watcher", "Create a watcher that runs a command."), tool("list_watchers", "List the watchers."), tool("get_settings", "Read the settings.")];
  expect(rankTools(tools, "create_watcher").map((t) => t.name)[0]).toBe("create_watcher");
  // Equal scores keep the run's own order.
  expect(rankTools(tools, "watchers").map((t) => t.name)).toEqual(["create_watcher", "list_watchers"]);
  expect(rankTools(tools, "settings read").map((t) => t.name)).toEqual(["get_settings"]);
  expect(rankTools(tools, "how do I open a url").map((t) => t.name)).toEqual(["browser_open"]);
  expect(rankTools(tools, "zzz")).toEqual([]);
});

test("the stub keeps the real name and shows a bare schema by default, but validates against the real one", async () => {
  const real = tool("create_thing", "Create a thing. Long explanation follows.", { name: { type: "string", description: "n" }, count: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, on: { type: "boolean" } }, ["name"]);
  const stub = stubTool(real, "bare");
  expect(stub).toMatchObject({ name: "create_thing", description: "", inputSchema: { type: "object" } });
  expect(text(await stub.execute({ name: "x", count: "3", tags: '["a","b"]', on: "true" }, ctx))).toBe('{"name":"x","count":3,"tags":["a","b"],"on":true}');
  expect(text(await stub.execute('{"name":"y"}', ctx))).toBe('{"name":"y"}');
});

test("a bad call to a stub comes back as the real description and schema, so the agent fixes it in one step", async () => {
  const stub = stubTool(tool("create_thing", "Create a thing.", { name: { type: "string" } }, ["name"]), "bare");
  const missing = await stub.execute({}, ctx);
  expect(missing.isError).toBe(true);
  expect(text(missing)).toContain('"name" is required');
  expect(text(missing)).toContain("## create_thing\nCreate a thing.\nInput schema:");
  expect(text(await stub.execute("{not json", ctx))).toContain("isn't JSON");
  expect(text(await stub.execute({ name: 5 }, ctx))).toContain('"name" must be a string');
});

test("the variants differ in what the stub shows: line keeps a short first sentence, schema keeps types without descriptions, none leaves the description out", () => {
  const real = tool("t", "Short first sentence. And a second.", { a: { type: "string", description: "A" } }, ["a"]);
  expect(stubTool(real, "line").description).toBe("Short first sentence.");
  expect(stubTool(real, "line").inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  expect(stubTool(real, "schema").description).toBe("");
  const none = stubTool(real, "none");
  expect(advertisedDescription(none)).toBeUndefined();
  expect(advertisedDescription(stubTool(real, "bare"))).toBe("");
  expect(advertisedDescription(real)).toBe(real.description);
});

test("toolStubVariant reads a known variant from the setting and falls back to bare", () => {
  expect(toolStubVariant("LINE")).toBe("line");
  expect(toolStubVariant(" full ")).toBe("full");
  expect(toolStubVariant("nonsense")).toBe("bare");
  expect(toolStubVariant(undefined)).toBe("bare");
});

const run: ToolDefinition[] = [tool("submit_for_review", "Submit."), tool("bash", "Run.", {}, [], "native"), tool("browser_open", "Open a page."), tool("create_watcher", "Create a watcher.")];

test("a run's view is its core tools, tool_search, then a stub per other tool, and is the same array every time", () => {
  const view = advertisedTools(run, "bare");
  expect(view.map((t) => t.name)).toEqual(["submit_for_review", "bash", TOOL_SEARCH, "browser_open", "create_watcher"]);
  expect(advertisedTools(run, "bare")).toBe(view);
  expect(advertisedTools(run, "full").map((t) => t.name)).toEqual(["submit_for_review", "bash", TOOL_SEARCH, "browser_open", "create_watcher"]);
  expect(advertisedTools(run, "full")[3]).toBe(run[2]!);
  const allCore = [run[0]!, run[1]!];
  expect(advertisedTools(allCore, "bare")).toEqual(allCore);
});

test("tool_search returns the full description and schema of matches, lists everything for an empty query, and says when nothing matches", async () => {
  const search = advertisedTools(run, "bare").find((t) => t.name === TOOL_SEARCH)!;
  const found = text(await search.execute({ query: "watcher" }, ctx));
  expect(found).toContain("## create_watcher\nCreate a watcher.\nInput schema:");
  expect(found).not.toContain("## browser_open");
  expect(text(await search.execute({ query: "" }, ctx))).toContain("- browser_open: Open a page.");
  expect(text(await search.execute({ query: "zzz" }, ctx))).toContain('No tool matches "zzz"');
});

test("a search with more matches than it shows names the rest", async () => {
  const many = [tool("submit_for_review", "x"), ...Array.from({ length: TOOL_SEARCH_MAX_RESULTS + 2 }, (_, i) => tool(`widget_${i}`, "A widget tool."))];
  const search = advertisedTools(many, "bare").find((t) => t.name === TOOL_SEARCH)!;
  const out = text(await search.execute({ query: "widget" }, ctx));
  expect(out).toContain("2 more matched, not shown: widget_8, widget_9");
});

test("a run with a single stubbed tool still gets tool_search for it", async () => {
  const search = advertisedTools([tool("submit_for_review", "x"), tool("other", "y")], "bare").find((t) => t.name === TOOL_SEARCH)!;
  expect(text(await search.execute({ query: "" }, ctx))).toContain("- other: y");
});
