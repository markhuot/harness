import { expect, test } from "bun:test";
import type { TranscriptEntry } from "../protocol";
import { inlineTokens, parseBlocks, plainText } from "./markdown";
import { describeApprovalInput, effectiveTab, fitRect, groupTranscript, normalizeUrl, parsePluginTab, pluginTabRoute, toPagePoint, toolPreview } from "./index";

test("fenced code keeps list- and heading-looking lines verbatim", () => {
  const blocks = parseBlocks("Intro\n```ts\n- not a list\n# not a heading\n```\n- real item");
  expect(blocks).toEqual([
    { t: "p", text: "Intro" },
    { t: "code", lang: "ts", text: "- not a list\n# not a heading" },
    { t: "ul", items: ["real item"] },
  ]);
});

test("switching between bullets and numbers starts a new list; blank lines split paragraphs", () => {
  const blocks = parseBlocks("- a\n- b\n1. one\n2. two\n\npara one\nstill one\n\npara two");
  expect(blocks.map((b) => b.t)).toEqual(["ul", "ol", "p", "p"]);
  expect(blocks[2]).toEqual({ t: "p", text: "para one\nstill one" });
});

test("an unterminated fence swallows the rest instead of dropping it", () => {
  expect(parseBlocks("```\nconst x = 1")).toEqual([{ t: "code", lang: "", text: "const x = 1" }]);
});

test("plainText strips markup for card snippets", () => {
  expect(plainText("**Done**: `bun test` passes.\n```\nnoise\n```\n- next: [ship](https://x.y)")).toBe("Done: bun test passes. • next: ship");
});

const e = (id: string, seq: number, content: TranscriptEntry["content"]): TranscriptEntry => ({
  id,
  sessionId: "s",
  runId: "r",
  seq,
  role: content.type === "text" ? "assistant" : "tool",
  content,
  createdAt: seq,
});

test("tool results attach to their call by callId, even out of order", () => {
  const items = groupTranscript([
    e("1", 1, { type: "tool_call", callId: "a", name: "bash", input: { command: "ls" } }),
    e("2", 2, { type: "tool_call", callId: "b", name: "read_file", input: { path: "x" } }),
    e("3", 3, { type: "tool_result", callId: "b", name: "read_file", output: [], isError: false }),
    e("4", 4, { type: "text", text: "between" }),
    e("5", 5, { type: "tool_result", callId: "a", name: "bash", output: [{ type: "text", text: "ok" }], isError: true }),
  ]);
  expect(items.map((i) => (i.kind === "tool" ? `${i.call.id}+${i.result?.id ?? "-"}` : i.entry.id))).toEqual(["1+5", "2+3", "4"]);
});

test("a result whose call isn't loaded is kept as its own row", () => {
  const items = groupTranscript([e("9", 9, { type: "tool_result", callId: "zz", name: "bash", output: [], isError: false })]);
  expect(items).toHaveLength(1);
  expect(items[0]!.kind).toBe("entry");
});

test("toolPreview picks the meaningful field", () => {
  expect(toolPreview("bash", { command: "bun test\nmore" })).toBe("bun test");
  expect(toolPreview("browser_open", { url: "https://a" })).toBe("https://a");
  expect(toolPreview("x", {})).toBe("");
  expect(toolPreview("x", { n: 1 })).toBe('{"n":1}');
});


test("approval input: Bash shows the command as code, keeps description and extra fields apart", () => {
  const d = describeApprovalInput("Bash", { command: "npm i", description: "Install deps", timeout: 5 });
  expect(d.primary).toEqual({ label: "Command", value: "npm i", code: true });
  expect(d.description).toBe("Install deps");
  expect(d.rest).toEqual({ timeout: 5 });
});

test("approval input: Write/Edit show file_path, WebFetch shows the url as plain text", () => {
  expect(describeApprovalInput("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }).primary).toEqual({ label: "File", value: "/a.ts", code: true });
  expect(describeApprovalInput("WebFetch", { url: "https://x.y", prompt: "p" })).toMatchObject({ primary: { label: "URL", value: "https://x.y", code: false }, rest: { prompt: "p" } });
});

test("approval input: config tools show the watcher command line and what they act on", () => {
  // a shell command line (no args) is shown as typed, not quoted as one word
  expect(describeApprovalInput("create_watcher", { name: "status", command: "while true; do curl -s https://x.test; sleep 60; done", prompt: "Dispatch outages." })).toEqual({
    primary: { label: "Command", value: "while true; do curl -s https://x.test; sleep 60; done", code: true },
    description: null,
    rest: { name: "status", prompt: "Dispatch outages." },
  });
  // a login shell running one line shows the line itself
  expect(describeApprovalInput("create_watcher", { command: "/bin/zsh", args: ["-lc", "while true; do curl -s 'https://x.test'; sleep 60; done"] }).primary).toEqual({
    label: "Command",
    value: "while true; do curl -s 'https://x.test'; sleep 60; done",
    code: true,
  });
  // other command + args are quoted as the argv they are
  expect(describeApprovalInput("create_watcher", { name: "jira", command: "/usr/local/bin/watch-jira", args: ["--project=FOO", "--jql=status = Done"], mode: "loop" })).toEqual({
    primary: { label: "Command", value: "/usr/local/bin/watch-jira --project=FOO '--jql=status = Done'", code: true },
    description: null,
    rest: { name: "jira", mode: "loop" },
  });
  // an args-only update still shows what will run
  expect(describeApprovalInput("mcp__harness__update_watcher", { watcher: "jira", args: ["it's"] })).toMatchObject({
    primary: { value: "'(unchanged command)' 'it'\\''s'" },
    rest: { watcher: "jira" },
  });
  expect(describeApprovalInput("update_watcher", { watcher: "jira", enabled: false }).primary).toEqual({ label: "Watcher", value: "jira", code: false });
  expect(describeApprovalInput("delete_ticket", { key: "ACME-3" }).primary).toEqual({ label: "Ticket", value: "ACME-3", code: false });
  expect(describeApprovalInput("update_project", { project_key: "ACME", auto_complete: true })).toMatchObject({
    primary: { label: "Project", value: "ACME" },
    rest: { auto_complete: true },
  });
});

test("approval input: unknown tools fall back to JSON, non-objects are shown raw", () => {
  expect(describeApprovalInput("mcp__x__thing", { a: 1 })).toEqual({ primary: null, description: null, rest: { a: 1 } });
  expect(describeApprovalInput("Odd", "raw")).toMatchObject({ primary: { label: "Input", value: '"raw"' } });
  expect(describeApprovalInput("Odd", null).primary).toBeNull();
});

test("inline tokens: code, bold, italic, http links; non-http link targets keep only the label", () => {
  expect(inlineTokens("run `bun test` **now** _please_ [docs](https://x.y) or https://a.b/c and [x](javascript:void)")).toEqual([
    { t: "text", text: "run " },
    { t: "code", text: "bun test" },
    { t: "text", text: " " },
    { t: "strong", text: "now" },
    { t: "text", text: " " },
    { t: "em", text: "please" },
    { t: "text", text: " " },
    { t: "link", text: "docs", url: "https://x.y" },
    { t: "text", text: " or " },
    { t: "link", text: "https://a.b/c", url: "https://a.b/c" },
    { t: "text", text: " and " },
    { t: "text", text: "x" },
  ]);
});

test("tabs: plugin tab ids; the Tickets tab only on conductors; plugin tabs that don't apply fall back", () => {
  expect(parsePluginTab(pluginTabRoute("git", "changes"))).toEqual({ pluginId: "git", tabId: "changes" });
  expect(parsePluginTab("details")).toBeNull();
  expect(parsePluginTab("plugin:Git:changes")).toBeNull();
  const tabs = [{ pluginId: "git", id: "changes" }];
  expect(effectiveTab("children", { conductor: false, pluginTabs: tabs })).toBe("summaries");
  expect(effectiveTab("children", { conductor: true, pluginTabs: tabs })).toBe("children");
  expect(effectiveTab("plugin:git:changes", { conductor: false, pluginTabs: tabs })).toBe("plugin:git:changes");
  expect(effectiveTab("plugin:git:log", { conductor: false, pluginTabs: tabs })).toBe("summaries");
  // Tabs still loading: keep the plugin tab so the UI can show a spinner rather than flash Summaries.
  expect(effectiveTab("plugin:git:log", { conductor: false, pluginTabs: null })).toBe("plugin:git:log");
});

test("browser: URL normalization and letterboxed touch → page coordinates", () => {
  expect(normalizeUrl("  example.com/x ")).toBe("https://example.com/x");
  expect(normalizeUrl("http://a.b")).toBe("http://a.b");
  expect(normalizeUrl("about:blank")).toBe("about:blank");
  expect(normalizeUrl("   ")).toBe("");
  // A 1280×800 page in a 400×400 box: scaled to 400×250, centred vertically at y=75.
  const r = fitRect(400, 400, 1280, 800);
  expect(r).toEqual({ x: 0, y: 75, w: 400, h: 250 });
  expect(toPagePoint({ x: 200, y: 200 }, r, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
  expect(toPagePoint({ x: 0, y: 75 }, r, { width: 1280, height: 800 })).toEqual({ x: 0, y: 0 });
  expect(toPagePoint({ x: 400, y: 325 }, r, { width: 1280, height: 800 })).toEqual({ x: 1280, y: 800 });
  expect(toPagePoint({ x: 200, y: 74 }, r, { width: 1280, height: 800 })).toBeNull(); // in the letterbox bar
  expect(toPagePoint({ x: 200, y: 326 }, r, { width: 1280, height: 800 })).toBeNull();
  expect(toPagePoint({ x: 1, y: 1 }, fitRect(0, 0, 1, 1), { width: 1, height: 1 })).toBeNull();
});
