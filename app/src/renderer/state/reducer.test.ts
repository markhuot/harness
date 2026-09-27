import { describe, expect, test } from "bun:test";
import type { Project, Run, Session, Summary, Ticket, TranscriptEntry } from "@harness/shared";
import {
  boardColumns,
  dependencyStates,
  initialState,
  liveDelta,
  mergeById,
  reducer,
  type Action,
  type State,
} from "./reducer";

const project = (id: string, key: string): Project => ({
  id,
  key,
  name: key.toLowerCase(),
  path: `/tmp/${key}`,
  nextSeq: 1,
  defaultDriver: null,
  useWorktrees: false,
  requireHumanReview: true,
  createdAt: 1,
  updatedAt: 1,
});

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id,
  key: id.toUpperCase(),
  projectId: "p1",
  kind: "task",
  title: id,
  description: "",
  status: "planning",
  sessionId: `s-${id}`,
  driver: "dummy",
  parentId: null,
  dependsOn: [],
  autoStart: false,
  agentReview: "pending",
  humanReview: "pending",
  externalRef: null,
  workdir: null,
  branch: null,
  blockedReason: null,
  busy: false,
  pendingApproval: null,
  allowedTools: [],
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const entry = (id: string, seq: number, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id,
  sessionId: "s1",
  runId: "r1",
  seq,
  role: "assistant",
  content: { type: "text", text: `entry ${id}` },
  createdAt: seq,
  ...over,
});

const summary = (id: string, createdAt: number, body = id): Summary => ({
  id,
  sessionId: "s1",
  ticketId: "t1",
  author: "agent",
  body,
  createdAt,
});

const run = (id: string, status: Run["status"]): Run => ({
  id,
  sessionId: "s1",
  kind: "work",
  status,
  driver: "dummy",
  prompt: "",
  error: null,
  createdAt: 0,
  startedAt: 0,
  endedAt: null,
});

const apply = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);
const ev = (event: Extract<Action, { type: "event" }>["event"]): Action => ({ type: "event", event });

describe("transcript", () => {
  test("out-of-order live entries are kept sorted by seq", () => {
    const s = apply(
      initialState,
      ev({ kind: "transcript.appended", entry: entry("c", 3) }),
      ev({ kind: "transcript.appended", entry: entry("a", 1) }),
      ev({ kind: "transcript.appended", entry: entry("b", 2) }),
    );
    expect(s.transcripts.s1!.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(s.transcripts.s1!.loaded).toBe(false);
  });

  test("REST backfill overlapping live events dedupes by id and marks loaded", () => {
    const s = apply(
      initialState,
      ev({ kind: "transcript.appended", entry: entry("b", 2) }),
      ev({ kind: "transcript.appended", entry: entry("c", 3) }),
      { type: "transcript", sessionId: "s1", entries: [entry("a", 1), entry("b", 2), entry("c", 3)] },
    );
    expect(s.transcripts.s1!.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(s.transcripts.s1!.loaded).toBe(true);
  });

  test("a later version of the same entry id replaces the earlier one", () => {
    const s = apply(
      initialState,
      ev({ kind: "transcript.appended", entry: entry("a", 1) }),
      ev({ kind: "transcript.appended", entry: entry("a", 1, { content: { type: "text", text: "edited" } }) }),
    );
    expect(s.transcripts.s1!.entries).toHaveLength(1);
    expect(s.transcripts.s1!.entries[0]!.content).toEqual({ type: "text", text: "edited" });
  });

  test("sessions are isolated", () => {
    const s = apply(
      initialState,
      ev({ kind: "transcript.appended", entry: entry("a", 1) }),
      ev({ kind: "transcript.appended", entry: entry("x", 1, { sessionId: "s2" }) }),
    );
    expect(s.transcripts.s1!.entries.map((e) => e.id)).toEqual(["a"]);
    expect(s.transcripts.s2!.entries.map((e) => e.id)).toEqual(["x"]);
  });
});

describe("streaming deltas", () => {
  const delta = (text: string, runId = "r1", sessionId = "s1"): Action =>
    ev({ kind: "transcript.delta", sessionId, runId, text });

  test("accumulate per session and run", () => {
    const s = apply(initialState, delta("Hel"), delta("lo"), delta("other", "r2"), delta("x", "r1", "s2"));
    expect(s.deltas.s1).toEqual({ r1: "Hello", r2: "other" });
    expect(liveDelta(s, "s2")).toEqual([{ runId: "r1", text: "x" }]);
  });

  test("cleared by the matching assistant text entry only", () => {
    let s = apply(initialState, delta("Hello"), delta("Other", "r2"));
    // A tool call from the same run doesn't end the streamed text block.
    s = apply(
      s,
      ev({
        kind: "transcript.appended",
        entry: entry("t", 1, { role: "tool", content: { type: "tool_call", callId: "c", name: "bash", input: {} } }),
      }),
    );
    expect(s.deltas.s1).toEqual({ r1: "Hello", r2: "Other" });
    // User text on the same run id doesn't either.
    s = apply(s, ev({ kind: "transcript.appended", entry: entry("u", 2, { role: "user" }) }));
    expect(s.deltas.s1!.r1).toBe("Hello");

    s = apply(s, ev({ kind: "transcript.appended", entry: entry("a", 3, { runId: "r1" }) }));
    expect(s.deltas.s1).toEqual({ r2: "Other" });
    s = apply(s, ev({ kind: "transcript.appended", entry: entry("b", 4, { runId: "r2" }) }));
    expect(s.deltas.s1).toBeUndefined();
    expect(liveDelta(s, "s1")).toEqual([]);
  });

  test("a new delta after the clear starts a fresh block", () => {
    const s = apply(
      initialState,
      delta("first"),
      ev({ kind: "transcript.appended", entry: entry("a", 1) }),
      delta("second"),
    );
    expect(s.deltas.s1).toEqual({ r1: "second" });
  });

  test("a run ending (e.g. cancelled mid-stream) drops its dangling delta", () => {
    let s = apply(initialState, delta("partial"), ev({ kind: "run.upserted", run: run("r1", "running") }));
    expect(s.deltas.s1!.r1).toBe("partial");
    s = apply(s, ev({ kind: "run.upserted", run: run("r1", "cancelled") }));
    expect(s.deltas.s1).toBeUndefined();
    expect(s.runs.r1!.status).toBe("cancelled");
  });
});

describe("summaries", () => {
  test("ordered by createdAt and deduped when detail backfill overlaps live events", () => {
    const t = ticket("t1", { sessionId: "s1" });
    const session: Session = {
      id: "s1",
      key: "T1",
      kind: "ticket",
      ticketId: "t1",
      driver: "dummy",
      cwd: "/",
      title: "",
      triageStatus: null,
      outcome: null,
      busy: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const s = apply(
      initialState,
      ev({ kind: "summary.added", summary: summary("b", 20) }),
      { type: "detail", detail: { ticket: t, session, summaries: [summary("a", 10), summary("b", 20)], runs: [], dependents: [], children: [] } },
      ev({ kind: "summary.added", summary: summary("c", 30) }),
    );
    expect(s.summaries.s1!.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(s.tickets.t1).toEqual(t);
    expect(s.sessions.s1).toEqual(session);
  });
});

describe("entities", () => {
  test("ticket upsert replaces, delete removes, and unknown deletes are no-ops", () => {
    let s = apply(initialState, ev({ kind: "ticket.upserted", ticket: ticket("t1") }));
    s = apply(s, ev({ kind: "ticket.upserted", ticket: ticket("t1", { status: "review", busy: true }) }));
    expect(Object.keys(s.tickets)).toEqual(["t1"]);
    expect(s.tickets.t1!.status).toBe("review");
    const before = s;
    s = apply(s, ev({ kind: "ticket.deleted", id: "nope" }));
    expect(s.tickets).toBe(before.tickets);
    s = apply(s, ev({ kind: "ticket.deleted", id: "t1" }));
    expect(s.tickets).toEqual({});
  });

  test("deleting a project drops its tickets and mappings", () => {
    const s = apply(
      initialState,
      ev({ kind: "project.upserted", project: project("p1", "A") }),
      ev({ kind: "project.upserted", project: project("p2", "B") }),
      ev({ kind: "ticket.upserted", ticket: ticket("t1", { projectId: "p1" }) }),
      ev({ kind: "ticket.upserted", ticket: ticket("t2", { projectId: "p2" }) }),
      ev({ kind: "mapping.upserted", mapping: { id: "m1", pattern: "FOO", projectId: "p1", notes: "", createdAt: 0 } }),
      ev({ kind: "project.deleted", id: "p1" }),
    );
    expect(Object.keys(s.projects)).toEqual(["p2"]);
    expect(Object.keys(s.tickets)).toEqual(["t2"]);
    expect(s.mappings).toEqual({});
  });

  test("watcher and mapping deletes", () => {
    const w = {
      id: "w1",
      name: "jira",
      command: "node",
      args: [],
      cwd: null,
      env: {},
      mode: "loop" as const,
      intervalSec: 60,
      enabled: true,
      driver: null,
      lastRunAt: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    };
    let s = apply(initialState, ev({ kind: "watcher.upserted", watcher: w }));
    expect(s.watchers.w1!.name).toBe("jira");
    s = apply(s, ev({ kind: "watcher.deleted", id: "w1" }));
    expect(s.watchers).toEqual({});
  });

  test("snapshot replaces entity lists (stale tickets vanish after a reconnect refetch)", () => {
    let s = apply(initialState, ev({ kind: "ticket.upserted", ticket: ticket("gone") }));
    s = apply(s, {
      type: "snapshot",
      snapshot: { projects: [], tickets: [ticket("t1")], sessions: [], watchers: [], mappings: [], settings: null, drivers: [] },
    });
    expect(Object.keys(s.tickets)).toEqual(["t1"]);
    expect(s.ready).toBe(true);
  });

  test("snapshot doesn't clobber a newer live update that raced the REST request", () => {
    const snap = (t: Ticket) => ({
      type: "snapshot" as const,
      snapshot: { projects: [], tickets: [t], sessions: [], watchers: [], mappings: [], settings: null, drivers: [] },
    });
    let s = apply(initialState, ev({ kind: "ticket.upserted", ticket: ticket("t1", { status: "review", updatedAt: 20 }) }));
    s = apply(s, snap(ticket("t1", { status: "in_progress", updatedAt: 10 })));
    expect(s.tickets.t1!.status).toBe("review");
    // Equal or newer snapshot data wins.
    s = apply(s, snap(ticket("t1", { status: "done", updatedAt: 20 })));
    expect(s.tickets.t1!.status).toBe("done");
  });
});

describe("board selectors", () => {
  const base = apply(
    initialState,
    ev({ kind: "ticket.upserted", ticket: ticket("a", { projectId: "p1", status: "planning", position: 2, createdAt: 1 }) }),
    ev({ kind: "ticket.upserted", ticket: ticket("b", { projectId: "p1", status: "planning", position: 1, createdAt: 2 }) }),
    ev({ kind: "ticket.upserted", ticket: ticket("c", { projectId: "p2", status: "planning", position: 1, createdAt: 0 }) }),
    ev({ kind: "ticket.upserted", ticket: ticket("d", { projectId: "p2", status: "done", updatedAt: 5 }) }),
    ev({ kind: "ticket.upserted", ticket: ticket("e", { projectId: "p1", status: "done", updatedAt: 9 }) }),
  );

  test("filters by project; null means all projects", () => {
    expect(boardColumns(base, "p1").planning.map((t) => t.id)).toEqual(["b", "a"]);
    expect(boardColumns(base, "p2").planning.map((t) => t.id)).toEqual(["c"]);
    expect(boardColumns(base, null).planning.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(boardColumns(base, "missing").planning).toEqual([]);
  });

  test("position ties fall back to creation order; done is newest-first", () => {
    expect(boardColumns(base, null).planning.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(boardColumns(base, null).done.map((t) => t.id)).toEqual(["e", "d"]);
  });

  test("dependency chips are done only when the named ticket is done; unknown keys stay pending", () => {
    const s = apply(
      base,
      ev({ kind: "ticket.upserted", ticket: ticket("f", { dependsOn: ["E", "A", "ZZZ-9"] }) }),
    );
    expect(dependencyStates(s, s.tickets.f!).map((d) => [d.key, d.done])).toEqual([
      ["E", true],
      ["A", false],
      ["ZZZ-9", false],
    ]);
  });
});

test("mergeById is stable for equal sort keys", () => {
  const out = mergeById([{ id: "b", n: 1 }], [{ id: "a", n: 1 }], (x) => x.n);
  expect(out.map((x) => x.id)).toEqual(["a", "b"]);
});

import { positionForDrop } from "./reducer";

describe("positionForDrop", () => {
  const col = [{ position: 1 }, { position: 2 }, { position: 4 }];
  test("between neighbours takes the midpoint", () => {
    expect(positionForDrop(col, 1)).toBe(1.5);
    expect(positionForDrop(col, 2)).toBe(3);
  });
  test("ends extend past the first/last card; out-of-range index clamps", () => {
    expect(positionForDrop(col, 0)).toBe(0);
    expect(positionForDrop(col, 3)).toBe(5);
    expect(positionForDrop(col, 99)).toBe(5);
    expect(positionForDrop(col, -3)).toBe(0);
  });
  test("empty column and equal neighbours", () => {
    expect(positionForDrop([], 0)).toBe(0);
    const p = positionForDrop([{ position: 2 }, { position: 2 }], 1);
    expect(p).toBeGreaterThan(2);
  });
  test("the result sorts where it was dropped", () => {
    for (let i = 0; i <= col.length; i++) {
      const p = positionForDrop(col, i);
      const sorted = [...col.map((c) => c.position), p].sort((a, b) => a - b);
      expect(sorted.indexOf(p)).toBe(i);
    }
  });
});

import { composerProject } from "./reducer";

describe("composerProject", () => {
  const withProjects = (...ps: Project[]) => ({ ...initialState, projects: Object.fromEntries(ps.map((p) => [p.id, p])) });

  test("resolves to a real project when the modal mounted before projects loaded", () => {
    // Regression: state was "" while the <select> displayed the first project, disabling Start.
    expect(composerProject(initialState, "", [null, null])).toBe("");
    expect(composerProject(withProjects(project("p1", "ZED"), project("p2", "ALPHA")), "", [null, null])).not.toBe("");
  });
  test("keeps an explicit choice that still exists", () => {
    const s = withProjects(project("p1", "A"), project("p2", "B"));
    expect(composerProject(s, "p2", ["p1", null])).toBe("p2");
  });
  test("drops a choice whose project was deleted, preferring route then last-used", () => {
    const s = withProjects(project("p1", "A"), project("p2", "B"));
    expect(composerProject(s, "gone", ["p2", "p1"])).toBe("p2");
    expect(composerProject(s, "gone", ["missing", "p1"])).toBe("p1");
  });
});
