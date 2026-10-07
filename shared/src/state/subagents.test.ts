import { describe, expect, test } from "bun:test";
import type { Session, Subagent, TaskOutput, TicketDetail, TranscriptEntry } from "../index";
import { initialState, reducer, TASK_OUTPUT_KEEP_CHARS, transcriptKey, type Action, type State } from "./reducer";
import { isTask, sortSubagents, subagentById, subagentModelLabel, subagentOpenLabel, subagentDuration, subagentPath, subagentsOf, subagentTitle, subagentTranscript, subagentTypeLabel, taskOutputOf } from "./subagents";
import { effectiveTab, isTicketTab, parseSubagentTab, showsAgentsTab, subagentTabRoute, tabStripTab } from "./tabs";

const sub = (id: string, over: Partial<Subagent> = {}): Subagent => ({
  id,
  sessionId: "s1",
  runId: "r1",
  parentId: null,
  description: `Task ${id}`,
  agentType: "general-purpose",
  prompt: "",
  status: "running",
  result: null,
  startedAt: 10,
  endedAt: null,
  updatedAt: 10,
  ...over,
});

const entry = (seq: number, subagentId: string | null, text = `e${seq}`): TranscriptEntry => ({
  id: `e${seq}`,
  sessionId: "s1",
  runId: "r1",
  subagentId,
  seq,
  role: "assistant",
  content: { type: "text", text },
  createdAt: seq,
});

const run = (actions: Action[], from: State = initialState) => actions.reduce(reducer, from);
const upserted = (subagent: Subagent): Action => ({ type: "event", event: { kind: "subagent.upserted", subagent } });

describe("sub-agent state", () => {
  test("live entries go to the sub-agent's transcript, not the session's", () => {
    const s = run([
      { type: "event", event: { kind: "transcript.appended", entry: entry(1, null) } },
      { type: "event", event: { kind: "transcript.appended", entry: entry(2, "a") } },
      { type: "event", event: { kind: "transcript.appended", entry: entry(3, undefined as never) } }, // older service: no field
    ]);
    expect(s.transcripts.s1!.entries.map((e) => e.seq)).toEqual([1, 3]);
    expect(subagentTranscript(s, "s1", "a")!.entries.map((e) => e.seq)).toEqual([2]);
    expect(subagentTranscript(s, "s1", "a")!.loaded).toBe(false);
  });

  test("a sub-agent backfill merges with live entries and marks only that transcript loaded", () => {
    const s = run([
      { type: "event", event: { kind: "transcript.appended", entry: entry(5, "a") } },
      { type: "transcript", sessionId: "s1", subagentId: "a", entries: [entry(2, "a"), entry(5, "a")] },
    ]);
    expect(subagentTranscript(s, "s1", "a")).toMatchObject({ loaded: true });
    expect(subagentTranscript(s, "s1", "a")!.entries.map((e) => e.seq)).toEqual([2, 5]);
    expect(s.transcripts[transcriptKey("s1")]).toBeUndefined();
  });

  test("sub-agent text doesn't clear the session agent's streaming preview", () => {
    const s = run([
      { type: "event", event: { kind: "transcript.delta", sessionId: "s1", runId: "r1", text: "Hel" } },
      { type: "event", event: { kind: "transcript.appended", entry: entry(1, "a") } },
    ]);
    expect(s.deltas.s1).toEqual({ r1: "Hel" });
  });

  test("upserts keep start order; a stale copy doesn't overwrite a newer one", () => {
    let s = run([upserted(sub("b", { startedAt: 20 })), upserted(sub("a", { startedAt: 5 }))]);
    expect(subagentsOf(s, "s1")!.map((x) => x.id)).toEqual(["a", "b"]);
    s = run([upserted(sub("a", { status: "succeeded", updatedAt: 30 }))], s);
    const detail = { ticket: {}, session: { id: "s1" } as Session, activity: [], runs: [], dependents: [], children: [], subagents: [sub("a", { updatedAt: 15 })] } as unknown as TicketDetail;
    s = run([{ type: "detail", detail }], s);
    expect(subagentById(s, "s1", "a")!.status).toBe("succeeded");
  });

  test("the list is unknown until a detail says; a detail without sub-agents (older service) leaves it unknown", () => {
    const base = { ticket: { id: "t", key: "T-1", kind: "task" }, session: { id: "s1" } as Session, activity: [], runs: [], dependents: [], children: [] };
    expect(subagentsOf(initialState, "s1")).toBeNull();
    expect(subagentsOf(run([{ type: "detail", detail: base as unknown as TicketDetail }]), "s1")).toBeNull();
    expect(subagentsOf(run([{ type: "detail", detail: { ...base, subagents: [] } as unknown as TicketDetail }]), "s1")).toEqual([]);
  });
});

describe("sub-agent tabs", () => {
  test("agent:<id> routes round-trip and sit under Agents", () => {
    const t = subagentTabRoute("toolu_01AbC-9");
    expect(isTicketTab(t)).toBe(true);
    expect(parseSubagentTab(t)).toBe("toolu_01AbC-9");
    expect(tabStripTab(t)).toBe("agents");
    expect(tabStripTab("transcript")).toBe("transcript");
    expect(isTicketTab("agent:")).toBe(false);
    expect(isTicketTab("agent:a/b")).toBe(false);
    expect(parseSubagentTab("plugin:git:changes")).toBeNull();
  });

  test("Agents and a sub-agent's view need sub-agents; an unknown one falls back to the list", () => {
    const opts = { conductor: false, pluginTabs: null };
    for (const subagents of [null, undefined, []]) {
      expect(effectiveTab("agents", { ...opts, subagents })).toBe("spec");
      expect(effectiveTab("agent:x", { ...opts, subagents })).toBe("spec");
    }
    expect(effectiveTab("agents", { ...opts, subagents: [{ id: "y" }] })).toBe("agents");
    expect(effectiveTab("agent:x", { ...opts, subagents: [{ id: "y" }] })).toBe("agents");
    expect(effectiveTab("agent:y", { ...opts, subagents: [{ id: "y" }] })).toBe("agent:y");
    expect(effectiveTab("transcript", { ...opts, subagents: [] })).toBe("transcript");
  });

  test("the Agents tab shows only when there are sub-agents", () => {
    expect(showsAgentsTab(null)).toBe(false);
    expect(showsAgentsTab([])).toBe(false);
    expect(showsAgentsTab([{ id: "a" }])).toBe(true);
  });
});

describe("sub-agent labels", () => {
  test("title falls back to the agent type, and the type chip hides when it is the title", () => {
    expect(subagentTitle({ description: "  ", agentType: "Explore" })).toBe("Explore");
    expect(subagentTitle({ description: "", agentType: null })).toBe("Sub-agent");
    expect(subagentTypeLabel({ description: "", agentType: "Explore" })).toBeNull();
    expect(subagentTypeLabel({ description: "Scan", agentType: "Explore" })).toBe("Explore");
  });

  test("model chip: Claude ids by family and version, aliases capitalized, anything else as is", () => {
    expect(subagentModelLabel(null)).toBeNull();
    expect(subagentModelLabel(" ")).toBeNull();
    expect(subagentModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(subagentModelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    // An 8-digit date is never read as the minor version.
    expect(subagentModelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(subagentModelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(subagentModelLabel("claude-3-opus-20240229")).toBe("Opus 3");
    expect(subagentModelLabel("haiku")).toBe("Haiku");
    expect(subagentModelLabel("claude-opus-4-6[1m]")).toBe("Opus 4.6 1M");
    expect(subagentModelLabel("sonnet[1m]")).toBe("Sonnet 1M");
    expect(subagentModelLabel("gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(subagentModelLabel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  test("duration boundaries", () => {
    expect(subagentDuration({ startedAt: 0, endedAt: 59_000 })).toBe("59s");
    expect(subagentDuration({ startedAt: 0, endedAt: 60_000 })).toBe("1m 0s");
    expect(subagentDuration({ startedAt: 0, endedAt: 3_600_000 + 120_000 })).toBe("1h 2m");
    expect(subagentDuration({ startedAt: 1000, endedAt: null }, 6000)).toBe("5s");
    expect(subagentDuration({ startedAt: 5000, endedAt: 1000 })).toBe("0s");
  });

  test("one list, the latest updated first; ties go to the later start", () => {
    const list = sortSubagents([
      sub("old-done", { status: "succeeded", startedAt: 1, endedAt: 2, updatedAt: 2 }),
      sub("run", { startedAt: 5, updatedAt: 5 }),
      sub("new-done", { status: "failed", startedAt: 3, endedAt: 9, updatedAt: 9 }),
      sub("tie-early", { startedAt: 1, updatedAt: 5 }),
    ]);
    expect(list.map((s) => s.id)).toEqual(["new-done", "run", "tie-early", "old-done"]);
  });

  test("a task is titled by its description, then its command, and chipped with its kind", () => {
    const task = { description: "", agentType: null, kind: "monitor" as const, command: "tail -f log" };
    expect(isTask(task)).toBe(true);
    expect(isTask({ kind: undefined })).toBe(false);
    expect(subagentTitle(task)).toBe("tail -f log");
    expect(subagentTitle({ ...task, command: null })).toBe("Background task");
    expect(subagentTypeLabel(task)).toBe("Monitor");
    expect(subagentOpenLabel(task)).toBe("Open output");
    expect(subagentOpenLabel({})).toBe("Open transcript");
  });

  test("path walks up to the top-level agent and survives a cycle", () => {
    const s = run([upserted(sub("top")), upserted(sub("mid", { parentId: "top" })), upserted(sub("leaf", { parentId: "mid" })), upserted(sub("x", { parentId: "y" })), upserted(sub("y", { parentId: "x" }))]);
    expect(subagentPath(s, "s1", "leaf").map((a) => a.id)).toEqual(["top", "mid", "leaf"]);
    expect(subagentPath(s, "s1", "x").map((a) => a.id)).toEqual(["y", "x"]);
    expect(subagentPath(s, "s1", "missing")).toEqual([]);
  });
});

describe("task output", () => {
  const out = (text: string, start: number, over: Partial<TaskOutput> = {}): TaskOutput => ({
    text,
    start,
    end: start + Buffer.byteLength(text),
    size: start + Buffer.byteLength(text),
    done: false,
    available: true,
    ...over,
  });
  const fold = (...outs: TaskOutput[]) => outs.reduce<State>((s, output) => reducer(s, { type: "taskOutput", sessionId: "s1", subagentId: "c1", output }), initialState);

  test("appends a slice that starts where the text ends; a repeated poll keeps the same state object", () => {
    const s = fold(out("a\n", 0), out("é\n", 2));
    expect(taskOutputOf(s, "s1", "c1")).toEqual({ text: "a\né\n", end: 5, size: 5, done: false, available: true, truncated: false });
    expect(reducer(s, { type: "taskOutput", sessionId: "s1", subagentId: "c1", output: out("é\n", 2) })).toBe(s);
  });

  test("a gap replaces the text and marks it truncated", () => {
    expect(taskOutputOf(fold(out("a\n", 0), out("z\n", 10)), "s1", "c1")).toMatchObject({ text: "z\n", end: 12, truncated: true });
  });

  test("past the keep limit, the oldest lines are dropped at a line break", () => {
    const line = "x".repeat(99) + "\n";
    const big = line.repeat(TASK_OUTPUT_KEEP_CHARS / 100 + 5);
    const t = taskOutputOf(fold(out(big, 0)), "s1", "c1")!;
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual(TASK_OUTPUT_KEEP_CHARS);
    expect(t.text.startsWith("x")).toBe(true);
    expect(t.text.length % 100).toBe(0);
    expect(t.end).toBe(Buffer.byteLength(big));
  });

  test("output that's gone keeps what was loaded; none loaded is unavailable", () => {
    const gone = { text: "", start: 2, end: 2, size: 0, done: true, available: false };
    expect(taskOutputOf(fold(out("a\n", 0), gone), "s1", "c1")).toMatchObject({ text: "a\n", done: true, available: true });
    expect(taskOutputOf(fold(gone), "s1", "c1")).toMatchObject({ text: "", available: false, done: true });
  });
});
