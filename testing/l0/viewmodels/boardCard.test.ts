import { describe, expect, test } from "bun:test";
import { initialState } from "@harness/shared/state";
import { cardPropsEqual, type CardProps } from "../../../app/src/renderer/state/boardCard";
import { makeTicket } from "../../builders/ticket";

const plain = makeTicket({ key: "A-1", status: "in_progress" });
const props = (o: Partial<CardProps> = {}): CardProps => ({ ticket: plain, state: initialState, selected: null, isCursor: false, showProject: false, related: false, ...o });

describe("cardPropsEqual", () => {
  test("identical props are equal", () => {
    expect(cardPropsEqual(props(), props())).toBe(true);
  });
  test("a new ticket object re-renders, even with equal contents", () => {
    expect(cardPropsEqual(props(), props({ ticket: { ...plain } }))).toBe(false);
  });
  test.each([
    ["selected", { selected: "open" as const }],
    ["isCursor", { isCursor: true }],
    ["showProject", { showProject: true }],
    ["related", { related: true }],
  ])("a changed %s re-renders", (_name, change) => {
    expect(cardPropsEqual(props(), props(change))).toBe(false);
  });
  test("a changed activity list for this ticket's session re-renders; another session's doesn't", () => {
    const a = [{ id: "e1" }] as never;
    const mine = { ...initialState, activity: { [plain.sessionId]: a } };
    expect(cardPropsEqual(props(), props({ state: mine }))).toBe(false);
    const other = { ...initialState, activity: { "session-OTHER": a } };
    expect(cardPropsEqual(props(), props({ state: other }))).toBe(true);
  });
  test("projects, settings, key aliases and missing keys each re-render", () => {
    expect(cardPropsEqual(props(), props({ state: { ...initialState, projects: {} } }))).toBe(false);
    expect(cardPropsEqual(props(), props({ state: { ...initialState, settings: {} as never } }))).toBe(false);
    expect(cardPropsEqual(props(), props({ state: { ...initialState, keyAliases: {} } }))).toBe(false);
    expect(cardPropsEqual(props(), props({ state: { ...initialState, missingKeys: {} } }))).toBe(false);
  });
  test("an unrelated state slice changing doesn't re-render", () => {
    expect(cardPropsEqual(props(), props({ state: { ...initialState, activity: initialState.activity } }))).toBe(true);
    expect(cardPropsEqual(props(), props({ state: { ...initialState, selectedProjectId: "x" } as never }))).toBe(true);
  });
  describe("the tickets map matters only to tickets that read it", () => {
    const moved = { ...initialState, tickets: {} };
    test("a plain ticket ignores it", () => {
      expect(cardPropsEqual(props(), props({ state: moved }))).toBe(true);
    });
    test.each([
      ["has dependencies", { dependsOn: ["T-2"] }],
      ["is a conductor by kind", { kind: "conductor" as const }],
      ["is a conductor by having children", { childCount: 2 }],
      ["is a child", { parentId: "parent-id" }],
    ])("a ticket that %s re-renders", (_name, extra) => {
      const t = makeTicket({ key: "A-2", status: "in_progress", ...extra });
      expect(cardPropsEqual(props({ ticket: t }), props({ ticket: t, state: moved }))).toBe(false);
      expect(cardPropsEqual(props({ ticket: t }), props({ ticket: t }))).toBe(true);
    });
  });
});
