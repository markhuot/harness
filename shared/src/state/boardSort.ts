// Board order and grouping: how the cards in a live column are sorted ("Sort by" in the board's
// options menu), and the "Group by project" sections on a board that spans projects (All projects,
// a project group). Both are per-machine preferences stored like hideChildren (conductor.ts).
// The Done column is outside the sort: it pages from the service newest-completed first
// (paging.ts), so it keeps that order and only groups.
//
// iOS mirrors this in HarnessKit (State/BoardSort.swift); keep the two in step.

import type { Project, Ticket } from "../index";
import type { KV } from "./conductor";

export type BoardSort = "recent" | "created" | "title";
export const BOARD_SORTS: { value: BoardSort; label: string; title: string }[] = [
  { value: "recent", label: "Recent activity", title: "Most recent run or transcript entry first" },
  { value: "created", label: "Created", title: "Oldest first, in the order the tickets were created" },
  { value: "title", label: "Title", title: "A to Z by title" },
];
export const BOARD_SORT_KEY = "harness.board.sort";
export const BOARD_SORT_DEFAULT: BoardSort = "recent";
export const GROUP_BY_PROJECT_KEY = "harness.board.groupByProject";
export const GROUP_BY_PROJECT_DEFAULT = false;
/** Dispatched on window when either preference changes, so every board on screen follows. */
export const BOARD_ORDER_CHANGED = "harness:board-order-changed";

const defaultStorage = (): KV | undefined => (globalThis as { localStorage?: KV }).localStorage;
const isSort = (v: unknown): v is BoardSort => BOARD_SORTS.some((s) => s.value === v);

export function readBoardSort(storage: KV | undefined = defaultStorage()): BoardSort {
  try {
    const v = storage?.getItem(BOARD_SORT_KEY);
    return isSort(v) ? v : BOARD_SORT_DEFAULT;
  } catch {
    return BOARD_SORT_DEFAULT;
  }
}

export function writeBoardSort(value: BoardSort, storage: KV | undefined = defaultStorage()): void {
  try {
    storage?.setItem(BOARD_SORT_KEY, value);
  } catch {
    // Private mode / quota: the choice just isn't remembered.
  }
}

export function readGroupByProject(storage: KV | undefined = defaultStorage()): boolean {
  try {
    const v = storage?.getItem(GROUP_BY_PROJECT_KEY);
    return v === "1" ? true : v === "0" ? false : GROUP_BY_PROJECT_DEFAULT;
  } catch {
    return GROUP_BY_PROJECT_DEFAULT;
  }
}

export function writeGroupByProject(value: boolean, storage: KV | undefined = defaultStorage()): void {
  try {
    storage?.setItem(GROUP_BY_PROJECT_KEY, value ? "1" : "0");
  } catch {
    // As above.
  }
}

/** When the ticket's agent last did anything (protocol.ts Ticket.lastActiveAt); updatedAt from an older service. */
export const lastActiveOf = (t: Ticket): number => t.lastActiveAt ?? t.updatedAt;

/** Creation order: the column's stored position, then age, then id (the order before sorting existed). */
export function compareCreated(a: Ticket, b: Ticket): number {
  return a.position - b.position || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const titleOf = (t: Ticket) => t.title.trim() || "Untitled";

/** The comparator for a live column under `sort`; ties fall back to creation order. */
export function boardComparator(sort: BoardSort): (a: Ticket, b: Ticket) => number {
  switch (sort) {
    case "recent":
      return (a, b) => lastActiveOf(b) - lastActiveOf(a) || compareCreated(a, b);
    case "title":
      return (a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: "base" }) || compareCreated(a, b);
    case "created":
      return compareCreated;
  }
}

export interface ProjectSection {
  /** Null for tickets whose project isn't loaded (they sort last). */
  project: Project | null;
  projectId: string;
  tickets: Ticket[];
}

/**
 * A column's tickets in sections by project: projects by name (as the sidebar lists them), each
 * section keeping the column's order. Empty projects get no section.
 */
export function sectionsByProject(projects: Record<string, Project>, tickets: readonly Ticket[]): ProjectSection[] {
  const byId = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const list = byId.get(t.projectId);
    if (list) list.push(t);
    else byId.set(t.projectId, [t]);
  }
  return [...byId.entries()]
    .map(([projectId, list]) => ({ project: projects[projectId] ?? null, projectId, tickets: list }))
    .sort((a, b) => {
      if (!a.project || !b.project) return a.project ? -1 : b.project ? 1 : a.projectId.localeCompare(b.projectId);
      return a.project.name.localeCompare(b.project.name) || a.projectId.localeCompare(b.projectId);
    });
}
