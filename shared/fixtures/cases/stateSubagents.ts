// Sub-agent state and labels (shared/src/state/subagents.ts, the subagents.test.ts cases outside
// tabs) for HarnessKit's Subagents.swift. See ../board.ts for the scenario format.
import { groupSubagents, subagentDuration, subagentTitle, subagentTypeLabel, SUBAGENT_STATUS_LABEL } from "../../src/state";
import type { Subagent } from "../../src/protocol";
import { cases } from "../case";
import { detail, entry, ev, scenario, sub, ticket } from "../board";

const e = (seq: number, subagentId: string | null | undefined, text = `e${seq}`) =>
  entry(`e${seq}`, seq, { ...(subagentId === undefined ? {} : { subagentId }), content: { type: "text", text } });
const appended = (x: ReturnType<typeof e>) => ev({ kind: "transcript.appended", entry: x });
const upserted = (subagent: Subagent) => ev({ kind: "subagent.upserted", subagent });
const s1Detail = (subagents?: Subagent[]) => detail(ticket("t", { key: "T-1", sessionId: "s1" }), subagents ? { subagents } : {});

export const statusLabel = SUBAGENT_STATUS_LABEL;

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
});

export const typeLabelCases = cases(subagentTypeLabel, {
  "hidden when it is the title": { description: "", agentType: "Explore" },
  shown: { description: "Scan", agentType: "Explore" },
  "no type": { description: "Scan", agentType: null },
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

export const groupCases = cases(groupSubagents, {
  "running first, finished newest first": [
    sub("old-done", { status: "succeeded", startedAt: 1, endedAt: 2 }),
    sub("run2", { startedAt: 5 }),
    sub("new-done", { status: "failed", startedAt: 3, endedAt: 9 }),
    sub("run1", { startedAt: 4 }),
  ],
  "finished without endedAt sort by start; ties keep order": [
    sub("s1", { status: "stopped", startedAt: 4, endedAt: null }),
    sub("s2", { status: "succeeded", startedAt: 1, endedAt: 4 }),
    sub("s3", { status: "failed", startedAt: 7, endedAt: null }),
  ],
});
