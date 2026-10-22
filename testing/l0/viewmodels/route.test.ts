import { describe, expect, test } from "bun:test";
import { boardRoute, formatRoute, mirrorRoute, paneScopeOf, parseRoute, type Route } from "../../../app/src/renderer/state/route";

describe("parseRoute", () => {
  test("empty and unknown hashes are the All projects board", () => {
    for (const h of ["", "#", "#/", "#/board", "#/board/all", "#/nonsense"]) {
      const r = parseRoute(h);
      expect(r.view === "board" && r.projectId === null && r.ticketKey === null && r.tab === "spec").toBe(true);
    }
  });
  test("a project board and a ticket with a tab", () => {
    expect(parseRoute("#/board/p1/ticket/HAR-4/activity")).toEqual({ view: "board", projectId: "p1", ticketKey: "HAR-4", tab: "activity" });
  });
  test("a ticket straight after the view, with no project", () => {
    expect(parseRoute("#/board/ticket/HAR-4")).toEqual({ view: "board", projectId: null, ticketKey: "HAR-4", tab: "spec" });
  });
  test("a group board drops projectId", () => {
    expect(parseRoute("#/board/group/Web%20apps/ticket/X-1")).toEqual({ view: "board", projectId: null, group: "Web apps", ticketKey: "X-1", tab: "spec" });
  });
  test("a bare 'group' with no name is a project called group", () => {
    expect(parseRoute("#/board/group")).toMatchObject({ projectId: "group" });
  });
  test("renamed and unknown tabs fall back", () => {
    expect(parseRoute("#/board/ticket/A-1/summaries")).toMatchObject({ tab: "spec" });
    expect(parseRoute("#/board/ticket/A-1/bogus")).toMatchObject({ tab: "spec" });
    expect(parseRoute("#/board/ticket/A-1/plugin:git:changes")).toMatchObject({ tab: "changes" });
  });
  test("'ticket' with no key is not a ticket", () => {
    expect(parseRoute("#/board/p1/ticket")).toMatchObject({ projectId: "p1", ticketKey: null });
  });
  test("a chief of staff's views, the chat unless the inbox is named", () => {
    expect(parseRoute("#/cos/all")).toEqual({ view: "cos", scope: "all", tab: "chat" });
    expect(parseRoute("#/cos/all/inbox")).toEqual({ view: "cos", scope: "all", tab: "inbox" });
    expect(parseRoute("#/cos/group%3Ag1/inbox")).toEqual({ view: "cos", scope: "group:g1", tab: "inbox" });
    expect(parseRoute("#/cos/all/spec")).toEqual({ view: "cos", scope: "all", tab: "chat" });
  });
  test("a chief of staff with no valid scope falls through to the board", () => {
    expect(parseRoute("#/cos").view).toBe("board");
    expect(parseRoute("#/cos/nowhere/inbox").view).toBe("board");
    expect(parseRoute("#/cos/group:/inbox").view).toBe("board");
  });
  test("the old Inbox links open the board, whatever follows", () => {
    expect(parseRoute("#/inbox")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
    expect(parseRoute("#/inbox/s%2F1")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
  });
  test("settings, project and popout views", () => {
    expect(parseRoute("#/settings/drivers")).toEqual({ view: "settings", section: "drivers" });
    expect(parseRoute("#/project/p1/settings")).toEqual({ view: "project", projectId: "p1" });
    expect(parseRoute("#/popout/w1")).toEqual({ view: "popout", id: "w1", fromScope: "*" });
    expect(parseRoute("#/popout/w1/group:x")).toEqual({ view: "popout", id: "w1", fromScope: "group:x" });
  });
  test("project and popout without an id fall through to the board", () => {
    expect(parseRoute("#/project").view).toBe("board");
    expect(parseRoute("#/popout").view).toBe("board");
  });
});

describe("formatRoute", () => {
  const routes: Route[] = [
    { view: "board", projectId: null, ticketKey: null, tab: "spec" },
    { view: "board", projectId: "p 1", ticketKey: "A-1", tab: "activity" },
    { view: "board", projectId: null, group: "Web/apps", ticketKey: "A-1", tab: "changes" },
    { view: "cos", scope: "group:g/1", tab: "inbox" },
    { view: "cos", scope: "all", tab: "chat" },
    { view: "settings", section: null },
    { view: "project", projectId: "p1" },
    { view: "popout", id: "w1", fromScope: "group:x" },
  ];
  test("round-trips through parseRoute", () => {
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
  test("the default tab is omitted, others are kept", () => {
    expect(formatRoute({ view: "board", projectId: "p", ticketKey: "A-1", tab: "spec" })).toBe("#/board/p/ticket/A-1");
    expect(formatRoute({ view: "board", projectId: "p", ticketKey: "A-1", tab: "details" })).toBe("#/board/p/ticket/A-1/details");
  });
  test("no section is the bare view, and the chat tab is omitted", () => {
    expect(formatRoute({ view: "cos", scope: "all", tab: "chat" })).toBe("#/cos/all");
    expect(formatRoute({ view: "cos", scope: "group:g", tab: "inbox" })).toBe("#/cos/group%3Ag/inbox");
    expect(formatRoute({ view: "settings", section: null })).toBe("#/settings");
  });
});

describe("paneScopeOf / boardRoute / mirrorRoute", () => {
  test("scope is the group's, the project's, or all; null off the board", () => {
    expect(paneScopeOf({ view: "board", projectId: null, group: "g", ticketKey: null, tab: "spec" })).toBe("group:g");
    expect(paneScopeOf({ view: "board", projectId: "p", ticketKey: null, tab: "spec" })).toBe("p");
    expect(paneScopeOf({ view: "board", projectId: null, ticketKey: null, tab: "spec" })).toBe("*");
    expect(paneScopeOf({ view: "cos", scope: "all", tab: "chat" })).toBeNull();
  });
  test("boardRoute rebuilds a route for each kind of scope", () => {
    expect(boardRoute("*")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
    expect(boardRoute("p1", "A-1", "activity")).toEqual({ view: "board", projectId: "p1", ticketKey: "A-1", tab: "activity" });
    expect(boardRoute("group:g")).toEqual({ view: "board", projectId: null, group: "g", ticketKey: null, tab: "spec" });
  });
  test("mirrorRoute leaves non-board routes alone and follows the focused ticket", () => {
    const chief: Route = { view: "cos", scope: "all", tab: "chat" };
    expect(mirrorRoute(chief, { ticketKey: "A-1", tab: "spec" })).toBe(chief);
    const board: Route = { view: "board", projectId: "p", ticketKey: "A-9", tab: "details" };
    expect(mirrorRoute(board, { ticketKey: "A-1", tab: "activity" })).toEqual({ view: "board", projectId: "p", ticketKey: "A-1", tab: "activity" });
    expect(mirrorRoute(board, null)).toEqual({ view: "board", projectId: "p", ticketKey: null, tab: "spec" });
  });
  test("mirrorRoute keeps a group board's group", () => {
    const g: Route = { view: "board", projectId: null, group: "g", ticketKey: null, tab: "spec" };
    expect(mirrorRoute(g, { ticketKey: "A-1", tab: "spec" })).toEqual({ view: "board", projectId: null, group: "g", ticketKey: "A-1", tab: "spec" });
  });
});
