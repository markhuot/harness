// Spec text helpers (DESIGN.md "Spec revisions and attachments"): read_spec's numbered lines,
// edit_spec's edits, the unified diff between two revisions, and the local images in spec
// markdown that become ticket attachments. Pure functions over strings; the orchestrator does
// the storing.

/** One edit_spec edit: exact text, like Claude Code's Edit tool. */
export interface StringEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * One edit_spec edit by line numbers of the base revision (1-based, inclusive). end_line =
 * start_line - 1 inserts before start_line without replacing anything. `expected`, when given,
 * must equal those lines' text.
 */
export interface LineEdit {
  start_line: number;
  end_line: number;
  new_text: string;
  expected?: string;
}

export type SpecEdit = StringEdit | LineEdit;

/** An edit that can't apply; nothing in its batch was applied. */
export class SpecEditError extends Error {}

/** The spec's lines, numbered like Claude Code's Read (`cat -n`): right-aligned number, tab, text. */
export function numberLines(body: string): string {
  const lines = body.split("\n");
  const width = Math.max(4, String(lines.length).length);
  return lines.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join("\n");
}

/** Lines of new_text: one trailing newline is the end of its last line, not an empty line. */
function textLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

interface WorkLine {
  text: string;
  /** Its line number in the base revision; null once an earlier edit in the batch wrote it */
  origin: number | null;
}

const isLineEdit = (e: unknown): e is LineEdit => !!e && typeof e === "object" && "start_line" in e;

/**
 * Apply `edits` in order to `body` (the base revision `rev`), all or nothing: the first edit that
 * can't apply throws SpecEditError and the batch is dropped. Line edits name lines of the base
 * revision, so an earlier edit in the same call doesn't shift them; one that touches lines an
 * earlier edit already rewrote is refused.
 */
export function applySpecEdits(body: string, edits: unknown, rev: number): string {
  if (!Array.isArray(edits) || edits.length === 0) throw new SpecEditError("edits must be a non-empty list");
  const at = `the spec is at revision ${rev}`;
  let lines: WorkLine[] = body.split("\n").map((text, i) => ({ text, origin: i + 1 }));
  const baseCount = lines.length;
  edits.forEach((edit, n) => {
    const which = `Edit ${n + 1}`;
    if (isLineEdit(edit)) {
      const { start_line: s, end_line: e, new_text, expected } = edit;
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s - 1 || e > baseCount || s > baseCount + 1) {
        throw new SpecEditError(`${which}: lines ${s}-${e} aren't in revision ${rev}, which has ${baseCount} lines (${at}; read_spec shows them)`);
      }
      if (typeof new_text !== "string") throw new SpecEditError(`${which}: new_text must be a string`);
      let from: number;
      let count: number;
      if (e === s - 1) {
        // Insert before base line s (or at the end): next to a line no earlier edit rewrote.
        const anchor = s <= baseCount ? lines.findIndex((l) => l.origin === s) : lines.findIndex((l) => l.origin === baseCount) + 1;
        if (anchor < 0 || (s > baseCount && anchor === 0)) {
          throw new SpecEditError(`${which}: line ${s} was already changed by an earlier edit in this call (${at})`);
        }
        from = anchor;
        count = 0;
      } else {
        from = lines.findIndex((l) => l.origin === s);
        const to = lines.findIndex((l) => l.origin === e);
        if (from < 0 || to < 0 || to - from !== e - s) {
          throw new SpecEditError(`${which}: lines ${s}-${e} overlap an earlier edit in this call; give each edit its own lines (${at})`);
        }
        count = e - s + 1;
        if (expected !== undefined) {
          const actual = lines
            .slice(from, from + count)
            .map((l) => l.text)
            .join("\n");
          if (actual !== (expected.endsWith("\n") ? expected.slice(0, -1) : expected)) {
            throw new SpecEditError(`${which}: lines ${s}-${e} don't match expected (${at}). They read:\n${actual}`);
          }
        }
      }
      lines.splice(from, count, ...textLines(new_text).map((text) => ({ text, origin: null })));
      return;
    }
    if (!edit || typeof edit !== "object" || typeof (edit as StringEdit).old_string !== "string" || typeof (edit as StringEdit).new_string !== "string") {
      throw new SpecEditError(`${which}: give either { old_string, new_string, replace_all? } or { start_line, end_line, new_text, expected? }`);
    }
    const { old_string, new_string, replace_all } = edit as StringEdit;
    if (old_string === "") throw new SpecEditError(`${which}: old_string is empty; use a line edit to insert text`);
    if (old_string === new_string) throw new SpecEditError(`${which}: old_string and new_string are the same`);
    const text = lines.map((l) => l.text).join("\n");
    const hits: number[] = [];
    for (let i = text.indexOf(old_string); i >= 0; i = text.indexOf(old_string, i + old_string.length)) hits.push(i);
    if (hits.length === 0) throw new SpecEditError(`${which}: old_string wasn't found (${at}; read_spec shows it)`);
    if (hits.length > 1 && !replace_all) {
      throw new SpecEditError(`${which}: old_string appears ${hits.length} times (${at}). Add surrounding text to make it unique, or pass replace_all`);
    }
    // The lines the matches span are rewritten (they lose their base line numbers); others keep them.
    const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1;
    const startLine = lineOf(hits[0]!);
    const endLine = lineOf(hits.at(-1)! + old_string.length);
    const spanStart = lines.slice(0, startLine).reduce((sum, l) => sum + l.text.length + 1, 0);
    const span = lines
      .slice(startLine, endLine + 1)
      .map((l) => l.text)
      .join("\n");
    const at0 = hits[0]! - spanStart;
    const replaced = replace_all ? span.split(old_string).join(new_string) : span.slice(0, at0) + new_string + span.slice(at0 + old_string.length);
    lines = [...lines.slice(0, startLine), ...replaced.split("\n").map((t) => ({ text: t, origin: null })), ...lines.slice(endLine + 1)];
  });
  return lines.map((l) => l.text).join("\n");
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

type Op = { kind: "ctx" | "del" | "add"; text: string };

/** Line operations turning `a` into `b` (longest common subsequence; specs are small). */
function diffOps(a: string[], b: string[]): Op[] {
  // Trim the common head and tail first: most revisions change a few lines in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const mid: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      mid.push({ kind: "ctx", text: x[i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      mid.push({ kind: "add", text: y[j++]! });
    } else {
      mid.push({ kind: "del", text: x[i++]! });
    }
  }
  // Deletions before additions within each changed run, as git prints them.
  const ordered: Op[] = [];
  for (let k = 0; k < mid.length; ) {
    if (mid[k]!.kind === "ctx") {
      ordered.push(mid[k++]!);
      continue;
    }
    const run: Op[] = [];
    while (k < mid.length && mid[k]!.kind !== "ctx") run.push(mid[k++]!);
    ordered.push(...run.filter((o) => o.kind === "del"), ...run.filter((o) => o.kind === "add"));
  }
  return [...a.slice(0, head).map((text) => ({ kind: "ctx" as const, text })), ...ordered, ...a.slice(a.length - tail).map((text) => ({ kind: "ctx" as const, text }))];
}

const SIGN = { ctx: " ", del: "-", add: "+" } as const;

/**
 * A unified diff from `before` to `after` (with `context` lines around each change), headed
 * `--- <fromLabel>` / `+++ <toLabel>`; "" when they're equal. shared/src/diff.ts parseDiff and
 * HarnessKit's Diff.swift read it.
 */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string, context = 3): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = diffOps(a, b);
  const changed = ops.map((o, i) => (o.kind !== "ctx" ? i : -1)).filter((i) => i >= 0);
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  // Line numbers where each op sits in `a` and `b`.
  const posA: number[] = [];
  const posB: number[] = [];
  let la = 1;
  let lb = 1;
  for (const o of ops) {
    posA.push(la);
    posB.push(lb);
    if (o.kind !== "add") la++;
    if (o.kind !== "del") lb++;
  }
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const oldCount = slice.filter((o) => o.kind !== "add").length;
    const newCount = slice.filter((o) => o.kind !== "del").length;
    // An empty side starts at the line before (git's convention: -0,0 for a file that was empty).
    const oldStart = oldCount ? posA[s]! : posA[s]! - 1;
    const newStart = newCount ? posB[s]! : posB[s]! - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) out.push(SIGN[o.kind] + o.text);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** `![alt](src)` and `![alt](src "title")`, with an optional <angle-bracketed> src. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;

/** A src the spec keeps as written: an attachment already, or a link off the machine. */
function keepsSrc(src: string): boolean {
  return /^(attachment:|https?:|data:|mailto:)/i.test(src);
}

/** The local files spec markdown points at (in order, each once), as written. */
export function localImageSources(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(IMAGE)) {
    const src = unwrap(m[2]!);
    if (!keepsSrc(src) && !out.includes(src)) out.push(src);
  }
  return out;
}

const unwrap = (src: string) => (src.startsWith("<") && src.endsWith(">") ? src.slice(1, -1) : src);

/** Every local image src replaced by `attachment:<id>` (srcs missing from `ids` are left as they are). */
export function rewriteImageSources(body: string, ids: ReadonlyMap<string, string>): string {
  return body.replace(IMAGE, (whole, alt: string, rawSrc: string, title: string | undefined) => {
    const id = ids.get(unwrap(rawSrc));
    return id ? `![${alt}](attachment:${id}${title ?? ""})` : whole;
  });
}
