import { describe, expect, test } from "bun:test";
import type { Ticket } from "../index";
import {
  attentionOf,
  childrenOfTicket,
  dependencyDepths,
  depStates,
  dimOnBoard,
  groupChildren,
  hideOnBoard,
  progressLabel,
  progressOf,
  progressSegments,
  readHideChildren,
  waitingOn,
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

describe("dependencies", () => {
  test("depStates resolves case-insensitively; unknown keys stay pending", () => {
    const done = tk({ key: "D-1", status: "done" });
    const running = tk({ key: "D-2", status: "in_progress" });
    const t = tk({ key: "D-3", dependsOn: ["d-1", "D-2", "D-99"] });
    const deps = depStates(rec(done, running, t), t);
    expect(deps.map((d) => [d.key, d.done, d.ticket?.key])).toEqual([
      ["d-1", true, "D-1"],
      ["D-2", false, "D-2"],
      ["D-99", false, undefined],
    ]);
    expect(waitingOn(deps)).toEqual(["D-2", "D-99"]);
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
  test("round-trips through storage and tolerates throwing or missing storage", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(readHideChildren(storage)).toBe(false);
    writeHideChildren(true, storage);
    expect(readHideChildren(storage)).toBe(true);
    writeHideChildren(false, storage);
    expect(readHideChildren(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readHideChildren(broken)).toBe(false);
    expect(() => writeHideChildren(true, broken)).not.toThrow();
    expect(readHideChildren(undefined)).toBe(false);
  });
});
