import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "../protocol";
import { groupTranscript } from "./format";
import { itemRun, modelLabel, runHeader, runStartedText, splitRunSections } from "./runSections";

const e = (id: string, runId: string | null, text: string, createdAt: number, type: "text" | "status" = "text"): TranscriptEntry => ({
  id,
  sessionId: "s",
  runId,
  seq: createdAt,
  role: runId ? "assistant" : "user",
  content: { type, text },
  createdAt,
});
const split = (entries: TranscriptEntry[]) => splitRunSections(groupTranscript(entries), itemRun);

describe("splitRunSections", () => {
  test("a run's start status becomes its header and no longer draws as a row", () => {
    const [s] = split([e("1", "a", "Run started (work)", 10, "status"), e("2", "a", "hi", 11)]);
    expect(s!.startText).toBe("Run started (work)");
    expect(s!.rows.map((r) => (r.kind === "entry" ? r.entry.id : ""))).toEqual(["2"]);
  });

  test("a user message mid-run stays with that run; a run change opens the next section", () => {
    const sections = split([e("1", "a", "Run started (work)", 1, "status"), e("2", null, "ping", 2), e("3", "b", "Run started (review)", 3, "status"), e("4", "b", "ok", 4)]);
    expect(sections.map((s) => [s.runId, s.rows.length])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  test("rows before the first run have no run id, so no header", () => {
    expect(split([e("1", null, "first", 1), e("2", "a", "x", 2)]).map((s) => s.runId)).toEqual([null, "a"]);
  });

  test("rows that say nothing about a run (streaming text) join the last section", () => {
    const rows = [{ run: "a" }, { run: "b" }, { run: null }];
    const sections = splitRunSections(rows, (r) => (r.run ? { runId: r.run, startText: null, createdAt: 1 } : null));
    expect(sections.map((s) => s.rows.length)).toEqual([1, 2]);
  });

  test("only the exact start text is recognised", () => {
    expect(runStartedText("Run started (work · opus)")).not.toBeNull();
    expect(runStartedText("Run started later")).toBeNull();
    expect(runStartedText("Run finished (work)")).toBeNull();
  });
});

describe("modelLabel", () => {
  test("ids become names", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelLabel("opus[1m]")).toBe("Opus 1M");
    expect(modelLabel("gpt-5")).toBe("gpt-5");
    expect(modelLabel("  ")).toBeNull();
  });
});

describe("runHeader", () => {
  const run = { id: "r", sessionId: "s", kind: "work", status: "succeeded", driver: "claude-code", prompt: "", error: null, createdAt: 1, startedAt: 2, endedAt: 3, model: "claude-opus-5-5" } as const;
  test("phase • driver, model, at the start time", () => {
    expect(runHeader(run, {})).toEqual({ title: "Work • Claude Code, Opus 5.5", at: 2 });
  });
  test("the default model is only named once the list is loaded", () => {
    const def = { ...run, model: null };
    expect(runHeader(def, {}).title).toBe("Work • Claude Code");
    expect(runHeader(def, { models: [{ id: "s", name: "Sonnet 5.5", default: true }] }).title).toBe("Work • Claude Code, Sonnet 5.5");
  });
  test("an unloaded run falls back to the kind in its start text", () => {
    expect(runHeader(null, { startText: "Run started (review · opus)", firstAt: 9 })).toEqual({ title: "Review", at: 9 });
  });
});
