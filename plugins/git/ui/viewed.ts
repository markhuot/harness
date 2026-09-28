// "Viewed" marks on the Changes tab's diffs, like a GitHub PR review. A mark stores the file's diff
// fingerprint, so a file the agent changes again after you viewed it reads as unviewed. Marks live in
// localStorage (shared by every ticket's iframe on the service origin) under one key, bounded per
// ticket and in the number of tickets kept. Storage that's missing, throws, or holds garbage reads as
// "nothing viewed"; writes that fail are dropped.
import type { FileDiffMetadata } from "@pierre/diffs";

type Store = Pick<Storage, "getItem" | "setItem">;
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

const local = (): Store => localStorage;

/** FNV-1a, base 36. */
export function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
}

type Fingerprinted = Pick<FileDiffMetadata, "name" | "prevName" | "type" | "mode" | "prevMode" | "hunks" | "deletionLines" | "additionLines">;

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
