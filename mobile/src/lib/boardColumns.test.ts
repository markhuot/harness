import { describe, expect, test } from "bun:test";
import type { Ticket, TicketPage } from "@harness/shared";
import { boardColumns, initialState, reducer, type Action } from "@harness/shared/state";
import { columnCount, moveBody, visibleColumns } from "./boardColumns";

let seq = 0;
const tk = (id: string, extra: Partial<Ticket> = {}): Ticket =>
  ({
    id,
    key: `T-${id}`,
    title: id,
    description: "",
    status: "in_progress",
    kind: "task",
    projectId: "p1",
    parentId: null,
    dependsOn: [],
    pendingApproval: null,
    humanReview: "pending",
    position: 0,
    createdAt: ++seq,
    updatedAt: seq,
    completedAt: null,
    ...extra,
  }) as Ticket;
const keys = (ts: Ticket[]) => ts.map((t) => t.id);

// A conductor with a done child, a quiet in-progress child and a blocked one, plus 40 done tickets
// on the server of which the first page (3 newest) is loaded.
const conductor = tk("c", { kind: "conductor" });
const quietKid = tk("k1", { parentId: "c" });
const blockedKid = tk("k2", { parentId: "c", status: "blocked" });
const doneKid = tk("k3", { parentId: "c", status: "done", completedAt: 900 });
const d1 = tk("d1", { status: "done", completedAt: 800 });
const d2 = tk("d2", { status: "done", completedAt: 700 });
const page: TicketPage = { tickets: [doneKid, d1, d2], nextCursor: "c3", total: 40 };
const snapshot: Action = { type: "snapshot", snapshot: { projects: [], tickets: [conductor, quietKid, blockedKid], sessions: [], watchers: [], settings: null, drivers: [], donePage: { scope: "p1", page } } };
const state = reducer(initialState, snapshot);
const board = boardColumns(state, "p1");

describe("visibleColumns", () => {
  test("hides quiet children, keeps one the human has to act on", () => {
    const shown = visibleColumns(board, true);
    expect(keys(shown.in_progress)).toEqual(["c"]);
    expect(keys(shown.blocked)).toEqual(["k2"]);
    expect(keys(shown.done)).toEqual(["d1", "d2"]);
  });

  test("Show child tickets puts them all back", () => {
    const shown = visibleColumns(board, false);
    expect(keys(shown.in_progress).sort()).toEqual(["c", "k1"]);
    expect(keys(shown.done)).toEqual(["k3", "d1", "d2"]);
  });
});

describe("columnCount", () => {
  test("Done counts the server total even while children are hidden", () => {
    const shown = visibleColumns(board, true);
    expect(shown.done.length).toBe(2);
    expect(columnCount(state, "p1", shown, "done", false)).toBe(40);
    expect(columnCount(state, "p1", shown, "in_progress", false)).toBe(1);
  });

  test("search results count what's shown, Done included", () => {
    const shown = visibleColumns(board, true);
    expect(columnCount(state, "p1", shown, "done", true)).toBe(2);
  });

  test("without paging (an older service) Done counts what's loaded", () => {
    const legacy = reducer(initialState, { type: "snapshot", snapshot: { projects: [], tickets: [d1, d2], sessions: [], watchers: [], settings: null, drivers: [] } });
    const shown = visibleColumns(boardColumns(legacy, "p1"), true);
    expect(columnCount(legacy, "p1", shown, "done", false)).toBe(2);
  });
});

describe("moveBody", () => {
  const a = tk("a", { status: "planning", position: 1 });
  const b = tk("b", { status: "planning", position: 2 });
  const c = tk("c2", { status: "in_progress", position: 5 });
  const cols = { ...boardColumns(initialState, null), planning: [a, b], in_progress: [c] };

  test("into Done: the status only, and it's the newest completion", () => {
    expect(moveBody(c, "done", "bottom", cols, 1234)).toEqual({ body: { status: "done" }, completedAt: 1234 });
  });

  test("out of Done clears completedAt and takes a position in the new column", () => {
    const old = tk("o", { status: "done", completedAt: 50 });
    expect(moveBody(old, "planning", "top", cols)).toEqual({ body: { status: "planning", position: 0 }, completedAt: null });
    expect(moveBody(old, "planning", "bottom", cols)!.body.position).toBe(3);
  });

  test("within a column: a position around the others, not counting the card itself", () => {
    expect(moveBody(b, "planning", "top", cols)).toEqual({ body: { position: 0 }, completedAt: null });
    expect(moveBody(a, "planning", "bottom", cols)).toEqual({ body: { position: 3 }, completedAt: null });
  });

  test("a done card moved within Done changes nothing", () => {
    expect(moveBody(d1, "done", "top", cols)).toBeNull();
  });
});
