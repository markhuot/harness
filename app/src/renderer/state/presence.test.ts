import { describe, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { ALL_SCOPE, initialState, reducer, type Action, type State } from "@harness/shared/state";
import { defaultPanes, openTicket, toggleZoom, type PaneState } from "./panes";
import { parseRoute } from "./route";
import { boardCardKeys, presenceTickets } from "./presence";

const tk = (key: string, over: Partial<Ticket> = {}): Ticket =>
  ({
    id: key.toLowerCase(),
    key,
    projectId: "p1",
    kind: "task",
    title: key,
    spec: "",
    status: "planning",
    sessionId: `s-${key}`,
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
    permissionMode: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    model: null,
    position: 0,
    completedAt: null,
    createdAt: 10,
    updatedAt: 10,
    ...over,
  }) as Ticket;

const snapshot = (tickets: Ticket[], donePage?: { scope: string; tickets: Ticket[] }): Action => ({
  type: "snapshot",
  snapshot: {
    projects: [],
    tickets,
    sessions: [],
    watchers: [],
    settings: null,
    drivers: [],
    donePage: donePage ? { scope: donePage.scope, page: { tickets: donePage.tickets, nextCursor: "more", total: 40 } } : undefined,
  },
});
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);

const conductor = tk("P-1", { kind: "conductor", status: "in_progress" } as Partial<Ticket>);
const child = tk("P-2", { parentId: conductor.id, status: "in_progress" });
// A child waiting on the human stays on the board even with children hidden.
const childInReview = tk("P-3", { parentId: conductor.id, status: "blocked", blockedReason: "question" });
const planning = tk("P-4");
const doneLoaded = tk("P-5", { status: "done", completedAt: 500, updatedAt: 500 });
// Not in the paged-in prefix of Done (older than the loaded page): the board doesn't show it.
const doneOld = tk("P-6", { status: "done", completedAt: 100, updatedAt: 100 });
const otherProject = tk("Q-1", { projectId: "p2" });

const state = run(initialState, snapshot([conductor, child, childInReview, planning, doneLoaded, doneOld, otherProject], { scope: ALL_SCOPE, tickets: [doneLoaded] }));

const board = parseRoute("#/board/all");
const bare = defaultPanes("b1");

describe("boardCardKeys", () => {
  test("every column, with only the Done column's loaded page", () => {
    expect(boardCardKeys(state, ALL_SCOPE, false).sort()).toEqual(["P-1", "P-2", "P-3", "P-4", "P-5", "Q-1"]);
  });

  test("hidden children drop out, except one waiting on the human", () => {
    expect(boardCardKeys(state, ALL_SCOPE, true).sort()).toEqual(["P-1", "P-3", "P-4", "P-5", "Q-1"]);
  });

  test("while searching, the matches show, children included", () => {
    const searching = run(state, { type: "search.set", q: "P-2", scope: ALL_SCOPE });
    expect(boardCardKeys(searching, ALL_SCOPE, true)).toEqual(["P-2"]);
  });
});

describe("presenceTickets", () => {
  test("the board lists its cards and the ticket panes beside it", () => {
    const panes = openTicket(bare, "Z-9");
    expect(presenceTickets({ route: board, state, boardScope: ALL_SCOPE, panes, hideChildren: true })).toEqual(["P-1", "P-3", "P-4", "P-5", "Q-1", "Z-9"]);
  });

  test("a ticket pane zoomed over the board hides the board's cards", () => {
    const opened = openTicket(bare, "Z-9");
    const zoomed = toggleZoom(opened, opened.focusedId);
    expect(zoomed.zoomedId).not.toBeNull();
    expect(presenceTickets({ route: board, state, boardScope: ALL_SCOPE, panes: zoomed, hideChildren: false })).toEqual(["Z-9"]);
  });

  test("the board zoomed hides the ticket panes beside it", () => {
    const opened = openTicket(bare, "Z-9");
    const zoomed = toggleZoom(opened, "b1");
    expect(presenceTickets({ route: board, state, boardScope: ALL_SCOPE, panes: zoomed, hideChildren: true })).not.toContain("Z-9");
    expect(presenceTickets({ route: board, state, boardScope: ALL_SCOPE, panes: zoomed, hideChildren: true })).toContain("P-4");
  });

  test("off the board (Settings, Inbox, a project's settings) nothing is on screen", () => {
    for (const hash of ["#/settings/notifications", "#/inbox", "#/project/p1/settings"]) {
      expect(presenceTickets({ route: parseRoute(hash), state, boardScope: ALL_SCOPE, panes: null, hideChildren: false })).toEqual([]);
      // Even handed the board's panes by mistake, a route that isn't the board shows no cards.
      expect(presenceTickets({ route: parseRoute(hash), state, boardScope: ALL_SCOPE, panes: openTicket(bare, "Z-9"), hideChildren: false })).toEqual([]);
    }
  });

  test("a pop-out lists the ticket of its one pane, and no board cards", () => {
    const panes: PaneState = { root: { type: "leaf", id: "x1", content: { kind: "ticketTab", ticketKey: "Z-7", tab: "changes" } }, focusedId: "x1", zoomedId: null };
    expect(presenceTickets({ route: parseRoute("#/popout/abc/all"), state, boardScope: ALL_SCOPE, panes, hideChildren: false })).toEqual(["Z-7"]);
  });

  test("a pop-out whose pane is gone, or holds a terminal, shows no ticket", () => {
    const terminal: PaneState = { root: { type: "leaf", id: "x1", content: { kind: "terminal", sessionId: "t:1", cwd: "~" } }, focusedId: "x1", zoomedId: null };
    expect(presenceTickets({ route: parseRoute("#/popout/abc/all"), state, boardScope: ALL_SCOPE, panes: terminal, hideChildren: false })).toEqual([]);
    expect(presenceTickets({ route: parseRoute("#/popout/abc/all"), state, boardScope: ALL_SCOPE, panes: null, hideChildren: false })).toEqual([]);
  });

  test("a file pane resolved in a ticket counts for that ticket", () => {
    const panes: PaneState = { root: { type: "leaf", id: "x1", content: { kind: "file", root: { ticketKey: "Z-3" }, path: "README.md" } }, focusedId: "x1", zoomedId: null };
    expect(presenceTickets({ route: parseRoute("#/popout/abc/all"), state, boardScope: ALL_SCOPE, panes, hideChildren: false })).toEqual(["Z-3"]);
  });
});
