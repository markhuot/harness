// The editor's rules that need no DOM: which lines a reveal marks, which a selection covers, how
// many lines a file may have and still be highlighted, and the saved baseline behind the dirty flag.

/** A 1-based, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** A position as the editor reports it: zero-based line and character. */
interface Pos {
  line: number;
  character: number;
}

/**
 * Past this many lines a file opens as plain text: highlighting costs about 0.12 ms a line on the
 * main thread, so a 10,000-line file takes over a second to open and a 40,000-line one several.
 */
export const MAX_HIGHLIGHT_LINES = 10_000;

/** How many lines the text has: every kind of line break counts, a lone CR too. */
export function countLines(text: string): number {
  let n = 1;
  for (const _ of text.matchAll(/\r\n|\r|\n/g)) n++;
  return n;
}

/** `lines` is how many the document has (at least 1). Non-finite or out-of-range ends are pulled in. */
export function clampRange(range: LineRange, lines: number): LineRange {
  const first = Number.isFinite(range.start) ? Math.floor(range.start) : 1;
  const last = Number.isFinite(range.end) ? Math.floor(range.end) : first;
  const start = Math.min(Math.max(1, first), lines);
  const end = Math.min(Math.max(start, last), lines);
  return { start, end };
}

/** The lines a selection covers, or null for a caret (nothing selected). */
export function selectionLines(sel: { start: Pos; end: Pos } | undefined): LineRange | null {
  if (!sel) return null;
  if (sel.start.line === sel.end.line && sel.start.character === sel.end.character) return null;
  return { start: sel.start.line + 1, end: sel.end.line + 1 };
}

/** The offset of a position in the text (a line break counts for its own length). */
export function offsetOf(text: string, pos: Pos): number {
  let offset = 0;
  let line = 0;
  const re = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  while (line < pos.line && (m = re.exec(text))) {
    line++;
    offset = m.index + m[0].length;
  }
  return Math.min(offset + pos.character, text.length);
}

/** The position (zero-based line and character) of an offset in the text. */
export function positionOf(text: string, offset: number): Pos {
  const at = Math.min(Math.max(0, offset), text.length);
  let line = 0;
  let start = 0;
  const re = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index + m[0].length <= at) {
    line++;
    start = m.index + m[0].length;
  }
  return { line, character: at - start };
}

/** What's on disk, and whether the document has moved off it. */
export function createBaseline(saved: string, initiallyDirty = false) {
  let baseline = saved;
  let dirty = initiallyDirty;
  return {
    get saved() {
      return baseline;
    },
    get dirty() {
      return dirty;
    },
    /** The document is `text` now: true when that flipped the dirty flag. */
    check(text: string): boolean {
      const now = text !== baseline;
      if (now === dirty) return false;
      dirty = now;
      return true;
    },
    /** `text` is what's on disk now (what the last save handed out). Stays dirty if the document has moved on. */
    mark(text: string, current: string): boolean {
      baseline = text;
      return this.check(current);
    },
  };
}
