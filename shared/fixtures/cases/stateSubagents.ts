// Sub-agent state and labels (shared/src/state/subagents.ts, the subagents.test.ts cases outside
// tabs) for HarnessKit's Subagents.swift. See ../board.ts for the scenario format.
import { filterSubagents, sortSubagents, subagentCounts, subagentDuration, subagentModelLabel, subagentOpenLabel, subagentTitle, subagentTypeLabel, SUBAGENT_STATUS_LABEL, TASK_KIND_LABEL, TASK_OUTPUT_KEEP_CHARS, TASK_OUTPUT_POLL_MS, type SubagentFilter } from "../../src/state";
import type { Subagent, TaskOutput } from "../../src/protocol";
import { cases } from "../case";
import { detail, entry, ev, scenario, sub, ticket } from "../board";

const e = (seq: number, subagentId: string | null | undefined, text = `e${seq}`) =>
  entry(`e${seq}`, seq, { ...(subagentId === undefined ? {} : { subagentId }), content: { type: "text", text } });
const appended = (x: ReturnType<typeof e>) => ev({ kind: "transcript.appended", entry: x });
const upserted = (subagent: Subagent) => ev({ kind: "subagent.upserted", subagent });
const s1Detail = (subagents?: Subagent[]) => detail(ticket("t", { key: "T-1", sessionId: "s1" }), subagents ? { subagents } : {});

export const statusLabel = SUBAGENT_STATUS_LABEL;
export const taskKindLabel = TASK_KIND_LABEL;
export const taskOutputKeepChars = TASK_OUTPUT_KEEP_CHARS;
export const taskOutputPollMs = TASK_OUTPUT_POLL_MS;

const out = (text: string, start: number, over: Partial<TaskOutput> = {}): TaskOutput => ({
  text,
  start,
  end: start + new TextEncoder().encode(text).length,
  size: start + new TextEncoder().encode(text).length,
  done: false,
  available: true,
  ...over,
});
const taskOutput = (output: TaskOutput, subagentId = "c1") => ({ type: "taskOutput" as const, sessionId: "s1", subagentId, output });

export const scenarios = [
  scenario("live entries go to the sub-agent's transcript, not the session's", [
    { actions: [appended(e(1, null)), appended(e(2, "a")), appended(e(3, undefined))], probes: [["transcript", "s1"], ["subagentTranscript", "s1", "a"], ["subagentTranscript", "s1", "b"]] },
  ]),
  scenario("a sub-agent backfill merges with live entries and marks only that transcript loaded", [
    { actions: [appended(e(5, "a")), { type: "transcript", sessionId: "s1", subagentId: "a", entries: [e(2, "a"), e(5, "a")] }], probes: [["subagentTranscript", "s1", "a"], ["transcript", "s1"]] },
  ]),
  scenario("sub-agent text doesn't clear the session agent's streaming preview", [
    { actions: [ev({ kind: "transcript.delta", sessionId: "s1", runId: "r1", text: "Hel" }), appended(e(1, "a"))], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("upserts keep start order; a stale copy doesn't overwrite a newer one", [
    { actions: [upserted(sub("b", { startedAt: 20 })), upserted(sub("a", { startedAt: 5 }))], probes: [["subagentsOf", "s1"]] },
    { actions: [upserted(sub("a", { status: "succeeded", updatedAt: 30 })), { type: "detail", detail: s1Detail([sub("a", { updatedAt: 15 })]) }], probes: [["subagentById", "s1", "a"], ["subagentsOf", "s1"]] },
    // An equal updatedAt replaces (<=).
    { actions: [{ type: "subagents", sessionId: "s1", subagents: [sub("a", { status: "failed", updatedAt: 30 })] }], probes: [["subagentById", "s1", "a"]] },
  ]),
  scenario("the list is unknown until a detail says; a detail without sub-agents (older service) leaves it unknown", [
    { probes: [["subagentsOf", "s1"]] },
    { actions: [{ type: "detail", detail: s1Detail() }], probes: [["subagentsOf", "s1"]] },
    { actions: [{ type: "detail", detail: s1Detail([]) }], probes: [["subagentsOf", "s1"]] },
  ]),
  scenario("an all-stale sub-agents action leaves a known list alone", [
    { actions: [upserted(sub("a", { updatedAt: 9 })), { type: "subagents", sessionId: "s1", subagents: [sub("a", { status: "failed", updatedAt: 1 })] }], probes: [["subagentById", "s1", "a"]] },
  ]),
  scenario("a task's output: the first read replaces, the next appends, a repeat only updates done", [
    { actions: [taskOutput(out("line 1\n", 0))], probes: [["taskOutputOf", "s1", "c1"], ["taskOutputOf", "s1", "other"]] },
    { actions: [taskOutput(out("liné 2\n", 7))], probes: [["taskOutputOf", "s1", "c1"]] },
    { actions: [taskOutput(out("liné 2\n", 7, { done: true }))], probes: [["taskOutputOf", "s1", "c1"]] },
  ]),
  scenario("a task's output after a gap (a burst bigger than one read) starts over, truncated", [
    { actions: [taskOutput(out("a\n", 0)), taskOutput(out("z\n", 900_000))], probes: [["taskOutputOf", "s1", "c1"]] },
  ]),
  scenario("a tail that doesn't start at 0 is truncated; output that's gone keeps what was loaded", [
    { actions: [taskOutput(out("tail\n", 40))], probes: [["taskOutputOf", "s1", "c1"]] },
    { actions: [taskOutput({ text: "", start: 45, end: 45, size: 0, done: true, available: false })], probes: [["taskOutputOf", "s1", "c1"]] },
    { actions: [taskOutput({ text: "", start: 0, end: 0, size: 0, done: false, available: false }, "c2")], probes: [["taskOutputOf", "s1", "c2"]] },
  ]),
  scenario("path walks up to the top-level agent and survives a cycle", [
    {
      actions: [upserted(sub("top")), upserted(sub("mid", { parentId: "top" })), upserted(sub("leaf", { parentId: "mid" })), upserted(sub("x", { parentId: "y" })), upserted(sub("y", { parentId: "x" }))],
      probes: [["subagentPath", "s1", "leaf"], ["subagentPath", "s1", "x"], ["subagentPath", "s1", "missing"], ["subagentPath", "nope", "leaf"]],
    },
  ]),
];

export const titleCases = cases(subagentTitle, {
  "blank description falls back to the type": { description: "  ", agentType: "Explore" },
  "nothing at all": { description: "", agentType: null },
  "description trimmed": { description: "  Scan the repo ", agentType: "Explore" },
  "empty type": { description: "", agentType: "" },
  "a task's description": { description: "Run the tests", agentType: null, kind: "bash", command: "bun test" },
  "a task without one falls back to its command": { description: " ", agentType: null, kind: "monitor", command: " tail -f log " },
  "a task with neither": { description: "", agentType: null, kind: "bash", command: null },
  "an explicit agent kind": { description: "", agentType: "Explore", kind: "agent", command: null },
});

export const openLabelCases = cases(subagentOpenLabel, {
  agent: { kind: "agent" },
  "older service (no kind)": {},
  bash: { kind: "bash" },
  monitor: { kind: "monitor" },
});

export const typeLabelCases = cases(subagentTypeLabel, {
  "hidden when it is the title": { description: "", agentType: "Explore" },
  shown: { description: "Scan", agentType: "Explore" },
  "no type": { description: "Scan", agentType: null },
  "a Bash task": { description: "Run the tests", agentType: null, kind: "bash" },
  "a Monitor": { description: "", agentType: null, kind: "monitor" },
});

export const modelLabelCases = cases(({ model }: { model: string | null }) => subagentModelLabel(model), {
  "unknown": { model: null },
  "blank": { model: "  " },
  "a dated id": { model: "claude-haiku-4-5-20251001" },
  "an undated id": { model: "claude-opus-5-5" },
  "a major version only, dated (the date isn't a minor version)": { model: "claude-sonnet-4-20250514" },
  "the older version-first form": { model: "claude-3-5-sonnet-20241022" },
  "the older form, major only": { model: "claude-3-opus-20240229" },
  "an alias": { model: "haiku" },
  "a 1M context id": { model: "claude-opus-4-6[1m]" },
  "a 1M context alias": { model: "sonnet[1m]" },
  "another provider's id as is": { model: "gpt-5.1-codex" },
  "a Bedrock id as is": { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
});

export const durationCases = cases(({ startedAt, endedAt, now }: { startedAt: number; endedAt: number | null; now?: number }) => subagentDuration({ startedAt, endedAt }, now ?? 0), {
  "59s": { startedAt: 0, endedAt: 59_000 },
  "1m 0s": { startedAt: 0, endedAt: 60_000 },
  "1h 2m": { startedAt: 0, endedAt: 3_600_000 + 120_000 },
  "running uses now": { startedAt: 1000, endedAt: null, now: 6000 },
  "negative clamps": { startedAt: 5000, endedAt: 1000 },
  "rounds half up": { startedAt: 0, endedAt: 59_500 },
  "just under a minute rounds to 1m": { startedAt: 0, endedAt: 59_600 },
  "days stay in hours": { startedAt: 0, endedAt: 90_000_000 },
});

export const sortCases = cases(sortSubagents, {
  "latest update first, running or not": [
    sub("old-done", { status: "succeeded", startedAt: 1, endedAt: 2, updatedAt: 2 }),
    sub("run2", { startedAt: 5, updatedAt: 5 }),
    sub("new-done", { status: "failed", startedAt: 3, endedAt: 9, updatedAt: 9 }),
    sub("task", { kind: "bash", command: "make", startedAt: 4, updatedAt: 7 }),
  ],
  "ties go to the later start": [
    sub("s1", { status: "stopped", startedAt: 4, updatedAt: 8 }),
    sub("s2", { status: "succeeded", startedAt: 1, updatedAt: 8 }),
    sub("s3", { startedAt: 7, updatedAt: 8 }),
  ],
});

const mixed = [
  sub("a1"),
  sub("b1", { kind: "bash", command: "make" }),
  sub("a2", { kind: "agent" }),
  sub("m1", { kind: "monitor", command: "tail -f log" }),
];

export const filterCases = cases(({ list, filter }: { list: Subagent[]; filter: SubagentFilter }) => filterSubagents(list, filter), {
  "agents only": { list: mixed, filter: { agents: true, tasks: false } },
  "tasks only": { list: mixed, filter: { agents: false, tasks: true } },
  "both shows everything": { list: mixed, filter: { agents: true, tasks: true } },
  "neither shows everything": { list: mixed, filter: { agents: false, tasks: false } },
  "tasks only with none": { list: [sub("a1")], filter: { agents: false, tasks: true } },
});

export const countsCases = cases(subagentCounts, {
  "mixed, a row without a kind counts as an agent": mixed,
  empty: [],
  "tasks only": [sub("b1", { kind: "bash" }), sub("m1", { kind: "monitor" })],
});
