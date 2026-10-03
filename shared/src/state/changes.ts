// The Changes tab (a ticket's diff): what the git plugin's routes return, the "Viewed" marks, the
// view preferences and the bits of presentation every client shares. The data still comes from the
// git plugin's server (GET /plugins/git/api/{changes,log,file}); the desktop app draws it natively
// (app/src/renderer/views/ChangesTab.tsx), as does the iOS app (HarnessKit Changes*), and the plugin's
// own page (plugins/git/ui) remains for other hosts.

// --- payloads (plugins/git/git.ts produces these) -----------------------------------------------

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** GET /plugins/git/api/changes?ticket=KEY */
export interface Changes {
  /**
   * "branch": ticket branch vs the base branch; "workdir": uncommitted changes vs HEAD;
   * "pinned": the worktree is gone, so the diff comes from the refs saved while it existed
   */
  mode: "branch" | "workdir" | "pinned";
  /** Base ref name ("main", or "HEAD" in workdir mode); null when no base branch could be found */
  base: string | null;
  /** The commit the diff starts from (merge-base in branch mode, HEAD in workdir mode); null for an empty repo */
  baseSha: string | null;
  /** HEAD of the workdir (the pinned branch head in pinned mode); null for an unborn branch */
  head: string | null;
  /** The ticket's branch, or the workdir's current branch in workdir mode */
  branch: string | null;
  files: ChangedFile[];
  /** Unified diff (git format), cut at a file boundary when truncated */
  patch: string;
  truncated: boolean;
  additions: number;
  deletions: number;
  /** Pinned mode only: the commit holding the pinned uncommitted changes, when there were any */
  worktree?: string | null;
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  /** epoch ms */
  date: number;
}

/** GET /plugins/git/api/log?ticket=KEY */
export interface ChangesLog {
  mode: Changes["mode"];
  base: string | null;
  commits: Commit[];
}

/** The git plugin's routes, relative to the service. */
export const changesApi = {
  changes: (ticket: string) => `/plugins/git/api/changes?ticket=${encodeURIComponent(ticket)}`,
  log: (ticket: string) => `/plugins/git/api/log?ticket=${encodeURIComponent(ticket)}`,
  /** One side of a file: "new" is the workdir's copy, "old" the base commit's (`ref`). */
  file: (ticket: string, side: "old" | "new", path: string, ref?: string | null) =>
    `/plugins/git/api/file?ticket=${encodeURIComponent(ticket)}&side=${side}&path=${encodeURIComponent(path)}${side === "old" && ref ? `&ref=${ref}` : ""}`,
};

// --- presentation ------------------------------------------------------------------------------

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A changed file's tree-row decoration: its line counts, or what kind of change it is when there are none. */
export function fileDecoration(f: ChangedFile): { text: string; title: string; parts?: { text: string; tone?: "add" | "del" }[] } | null {
  if (f.binary) return { text: "bin", title: "Binary file" };
  if (f.status === "renamed" && !f.additions && !f.deletions) return f.oldPath ? { text: "moved", title: `Renamed from ${f.oldPath}` } : null;
  return {
    text: `+${f.additions} −${f.deletions}`,
    title: `${f.additions} additions, ${f.deletions} deletions`,
    parts: [{ text: `+${f.additions}`, tone: "add" }, { text: " " }, { text: `−${f.deletions}`, tone: "del" }],
  };
}

/** What the tab says when there's nothing to diff. */
export function changesEmptyState(c: Pick<Changes, "mode" | "branch" | "base">): { title: string; detail: string } {
  if (c.mode === "branch")
    return { title: "No changes yet", detail: `${c.branch ?? "This branch"} matches ${c.base ?? "its base"} and the worktree is clean. Changes appear here as the agent edits files.` };
  if (c.mode === "pinned") return { title: "No changes", detail: `${c.branch ?? "This branch"} didn't change anything before its worktree was removed.` };
  return { title: "No changes yet", detail: "The working tree is clean. Changes appear here as the agent edits files." };
}

/** The amber notices above the diffs: a truncated patch, and a refresh that failed after one that worked. */
export function changesNotices(c: Pick<Changes, "truncated" | "files"> | null, error: string | null): string[] {
  const out: string[] = [];
  if (c?.truncated) out.push(`This diff is large, so only the first part is shown. ${plural(c.files.length, "file")} changed in total.`);
  if (error && c) out.push(`Refresh failed: ${error}`);
  return out;
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function relTime(ms: number, now = Date.now()) {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// --- preferences -------------------------------------------------------------------------------
// Kept in localStorage, so they carry over from one ticket to the next. Storage can be missing or
// throw (sandboxed or private contexts); reads then fall back to "no preference" and writes are dropped.

export type DiffStyle = "unified" | "split";
type Store = Pick<Storage, "getItem" | "setItem">;

export const STYLE_KEY = "harness.git.diffStyle";
export const SIDEBAR_KEY = "harness.git.sidebarCollapsed";
/** Below this width the file list becomes an overlay behind a button. */
export const CHANGES_NARROW_WIDTH = 720;
/** With no style chosen, split from this width up. */
export const AUTO_SPLIT_WIDTH = 1000;

const local = (): Store => localStorage;

function read(key: string, store: () => Store): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string, store: () => Store) {
  try {
    store().setItem(key, value);
  } catch {}
}

/** The diff style the user picked, or null when they haven't picked one (or it's unreadable). */
export function readStyle(store = local): DiffStyle | null {
  const v = read(STYLE_KEY, store);
  return v === "split" || v === "unified" ? v : null;
}

export const saveStyle = (s: DiffStyle, store = local) => write(STYLE_KEY, s, store);

/** The style to draw at `width`: the chosen one, else split on a wide panel. */
export const effectiveStyle = (chosen: DiffStyle | null, width: number): DiffStyle => chosen ?? (width >= AUTO_SPLIT_WIDTH ? "split" : "unified");

/** Whether the docked file sidebar is collapsed. Anything but an explicit "1" means expanded. */
export function readSidebarCollapsed(store = local): boolean {
  return read(SIDEBAR_KEY, store) === "1";
}

export const saveSidebarCollapsed = (collapsed: boolean, store = local) => write(SIDEBAR_KEY, collapsed ? "1" : "0", store);

// --- viewed marks ------------------------------------------------------------------------------
// "Viewed" marks on the diffs, like a GitHub PR review. A mark stores the file's diff fingerprint, so
// a file the agent changes again after you viewed it reads as unviewed. Marks live in localStorage
// under one key, bounded per ticket and in the number of tickets kept. Storage that's missing, throws,
// or holds garbage reads as "nothing viewed"; writes that fail are dropped.

/** path → fingerprint of the diff that was viewed */
export type Viewed = Map<string, string>;
interface TicketMarks {
  /** Last write, for evicting the least recently used tickets. */
  at: number;
  files: Record<string, string>;
}
type Stored = Record<string, TicketMarks>;

export const VIEWED_KEY = "harness.git.viewed";
export const MAX_TICKETS = 40;
export const MAX_FILES = 400;

/** FNV-1a, base 36. */
export function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
}

/** The parts of @pierre/diffs' FileDiffMetadata a fingerprint reads. */
export interface Fingerprinted {
  name: string;
  prevName?: string;
  type: string;
  mode?: string;
  prevMode?: string;
  hunks: { deletionStart: number; deletionCount: number; additionStart: number; additionCount: number }[];
  deletionLines: string[];
  additionLines: string[];
}

/** Identifies one version of a file's diff: its paths, change type, mode, hunk positions and lines. */
export function fingerprint(d: Fingerprinted) {
  const hunks = d.hunks.map((h) => `${h.deletionStart},${h.deletionCount},${h.additionStart},${h.additionCount}`).join(";");
  const parts = [d.name, d.prevName ?? "", d.type, d.prevMode ?? "", d.mode ?? "", hunks, d.deletionLines.join("\n"), "\u0000", d.additionLines.join("\n")];
  return `${hash(parts.join("\u0001"))}.${d.deletionLines.length}.${d.additionLines.length}`;
}

function readAll(store: () => Store): Stored {
  try {
    const raw = store().getItem(VIEWED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Stored) : {};
  } catch {
    return {};
  }
}

/** The files marked viewed on a ticket. Malformed entries are skipped. */
export function readViewed(ticket: string, store = local): Viewed {
  const files = readAll(store)[ticket]?.files;
  const out: Viewed = new Map();
  if (!files || typeof files !== "object" || Array.isArray(files)) return out;
  for (const [path, fp] of Object.entries(files)) if (typeof fp === "string") out.set(path, fp);
  return out;
}

/**
 * Replace a ticket's marks (an empty map removes the ticket). Keeps at most MAX_FILES marks for it and
 * MAX_TICKETS tickets overall, evicting the tickets written longest ago.
 */
export function saveViewed(ticket: string, viewed: Viewed, store = local, now = Date.now()) {
  const all = readAll(store);
  delete all[ticket];
  if (viewed.size) all[ticket] = { at: now, files: Object.fromEntries([...viewed].slice(-MAX_FILES)) };
  const keep = Object.entries(all)
    .filter(([, t]) => t && typeof t === "object" && typeof t.at === "number")
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TICKETS);
  try {
    store().setItem(VIEWED_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}

/**
 * Drop marks that no longer apply: files whose diff changed since they were viewed, and files that
 * aren't changed any more. `current` holds the fingerprint of every file in the parsed diff; `changed`
 * lists every changed path, which can be longer than `current` when the diff was truncated. Those
 * unparsed files keep their mark, since there's nothing to compare it with.
 */
export function prune(viewed: Viewed, current: ReadonlyMap<string, string>, changed: ReadonlySet<string>): Viewed {
  const out: Viewed = new Map();
  for (const [path, fp] of viewed) {
    const now = current.get(path);
    if (now === undefined ? changed.has(path) : now === fp) out.set(path, fp);
  }
  return out;
}

export const sameMarks = (a: Viewed, b: Viewed) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * Whether a file's diff is collapsed. Viewed files collapse, others don't, unless the disclosure arrow
 * was toggled this session for this same version of the diff.
 */
export function isCollapsed(viewed: boolean, toggle: { fp: string; collapsed: boolean } | undefined, fp: string) {
  return toggle && toggle.fp === fp ? toggle.collapsed : viewed;
}
