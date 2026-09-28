import { expect, test } from "bun:test";
import { formatRoute, mirrorRoute, parsePluginTab, parseRoute, pluginTabRoute, type Route } from "./route";

test("parses board routes with and without a project", () => {
  expect(parseRoute("")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "summaries" });
  expect(parseRoute("#/board/p1")).toEqual({ view: "board", projectId: "p1", ticketKey: null, tab: "summaries" });
  // A ticket route without a project segment must not treat "ticket" as a project id.
  expect(parseRoute("#/board/ticket/FOO-1")).toEqual({ view: "board", projectId: null, ticketKey: "FOO-1", tab: "summaries" });
  expect(parseRoute("#/board/all/ticket/FOO-1/browser")).toMatchObject({ ticketKey: "FOO-1", tab: "browser" });
  expect(parseRoute("#/board/all/ticket/FOO-1/bogus")).toMatchObject({ tab: "summaries" });
});

test("the conductor Tickets tab has its own route segment", () => {
  const r: Route = { view: "board", projectId: null, ticketKey: "HEL-1", tab: "children" };
  expect(formatRoute(r)).toBe("#/board/all/ticket/HEL-1/children");
  expect(parseRoute("#/board/all/ticket/HEL-1/children")).toEqual(r);
});

test("round-trips every view", () => {
  const routes: Route[] = [
    { view: "board", projectId: null, ticketKey: null, tab: "summaries" },
    { view: "board", projectId: "p 1", ticketKey: "NYTIMES-3", tab: "transcript" },
    { view: "inbox", sessionId: "s1" },
    { view: "inbox", sessionId: null },
    { view: "settings", section: "watchers" },
    { view: "project", projectId: "p 1" },
  ];
  for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
});

test("project settings route", () => {
  expect(formatRoute({ view: "project", projectId: "p1" })).toBe("#/project/p1/settings");
  expect(parseRoute("#/project/p1/settings")).toEqual({ view: "project", projectId: "p1" });
  expect(parseRoute("#/project/p1")).toEqual({ view: "project", projectId: "p1" });
  // No id: nothing to show, fall back to the board.
  expect(parseRoute("#/project")).toMatchObject({ view: "board" });
});

test("plugin tabs round-trip as plugin:<id>:<tab>; malformed ones fall back to summaries", () => {
  const r: Route = { view: "board", projectId: null, ticketKey: "HELLO-1", tab: pluginTabRoute("git", "changes") };
  expect(formatRoute(r)).toBe("#/board/all/ticket/HELLO-1/plugin:git:changes");
  expect(parseRoute(formatRoute(r))).toEqual(r);
  expect(parsePluginTab("plugin:git:changes")).toEqual({ pluginId: "git", tabId: "changes" });
  expect(parsePluginTab("details")).toBeNull();
  for (const bad of ["plugin:git", "plugin::x", "plugin:Git:changes", "plugin:git:changes:extra"]) {
    expect(parseRoute(`#/board/all/ticket/HELLO-1/${bad}`)).toMatchObject({ tab: "summaries" });
  }
});

test("the board hash mirrors the focused ticket pane and keeps the project filter", () => {
  const board: Route = { view: "board", projectId: "p1", ticketKey: "A-1", tab: "transcript" };
  expect(formatRoute(mirrorRoute(board, { ticketKey: "B-2", tab: "details" }))).toBe("#/board/p1/ticket/B-2/details");
  // The board (or nothing) focused: the hash drops the ticket.
  expect(formatRoute(mirrorRoute(board, null))).toBe("#/board/p1");
  // Other views aren't touched.
  const inbox: Route = { view: "inbox", sessionId: "s1" };
  expect(mirrorRoute(inbox, { ticketKey: "B-2", tab: "details" })).toBe(inbox);
});
