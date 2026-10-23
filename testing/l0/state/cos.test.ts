import { describe, expect, test } from "bun:test";
import type { Cos, CosChatEntry, CosEvent } from "../../../shared/src/cos";
import { anchoredScrollTop, canEscalate, cosBadgeCount, COS_TABS, inboxState, isCosTab, mergeChat, mergeEvents, nearTop, openEventCount, sortChiefs, triStateOf, triStateValue } from "../../../shared/src/state/cos";
import { applyEvent, initialState, reducer } from "../../../shared/src/state/reducer";

const msg = (id: string, createdAt: number, text = id, role: "user" | "assistant" = "assistant"): CosChatEntry => ({ id, cosId: "c1", createdAt, kind: "message", role, text });
const event = (id: string, patch: Partial<CosEvent> = {}): CosEvent => ({
  id,
  cosId: "c1",
  projectKey: null,
  sourceKind: "activity",
  title: id,
  summary: "",
  actor: "human",
  status: "pending",
  verdict: "pending",
  reason: null,
  model: null,
  ticketKey: null,
  wakeId: null,
  handledBy: null,
  outcome: null,
  createdAt: 1,
  ...patch,
});

describe("tabs", () => {
  test("a chief has Chat, Inbox and Listeners only", () => {
    expect([...COS_TABS]).toEqual(["chat", "inbox", "listeners"]);
    expect(isCosTab("inbox")).toBe(true);
    for (const t of ["spec", "activity", "children", "", undefined]) expect(isCosTab(t)).toBe(false);
  });
});

describe("mergeChat", () => {
  test("older pages go above, oldest first, whatever order they arrive in", () => {
    const live = [msg("c", 30), msg("d", 40)];
    const older = [msg("b", 20), msg("a", 10)]; // a page is newest first
    expect(mergeChat(live, older).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });
  test("an entry that arrived live and again in a page shows once", () => {
    const live = [msg("c", 30)];
    expect(mergeChat(live, [msg("c", 30), msg("b", 20)]).map((e) => e.id)).toEqual(["b", "c"]);
  });
  test("the incoming copy of an id wins; identical entries keep the same array", () => {
    const first = [msg("a", 1, "old")];
    expect(mergeChat(first, [msg("a", 1, "new")])[0]).toMatchObject({ text: "new" });
    expect(mergeChat(first, [msg("a", 1, "old")])).toBe(first);
  });
  test("entries with the same time keep a stable order by id", () => {
    expect(mergeChat([], [msg("b", 5), msg("a", 5)]).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("chat scrolling", () => {
  test("the reader stays on the same content after a page is prepended", () => {
    expect(anchoredScrollTop({ scrollTop: 20, scrollHeight: 1000 }, 1600)).toBe(620);
  });
  test("never scrolls above the top", () => {
    expect(anchoredScrollTop({ scrollTop: 0, scrollHeight: 1000 }, 900)).toBe(0);
  });
  test("asks for an older page only near the top", () => {
    expect(nearTop(0)).toBe(true);
    expect(nearTop(80)).toBe(true);
    expect(nearTop(81)).toBe(false);
  });
});

describe("Inbox", () => {
  test("newest first, each event once with its latest state", () => {
    const merged = mergeEvents([event("a", { createdAt: 1 }), event("b", { createdAt: 2 })], [event("a", { createdAt: 1, status: "ignored", verdict: "ignore" })]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
    expect(merged[1]!.status).toBe("ignored");
  });
  test("states in a word", () => {
    expect(inboxState(event("e", { status: "pending" }))).toBe("waiting");
    expect(inboxState(event("e", { status: "triaging" }))).toBe("waiting");
    expect(inboxState(event("e", { status: "ignored", verdict: "ignore" }))).toBe("ignored");
    expect(inboxState(event("e", { status: "escalated", verdict: "escalate" }))).toBe("escalated");
    expect(inboxState(event("e", { status: "handling", verdict: "escalate" }))).toBe("handling");
    expect(inboxState(event("e", { status: "handled", verdict: "escalate" }))).toBe("reviewed");
    for (const kind of ["acted", "no_action", "needs_user"] as const) expect(inboxState(event("e", { status: "handled", verdict: "escalate", outcome: { kind, text: "x" } }))).toBe(kind);
    expect(inboxState(event("e", { status: "escalated", verdict: "escalate", outcome: { kind: "acted", text: "stale" } }))).toBe("escalated");
    expect(inboxState(event("e", { status: "ignored", verdict: "filtered" }))).toBe("filtered");
  });
  test("only an ignored event can be escalated, never a filtered one", () => {
    expect(canEscalate(event("e", { status: "ignored", verdict: "ignore" }))).toBe(true);
    expect(canEscalate(event("e", { status: "ignored", verdict: "filtered" }))).toBe(false);
    expect(canEscalate(event("e", { status: "handled", verdict: "escalate" }))).toBe(false);
    expect(canEscalate(event("e", { status: "escalated", verdict: "escalate" }))).toBe(false);
  });
});

describe("badge", () => {
  test("a chief's count, zero for an unknown one or before the badge loads", () => {
    const badge = { total: 4, byCos: { c1: 3, c2: 1 } };
    expect(cosBadgeCount(badge, "c1")).toBe(3);
    expect(cosBadgeCount(badge, "nobody")).toBe(0);
    expect(cosBadgeCount(null, "c1")).toBe(0);
  });
  test("counts the events awaiting a verdict or handling, not settled ones or other chiefs'", () => {
    const events = [
      event("a", { status: "pending" }),
      event("b", { status: "escalated" }),
      event("c", { status: "handling" }),
      event("d", { status: "handled" }),
      event("e", { status: "ignored" }),
      event("f", { status: "pending", cosId: "c2" }),
    ];
    expect(openEventCount(events, "c1")).toBe(3);
  });
});

describe("project inheritance", () => {
  test("null inherits, a boolean overrides, and each choice saves what it names", () => {
    expect(triStateOf(null)).toBe("inherit");
    expect(triStateOf(undefined)).toBe("inherit");
    expect(triStateOf(true)).toBe("on");
    expect(triStateOf(false)).toBe("off");
    expect(triStateValue("inherit")).toBeNull();
    expect(triStateValue("on")).toBe(true);
    expect(triStateValue("off")).toBe(false);
  });
});

describe("sortChiefs", () => {
  const chief = (ticketId: string, scope: Cos["scope"], groupId: string | null): Cos => ({ ticketId, key: ticketId, scope, groupId, enabled: true, createdAt: 1 });
  test("All projects first, then groups by name", () => {
    const names: Record<string, string> = { g1: "Web", g2: "Apps" };
    const sorted = sortChiefs([chief("a", "group:g1", "g1"), chief("b", "all", null), chief("c", "group:g2", "g2")], (id) => names[id] ?? "");
    expect(sorted.map((c) => c.ticketId)).toEqual(["b", "c", "a"]);
  });
});

describe("store", () => {
  test("a live chat entry and the same entry in a loaded page show once", () => {
    const live = applyEvent(initialState, { kind: "cos.transcript.appended", cosId: "c1", entry: msg("m2", 20) });
    const paged = reducer(live, { type: "cosChat", cosId: "c1", entries: [msg("m2", 20), msg("m1", 10)] });
    expect(paged.cosChat.c1!.map((e) => e.id)).toEqual(["m1", "m2"]);
  });
  test("events and the badge follow the bus; a pushed event replaces the loaded row", () => {
    let s = reducer(initialState, { type: "cosEvents", events: [event("e1", { status: "ignored", verdict: "ignore" })] });
    s = applyEvent(s, { kind: "cos.event.upserted", event: event("e1", { status: "escalated", verdict: "escalate" }) });
    s = applyEvent(s, { kind: "cos.badge", total: 1, byCos: { c1: 1 } });
    expect(s.cosEvents.e1!.status).toBe("escalated");
    expect(cosBadgeCount(s.cosBadge, "c1")).toBe(1);
  });
  test("the chief's own ticket upserting keeps it off the board but moves its message draft onto the chief", () => {
    const c: Cos = { ticketId: "t1", key: "COS-1", scope: "all", groupId: null, enabled: true, createdAt: 1 };
    const draft = { text: "hi", attachments: [], origin: "phone", updatedAt: 5 };
    const ticket = { id: "t1", key: "COS-1", kind: "cos", messageDraft: draft } as never;
    let s = reducer(initialState, { type: "chiefs", chiefs: [c] });
    s = applyEvent(s, { kind: "ticket.upserted", ticket });
    expect(s.chiefs.t1!.messageDraft).toEqual(draft);
    expect(s.tickets.t1).toBeUndefined();
    s = applyEvent(s, { kind: "ticket.upserted", ticket: { id: "t1", key: "COS-1", kind: "cos", messageDraft: null } as never });
    expect(s.chiefs.t1!.messageDraft).toBeNull();
    // A chief the client doesn't hold yet is ignored.
    expect(applyEvent(initialState, { kind: "ticket.upserted", ticket })).toBe(initialState);
  });
  test("a chief changed in place replaces its entry", () => {
    const c: Cos = { ticketId: "t1", key: "COS-1", scope: "all", groupId: null, enabled: true, createdAt: 1 };
    const s = reducer(reducer(initialState, { type: "chiefs", chiefs: [c] }), { type: "chief", chief: { ...c, enabled: false } });
    expect(Object.values(s.chiefs)).toEqual([{ ...c, enabled: false }]);
  });
});
