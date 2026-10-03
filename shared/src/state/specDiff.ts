// The Spec tab's Show changes, as rendered markdown: two revisions of a spec, parsed with
// parseBlocks/inlineTokens (markdown.ts), compared block by block and word by word. Clients render
// the result with their markdown primitives, so turning changes on keeps headings, lists, tables and
// code where they were, with added words marked green and removed ones red.
//
// The output is plain JSON (shared/fixtures/cases/specDiff.ts pins it for the iOS port, which must
// reproduce it exactly). The algorithm, step by step:
//
// 1. Sequences (blocks, list items, table rows, code lines, words) are aligned with `lcs`: the
//    common prefix and suffix are matched first, then a longest common subsequence of the middle
//    (table L[i][j] = LCS of a[i…] and b[j…]); walking from the front, equal elements match, else
//    the old element is deleted when L[i+1][j] >= L[i][j+1], otherwise the new one is added. So at a
//    tie, deletions come before additions. Blocks compare by JSON.stringify of the parsed Block,
//    items by JSON.stringify of the ListItem, rows by JSON.stringify of their cells.
// 2. Between two matches sits a gap of deleted and added elements. `pairGap` pairs them: for each
//    deleted element in order, the first added one (after the last pair) it may pair with is found;
//    added elements skipped over are emitted as added, then the pair. A deleted element with no
//    partner is emitted as deleted, and added ones left at the end as added.
// 3. What may pair: blocks of the same kind. Paragraphs and quotes need `similar` text, headings
//    the same level and similar text, lists the same kind (ul/ol), tables the same column count and
//    alignments, code blocks the same lang. Images and rules never pair (they're equal or not).
//    List items and table rows need similar text (a row's cells joined in order).
// 4. `similar` is the noise guard: the words (non-whitespace units, below) shared by an LCS, as a
//    Dice coefficient 2·common / (old words + new words), must be at least 0.4. Two empty texts are
//    similar; empty and non-empty aren't. Below that the old block shows removed and the new added.
// 5. A paired text becomes runs (`diffText`): each line's inline tokens split into units (a "\n"
//    unit between lines; text inside text/code/strong/em/link tokens splits into "\n", runs of other
//    whitespace, and runs of non-whitespace; ticket and img tokens stay whole), compared by their
//    style (t, url) and text with `lcs`. Then cleanup: a "same" stretch of only whitespace units with
//    a change on both sides becomes deleted + added, and within each stretch of changes the deleted
//    units move before the added ones. Last, neighbouring units with the same style and change merge
//    into one run (ticket and img runs never merge).
// 6. Paired lists diff their items (steps 1-3), and a paired item diffs its text into runs and its
//    nested lists as blocks, recursively. Paired tables diff the header cell by cell and the rows as
//    in steps 1-3; a paired row diffs cell by cell. Paired code blocks diff their lines.

import { inlineTokens, parseBlocks, type Align, type Block, type InlineToken, type ListItem } from "./markdown";

/** Whether a piece of the newer revision is in both, only in the newer one, or only in the older one. */
export type DiffChange = "same" | "add" | "del";

/** An inline token (markdown.ts) carrying its change. Text-bearing tokens may hold part of the original token's text. */
export type DiffRun = InlineToken & { change: DiffChange };

/** A line of a code block. */
export interface DiffCodeLine {
  change: DiffChange;
  text: string;
}

/**
 * A list item. Unchanged, added and removed items carry the parsed item as is; an edited one (its
 * text or its nested lists changed) carries its text as runs and its nested lists as diffed blocks.
 */
export type DiffItem =
  | { change: "same" | "add" | "del"; item: ListItem }
  | { change: "edit"; runs: DiffRun[]; children: DiffBlock[] };

/** A table body row: the cells as parsed, or (edited) each cell as runs. */
export type DiffRow = { change: "same" | "add" | "del"; cells: string[] } | { change: "edit"; cells: DiffRun[][] };

/** A block of the newer revision whose contents changed, shaped like the Block it renders as. Lists and ol `start` are the newer revision's. */
export type EditBlock =
  | { t: "p"; runs: DiffRun[] }
  | { t: "quote"; runs: DiffRun[] }
  | { t: "h"; level: number; runs: DiffRun[] }
  | { t: "ul"; items: DiffItem[] }
  | { t: "ol"; start: number; items: DiffItem[] }
  | { t: "code"; lang: string; lines: DiffCodeLine[] }
  | { t: "table"; align: Align[]; header: DiffRun[][]; rows: DiffRow[] };

/**
 * One block of the compared document, in reading order: unchanged ("same"), only in the newer
 * revision ("add"), only in the older one ("del"), or in both with changes ("edit").
 */
export type DiffBlock = { change: "same" | "add" | "del"; block: Block } | { change: "edit"; block: EditBlock };

/** The minimum Dice coefficient of shared words for two texts to be shown as one edited block. */
export const SIMILAR_THRESHOLD = 0.4;

type Op = { op: "same"; a: number; b: number } | { op: "del"; a: number } | { op: "add"; b: number };

/** Step 1: the edit script turning `a` into `b`, by key. */
function lcs<T>(a: readonly T[], b: readonly T[], key: (x: T) => string = String): Op[] {
  const ka = a.map(key);
  const kb = b.map(key);
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let suf = 0;
  while (suf < ka.length - pre && suf < kb.length - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++;
  const n = ka.length - pre - suf;
  const m = kb.length - pre - suf;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i]![j] = ka[pre + i] === kb[pre + j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ op: "same", a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[pre + i] === kb[pre + j]) {
      ops.push({ op: "same", a: pre + i, b: pre + j });
      i++;
      j++;
    } else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) ops.push({ op: "del", a: pre + i++ });
    else ops.push({ op: "add", b: pre + j++ });
  }
  for (let k = 0; k < suf; k++) ops.push({ op: "same", a: ka.length - suf + k, b: kb.length - suf + k });
  return ops;
}

type Out<A, B, R> = { kind: "same"; a: A; b: B } | { kind: "del"; a: A } | { kind: "add"; b: B } | { kind: "pair"; a: A; b: B; result: R };

/**
 * Steps 1-2: align `a` with `b`, pairing deleted and added elements in each gap when `pair` returns
 * a result for them (null: they can't pair).
 */
function align<T, R>(a: readonly T[], b: readonly T[], key: (x: T) => string, pair: (x: T, y: T) => R | null): Out<T, T, R>[] {
  const out: Out<T, T, R>[] = [];
  let dels: T[] = [];
  let adds: T[] = [];
  const flush = () => {
    let j = 0;
    for (const d of dels) {
      let found = -1;
      let result: R | null = null;
      for (let k = j; k < adds.length; k++) {
        result = pair(d, adds[k]!);
        if (result !== null) {
          found = k;
          break;
        }
      }
      if (found < 0) {
        out.push({ kind: "del", a: d });
        continue;
      }
      for (; j < found; j++) out.push({ kind: "add", b: adds[j]! });
      out.push({ kind: "pair", a: d, b: adds[found]!, result: result! });
      j = found + 1;
    }
    for (; j < adds.length; j++) out.push({ kind: "add", b: adds[j]! });
    dels = [];
    adds = [];
  };
  for (const op of lcs(a, b, key)) {
    if (op.op === "del") dels.push(a[op.a]!);
    else if (op.op === "add") adds.push(b[op.b]!);
    else {
      flush();
      out.push({ kind: "same", a: a[op.a]!, b: b[op.b]! });
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- words

/** A unit of inline text (step 5): one token, or a piece of a text-bearing one. */
type Unit = InlineToken;

const WHOLE = new Set(["ticket", "img"]);

function styleKey(t: InlineToken): string {
  return t.t === "link" ? `link ${t.url}` : t.t;
}

function unitKey(u: Unit): string {
  return WHOLE.has(u.t) ? JSON.stringify(u) : `${styleKey(u)}|${(u as { text: string }).text}`;
}

function isSpace(u: Unit): boolean {
  return !WHOLE.has(u.t) && /^\s+$/.test((u as { text: string }).text);
}

/** The units of a paragraph, heading, quote, item or cell: each line's tokens, "\n" between lines. */
function units(text: string): Unit[] {
  const out: Unit[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ t: "text", text: "\n" });
    for (const tok of inlineTokens(line)) {
      if (WHOLE.has(tok.t)) out.push(tok);
      else for (const piece of (tok as { text: string }).text.match(/\n|[^\S\n]+|\S+/g) ?? []) out.push({ ...tok, text: piece } as Unit);
    }
  });
  return out;
}

/** Step 4: whether two texts share enough words to show as one edited block. */
function similar(a: string, b: string): boolean {
  const ua = units(a).filter((x) => !isSpace(x));
  const ub = units(b).filter((x) => !isSpace(x));
  if (!ua.length && !ub.length) return true;
  const common = lcs(ua, ub, unitKey).filter((o) => o.op === "same").length;
  return (2 * common) / (ua.length + ub.length) >= SIMILAR_THRESHOLD;
}

function merge(list: DiffRun[]): DiffRun[] {
  const out: DiffRun[] = [];
  for (const r of list) {
    const prev = out[out.length - 1];
    if (prev && prev.change === r.change && !WHOLE.has(r.t) && !WHOLE.has(prev.t) && styleKey(prev) === styleKey(r))
      (prev as { text: string }).text += (r as { text: string }).text;
    else out.push({ ...r });
  }
  return out;
}

/** Step 5: a paired text as runs. */
export function diffText(a: string, b: string): DiffRun[] {
  const ua = units(a);
  const ub = units(b);
  let list: DiffRun[] = lcs(ua, ub, unitKey).map((o) =>
    o.op === "same" ? ({ ...ub[o.b]!, change: "same" } as DiffRun) : o.op === "del" ? ({ ...ua[o.a]!, change: "del" } as DiffRun) : ({ ...ub[o.b]!, change: "add" } as DiffRun),
  );
  // Whitespace-only "same" stretches between changes join the change.
  const spread: DiffRun[] = [];
  for (let i = 0; i < list.length; ) {
    let k = i;
    while (k < list.length && list[k]!.change === "same") k++;
    const stretch = list.slice(i, k);
    if (stretch.length && i > 0 && k < list.length && stretch.every(isSpace)) {
      for (const s of stretch) spread.push({ ...s, change: "del" }, { ...s, change: "add" });
    } else spread.push(...stretch);
    if (k < list.length) spread.push(list[k]!);
    i = k + 1;
  }
  // Within each stretch of changes, deletions first.
  list = [];
  for (let i = 0; i < spread.length; ) {
    if (spread[i]!.change === "same") {
      list.push(spread[i++]!);
      continue;
    }
    let k = i;
    while (k < spread.length && spread[k]!.change !== "same") k++;
    const stretch = spread.slice(i, k);
    list.push(...stretch.filter((r) => r.change === "del"), ...stretch.filter((r) => r.change === "add"));
    i = k;
  }
  return merge(list);
}

// ---------------------------------------------------------------- blocks

function diffItems(a: ListItem[], b: ListItem[]): DiffItem[] {
  return align(a, b, (x) => JSON.stringify(x), (x, y) => (similar(x.text, y.text) ? true : null)).map((o): DiffItem => {
    if (o.kind === "same") return { change: "same", item: o.b };
    if (o.kind === "del") return { change: "del", item: o.a };
    if (o.kind === "add") return { change: "add", item: o.b };
    return { change: "edit", runs: diffText(o.a.text, o.b.text), children: diffBlocks(o.a.children, o.b.children) };
  });
}

function diffRows(a: string[][], b: string[][]): DiffRow[] {
  return align(a, b, (x) => JSON.stringify(x), (x, y) => (similar(x.join(" "), y.join(" ")) ? true : null)).map((o): DiffRow => {
    if (o.kind === "same") return { change: "same", cells: o.b };
    if (o.kind === "del") return { change: "del", cells: o.a };
    if (o.kind === "add") return { change: "add", cells: o.b };
    return { change: "edit", cells: o.b.map((cell, k) => diffText(o.a[k] ?? "", cell)) };
  });
}

/** Step 3: an edited block for two differing blocks that may pair, else null. */
function pairBlocks(a: Block, b: Block): EditBlock | null {
  if ((a.t === "p" && b.t === "p") || (a.t === "quote" && b.t === "quote"))
    return similar(a.text, b.text) ? { t: b.t, runs: diffText(a.text, b.text) } : null;
  if (a.t === "h" && b.t === "h") return a.level === b.level && similar(a.text, b.text) ? { t: "h", level: b.level, runs: diffText(a.text, b.text) } : null;
  if (a.t === "ul" && b.t === "ul") return { t: "ul", items: diffItems(a.items, b.items) };
  if (a.t === "ol" && b.t === "ol") return { t: "ol", start: b.start, items: diffItems(a.items, b.items) };
  if (a.t === "code" && b.t === "code") {
    if (a.lang !== b.lang) return null;
    const la = a.text.split("\n");
    const lb = b.text.split("\n");
    const lines = lcs(la, lb).map((o): DiffCodeLine => (o.op === "add" ? { change: "add", text: lb[o.b]! } : o.op === "del" ? { change: "del", text: la[o.a]! } : { change: "same", text: lb[o.b]! }));
    return { t: "code", lang: b.lang, lines };
  }
  if (a.t === "table" && b.t === "table") {
    if (JSON.stringify(a.align) !== JSON.stringify(b.align)) return null;
    return { t: "table", align: b.align, header: b.header.map((cell, k) => diffText(a.header[k] ?? "", cell)), rows: diffRows(a.rows, b.rows) };
  }
  return null;
}

/** Steps 1-3 over two block lists. */
export function diffBlocks(a: Block[], b: Block[]): DiffBlock[] {
  return align(a, b, (x) => JSON.stringify(x), pairBlocks).map((o): DiffBlock => {
    if (o.kind === "same") return { change: "same", block: o.b };
    if (o.kind === "del") return { change: "del", block: o.a };
    if (o.kind === "add") return { change: "add", block: o.b };
    return { change: "edit", block: o.result };
  });
}

/** Compare two revisions of a spec (older first) for rendering with their changes marked. */
export function specDiff(before: string, after: string): DiffBlock[] {
  return diffBlocks(parseBlocks(before), parseBlocks(after));
}

/** True when the comparison found nothing changed. */
export function diffUnchanged(blocks: DiffBlock[]): boolean {
  return blocks.every((b) => b.change === "same");
}
