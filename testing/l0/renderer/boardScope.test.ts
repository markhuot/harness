import { describe, expect, test } from "bun:test";
import { ALL_SCOPE, groupScope, initialState, type State } from "@harness/shared/state";
import { boardProjectOf, boardScopeOf } from "../../../app/src/renderer/state/boardScope";
import type { Route } from "../../../app/src/renderer/state/route";

const state = { ...initialState, projects: { p1: { id: "p1", key: "ONE", name: "One", path: "/x", nextSeq: 1 } } } as unknown as State;
const board = (o: Partial<Extract<Route, { view: "board" }>> = {}): Route => ({ view: "board", projectId: null, ticketKey: null, tab: "spec", ...o });

describe("boardProjectOf", () => {
  test("names the project when it exists", () => {
    expect(boardProjectOf(state, board({ projectId: "p1" }))).toBe("p1");
  });
  test("an unknown project id is all projects", () => {
    expect(boardProjectOf(state, board({ projectId: "gone" }))).toBeNull();
  });
  test("no project is null", () => {
    expect(boardProjectOf(state, board())).toBeNull();
  });
  test("a group board has no project even if projectId is set", () => {
    expect(boardProjectOf(state, board({ projectId: "p1", group: "g" }))).toBeNull();
  });
  test("other views have no board project", () => {
    expect(boardProjectOf(state, { view: "cos", scope: "all", tab: "chat" })).toBeNull();
    expect(boardProjectOf(state, { view: "project", projectId: "p1" })).toBeNull();
  });
});

describe("boardScopeOf", () => {
  test("a group's scope, even with no project in it", () => {
    expect(boardScopeOf(state, board({ group: "Ghosts" }))).toBe(groupScope("Ghosts"));
  });
  test("a route that names the group (saved before groups had ids) scopes to its id", () => {
    const grouped = { ...state, projects: { p1: { ...state.projects.p1!, groupId: "g-1", group: "Work" } } } as State;
    expect(boardScopeOf(grouped, board({ group: "work" }))).toBe(groupScope("g-1"));
    expect(boardScopeOf(grouped, board({ group: "g-1" }))).toBe(groupScope("g-1"));
  });
  test("a valid project's id", () => {
    expect(boardScopeOf(state, board({ projectId: "p1" }))).toBe("p1");
  });
  test("unknown project and no project both fall to All projects", () => {
    expect(boardScopeOf(state, board({ projectId: "gone" }))).toBe(ALL_SCOPE);
    expect(boardScopeOf(state, board())).toBe(ALL_SCOPE);
  });
  test("non-board routes are All projects", () => {
    expect(boardScopeOf(state, { view: "settings", section: null })).toBe(ALL_SCOPE);
  });
});
