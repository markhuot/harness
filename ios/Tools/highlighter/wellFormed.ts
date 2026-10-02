// diffLines splits a code line's sign off with text.slice(0, 1), a UTF-16 code unit. A context line
// that starts with an astral character (an emoji) then ends its sign span on a lone high surrogate,
// which Swift strings can't hold and JSONDecoder rejects. Before handing lines to Swift, move such a
// surrogate into the next span, so the sign is "" and the character stays whole. Nothing else changes.

import type { Highlighted, HighlightedLine } from "./highlight";

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function wellFormedLines(lines: HighlightedLine[]): HighlightedLine[] {
  return lines.map((line) => {
    const spans = line.spans;
    let fixed: typeof spans | null = null;
    for (let i = 0; i + 1 < spans.length; i++) {
      const a = (fixed ?? spans)[i]!;
      const b = (fixed ?? spans)[i + 1]!;
      if (!a.text || !b.text || !isHigh(a.text.charCodeAt(a.text.length - 1)) || !isLow(b.text.charCodeAt(0))) continue;
      fixed ??= spans.map((s) => ({ ...s }));
      fixed[i] = { ...a, text: a.text.slice(0, -1) };
      fixed[i + 1] = { ...b, text: a.text.slice(-1) + b.text };
    }
    return fixed ? { ...line, spans: fixed } : line;
  });
}

export function wellFormed(h: Highlighted | null): Highlighted | null {
  return h && { ...h, lines: wellFormedLines(h.lines) };
}
