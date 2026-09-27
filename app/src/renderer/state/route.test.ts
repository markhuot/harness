import { expect, test } from "bun:test";
import { formatRoute, parseRoute, type Route } from "./route";

test("parses board routes with and without a project", () => {
  expect(parseRoute("")).toEqual({ view: "board", projectId: null, ticketKey: null, tab: "summaries" });
  expect(parseRoute("#/board/p1")).toEqual({ view: "board", projectId: "p1", ticketKey: null, tab: "summaries" });
  // A ticket route without a project segment must not treat "ticket" as a project id.
  expect(parseRoute("#/board/ticket/FOO-1")).toEqual({ view: "board", projectId: null, ticketKey: "FOO-1", tab: "summaries" });
  expect(parseRoute("#/board/all/ticket/FOO-1/browser")).toMatchObject({ ticketKey: "FOO-1", tab: "browser" });
  expect(parseRoute("#/board/all/ticket/FOO-1/bogus")).toMatchObject({ tab: "summaries" });
});

test("round-trips every view", () => {
  const routes: Route[] = [
    { view: "board", projectId: null, ticketKey: null, tab: "summaries" },
    { view: "board", projectId: "p 1", ticketKey: "NYTIMES-3", tab: "transcript" },
    { view: "inbox", sessionId: "s1" },
    { view: "inbox", sessionId: null },
    { view: "settings", section: "watchers" },
  ];
  for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
});
