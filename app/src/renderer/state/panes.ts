// The pane layout: everything right of the left nav is a tmux-style split tree of panes. The board
// is one pane, each open ticket is another, and panes sit side by side (a "row" split) or stacked
// (a "column" split). The pure helpers (the click-a-card rule, docking, closing, resizing, parsing)
// are tested in panes.test.ts; the store at the bottom persists to localStorage like layout.ts.
//
// Every operation returns a new, normalized state (see `normalize`), so these always hold:
//   • exactly one board leaf, and a ticket key is open in at most one leaf;
//   • no split has fewer than 2 children, and no split directly holds a split with the same dir;
//   • a split's sizes are positive fractions that sum to 1;
//   • focusedId/zoomedId name an existing leaf, or are null.

import { useSyncExternalStore } from "react";
import { isTicketTab, type TicketTab } from "@harness/shared/state";

/** What a pane shows. Terminal panes will join this union later. */
export type PaneContent = { kind: "board" } | { kind: "ticket"; ticketKey: string; tab: TicketTab };
export interface PaneLeaf {
  type: "leaf";
  id: string;
  content: PaneContent;
}
/** "row" = children side by side (left to right), "column" = stacked (top to bottom). */
export type SplitDir = "row" | "column";
export interface PaneSplit {
  type: "split";
  id: string;
  dir: SplitDir;
  children: PaneNode[];
  /** Each child's share of the split, positive and summing to 1. */
  sizes: number[];
}
export type PaneNode = PaneLeaf | PaneSplit;
/** Which half of a pane something is dropped on. */
export type DropZone = "left" | "right" | "top" | "bottom";

export interface PaneState {
  root: PaneNode;
  focusedId: string | null;
  zoomedId: string | null;
}

/** The board's share when a ticket first opens beside it (the old ticket panel was ~40vw). */
export const BOARD_SHARE = 0.6;
const MAX_DEPTH = 32;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Restart the id sequence (p1, p2, …) so tests get deterministic ids. */
export function resetPaneIds() {
  idCounter = 0;
}

/** A new id that isn't already used in `taken`. */
function freshId(taken: Set<string>): string {
  let id: string;
  do id = `p${++idCounter}`;
  while (taken.has(id));
  taken.add(id);
  return id;
}

function allIds(node: PaneNode, out = new Set<string>()): Set<string> {
  out.add(node.id);
  if (node.type === "split") for (const c of node.children) allIds(c, out);
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every leaf, depth-first, first child first (left to right, top to bottom). */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leaves);
}

export const findLeaf = (root: PaneNode, id: string): PaneLeaf | null => leaves(root).find((l) => l.id === id) ?? null;
export const boardLeaf = (root: PaneNode): PaneLeaf | null => leaves(root).find((l) => l.content.kind === "board") ?? null;
export const ticketLeafByKey = (root: PaneNode, key: string): PaneLeaf | null =>
  leaves(root).find((l) => l.content.kind === "ticket" && l.content.ticketKey === key) ?? null;

type PathStep = { split: PaneSplit; index: number };

/** The splits from the root down to the node `id`, with the child index taken at each; null when absent. */
function pathTo(node: PaneNode, id: string): PathStep[] | null {
  if (node.id === id) return [];
  if (node.type === "leaf") return null;
  for (let i = 0; i < node.children.length; i++) {
    const rest = pathTo(node.children[i]!, id);
    if (rest) return [{ split: node, index: i }, ...rest];
  }
  return null;
}

/** Replace the node `id` with fn(node), copying only the splits on the way down. */
function replaceNode(node: PaneNode, id: string, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return fn(node);
  if (node.type === "leaf") return node;
  let changed = false;
  const children = node.children.map((c) => {
    const r = replaceNode(c, id, fn);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...node, children } : node;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Sizes as positive fractions summing to 1; if any entry is unusable they all become equal. */
function fixSizes(sizes: readonly unknown[], n: number): number[] {
  const ok = sizes.length === n && sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0);
  const raw = ok ? (sizes as number[]) : Array<number>(n).fill(1);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((s) => s / sum);
}

/** Collapse single-child splits, drop empty ones, flatten same-dir nesting, and fix sizes. */
function normalizeNode(node: PaneNode): PaneNode | null {
  if (node.type === "leaf") return node;
  const sizes = fixSizes(node.sizes, node.children.length);
  const children: PaneNode[] = [];
  const sz: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalizeNode(c);
    if (!n) return;
    if (n.type === "split" && n.dir === node.dir) {
      n.children.forEach((g, j) => {
        children.push(g);
        sz.push(sizes[i]! * n.sizes[j]!);
      });
    } else {
      children.push(n);
      sz.push(sizes[i]!);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { type: "split", id: node.id, dir: node.dir, children, sizes: fixSizes(sz, children.length) };
}

/** Drop the leaves `keep` rejects (their sizes go with them); the result still needs normalizing. */
function prune(node: PaneNode, keep: (l: PaneLeaf) => boolean): PaneNode | null {
  if (node.type === "leaf") return keep(node) ? node : null;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = prune(c, keep);
    if (n) {
      children.push(n);
      sizes.push(node.sizes[i]!);
    }
  });
  return children.length ? { ...node, children, sizes } : null;
}

/** Give every node a unique, non-empty id (the first holder of an id keeps it). */
function uniqueIds(root: PaneNode): PaneNode {
  const taken = allIds(root);
  const seen = new Set<string>();
  const walk = (n: PaneNode): PaneNode => {
    const id = n.id && !seen.has(n.id) ? n.id : freshId(taken);
    seen.add(id);
    if (n.type === "leaf") return id === n.id ? n : { ...n, id };
    return { ...n, id, children: n.children.map(walk) };
  };
  return walk(root);
}

/**
 * Repair a state so every invariant holds: later duplicate boards and duplicate ticket keys are
 * dropped, a missing board comes back on the left, the tree is collapsed/flattened, sizes are fixed,
 * ids are made unique, and a focus/zoom pointing at no leaf becomes null.
 */
export function normalize(s: { root: PaneNode | null; focusedId?: string | null; zoomedId?: string | null }): PaneState {
  let sawBoard = false;
  const keys = new Set<string>();
  let root =
    s.root &&
    prune(s.root, (l) => {
      if (l.content.kind === "board") return sawBoard ? false : (sawBoard = true);
      if (keys.has(l.content.ticketKey)) return false;
      keys.add(l.content.ticketKey);
      return true;
    });
  root = root && normalizeNode(root);
  if (!root || !sawBoard) {
    const board: PaneLeaf = { type: "leaf", id: "", content: { kind: "board" } };
    root = root ? normalizeNode({ type: "split", id: "", dir: "row", children: [board, root], sizes: [BOARD_SHARE, 1 - BOARD_SHARE] })! : board;
  }
  root = uniqueIds(root);
  const ids = new Set(leaves(root).map((l) => l.id));
  const keepId = (id: string | null | undefined) => (id && ids.has(id) ? id : null);
  return { root, focusedId: keepId(s.focusedId), zoomedId: keepId(s.zoomedId) };
}

/** Every invariant `state` breaks, as human-readable strings (empty = valid). */
export function checkPanes(state: PaneState): string[] {
  const errors: string[] = [];
  const all = leaves(state.root);
  const boards = all.filter((l) => l.content.kind === "board").length;
  if (boards !== 1) errors.push(`${boards} board leaves`);
  const keys = new Set<string>();
  for (const l of all) {
    if (l.content.kind !== "ticket") continue;
    if (keys.has(l.content.ticketKey)) errors.push(`ticket ${l.content.ticketKey} is open twice`);
    keys.add(l.content.ticketKey);
  }
  const ids = new Set<string>();
  const walk = (n: PaneNode) => {
    if (!n.id) errors.push("a node has no id");
    else if (ids.has(n.id)) errors.push(`id ${n.id} is used twice`);
    ids.add(n.id);
    if (n.type === "leaf") return;
    if (n.children.length < 2) errors.push(`split ${n.id} has ${n.children.length} children`);
    if (n.sizes.length !== n.children.length) errors.push(`split ${n.id} has ${n.sizes.length} sizes for ${n.children.length} children`);
    if (!n.sizes.every((s) => Number.isFinite(s) && s > 0)) errors.push(`split ${n.id} has a non-positive size`);
    const sum = n.sizes.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) errors.push(`split ${n.id} sizes sum to ${sum}`);
    for (const c of n.children) {
      if (c.type === "split" && c.dir === n.dir) errors.push(`split ${c.id} nests in ${n.id} with the same dir`);
      walk(c);
    }
  };
  walk(state.root);
  const leafIds = new Set(all.map((l) => l.id));
  if (state.focusedId !== null && !leafIds.has(state.focusedId)) errors.push(`focusedId ${state.focusedId} is not a leaf`);
  if (state.zoomedId !== null && !leafIds.has(state.zoomedId)) errors.push(`zoomedId ${state.zoomedId} is not a leaf`);
  return errors;
}

// ---------------------------------------------------------------------------
// Tree edits
// ---------------------------------------------------------------------------

const DIR_OF: Record<DropZone, SplitDir> = { left: "row", right: "row", top: "column", bottom: "column" };
const AFTER: Record<DropZone, boolean> = { left: false, right: true, top: false, bottom: true };

/**
 * Put `leaf` beside the leaf `targetId` on its `zone` side, taking `share` of the target's space.
 * When the target's parent already splits that way the leaf becomes a sibling; otherwise the target
 * is wrapped in a new split.
 */
function insertLeaf(root: PaneNode, targetId: string, zone: DropZone, leaf: PaneLeaf, share: number): PaneNode {
  const path = pathTo(root, targetId);
  if (!path) return root;
  const dir = DIR_OF[zone];
  const after = AFTER[zone];
  const parent = path.at(-1);
  if (parent && parent.split.dir === dir) {
    const { split, index } = parent;
    const s = split.sizes[index]!;
    const at = after ? index + 1 : index;
    const children = [...split.children];
    const sizes = [...split.sizes];
    sizes[index] = s * (1 - share);
    children.splice(at, 0, leaf);
    sizes.splice(at, 0, s * share);
    return replaceNode(root, split.id, () => ({ ...split, children, sizes }));
  }
  const id = freshId(allIds(root));
  return replaceNode(root, targetId, (t) => ({
    type: "split",
    id,
    dir,
    children: after ? [t, leaf] : [leaf, t],
    sizes: after ? [1 - share, share] : [share, 1 - share],
  }));
}

/**
 * Remove the leaf `id`, handing its share to its neighbours (half each, or all of it to the only
 * one). `neighbour` is the nearest leaf in the pane that slides into its place: the next sibling's
 * first leaf, or the previous sibling's last leaf when it was the last child.
 */
function removeLeaf(root: PaneNode, id: string): { root: PaneNode | null; neighbour: string | null } {
  const path = pathTo(root, id);
  if (!path) return { root, neighbour: null };
  const parent = path.at(-1);
  if (!parent) return { root: null, neighbour: null };
  const { split, index } = parent;
  const s = split.sizes[index]!;
  const sizes = [...split.sizes];
  const hasPrev = index > 0;
  const hasNext = index < split.children.length - 1;
  if (hasPrev) sizes[index - 1]! += hasNext ? s / 2 : s;
  if (hasNext) sizes[index + 1]! += hasPrev ? s / 2 : s;
  sizes.splice(index, 1);
  const children = split.children.filter((_, i) => i !== index);
  const neighbour = hasNext ? leaves(split.children[index + 1]!)[0]!.id : leaves(split.children[index - 1]!).at(-1)!.id;
  return { root: normalizeNode(replaceNode(root, split.id, () => ({ ...split, children, sizes }))), neighbour };
}

function setLeafContent(root: PaneNode, id: string, content: PaneContent): PaneNode {
  return replaceNode(root, id, (n) => ({ ...(n as PaneLeaf), content }));
}

/** Keep the zoom only if it's on the pane being revealed; zooming something else would hide it. */
const zoomFor = (state: PaneState, id: string) => (state.zoomedId === id ? id : null);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function defaultPanes(): PaneState {
  return { root: { type: "leaf", id: freshId(new Set()), content: { kind: "board" } }, focusedId: null, zoomedId: null };
}

/**
 * The click-a-card rule. An already-open ticket gets focused (switching to `tab` if given).
 * Otherwise the ticket replaces the first ticket pane to the right of the board (in the next
 * sibling of the nearest row split where the board isn't last); failing that, the board splits
 * with the new pane on its right taking 40%. The opened pane is focused, and a zoom on some other
 * pane ends so the ticket is visible.
 */
export function openTicket(state: PaneState, key: string, tab?: TicketTab): PaneState {
  const existing = ticketLeafByKey(state.root, key);
  if (existing) {
    const root = tab && existing.content.kind === "ticket" && existing.content.tab !== tab ? setLeafContent(state.root, existing.id, { ...existing.content, tab }) : state.root;
    return normalize({ root, focusedId: existing.id, zoomedId: zoomFor(state, existing.id) });
  }
  const content: PaneContent = { kind: "ticket", ticketKey: key, tab: tab ?? "summaries" };
  const board = boardLeaf(state.root)!;
  const path = pathTo(state.root, board.id)!;
  for (let k = path.length - 1; k >= 0; k--) {
    const { split, index } = path[k]!;
    if (split.dir !== "row" || index === split.children.length - 1) continue;
    const target = leaves(split.children[index + 1]!).find((l) => l.content.kind === "ticket");
    if (target) return normalize({ root: setLeafContent(state.root, target.id, content), focusedId: target.id, zoomedId: zoomFor(state, target.id) });
    break;
  }
  const leaf: PaneLeaf = { type: "leaf", id: freshId(allIds(state.root)), content };
  return normalize({ root: insertLeaf(state.root, board.id, "right", leaf, 1 - BOARD_SHARE), focusedId: leaf.id, zoomedId: null });
}

/**
 * Dock `moving` (an existing leaf, re-docked with `content`) or a new leaf showing `content` on the
 * `zone` half of `targetId`, splitting the target's space 50/50. Ends any zoom.
 */
function dock(state: PaneState, moving: PaneLeaf | null, targetId: string, zone: DropZone, content: PaneContent): PaneState {
  if (!findLeaf(state.root, targetId) || moving?.id === targetId) return state;
  let root = state.root;
  let leaf: PaneLeaf;
  if (moving) {
    root = removeLeaf(root, moving.id).root!; // the target survives, so the tree isn't empty
    leaf = { ...moving, content };
  } else {
    leaf = { type: "leaf", id: freshId(allIds(root)), content };
  }
  return normalize({ root: insertLeaf(root, targetId, zone, leaf, 0.5), focusedId: leaf.id, zoomedId: null });
}

/**
 * Drop a card (or the board) on the `zone` half of a pane. Content that's already open (the board,
 * or a ticket in another pane) moves there rather than opening twice.
 */
export function dropContent(state: PaneState, targetLeafId: string, zone: DropZone, content: PaneContent): PaneState {
  const existing = content.kind === "board" ? boardLeaf(state.root) : ticketLeafByKey(state.root, content.ticketKey);
  return dock(state, existing, targetLeafId, zone, content);
}

/** Re-dock an existing pane on the `zone` half of another (dragging a pane by its header). */
export function movePane(state: PaneState, leafId: string, targetLeafId: string, zone: DropZone): PaneState {
  const leaf = findLeaf(state.root, leafId);
  return leaf ? dock(state, leaf, targetLeafId, zone, leaf.content) : state;
}

/**
 * Close a pane; its neighbours take its space. The board can't be closed. Closing the focused pane
 * focuses its nearest neighbour; closing the zoomed pane ends the zoom.
 */
export function closePane(state: PaneState, leafId: string): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind === "board") return state;
  const { root, neighbour } = removeLeaf(state.root, leafId);
  return normalize({
    root,
    focusedId: state.focusedId === leafId ? neighbour : state.focusedId,
    zoomedId: state.zoomedId === leafId ? null : state.zoomedId,
  });
}

export function setTab(state: PaneState, leafId: string, tab: TicketTab): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind !== "ticket" || leaf.content.tab === tab) return state;
  return { ...state, root: setLeafContent(state.root, leafId, { ...leaf.content, tab }) };
}

/**
 * Navigate inside a pane (e.g. opening a child from a conductor's Tickets tab). Content already open
 * in another pane is focused there instead (switching its tab to the requested one). The board pane
 * always shows the board, so it can't be navigated away.
 */
export function replaceContent(state: PaneState, leafId: string, content: PaneContent): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind === "board") return state;
  const existing = content.kind === "board" ? boardLeaf(state.root) : ticketLeafByKey(state.root, content.ticketKey);
  const target = existing ?? leaf;
  return normalize({ root: setLeafContent(state.root, target.id, content), focusedId: target.id, zoomedId: zoomFor(state, target.id) });
}

/** Focus a pane; a zoom on another pane ends so the focused one is visible. */
export function focusPane(state: PaneState, leafId: string): PaneState {
  if (!findLeaf(state.root, leafId)) return state;
  const zoomedId = zoomFor(state, leafId);
  return state.focusedId === leafId && state.zoomedId === zoomedId ? state : { ...state, focusedId: leafId, zoomedId };
}

/** Zoom a pane to fill the area (and focus it), or unzoom it. A lone pane has nothing to zoom over. */
export function toggleZoom(state: PaneState, leafId: string | null = state.focusedId): PaneState {
  if (state.zoomedId !== null && state.zoomedId === leafId) return { ...state, zoomedId: null };
  if (!leafId || state.root.type === "leaf" || !findLeaf(state.root, leafId)) return state;
  return { ...state, focusedId: leafId, zoomedId: leafId };
}

/** Commit a split's sizes (after a divider drag); they're re-normalized, and ignored if they don't fit. */
export function setSizes(state: PaneState, splitId: string, sizes: number[]): PaneState {
  const path = pathTo(state.root, splitId);
  const node = path && (path.length ? path.at(-1)!.split.children[path.at(-1)!.index]! : state.root);
  if (!node || node.type !== "split" || sizes.length !== node.children.length) return state;
  return normalize({ ...state, root: replaceNode(state.root, splitId, () => ({ ...node, sizes })) });
}

/** A ticket's key changed (a project rename): follow it, or close the pane if the new key is already open. */
export function renameTicketKey(state: PaneState, oldKey: string, newKey: string): PaneState {
  const leaf = ticketLeafByKey(state.root, oldKey);
  if (!leaf || leaf.content.kind !== "ticket" || oldKey === newKey) return state;
  const other = ticketLeafByKey(state.root, newKey);
  if (other) {
    const next = closePane(state, leaf.id);
    return state.focusedId === leaf.id ? { ...next, focusedId: other.id } : next;
  }
  return { ...state, root: setLeafContent(state.root, leaf.id, { ...leaf.content, ticketKey: newKey }) };
}

/** Close every ticket pane whose ticket no longer exists. */
export function pruneTickets(state: PaneState, exists: (key: string) => boolean): PaneState {
  let next = state;
  for (const l of leaves(state.root)) if (l.content.kind === "ticket" && !exists(l.content.ticketKey)) next = closePane(next, l.id);
  return next;
}

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

/**
 * New sizes while dragging the divider between child `index` and `index + 1` by `deltaPx`, in a
 * split `totalPx` long. Only those two children change, and neither goes below `minPx`; when the
 * pair is too small for two minimums they share it equally.
 */
export function resizeSplit(sizes: readonly number[], index: number, deltaPx: number, totalPx: number, minPx: number): number[] {
  const out = [...sizes];
  if (index < 0 || index + 1 >= sizes.length || !(totalPx > 0) || Number.isNaN(deltaPx)) return out;
  const a = sizes[index]! * totalPx;
  const pair = a + sizes[index + 1]! * totalPx;
  const na = pair < 2 * minPx ? pair / 2 : Math.max(minPx, Math.min(pair - minPx, a + deltaPx));
  out[index] = na / totalPx;
  out[index + 1] = (pair - na) / totalPx;
  return out;
}

/**
 * Keyboard resizing on a focused divider (role=separator), like keyWidth in layout.ts: the arrows
 * along the split's axis move it 16px (64px with Shift); Home/End move it as far back/forward as it
 * goes. Returns the new sizes, or null when the key isn't a resize key for this split.
 */
export function keySplit(key: string, shift: boolean, dir: SplitDir, sizes: readonly number[], index: number, totalPx: number, minPx: number): number[] | null {
  const step = shift ? 64 : 16;
  const [back, forward] = dir === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const delta = key === back ? -step : key === forward ? step : key === "Home" ? -Infinity : key === "End" ? Infinity : null;
  return delta === null ? null : resizeSplit(sizes, index, delta, totalPx, minPx);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseContent(v: unknown): PaneContent | null {
  if (!isObject(v)) return null;
  if (v.kind === "board") return { kind: "board" };
  if (v.kind === "ticket" && typeof v.ticketKey === "string" && v.ticketKey) {
    return { kind: "ticket", ticketKey: v.ticketKey, tab: typeof v.tab === "string" && isTicketTab(v.tab) ? v.tab : "summaries" };
  }
  return null; // unknown kinds (e.g. from a newer build) are dropped
}

function parseNode(v: unknown, depth: number): PaneNode | null {
  if (depth > MAX_DEPTH || !isObject(v)) return null;
  const id = typeof v.id === "string" ? v.id : "";
  if (v.type === "leaf") {
    const content = parseContent(v.content);
    return content && { type: "leaf", id, content };
  }
  if (v.type !== "split" || (v.dir !== "row" && v.dir !== "column") || !Array.isArray(v.children)) return null;
  const rawSizes: unknown[] = Array.isArray(v.sizes) && v.sizes.length === v.children.length ? v.sizes : [];
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  v.children.forEach((c, i) => {
    const n = parseNode(c, depth + 1);
    if (!n) return;
    children.push(n);
    sizes.push(typeof rawSizes[i] === "number" ? rawSizes[i] : NaN); // NaN → fixSizes evens them out
  });
  return { type: "split", id, dir: v.dir, children, sizes };
}

/** Read the stored panes, tolerating anything (missing, corrupt, older shapes, junk, broken invariants). */
export function parsePanes(raw: string | null | undefined): PaneState {
  if (!raw) return defaultPanes();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return defaultPanes();
  }
  if (!isObject(v)) return defaultPanes();
  const root = parseNode(v.root, 0);
  if (!root) return defaultPanes();
  const idOrNull = (x: unknown) => (typeof x === "string" ? x : null);
  return normalize({ root, focusedId: idOrNull(v.focusedId), zoomedId: idOrNull(v.zoomedId) });
}

export const serializePanes = (s: PaneState) => JSON.stringify(s);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const PANES_KEY = "harness.panes";

function load(): PaneState {
  try {
    return parsePanes(localStorage.getItem(PANES_KEY));
  } catch {
    return defaultPanes();
  }
}

let current: PaneState | null = null;
const listeners = new Set<() => void>();
const get = () => (current ??= load());

function publish(next: PaneState) {
  current = next;
  for (const fn of listeners) fn();
}

/** Apply an operation (e.g. `updatePanes((s) => openTicket(s, key))`); a no-op returning the same state writes nothing. */
export function updatePanes(fn: (s: PaneState) => PaneState) {
  const prev = get();
  const next = fn(prev);
  if (next === prev) return;
  try {
    localStorage.setItem(PANES_KEY, serializePanes(next));
  } catch {}
  publish(next);
}

let started = false;
function subscribe(fn: () => void) {
  if (!started) {
    started = true;
    // Another window (or a test/screenshot setup) changed it: follow.
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === PANES_KEY || e.key === null) publish(load());
    });
  }
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function usePanes(): PaneState {
  return useSyncExternalStore(subscribe, get);
}
