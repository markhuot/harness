import { describe, expect, test } from "bun:test";
import type { Session, Subagent, TicketDetail, TranscriptEntry } from "../index";
import { initialState, reducer, transcriptKey, type Action, type State } from "./reducer";
import { groupSubagents, subagentById, subagentDuration, subagentPath, subagentsOf, subagentTitle, subagentTranscript, subagentTypeLabel } from "./subagents";
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
    const detail = { ticket: {}, session: { id: "s1" } as Session, summaries: [], runs: [], dependents: [], children: [], subagents: [sub("a", { updatedAt: 15 })] } as unknown as TicketDetail;
    s = run([{ type: "detail", detail }], s);
    expect(subagentById(s, "s1", "a")!.status).toBe("succeeded");
  });

  test("the list is unknown until a detail says; a detail without sub-agents (older service) leaves it unknown", () => {
    const base = { ticket: { id: "t", key: "T-1", kind: "task" }, session: { id: "s1" } as Session, summaries: [], runs: [], dependents: [], children: [] };
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
      expect(effectiveTab("agents", { ...opts, subagents })).toBe("summaries");
      expect(effectiveTab("agent:x", { ...opts, subagents })).toBe("summaries");
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

  test("duration boundaries", () => {
    expect(subagentDuration({ startedAt: 0, endedAt: 59_000 })).toBe("59s");
    expect(subagentDuration({ startedAt: 0, endedAt: 60_000 })).toBe("1m 0s");
    expect(subagentDuration({ startedAt: 0, endedAt: 3_600_000 + 120_000 })).toBe("1h 2m");
    expect(subagentDuration({ startedAt: 1000, endedAt: null }, 6000)).toBe("5s");
    expect(subagentDuration({ startedAt: 5000, endedAt: 1000 })).toBe("0s");
  });

  test("running first (oldest first), then finished newest first", () => {
    const g = groupSubagents([
      sub("old-done", { status: "succeeded", startedAt: 1, endedAt: 2 }),
      sub("run2", { startedAt: 5 }),
      sub("new-done", { status: "failed", startedAt: 3, endedAt: 9 }),
      sub("run1", { startedAt: 4 }),
    ]);
    expect(g.running.map((s) => s.id)).toEqual(["run2", "run1"]);
    expect(g.finished.map((s) => s.id)).toEqual(["new-done", "old-done"]);
  });

  test("path walks up to the top-level agent and survives a cycle", () => {
    const s = run([upserted(sub("top")), upserted(sub("mid", { parentId: "top" })), upserted(sub("leaf", { parentId: "mid" })), upserted(sub("x", { parentId: "y" })), upserted(sub("y", { parentId: "x" }))]);
    expect(subagentPath(s, "s1", "leaf").map((a) => a.id)).toEqual(["top", "mid", "leaf"]);
    expect(subagentPath(s, "s1", "x").map((a) => a.id)).toEqual(["y", "x"]);
    expect(subagentPath(s, "s1", "missing")).toEqual([]);
  });
});
