import { describe, expect, test } from "bun:test";
import { ACTIVITY_CATEGORY, NOTIFICATION_CATEGORIES, notificationAlert } from "./notifications";
import { ACTIVITY_KINDS } from "./protocol";

describe("ACTIVITY_CATEGORY", () => {
  test("maps every activity kind, and nothing else, to a known category", () => {
    expect(Object.keys(ACTIVITY_CATEGORY).sort()).toEqual([...ACTIVITY_KINDS].sort());
    for (const cat of Object.values(ACTIVITY_CATEGORY)) expect(NOTIFICATION_CATEGORIES).toContain(cat);
  });

  test("every category has at least one kind, so each switch does something", () => {
    for (const cat of NOTIFICATION_CATEGORIES) expect(Object.values(ACTIVITY_CATEGORY)).toContain(cat);
  });
});

describe("notificationAlert", () => {
  const ticket = { key: "SPEC-123", title: "Fix the login" };

  test("titles with the key and ticket title, subtitles with the author and kind", () => {
    expect(notificationAlert({ kind: "note", author: "agent", body: "Tests pass", meta: {} }, ticket)).toEqual({
      title: "SPEC-123 · Fix the login",
      subtitle: "Agent · Note",
      body: "Tests pass",
    });
  });

  test("a conductor's decision is labeled Conductor, not Agent", () => {
    expect(notificationAlert({ kind: "approved", author: "agent", body: "LGTM", meta: { by: "conductor" } }, ticket).subtitle).toBe("Conductor · Approved");
  });

  test("a move names the column it went to", () => {
    expect(notificationAlert({ kind: "moved", author: "system", body: "", meta: { from: "review", to: "done" } }, ticket)).toMatchObject({
      subtitle: "System · Moved to Done",
      body: "Moved to Done",
    });
  });

  test("an empty body falls back to the blocked question", () => {
    expect(notificationAlert({ kind: "blocked", author: "agent", body: " ", meta: { question: "Which API?" } }, ticket).body).toBe("Which API?");
  });
});
