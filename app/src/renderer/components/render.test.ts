import { expect, test } from "bun:test";
import type { TranscriptEntry } from "@harness/shared";
import { parseBlocks, plainText } from "./Markdown";
import { groupTranscript, toolPreview } from "../views/Transcript";

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

import { describeApprovalInput } from "../views/Approval";

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

test("approval input: unknown tools fall back to JSON, non-objects are shown raw", () => {
  expect(describeApprovalInput("mcp__x__thing", { a: 1 })).toEqual({ primary: null, description: null, rest: { a: 1 } });
  expect(describeApprovalInput("Odd", "raw")).toMatchObject({ primary: { label: "Input", value: '"raw"' } });
  expect(describeApprovalInput("Odd", null).primary).toBeNull();
});
