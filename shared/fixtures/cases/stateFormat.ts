// Labels, previews and small derivations (shared/src/state/format.ts) for HarnessKit's
// State/Format.swift. Time-based cases carry their own `now`.
import type { DriverInfo, PermissionDecisionLog, TicketKind, TicketStatus, TranscriptEntry } from "../../src/protocol";
import {
  approvalToast,
  CLASSIFIER_LABELS,
  COLUMN_EMPTY_TEXT,
  COMPOSER_PLACEHOLDER,
  composerHint,
  decisionSource,
  describeApprovalInput,
  dispatchedKey,
  driverIcon,
  driverLabel,
  fitRect,
  formatMaybeJson,
  groupTranscript,
  moveSwitchLabel,
  newSessionPlaceholder,
  normalizeUrl,
  permissionModeLabel,
  permissionVerb,
  relativeTime,
  shortToolName,
  STATUS_LABEL,
  tildify,
  toolIcon,
  toolPreview,
  toPagePoint,
  TRIAGE_LABEL,
  type Rect,
} from "../../src/state/format";
import { cases } from "../case";

export const statusLabel = STATUS_LABEL;
export const columnEmptyText = COLUMN_EMPTY_TEXT;
export const composerPlaceholder = COMPOSER_PLACEHOLDER;
export const classifierLabels = CLASSIFIER_LABELS;
export const triageLabel = TRIAGE_LABEL;

// ---------------------------------------------------------------------------
// Drivers and time
// ---------------------------------------------------------------------------

const drivers: DriverInfo[] = [
  { id: "codex", name: "OpenAI Codex", description: "", available: true, authenticated: true, detail: "", supportsLogin: false },
  { id: "blank", name: "", description: "", available: true, authenticated: true, detail: "", supportsLogin: false },
  { id: "codex", name: "Second Codex", description: "", available: true, authenticated: true, detail: "", supportsLogin: false },
  { id: "claude-code", name: "Claude Code (long name)", description: "", available: true, authenticated: true, detail: "", supportsLogin: true },
];

export const driverLabelCases = cases(({ id, drivers }: { id: string; drivers?: DriverInfo[] }) => driverLabel(id, drivers), {
  "short name wins over the list": { id: "claude-code", drivers },
  "short name without a list": { id: "anthropic-api" },
  dummy: { id: "dummy" },
  "first matching driver's name": { id: "codex", drivers },
  "empty name is kept (?? not ||)": { id: "blank", drivers },
  "unknown id without a list": { id: "codex" },
  "unknown id not in the list": { id: "mystery", drivers },
  "case-sensitive": { id: "Claude-Code", drivers },
});

export const driverIconCases = cases(driverIcon, {
  dummy: "dummy",
  api: "anthropic-api",
  claude: "claude-code",
  other: "codex",
  "case-sensitive": "Dummy",
});

const NOW = 1_800_000_000_000;
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const ago = (ms: number) => ({ ts: NOW - ms, now: NOW });

// The >30-day branch is toLocaleDateString (locale-dependent), so it's checked by hand in Swift.
export const relativeTimeCases = cases(({ ts, now }: { ts: number | null; now: number }) => relativeTime(ts, now), {
  "null is never": { ts: null, now: NOW },
  "0 is never (falsy)": { ts: 0, now: NOW },
  "same instant": ago(0),
  "future is just now": ago(-5 * M),
  "9s": ago(9 * S),
  "9.4s rounds to 9: just now": ago(9_400),
  "9.5s rounds to 10s": ago(9_500),
  "10s": ago(10 * S),
  "59s": ago(59 * S),
  "59.4s stays seconds": ago(59_400),
  "59.5s rounds to 1m": ago(59_500),
  "60s": ago(M),
  "89s": ago(89 * S),
  "90s rounds to 2m": ago(90 * S),
  "59m": ago(59 * M),
  "59m29s stays minutes": ago(59 * M + 29 * S),
  "59.5m rounds to 1h": ago(59 * M + 30 * S),
  "1h": ago(H),
  "23h": ago(23 * H),
  "23h29m stays hours": ago(23 * H + 29 * M),
  "23h30m rounds to 1d": ago(23 * H + 30 * M),
  "1d": ago(D),
  "29d": ago(29 * D),
  "29d11h stays days": ago(29 * D + 11 * H),
});

export const tildifyCases = cases(tildify, {
  "home path": "/Users/mark/Sites/harness",
  "home itself": "/Users/mark",
  "home with trailing slash": "/Users/mark/",
  "only the first segment": "/Users/mark/Users/other",
  "no user segment": "/Users/",
  "not at the start": "/Volumes/x/Users/mark",
  "linux home untouched": "/home/mark",
  "case-sensitive": "/users/mark/x",
  "unicode user name": "/Users/rené/x",
  "emoji user name": "/Users/🚀/x",
  "newline in the user segment": "/Users/a\nb/c",
  empty: "",
});

// ---------------------------------------------------------------------------
// Composers
// ---------------------------------------------------------------------------

const STATUSES: TicketStatus[] = ["planning", "in_progress", "blocked", "review", "done"];
const approvalStub = { id: "a", runId: "r", toolName: "Bash", input: {}, requestedAt: 1 };

export const moveSwitchLabelCases = cases(
  ({ status, pendingApproval }: { status: TicketStatus; pendingApproval: typeof approvalStub | null }) => moveSwitchLabel({ status, pendingApproval }),
  {
    ...Object.fromEntries(STATUSES.map((status) => [status, { status, pendingApproval: null }])),
    "review with a pending approval": { status: "review", pendingApproval: approvalStub },
    "done with a pending approval": { status: "done", pendingApproval: approvalStub },
    "unknown status": { status: "archived" as TicketStatus, pendingApproval: null },
  },
);

export const composerHintCases = cases(
  ({ busy, status, move }: { busy: boolean; status: TicketStatus; move?: boolean }) => composerHint({ busy, status }, move),
  [
    ...STATUSES.flatMap((status) =>
      [false, true].flatMap((busy) =>
        [undefined, false, true].map((move) => [`${status} busy=${busy} move=${move ?? "default"}`, move === undefined ? { busy, status } : { busy, status, move }] as const),
      ),
    ),
    ["unknown status idle", { busy: false, status: "archived" as TicketStatus }],
    ["unknown status busy", { busy: true, status: "archived" as TicketStatus }],
  ],
);

export const newSessionPlaceholderCases = cases(newSessionPlaceholder, {
  task: "task",
  conductor: "conductor",
  "unknown kind": "epic" as TicketKind,
});

// ---------------------------------------------------------------------------
// Tools, approvals, permissions
// ---------------------------------------------------------------------------

export const shortToolNameCases = cases(shortToolName, {
  "harness tool": "mcp__harness__post_summary",
  "plain tool": "Bash",
  "server name with an underscore doesn't match": "mcp__a_b__x",
  "empty server name": "mcp____x",
  "empty tool name": "mcp__x__",
  "not at the start": "xmcp__a__b",
  "only one prefix stripped": "mcp__a__mcp__b__c",
  "uppercase prefix": "MCP__a__b",
  "unicode server name": "mcp__é__tool",
  empty: "",
});

type ApprovalInput = { toolName: string; input?: unknown };
const approval = ({ toolName, input }: ApprovalInput) => describeApprovalInput(toolName, input);

export const describeApprovalInputCases = cases(approval, {
  "Bash command, description and rest": { toolName: "Bash", input: { command: "npm i", description: "Install deps", timeout: 5 } },
  "bash is case-insensitive": { toolName: "BASH", input: { command: "ls" } },
  "Bash with a non-string command": { toolName: "Bash", input: { command: 5, cwd: "/x" } },
  "Edit shows file_path": { toolName: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "y" } },
  "Read shows file_path": { toolName: "Read", input: { file_path: "/a.ts" } },
  "NotebookEdit shows notebook_path": { toolName: "NotebookEdit", input: { notebook_path: "/n.ipynb", new_source: "x" } },
  "NOTEBOOKEDIT is case-insensitive": { toolName: "NOTEBOOKEDIT", input: { notebook_path: "/n.ipynb" } },
  "dotless i is not i (non-unicode regex)": { toolName: "notebookedıt", input: { notebook_path: "/n.ipynb" } },
  "Write prefers file_path over notebook_path": { toolName: "Write", input: { notebook_path: "/n", file_path: "/f" } },
  "WebFetch shows the url as text": { toolName: "WebFetch", input: { url: "https://x.y", prompt: "p" } },
  "WebSearch shows the query": { toolName: "WebSearch", input: { query: "swift testing" } },
  "webfetch with only a query": { toolName: "webfetch", input: { query: "q" } },
  "create_watcher shell line": {
    toolName: "create_watcher",
    input: { name: "status", command: "while true; do curl -s https://x.test; sleep 60; done", prompt: "Dispatch outages." },
  },
  "create_watcher login shell shows the line": {
    toolName: "create_watcher",
    input: { command: "/bin/zsh", args: ["-lc", "while true; do curl -s 'https://x.test'; sleep 60; done"] },
  },
  "create_watcher argv quoted": {
    toolName: "create_watcher",
    input: { name: "jira", command: "/usr/local/bin/watch-jira", args: ["--project=FOO", "--jql=status = Done"], mode: "loop" },
  },
  "update_watcher args only": { toolName: "mcp__harness__update_watcher", input: { watcher: "jira", args: ["it's"] } },
  "update_watcher without command shows the watcher": { toolName: "update_watcher", input: { watcher: "jira", enabled: false } },
  "create_watcher args are String()ed": { toolName: "create_watcher", input: { command: "poll", args: [1, true, null, { a: 1 }, [1, [2, null]], 2.5] } },
  "create_watcher non-array args and non-string command": { toolName: "create_watcher", input: { command: 5, args: "x" } },
  "Create_watcher is case-sensitive": { toolName: "Create_watcher", input: { command: "x", args: ["y z"] } },
  "delete_watcher shows the watcher": { toolName: "delete_watcher", input: { watcher: "jira" } },
  "run_watcher shows the watcher": { toolName: "mcp__harness__run_watcher", input: { watcher: "jira" } },
  "create_watcher doesn't pick watcher": { toolName: "create_watcher", input: { watcher: "jira" } },
  "delete_ticket shows the key": { toolName: "delete_ticket", input: { key: "ACME-3" } },
  "other tools don't pick key": { toolName: "get_ticket", input: { key: "ACME-3" } },
  "update_project shows the project": { toolName: "update_project", input: { project_key: "ACME", auto_complete: true } },
  "create_project prefers the directory": { toolName: "create_project", input: { path: "~/Sites/x", project_key: "X" } },
  "generic command fallback": { toolName: "mcp__x__run", input: { command: "make", url: "https://x" } },
  "generic url fallback": { toolName: "mcp__x__open", input: { url: "https://x", path: "/p" } },
  "generic file_path before path": { toolName: "custom", input: { path: "/p", file_path: "/f" } },
  "generic path": { toolName: "custom", input: { path: "/p" } },
  "unknown tool falls back to rest": { toolName: "mcp__x__thing", input: { a: 1 } },
  "description only": { toolName: "Bash", input: { description: "nothing else" } },
  "non-string description is dropped": { toolName: "Bash", input: { description: 5, command: "ls" } },
  "empty object": { toolName: "Bash", input: {} },
  "empty command string is still picked": { toolName: "Bash", input: { command: "" } },
  "raw string": { toolName: "Odd", input: "raw" },
  "raw string with escapes": { toolName: "Odd", input: 'say "hi"\n\t\\ \u0001' },
  "raw number": { toolName: "Odd", input: 1.5 },
  "raw big number": { toolName: "Odd", input: 1e21 },
  "raw false": { toolName: "Odd", input: false },
  "raw zero": { toolName: "Odd", input: 0 },
  "raw array is pretty-printed": { toolName: "Odd", input: [1, "two", [3, []], {}] },
  null: { toolName: "Odd", input: null },
  "undefined (missing)": { toolName: "Odd" },
});

export const approvalToastCases = cases(({ decision, tool, ticketKey }: { decision: "allow_once" | "allow_tool" | "deny"; tool: string; ticketKey: string }) => approvalToast(decision, tool, ticketKey), {
  deny: { decision: "deny", tool: "Bash", ticketKey: "A-1" },
  "allow tool": { decision: "allow_tool", tool: "Bash", ticketKey: "A-1" },
  "allow once": { decision: "allow_once", tool: "WebFetch", ticketKey: "A-1" },
  "unknown decision reads as once": { decision: "allow_forever" as "allow_once", tool: "Bash", ticketKey: "A-1" },
});

type VerbInput = Pick<PermissionDecisionLog, "decision" | "source">;
export const permissionVerbCases = cases((log: VerbInput) => permissionVerb(log), {
  "allow by classifier": { decision: "allow", source: "classifier" },
  "allow by policy": { decision: "allow", source: "policy" },
  ask: { decision: "ask", source: "classifier" },
  deny: { decision: "deny", source: "policy" },
  "unknown decision reads as denied": { decision: "maybe" as "deny", source: "policy" },
});

type SourceInput = Pick<PermissionDecisionLog, "source" | "backend" | "latencyMs">;
export const decisionSourceCases = cases((log: SourceInput) => decisionSource(log), {
  policy: { source: "policy" },
  "classifier with backend and latency": { source: "classifier", backend: "claude-cli", latencyMs: 2400 },
  "empty backend skipped": { source: "classifier", backend: "", latencyMs: 412.5 },
  "latency without backend": { source: "classifier", latencyMs: 0 },
  "0.25s: exact tie rounds up": { source: "classifier", latencyMs: 250 },
  "0.75s: exact tie rounds up": { source: "classifier", latencyMs: 750 },
  "0.05s: just above a tie": { source: "classifier", latencyMs: 50 },
  "1.05s: just above a tie": { source: "classifier", latencyMs: 1050 },
  "1.45s: just below a tie": { source: "classifier", latencyMs: 1450 },
  "0.04s": { source: "classifier", latencyMs: 40 },
  "large latency": { source: "classifier", latencyMs: 12345678 },
  "negative latency": { source: "classifier", latencyMs: -50 },
  "negative rounds to -0.0": { source: "classifier", latencyMs: -40 },
  "unknown source passes through": { source: "oracle" as "policy", backend: "x" },
});

export const permissionModeLabelCases = cases(permissionModeLabel, {
  auto: "auto",
  ask: "ask",
  "read only": "read_only",
  "unknown mode passes through": "yolo" as "auto",
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const e = (id: string, seq: number, content: TranscriptEntry["content"]): TranscriptEntry => ({
  id,
  sessionId: "s",
  runId: "r",
  seq,
  role: content.type === "text" ? "assistant" : "tool",
  content,
  createdAt: seq,
});
const call = (id: string, callId: string, name = "bash") => e(id, Number(id), { type: "tool_call", callId, name, input: { command: "ls" } });
const result = (id: string, callId: string, name = "bash") => e(id, Number(id), { type: "tool_result", callId, name, output: [], isError: false });
const text = (id: string) => e(id, Number(id), { type: "text", text: `t${id}` });

export const groupTranscriptCases = cases(
  (entries: TranscriptEntry[]) =>
    groupTranscript(entries).map((i) => (i.kind === "tool" ? { kind: "tool", call: i.call.id, result: i.result?.id ?? null } : { kind: "entry", id: i.entry.id })),
  {
    "results attach by callId, out of order": [call("1", "a"), call("2", "b"), result("3", "b"), text("4"), result("5", "a")],
    "result without its call is its own row": [result("9", "zz")],
    "result before its call stays a row": [result("1", "a"), call("2", "a")],
    "a later result replaces an earlier one": [call("1", "a"), result("2", "a"), result("3", "a")],
    "a repeated callId pairs with the latest call": [call("1", "a"), call("2", "a"), result("3", "a")],
    "status and error entries pass through": [
      e("1", 1, { type: "status", text: "Moved to review" }),
      e("2", 2, { type: "error", text: "boom" }),
      e("3", 3, { type: "thinking", text: "hm" }),
    ],
    empty: [],
  },
);

export const toolPreviewCases = cases(({ name, input }: { name: string; input?: unknown }) => toolPreview(name, input), {
  "bash first line": { name: "bash", input: { command: "bun test\nmore" } },
  "url": { name: "browser_open", input: { url: "https://a" } },
  "empty object": { name: "x", input: {} },
  "single numeric field": { name: "x", input: { n: 1 } },
  "priority: command before url": { name: "x", input: { url: "u", command: "c" } },
  "priority: path before file_path": { name: "x", input: { file_path: "f", path: "p" } },
  "skips empty strings": { name: "x", input: { command: "", url: "u" } },
  "skips non-strings": { name: "x", input: { command: 5, text: "t" } },
  "last field: text": { name: "x", input: { text: "hello" } },
  "every field in order": { name: "x", input: { selector: "#a", pattern: "p", key: "k", title: "t", question: "q", summary: "s", expression: "e" } },
  "only splits on \\n": { name: "x", input: { command: "a\r\nb" } },
  "leading newline gives empty first line": { name: "x", input: { command: "\nsecond" } },
  "no picked field: compact JSON": { name: "x", input: { a: [1, { b: null }], c: true } },
  "numbers in JSON use JS formatting": { name: "x", input: { m: 0.1, n: 1e21, z: -0 } },
  "array input is JSON": { name: "x", input: [1, "a"] },
  "empty array": { name: "x", input: [] },
  "string input as is (no split)": { name: "x", input: "multi\nline" },
  "number input": { name: "x", input: 3.5 },
  "false input": { name: "x", input: false },
  "zero input": { name: "x", input: 0 },
  "empty string input": { name: "x", input: "" },
  null: { name: "x", input: null },
  "undefined (missing)": { name: "x" },
});

// JSONValue objects in Swift are unordered dictionaries, so where TS prints an object in insertion
// order, Swift prints it with sorted keys. Each case records both: `ts` (what TS printed for the
// input as written) and `sortedKeys` (what TS prints for the same input with keys sorted), which is
// what Swift must produce.
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]))
      : v;

export const keyOrderDeviationCases = cases(
  ({ fn, name, input }: { fn: "toolPreview" | "describeApprovalInput"; name: string; input: unknown }) => {
    const run = (i: unknown) => (fn === "toolPreview" ? toolPreview(name, i) : describeApprovalInput(name, i).primary?.value ?? null);
    return { ts: run(input), sortedKeys: run(sortKeys(input)) };
  },
  {
    "toolPreview object": { fn: "toolPreview", name: "x", input: { z: 1, a: { y: 2, b: 3 } } },
    "toolPreview array of objects": { fn: "toolPreview", name: "x", input: [{ b: 1, a: 2 }] },
    "describeApprovalInput array of objects": { fn: "describeApprovalInput", name: "Odd", input: [{ b: 1, a: [{ d: 1, c: 2 }] }] },
  },
);

export const toolIconCases = cases(toolIcon, {
  bash: "bash",
  Bash: "Bash",
  BASH: "BASH",
  "browser tool": "browser_click",
  "browser prefix only": "browser",
  "mcp browser tool is not a prefix match": "mcp__harness__browser_open",
  other: "read_file",
});

export const formatMaybeJsonCases = cases(({ text, max }: { text: string; max?: number }) => formatMaybeJson(text, max), {
  "object pretty-printed": { text: '{"a":1,"b":[true,false,null],"c":{"d":"e"}}' },
  "array pretty-printed": { text: '[1,{"a":[]},{},[[]]]' },
  "keeps insertion order": { text: '{"z":1,"a":2,"m":3}' },
  "integer-like keys come first, ascending": { text: '{"b":1,"10":2,"2":3,"01":4,"-1":5,"4294967294":6,"4294967295":7,"1.5":8}' },
  "duplicate key: last value, first position": { text: '{"a":1,"b":2,"a":3}' },
  "empty object": { text: "{}" },
  "empty array": { text: "[]" },
  "whitespace inside": { text: '{ "a" :\t[ 1 ,\r\n 2 ] }' },
  "surrounding whitespace trimmed": { text: '  \n{"a":1}\n  ' },
  "BOM and NBSP trimmed by trim()": { text: '﻿ {"a":1} ' },
  "NBSP inside is not JSON whitespace": { text: '{ "a":1}' },
  numbers: { text: "[1.0,1e2,1.5E+3,1E-7,5e-7,0.1,-0,-0.0,1e21,123456789012345678901234,0.000001,1e400,-1e400,12345678901234567890]" },
  "leading zero is invalid": { text: "[01]" },
  "trailing dot is invalid": { text: "[1.]" },
  "leading dot is invalid": { text: "[.5]" },
  "plus sign is invalid": { text: "[+1]" },
  "bare minus is invalid": { text: "[-]" },
  "empty exponent is invalid": { text: "[1e]" },
  "string escapes round trip": { text: '["\\"\\\\\\b\\f\\n\\r\\t\\/"]' },
  "unicode escapes decode; only controls re-escape": { text: '["\\u00e9\\u2028\\u007f\\u0001\\u001f\\u0000 é 🚀 \\ud83d\\ude80"]' },
  "lone surrogates are escaped": { text: '["\\ud800","x\\udfffy","\\ude80\\ud83d"]' },
  "uppercase hex escapes": { text: '["\\u00E9\\u00C9"]' },
  "invalid escape": { text: '["\\x"]' },
  "short unicode escape": { text: '["\\u12"]' },
  "raw control character is invalid": { text: '["a\tb"]' },
  "raw newline is invalid": { text: '["a\nb"]' },
  "trailing comma": { text: "[1,2,]" },
  "missing value": { text: '{"a":}' },
  "unquoted key": { text: "{a:1}" },
  "single quotes": { text: "{'a':1}" },
  "trailing content": { text: '{"a":1} {"b":2}' },
  "literals": { text: "[true,false,null]" },
  "bad literal": { text: "[tru]" },
  "nested deeply": { text: '{"a":{"b":{"c":[{"d":[1]}]}}}' },
  "keys need escaping too": { text: '{"a\\"b":1,"\\u0001":2}' },
  "only starts with a brace": { text: '{"a":1} trailing' },
  "mismatched brackets": { text: "[1}" },
  "plain text": { text: "hello" },
  "plain text under max": { text: "abcdefghij", max: 10 },
  "plain text over max": { text: "abcdefghijk", max: 10 },
  "max counts UTF-16 units": { text: "🚀🚀🚀", max: 4 },
  "truncation keeps surrounding whitespace": { text: "  abcdef  ", max: 4 },
  "invalid JSON is truncated like text": { text: "{" + "x".repeat(20) + "}", max: 5 },
  "valid JSON is never truncated": { text: '{"a":"' + "x".repeat(20) + '"}', max: 5 },
  empty: { text: "" },
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const dispatchedKeyCases = cases((outcome: string | null) => dispatchedKey({ outcome }), {
  "dispatched to": "Dispatched to FOO-123",
  "first of two": "Dispatched to NYTIMES-31 and BAR-2",
  "lower-case doesn't count": "Dispatched to foo-123",
  "word prefix breaks the boundary": "aFOO-123",
  "digit prefix breaks the boundary": "1FOO-2",
  "word suffix breaks the boundary": "FOO-123a",
  "underscore suffix breaks the boundary": "FOO-123_",
  "underscore and digits in the project": "see FOO_BAR2-1.",
  "stops at a dot": "FOO-12.5",
  "in parentheses": "(FOO-1)",
  "single letter": "A-1",
  "later start after a failed one": "FOO-BAR-1",
  "a hyphenated number": "FOO-1-2",
  "no number": "FOO-",
  "non-ASCII digits aren't \\d": "FOO-١٢",
  "non-ASCII letter before is a boundary": "éFOO-1",
  "non-ASCII letter after is a boundary": "FOO-1é",
  "combining mark after is a boundary": "FOO-1́",
  "emoji before": "🚀FOO-7",
  "declined": "Declined: not assigned to me",
  empty: "",
  null: null,
});

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export const normalizeUrlCases = cases(normalizeUrl, {
  "bare host": "  example.com/x ",
  http: "http://a.b",
  about: "about:blank",
  blank: "   ",
  empty: "",
  "uppercase scheme": "HTTPS://X.Y",
  "host:port looks like a scheme": "localhost:3000",
  "ip:port": "1.2.3.4:80",
  mailto: "mailto:a@b.c",
  "scheme with +.-": "git+ssh://h",
  "NBSP trimmed": " example.com ",
  "NEL is not trimmed": "\u0085x.y",
  "inner space kept": "a b",
  "non-ASCII first letter": "é:x",
  "long s is not s": "ſ:x",
  "Kelvin sign is not k": "K:x",
});

export const fitRectCases = cases(({ boxW, boxH, w, h }: { boxW: number; boxH: number; w: number; h: number }) => fitRect(boxW, boxH, w, h), {
  "wide image in a square": { boxW: 400, boxH: 400, w: 1280, h: 800 },
  "tall image in a square": { boxW: 400, boxH: 400, w: 800, h: 1280 },
  "same aspect": { boxW: 200, boxH: 100, w: 400, h: 200 },
  "upscaled": { boxW: 1000, boxH: 1000, w: 10, h: 20 },
  "fractional": { boxW: 100, boxH: 100, w: 3, h: 7 },
  "zero box": { boxW: 0, boxH: 0, w: 1, h: 1 },
  "zero image width": { boxW: 100, boxH: 100, w: 0, h: 10 },
  "zero box height": { boxW: 100, boxH: 0, w: 10, h: 10 },
  "negative image width": { boxW: 100, boxH: 100, w: -10, h: 10 },
});

const r = fitRect(400, 400, 1280, 800);
const page = { width: 1280, height: 800 };
export const toPagePointCases = cases(({ local, drawn, page }: { local: { x: number; y: number }; drawn: Rect; page: { width: number; height: number } }) => toPagePoint(local, drawn, page), {
  centre: { local: { x: 200, y: 200 }, drawn: r, page },
  "top-left corner": { local: { x: 0, y: 75 }, drawn: r, page },
  "bottom-right corner": { local: { x: 400, y: 325 }, drawn: r, page },
  "above the image": { local: { x: 200, y: 74 }, drawn: r, page },
  "below the image": { local: { x: 200, y: 326 }, drawn: r, page },
  "left of the image": { local: { x: -1, y: 200 }, drawn: r, page },
  "right of the image": { local: { x: 400.5, y: 200 }, drawn: r, page },
  "nothing drawn": { local: { x: 1, y: 1 }, drawn: fitRect(0, 0, 1, 1), page: { width: 1, height: 1 } },
  "zero page": { local: { x: 1, y: 1 }, drawn: { x: 0, y: 0, w: 2, h: 2 }, page: { width: 0, height: 5 } },
  "half rounds up": { local: { x: 1, y: 1 }, drawn: { x: 0, y: 0, w: 2, h: 2 }, page: { width: 5, height: 5 } },
  "just under a half rounds down": { local: { x: 0.999, y: 1.001 }, drawn: { x: 0, y: 0, w: 2, h: 2 }, page: { width: 5, height: 5 } },
  "offset frame": { local: { x: 33.3, y: 66.6 }, drawn: { x: 10, y: 20, w: 100, h: 50 }, page: { width: 1920, height: 1080 } },
});
