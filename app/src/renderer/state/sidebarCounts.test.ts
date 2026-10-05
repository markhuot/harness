import { expect, test } from "bun:test";
import { countSegments, sidebarCounts } from "./sidebarCounts";

const t = (projectId: string, status: string) => ({ projectId, status }) as Parameters<typeof sidebarCounts>[0] extends Iterable<infer T> ? T : never;

test("counts in progress, blocked and review per project and in total; planning and done don't count", () => {
  const { byProject, total } = sidebarCounts([
    t("a", "in_progress"),
    t("a", "in_progress"),
    t("a", "blocked"),
    t("a", "planning"),
    t("a", "done"),
    t("b", "review"),
    t("c", "planning"),
  ]);
  expect(byProject).toEqual({ a: { in_progress: 2, blocked: 1, review: 0 }, b: { in_progress: 0, blocked: 0, review: 1 } });
  expect(total).toEqual({ in_progress: 2, blocked: 1, review: 1 });
});

test("a group counts its projects' tickets; projects in no group count only for themselves", () => {
  const groupOf = (id: string) => ({ a: "Work", b: "Work", c: "Personal" })[id] ?? null;
  const { byGroup, byProject } = sidebarCounts([t("a", "in_progress"), t("b", "in_progress"), t("b", "review"), t("c", "planning"), t("d", "blocked")], groupOf);
  expect(byGroup).toEqual({ Work: { in_progress: 2, blocked: 0, review: 1 } });
  expect(byProject.d).toEqual({ in_progress: 0, blocked: 1, review: 0 });
});

test("zero columns drop out of the pill and the order stays in progress, blocked, review", () => {
  expect(countSegments({ in_progress: 2, blocked: 1, review: 4 })).toEqual([
    { status: "in_progress", n: 2 },
    { status: "blocked", n: 1 },
    { status: "review", n: 4 },
  ]);
  expect(countSegments({ in_progress: 0, blocked: 0, review: 3 })).toEqual([{ status: "review", n: 3 }]);
  expect(countSegments({ in_progress: 1, blocked: 0, review: 0 })).toEqual([{ status: "in_progress", n: 1 }]);
  expect(countSegments({ in_progress: 0, blocked: 0, review: 0 })).toEqual([]);
  expect(countSegments(undefined)).toEqual([]);
});
