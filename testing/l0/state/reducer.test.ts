import { describe, expect, test } from "bun:test";
import type { ActivityEntry, Project, Run, Session, Subagent, TaskOutput, Ticket, TicketDetail, TicketPage, TranscriptEntry } from "../../../shared/src/index";
import {
  NEWS_KINDS,
  TASK_OUTPUT_KEEP_CHARS,
  applyEvent,
  boardColumns,
  composerCandidates,
  composerProject,
  conductorsNeedingChildren,
  defaultDriverOf,
  defaultModelOf,
  dependencyStates,
  dependentsOf,
  hasCustomDriver,
  hasCustomModel,
  initialState,
  isReady,
  latestActivity,
  liveDelta,
  mergeById,
  mergeTaskOutput,
  positionForDrop,
  reducer,
  sortedProjects,
  specBody,
  specBodyKey,
  ticketByKey,
  ticketLinkable,
  ticketsForProject,
  transcriptKey,
  triageSessions,
  unresolvedKeys,
  type Snapshot,
  type State,
  type TaskOutputState,
} from "../../../shared/src/state/reducer";
import { makeTicket } from "../../builders/ticket";

// --- minimal builders -------------------------------------------------------------------------

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => makeTicket({ status: "planning", key, id: `id-${key}`, ...over });
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, key: id.toUpperCase(), name: id, ...over }) as Project;
const session = (id: string, over: Partial<Session> = {}): Session => ({ id, key: id, kind: "ticket", busy: false, createdAt: 0, updatedAt: 0, outcome: null, ...over }) as Session;
const run = (id: string, sessionId: string, status: Run["status"], over: Partial<Run> = {}): Run => ({ id, sessionId, kind: "work", status, ...over }) as Run;
const entry = (id: string, seq: number, over: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ id, sessionId: "s1", runId: "r1", subagentId: null, seq, role: "assistant", content: { type: "text", text: id }, createdAt: seq, ...over }) as TranscriptEntry;
const sub = (id: string, over: Partial<Subagent> = {}): Subagent => ({ id, sessionId: "s1", startedAt: 0, updatedAt: 0, ...over }) as Subagent;
const act = (id: string, createdAt: number, over: Partial<ActivityEntry> = {}): ActivityEntry => ({ id, sessionId: "s1", kind: "note", createdAt, ...over }) as ActivityEntry;
const withState = (patch: Partial<State>): State => ({ ...initialState, ...patch });
const tickets = (...ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const page = (ts: Ticket[], over: Partial<TicketPage> = {}): TicketPage => ({ tickets: ts, total: ts.length, nextCursor: null, ...over }) as TicketPage;
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ projects: [], tickets: [], sessions: [], watchers: [], settings: null, drivers: [], ...over });
const detail = (t: Ticket, over: Partial<TicketDetail> = {}): TicketDetail =>
  ({ ticket: t, session: session(t.sessionId), activity: [], runs: [], dependents: [], children: [], ...over }) as TicketDetail;
const event = (state: State, e: Parameters<typeof applyEvent>[1]) => applyEvent(state, e);

// --- mergeById ----------------------------------------------------------------------------------

describe("mergeById", () => {
  test("returns the same array when there is nothing incoming", () => {
    const existing = [{ id: "a", n: 1 }];
    expect(mergeById(existing, [], (x) => x.n)).toBe(existing);
  });

  test("newer wins by id, result sorted by order then id", () => {
    const out = mergeById([{ id: "a", n: 2 }, { id: "b", n: 1 }], [{ id: "a", n: 0 }, { id: "c", n: 1 }], (x) => x.n);
    expect(out).toEqual([{ id: "a", n: 0 }, { id: "b", n: 1 }, { id: "c", n: 1 }]);
  });
});

// --- mergeTaskOutput ----------------------------------------------------------------------------

describe("mergeTaskOutput", () => {
  const out = (over: Partial<TaskOutput> = {}): TaskOutput => ({ text: "abc", start: 0, end: 3, size: 3, done: false, available: true, ...over });
  const loaded = (over: Partial<TaskOutputState> = {}): TaskOutputState => ({ text: "abc", end: 3, size: 3, done: false, available: true, truncated: false, ...over });

  test("the first read replaces; starting past zero marks it truncated", () => {
    expect(mergeTaskOutput(undefined, out())).toEqual(loaded());
    expect(mergeTaskOutput(undefined, out({ start: 10, end: 13 })).truncated).toBe(true);
  });

  test("a slice starting where the text ends is appended", () => {
    const next = mergeTaskOutput(loaded(), out({ text: "def", start: 3, end: 6, size: 6, done: true }));
    expect(next).toMatchObject({ text: "abcdef", end: 6, size: 6, done: true });
  });

  test("an already-covered slice only updates done, returning the same object when nothing changes", () => {
    const prev = loaded();
    expect(mergeTaskOutput(prev, out({ start: 0, end: 3 }))).toBe(prev);
    expect(mergeTaskOutput(prev, out({ start: 0, end: 3, done: true }))).toEqual({ ...prev, done: true });
  });

  test("a gap replaces the text, and truncated reflects the new start", () => {
    const next = mergeTaskOutput(loaded(), out({ text: "xyz", start: 50, end: 53 }));
    expect(next).toMatchObject({ text: "xyz", end: 53, truncated: true });
  });

  test("a slice that starts inside the text but runs past its end replaces it", () => {
    const next = mergeTaskOutput(loaded(), out({ text: "bcdef", start: 1, end: 6 }));
    expect(next.text).toBe("bcdef");
    expect(next.truncated).toBe(true);
  });

  test("unavailable output with nothing loaded", () => {
    expect(mergeTaskOutput(undefined, out({ available: false, end: 7, done: true }))).toEqual({ text: "", end: 7, size: 0, done: true, available: false, truncated: false });
  });

  test("unavailable output after text loaded keeps the text, and stays available only if there is some", () => {
    expect(mergeTaskOutput(loaded(), out({ available: false, done: true }))).toMatchObject({ text: "abc", done: true, available: true });
    expect(mergeTaskOutput(loaded({ text: "" }), out({ available: false }))).toMatchObject({ available: false });
  });

  test("text beyond the cap is trimmed to a line boundary when one is near, flagged truncated", () => {
    const long = "x".repeat(100) + "\n" + "y".repeat(TASK_OUTPUT_KEEP_CHARS - 50);
    const next = mergeTaskOutput(undefined, out({ text: long, end: long.length, size: long.length }));
    expect(next.truncated).toBe(true);
    expect(next.text).toBe("y".repeat(TASK_OUTPUT_KEEP_CHARS - 50));
  });

  test("with no newline nearby it cuts exactly at the cap", () => {
    const long = "x".repeat(TASK_OUTPUT_KEEP_CHARS + 10);
    const next = mergeTaskOutput(undefined, out({ text: long, end: long.length }));
    expect(next.text.length).toBe(TASK_OUTPUT_KEEP_CHARS);
    expect(next.truncated).toBe(true);
  });

  test("a newline too far from the cut (4096+) isn't used", () => {
    const long = "x".repeat(5010) + "\n" + "y".repeat(TASK_OUTPUT_KEEP_CHARS - 5001);
    const next = mergeTaskOutput(undefined, out({ text: long, end: long.length }));
    expect(next.text.length).toBe(TASK_OUTPUT_KEEP_CHARS);
    expect(next.text.startsWith("x")).toBe(true);
  });

  test("text exactly at the cap is left whole", () => {
    const exact = "x".repeat(TASK_OUTPUT_KEEP_CHARS);
    expect(mergeTaskOutput(undefined, out({ text: exact })).truncated).toBe(false);
  });
});

// --- transcriptKey / specBodyKey -----------------------------------------------------------------

describe("keys", () => {
  test("transcriptKey: the session alone, or session/sub-agent; empty or null sub-agent is the session's", () => {
    expect(transcriptKey("s")).toBe("s");
    expect(transcriptKey("s", null)).toBe("s");
    expect(transcriptKey("s", "")).toBe("s");
    expect(transcriptKey("s", "a")).toBe("s/a");
  });

  test("specBodyKey joins ticket and revision", () => {
    expect(specBodyKey("t", 3)).toBe("t#3");
  });
});

// --- applyEvent ---------------------------------------------------------------------------------

describe("applyEvent: projects", () => {
  test("upserting a project adds it without touching paging when its group is unchanged", () => {
    const st = withState({ projects: { p: project("p", { group: "g" }) }, donePaging: { "group:g": { total: 1 } as never } });
    const next = event(st, { kind: "project.upserted", project: project("p", { group: "g", name: "renamed" }) });
    expect(next.projects.p!.name).toBe("renamed");
    expect(next.donePaging).toBe(st.donePaging);
  });

  test("moving between groups drops the paging of both groups and keeps the rest", () => {
    const st = withState({
      projects: { p: project("p", { group: "a" }) },
      donePaging: { "group:a": { total: 1 } as never, "group:b": { total: 2 } as never, "group:c": { total: 3 } as never, "*": { total: 4 } as never },
    });
    const next = event(st, { kind: "project.upserted", project: project("p", { group: "b" }) });
    expect(Object.keys(next.donePaging).sort()).toEqual(["*", "group:c"]);
  });

  test("joining a group from none, and leaving one to none, drop only the group's paging", () => {
    const st = withState({ projects: { p: project("p") }, donePaging: { "group:a": {} as never, "*": {} as never } });
    expect(Object.keys(event(st, { kind: "project.upserted", project: project("p", { group: "a" }) }).donePaging)).toEqual(["*"]);
    const st2 = withState({ projects: { p: project("p", { group: "a" }) }, donePaging: { "group:a": {} as never, "*": {} as never } });
    expect(Object.keys(event(st2, { kind: "project.upserted", project: project("p", { group: null }) }).donePaging)).toEqual(["*"]);
  });

  test("a brand-new ungrouped project changes no paging (undefined group equals null)", () => {
    const st = withState({ donePaging: { "*": {} as never } });
    const next = event(st, { kind: "project.upserted", project: project("p") });
    expect(next.donePaging).toBe(st.donePaging);
  });

  test("deleting a project removes it and its tickets only", () => {
    const st = withState({ projects: { p: project("p"), q: project("q") }, tickets: tickets(ticket("P-1", { projectId: "p" }), ticket("Q-1", { projectId: "q" })) });
    const next = event(st, { kind: "project.deleted", id: "p" });
    expect(Object.keys(next.projects)).toEqual(["q"]);
    expect(Object.values(next.tickets).map((t) => t.key)).toEqual(["Q-1"]);
  });
});

describe("applyEvent: tickets", () => {
  test("upsert stores the ticket", () => {
    const t = ticket("A-1");
    expect(event(initialState, { kind: "ticket.upserted", ticket: t }).tickets[t.id]).toBe(t);
  });

  test("upsert re-marks the approved baseline on a loaded revision list; an unloaded list stays unloaded", () => {
    const revs = [1, 2, 3].map((rev) => ({ rev, approvedBaseline: rev === 1 })) as never[];
    const t = ticket("A-1", { specBaselineRevision: 2 });
    const st = withState({ specRevisions: { [t.id]: revs } });
    const next = event(st, { kind: "ticket.upserted", ticket: t });
    expect(next.specRevisions[t.id]!.map((r) => r.approvedBaseline)).toEqual([false, true, false]);
    expect(event(initialState, { kind: "ticket.upserted", ticket: t }).specRevisions).toEqual({});
  });

  test("upsert with the baseline already right keeps the same list object; a cleared baseline clears marks", () => {
    const revs = [{ rev: 1, approvedBaseline: true }, { rev: 2, approvedBaseline: false }] as never[];
    const t = ticket("A-1", { specBaselineRevision: 1 });
    const st = withState({ specRevisions: { [t.id]: revs } });
    expect(event(st, { kind: "ticket.upserted", ticket: t }).specRevisions[t.id]).toBe(revs);
    const cleared = event(st, { kind: "ticket.upserted", ticket: ticket("A-1", { specBaselineRevision: null }) });
    expect(cleared.specRevisions[t.id]!.every((r) => !r.approvedBaseline)).toBe(true);
  });

  test("upsert with the baseline field absent leaves the marks as they were", () => {
    const revs = [{ rev: 1, approvedBaseline: true }] as never[];
    const t = ticket("A-1");
    const st = withState({ specRevisions: { [t.id]: revs } });
    expect(event(st, { kind: "ticket.upserted", ticket: t }).specRevisions[t.id]).toBe(revs);
  });

  test("a ticket finishing moves the board's done total up; leaving done moves it down, never below zero", () => {
    const open = ticket("A-1", { status: "in_progress", projectId: "p" });
    const paging = { total: 5, nextCursor: null, loading: false, frontier: null, newest: null, error: null };
    const st = withState({ tickets: tickets(open), projects: { p: project("p") }, donePaging: { "*": paging } });
    const done = event(st, { kind: "ticket.upserted", ticket: { ...open, status: "done" } as Ticket });
    expect(done.donePaging["*"]!.total).toBe(6);
    const reopened = event(done, { kind: "ticket.upserted", ticket: open });
    expect(reopened.donePaging["*"]!.total).toBe(5);
    const zero = withState({ tickets: tickets({ ...open, status: "done" } as Ticket), donePaging: { "*": { ...paging, total: 0 } } });
    expect(event(zero, { kind: "ticket.upserted", ticket: open }).donePaging["*"]!.total).toBe(0);
  });

  test("deleting a done ticket lowers the total; deleting an unknown id changes nothing", () => {
    const done = ticket("A-1", { status: "done", projectId: "p" });
    const paging = { total: 5, nextCursor: null, loading: false, frontier: null, newest: null, error: null };
    const st = withState({ tickets: tickets(done), donePaging: { "*": paging } });
    const next = event(st, { kind: "ticket.deleted", id: done.id });
    expect(next.tickets).toEqual({});
    expect(next.donePaging["*"]!.total).toBe(4);
    const unknown = event(st, { kind: "ticket.deleted", id: "nope" });
    expect(unknown.tickets).toBe(st.tickets);
    expect(unknown.donePaging).toBe(st.donePaging);
  });

  test("an unloaded ticket that finishes after the first page's newest adds to the total; an older one is already counted", () => {
    const paging = { total: 5, nextCursor: null, loading: false, frontier: null, newest: 100, error: null };
    const st = withState({ donePaging: { "*": paging } });
    const newer = event(st, { kind: "ticket.upserted", ticket: ticket("A-1", { status: "done", completedAt: 200 }) });
    expect(newer.donePaging["*"]!.total).toBe(6);
    const older = event(st, { kind: "ticket.upserted", ticket: ticket("A-2", { status: "done", completedAt: 50 }) });
    expect(older.donePaging["*"]!.total).toBe(5);
  });

  test("an unloaded open ticket created before the snapshot was a reopened done one (total drops); a newer one is simply new", () => {
    const paging = { total: 5, nextCursor: null, loading: false, frontier: null, newest: null, error: null };
    const st = withState({ donePaging: { "*": paging }, ticketsAsOf: 100 });
    expect(event(st, { kind: "ticket.upserted", ticket: ticket("A-1", { createdAt: 50 }) }).donePaging["*"]!.total).toBe(4);
    expect(event(st, { kind: "ticket.upserted", ticket: ticket("A-2", { createdAt: 150 }) }).donePaging["*"]!.total).toBe(5);
    expect(event({ ...st, ticketsAsOf: null }, { kind: "ticket.upserted", ticket: ticket("A-3", { createdAt: 50 }) }).donePaging["*"]!.total).toBe(5);
  });

  test("totals only change for scopes the ticket belongs to", () => {
    const paging = { total: 5, nextCursor: null, loading: false, frontier: null, newest: null, error: null };
    const st = withState({ donePaging: { other: paging }, tickets: tickets(ticket("A-1", { projectId: "p", status: "in_progress" })) });
    const next = event(st, { kind: "ticket.upserted", ticket: ticket("A-1", { projectId: "p", status: "done" }) });
    expect(next.donePaging).toBe(st.donePaging);
  });
});

describe("applyEvent: sessions and runs", () => {
  test("session upsert stores by id", () => {
    expect(event(initialState, { kind: "session.upserted", session: session("s1") }).sessions.s1!.id).toBe("s1");
  });

  test("a terminal run clears just its own delta; a live run leaves deltas alone", () => {
    const st = withState({ deltas: { s1: { r1: "a", r2: "b" } } });
    const ended = event(st, { kind: "run.upserted", run: run("r1", "s1", "succeeded") });
    expect(ended.deltas).toEqual({ s1: { r2: "b" } });
    for (const status of ["failed", "cancelled"] as const) expect(event(st, { kind: "run.upserted", run: run("r1", "s1", status) }).deltas.s1).toEqual({ r2: "b" });
    const live = event(st, { kind: "run.upserted", run: run("r1", "s1", "running") });
    expect(live.deltas).toBe(st.deltas);
    expect(live.runs.r1!.status).toBe("running");
  });

  test("the last delta of a session removes the session's entry", () => {
    const st = withState({ deltas: { s1: { r1: "a" } } });
    expect(event(st, { kind: "run.upserted", run: run("r1", "s1", "succeeded") }).deltas).toEqual({});
  });

  test("a terminal run with no delta changes nothing in deltas", () => {
    const st = withState({ deltas: { s1: { r2: "b" } } });
    expect(event(st, { kind: "run.upserted", run: run("r1", "s1", "succeeded") }).deltas).toBe(st.deltas);
    const other = withState({ deltas: { s9: { r1: "b" } } });
    expect(event(other, { kind: "run.upserted", run: run("r1", "s1", "succeeded") }).deltas).toBe(other.deltas);
  });
});

describe("applyEvent: transcript", () => {
  test("appended entries merge into the session's transcript in seq order, replacing by id", () => {
    let st = event(initialState, { kind: "transcript.appended", entry: entry("b", 2, { role: "user" }) });
    st = event(st, { kind: "transcript.appended", entry: entry("a", 1, { role: "user" }) });
    st = event(st, { kind: "transcript.appended", entry: entry("b", 2, { role: "user", content: { type: "text", text: "edited" } }) });
    expect(st.transcripts.s1!.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect((st.transcripts.s1!.entries[1]!.content as { text: string }).text).toBe("edited");
    expect(st.transcripts.s1!.loaded).toBe(false);
  });

  test("a sub-agent's entry lands under its own key and leaves the streamed preview alone", () => {
    const st = withState({ deltas: { s1: { r1: "streaming" } } });
    const next = event(st, { kind: "transcript.appended", entry: entry("x", 1, { subagentId: "ag" }) });
    expect(Object.keys(next.transcripts)).toEqual(["s1/ag"]);
    expect(next.deltas).toBe(st.deltas);
  });

  test("the persisted assistant text replaces that run's preview", () => {
    const st = withState({ deltas: { s1: { r1: "streaming", r2: "other" } } });
    const next = event(st, { kind: "transcript.appended", entry: entry("x", 1) });
    expect(next.deltas).toEqual({ s1: { r2: "other" } });
  });

  test("a user message, a tool call, or an entry with no run doesn't clear the preview", () => {
    const st = withState({ deltas: { s1: { r1: "streaming" } } });
    expect(event(st, { kind: "transcript.appended", entry: entry("x", 1, { role: "user" }) }).deltas).toBe(st.deltas);
    expect(event(st, { kind: "transcript.appended", entry: entry("y", 2, { content: { type: "tool_use" } as never }) }).deltas).toBe(st.deltas);
    // runId null: clearDelta(…, null) would wipe the whole session, which must not happen for runless text
    const runless = event(st, { kind: "transcript.appended", entry: entry("z", 3, { runId: null }) });
    expect(runless.deltas).toEqual({});
  });

  test("deltas accumulate per run", () => {
    let st = event(initialState, { kind: "transcript.delta", sessionId: "s1", runId: "r1", text: "He" });
    st = event(st, { kind: "transcript.delta", sessionId: "s1", runId: "r1", text: "llo" });
    st = event(st, { kind: "transcript.delta", sessionId: "s1", runId: "r2", text: "x" });
    expect(st.deltas).toEqual({ s1: { r1: "Hello", r2: "x" } });
  });
});

describe("applyEvent: sub-agents, activity, spec, watchers, settings", () => {
  test("a stale sub-agent copy never replaces a newer one; an equal or newer one does", () => {
    let st = event(initialState, { kind: "subagent.upserted", subagent: sub("a", { updatedAt: 10, status: "succeeded" }) });
    st = event(st, { kind: "subagent.upserted", subagent: sub("a", { updatedAt: 5, status: "running" }) });
    expect(st.subagents.s1![0]!.status).toBe("succeeded");
    st = event(st, { kind: "subagent.upserted", subagent: sub("a", { updatedAt: 10, status: "failed" }) });
    expect(st.subagents.s1![0]!.status).toBe("failed");
  });

  test("stale copy against existing list returns the very same subagents map", () => {
    const st = event(initialState, { kind: "subagent.upserted", subagent: sub("a", { updatedAt: 10 }) });
    expect(event(st, { kind: "subagent.upserted", subagent: sub("a", { updatedAt: 1 }) }).subagents).toBe(st.subagents);
  });

  test("sub-agents sort by start time", () => {
    let st = event(initialState, { kind: "subagent.upserted", subagent: sub("late", { startedAt: 9 }) });
    st = event(st, { kind: "subagent.upserted", subagent: sub("early", { startedAt: 1 }) });
    expect(st.subagents.s1!.map((s) => s.id)).toEqual(["early", "late"]);
  });

  test("activity merges by id, ordered by time", () => {
    let st = event(initialState, { kind: "activity.added", entry: act("b", 2) });
    st = event(st, { kind: "activity.added", entry: act("a", 1) });
    st = event(st, { kind: "activity.added", entry: act("b", 2, { body: "again" }) });
    expect(st.activity.s1!.map((e) => e.id)).toEqual(["a", "b"]);
    expect(st.activity.s1![1]!.body).toBe("again");
  });

  test("spec.revised is ignored until the list was loaded, then adds the revision with defaults", () => {
    const e = { kind: "spec.revised", ticketId: "t", rev: 2, author: "agent", note: "n" } as const;
    expect(event(initialState, e)).toBe(initialState);
    const st = withState({ specRevisions: { t: [{ rev: 1, approvedBaseline: true }] as never[] } });
    const next = event(st, e);
    expect(next.specRevisions.t).toHaveLength(2);
    expect(next.specRevisions.t![1]).toEqual({ rev: 2, author: "agent", note: "n", runId: null, runKind: null, approvedBaseline: false, createdAt: 0 });
  });

  test("spec.revised with a rev already listed replaces it", () => {
    const st = withState({ specRevisions: { t: [{ rev: 1, note: "old", approvedBaseline: true }] as never[] } });
    const next = event(st, { kind: "spec.revised", ticketId: "t", rev: 1, author: "human", note: "new", createdAt: 7 });
    expect(next.specRevisions.t).toHaveLength(1);
    expect(next.specRevisions.t![0]).toMatchObject({ note: "new", createdAt: 7, approvedBaseline: false });
  });

  test("watchers add and delete; deleting an unknown id keeps the object", () => {
    const w = { id: "w1" } as never;
    const st = event(initialState, { kind: "watcher.upserted", watcher: w });
    expect(st.watchers.w1).toBe(w);
    expect(event(st, { kind: "watcher.deleted", id: "w1" }).watchers).toEqual({});
    expect(event(st, { kind: "watcher.deleted", id: "zz" }).watchers).toBe(st.watchers);
  });

  test("settings.updated stores the settings", () => {
    const s = { defaultDriver: "x" } as never;
    expect(event(initialState, { kind: "settings.updated", settings: s }).settings).toBe(s);
  });

  test("browser frames and unknown events leave the state untouched", () => {
    expect(event(initialState, { kind: "browser.frame", sessionId: "s", data: "", width: 1, height: 1 })).toBe(initialState);
    expect(event(initialState, { kind: "devices.changed" })).toBe(initialState);
  });
});

// --- reducer ------------------------------------------------------------------------------------

describe("reducer: connected", () => {
  test("a repeat value returns the same state; a change creates a new one", () => {
    expect(reducer(initialState, { type: "connected", connected: false })).toBe(initialState);
    expect(reducer(initialState, { type: "connected", connected: true }).connected).toBe(true);
  });
});

describe("reducer: snapshot", () => {
  test("replaces the entity lists, marks ready, and records the newest createdAt", () => {
    const old = ticket("A-1", { createdAt: 5 });
    const st = withState({ tickets: tickets(old), watchers: { gone: {} as never }, keyAliases: { X: "y" }, missingKeys: { Z: true }, childrenLoaded: { c: true }, dependents: { t: ["A"] } });
    const next = reducer(st, { type: "snapshot", snapshot: snapshot({ tickets: [ticket("B-1", { createdAt: 9 }), ticket("B-2", { createdAt: 3 })] }) });
    expect(next.ready).toBe(true);
    expect(Object.values(next.tickets).map((t) => t.key).sort()).toEqual(["B-1", "B-2"]);
    expect(next.watchers).toEqual({});
    expect(next.ticketsAsOf).toBe(9);
    expect(next.keyAliases).toEqual({});
    expect(next.missingKeys).toEqual({});
    expect(next.childrenLoaded).toEqual({});
    expect(next.dependents).toEqual({});
  });

  test("an empty snapshot gives ticketsAsOf 0, not null", () => {
    expect(reducer(initialState, { type: "snapshot", snapshot: snapshot() }).ticketsAsOf).toBe(0);
  });

  test("the done page joins the tickets, seeds that scope's paging, and drops other scopes", () => {
    const done = ticket("D-1", { status: "done", completedAt: 5 });
    const st = withState({ donePaging: { stale: {} as never } });
    const next = reducer(st, { type: "snapshot", snapshot: snapshot({ donePage: { scope: "*", page: page([done], { total: 9, nextCursor: "c" }) } }) });
    expect(next.tickets[done.id]).toBeDefined();
    expect(Object.keys(next.donePaging)).toEqual(["*"]);
    expect(next.donePaging["*"]).toMatchObject({ total: 9, nextCursor: "c", frontier: 5 });
  });

  test("without a done page, paging is cleared entirely", () => {
    const st = withState({ donePaging: { "*": {} as never } });
    expect(reducer(st, { type: "snapshot", snapshot: snapshot() }).donePaging).toEqual({});
  });

  test("a live version newer than the snapshot's survives; an older or equal one doesn't", () => {
    const live = ticket("A-1", { updatedAt: 20, title: "live" });
    const st = withState({ tickets: tickets(live) });
    const kept = reducer(st, { type: "snapshot", snapshot: snapshot({ tickets: [ticket("A-1", { updatedAt: 10, title: "snap" })] }) });
    expect(kept.tickets[live.id]!.title).toBe("live");
    const replaced = reducer(st, { type: "snapshot", snapshot: snapshot({ tickets: [ticket("A-1", { updatedAt: 20, title: "snap" })] }) });
    expect(replaced.tickets[live.id]!.title).toBe("snap");
  });

  test("same newer-wins rule for projects and sessions", () => {
    const st = withState({ projects: { p: project("p", { updatedAt: 9, name: "live" } as never) }, sessions: { s1: session("s1", { updatedAt: 9, title: "live" }) } });
    const next = reducer(st, { type: "snapshot", snapshot: snapshot({ projects: [project("p", { updatedAt: 1, name: "snap" } as never)], sessions: [session("s1", { updatedAt: 1, title: "snap" })] }) });
    expect(next.projects.p!.name).toBe("live");
    expect(next.sessions.s1!.title).toBe("live");
  });

  test("an active search is re-armed; none stays none", () => {
    const search = { q: "x", scope: "*", ids: ["a"], nextCursor: "c", total: 3, loading: false, error: "e" };
    const next = reducer(withState({ search }), { type: "snapshot", snapshot: snapshot() });
    expect(next.search).toEqual({ q: "x", scope: "*", ids: null, nextCursor: null, total: 0, loading: true, error: null });
    expect(reducer(initialState, { type: "snapshot", snapshot: snapshot() }).search).toBeNull();
  });

  test("deltas of sessions the snapshot shows idle are dropped; busy sessions' deltas are kept", () => {
    const st = withState({ deltas: { idle: { r: "x" }, busy: { r: "y" }, unknown: { r: "z" } } });
    const next = reducer(st, { type: "snapshot", snapshot: snapshot({ sessions: [session("idle", { busy: false }), session("busy", { busy: true })] }) });
    expect(Object.keys(next.deltas).sort()).toEqual(["busy", "unknown"]);
  });

  test("transcripts and activity survive a snapshot", () => {
    const st = withState({ transcripts: { s1: { entries: [], loaded: true } }, activity: { s1: [act("a", 1)] } });
    const next = reducer(st, { type: "snapshot", snapshot: snapshot() });
    expect(next.transcripts).toBe(st.transcripts);
    expect(next.activity).toBe(st.activity);
  });
});

describe("reducer: detail", () => {
  test("merges the ticket, its children and parent; a newer live copy beats the detail's", () => {
    const t = ticket("A-1");
    const child = ticket("A-2", { parentId: t.id, updatedAt: 1 });
    const parent = ticket("A-0");
    const liveChild = { ...child, updatedAt: 9, title: "live" };
    const next = reducer(withState({ tickets: tickets(liveChild) }), { type: "detail", detail: detail(t, { children: [child], parent }) });
    expect(Object.keys(next.tickets).sort()).toEqual([parent.id, t.id, child.id].sort());
    expect(next.tickets[child.id]!.title).toBe("live");
  });

  test("an old key records an alias to the current ticket; the current key does not", () => {
    const t = ticket("NEW-1");
    expect(reducer(initialState, { type: "detail", detail: detail(t), requestedKey: "old-1" }).keyAliases).toEqual({ "OLD-1": t.id });
    expect(reducer(initialState, { type: "detail", detail: detail(t), requestedKey: "new-1" }).keyAliases).toEqual({});
    expect(reducer(initialState, { type: "detail", detail: detail(t) }).keyAliases).toEqual({});
  });

  test("resolvedFrom wins over requestedKey for the alias", () => {
    const t = ticket("NEW-1");
    const next = reducer(initialState, { type: "detail", detail: { ...detail(t), resolvedFrom: "old-9" }, requestedKey: "whatever" });
    expect(next.keyAliases).toEqual({ "OLD-9": t.id });
  });

  test("a fetched detail clears the key's missing mark", () => {
    const t = ticket("NEW-1");
    const st = withState({ missingKeys: { "OLD-1": true, "OTHER-1": true } });
    expect(reducer(st, { type: "detail", detail: detail(t), requestedKey: "old-1" }).missingKeys).toEqual({ "OTHER-1": true });
    expect(reducer(st, { type: "detail", detail: detail(t) }).missingKeys).toBe(st.missingKeys);
  });

  test("a conductor's detail marks its children loaded; a plain ticket's does not", () => {
    const conductor = ticket("C-1", { kind: "conductor" });
    expect(reducer(initialState, { type: "detail", detail: detail(conductor) }).childrenLoaded).toEqual({ [conductor.id]: true });
    expect(reducer(initialState, { type: "detail", detail: detail(ticket("A-1")) }).childrenLoaded).toEqual({});
  });

  test("stores dependents, runs, session and activity; ended runs clear their deltas", () => {
    const t = ticket("A-1");
    const st = withState({ deltas: { [t.sessionId]: { r1: "half", r2: "live" } }, activity: { [t.sessionId]: [act("old", 1, { sessionId: t.sessionId })] } });
    const d = detail(t, { dependents: ["B-1"], runs: [run("r1", t.sessionId, "succeeded"), run("r2", t.sessionId, "running")], activity: [act("new", 2, { sessionId: t.sessionId })] });
    const next = reducer(st, { type: "detail", detail: d });
    expect(next.dependents[t.id]).toEqual(["B-1"]);
    expect(Object.keys(next.runs).sort()).toEqual(["r1", "r2"]);
    expect(next.deltas[t.sessionId]).toEqual({ r2: "live" });
    expect(next.activity[t.sessionId]!.map((e) => e.id)).toEqual(["old", "new"]);
    expect(next.sessions[t.sessionId]).toBeDefined();
  });

  test("detail sub-agents merge when present and leave the list unknown when absent", () => {
    const t = ticket("A-1");
    const withSubs = reducer(initialState, { type: "detail", detail: detail(t, { subagents: [sub("a", { sessionId: t.sessionId })] }) });
    expect(withSubs.subagents[t.sessionId]).toHaveLength(1);
    const without = reducer(initialState, { type: "detail", detail: detail(t) });
    expect(without.subagents[t.sessionId]).toBeUndefined();
  });

  test("detail does not prune deltas of sessions it doesn't mention", () => {
    const t = ticket("A-1");
    const st = withState({ deltas: { other: { r: "x" } } });
    expect(reducer(st, { type: "detail", detail: detail(t) }).deltas.other).toEqual({ r: "x" });
  });
});

describe("reducer: transcripts, sub-agents, task output, activity", () => {
  test("a transcript backfill merges with live entries and marks the transcript loaded", () => {
    let st = event(initialState, { kind: "transcript.appended", entry: entry("live", 5) });
    st = reducer(st, { type: "transcript", sessionId: "s1", entries: [entry("a", 1), entry("live", 5)] });
    expect(st.transcripts.s1!.entries.map((e) => e.id)).toEqual(["a", "live"]);
    expect(st.transcripts.s1!.loaded).toBe(true);
  });

  test("loaded stays true after a later live entry", () => {
    let st = reducer(initialState, { type: "transcript", sessionId: "s1", entries: [] });
    st = event(st, { kind: "transcript.appended", entry: entry("a", 1) });
    expect(st.transcripts.s1!.loaded).toBe(true);
  });

  test("a sub-agent's transcript backfill goes under its key", () => {
    const st = reducer(initialState, { type: "transcript", sessionId: "s1", subagentId: "ag", entries: [] });
    expect(Object.keys(st.transcripts)).toEqual(["s1/ag"]);
  });

  test("a subagents action merges by id and keeps the newer", () => {
    let st = reducer(initialState, { type: "subagents", sessionId: "s1", subagents: [sub("a", { updatedAt: 5 })] });
    st = reducer(st, { type: "subagents", sessionId: "s1", subagents: [sub("a", { updatedAt: 1, status: "failed" }), sub("b", { updatedAt: 1 })] });
    expect(st.subagents.s1!.map((s) => [s.id, s.updatedAt])).toEqual([["a", 5], ["b", 1]]);
  });

  test("an empty subagents list for a new session still records the session as known (empty, not unknown)", () => {
    const st = reducer(initialState, { type: "subagents", sessionId: "s1", subagents: [] });
    expect(st.subagents.s1).toEqual([]);
  });

  test("task output keyed by session/sub-agent; a repeated poll returns the same state object", () => {
    const out: TaskOutput = { text: "hi", start: 0, end: 2, size: 2, done: false, available: true };
    const st = reducer(initialState, { type: "taskOutput", sessionId: "s1", subagentId: "t", output: out });
    expect(st.taskOutputs["s1/t"]!.text).toBe("hi");
    expect(reducer(st, { type: "taskOutput", sessionId: "s1", subagentId: "t", output: out })).toBe(st);
  });

  test("activity action merges with what's there", () => {
    const st = withState({ activity: { s1: [act("a", 1)] } });
    const next = reducer(st, { type: "activity", sessionId: "s1", activity: [act("b", 0)] });
    expect(next.activity.s1!.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("reducer: spec revisions", () => {
  const info = (rev: number, over: object = {}) => ({ rev, approvedBaseline: false, note: "", ...over }) as never;

  test("a loaded list merges by rev (oldest first) and applies the ticket's baseline", () => {
    const t = ticket("A-1", { specBaselineRevision: 2 });
    const st = withState({ tickets: tickets(t), specRevisions: { [t.id]: [info(3)] } });
    const next = reducer(st, { type: "specRevisions", ticketId: t.id, revisions: [info(1), info(2)] });
    expect(next.specRevisions[t.id]!.map((r) => [r.rev, r.approvedBaseline])).toEqual([[1, false], [2, true], [3, false]]);
  });

  test("an unknown ticket leaves the revisions' own baseline flags", () => {
    const next = reducer(initialState, { type: "specRevisions", ticketId: "t", revisions: [info(1, { approvedBaseline: true })] });
    expect(next.specRevisions.t![0]!.approvedBaseline).toBe(true);
  });

  test("a ticket with a null baseline clears every flag", () => {
    const t = ticket("A-1", { specBaselineRevision: null });
    const st = withState({ tickets: tickets(t) });
    const next = reducer(st, { type: "specRevisions", ticketId: t.id, revisions: [info(1, { approvedBaseline: true })] });
    expect(next.specRevisions[t.id]![0]!.approvedBaseline).toBe(false);
  });

  test("a revision body is stored apart from its info, and the info joins a loaded list only", () => {
    const rev = { ...(info(2) as object), body: "text" } as never;
    const loaded = reducer(withState({ specRevisions: { t: [info(1)] } }), { type: "specRevision", ticketId: "t", revision: rev });
    expect(loaded.specBodies["t#2"]).toBe("text");
    expect(loaded.specRevisions.t!.map((r) => r.rev)).toEqual([1, 2]);
    expect("body" in loaded.specRevisions.t![1]!).toBe(false);
    const unloaded = reducer(initialState, { type: "specRevision", ticketId: "t", revision: rev });
    expect(unloaded.specBodies["t#2"]).toBe("text");
    expect(unloaded.specRevisions).toEqual({});
  });
});

describe("reducer: tickets, missing keys, drivers, paging", () => {
  test("tickets action keeps a newer live copy", () => {
    const st = withState({ tickets: tickets(ticket("A-1", { updatedAt: 9, title: "live" })) });
    const next = reducer(st, { type: "tickets", tickets: [ticket("A-1", { updatedAt: 1, title: "stale" }), ticket("A-2")] });
    expect(next.tickets["id-A-1"]!.title).toBe("live");
    expect(next.tickets["id-A-2"]).toBeDefined();
  });

  test("missing keys are stored upper-case", () => {
    expect(reducer(initialState, { type: "missingKeys", keys: ["a-1", "B-2"] }).missingKeys).toEqual({ "A-1": true, "B-2": true });
  });

  test("drivers replace the list", () => {
    const drivers = [{ id: "x" }] as never;
    expect(reducer(initialState, { type: "drivers", drivers }).drivers).toBe(drivers);
  });

  test("paging actions are routed to the paging reducer", () => {
    const st = reducer(initialState, { type: "donePage.request", scope: "*" });
    expect(st.donePaging["*"]!.loading).toBe(true);
  });
});

// --- selectors ----------------------------------------------------------------------------------

describe("ticketsForProject / boardColumns", () => {
  const a = ticket("A-1", { projectId: "p", status: "planning", position: 2, createdAt: 1 });
  const b = ticket("A-2", { projectId: "p", status: "planning", position: 1, createdAt: 5 });
  const c = ticket("A-3", { projectId: "p", status: "planning", position: 1, createdAt: 2 });
  const q = ticket("Q-1", { projectId: "q", status: "review" });
  const d1 = ticket("A-4", { projectId: "p", status: "done", completedAt: 10 });
  const d2 = ticket("A-5", { projectId: "p", status: "done", completedAt: 20 });
  const st = withState({ tickets: tickets(a, b, c, q, d1, d2), projects: { p: project("p", { group: "g" }), q: project("q") } });

  test("null board is all projects; a project id filters; a group scope filters by the project's group", () => {
    expect(ticketsForProject(st, null)).toHaveLength(6);
    expect(ticketsForProject(st, "q").map((t) => t.key)).toEqual(["Q-1"]);
    expect(ticketsForProject(st, "group:g")).toHaveLength(5);
  });

  test("open columns sort by position then age; done is newest-completed first", () => {
    const cols = boardColumns(st, "p");
    expect(cols.planning.map((t) => t.key)).toEqual(["A-3", "A-2", "A-1"]);
    expect(cols.done.map((t) => t.key)).toEqual(["A-5", "A-4"]);
    expect(cols.review).toEqual([]);
  });

  test("the done column is cut at the paging frontier", () => {
    const paged = withState({ ...st, donePaging: { p: { total: 5, nextCursor: "c", loading: false, frontier: 15, newest: 20, error: null } } });
    expect(boardColumns(paged, "p").done.map((t) => t.key)).toEqual(["A-5"]);
  });
});

describe("ticketByKey / ticketLinkable", () => {
  const t = ticket("NEW-1", { id: "tid" });
  const st = withState({ tickets: tickets(t), keyAliases: { "OLD-1": "tid", "GONE-1": "nope" }, projects: { p: project("p", { key: "Proj" }) }, missingKeys: { "PROJ-404": true } });

  test("finds by key case-insensitively, then by alias; unknown or dangling alias is undefined", () => {
    expect(ticketByKey(st, "new-1")).toBe(t);
    expect(ticketByKey(st, "old-1")).toBe(t);
    expect(ticketByKey(st, "GONE-1")).toBeUndefined();
    expect(ticketByKey(st, "NOPE-1")).toBeUndefined();
  });

  test("linkable when loaded, aliased, or the prefix is a project's key; not when 404'd or a look-alike", () => {
    expect(ticketLinkable(st, "new-1")).toBe(true);
    expect(ticketLinkable(st, "OLD-1")).toBe(true);
    expect(ticketLinkable(st, "proj-12")).toBe(true);
    expect(ticketLinkable(st, "PROJ-404")).toBe(false);
    expect(ticketLinkable(st, "UTF-8")).toBe(false);
  });
});

describe("triageSessions", () => {
  test("only triage sessions, newest first", () => {
    const st = withState({ sessions: { a: session("a", { kind: "triage", createdAt: 1 }), b: session("b", { kind: "triage", createdAt: 5 }), c: session("c", { kind: "ticket", createdAt: 9 }) } });
    expect(triageSessions(st).map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("driver and model selectors", () => {
  const st = withState({
    projects: { p: project("p", { defaultDriver: "codex", defaultModels: { codex: "gpt-9" } } as never), q: project("q") },
    settings: { defaultDriver: "claude-code", defaultModels: { "claude-code": "sonnet" } } as never,
  });

  test("defaultDriverOf: project, else settings, else null before settings load", () => {
    expect(defaultDriverOf(st, "p")).toBe("codex");
    expect(defaultDriverOf(st, "q")).toBe("claude-code");
    expect(defaultDriverOf(st, "missing")).toBe("claude-code");
    expect(defaultDriverOf(initialState, "p")).toBeNull();
  });

  test("hasCustomDriver is false while the default is unknown", () => {
    expect(hasCustomDriver(st, ticket("A-1", { projectId: "p", driver: "codex" }))).toBe(false);
    expect(hasCustomDriver(st, ticket("A-1", { projectId: "p", driver: "claude-code" }))).toBe(true);
    expect(hasCustomDriver(initialState, ticket("A-1", { driver: "whatever" }))).toBe(false);
  });

  test("defaultModelOf: project's model for the driver, then settings', else null", () => {
    expect(defaultModelOf(st, "p", "codex")).toBe("gpt-9");
    expect(defaultModelOf(st, "q", "claude-code")).toBe("sonnet");
    expect(defaultModelOf(st, "q", "codex")).toBeNull();
  });

  test("hasCustomModel: no model or no settings is never custom; the default model isn't; another is", () => {
    const m = (model: string | null, over: Partial<Ticket> = {}) => ticket("A-1", { projectId: "q", driver: "claude-code", model, ...over });
    expect(hasCustomModel(st, m(null))).toBe(false);
    expect(hasCustomModel(initialState, m("opus"))).toBe(false);
    expect(hasCustomModel(st, m("sonnet"))).toBe(false);
    expect(hasCustomModel(st, m("opus"))).toBe(true);
  });

  test("hasCustomModel falls back to the driver's default in the model list when nothing is configured", () => {
    const bare = withState({ projects: { q: project("q") }, settings: { defaultDriver: "claude-code", defaultModels: {} } as never });
    const t = ticket("A-1", { projectId: "q", driver: "claude-code", model: "opus" });
    expect(hasCustomModel(bare, t, [{ id: "opus", default: true }, { id: "haiku" }])).toBe(false);
    expect(hasCustomModel(bare, t, [{ id: "sonnet", default: true }])).toBe(true);
    expect(hasCustomModel(bare, t, null)).toBe(true);
  });
});

describe("dependencies", () => {
  const done = ticket("D-1", { status: "done" });
  const open = ticket("O-1", { status: "in_progress" });

  test("dependencyStates: done, pending, unknown, and missing only when the service said 404", () => {
    const me = ticket("A-1", { dependsOn: ["d-1", "O-1", "X-1", "Y-1"] });
    const st = withState({ tickets: tickets(done, open, me), missingKeys: { "Y-1": true } });
    const states = dependencyStates(st, me);
    expect(states.map((s) => [s.key, s.state, s.done, s.missing])).toEqual([
      ["d-1", "done", true, false],
      ["O-1", "pending", false, false],
      ["X-1", "unknown", false, false],
      ["Y-1", "unknown", false, true],
    ]);
  });

  test("a key found through an alias is not reported missing", () => {
    const me = ticket("A-1", { dependsOn: ["OLD-1"] });
    const st = withState({ tickets: tickets(done, me), keyAliases: { "OLD-1": done.id }, missingKeys: { "OLD-1": true } });
    expect(dependencyStates(st, me)[0]).toMatchObject({ state: "done", missing: false });
  });

  test("unresolvedKeys is empty until the first snapshot", () => {
    const me = ticket("A-1", { dependsOn: ["X-1"] });
    expect(unresolvedKeys(withState({ tickets: tickets(me) }))).toEqual([]);
  });

  test("unresolvedKeys collects unknown dependencies, dependents, triage outcomes and extras once, upper-cased; skipping known, aliased and 404'd keys", () => {
    const me = ticket("A-1", { dependsOn: ["x-1", "D-1", "alias-1", "dead-1"] });
    const st = withState({
      ready: true,
      tickets: tickets(me, done),
      keyAliases: { "ALIAS-1": done.id },
      missingKeys: { "DEAD-1": true },
      dependents: { [me.id]: ["z-9", "X-1"] },
      sessions: { s: session("s", { kind: "triage", outcome: "Dispatched to TRI-7." }), t: session("t", { kind: "ticket", outcome: "Dispatched to NOPE-1" }) },
    });
    expect(unresolvedKeys(st, ["extra-2", "A-1"]).sort()).toEqual(["EXTRA-2", "TRI-7", "X-1", "Z-9"]);
  });

  test("conductorsNeedingChildren: only conductors whose detail hasn't arrived, once ready", () => {
    const c1 = ticket("C-1", { kind: "conductor" });
    const c2 = ticket("C-2", { kind: "conductor" });
    const withKids = ticket("C-3", { childCount: 2 });
    const plain = ticket("P-1");
    const st = withState({ ready: true, tickets: tickets(c1, c2, withKids, plain), childrenLoaded: { [c2.id]: true } });
    expect(conductorsNeedingChildren(st).map((t) => t.key).sort()).toEqual(["C-1", "C-3"]);
    expect(conductorsNeedingChildren({ ...st, ready: false })).toEqual([]);
  });

  test("dependentsOf merges live dependents with the detail's list, dropping stale ones, sorted numerically", () => {
    const me = ticket("A-1");
    const live = ticket("B-10", { dependsOn: ["a-1"] });
    const live2 = ticket("B-2", { dependsOn: ["A-1"] });
    const stale = ticket("B-3", { dependsOn: ["Z-1"] }); // listed by the detail but no longer depends on me
    const st = withState({ tickets: tickets(me, live, live2, stale), dependents: { [me.id]: ["B-3", "b-10", "OFF-1"] } });
    const out = dependentsOf(st, me);
    expect(out.map((d) => d.key)).toEqual(["B-2", "B-10", "OFF-1"]);
    expect(out[2]!.ticket).toBeUndefined();
    expect(out[0]!.ticket).toBe(live2);
  });

  test("dependentsOf with nothing known is empty", () => {
    expect(dependentsOf(initialState, ticket("A-1"))).toEqual([]);
  });
});

describe("activity, spec body, deltas", () => {
  test("latestActivity: newest entry, or the newest of the given kinds, or undefined", () => {
    const st = withState({ activity: { s1: [act("a", 1, { kind: "note" }), act("b", 2, { kind: "moved" as never }), act("c", 3, { kind: "question" as never })] } });
    expect(latestActivity(st, "s1")!.id).toBe("c");
    expect(latestActivity(st, "s1", NEWS_KINDS)!.id).toBe("a");
    expect(latestActivity(st, "s1", ["failed"])).toBeUndefined();
    expect(latestActivity(st, "nope")).toBeUndefined();
  });

  test("NEWS_KINDS leave out column moves and questions", () => {
    expect(NEWS_KINDS).not.toContain("moved" as never);
    expect(NEWS_KINDS).not.toContain("question" as never);
  });

  test("specBody: the ticket's own spec for its current revision (default 1), else a fetched body, else undefined", () => {
    const t = ticket("A-1", { spec: "current", specRevision: 3 });
    const st = withState({ tickets: tickets(t), specBodies: { [specBodyKey(t.id, 2)]: "older" } });
    expect(specBody(st, t.id, 3)).toBe("current");
    expect(specBody(st, t.id, 2)).toBe("older");
    expect(specBody(st, t.id, 1)).toBeUndefined();
    const noRev = ticket("A-2", { spec: "first" });
    expect(specBody(withState({ tickets: tickets(noRev) }), noRev.id, 1)).toBe("first");
    expect(specBody(initialState, "nope", 1)).toBeUndefined();
  });

  test("liveDelta lists a session's in-flight runs, empty when none", () => {
    const st = withState({ deltas: { s1: { r1: "a", r2: "b" } } });
    expect(liveDelta(st, "s1")).toEqual([{ runId: "r1", text: "a" }, { runId: "r2", text: "b" }]);
    expect(liveDelta(st, "s2")).toEqual([]);
  });
});

describe("isReady", () => {
  test("review status plus passed agent review (approved or skipped) plus human approval", () => {
    const base = { status: "review", humanReview: "approved" } as const;
    expect(isReady(ticket("A-1", { ...base, agentReview: "approved" }))).toBe(true);
    expect(isReady(ticket("A-1", { ...base, agentReview: "skipped" }))).toBe(true);
    expect(isReady(ticket("A-1", { ...base, agentReview: "pending" }))).toBe(false);
    expect(isReady(ticket("A-1", { ...base, agentReview: "approved", humanReview: "pending" }))).toBe(false);
    expect(isReady(ticket("A-1", { ...base, agentReview: "approved", status: "in_progress" }))).toBe(false);
  });
});

describe("projects and the composer", () => {
  const st = withState({
    projects: {
      b: project("b", { name: "Beta", group: "g" }),
      a: project("a", { name: "alpha", group: "g" }),
      c: project("c", { name: "Charlie" }),
    },
  });

  test("sortedProjects orders by name", () => {
    expect(sortedProjects(st).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  test("composerCandidates on a project board: the project then the last used; All projects has no board pick", () => {
    expect(composerCandidates(st, "c", "b")).toEqual(["c", "b"]);
    expect(composerCandidates(st, "*", "b")).toEqual([null, "b"]);
    expect(composerCandidates(st, null, null)).toEqual([null, null]);
  });

  test("composerCandidates on a group board: last used if in the group, else the group's first by name, then last", () => {
    expect(composerCandidates(st, "group:g", "b")).toEqual(["b", "a", "b"]);
    expect(composerCandidates(st, "group:g", "c")).toEqual([null, "a", "c"]);
    expect(composerCandidates(st, "group:empty", null)).toEqual([null, null, null]);
  });

  test("composerProject: keeps a real current choice, else the first candidate that exists, else the first project by name, else empty", () => {
    expect(composerProject(st, "c", ["a"])).toBe("c");
    expect(composerProject(st, "gone", [null, "ghost", "b", "a"])).toBe("b");
    expect(composerProject(st, "", [null])).toBe("a");
    expect(composerProject(initialState, "x", ["y"])).toBe("");
  });
});

describe("positionForDrop", () => {
  const col = (...ps: number[]) => ps.map((position) => ({ position }));

  test("empty column is 0; the top is one below the first; the bottom one above the last", () => {
    expect(positionForDrop([], 0)).toBe(0);
    expect(positionForDrop(col(5, 7), 0)).toBe(4);
    expect(positionForDrop(col(5, 7), 2)).toBe(8);
  });

  test("between neighbours is the midpoint", () => {
    expect(positionForDrop(col(1, 3), 1)).toBe(2);
  });

  test("an index out of range is clamped to the ends", () => {
    expect(positionForDrop(col(5, 7), -4)).toBe(4);
    expect(positionForDrop(col(5, 7), 99)).toBe(8);
  });

  test("equal neighbours nudge just above the earlier one, staying below the later and unequal", () => {
    const p = positionForDrop(col(2, 2), 1);
    expect(p).toBeGreaterThan(2);
    expect(p).toBeLessThan(2.001);
  });

  test("inverted neighbours (legacy data) also nudge above the earlier", () => {
    expect(positionForDrop(col(5, 3), 1)).toBeGreaterThan(5);
  });
});
