import { describe, expect, test } from "bun:test";
import type { Ticket } from "../../../shared/src/index";
import {
  APPROVED_TITLE,
  HIDE_CHILDREN_DEFAULT,
  HIDE_CHILDREN_KEY,
  attentionOf,
  autoStartTitle,
  autoStartWaitingOn,
  childrenOfTicket,
  depChipTitle,
  depStates,
  dependencyDepths,
  dimOnBoard,
  groupChildren,
  hideOnBoard,
  isWorking,
  needsHuman,
  progressLabel,
  progressOf,
  progressSegments,
  readHideChildren,
  restartTitle,
  restartsAt,
  startLabel,
  startState,
  waitingOn,
  workingTitle,
  writeHideChildren,
  type DepState,
  type KV,
} from "../../../shared/src/state/conductor";
import { makeTicket } from "../../builders/ticket";

const t = (key: string, over: Partial<Ticket> = {}) => makeTicket({ status: "planning", key, id: `id-${key}`, ...over });
const byId = (...ts: Ticket[]) => Object.fromEntries(ts.map((x) => [x.id, x]));
const approval = { id: "a" } as unknown as Ticket["pendingApproval"];

describe("attentionOf / needsHuman", () => {
  test("a pending approval wins over blocked", () => {
    expect(attentionOf(t("A-1", { status: "blocked", pendingApproval: approval }))).toBe("approval");
  });

  test("blocked asks for the human, for children too", () => {
    expect(attentionOf(t("A-1", { status: "blocked" }))).toBe("blocked");
    expect(attentionOf(t("A-2", { status: "blocked", parentId: "p" }))).toBe("blocked");
  });

  test("a top-level ticket in review with a pending human review needs review", () => {
    expect(attentionOf(t("A-1", { status: "review", humanReview: "pending" }))).toBe("review");
  });

  test("a child in review belongs to its conductor, and a reviewed ticket needs nothing", () => {
    expect(attentionOf(t("A-1", { status: "review", humanReview: "pending", parentId: "p" }))).toBeNull();
    expect(attentionOf(t("A-2", { status: "review", humanReview: "approved" }))).toBeNull();
    expect(needsHuman(t("A-3", { status: "in_progress" }))).toBe(false);
  });
});

describe("dim / hide on board", () => {
  test("a quiet child dims and hides; a child needing the human does neither; a top-level never does", () => {
    const quiet = t("A-1", { parentId: "p" });
    const blocked = t("A-2", { parentId: "p", status: "blocked" });
    expect(dimOnBoard(quiet)).toBe(true);
    expect(dimOnBoard(blocked)).toBe(false);
    expect(dimOnBoard(t("A-3"))).toBe(false);
    expect(hideOnBoard(quiet, true)).toBe(true);
    expect(hideOnBoard(quiet, false)).toBe(false);
    expect(hideOnBoard(blocked, true)).toBe(false);
  });
});

describe("childrenOfTicket", () => {
  test("only the conductor's children, oldest first, then by position", () => {
    const a = t("A-1", { parentId: "c", createdAt: 5, position: 2 });
    const b = t("A-2", { parentId: "c", createdAt: 1, position: 9 });
    const c = t("A-3", { parentId: "c", createdAt: 5, position: 1 });
    const other = t("A-4", { parentId: "x" });
    expect(childrenOfTicket(byId(a, b, c, other), "c").map((x) => x.key)).toEqual(["A-2", "A-3", "A-1"]);
  });
});

describe("isWorking", () => {
  test("a busy ticket is working", () => {
    const a = t("A-1", { busy: true });
    expect(isWorking(byId(a), a)).toBe(true);
  });

  test("a conductor rolls up busy children and grandchildren", () => {
    const root = t("R-1", { id: "root" });
    const kid = t("R-2", { id: "kid", parentId: "root" });
    const grand = t("R-3", { id: "grand", parentId: "kid", busy: true });
    const all = byId(root, kid, grand);
    expect(isWorking(all, root)).toBe(true);
    expect(isWorking(all, kid)).toBe(true);
  });

  test("an idle tree, siblings and a busy child's own children don't spin", () => {
    const root = t("R-1", { id: "root" });
    const busy = t("R-2", { id: "busy", parentId: "root", busy: true });
    const sibling = t("R-3", { id: "sib", parentId: "root" });
    const below = t("R-4", { id: "below", parentId: "busy" });
    const all = byId(root, busy, sibling, below);
    expect(isWorking(all, sibling)).toBe(false);
    expect(isWorking(all, below)).toBe(false);
    expect(isWorking(byId(root, sibling), root)).toBe(false);
  });

  test("a parent cycle among tickets terminates", () => {
    const a = t("A-1", { id: "a", parentId: "b", busy: true });
    const b = t("A-2", { id: "b", parentId: "a" });
    const c = t("A-3", { id: "c" });
    expect(isWorking(byId(a, b, c), c)).toBe(false);
  });

  test("a parent that isn't loaded ends the walk", () => {
    const a = t("A-1", { id: "a", parentId: "missing", busy: true });
    const c = t("A-2", { id: "c" });
    expect(isWorking(byId(a, c), c)).toBe(false);
  });

  test("the tooltip says whose work it is", () => {
    expect(workingTitle(t("A-1", { busy: true }))).toBe("Agent working");
    expect(workingTitle(t("A-1"))).toBe("A child ticket is working");
  });
});

describe("progress", () => {
  const kids = [t("A-1", { status: "done" }), t("A-2", { status: "in_progress" }), t("A-3", { status: "blocked" }), t("A-4", { status: "review", parentId: "p" }), t("A-5")];

  test("counts by status and children needing the human (a child's review is not attention)", () => {
    const p = progressOf(kids);
    expect(p.total).toBe(5);
    expect(p.byStatus).toEqual({ done: 1, in_progress: 1, blocked: 1, review: 1, planning: 1 });
    expect(p.attention).toBe(1);
  });

  test("label omits zero counts and calls planning 'up next'", () => {
    expect(progressLabel(progressOf(kids))).toBe("1/5 done · 1 in progress · 1 blocked · 1 review · 1 up next");
    expect(progressLabel(progressOf([t("A-1", { status: "done" }), t("A-2", { status: "done" })]))).toBe("2/2 done");
    expect(progressLabel(progressOf([]))).toBe("0/0 done");
  });

  test("segments run done, review, in progress, blocked, planning; empty dropped; percent of total", () => {
    const segs = progressSegments(progressOf([t("A-1", { status: "planning" }), t("A-2", { status: "done" }), t("A-3", { status: "done" }), t("A-4", { status: "blocked" })]));
    expect(segs.map((s) => s.status)).toEqual(["done", "blocked", "planning"]);
    expect(segs[0]).toEqual({ status: "done", count: 2, pct: 50 });
  });

  test("no children means no segments (no divide by zero)", () => {
    expect(progressSegments(progressOf([]))).toEqual([]);
  });
});

describe("depStates / depChipTitle / waitingOn", () => {
  test("states: done, pending, unknown; matches keys case-insensitively", () => {
    const done = t("A-1", { status: "done" });
    const open = t("A-2", { status: "in_progress" });
    const me = t("A-9", { dependsOn: ["a-1", "A-2", "A-404"] });
    const states = depStates(byId(done, open), me);
    expect(states.map((s) => [s.key, s.state, s.done])).toEqual([
      ["a-1", "done", true],
      ["A-2", "pending", false],
      ["A-404", "unknown", false],
    ]);
    expect(states[0]!.ticket).toBe(done);
    expect(states[2]!.ticket).toBeUndefined();
  });

  test("an alias from before a rename resolves; an alias to an unloaded ticket stays unknown", () => {
    const moved = t("NEW-1", { id: "moved", status: "done" });
    const me = t("A-9", { dependsOn: ["OLD-1", "OLD-2"] });
    const states = depStates(byId(moved), me, { "OLD-1": "moved", "OLD-2": "gone" });
    expect(states.map((s) => s.state)).toEqual(["done", "unknown"]);
  });

  test("a real key wins over an alias of the same name", () => {
    const real = t("X-1", { id: "real", status: "done" });
    const aliased = t("Y-1", { id: "aliased", status: "planning" });
    const states = depStates(byId(real, aliased), t("A-9", { dependsOn: ["X-1"] }), { "X-1": "aliased" });
    expect(states[0]!.ticket).toBe(real);
  });

  test("chip titles: done, waiting, looking up, and missing", () => {
    const base = { key: "A-1", done: false };
    expect(depChipTitle({ ...base, done: true, state: "done" })).toBe("A-1 is done");
    expect(depChipTitle({ ...base, state: "pending" })).toBe("Waiting on A-1");
    expect(depChipTitle({ ...base, state: "unknown" })).toBe("Looking up A-1…");
    expect(depChipTitle({ ...base, state: "unknown", missing: true })).toBe("A-1 wasn't found");
  });

  test("waitingOn counts unknown keys as holding", () => {
    const deps: DepState[] = [
      { key: "A", done: true, state: "done" },
      { key: "B", done: false, state: "pending" },
      { key: "C", done: false, state: "unknown" },
    ];
    expect(waitingOn(deps)).toEqual(["B", "C"]);
  });
});

describe("autoStartWaitingOn / startState / labels", () => {
  const pending: DepState = { key: "D-1", done: false, state: "pending" };
  const unknown: DepState = { key: "D-2", done: false, state: "unknown" };
  const done: DepState = { key: "D-3", done: true, state: "done" };

  test("waits only on loaded, unfinished deps, for an auto-start planning ticket", () => {
    expect(autoStartWaitingOn(t("A-1", { autoStart: true }), [pending, unknown, done])).toEqual(["D-1"]);
    expect(autoStartWaitingOn(t("A-1", { startAfterPlan: true }), [pending])).toEqual(["D-1"]);
  });

  test("empty for drafts, non-auto, and non-planning tickets", () => {
    expect(autoStartWaitingOn(t("A-1", { autoStart: true, draft: true }), [pending])).toEqual([]);
    expect(autoStartWaitingOn(t("A-1"), [pending])).toEqual([]);
    expect(autoStartWaitingOn(t("A-1", { autoStart: true, status: "in_progress" }), [pending])).toEqual([]);
  });

  test("an approved plan still being written has no dependency wait", () => {
    expect(autoStartWaitingOn(t("A-1", { startAfterPlan: true, busy: true }), [pending])).toEqual([]);
    // autoStart alone while busy still waits
    expect(autoStartWaitingOn(t("A-1", { autoStart: true, busy: true }), [pending])).toEqual(["D-1"]);
  });

  test("startState across the lifecycle", () => {
    expect(startState(t("A-1", { draft: true }), [])).toBe("none");
    expect(startState(t("A-1", { status: "review" }), [])).toBe("none");
    expect(startState(t("A-1"), [])).toBe("start");
    expect(startState(t("A-1", { busy: true }), [])).toBe("approve");
    expect(startState(t("A-1", { startAfterPlan: true }), [])).toBe("approved");
    expect(startState(t("A-1", { startAfterPlan: true, busy: true }), [pending])).toBe("approved");
    expect(startState(t("A-1", { autoStart: true }), [pending])).toBe("waiting");
    expect(startState(t("A-1", { startAfterPlan: true }), [pending])).toBe("waiting");
    expect(startState(t("A-1", { autoStart: true }), [done])).toBe("start");
  });

  test("start label", () => {
    expect(startLabel("approve")).toBe("Approve plan");
    expect(startLabel("start")).toBe("Start work");
    expect(startLabel("approved")).toBe("Start work");
    expect(APPROVED_TITLE).toContain("Plan approved");
  });

  test("autoStartTitle grammar for none, one, two and three keys", () => {
    expect(autoStartTitle([])).toBe("Starts on its own once its dependencies are done");
    expect(autoStartTitle(["A"])).toBe("Starts on its own once A is done");
    expect(autoStartTitle(["A", "B"])).toBe("Starts on its own once A and B are done");
    expect(autoStartTitle(["A", "B", "C"])).toBe("Starts on its own once A, B and C are done");
  });
});

describe("restartsAt / restartTitle", () => {
  test("only a blocked, non-draft ticket with resumeAt restarts", () => {
    expect(restartsAt(t("A-1", { status: "blocked", resumeAt: 123 }))).toBe(123);
    expect(restartsAt(t("A-1", { status: "blocked" }))).toBeNull();
    expect(restartsAt(t("A-1", { status: "blocked", resumeAt: 0 }))).toBeNull();
    expect(restartsAt(t("A-1", { status: "in_progress", resumeAt: 123 }))).toBeNull();
    expect(restartsAt(t("A-1", { status: "blocked", resumeAt: 123, draft: true }))).toBeNull();
  });

  test("the title embeds the formatted time", () => {
    expect(restartTitle("2:35 PM")).toContain("at 2:35 PM,");
  });
});

describe("dependencyDepths", () => {
  test("depth is one more than the deepest sibling dependency; outside deps are ignored", () => {
    const a = t("A-1");
    const b = t("A-2", { dependsOn: ["A-1"] });
    const c = t("A-3", { dependsOn: ["a-2", "A-1", "OUT-1"] });
    const d = t("A-4", { dependsOn: ["OUT-1"] });
    const depths = dependencyDepths([c, b, a, d]);
    expect(depths.get("A-1")).toBe(0);
    expect(depths.get("A-2")).toBe(1);
    expect(depths.get("A-3")).toBe(2);
    expect(depths.get("A-4")).toBe(0);
  });

  test("a dependency cycle terminates with finite depths", () => {
    const a = t("A-1", { dependsOn: ["A-2"] });
    const b = t("A-2", { dependsOn: ["A-1"] });
    const depths = dependencyDepths([a, b]);
    expect(Number.isFinite(depths.get("A-1"))).toBe(true);
    expect(Number.isFinite(depths.get("A-2"))).toBe(true);
  });
});

describe("groupChildren", () => {
  test("groups in lifecycle order and drops empty groups", () => {
    const groups = groupChildren([t("A-1", { status: "done" }), t("A-2", { status: "planning" })]);
    expect(groups.map((g) => g.status)).toEqual(["planning", "done"]);
  });

  test("inside a group: attention first, then dependency order, then age", () => {
    const late = t("A-1", { status: "in_progress", createdAt: 1, dependsOn: ["A-2"] });
    const dep = t("A-2", { status: "in_progress", createdAt: 9 });
    const old = t("A-3", { status: "in_progress", createdAt: 0 });
    const asking = t("A-4", { status: "in_progress", createdAt: 99, pendingApproval: approval });
    const [g] = groupChildren([late, dep, old, asking]);
    // asking (attention) first; then depth 0 by age: old(0), dep(9); then late (depth 1)
    expect(g!.tickets.map((x) => x.key)).toEqual(["A-4", "A-3", "A-2", "A-1"]);
  });

  test("no children, no groups", () => {
    expect(groupChildren([])).toEqual([]);
  });
});

describe("hide-children preference", () => {
  const memory = (initial?: string): KV & { map: Map<string, string> } => {
    const map = new Map<string, string>(initial === undefined ? [] : [[HIDE_CHILDREN_KEY, initial]]);
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  };
  const throwing: KV = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };

  test("1 hides, 0 shows, nothing or junk falls back to the default", () => {
    expect(readHideChildren(memory("1"))).toBe(true);
    expect(readHideChildren(memory("0"))).toBe(false);
    expect(readHideChildren(memory())).toBe(HIDE_CHILDREN_DEFAULT);
    expect(readHideChildren(memory("yes"))).toBe(HIDE_CHILDREN_DEFAULT);
  });

  test("no storage or storage that throws uses the default", () => {
    expect(readHideChildren(throwing)).toBe(HIDE_CHILDREN_DEFAULT);
  });

  test("write stores 1 or 0 and swallows storage errors", () => {
    const kv = memory();
    writeHideChildren(true, kv);
    expect(kv.map.get(HIDE_CHILDREN_KEY)).toBe("1");
    writeHideChildren(false, kv);
    expect(kv.map.get(HIDE_CHILDREN_KEY)).toBe("0");
    expect(() => writeHideChildren(true, throwing)).not.toThrow();
  });

  test("a written value reads back as written", () => {
    const kv = memory();
    writeHideChildren(false, kv);
    expect(readHideChildren(kv)).toBe(false);
  });
});
