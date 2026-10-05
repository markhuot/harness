import { expect, test } from "bun:test";
import { subagentTabRoute } from "@harness/shared/state";
import { ALL_SCOPE, groupScope } from "@harness/shared/state";
import { boardRoute, formatRoute, mirrorRoute, paneScopeOf, parsePluginTab, parseRoute, pluginTabRoute, type Route } from "./route";

test("parses board routes with and without a project", () => {
  expect(parseRoute("")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
  expect(parseRoute("#/board/p1")).toEqual({ view: "board", projectId: "p1", ticketKey: null, tab: "spec" });
  // A ticket route without a project segment must not treat "ticket" as a project id.
  expect(parseRoute("#/board/ticket/FOO-1")).toEqual({ view: "board", projectId: null, ticketKey: "FOO-1", tab: "spec" });
  expect(parseRoute("#/board/all/ticket/FOO-1/browser")).toMatchObject({ ticketKey: "FOO-1", tab: "browser" });
  expect(parseRoute("#/board/all/ticket/FOO-1/bogus")).toMatchObject({ tab: "spec" });
});

test("the Spec is the default tab and has no segment; Activity has one", () => {
  expect(formatRoute({ view: "board", projectId: null, ticketKey: "FOO-1", tab: "spec" })).toBe("#/board/all/ticket/FOO-1");
  const activity: Route = { view: "board", projectId: "p1", ticketKey: "FOO-1", tab: "activity" };
  expect(formatRoute(activity)).toBe("#/board/p1/ticket/FOO-1/activity");
  expect(parseRoute(formatRoute(activity))).toEqual(activity);
});

test("an old link to the Summaries tab opens the Spec and is rewritten without the segment", () => {
  const r = parseRoute("#/board/p1/ticket/FOO-1/summaries");
  expect(r).toEqual({ view: "board", projectId: "p1", ticketKey: "FOO-1", tab: "spec" });
  expect(formatRoute(r)).toBe("#/board/p1/ticket/FOO-1");
});

test("the conductor Tickets tab has its own route segment", () => {
  const r: Route = { view: "board", projectId: null, ticketKey: "HEL-1", tab: "children" };
  expect(formatRoute(r)).toBe("#/board/all/ticket/HEL-1/children");
  expect(parseRoute("#/board/all/ticket/HEL-1/children")).toEqual(r);
});

test("round-trips every view", () => {
  const routes: Route[] = [
    { view: "board", projectId: null, ticketKey: null, tab: "spec" },
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
  const r: Route = { view: "board", projectId: null, ticketKey: "HELLO-1", tab: pluginTabRoute("notes", "list") };
  expect(formatRoute(r)).toBe("#/board/all/ticket/HELLO-1/plugin:notes:list");
  expect(parseRoute(formatRoute(r))).toEqual(r);
  expect(parsePluginTab("plugin:git:changes")).toEqual({ pluginId: "git", tabId: "changes" });
  expect(parsePluginTab("details")).toBeNull();
  for (const bad of ["plugin:git", "plugin::x", "plugin:Git:changes", "plugin:git:changes:extra"]) {
    expect(parseRoute(`#/board/all/ticket/HELLO-1/${bad}`)).toMatchObject({ tab: "spec" });
  }
});

test("the built-in Changes tab is /changes, and the git plugin's old route opens it", () => {
  const r: Route = { view: "board", projectId: null, ticketKey: "HELLO-1", tab: "changes" };
  expect(formatRoute(r)).toBe("#/board/all/ticket/HELLO-1/changes");
  expect(parseRoute(formatRoute(r))).toEqual(r);
  expect(parseRoute("#/board/all/ticket/HELLO-1/plugin:git:changes")).toEqual(r);
});

test("a sub-agent's transcript round-trips as agent:<id>; the Agents list as agents", () => {
  const r: Route = { view: "board", projectId: "p1", ticketKey: "HELLO-1", tab: subagentTabRoute("toolu_01AbC") };
  expect(formatRoute(r)).toBe("#/board/p1/ticket/HELLO-1/agent:toolu_01AbC");
  expect(parseRoute(formatRoute(r))).toEqual(r);
  expect(parseRoute("#/board/p1/ticket/HELLO-1/agents")).toMatchObject({ tab: "agents" });
  // An encoded colon (a link copied from elsewhere) decodes to the same tab.
  expect(parseRoute("#/board/p1/ticket/HELLO-1/agent%3Atoolu_01AbC")).toMatchObject({ tab: "agent:toolu_01AbC" });
  for (const bad of ["agent:", "agent:a.b", "agents:x"]) expect(parseRoute(`#/board/all/ticket/HELLO-1/${bad}`)).toMatchObject({ tab: "spec" });
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

test("a group's board round-trips as /board/group/<name> (any characters), with its tickets, and has its own pane scope", () => {
  const r: Route = { view: "board", projectId: null, group: "Side / fun", ticketKey: "FOO-1", tab: "activity" };
  expect(formatRoute(r)).toBe("#/board/group/Side%20%2F%20fun/ticket/FOO-1/activity");
  expect(parseRoute(formatRoute(r))).toEqual(r);
  expect(parseRoute("#/board/group/Work")).toEqual({ view: "board", projectId: null, group: "Work", ticketKey: null, tab: "spec" });
  expect(paneScopeOf(r)).toBe(groupScope("Side / fun"));
  expect(paneScopeOf({ view: "board", projectId: "p1", ticketKey: null, tab: "spec" })).toBe("p1");
  // "group" without a name isn't a group (nor a project called "group").
  expect(parseRoute("#/board/group")).toMatchObject({ projectId: "group" });
});

test("a group's board keeps its group as the hash follows the focused pane, and boardRoute goes back to it", () => {
  const board: Route = { view: "board", projectId: null, group: "Work", ticketKey: null, tab: "spec" };
  expect(mirrorRoute(board, { ticketKey: "A-1", tab: "spec" })).toEqual({ ...board, ticketKey: "A-1" });
  expect(boardRoute(groupScope("Work"))).toEqual(board);
  expect(boardRoute(ALL_SCOPE)).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
  expect(boardRoute("p1", "A-1", "activity")).toEqual({ view: "board", projectId: "p1", ticketKey: "A-1", tab: "activity" });
});
