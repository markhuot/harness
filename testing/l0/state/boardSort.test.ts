import { describe, expect, test } from "bun:test";
import type { Project, Run, Ticket, TranscriptEntry } from "../../../shared/src/index";
import {
  boardComparator,
  BOARD_SORT_DEFAULT,
  lastActiveOf,
  readBoardSort,
  readGroupByProject,
  sectionsByProject,
  writeBoardSort,
  writeGroupByProject,
} from "../../../shared/src/state/boardSort";
import { searchColumns } from "../../../shared/src/state/paging";
import { applyEvent, boardColumns, initialState, type State } from "../../../shared/src/state/reducer";
import { makeTicket } from "../../builders/ticket";

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => makeTicket({ status: "planning", key, id: `id-${key}`, sessionId: `s-${key}`, ...over });
const project = (id: string, name: string): Project => ({ id, key: id.toUpperCase(), name }) as Project;
const withTickets = (ts: Ticket[], projects: Project[] = []): State => ({
  ...initialState,
  tickets: Object.fromEntries(ts.map((t) => [t.id, t])),
  projects: Object.fromEntries(projects.map((p) => [p.id, p])),
});
const keys = (ts: Ticket[]) => ts.map((t) => t.key);
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("board order", () => {
  const old = ticket("A-1", { title: "zebra", position: 1, createdAt: 1, lastActiveAt: 100 });
  const fresh = ticket("A-2", { title: "Apple", position: 2, createdAt: 2, lastActiveAt: 900 });
  const mid = ticket("A-3", { title: "item 10", position: 3, createdAt: 3, lastActiveAt: 500 });
  const nine = ticket("A-4", { title: "Item 9", position: 4, createdAt: 4, lastActiveAt: 500 });
  const st = withTickets([old, fresh, mid, nine]);

  test("recent puts the latest activity first and breaks ties by creation order", () => {
    expect(keys(boardColumns(st, null, "recent").planning)).toEqual(["A-2", "A-3", "A-4", "A-1"]);
  });

  test("created keeps position, then age: the order before sorting existed (and the default)", () => {
    expect(keys(boardColumns(st, null, "created").planning)).toEqual(["A-1", "A-2", "A-3", "A-4"]);
    expect(keys(boardColumns(st, null).planning)).toEqual(["A-1", "A-2", "A-3", "A-4"]);
  });

  test("title sorts A to Z ignoring case, numbers by value, Untitled for a blank title", () => {
    const blank = ticket("A-5", { title: "  ", position: 5, createdAt: 5 });
    expect(keys(boardColumns(withTickets([old, fresh, mid, nine, blank]), null, "title").planning)).toEqual(["A-2", "A-4", "A-3", "A-5", "A-1"]);
  });

  test("done keeps newest-completed first whatever the sort", () => {
    const d1 = ticket("D-1", { status: "done", completedAt: 10, lastActiveAt: 999, title: "a" });
    const d2 = ticket("D-2", { status: "done", completedAt: 20, lastActiveAt: 1, title: "b" });
    for (const sort of ["recent", "title", "created"] as const) expect(keys(boardColumns(withTickets([d1, d2]), null, sort).done)).toEqual(["D-2", "D-1"]);
  });

  test("search results take the board's sort for live columns", () => {
    const s = { ...st, search: { q: "a", scope: "*", ids: [old.id, fresh.id], nextCursor: null, total: 2, loading: false, error: null } };
    expect(keys(searchColumns(s, null, "recent").columns.planning)).toEqual(["A-2", "A-1"]);
    expect(keys(searchColumns(s, null, "created").columns.planning)).toEqual(["A-1", "A-2"]);
  });

  test("a ticket from an older service without lastActiveAt sorts by updatedAt", () => {
    const legacy = ticket("L-1", { lastActiveAt: undefined, updatedAt: 700 });
    expect(lastActiveOf(legacy)).toBe(700);
    expect([old, legacy].sort(boardComparator("recent")).map((t) => t.key)).toEqual(["L-1", "A-1"]);
  });
});

describe("group by project", () => {
  test("sections come in project-name order, each keeping the column's order; unknown projects last", () => {
    const projects = { b: project("b", "Beta"), a: project("a", "alpha") };
    const ts = [ticket("B-1", { projectId: "b" }), ticket("X-1", { projectId: "gone" }), ticket("A-2", { projectId: "a" }), ticket("B-2", { projectId: "b" }), ticket("A-1", { projectId: "a" })];
    const sections = sectionsByProject(projects, ts);
    expect(sections.map((s) => [s.project?.name ?? null, keys(s.tickets)])).toEqual([
      ["alpha", ["A-2", "A-1"]],
      ["Beta", ["B-1", "B-2"]],
      [null, ["X-1"]],
    ]);
  });
});

describe("live activity moves lastActiveAt", () => {
  const t = ticket("A-1", { lastActiveAt: 1_000 });
  const st = withTickets([t, ticket("A-2", { lastActiveAt: 5_000 })]);
  const entry = (createdAt: number): TranscriptEntry =>
    ({ id: `e${createdAt}`, sessionId: t.sessionId, runId: null, subagentId: null, seq: 1, role: "user", content: { type: "text", text: "?" }, createdAt }) as TranscriptEntry;

  test("a transcript entry of the ticket's session brings it to the top of Recent activity", () => {
    const next = applyEvent(st, { kind: "transcript.appended", entry: entry(9_000) });
    expect(next.tickets[t.id]!.lastActiveAt).toBe(9_000);
    expect(keys(boardColumns(next, null, "recent").planning)).toEqual(["A-1", "A-2"]);
  });

  test("a run starting or ending counts at its latest timestamp", () => {
    const run = { id: "r", sessionId: t.sessionId, status: "succeeded", createdAt: 2_000, startedAt: 3_000, endedAt: 8_000 } as Run;
    expect(applyEvent(st, { kind: "run.upserted", run }).tickets[t.id]!.lastActiveAt).toBe(8_000);
  });

  test("under a second's change, an older entry or another session's leaves the tickets map alone", () => {
    expect(applyEvent(st, { kind: "transcript.appended", entry: entry(1_500) }).tickets).toBe(st.tickets);
    expect(applyEvent(st, { kind: "transcript.appended", entry: entry(500) }).tickets).toBe(st.tickets);
    expect(applyEvent(st, { kind: "transcript.appended", entry: { ...entry(9_000), sessionId: "nobody" } }).tickets).toBe(st.tickets);
  });
});

describe("preferences", () => {
  test("sort defaults to recent, remembers a choice and ignores an unknown value", () => {
    const kv = memory();
    expect(readBoardSort(kv)).toBe(BOARD_SORT_DEFAULT);
    expect(BOARD_SORT_DEFAULT).toBe("recent");
    writeBoardSort("title", kv);
    expect(readBoardSort(kv)).toBe("title");
    kv.setItem("harness.board.sort", "bogus");
    expect(readBoardSort(kv)).toBe("recent");
  });

  test("group by project is off until turned on", () => {
    const kv = memory();
    expect(readGroupByProject(kv)).toBe(false);
    writeGroupByProject(true, kv);
    expect(readGroupByProject(kv)).toBe(true);
  });
});
