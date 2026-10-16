import { describe, expect, test } from "bun:test";
import { actionMenuItems, paletteEntries, pickedAction, ticketActions, type TicketActionContext } from "../../../app/src/renderer/state/ticketActions";
import { makeTicket } from "../../builders/ticket";

const project = { isGit: true, completionAction: "merge", completionActions: undefined, pullRequestHost: null } as never;
const ctx = (o: Partial<TicketActionContext> = {}): TicketActionContext => ({ project, base: "main", deps: [], ...o });
const ids = (list: { id: string }[]) => list.map((a) => a.id);
const review = (o = {}) => makeTicket({ status: "review", branch: "harness/x", ...o });

describe("ticketActions", () => {
  test("a draft offers nothing", () => {
    expect(ticketActions(makeTicket({ status: "planning", draft: true }), ctx())).toEqual({ primary: [], more: [], enabled: [] });
  });
  test("planning idle offers Start work; busy offers Approve plan; approved plan offers neither", () => {
    expect(ticketActions(makeTicket({ status: "planning" }), ctx()).primary[0]).toMatchObject({ id: "start", label: "Start work", enabled: true });
    expect(ticketActions(makeTicket({ status: "planning", busy: true }), ctx()).primary[0]).toMatchObject({ id: "start", label: "Approve plan" });
    expect(ids(ticketActions(makeTicket({ status: "planning", startAfterPlan: true, busy: true }), ctx()).primary)).toEqual([]);
  });
  test("a planning ticket waiting on a dependency offers no Start", () => {
    const t = makeTicket({ status: "planning", autoStart: true });
    const deps = [{ key: "T-2", state: "pending" }] as never;
    expect(ids(ticketActions(t, ctx({ deps })).primary)).toEqual([]);
  });
  test("in progress: only Move to done and Delete; busy adds Cancel run before Delete", () => {
    expect(ids(ticketActions(makeTicket({ status: "in_progress" }), ctx()).more)).toEqual(["markDone", "delete"]);
    expect(ids(ticketActions(makeTicket({ status: "in_progress", busy: true }), ctx()).more)).toEqual(["markDone", "cancelRun", "delete"]);
  });
  test("review pending: Approve and Request changes, rerun review, no Move to done", () => {
    const s = ticketActions(review(), ctx());
    expect(ids(s.primary)).toEqual(["approve", "requestChanges"]);
    expect(s.primary[0]).toMatchObject({ label: "Approve and merge", enabled: true });
    expect(ids(s.more)).toEqual(["rerunReview", "delete"]);
    expect(s.more[0]!.label).toBe("Re-run agent review");
  });
  test("skipped agent review reads 'Run agent review'; a busy ticket can't rerun it", () => {
    const s = ticketActions(review({ agentReview: "skipped", busy: true }), ctx());
    expect(s.more[0]).toMatchObject({ label: "Run agent review", enabled: false });
    expect(ids(s.enabled)).not.toContain("rerunReview");
  });
  test("an already-approved review has no Approve or Request changes", () => {
    expect(ids(ticketActions(review({ humanReview: "approved" }), ctx()).primary)).toEqual([]);
  });
  test("conductor child: Approve stays (disabled, with a reason) even once approved", () => {
    const parent = makeTicket({ status: "in_progress", key: "COND-1", kind: "conductor" });
    const s = ticketActions(review({ parentId: parent.id, humanReview: "approved" }), ctx({ parent }));
    expect(s.primary).toHaveLength(1);
    expect(s.primary[0]).toMatchObject({ id: "approve", enabled: false });
    expect(s.primary[0]!.managedReason).toContain("COND-1");
    expect(ids(s.enabled)).not.toContain("approve");
  });
  test("a done parent no longer manages its child", () => {
    const parent = makeTicket({ status: "done", key: "COND-1" });
    const s = ticketActions(review({ parentId: parent.id }), ctx({ parent }));
    expect(s.primary[0]).toMatchObject({ id: "approve", enabled: true });
    expect(s.primary[0]!.managedReason).toBeUndefined();
  });
  test("done offers Re-open and no Move to done", () => {
    const s = ticketActions(makeTicket({ status: "done" }), ctx());
    expect(ids(s.primary)).toEqual(["reopen"]);
    expect(ids(s.more)).toEqual(["delete"]);
  });
  test("compacting disables everything but Cancel run", () => {
    const s = ticketActions(review({ compacting: true, busy: true }), ctx());
    expect(ids(s.enabled)).toEqual(["cancelRun"]);
    const planning = ticketActions(makeTicket({ status: "planning", compacting: true }), ctx());
    expect(planning.primary[0]!.enabled).toBe(false);
  });
  test("enabled lists primary before more and excludes disabled ones", () => {
    expect(ids(ticketActions(review(), ctx()).enabled)).toEqual(["approve", "requestChanges", "rerunReview", "delete"]);
  });
});

describe("paletteEntries", () => {
  test("plain actions are keyed ticket.<id>", () => {
    const e = paletteEntries(ticketActions(makeTicket({ status: "in_progress" }), ctx()));
    expect(Object.keys(e)).toEqual(["ticket.markDone", "ticket.delete"]);
  });
  test("Approve fans out into the primary, each other way and take-no-action", () => {
    const e = paletteEntries(ticketActions(review(), ctx()));
    expect(e["ticket.approve"]).toMatchObject({ label: "Approve and merge", choice: { kind: "run", action: "merge" } });
    expect(e["ticket.land.cleanup"]!.choice).toMatchObject({ action: "cleanup" });
    expect(e["ticket.land.custom"]!.choice).toMatchObject({ kind: "sheet" });
    expect(e["ticket.land.merge"]).toBeUndefined();
    expect(e["ticket.approveNoAction"]!.choice).toEqual({ kind: "none", label: "Approve and take no action" });
  });
  test("a disabled (conductor-managed) Approve gets no palette entries", () => {
    const parent = makeTicket({ status: "in_progress", key: "C-1" });
    const e = paletteEntries(ticketActions(review({ parentId: parent.id }), ctx({ parent })));
    expect(Object.keys(e).some((k) => k.includes("pprove"))).toBe(false);
  });
});

describe("actionMenuItems / pickedAction", () => {
  const set = ticketActions(review(), ctx());
  const menu = actionMenuItems(set.enabled);

  test("Approve becomes a submenu with the no-action choice after a separator", () => {
    const approve = menu[0] as { id: string; label: string; submenu: ({ id?: string; label?: string; type?: string })[] };
    expect(approve.label).toBe("Approve");
    expect(approve.submenu.map((s) => s.type ?? s.label)).toEqual(["Approve and merge", "Approve and clean up", "Approve and…", "separator", "Approve and take no action"]);
    expect(approve.submenu[0]!.id).toBe("action:approve:0");
  });
  test("other actions are plain items", () => {
    expect(menu.slice(1)).toEqual([
      { id: "action:requestChanges", label: "Request changes" },
      { id: "action:rerunReview", label: "Re-run agent review" },
      { id: "action:delete", label: "Delete ticket" },
    ]);
  });
  test("an approve action without a land menu stays a plain item", () => {
    expect(actionMenuItems([{ id: "approve", label: "Approve", enabled: true }])).toEqual([{ id: "action:approve", label: "Approve" }]);
  });
  test("pickedAction resolves a plain id, an approve choice, and the no-action choice", () => {
    expect(pickedAction(set.enabled, "action:delete")?.action.id).toBe("delete");
    expect(pickedAction(set.enabled, "action:approve:1")?.choice).toMatchObject({ action: "cleanup" });
    expect(pickedAction(set.enabled, "action:approve:3")?.choice?.kind).toBe("none");
  });
  test("pickedAction is null for null, foreign ids, unknown actions and out-of-range choices", () => {
    expect(pickedAction(set.enabled, null)).toBeNull();
    expect(pickedAction(set.enabled, "other:delete")).toBeNull();
    expect(pickedAction(set.enabled, "action:markDone")).toBeNull();
    expect(pickedAction(set.enabled, "action:approve:9")).toBeNull();
    expect(pickedAction(set.enabled, "action:approve:x")).toBeNull();
  });
});
