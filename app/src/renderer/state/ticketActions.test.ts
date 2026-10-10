import { describe, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { actionMenuItems, paletteEntries, pickedAction, ticketActions, type TicketActionContext } from "./ticketActions";

const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const t = (over: Partial<Ticket>): Ticket => ({ id: "t1", key: "K-1", status: "planning", busy: false, humanReview: "pending", agentReview: "pending", draft: false, dependsOn: [], autoStart: false, ...over }) as Ticket;
const ctx = (over: Partial<TicketActionContext> = {}): TicketActionContext => ({ project: gh, base: null, deps: [], ...over });
const labels = (ticket: Ticket, c: Partial<TicketActionContext> = {}) => ticketActions(ticket, ctx(c)).enabled.map((a) => a.label);

describe("ticketActions", () => {
  test("planning offers Start work, and Approve plan while its planning run is going", () => {
    expect(labels(t({}))).toEqual(["Start work", "Move to done", "Delete ticket"]);
    expect(labels(t({ busy: true }))).toEqual(["Approve plan", "Move to done", "Cancel run", "Delete ticket"]);
  });

  test("an approved plan and a ticket waiting on dependencies offer no Start", () => {
    expect(labels(t({ busy: true, startAfterPlan: true }))).toEqual(["Move to done", "Cancel run", "Delete ticket"]);
    const waiting = t({ autoStart: true, dependsOn: ["K-9"] });
    expect(labels(waiting, { deps: [{ key: "K-9", done: false, state: "pending" }] })).toEqual(["Move to done", "Delete ticket"]);
    expect(labels(waiting, { deps: [{ key: "K-9", done: true, state: "done" }] })[0]).toBe("Start work");
  });

  test("review offers Approve with its ways, Request changes and the agent review", () => {
    const set = ticketActions(t({ status: "review" }), ctx());
    expect(set.enabled.map((a) => a.label)).toEqual(["Approve and merge", "Request changes", "Re-run agent review", "Delete ticket"]);
    expect(set.primary[0]!.land!.items.map((i) => i.label)).toEqual(["Approve and merge", "Approve and open PR", "Approve and clean up", "Approve and…"]);
    expect(labels(t({ status: "review", agentReview: "skipped" }))).toContain("Run agent review");
  });

  test("an approved review offers neither Approve nor Request changes", () => {
    expect(labels(t({ status: "review", humanReview: "approved" }))).toEqual(["Re-run agent review", "Delete ticket"]);
  });

  test("a conductor-managed review keeps its Approve, off, with the reason, until the conductor is done", () => {
    const child = t({ status: "review", parentId: "p1" });
    const parent = t({ id: "p1", key: "K-P", status: "in_progress" });
    const set = ticketActions(child, ctx({ parent }));
    expect(set.primary[0]).toMatchObject({ id: "approve", enabled: false, managedReason: "Conductor managed: K-P approves and lands this ticket" });
    expect(set.enabled.map((a) => a.id)).toEqual(["requestChanges", "rerunReview", "delete"]);
    expect(labels(child, { parent: { ...parent, status: "done" } })[0]).toBe("Approve and merge");
  });

  test("a busy review turns the agent review off, and done offers Re-open", () => {
    expect(ticketActions(t({ status: "review", busy: true }), ctx()).more[0]).toMatchObject({ id: "rerunReview", enabled: false });
    expect(labels(t({ status: "done" }))).toEqual(["Re-open", "Delete ticket"]);
    expect(labels(t({ status: "in_progress" }))).toEqual(["Move to done", "Delete ticket"]);
  });

  test("compacting turns everything off but Cancel run", () => {
    expect(ticketActions(t({ status: "in_progress", busy: true, compacting: true }), ctx()).enabled.map((a) => a.id)).toEqual(["cancelRun"]);
    expect(labels(t({ status: "review", compacting: true }))).toEqual([]);
  });

  test("a draft offers nothing, and Cancel run and Delete are destructive", () => {
    expect(ticketActions(t({ draft: true }), ctx()).enabled).toEqual([]);
    const more = ticketActions(t({ status: "in_progress", busy: true }), ctx()).more;
    expect(more.filter((a) => a.destructive).map((a) => a.id)).toEqual(["cancelRun", "delete"]);
  });
});

describe("the card's menu", () => {
  const review = ticketActions(t({ status: "review" }), ctx()).enabled;

  test("Approve is a submenu of the ways to approve, taking no action after a separator", () => {
    const [approve, ...rest] = actionMenuItems(review);
    expect(approve).toMatchObject({ label: "Approve" });
    const sub = (approve as { submenu: { label?: string; type?: string }[] }).submenu;
    expect(sub.map((i) => i.label ?? i.type)).toEqual(["Approve and merge", "Approve and open PR", "Approve and clean up", "Approve and…", "separator", "Approve and take no action"]);
    expect(rest.map((i) => ("label" in i ? i.label : i.type))).toEqual(["Request changes", "Re-run agent review", "Delete ticket"]);
  });

  test("a picked id runs its action, and an Approve choice carries the choice", () => {
    expect(pickedAction(review, "action:requestChanges")?.action.id).toBe("requestChanges");
    const sub = (actionMenuItems(review)[0] as { submenu: { id?: string }[] }).submenu;
    const custom = pickedAction(review, sub[3]!.id!);
    expect(custom?.choice).toMatchObject({ kind: "sheet", action: "custom" });
    expect(pickedAction(review, sub[5]!.id!)?.choice).toMatchObject({ kind: "none" });
  });

  test("an id that isn't the card's offers nothing", () => {
    expect(pickedAction(review, "open")).toBeNull();
    expect(pickedAction(review, null)).toBeNull();
    expect(pickedAction(review, "action:start")).toBeNull();
    expect(pickedAction(review, "action:approve:99")).toBeNull();
  });
});

describe("the palette's commands", () => {
  const ids = (ticket: Ticket, c: Partial<TicketActionContext> = {}) => Object.keys(paletteEntries(ticketActions(ticket, ctx(c)))).sort();

  test("a review ticket offers the ways to approve but not Move to done", () => {
    const got = ids(t({ status: "review" }));
    expect(got).toContain("ticket.approve");
    expect(got).toContain("ticket.land.pr"); // merge is the primary, so it has no command of its own
    expect(got).toContain("ticket.approveNoAction");
    expect(got).not.toContain("ticket.markDone");
  });

  test("a compacting ticket offers only Cancel run", () => {
    expect(ids(t({ status: "review", compacting: true, busy: true }))).toEqual(["ticket.cancelRun"]);
  });

  test("an approve choice carries its land choice, and a plain action carries none", () => {
    const e = paletteEntries(ticketActions(t({ status: "review" }), ctx()));
    expect(e["ticket.land.custom"]!.choice).toMatchObject({ action: "custom" });
    expect(e["ticket.approveNoAction"]!.choice).toMatchObject({ kind: "none" });
    expect(e["ticket.requestChanges"]!.choice).toBeUndefined();
  });

  test("a draft offers no ticket actions", () => {
    expect(ids(t({ draft: true }))).toEqual([]);
  });
});
