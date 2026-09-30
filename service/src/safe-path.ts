// Confining a caller-supplied path to a folder: plugin static UIs, and the file viewer's reads of
// project and ticket files.

import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Resolve `rel` inside `root`, refusing anything that escapes it (.., absolute paths, symlinks out). */
export function safeJoin(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === "..")) return null;
  const target = resolve(root, ...segments);
  if (!inside(target, root)) return null;
  if (!existsSync(target)) return target; // caller 404s; nothing to follow
  try {
    const realRoot = realpathSync(root);
    if (!inside(realpathSync(target), realRoot)) return null;
  } catch {
    return null;
  }
  return target;
}

/** `p` is `root` or somewhere under it (plain string check; resolve both first). */
export function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}
