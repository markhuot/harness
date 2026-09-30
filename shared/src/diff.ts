// A unified diff line by line, for clients that draw diffs themselves (the phone's CodeBlock):
// what each line is (added, removed, context, hunk or file header), which file it belongs to, and
// that file's language. Fence aliases and diff detection live in state/code.ts.

import { codeLanguage } from "./state/code";

const FILE_NAMES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** The Shiki language for a file path, by its name or extension ("app/Foo.blade.php" → blade); null for none. */
export function langForPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (FILE_NAMES[name]) return FILE_NAMES[name]!;
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  if (name.endsWith(".blade.php")) return "blade";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return codeLanguage(name.slice(dot + 1));
}

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line as written, sign included */
  text: string;
  /** Which file section it belongs to (an index into DiffFile[]) */
  file: number;
}

export interface DiffFile {
  /** The new path (the old one for a deletion), without git's a/ b/ prefix; null when the diff names none */
  path: string | null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HEADER = /^(diff |index |new file|deleted file|similarity |dissimilarity |rename |copy |old mode|new mode|Binary files)/;

function headerPath(raw: string): string | null {
  const p = raw.replace(/\t.*$/, "").trim();
  if (!p || p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * Classify each line of a unified diff, as written (no headers added or counts fixed, unlike
 * normalizePatch). Hunk header counts decide whether a `--- `/`+++ ` line is a file header or a
 * removed/added line starting with dashes; once a hunk's counts run out (or a hunk has none, as
 * hand-written diffs often do), lines are judged by their first character.
 */
export function parseDiff(text: string): { lines: DiffLine[]; files: DiffFile[] } {
  const files: DiffFile[] = [];
  const lines: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let file = -1;
  /** A `diff --git` line started the current file, and its `--- `/`+++ ` pair hasn't come yet */
  let gitHeader = false;
  const src = text.replace(/\r\n/g, "\n").split("\n");
  const startFile = (path: string | null) => {
    files.push({ path });
    file = files.length - 1;
  };
  for (let i = 0; i < src.length; i++) {
    const l = src[i]!;
    const inHunk = oldLeft > 0 || newLeft > 0;
    const push = (kind: DiffLineKind) => lines.push({ kind, text: l, file: Math.max(file, 0) });
    if (!inHunk) {
      const git = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (git) {
        startFile(git[2]!);
        gitHeader = true;
        push("meta");
        continue;
      }
      if (l.startsWith("--- ") && src[i + 1]?.startsWith("+++ ")) {
        const path = headerPath(src[i + 1]!.slice(4)) ?? headerPath(l.slice(4));
        // A `diff --git` line already started this file; otherwise the header pair does.
        if (!gitHeader) startFile(path);
        else if (path) files[file]!.path = path;
        gitHeader = false;
        push("meta");
        lines.push({ kind: "meta", text: src[++i]!, file });
        continue;
      }
      if (HEADER.test(l) || l.startsWith("\\")) {
        push("meta");
        continue;
      }
    }
    const hunk = HUNK.exec(l);
    if (hunk || (!inHunk && l.startsWith("@@"))) {
      if (file < 0) startFile(null);
      gitHeader = false;
      oldLeft = hunk ? Number(hunk[2] ?? 1) : 0;
      newLeft = hunk ? Number(hunk[4] ?? 1) : 0;
      push("hunk");
      continue;
    }
    if (file < 0) startFile(null);
    const c = l[0];
    if (c === "+") {
      newLeft = Math.max(0, newLeft - 1);
      push("add");
    } else if (c === "-") {
      oldLeft = Math.max(0, oldLeft - 1);
      push("del");
    } else if (c === "\\") {
      push("meta");
    } else {
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
      push("ctx");
    }
  }
  if (!files.length) files.push({ path: null });
  return { lines, files };
}
