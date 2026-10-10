// Run sections and run headers (shared/src/state/runSections.ts) for HarnessKit's State/RunSections.swift.
import type { DriverInfo, ModelInfo, Run, TranscriptContent, TranscriptEntry } from "../../src/protocol";
import { groupTranscript } from "../../src/state/format";
import { itemRun, modelLabel, runHeader, splitRunSections } from "../../src/state/runSections";
import { cases } from "../case";

const entry = (id: string, runId: string | null, content: TranscriptContent, createdAt: number): TranscriptEntry => ({
  id,
  sessionId: "s",
  runId,
  seq: createdAt,
  role: content.type === "text" ? (runId ? "assistant" : "user") : "tool",
  content,
  createdAt,
});
const text = (id: string, runId: string | null, at: number) => entry(id, runId, { type: "text", text: id }, at);
const status = (id: string, runId: string | null, t: string, at: number) => entry(id, runId, { type: "status", text: t }, at);
const call = (id: string, runId: string | null, callId: string, at: number) => entry(id, runId, { type: "tool_call", callId, name: "bash", input: {} }, at);
const result = (id: string, runId: string | null, callId: string, at: number) => entry(id, runId, { type: "tool_result", callId, name: "bash", output: [], isError: false }, at);

export const runSectionCases = cases(
  (entries: TranscriptEntry[]) =>
    splitRunSections(groupTranscript(entries), itemRun).map((s) => ({
      runId: s.runId,
      startText: s.startText,
      firstAt: s.firstAt,
      rows: s.rows.map((i) => (i.kind === "tool" ? i.call.id : i.entry.id)),
    })),
  {
    empty: [],
    "one run: its start row becomes the header": [status("1", "a", "Run started (work)", 10), text("2", "a", 11), status("3", "a", "Run finished (work)", 12)],
    "a run change starts a section": [status("1", "a", "Run started (plan)", 10), text("2", "a", 11), status("3", "b", "Run started (work · claude-code · opus)", 20), text("4", "b", 21)],
    "a message with no run is a headerless section of its own, and the run carries on after it": [status("1", "a", "Run started (work)", 10), text("2", null, 11), text("3", "a", 12), status("4", "b", "Run started (review)", 20)],
    "rows before the first run form a headerless section": [text("1", null, 1), status("2", "a", "Run started (work)", 10), text("3", "a", 11)],
    "a section cut by the window has no start text": [text("1", "a", 11), status("2", "a", "Run finished (work)", 12), status("3", "b", "Run started (work)", 20)],
    "a tool call and its result stay together in their run": [status("1", "a", "Run started (work)", 10), call("2", "a", "x", 11), result("3", "a", "x", 12), text("4", "b", 20)],
    "only a Run started status is a header: other statuses are rows": [status("1", "a", "Run started (work)", 10), status("2", "a", "Run finished (work)", 11), status("3", "a", "Run started later", 12)],
    "a message first, then nothing else": [text("1", null, 1)],
    "a section whose only row is its start": [status("1", "a", "Run started (work)", 10), status("2", "b", "Run started (review)", 20)],
    "a status written without a run stays in the run around it": [status("1", "a", "Run started (work)", 10), text("2", "a", 11), status("3", null, "Moved to review", 12), status("4", "a", "Run finished (work)", 13)],
    "an interleaved run id starts another section": [text("1", "a", 1), text("2", "b", 2), text("3", "a", 3)],
  },
);

export const modelLabelCases = cases((id: string | null) => modelLabel(id), {
  "current id": "claude-opus-5-5",
  "dated id": "claude-haiku-4-5-20251001",
  "no minor": "claude-sonnet-4-20250514",
  "older order": "claude-3-5-sonnet-20241022",
  "older order, no minor": "claude-3-opus-20240229",
  alias: "haiku",
  "1M suffix": "claude-opus-5-5[1m]",
  "alias with 1M": "sonnet[1m]",
  "unknown id": "gpt-5.1-codex",
  "unknown with digits": "claude-opus-5-5-preview",
  empty: "",
  "only spaces": "   ",
  null: null,
});

const DRIVERS: DriverInfo[] = [{ id: "acme", name: "Acme Agent" } as DriverInfo];
const MODELS: ModelInfo[] = [
  { id: "opus", name: "Opus 5.5" },
  { id: "sonnet", name: "Sonnet 5.5", default: true },
];
const run = (over: Partial<Run>): Run => ({
  id: "r",
  sessionId: "s",
  kind: "work",
  status: "succeeded",
  driver: "claude-code",
  prompt: "",
  error: null,
  createdAt: 100,
  startedAt: 200,
  endedAt: 300,
  model: null,
  ...over,
});

export const runHeaderCases = cases(
  (c: { run?: Run | null; startText?: string | null; firstAt?: number | null; drivers?: DriverInfo[]; models?: ModelInfo[] }) =>
    runHeader(c.run, { startText: c.startText, firstAt: c.firstAt, drivers: c.drivers, models: c.models }),
  {
    "model name from the loaded list": { run: run({ model: "opus" }), models: MODELS },
    "model id made readable when the list lacks it": { run: run({ model: "claude-opus-5-5" }), models: MODELS },
    "model id made readable before the list loads": { run: run({ model: "claude-opus-5-5" }) },
    "default model is named from the loaded list": { run: run({ model: null }), models: MODELS },
    "default model with no list: just the driver": { run: run({ model: null }) },
    "default model when the list has no default": { run: run({ model: null }), models: [{ id: "opus", name: "Opus 5.5" }] },
    "other driver, named from the driver list": { run: run({ driver: "acme", model: "x-1" }), drivers: DRIVERS },
    "other driver, unknown": { run: run({ driver: "zeta", model: null }) },
    "plan run": { run: run({ kind: "plan", model: "opus" }), models: MODELS },
    "review run": { run: run({ kind: "review", model: "opus" }), models: MODELS },
    "complete run": { run: run({ kind: "complete", model: "haiku" }) },
    "conductor run is named by its kind": { run: run({ kind: "conductor", model: "opus" }), models: MODELS },
    "chat run": { run: run({ kind: "chat" }) },
    "triage run": { run: run({ kind: "triage", driver: "anthropic-api", model: "claude-haiku-5-5" }) },
    "compact run": { run: run({ kind: "compact" }) },
    "queued run falls back to createdAt": { run: run({ startedAt: null, status: "queued", model: "opus" }), models: MODELS },
    "no run: kind from the start text": { run: null, startText: "Run started (review · claude-code · opus)", firstAt: 50 },
    "no run: a kind with no phase": { run: undefined, startText: "Run started (conductor)", firstAt: 50 },
    "no run, no start text": { run: null, firstAt: 50 },
    "no run, no time": { run: null },
  },
);
