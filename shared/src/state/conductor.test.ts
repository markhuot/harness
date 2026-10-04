import { describe, expect, test } from "bun:test";
import type { Ticket } from "../index";
import {
  attentionOf,
  autoStartTitle,
  autoStartWaitingOn,
  childrenOfTicket,
  dependencyDepths,
  depStates,
  dimOnBoard,
  groupChildren,
  hideOnBoard,
  isWorking,
  progressLabel,
  progressOf,
  progressSegments,
  readHideChildren,
  HIDE_CHILDREN_KEY,
  waitingOn,
  workingTitle,
  writeHideChildren,
} from "./conductor";

let seq = 0;
function tk(o: Partial<Ticket> & { key: string }): Ticket {
  seq++;
  return {
    id: `id-${o.key}`,
    projectId: "p1",
    kind: "task",
    title: o.key,
    description: "",
    status: "planning",
    sessionId: `s-${o.key}`,
    driver: "claude-code",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    blockedReason: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    position: seq,
    createdAt: seq,
    updatedAt: seq,
    ...o,
  } as Ticket;
}
const rec = (...ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const approval = { id: "a", runId: "r", toolName: "Bash", input: {}, requestedAt: 1 };

describe("attention", () => {
  test("approval outranks blocked; review needs the human only while their review is pending", () => {
    expect(attentionOf(tk({ key: "A-1", status: "blocked", pendingApproval: approval }))).toBe("approval");
    expect(attentionOf(tk({ key: "A-2", status: "blocked" }))).toBe("blocked");
    expect(attentionOf(tk({ key: "A-3", status: "review", humanReview: "pending" }))).toBe("review");
    expect(attentionOf(tk({ key: "A-4", status: "review", humanReview: "approved" }))).toBeNull();
    expect(attentionOf(tk({ key: "A-5", status: "in_progress", humanReview: "pending" }))).toBeNull();
    expect(attentionOf(tk({ key: "A-6", status: "done", humanReview: "pending" }))).toBeNull();
  });

  test("a child's pending human review is the conductor's job, not the human's", () => {
    const child = { parentId: "id-P-1", status: "review" as const, humanReview: "pending" as const };
    expect(attentionOf(tk({ key: "P-2", ...child }))).toBeNull();
    expect(attentionOf(tk({ key: "P-3", ...child, pendingApproval: approval }))).toBe("approval");
    expect(attentionOf(tk({ key: "P-4", parentId: "id-P-1", status: "blocked" }))).toBe("blocked");
  });

  test("board dims and hides quiet children (including ones in conductor review); top-level tickets are untouched", () => {
    const quiet = tk({ key: "C-2", parentId: "id-C-1", status: "in_progress" });
    const blocked = tk({ key: "C-3", parentId: "id-C-1", status: "blocked" });
    const reviewing = tk({ key: "C-4", parentId: "id-C-1", status: "review", humanReview: "pending" });
    const topLevel = tk({ key: "C-5", status: "in_progress" });
    const topReview = tk({ key: "C-6", status: "review", humanReview: "pending" });
    const all = [quiet, blocked, reviewing, topLevel, topReview];
    expect(all.map(dimOnBoard)).toEqual([true, false, true, false, false]);
    expect(all.map((t) => hideOnBoard(t, true))).toEqual([true, false, true, false, false]);
    expect(hideOnBoard(quiet, false)).toBe(false);
  });
});

describe("children and progress", () => {
  test("childrenOfTicket filters by parent and keeps creation order", () => {
    const a = tk({ key: "H-3", parentId: "id-H-1", createdAt: 30 });
    const b = tk({ key: "H-2", parentId: "id-H-1", createdAt: 20 });
    const other = tk({ key: "H-9", parentId: "id-H-8" });
    expect(childrenOfTicket(rec(a, other, b), "id-H-1").map((t) => t.key)).toEqual(["H-2", "H-3"]);
  });

  test("counts by status and attention (blocked / approval only); label omits zero counts", () => {
    const kid = (o: Partial<Ticket> & { key: string }) => tk({ parentId: "id-K-0", ...o });
    const kids = [
      kid({ key: "K-1", status: "done" }),
      kid({ key: "K-2", status: "done" }),
      kid({ key: "K-3", status: "in_progress" }),
      kid({ key: "K-4", status: "blocked", pendingApproval: approval }),
      kid({ key: "K-5", status: "review", humanReview: "pending" }),
      kid({ key: "K-6", status: "planning" }),
      kid({ key: "K-8", status: "blocked" }),
    ];
    const p = progressOf(kids);
    expect(p.total).toBe(7);
    expect(p.attention).toBe(2);
    expect(progressLabel(p)).toBe("2/7 done · 1 in progress · 2 blocked · 1 review · 1 up next");
    expect(progressLabel(progressOf([tk({ key: "K-7", status: "done" })]))).toBe("1/1 done");
    const segs = progressSegments(p);
    expect(segs.map((s) => s.status)).toEqual(["done", "review", "in_progress", "blocked", "planning"]);
    expect(segs.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100);
    expect(progressSegments(progressOf([]))).toEqual([]);
  });
});

describe("isWorking (spinner rollup)", () => {
  const conductor = tk({ key: "W-1", kind: "conductor" });
  const sub = tk({ key: "W-2", kind: "conductor", parentId: conductor.id });

  test("a conductor spins while any child or grandchild has a run going", () => {
    const busyKid = tk({ key: "W-3", parentId: conductor.id, busy: true, status: "in_progress" });
    expect(isWorking(rec(conductor, busyKid), conductor)).toBe(true);
    const busyGrandkid = tk({ key: "W-4", parentId: sub.id, busy: true });
    expect(isWorking(rec(conductor, sub, busyGrandkid), conductor)).toBe(true);
    expect(isWorking(rec(conductor, sub, busyGrandkid), sub)).toBe(true);
    expect(workingTitle(conductor)).toBe("A child ticket is working");
  });

  test("stops when every child is blocked, stopped or done, or the busy ticket belongs elsewhere", () => {
    const idle = [
      tk({ key: "W-5", parentId: conductor.id, status: "blocked" }),
      tk({ key: "W-6", parentId: conductor.id, status: "in_progress" }),
      tk({ key: "W-7", parentId: conductor.id, status: "done" }),
    ];
    const elsewhere = tk({ key: "W-8", parentId: "id-OTHER", busy: true });
    expect(isWorking(rec(conductor, ...idle, elsewhere), conductor)).toBe(false);
    // A busy parent doesn't make its child spin: the rollup only goes up.
    expect(isWorking(rec({ ...conductor, busy: true }, idle[0]!), idle[0]!)).toBe(false);
  });

  test("its own run counts; a parent cycle or an unloaded ancestor ends the walk", () => {
    expect(isWorking({}, tk({ key: "W-9", busy: true }))).toBe(true);
    expect(workingTitle(tk({ key: "W-9", busy: true }))).toBe("Agent working");
    const a = tk({ key: "W-10", parentId: "id-W-11", busy: true });
    const b = tk({ key: "W-11", parentId: "id-W-10" });
    expect(isWorking(rec(a, b), conductor)).toBe(false);
    expect(isWorking(rec(a, b), b)).toBe(true);
    expect(isWorking(rec(tk({ key: "W-12", parentId: "id-GONE", busy: true })), conductor)).toBe(false);
  });
});

describe("dependencies", () => {
  test("depStates resolves case-insensitively (and through aliases); unloaded keys are unknown, not pending", () => {
    const done = tk({ key: "D-1", status: "done" });
    const running = tk({ key: "D-2", status: "in_progress" });
    const t = tk({ key: "D-3", dependsOn: ["d-1", "D-2", "D-99"] });
    const deps = depStates(rec(done, running, t), t);
    expect(deps.map((d) => [d.key, d.done, d.ticket?.key])).toEqual([
      ["d-1", true, "D-1"],
      ["D-2", false, "D-2"],
      ["D-99", false, undefined],
    ]);
    expect(deps.map((d) => d.state)).toEqual(["done", "pending", "unknown"]);
    expect(waitingOn(deps)).toEqual(["D-2", "D-99"]);
    // An old key (pre-rename) resolves through the alias map to the renamed ticket.
    const renamed = tk({ key: "NEW-1", status: "done" });
    const viaAlias = depStates(rec(renamed), tk({ key: "X-1", dependsOn: ["old-1"] }), { "OLD-1": renamed.id });
    expect(viaAlias.map((d) => [d.state, d.ticket?.key])).toEqual([["done", "NEW-1"]]);
  });

  test("autoStartWaitingOn: only a submitted auto-start ticket in planning, and only loaded open deps", () => {
    const open = tk({ key: "A-1", status: "in_progress" });
    const done = tk({ key: "A-2", status: "done" });
    const waiting = tk({ key: "A-3", autoStart: true, dependsOn: ["A-1", "A-2", "A-99"] });
    const deps = (t: Ticket) => depStates(rec(open, done), t);
    expect(autoStartWaitingOn(waiting, deps(waiting))).toEqual(["A-1"]);
    // Not started (no autoStart), a draft, or already past planning: not waiting.
    for (const t of [{ ...waiting, autoStart: false }, { ...waiting, draft: true }, { ...waiting, status: "in_progress" as const }]) {
      expect(autoStartWaitingOn(t, deps(t))).toEqual([]);
    }
    // Every dep done or unloaded: the service starts it (or already has), so nothing to wait on.
    const ready = tk({ key: "A-4", autoStart: true, dependsOn: ["A-2", "A-99"] });
    expect(autoStartWaitingOn(ready, deps(ready))).toEqual([]);
  });

  test("autoStartTitle lists the keys", () => {
    expect(autoStartTitle(["A-1"])).toBe("Starts on its own once A-1 is done");
    expect(autoStartTitle(["A-1", "A-2"])).toBe("Starts on its own once A-1 and A-2 are done");
    expect(autoStartTitle(["A-1", "A-2", "A-3"])).toBe("Starts on its own once A-1, A-2 and A-3 are done");
    expect(autoStartTitle([])).toBe("Starts on its own once its dependencies are done");
  });

  test("depths follow sibling chains, ignore outside deps and survive cycles", () => {
    const a = tk({ key: "G-1", dependsOn: ["OUT-1"] });
    const b = tk({ key: "G-2", dependsOn: ["G-1"] });
    const c = tk({ key: "G-3", dependsOn: ["G-2", "G-1"] });
    const x = tk({ key: "G-4", dependsOn: ["G-5"] });
    const y = tk({ key: "G-5", dependsOn: ["G-4"] });
    const d = dependencyDepths([c, b, a, x, y]);
    expect([d.get("G-1"), d.get("G-2"), d.get("G-3")]).toEqual([0, 1, 2]);
    expect(Math.max(d.get("G-4")!, d.get("G-5")!)).toBeLessThanOrEqual(2); // finite: the cycle is cut
  });

  test("groups follow lifecycle order; attention first, then dependency order within a group", () => {
    const kid = (o: Partial<Ticket> & { key: string }) => tk({ parentId: "id-L-0", ...o });
    const first = kid({ key: "L-1", status: "planning", dependsOn: ["L-2"], createdAt: 1 });
    const dep = kid({ key: "L-2", status: "planning", createdAt: 2 });
    const done = kid({ key: "L-3", status: "done" });
    const r1 = kid({ key: "L-4", status: "review", humanReview: "approved", createdAt: 1 });
    const r2 = kid({ key: "L-5", status: "review", humanReview: "pending", createdAt: 2 });
    const w1 = kid({ key: "L-6", status: "in_progress", createdAt: 1 });
    const w2 = kid({ key: "L-7", status: "in_progress", pendingApproval: approval, createdAt: 2 });
    const groups = groupChildren([done, first, r1, dep, r2, w1, w2]);
    expect(groups.map((g) => g.status)).toEqual(["planning", "in_progress", "review", "done"]);
    expect(groups[0]!.tickets.map((t) => t.key)).toEqual(["L-2", "L-1"]);
    expect(groups[1]!.tickets.map((t) => t.key)).toEqual(["L-7", "L-6"]);
    // A pending human review doesn't jump the queue: the conductor reviews it, so age decides.
    expect(groups[2]!.tickets.map((t) => t.key)).toEqual(["L-4", "L-5"]);
  });
});

describe("hide-children preference", () => {
  test("children are hidden on a first run; an explicit choice persists either way", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(readHideChildren(storage)).toBe(true); // nothing stored → hidden
    writeHideChildren(false, storage);
    expect(mem.get(HIDE_CHILDREN_KEY)).toBe("0");
    expect(readHideChildren(storage)).toBe(false); // "Show child tickets" sticks
    writeHideChildren(true, storage);
    expect(readHideChildren(storage)).toBe(true);
    mem.set(HIDE_CHILDREN_KEY, "garbage");
    expect(readHideChildren(storage)).toBe(true); // unreadable value → the default
  });

  test("tolerates throwing or missing storage (falls back to hidden)", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readHideChildren(broken)).toBe(true);
    expect(() => writeHideChildren(true, broken)).not.toThrow();
    expect(readHideChildren(undefined)).toBe(true);
  });
});
