import { describe, expect, test } from "bun:test";
import { ACTIVITY_CATEGORY, NOTIFICATION_CATEGORIES, activityAuthorLabel, notificationAlert } from "../../../shared/src/notifications";

describe("activityAuthorLabel", () => {
  test("a conductor's work is labelled Conductor whoever the author field says", () => {
    expect(activityAuthorLabel("agent", { by: "conductor" })).toBe("Conductor");
    expect(activityAuthorLabel("human", { by: "conductor" })).toBe("Conductor");
  });
  test("agent, human and anything else", () => {
    expect(activityAuthorLabel("agent", {})).toBe("Agent");
    expect(activityAuthorLabel("human", {})).toBe("You");
    expect(activityAuthorLabel("system", {})).toBe("System");
  });
});

describe("notificationAlert", () => {
  const ticket = { key: "HAR-7", title: "Fix it" };
  const entry = (over: Record<string, unknown>) => ({ kind: "note", author: "agent", body: "", meta: {}, ...over }) as never;
  test("title is key and ticket title; subtitle is author and kind", () => {
    const a = notificationAlert(entry({ body: "hello" }), ticket);
    expect(a).toEqual({ title: "HAR-7 · Fix it", subtitle: "Agent · Note", body: "hello" });
  });
  test("a move names the destination column, or the raw status when unknown, or plain Moved without one", () => {
    expect(notificationAlert(entry({ kind: "moved", meta: { to: "in_progress" } }), ticket).subtitle).toBe("Agent · Moved to In progress");
    expect(notificationAlert(entry({ kind: "moved", meta: { to: "archived" } }), ticket).subtitle).toBe("Agent · Moved to archived");
    expect(notificationAlert(entry({ kind: "moved", meta: {} }), ticket).subtitle).toBe("Agent · Moved");
  });
  test("a non-move entry with meta.to ignores it", () => {
    expect(notificationAlert(entry({ kind: "note", meta: { to: "done" } }), ticket).subtitle).toBe("Agent · Note");
  });
  test("body falls back from the trimmed body to the trimmed question to the kind label", () => {
    expect(notificationAlert(entry({ body: "  hi  " }), ticket).body).toBe("hi");
    expect(notificationAlert(entry({ body: "  ", meta: { question: " Which? " } }), ticket).body).toBe("Which?");
    expect(notificationAlert(entry({ body: "", meta: { question: "  " } }), ticket).body).toBe("Note");
    expect(notificationAlert(entry({ kind: "moved", body: "", meta: { to: "done" } }), ticket).body).toBe("Moved to Done");
  });
  test("the conductor label shows in the subtitle", () => {
    expect(notificationAlert(entry({ kind: "review_approved", meta: { by: "conductor" } }), ticket).subtitle).toBe("Conductor · Review approved");
  });
});

test("every switchable category has at least one activity kind, and every kind maps to a known category", () => {
  const used = new Set(Object.values(ACTIVITY_CATEGORY));
  for (const c of NOTIFICATION_CATEGORIES) expect(used.has(c)).toBe(true);
  for (const c of used) expect(NOTIFICATION_CATEGORIES).toContain(c);
});
