// The pane layout: everything right of the left nav is a tmux-style split tree of panes. The board
// is one pane, each open ticket or terminal is another, and panes sit side by side (a "row" split) or stacked
// (a "column" split). The pure helpers (the click-a-card rule, docking, closing, resizing, parsing)
// are tested in panes.test.ts; the store at the bottom persists to localStorage like layout.ts.
//
// Each board scope (a project, or ALL_SCOPE for "All projects") has its own tree: the operations
// work on one scope's PaneState, and the store keeps a PaneState per scope. Pane ids are unique
// across every scope, since a pane's id is what its content is keyed by. A terminal pane's shell is
// keyed by its content's `sessionId` rather than the pane id: pane ids come from a per-window
// counter and can be re-minted on load, and a shell must never be handed to the wrong pane.
//
// Every operation returns a new, normalized state (see `normalize`), so these always hold:
//   • exactly one board leaf, a ticket key is open in at most one leaf, and so is a terminal session;
//   • no split has fewer than 2 children, and no split directly holds a split with the same dir;
//   • a split's sizes are positive fractions that sum to 1;
//   • focusedId/zoomedId name an existing leaf, or are null.

import { useSyncExternalStore } from "react";
import { ALL_SCOPE, isTicketTab, type TicketTab } from "@harness/shared/state";

/**
 * A shell in the main process (window.harness.terminal), started in `cwd` (`~` = home). `sessionId`
 * names the PTY, so a remounted pane re-attaches to the same shell; `title` is the last one the
 * shell set (OSC 0/2), if any.
 */
export interface TerminalContent {
  kind: "terminal";
  sessionId: string;
  cwd: string;
  title?: string;
}
/**
 * A New session before anything is saved (views/DraftEditor.tsx). `id` names it (at most one leaf
 * per id); `projectId` presets the project ("New session in <project>"). Never stored: an empty
 * New session isn't worth restoring, and one with anything in it is already a draft ticket, whose
 * pane (a "ticket" leaf) is stored like any other.
 */
export interface ComposeContent {
  kind: "compose";
  id: string;
  projectId?: string | null;
}
/** What a pane shows. */
export type PaneContent = { kind: "board" } | { kind: "ticket"; ticketKey: string; tab: TicketTab } | TerminalContent | ComposeContent;
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

/**
 * Move the id sequence past every `p<N>` in `ids`. Other scopes' ids never reach the operations
 * (they only see their own tree), so the sequence itself has to stay clear of them: the store runs
 * every id it loads through here.
 */
export function seedPaneIds(ids: Iterable<string>) {
  for (const id of ids) {
    const m = /^p(\d+)$/.exec(id);
    if (m) idCounter = Math.max(idCounter, Number(m[1]));
  }
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
export const terminalLeafBySession = (root: PaneNode, sessionId: string): PaneLeaf | null =>
  leaves(root).find((l) => l.content.kind === "terminal" && l.content.sessionId === sessionId) ?? null;
export const composeLeafById = (root: PaneNode, id: string): PaneLeaf | null => leaves(root).find((l) => l.content.kind === "compose" && l.content.id === id) ?? null;

/** The leaf already showing `content`'s one-of-a-kind thing (the board, a ticket, a terminal session, a New session), if any. */
function leafShowing(root: PaneNode, content: PaneContent): PaneLeaf | null {
  switch (content.kind) {
    case "board":
      return boardLeaf(root);
    case "ticket":
      return ticketLeafByKey(root, content.ticketKey);
    case "terminal":
      return terminalLeafBySession(root, content.sessionId);
    case "compose":
      return composeLeafById(root, content.id);
  }
}

/** How menus and drag chips name a pane: "the board", a ticket's key, a terminal's title or folder, "New session". */
export function paneLabel(content: PaneContent): string {
  if (content.kind === "board") return "the board";
  if (content.kind === "ticket") return content.ticketKey;
  if (content.kind === "compose") return "New session";
  return content.title || cwdName(content.cwd);
}

/** A directory's last component, for a terminal that hasn't set a title (`~` for home). */
export function cwdName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "~" || trimmed === "") return cwd.startsWith("/") ? "/" : "~";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

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

/** Give every node a unique, non-empty id that isn't `reserved` (the first holder of an id keeps it). */
function uniqueIds(root: PaneNode, reserved: ReadonlySet<string>): PaneNode {
  const taken = new Set([...reserved, ...allIds(root)]);
  const seen = new Set(reserved);
  const walk = (n: PaneNode): PaneNode => {
    const id = n.id && !seen.has(n.id) ? n.id : freshId(taken);
    seen.add(id);
    if (n.type === "leaf") return id === n.id ? n : { ...n, id };
    return { ...n, id, children: n.children.map(walk) };
  };
  return walk(root);
}

/**
 * Repair a state so every invariant holds: later duplicate boards, ticket keys and terminal sessions
 * are dropped, a missing board comes back on the left, the tree is collapsed/flattened, sizes are
 * fixed, ids are made unique (and kept clear of `reserved`, e.g. other scopes' ids), and a focus/zoom
 * pointing at no leaf becomes null. Terminal sessions in `claimedSessions` (other scopes' terminals)
 * are dropped too, and the ones kept are added to it.
 */
export function normalize(
  s: { root: PaneNode | null; focusedId?: string | null; zoomedId?: string | null },
  reserved: ReadonlySet<string> = new Set(),
  claimedSessions: Set<string> = new Set(),
): PaneState {
  let sawBoard = false;
  const keys = new Set<string>();
  const sessions = new Set<string>();
  const composes = new Set<string>();
  let root =
    s.root &&
    prune(s.root, (l) => {
      if (l.content.kind === "board") return sawBoard ? false : (sawBoard = true);
      if (l.content.kind === "compose") {
        if (composes.has(l.content.id)) return false;
        composes.add(l.content.id);
        return true;
      }
      if (l.content.kind === "terminal") {
        if (sessions.has(l.content.sessionId) || claimedSessions.has(l.content.sessionId)) return false;
        sessions.add(l.content.sessionId);
        return true;
      }
      if (keys.has(l.content.ticketKey)) return false;
      keys.add(l.content.ticketKey);
      return true;
    });
  for (const id of sessions) claimedSessions.add(id);
  root = root && normalizeNode(root);
  if (!root || !sawBoard) {
    const board: PaneLeaf = { type: "leaf", id: "", content: { kind: "board" } };
    root = root ? normalizeNode({ type: "split", id: "", dir: "row", children: [board, root], sizes: [BOARD_SHARE, 1 - BOARD_SHARE] })! : board;
  }
  root = uniqueIds(root, reserved);
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
  const sessions = new Set<string>();
  const composes = new Set<string>();
  for (const l of all) {
    if (l.content.kind === "compose") {
      if (composes.has(l.content.id)) errors.push(`New session ${l.content.id} is open twice`);
      composes.add(l.content.id);
    }
    if (l.content.kind === "terminal") {
      if (sessions.has(l.content.sessionId)) errors.push(`terminal ${l.content.sessionId} is open twice`);
      sessions.add(l.content.sessionId);
    }
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

/** Just the board. `boardId` defaults to a fresh id. */
export function defaultPanes(boardId: string = freshId(new Set())): PaneState {
  return { root: { type: "leaf", id: boardId, content: { kind: "board" } }, focusedId: null, zoomedId: null };
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
 * A new terminal pane's content: a shell in `cwd` under a fresh, collision-proof session id (two
 * windows can mint the same pane id before either sees the other's write, but never the same UUID).
 */
export function newTerminalContent(cwd: string, uuid: () => string = () => crypto.randomUUID()): TerminalContent {
  return { kind: "terminal", sessionId: `${TERMINAL_SESSION_PREFIX}${uuid()}`, cwd };
}

/** Every terminal pane's session id starts with this; shells with other ids aren't a pane's to clean up. */
export const TERMINAL_SESSION_PREFIX = "t:";

/** Of the shells the main process has, the ones a pane made that no scope shows any more (left over from before a reload). */
export function orphanSessions(running: readonly string[], store: PaneStore): string[] {
  const open = terminalSessions(store);
  return running.filter((id) => id.startsWith(TERMINAL_SESSION_PREFIX) && !open.has(id));
}

/**
 * Open a terminal beside `fromLeafId`, else the focused pane, else the board (splitTarget), on its
 * right: half of that pane's space, or the ticket's 40% beside the board. The new pane is focused.
 * Every call adds a pane (terminals aren't one-per-anything), unless `content`'s session is already
 * open, which just focuses it.
 */
export function openTerminal(state: PaneState, content: TerminalContent, fromLeafId: string | null = null): PaneState {
  const existing = terminalLeafBySession(state.root, content.sessionId);
  if (existing) return focusPane(state, existing.id);
  return dock(state, null, splitTarget(state, fromLeafId), "right", content);
}

let composeCounter = 0;

/** A new New session pane's content, under an id no other New session has (optionally preset to a project). */
export function newComposeContent(projectId: string | null = null): ComposeContent {
  return { kind: "compose", id: `n${++composeCounter}`, ...(projectId ? { projectId } : {}) };
}

/**
 * Open a New session pane beside `fromLeafId`, else the focused pane, else the board, exactly
 * where openTerminal puts a terminal. Every call opens another one (several drafts can be written
 * at once); `content` defaults to a fresh one.
 */
export function openCompose(state: PaneState, fromLeafId: string | null = null, content: ComposeContent = newComposeContent()): PaneState {
  const existing = composeLeafById(state.root, content.id);
  if (existing) return focusPane(state, existing.id);
  return dock(state, null, splitTarget(state, fromLeafId), "right", content);
}

/**
 * A New session was saved as the draft `ticketKey`: its pane shows the ticket from now on, in
 * place (same leaf id, same size, same focus). If that ticket is already open in another pane,
 * the New session pane closes and the focus goes there instead.
 */
export function composeToTicket(state: PaneState, composeId: string, ticketKey: string, tab: TicketTab = "summaries"): PaneState {
  const leaf = composeLeafById(state.root, composeId);
  if (!leaf) return state;
  const other = ticketLeafByKey(state.root, ticketKey);
  if (other) {
    const next = closePane(state, leaf.id);
    return state.focusedId === leaf.id ? focusPane(next, other.id) : next;
  }
  return normalize({ ...state, root: setLeafContent(state.root, leaf.id, { kind: "ticket", ticketKey, tab }) });
}

/**
 * Dock `moving` (an existing leaf, re-docked with `content`) or a new leaf showing `content` on the
 * `zone` half of `targetId`, splitting the target's space 50/50. Docking against the board leaves
 * it BOARD_SHARE instead, the same split a card click makes. Ends any zoom.
 */
function dock(state: PaneState, moving: PaneLeaf | null, targetId: string, zone: DropZone, content: PaneContent): PaneState {
  const target = findLeaf(state.root, targetId);
  if (!target || moving?.id === targetId) return state;
  const share = target.content.kind === "board" ? 1 - BOARD_SHARE : 0.5;
  let root = state.root;
  let leaf: PaneLeaf;
  if (moving) {
    root = removeLeaf(root, moving.id).root!; // the target survives, so the tree isn't empty
    leaf = { ...moving, content };
  } else {
    leaf = { type: "leaf", id: freshId(allIds(root)), content };
  }
  return normalize({ root: insertLeaf(root, targetId, zone, leaf, share), focusedId: leaf.id, zoomedId: null });
}

/**
 * Drop a card (or the board) on the `zone` half of a pane. Content that's already open (the board,
 * a ticket or a terminal session in another pane) moves there rather than opening twice.
 */
export function dropContent(state: PaneState, targetLeafId: string, zone: DropZone, content: PaneContent): PaneState {
  return dock(state, leafShowing(state.root, content), targetLeafId, zone, content);
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

/**
 * Escape ends a zoom, or else closes the focused ticket or New session pane (never the board, nor a
 * terminal: Escape is the shell's). A draft's pane asks first (components/draftClose.ts), before this.
 */
export function escapePanes(s: PaneState): PaneState {
  if (s.zoomedId) return toggleZoom(s, s.zoomedId);
  const leaf = s.focusedId ? findLeaf(s.root, s.focusedId) : null;
  return leaf?.content.kind === "ticket" || leaf?.content.kind === "compose" ? closePane(s, leaf.id) : s;
}

export function setTab(state: PaneState, leafId: string, tab: TicketTab): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind !== "ticket" || leaf.content.tab === tab) return state;
  return { ...state, root: setLeafContent(state.root, leafId, { ...leaf.content, tab }) };
}

/** A terminal's shell set its title (OSC 0/2): keep it with the pane, so the header has it after a remount. Empty clears it. */
export function setTerminalTitle(state: PaneState, leafId: string, title: string): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind !== "terminal" || (leaf.content.title ?? "") === title) return state;
  const { title: _old, ...rest } = leaf.content;
  return { ...state, root: setLeafContent(state.root, leafId, title ? { ...rest, title } : rest) };
}

/**
 * Navigate inside a pane (e.g. opening a child from a conductor's Tickets tab). Content already open
 * in another pane is focused there instead (switching its tab to the requested one). The board pane
 * always shows the board, so it can't be navigated away.
 */
export function replaceContent(state: PaneState, leafId: string, content: PaneContent): PaneState {
  const leaf = findLeaf(state.root, leafId);
  if (!leaf || leaf.content.kind === "board") return state;
  const target = leafShowing(state.root, content) ?? leaf;
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

/** The ticket in the focused pane (what the URL hash mirrors), or null when no ticket pane is focused. */
export function focusedTicket(state: PaneState): { ticketKey: string; tab: TicketTab } | null {
  const leaf = state.focusedId ? findLeaf(state.root, state.focusedId) : null;
  return leaf?.content.kind === "ticket" ? { ticketKey: leaf.content.ticketKey, tab: leaf.content.tab } : null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A box as fractions (0–1) of the whole pane area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LeafBox {
  leaf: PaneLeaf;
  rect: Rect;
  /** Covered by a zoomed pane (still mounted, just not shown). */
  hidden: boolean;
}
export interface DividerBox {
  split: PaneSplit;
  /** Between child `index` and `index + 1`. */
  index: number;
  /** The split's sizes as laid out (after clamping to the panes' minimums), which a drag starts from. */
  sizes: number[];
  /** The split's own box (its length along the axis is what the divider resizes). */
  rect: Rect;
  /** Where the divider sits along the split's axis (x for "row", y for "column"). */
  at: number;
}
export interface PaneLayout {
  leaves: LeafBox[];
  dividers: DividerBox[];
  /** The pane in the top-left corner (the one whose header clears the window controls). */
  cornerId: string;
}

/** The workspace's size in px, which lets `layoutPanes` keep panes at their minimums. */
export interface PaneArea {
  width: number;
  height: number;
}

/**
 * Where every pane and divider goes. Panes are laid out flat (absolutely positioned siblings, not
 * nested boxes) so reshaping the tree never remounts one. A zoomed pane fills the area and the rest
 * are hidden, with no dividers. Given the workspace's `area`, each split's stored sizes are clamped
 * (clampSizes) so no pane renders below its minimum while there's room, whatever was stored (a
 * layout saved in a wider window, say); the stored sizes themselves don't change.
 */
export function layoutPanes(state: PaneState, area?: PaneArea): PaneLayout {
  const out: PaneLayout = { leaves: [], dividers: [], cornerId: "" };
  const zoomed = state.zoomedId;
  const walk = (node: PaneNode, rect: Rect) => {
    if (node.type === "leaf") {
      const isZoomed = node.id === zoomed;
      out.leaves.push({ leaf: node, rect: isZoomed ? { x: 0, y: 0, w: 1, h: 1 } : rect, hidden: !!zoomed && !isZoomed });
      return;
    }
    const row = node.dir === "row";
    const sizes = area ? clampSizes(node.sizes, node.children.map((c) => minSize(c, node.dir)), row ? rect.w * area.width : rect.h * area.height) : node.sizes;
    let offset = 0;
    node.children.forEach((c, i) => {
      const share = sizes[i]!;
      const box = row ? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * share, h: rect.h } : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * share };
      offset += share;
      if (i < node.children.length - 1 && !zoomed) out.dividers.push({ split: node, index: i, sizes, rect, at: row ? rect.x + rect.w * offset : rect.y + rect.h * offset });
      walk(c, box);
    });
  };
  walk(state.root, { x: 0, y: 0, w: 1, h: 1 });
  out.cornerId = zoomed ?? leaves(state.root)[0]!.id;
  return out;
}

export type PaneDir = "left" | "right" | "up" | "down";
const EDGE = 1e-6;

/**
 * The pane you land on moving `dir` from the pane `fromId` (⌥⌘arrows, ⌃hjkl): the nearest visible
 * pane beyond that edge that overlaps it across the axis, preferring the one sharing the most of its
 * edge, then the topmost/leftmost. Moving left from a pane on the workspace's left edge gives
 * "sidebar" when `sidebar` is set (the nav is open); otherwise null where there's nothing there.
 */
export function paneInDirection(layout: PaneLayout, fromId: string, dir: PaneDir, opts: { sidebar?: boolean } = {}): string | "sidebar" | null {
  const from = layout.leaves.find((b) => b.leaf.id === fromId && !b.hidden);
  if (!from) return null;
  const a = from.rect;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; gap: number; overlap: number; across: number } | null = null;
  for (const b of layout.leaves) {
    if (b.hidden || b.leaf.id === fromId) continue;
    const r = b.rect;
    const gap = dir === "left" ? a.x - (r.x + r.w) : dir === "right" ? r.x - (a.x + a.w) : dir === "up" ? a.y - (r.y + r.h) : r.y - (a.y + a.h);
    if (gap < -EDGE) continue;
    const overlap = horizontal ? Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y) : Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x);
    if (overlap <= EDGE) continue;
    const across = horizontal ? r.y : r.x;
    const better =
      !best || gap < best.gap - EDGE || (Math.abs(gap - best.gap) <= EDGE && (overlap > best.overlap + EDGE || (Math.abs(overlap - best.overlap) <= EDGE && across < best.across)));
    if (better) best = { id: b.leaf.id, gap, overlap, across };
  }
  if (best) return best.id;
  return dir === "left" && opts.sidebar && a.x <= EDGE ? "sidebar" : null;
}

/**
 * A split's `sizes` adjusted so each child gets at least `mins[i]` px of the split's `totalPx`:
 * children below their minimum are raised to it, and the rest share what's left in proportion to
 * their stored sizes (repeated until none is short). When the minimums don't all fit, the space is
 * shared in proportion to them, as resizeSplit does. Sizes that already fit come back unchanged.
 */
export function clampSizes(sizes: readonly number[], mins: readonly number[], totalPx: number): number[] {
  if (!(totalPx > 0) || sizes.length !== mins.length) return [...sizes];
  const need = mins.reduce((a, b) => a + b, 0);
  if (need >= totalPx) return need > 0 ? mins.map((m) => m / need) : [...sizes];
  const fixed = new Set<number>();
  const flexPx = () => {
    const free = totalPx - [...fixed].reduce((a, i) => a + mins[i]!, 0);
    const weight = sizes.reduce((a, s, i) => (fixed.has(i) ? a : a + s), 0);
    return (i: number) => (weight > 0 ? (sizes[i]! / weight) * free : free / (sizes.length - fixed.size));
  };
  for (;;) {
    const px = flexPx();
    const short = sizes.map((_, i) => i).filter((i) => !fixed.has(i) && px(i) < mins[i]! - 1e-9);
    if (!short.length) return sizes.map((_, i) => (fixed.has(i) ? mins[i]! : px(i)) / totalPx);
    for (const i of short) fixed.add(i);
  }
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/** What's being dragged onto the workspace: a ticket (a board card or child row), or a pane by its header. */
export type DragSource = { kind: "ticket"; ticketKey: string } | { kind: "pane"; leafId: string };

/** Ties go to the earlier zone, so the exact centre (and a row/column tie on a diagonal) splits side by side. */
const ZONE_ORDER: readonly DropZone[] = ["right", "left", "bottom", "top"];

/**
 * Which half of `rect` the point (x, y) points at: the rect's diagonals cut it into four triangles,
 * one per edge, so this is the nearest edge measured in the rect's own proportions. Points on a
 * diagonal go to left/right, the centre to "right". Null outside the rect (edges count as inside)
 * or for an empty rect.
 */
export function zoneAt(rect: Rect, x: number, y: number): DropZone | null {
  if (!(rect.w > 0 && rect.h > 0)) return null;
  const dx = (x - rect.x) / rect.w;
  const dy = (y - rect.y) / rect.h;
  if (!(dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1)) return null;
  const dist: Record<DropZone, number> = { right: 1 - dx, left: dx, bottom: 1 - dy, top: dy };
  let best = ZONE_ORDER[0]!;
  for (const z of ZONE_ORDER) if (dist[z] < dist[best]) best = z;
  return best;
}

/** The visible pane under the point (fractions of the workspace, as in `layoutPanes`) and the zone pointed at. */
export function dropTargetAt(layout: PaneLayout, x: number, y: number): { leafId: string; zone: DropZone; rect: Rect } | null {
  for (const { leaf, rect, hidden } of layout.leaves) {
    if (hidden) continue;
    const zone = zoneAt(rect, x, y);
    if (zone) return { leafId: leaf.id, zone, rect };
  }
  return null;
}

/**
 * Drop `source` on the `zone` half of the pane `targetLeafId`. A ticket that's already open moves
 * with its pane (keeping its tab) instead of opening twice; a new one opens on Summaries. Returns
 * `state` itself when the drop would do nothing (a pane dropped on itself, a missing pane), which
 * is also how the drag preview knows not to show.
 */
export function applyDrop(state: PaneState, source: DragSource, targetLeafId: string, zone: DropZone): PaneState {
  if (source.kind === "pane") return movePane(state, source.leafId, targetLeafId, zone);
  const open = ticketLeafByKey(state.root, source.ticketKey);
  return dropContent(state, targetLeafId, zone, open?.content ?? { kind: "ticket", ticketKey: source.ticketKey, tab: "summaries" });
}

/**
 * Where the dropped pane would land (fractions of the workspace): its box in the layout after
 * `applyDrop`, so the preview matches the result exactly (the board keeping 60%, a moved pane's old
 * space closing up). Null when the drop would do nothing.
 */
export function dropPreview(state: PaneState, source: DragSource, targetLeafId: string, zone: DropZone, area?: PaneArea): Rect | null {
  const next = applyDrop(state, source, targetLeafId, zone);
  if (next === state) return null;
  return layoutPanes(next, area).leaves.find((b) => b.leaf.id === next.focusedId)?.rect ?? null;
}

/**
 * The pane a menu's "Open to the Right/Below/…" splits: the pane the command came from (a child
 * row's conductor pane), else the focused pane, else the board. A pane already showing `ticketKey`
 * is skipped (splitting a ticket beside itself does nothing), falling through to the next choice.
 */
export function splitTarget(state: PaneState, fromLeafId: string | null = null, ticketKey?: string): string {
  const usable = (id: string | null) => {
    const leaf = id ? findLeaf(state.root, id) : null;
    return !!leaf && !(leaf.content.kind === "ticket" && leaf.content.ticketKey === ticketKey);
  };
  if (usable(fromLeafId)) return fromLeafId!;
  if (usable(state.focusedId)) return state.focusedId!;
  return boardLeaf(state.root)!.id;
}

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

/** The narrowest a pane may get: the board keeps its columns usable, a ticket its header and tabs, a terminal ~40 columns. */
export const PANE_MIN_WIDTH = { board: 320, ticket: 360, terminal: 320, compose: 360 } as const;
/** The shortest any pane may get in a column split. */
export const PANE_MIN_HEIGHT = 200;

/**
 * The least room `node` needs along `dir`'s axis (width for "row", height for "column"): leaves
 * need their own minimum, a split along the same axis the sum of its children's, a split across it
 * the largest of theirs.
 */
export function minSize(node: PaneNode, dir: SplitDir): number {
  if (node.type === "leaf") return dir === "row" ? PANE_MIN_WIDTH[node.content.kind] : PANE_MIN_HEIGHT;
  const mins = node.children.map((c) => minSize(c, dir));
  return node.dir === dir ? mins.reduce((a, b) => a + b, 0) : Math.max(...mins);
}

/**
 * New sizes while dragging the divider between child `index` and `index + 1` by `deltaPx`, in a
 * split `totalPx` long. Only those two children change, and neither goes below its minimum
 * (`minPx`, or `[before, after]` for different minimums); when the pair is too small for both
 * minimums it's shared in proportion to them (equally for a single `minPx`).
 */
export function resizeSplit(sizes: readonly number[], index: number, deltaPx: number, totalPx: number, minPx: number | readonly [number, number]): number[] {
  const out = [...sizes];
  if (index < 0 || index + 1 >= sizes.length || !(totalPx > 0) || Number.isNaN(deltaPx)) return out;
  const [minA, minB] = typeof minPx === "number" ? [minPx, minPx] : minPx;
  const a = sizes[index]! * totalPx;
  const pair = a + sizes[index + 1]! * totalPx;
  const na = pair < minA + minB ? (minA + minB > 0 ? (pair * minA) / (minA + minB) : pair / 2) : Math.max(minA, Math.min(pair - minB, a + deltaPx));
  out[index] = na / totalPx;
  out[index + 1] = (pair - na) / totalPx;
  return out;
}

/**
 * Keyboard resizing on a focused divider (role=separator): the arrows
 * along the split's axis move it 16px (64px with Shift); Home/End move it as far back/forward as it
 * goes. Returns the new sizes, or null when the key isn't a resize key for this split.
 */
export function keySplit(key: string, shift: boolean, dir: SplitDir, sizes: readonly number[], index: number, totalPx: number, minPx: number | readonly [number, number]): number[] | null {
  const step = shift ? 64 : 16;
  const [back, forward] = dir === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const delta = key === back ? -step : key === forward ? step : key === "Home" ? -Infinity : key === "End" ? Infinity : null;
  return delta === null ? null : resizeSplit(sizes, index, delta, totalPx, minPx);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** What the main process accepts as a terminal id (terminals.ts ID_PATTERN); anything else could never attach. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The panes as stored: New session panes aren't (see ComposeContent), so they drop out and their neighbours take their space. */
function withoutCompose(s: PaneState): PaneState {
  if (!leaves(s.root).some((l) => l.content.kind === "compose")) return s;
  const root = prune(s.root, (l) => l.content.kind !== "compose");
  const kept = (id: string | null) => (id && root && findLeaf(root, id) ? id : null);
  return { root: (root && normalizeNode(root)) ?? s.root, focusedId: kept(s.focusedId), zoomedId: kept(s.zoomedId) };
}

function parseContent(v: unknown): PaneContent | null {
  if (!isObject(v)) return null;
  if (v.kind === "board") return { kind: "board" };
  if (v.kind === "ticket" && typeof v.ticketKey === "string" && v.ticketKey) {
    return { kind: "ticket", ticketKey: v.ticketKey, tab: typeof v.tab === "string" && isTicketTab(v.tab) ? v.tab : "summaries" };
  }
  if (v.kind === "terminal" && typeof v.sessionId === "string" && SESSION_ID.test(v.sessionId) && typeof v.cwd === "string" && v.cwd) {
    const t: TerminalContent = { kind: "terminal", sessionId: v.sessionId, cwd: v.cwd };
    if (typeof v.title === "string" && v.title) t.title = v.title;
    return t;
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

const idOrNull = (x: unknown) => (typeof x === "string" ? x : null);

/** Read one stored tree, tolerating anything (missing, corrupt, older shapes, junk, broken invariants). */
export function parsePanes(raw: string | null | undefined): PaneState {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {}
  const root = isObject(v) ? parseNode(v.root, 0) : null;
  return root && isObject(v) ? normalize({ root, focusedId: idOrNull(v.focusedId), zoomedId: idOrNull(v.zoomedId) }) : defaultPanes();
}

export const serializePanes = (s: PaneState) => JSON.stringify(withoutCompose(s));

/** Every board scope's panes, keyed by scope (a project id, or ALL_SCOPE). A scope that isn't here shows just the board. */
export interface PaneStore {
  scopes: Record<string, PaneState>;
}

/**
 * Read the stored scopes, tolerating anything. An entry that doesn't parse is dropped (that board
 * starts bare), and ids are made unique across scopes, the first scope to use an id keeping it.
 * The id sequence moves past every stored id (seedPaneIds), so new panes never reuse one.
 *
 * The single tree from before layouts were per board (`{ root, focusedId, zoomedId }`) becomes the
 * All projects scope: it was shared by every board, and All projects is the one board that shows
 * every ticket it could hold. Project boards start bare.
 */
export function parsePaneStore(raw: string | null | undefined): PaneStore {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {}
  const entries: [string, unknown][] = !isObject(v) ? [] : isObject(v.scopes) ? Object.entries(v.scopes) : "root" in v ? [[ALL_SCOPE, v]] : [];
  const parsed = entries.flatMap(([scope, e]) => {
    const root = scope && isObject(e) ? parseNode(e.root, 0) : null;
    return root && isObject(e) ? [{ scope, root, focusedId: idOrNull(e.focusedId), zoomedId: idOrNull(e.zoomedId) }] : [];
  });
  seedPaneIds(parsed.flatMap((p) => [...allIds(p.root)]));
  const taken = new Set<string>();
  const sessions = new Set<string>();
  const scopes: Record<string, PaneState> = {};
  for (const { scope, ...s } of parsed) {
    const state = normalize(s, taken, sessions);
    allIds(state.root, taken);
    scopes[scope] = state;
  }
  return { scopes };
}

export const serializePaneStore = (s: PaneStore) => JSON.stringify({ scopes: Object.fromEntries(Object.entries(s.scopes).map(([scope, st]) => [scope, withoutCompose(st)])) });

/** The board leaf id of a scope that has no stored panes yet: the same every time, so re-reading the store doesn't remount the board. */
const bareBoardId = (scope: string) => `b:${scope}`;

/** `store` with `fn` applied to every stored scope; the same object when nothing changed. */
export function mapScopes(store: PaneStore, fn: (s: PaneState, scope: string) => PaneState): PaneStore {
  let changed = false;
  const scopes: Record<string, PaneState> = {};
  for (const [scope, s] of Object.entries(store.scopes)) {
    scopes[scope] = fn(s, scope);
    if (scopes[scope] !== s) changed = true;
  }
  return changed ? { scopes } : store;
}

/** `store` without the scopes `keep` rejects; the same object when none go. */
export function retainScopes(store: PaneStore, keep: (scope: string) => boolean): PaneStore {
  const scopes = Object.fromEntries(Object.entries(store.scopes).filter(([scope]) => keep(scope)));
  return Object.keys(scopes).length === Object.keys(store.scopes).length ? store : { scopes };
}

/** Every terminal session open in any scope: the shells that must stay alive. */
export function terminalSessions(store: PaneStore): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(store.scopes)) for (const l of leaves(s.root)) if (l.content.kind === "terminal") out.add(l.content.sessionId);
  return out;
}

/** The sessions open in `before` but in no scope of `after`: the shells to kill. A pane that only moved (even to another scope) keeps its shell. */
export function closedSessions(before: PaneStore, after: PaneStore): string[] {
  if (before === after) return [];
  const still = terminalSessions(after);
  return [...terminalSessions(before)].filter((id) => !still.has(id));
}

/**
 * A project was removed: its board's panes go, and its tickets (keys `<projectKey>-<n>`) close in
 * every other scope (All projects could have them open).
 */
export function forgetProject(store: PaneStore, projectId: string, projectKey: string | null): PaneStore {
  const rest = retainScopes(store, (scope) => scope !== projectId);
  return projectKey ? mapScopes(rest, (s) => pruneTickets(s, (k) => !k.startsWith(`${projectKey}-`))) : rest;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const PANES_KEY = "harness.panes";

function load(): PaneStore {
  try {
    return parsePaneStore(localStorage.getItem(PANES_KEY));
  } catch {
    return { scopes: {} };
  }
}

let current: PaneStore | null = null;
const listeners = new Set<() => void>();
const getStore = () => (current ??= load());

/** A scope's panes. One that isn't stored yet gets a bare board, kept in memory until it's first changed. */
function get(scope: string): PaneState {
  const store = getStore();
  return (store.scopes[scope] ??= defaultPanes(bareBoardId(scope)));
}

function publish(next: PaneStore) {
  current = next;
  for (const fn of listeners) fn();
}

/** Write the whole store (every scope) unless `next` is the store as it is. */
function commit(next: PaneStore) {
  if (next === getStore()) return;
  try {
    localStorage.setItem(PANES_KEY, serializePaneStore(next));
  } catch {}
  publish(next);
}

/** Apply an operation to one scope (e.g. `updatePanes(scope, (s) => openTicket(s, key))`); a no-op returning the same state writes nothing. */
export function updatePanes(scope: string, fn: (s: PaneState) => PaneState) {
  const prev = get(scope);
  const next = fn(prev);
  if (next !== prev) commit({ scopes: { ...getStore().scopes, [scope]: next } });
}

/** Apply an operation to every scope (a ticket deleted or renamed can be open in several). */
export function updateAllPanes(fn: (s: PaneState) => PaneState) {
  commit(mapScopes(getStore(), fn));
}

/** Drop the scopes `keep` rejects (projects that no longer exist). */
export function retainPaneScopes(keep: (scope: string) => boolean) {
  commit(retainScopes(getStore(), keep));
}

/** A project was removed (see forgetProject). */
export function forgetProjectPanes(projectId: string, projectKey: string | null) {
  commit(forgetProject(getStore(), projectId, projectKey));
}

/** Re-read the stored panes (another window wrote them). */
export const reloadPanes = () => publish(load());

/** The whole store (every scope), for things that span scopes like the terminal lifecycle. */
export const getPaneStore = (): PaneStore => getStore();

/**
 * Call `fn(before, after)` whenever the store changes (in this window, or re-read after another
 * window wrote it). Returns an unsubscribe.
 */
export function watchPaneStore(fn: (before: PaneStore, after: PaneStore) => void): () => void {
  let prev = getStore();
  return subscribe(() => {
    const next = getStore();
    if (next === prev) return;
    const before = prev;
    prev = next;
    fn(before, next);
  });
}

let started = false;
function subscribe(fn: () => void) {
  if (!started) {
    started = true;
    // Another window (or a test/screenshot setup) changed it: follow.
    globalThis.addEventListener?.("storage", (e: StorageEvent) => {
      if (e.key === PANES_KEY || e.key === null) reloadPanes();
    });
  }
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** A scope's current panes outside React (e.g. an effect checking that its render isn't already stale). */
export const getPanes = (scope: string): PaneState => get(scope);

export function usePanes(scope: string): PaneState {
  return useSyncExternalStore(subscribe, () => get(scope));
}
