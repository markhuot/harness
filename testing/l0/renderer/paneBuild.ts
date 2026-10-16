// Small builders and an independent invariant check for the pane model tests.
import type { PaneContent, PaneLeaf, PaneNode, PaneSplit, PaneState, PaneStore, SplitDir } from "../../../app/src/renderer/state/paneModel";

export const leaf = (id: string, content: PaneContent): PaneLeaf => ({ type: "leaf", id, content });
export const board = (id = "B") => leaf(id, { kind: "board" });
export const ticket = (id: string, key: string, tab: "spec" | "transcript" | "details" | "browser" | "activity" = "spec") => leaf(id, { kind: "ticket", ticketKey: key, tab });
export const term = (id: string, sessionId: string, cwd = "/work") => leaf(id, { kind: "terminal", sessionId, cwd });
export const torn = (id: string, key: string, tab: "transcript" | "browser" | "composer" | "changes" | "details" = "transcript", browserTab?: number) =>
  leaf(id, { kind: "ticketTab", ticketKey: key, tab, ...(browserTab !== undefined ? { browserTab } : {}) });
export const file = (id: string, path: string, root: { ticketKey: string } | { projectId: string } = { projectId: "pr" }) => leaf(id, { kind: "file", root, path });
export const compose = (id: string, composeId: string) => leaf(id, { kind: "compose", id: composeId });

export const split = (dir: SplitDir, id: string, children: PaneNode[], sizes?: number[]): PaneSplit => ({
  type: "split",
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});
export const row = (id: string, children: PaneNode[], sizes?: number[]) => split("row", id, children, sizes);
export const col = (id: string, children: PaneNode[], sizes?: number[]) => split("column", id, children, sizes);

export const st = (root: PaneNode, focusedId: string | null = null, zoomedId: string | null = null): PaneState => ({ root, focusedId, zoomedId });
export const store = (scopes: Record<string, PaneState>): PaneStore => ({ scopes });

/** Compact tree shape: leaves by id, splits as `row(a,b)` / `col(a,b)`. */
export function shape(n: PaneNode): string {
  return n.type === "leaf" ? n.id : `${n.dir === "row" ? "row" : "col"}(${n.children.map(shape).join(",")})`;
}
export const leafIds = (n: PaneNode): string[] => (n.type === "leaf" ? [n.id] : n.children.flatMap(leafIds));
export const sizesOf = (n: PaneNode): number[] => (n.type === "split" ? n.sizes : []);
export const findSplit = (n: PaneNode, id: string): PaneSplit | null => {
  if (n.type === "leaf") return null;
  if (n.id === id) return n;
  for (const c of n.children) {
    const r = findSplit(c, id);
    if (r) return r;
  }
  return null;
};

/**
 * The invariants at the top of paneModel.ts, checked from scratch (not through checkPanes).
 * `popout` trees have no board; everything else has exactly one.
 */
export function invariantErrors(s: PaneState, opts: { popout?: boolean } = {}): string[] {
  const errs: string[] = [];
  const all: PaneLeaf[] = [];
  const ids: string[] = [];
  const walk = (n: PaneNode) => {
    ids.push(n.id);
    if (n.type === "leaf") return all.push(n);
    if (n.children.length < 2) errs.push(`split ${n.id} has ${n.children.length} children`);
    if (n.sizes.length !== n.children.length) errs.push(`split ${n.id} sizes length`);
    const sum = n.sizes.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) errs.push(`split ${n.id} sizes sum ${sum}`);
    if (n.sizes.some((x) => !(x > 0))) errs.push(`split ${n.id} non-positive size`);
    for (const c of n.children) {
      if (c.type === "split" && c.dir === n.dir) errs.push(`split ${c.id} nested in same dir`);
      walk(c);
    }
  };
  walk(s.root);
  const boards = all.filter((l) => l.content.kind === "board").length;
  if (opts.popout ? boards !== 0 : boards !== 1) errs.push(`${boards} boards`);
  const dupes = (xs: string[], what: string) => {
    if (new Set(xs).size !== xs.length) errs.push(`duplicate ${what}`);
  };
  dupes(ids, "ids");
  if (ids.some((i) => !i)) errs.push("empty id");
  dupes(all.flatMap((l) => (l.content.kind === "ticket" ? [l.content.ticketKey] : [])), "ticket keys");
  dupes(all.flatMap((l) => (l.content.kind === "terminal" ? [l.content.sessionId] : [])), "terminal sessions");
  dupes(all.flatMap((l) => (l.content.kind === "compose" ? [l.content.id] : [])), "composes");
  dupes(all.flatMap((l) => (l.content.kind === "file" ? [JSON.stringify([l.content.root, l.content.path])] : [])), "files");
  const leafSet = new Set(all.map((l) => l.id));
  if (s.focusedId !== null && !leafSet.has(s.focusedId)) errs.push("focusedId not a leaf");
  if (s.zoomedId !== null && !leafSet.has(s.zoomedId)) errs.push("zoomedId not a leaf");
  return errs;
}
