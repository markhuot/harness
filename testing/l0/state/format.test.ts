import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "../../../shared/src/protocol";
import type { TranscriptItem } from "../../../shared/src/state/format";
import {
  approvalToast,
  decisionSource,
  describeApprovalInput,
  driverIcon,
  driverLabel,
  fitRect,
  formatDuration,
  formatMaybeJson,
  groupTranscript,
  newSessionPlaceholder,
  normalizeUrl,
  permissionModeLabel,
  permissionVerb,
  relativeTime,
  shortToolName,
  tildify,
  toPagePoint,
  toolElapsed,
  toolIcon,
  toolLabel,
  toolPreview,
} from "../../../shared/src/state/format";

const entry = (seq: number, content: TranscriptEntry["content"]): TranscriptEntry => ({
  id: `e${seq}`,
  sessionId: "s",
  runId: null,
  seq,
  role: "assistant",
  content,
  createdAt: seq,
});

describe("driverLabel / driverIcon", () => {
  test("known ids use the short names, an unlisted id falls back to the driver list then the id", () => {
    expect(driverLabel("claude-code")).toBe("Claude Code");
    expect(driverLabel("custom", [{ id: "custom", name: "Custom Driver" } as never])).toBe("Custom Driver");
    expect(driverLabel("custom", [])).toBe("custom");
    expect(driverLabel("custom")).toBe("custom");
  });
  test("icon per driver", () => {
    expect([driverIcon("dummy"), driverIcon("anthropic-api"), driverIcon("claude-code")]).toEqual(["bot", "key", "sparkle"]);
  });
});

describe("formatDuration", () => {
  test("seconds, minutes and hours boundaries", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(59_500)).toBe("1m 0s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
  test("negative spans clamp to zero", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("toolElapsed", () => {
  test("no call has no start time", () => {
    expect(toolElapsed(null, { createdAt: 5 }, 10)).toBeNull();
    expect(toolElapsed(undefined, null, 10)).toBeNull();
  });
  test("a finished call ends at its result, a running one at now", () => {
    expect(toolElapsed({ createdAt: 1000 }, { createdAt: 4000 }, 99_000)).toBe("3s");
    expect(toolElapsed({ createdAt: 1000 }, null, 11_000)).toBe("10s");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  test("never for a missing or zero timestamp", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime(0, now)).toBe("never");
  });
  test("each unit boundary", () => {
    expect(relativeTime(now - 9_000, now)).toBe("just now");
    expect(relativeTime(now - 10_000, now)).toBe("10s ago");
    expect(relativeTime(now - 59_000, now)).toBe("59s ago");
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe("1d ago");
    expect(relativeTime(now - 29 * 86_400_000, now)).toBe("29d ago");
  });
  test("30 days and older fall to a date, not '30d ago'", () => {
    expect(relativeTime(now - 30 * 86_400_000, now)).not.toMatch(/ago$/);
  });
});

test("tildify only rewrites a leading /Users/<name>", () => {
  expect(tildify("/Users/mark/Sites/x")).toBe("~/Sites/x");
  expect(tildify("/srv/Users/mark/x")).toBe("/srv/Users/mark/x");
  expect(tildify("/home/mark")).toBe("/home/mark");
});

test("newSessionPlaceholder differs for conductors", () => {
  expect(newSessionPlaceholder("conductor")).toContain("conductor");
  expect(newSessionPlaceholder("task")).not.toContain("conductor");
});

test("shortToolName strips the mcp prefix only", () => {
  expect(shortToolName("mcp__harness__post_note")).toBe("post_note");
  expect(shortToolName("Bash")).toBe("Bash");
});

describe("describeApprovalInput", () => {
  test("non-object input: null input has no primary, scalars and arrays show as JSON", () => {
    expect(describeApprovalInput("Bash", null).primary).toBeNull();
    expect(describeApprovalInput("Bash", undefined).primary).toBeNull();
    expect(describeApprovalInput("Bash", "ls").primary).toEqual({ label: "Input", value: '"ls"', code: true });
    expect(describeApprovalInput("Bash", [1]).primary?.label).toBe("Input");
    expect(describeApprovalInput("Bash", [1]).rest).toBeNull();
  });
  test("Bash picks the command, takes the description out, and leaves other keys in rest", () => {
    const r = describeApprovalInput("Bash", { command: "ls", description: "list", timeout: 5 });
    expect(r.primary).toEqual({ label: "Command", value: "ls", code: true });
    expect(r.description).toBe("list");
    expect(r.rest).toEqual({ timeout: 5 });
  });
  test("rest is null when everything was consumed, and the input isn't mutated", () => {
    const input = { command: "ls" };
    expect(describeApprovalInput("Bash", input).rest).toBeNull();
    expect(input).toEqual({ command: "ls" });
  });
  test("file tools show the file path, notebooks their notebook path", () => {
    expect(describeApprovalInput("Edit", { file_path: "/a/b" }).primary).toEqual({ label: "File", value: "/a/b", code: true });
    expect(describeApprovalInput("NotebookEdit", { notebook_path: "/n.ipynb" }).primary?.value).toBe("/n.ipynb");
  });
  test("write_terminal shows every keystroke with control bytes escaped, and keeps the rest (folder, program) in rest", () => {
    const r = describeApprovalInput("write_terminal", { id: "t1", data: "rm -rf build\r\u0003", process: "zsh", cwd: "/w" });
    expect(r.primary).toEqual({ label: "Keys", value: "rm -rf build\\r\\x03", code: true });
    expect(r.rest).toEqual({ id: "t1", process: "zsh", cwd: "/w" });
  });
  test("web tools prefer url over query, falling back to query", () => {
    expect(describeApprovalInput("WebFetch", { url: "https://x", query: "q" }).primary).toEqual({ label: "URL", value: "https://x", code: false });
    expect(describeApprovalInput("WebSearch", { query: "q" }).primary).toEqual({ label: "Query", value: "q", code: false });
  });
  test("a watcher shows its assembled command line and drops command and args from rest", () => {
    const r = describeApprovalInput("mcp__harness__create_watcher", { command: "tail", args: ["-f", "a b"], name: "w" });
    expect(r.primary?.label).toBe("Command");
    expect(r.primary?.value).toContain("tail");
    expect(r.primary?.value).toContain("-f");
    expect(r.rest).toEqual({ name: "w" });
  });
  test("an update_watcher with args only says the command is unchanged", () => {
    const r = describeApprovalInput("update_watcher", { args: ["x"], watcher: "w" });
    expect(r.primary?.value).toContain("(unchanged command)");
  });
  test("update_watcher without command or args falls through to the watcher name", () => {
    expect(describeApprovalInput("update_watcher", { watcher: "w", name: "n" }).primary).toEqual({ label: "Watcher", value: "w", code: false });
  });
  test("project tools prefer the directory over the project key", () => {
    expect(describeApprovalInput("create_project", { path: "/p", project_key: "K" }).primary?.label).toBe("Directory");
    expect(describeApprovalInput("delete_project", { project_key: "K" }).primary).toEqual({ label: "Project", value: "K", code: false });
  });
  test("delete_ticket shows the key; an unknown tool falls back to command, url, file_path, path in order", () => {
    expect(describeApprovalInput("delete_ticket", { key: "A-1" }).primary).toEqual({ label: "Ticket", value: "A-1", code: false });
    expect(describeApprovalInput("Other", { path: "/p", url: "u" }).primary?.label).toBe("URL");
    expect(describeApprovalInput("Other", { path: "/p" }).primary?.label).toBe("Path");
    expect(describeApprovalInput("Other", { n: 1 }).primary).toBeNull();
  });
  test("a non-string description is not reported, and its key is dropped from rest", () => {
    const r = describeApprovalInput("Other", { description: 4 });
    expect(r.description).toBeNull();
    expect(r.rest).toBeNull(); // take() deletes the key even when it isn't a string
  });
});

test("approvalToast per decision", () => {
  expect(approvalToast("deny", "Bash", "A-1")).toBe("Denied Bash");
  expect(approvalToast("allow_tool", "Bash", "A-1")).toBe("Bash allowed on A-1");
  expect(approvalToast("allow_once", "Bash", "A-1")).toBe("Allowed Bash once");
});

test("permissionVerb", () => {
  expect(permissionVerb({ decision: "allow", source: "classifier" })).toBe("Auto-approved");
  expect(permissionVerb({ decision: "allow", source: "policy" })).toBe("Allowed");
  expect(permissionVerb({ decision: "ask", source: "classifier" })).toBe("Asked you");
  expect(permissionVerb({ decision: "deny", source: "policy" })).toBe("Denied");
});

test("decisionSource joins the parts that exist; latency 0 still shows", () => {
  expect(decisionSource({ source: "policy" })).toBe("policy");
  expect(decisionSource({ source: "classifier", backend: "claude-cli", latencyMs: 2400 })).toBe("classifier · claude-cli · 2.4s");
  expect(decisionSource({ source: "classifier", latencyMs: 0 })).toBe("classifier · 0.0s");
});

test("permissionModeLabel falls back to the raw mode for an unknown one", () => {
  expect(permissionModeLabel("read_only")).toBe("Read only");
  expect(permissionModeLabel("bogus" as never)).toBe("bogus");
});

describe("groupTranscript", () => {
  test("a result joins its call and is not a row of its own", () => {
    const items = groupTranscript([
      entry(1, { type: "tool_call", callId: "c", name: "Bash", input: {} }),
      entry(2, { type: "text", text: "hi" }),
      entry(3, { type: "tool_result", callId: "c", name: "Bash", output: [], isError: false }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "entry"]);
    expect(items[0]!.kind === "tool" && (items[0] as Extract<TranscriptItem, { kind: "tool" }>).result?.seq).toBe(3);
  });
  test("an orphan result (no call seen) stays a plain entry", () => {
    const items = groupTranscript([entry(1, { type: "tool_result", callId: "x", name: "Bash", output: [], isError: false })]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("entry");
  });
  test("a call with no result has none", () => {
    const [item] = groupTranscript([entry(1, { type: "tool_call", callId: "c", name: "Bash", input: {} })]);
    expect(item!.kind === "tool" && (item as Extract<TranscriptItem, { kind: "tool" }>).result).toBeUndefined();
  });
});

describe("toolPreview", () => {
  test("first non-empty preferred key's first line", () => {
    expect(toolPreview("Bash", { command: "ls\nmore" })).toBe("ls");
    expect(toolPreview("x", { command: "", url: "u" })).toBe("u");
  });
  test("no known key: JSON, but an empty object is empty", () => {
    expect(toolPreview("x", { a: 1 })).toBe('{"a":1}');
    expect(toolPreview("x", {})).toBe("");
  });
  test("scalars stringify, null and undefined are empty", () => {
    expect(toolPreview("x", 5)).toBe("5");
    expect(toolPreview("x", null)).toBe("");
    expect(toolPreview("x", undefined)).toBe("");
  });
});

describe("toolLabel", () => {
  test("a description is the label and the preview the detail, unless they match", () => {
    expect(toolLabel("Bash", { description: "List files\nmore", command: "ls" })).toEqual({ label: "List files", detail: "ls" });
    expect(toolLabel("Bash", { description: "ls", command: "ls" })).toEqual({ label: "ls", detail: "" });
  });
  test("a blank description is ignored", () => {
    expect(toolLabel("Bash", { description: "  \n", command: "ls" })).toEqual({ label: "ls", detail: "" });
  });
  test("file tools show the base name with the Read range", () => {
    expect(toolLabel("Read", { file_path: "/a/b/c.ts" })).toEqual({ label: "c.ts", detail: "/a/b/c.ts" });
    expect(toolLabel("Read", { file_path: "/a/c.ts", offset: 10, limit: 5 }).label).toBe("c.ts:10–14");
    expect(toolLabel("Read", { file_path: "/a/c.ts", offset: 10 }).label).toBe("c.ts:10–");
    expect(toolLabel("Read", { file_path: "/a/c.ts", limit: 20 }).label).toBe("c.ts:1–20");
  });
  test("a non-positive or fractional offset/limit gives no range", () => {
    expect(toolLabel("Read", { file_path: "/a/c.ts", offset: 0, limit: 1.5 }).label).toBe("c.ts");
  });
  test("a non-file tool with file_path, or a path of only slashes, falls back to the preview", () => {
    expect(toolLabel("Grep", { file_path: "/a/c.ts" }).label).toBe("/a/c.ts");
    expect(toolLabel("Read", { file_path: "/" }).label).toBe("/");
  });
  test("array input is not treated as an object with a description", () => {
    expect(toolLabel("x", ["a"]).detail).toBe("");
  });
});

test("toolIcon", () => {
  expect([toolIcon("bash"), toolIcon("Bash"), toolIcon("browser_click"), toolIcon("Read")]).toEqual(["terminal", "terminal", "globe", "tool"]);
});

describe("formatMaybeJson", () => {
  test("pretty-prints objects and arrays", () => {
    expect(formatMaybeJson('  {"a":1}  ')).toBe('{\n  "a": 1\n}');
    expect(formatMaybeJson("[1]")).toBe("[\n  1\n]");
  });
  test("braces that aren't JSON are left alone", () => {
    expect(formatMaybeJson("{nope}")).toBe("{nope}");
  });
  test("long text is cut at max with a remainder count; text at the limit is not", () => {
    expect(formatMaybeJson("abcdef", 4)).toBe("abcd\n… (2 more characters)");
    expect(formatMaybeJson("abcd", 4)).toBe("abcd");
  });
});

describe("normalizeUrl", () => {
  test("empty, schemed and bare input", () => {
    expect(normalizeUrl("   ")).toBe("");
    expect(normalizeUrl(" example.com ")).toBe("https://example.com");
    expect(normalizeUrl("http://x")).toBe("http://x");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });
});

describe("fitRect / toPagePoint", () => {
  test("letterboxes by the tighter axis and centers", () => {
    expect(fitRect(200, 100, 100, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    expect(fitRect(100, 200, 100, 100)).toEqual({ x: 0, y: 50, w: 100, h: 100 });
  });
  test("any zero dimension draws nothing", () => {
    for (const args of [[0, 1, 1, 1], [1, 0, 1, 1], [1, 1, 0, 1], [1, 1, 1, 0]] as [number, number, number, number][]) expect(fitRect(args[0], args[1], args[2], args[3])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  test("maps a local point to page pixels, inclusive of the edges", () => {
    const drawn = { x: 50, y: 0, w: 100, h: 100 };
    const page = { width: 1000, height: 500 };
    expect(toPagePoint({ x: 100, y: 50 }, drawn, page)).toEqual({ x: 500, y: 250 });
    expect(toPagePoint({ x: 50, y: 0 }, drawn, page)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint({ x: 150, y: 100 }, drawn, page)).toEqual({ x: 1000, y: 500 });
  });
  test("outside the drawn image, or nothing drawn, is null", () => {
    const drawn = { x: 50, y: 0, w: 100, h: 100 };
    const page = { width: 1000, height: 500 };
    expect(toPagePoint({ x: 49, y: 10 }, drawn, page)).toBeNull();
    expect(toPagePoint({ x: 100, y: 101 }, drawn, page)).toBeNull();
    expect(toPagePoint({ x: 100, y: -1 }, drawn, page)).toBeNull();
    expect(toPagePoint({ x: 1, y: 1 }, { x: 0, y: 0, w: 0, h: 0 }, page)).toBeNull();
    expect(toPagePoint({ x: 100, y: 10 }, drawn, { width: 0, height: 5 })).toBeNull();
  });
});
