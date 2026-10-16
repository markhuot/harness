import { describe, expect, test } from "bun:test";
import type { Run, TranscriptEntry } from "../../../shared/src/protocol";
import type { TranscriptItem } from "../../../shared/src/state/format";
import { itemRun, runHeader, runStartedText, splitRunSections, type RowRun } from "../../../shared/src/state/runSections";

type Row = { id: string; run?: RowRun | null };
const at = (r: Row) => r.run ?? null;
const inRun = (id: string, runId: string, createdAt = 1): Row => ({ id, run: { runId, startText: null, createdAt } });
const start = (id: string, runId: string, text: string, createdAt: number): Row => ({ id, run: { runId, startText: text, createdAt } });
const human = (id: string, createdAt = 1): Row => ({ id, run: { runId: null, startText: null, createdAt } });
const ids = (s: { rows: Row[] }[]) => s.map((x) => x.rows.map((r) => r.id));

describe("runStartedText", () => {
  test("matches only a whole 'Run started (…)' status", () => {
    expect(runStartedText("Run started (work · opus)")).toBe("Run started (work · opus)");
    expect(runStartedText("Run started ()")).toBe("Run started ()");
    expect(runStartedText("Run started (work) extra")).toBeNull();
    expect(runStartedText("Moved to review")).toBeNull();
  });
});

describe("splitRunSections", () => {
  test("no rows, no sections", () => {
    expect(splitRunSections([], at)).toEqual([]);
  });
  test("a new section opens whenever the run changes, and the start row becomes header data", () => {
    const rows = [start("s1", "r1", "Run started (work)", 10), inRun("a", "r1", 11), start("s2", "r2", "Run started (plan)", 20), inRun("b", "r2", 21)];
    const sections = splitRunSections(rows, at);
    expect(ids(sections)).toEqual([["a"], ["b"]]);
    expect(sections.map((s) => [s.runId, s.startText, s.firstAt])).toEqual([["r1", "Run started (work)", 10], ["r2", "Run started (plan)", 20]]);
  });
  test("a human message splits a run in two; the run's second section opens with its header again", () => {
    const sections = splitRunSections([inRun("a", "r1"), human("h"), inRun("b", "r1")], at);
    expect(ids(sections)).toEqual([["a"], ["h"], ["b"]]);
    expect(sections.map((s) => s.runId)).toEqual(["r1", null, "r1"]);
  });
  test("rows that say nothing about their run go to the last section, even the very first row", () => {
    const sections = splitRunSections<Row>([{ id: "x" }, inRun("a", "r1"), { id: "y" }], at);
    expect(ids(sections)).toEqual([["x"], ["a", "y"]]);
    expect(sections[0]!.runId).toBeNull();
    expect(sections[0]!.firstAt).toBeNull();
  });
  test("firstAt is the first row's time and startText the first start seen", () => {
    const s = splitRunSections([inRun("a", "r1", 5), start("s", "r1", "Run started (work)", 9), start("s2", "r1", "Run started (again)", 12)], at)[0]!;
    expect(s.firstAt).toBe(5);
    expect(s.startText).toBe("Run started (work)");
  });
  test("a lone start row leaves an empty section rather than disappearing", () => {
    const sections = splitRunSections([start("s", "r1", "Run started (work)", 3)], at);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows).toEqual([]);
    expect(sections[0]!.firstAt).toBe(3);
  });
});

const run = (over: Partial<Run>): Run => ({ id: "r", kind: "work", driver: "claude-code", model: null, startedAt: 0, createdAt: 0, ...over }) as Run;
const models = [
  { id: "opus-id", name: "Opus 5.5", default: false },
  { id: "def-id", name: "Sonnet 5.5", default: true },
] as never[];

describe("runHeader", () => {
  test("an unloaded run takes its kind from the start text, labelled as a phase or capitalised", () => {
    expect(runHeader(null, { startText: "Run started (work · opus)", firstAt: 7 })).toEqual({ title: "Work", at: 7 });
    expect(runHeader(undefined, { startText: "Run started (plan)" })).toEqual({ title: "Planning", at: null });
    expect(runHeader(null, { startText: "Run started (conductor · x)" }).title).toBe("Conductor");
  });
  test("an unloaded run with no usable start text is just 'Run'", () => {
    expect(runHeader(null, {}).title).toBe("Run");
    expect(runHeader(null, { startText: "Run started ()" }).title).toBe("Run");
    expect(runHeader(null, { startText: "garbage" }).title).toBe("Run");
  });
  test("phase and driver, with the listed model name when the model is in the list", () => {
    expect(runHeader(run({ kind: "review", model: "opus-id", startedAt: 100 }), { models }).title).toBe("Review • Claude Code, Opus 5.5");
  });
  test("a model not in the list is made readable, or the driver alone when the list names nothing", () => {
    expect(runHeader(run({ model: "claude-opus-5-5" }), { models: [] }).title).toBe("Work • Claude Code, Opus 5.5");
    expect(runHeader(run({ model: null }), {}).title).toBe("Work • Claude Code");
  });
  test("no model chosen names the list's default model, but only when the list is loaded", () => {
    expect(runHeader(run({ model: null }), { models }).title).toBe("Work • Claude Code, Sonnet 5.5");
    expect(runHeader(run({ model: null }), { models: [{ id: "a", name: "A", default: false }] as never[] }).title).toBe("Work • Claude Code");
  });
  test("kinds that map to work but aren't Work get their own label; triage is capitalised", () => {
    expect(runHeader(run({ kind: "chat" }), {}).title).toBe("Chat • Claude Code");
    expect(runHeader(run({ kind: "compact" }), {}).title).toBe("Compact • Claude Code");
    expect(runHeader(run({ kind: "triage" }), {}).title).toBe("Triage • Claude Code");
    expect(runHeader(run({ kind: "complete" }), {}).title).toBe("Complete • Claude Code");
  });
  test("time: startedAt, else createdAt, else the first row's, else null", () => {
    expect(runHeader(run({ startedAt: 5, createdAt: 3 }), { firstAt: 1 }).at).toBe(5);
    expect(runHeader(run({ startedAt: 0, createdAt: 3 }), { firstAt: 1 }).at).toBe(3);
    expect(runHeader(run({ startedAt: 0, createdAt: 0 }), { firstAt: 1 }).at).toBe(1);
    expect(runHeader(run({ startedAt: 0, createdAt: 0 }), {}).at).toBeNull();
  });
});

describe("itemRun", () => {
  const e = (role: TranscriptEntry["role"], runId: string | null, content: TranscriptEntry["content"]): TranscriptEntry => ({ id: "e", sessionId: "s", runId, seq: 1, role, content, createdAt: 42 });
  const entryItem = (entry: TranscriptEntry): TranscriptItem => ({ kind: "entry", entry });
  test("a run-less agent row says nothing about its run", () => {
    expect(itemRun(entryItem(e("assistant", null, { type: "text", text: "x" })))).toBeNull();
    expect(itemRun(entryItem(e("system", null, { type: "status", text: "Moved to review" })))).toBeNull();
  });
  test("a run-less human text message is its own run-less section", () => {
    expect(itemRun(entryItem(e("user", null, { type: "text", text: "hi" })))).toEqual({ runId: null, startText: null, createdAt: 42 });
  });
  test("a run-less user row that isn't text says nothing", () => {
    expect(itemRun(entryItem(e("user", null, { type: "status", text: "x" })))).toBeNull();
  });
  test("a run's start status carries its text; a permission status with the same text does not", () => {
    const text = "Run started (work)";
    expect(itemRun(entryItem(e("system", "r1", { type: "status", text })))).toEqual({ runId: "r1", startText: text, createdAt: 42 });
    expect(itemRun(entryItem(e("system", "r1", { type: "status", text, permission: {} as never })))?.startText).toBeNull();
    expect(itemRun(entryItem(e("system", "r1", { type: "status", text: "other" })))?.startText).toBeNull();
    expect(itemRun(entryItem(e("assistant", "r1", { type: "text", text })))?.startText).toBeNull();
  });
  test("a tool item uses its call's run and never has start text", () => {
    const call = e("assistant", "r9", { type: "tool_call", callId: "c", name: "Bash", input: {} }) as never;
    expect(itemRun({ kind: "tool", call })).toEqual({ runId: "r9", startText: null, createdAt: 42 });
  });
});
