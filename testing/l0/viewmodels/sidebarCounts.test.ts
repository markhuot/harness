import { describe, expect, test } from "bun:test";
import { countSegments, sidebarCounts } from "../../../app/src/renderer/state/sidebarCounts";

const t = (projectId: string, status: string) => ({ projectId, status }) as { projectId: string; status: "review" };

describe("sidebarCounts", () => {
  test("counts only in progress, blocked and review, per project and in total", () => {
    const { byProject, total } = sidebarCounts([t("a", "in_progress"), t("a", "planning"), t("a", "done"), t("b", "blocked"), t("b", "review"), t("b", "review")]);
    expect(total).toEqual({ in_progress: 1, blocked: 1, review: 2 });
    expect(byProject.a).toEqual({ in_progress: 1, blocked: 0, review: 0 });
    expect(byProject.b).toEqual({ in_progress: 0, blocked: 1, review: 2 });
  });

  test("a project with only uncounted tickets gets no entry", () => {
    expect(sidebarCounts([t("a", "done"), t("a", "planning")]).byProject).toEqual({});
  });

  test("groups sum their projects; ungrouped and undefined groups are left out", () => {
    const groups: Record<string, string | null | undefined> = { a: "web", b: "web", c: null };
    const { byGroup } = sidebarCounts([t("a", "review"), t("b", "review"), t("c", "review"), t("d", "review")], (id) => groups[id]);
    expect(Object.keys(byGroup)).toEqual(["web"]);
    expect(byGroup.web!.review).toBe(2);
  });

  test("accepts any iterable and keeps the zero shape for an empty board", () => {
    expect(sidebarCounts(new Set<ReturnType<typeof t>>()).total).toEqual({ in_progress: 0, blocked: 0, review: 0 });
  });
});

describe("countSegments", () => {
  test("drops zero counts and keeps the pill order", () => {
    expect(countSegments({ in_progress: 0, blocked: 2, review: 1 })).toEqual([
      { status: "blocked", n: 2 },
      { status: "review", n: 1 },
    ]);
  });
  test("undefined counts and an idle board show nothing", () => {
    expect(countSegments(undefined)).toEqual([]);
    expect(countSegments({ in_progress: 0, blocked: 0, review: 0 })).toEqual([]);
  });
});
