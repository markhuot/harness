import { describe, expect, test } from "bun:test";
import { initialState, type State } from "@harness/shared/state";
import type { PaneContent, PaneLeaf, PaneState } from "../../../app/src/renderer/state/paneModel";
import { boardCardKeys, presenceTerminals, presenceTickets } from "../../../app/src/renderer/state/presence";
import type { Route } from "../../../app/src/renderer/state/route";
import { makeTicket } from "../../builders/ticket";

const leaf = (id: string, content: PaneContent): PaneLeaf => ({ type: "leaf", id, content });
const panes = (contents: PaneContent[], zoomedId: string | null = null): PaneState => ({
  root: { type: "split", id: "s", dir: "row", children: contents.map((c, i) => leaf(`l${i}`, c)), sizes: contents.map(() => 1 / contents.length) },
  focusedId: null,
  zoomedId,
});
const board: Route = { view: "board", projectId: null, ticketKey: null, tab: "spec" };
const stateWith = (tickets: ReturnType<typeof makeTicket>[], extra: Partial<State> = {}): State => ({
  ...initialState,
  tickets: Object.fromEntries(tickets.map((t) => [t.id, t])),
  ...extra,
});
const input = (p: PaneState | null, o: Partial<Parameters<typeof presenceTickets>[0]> = {}) => ({ route: board, state: stateWith([]), boardScope: "*", panes: p, hideChildren: false, ...o });

describe("boardCardKeys", () => {
  const a = makeTicket({ key: "A-1", status: "in_progress" });
  const child = makeTicket({ key: "A-2", status: "in_progress", parentId: a.id });
  const needy = makeTicket({ key: "A-3", status: "blocked", parentId: a.id });
  const done = makeTicket({ key: "A-4", status: "done" });

  test("every open card, in column order", () => {
    expect(boardCardKeys(stateWith([a, child, needy]), "*", false)).toEqual(["A-1", "A-2", "A-3"]);
  });
  test("hiding children drops quiet children but keeps one that needs the human", () => {
    expect(boardCardKeys(stateWith([a, child, needy]), "*", true)).toEqual(["A-1", "A-3"]);
  });
  test("done tickets come last, after the open columns", () => {
    expect(boardCardKeys(stateWith([done, a]), "*", false)).toEqual(["A-1", "A-4"]);
  });
  test("searching lists the matches only, children included even when hidden", () => {
    const search = { q: "A-2", scope: "*", ids: null, nextCursor: null, total: 0, loading: false, error: null };
    expect(boardCardKeys(stateWith([a, child], { search }), "*", true)).toEqual(["A-2"]);
  });
});

describe("presenceTickets", () => {
  test("no panes, or a route that isn't a board or pop-out, is empty", () => {
    expect(presenceTickets(input(null))).toEqual([]);
    expect(presenceTickets(input(panes([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }]), { route: { view: "settings", section: null } }))).toEqual([]);
  });
  test("ticket panes, torn-off tabs and files resolved in a ticket count; project files and terminals don't", () => {
    const p = panes([
      { kind: "ticket", ticketKey: "B-2", tab: "spec" },
      { kind: "ticketTab", ticketKey: "A-1", tab: "activity" },
      { kind: "file", root: { ticketKey: "C-3" }, path: "x.ts" },
      { kind: "file", root: { projectId: "p" }, path: "y.ts" },
      { kind: "terminal", sessionId: "s1", cwd: "/" },
    ]);
    expect(presenceTickets(input(p))).toEqual(["A-1", "B-2", "C-3"]);
  });
  test("a ticket open twice is listed once", () => {
    const p = panes([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }, { kind: "ticketTab", ticketKey: "A-1", tab: "activity" }]);
    expect(presenceTickets(input(p))).toEqual(["A-1"]);
  });
  test("panes hidden behind a zoomed one aren't on screen", () => {
    const p = panes([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }, { kind: "ticket", ticketKey: "B-1", tab: "spec" }], "l1");
    expect(presenceTickets(input(p))).toEqual(["B-1"]);
  });
  test("a showing board pane adds its cards; a zoomed-over board doesn't", () => {
    const s = stateWith([makeTicket({ key: "A-1", status: "review" })]);
    const p = panes([{ kind: "board" }, { kind: "ticket", ticketKey: "Z-9", tab: "spec" }]);
    expect(presenceTickets(input(p, { state: s }))).toEqual(["A-1", "Z-9"]);
    expect(presenceTickets(input({ ...p, zoomedId: "l1" }, { state: s }))).toEqual(["Z-9"]);
  });
  test("in a pop-out the board pane contributes no cards", () => {
    const s = stateWith([makeTicket({ key: "A-1", status: "review" })]);
    expect(presenceTickets(input(panes([{ kind: "board" }]), { state: s, route: { view: "popout", id: "w", fromScope: "*" } }))).toEqual([]);
  });
});

describe("presenceTerminals", () => {
  test("sorted, de-duplicated sessions of visible terminal panes", () => {
    const p = panes([
      { kind: "terminal", sessionId: "t2", cwd: "/" },
      { kind: "terminal", sessionId: "t1", cwd: "/" },
      { kind: "terminal", sessionId: "t2", cwd: "/" },
      { kind: "ticket", ticketKey: "A-1", tab: "spec" },
    ]);
    expect(presenceTerminals({ route: board, panes: p })).toEqual(["t1", "t2"]);
  });
  test("zoomed-over terminals and off-board routes report none", () => {
    const p = panes([{ kind: "terminal", sessionId: "t1", cwd: "/" }, { kind: "terminal", sessionId: "t2", cwd: "/" }], "l0");
    expect(presenceTerminals({ route: board, panes: p })).toEqual(["t1"]);
    expect(presenceTerminals({ route: { view: "settings", section: null }, panes: p })).toEqual([]);
    expect(presenceTerminals({ route: board, panes: null })).toEqual([]);
  });
});
