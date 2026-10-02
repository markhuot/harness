// Markdown-ish parsing for agent summaries and transcript text: paragraphs, headings, bullet /
// numbered lists, fenced code, quotes, rules, GFM pipe tables, and inline code / bold / italic / links. Pure: each
// client renders the blocks and tokens with its own primitives (DOM on desktop, <Text> on iOS), so
// agent output can never inject markup.

import { parseFileLink } from "../fileLinks";

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { t: "hr" };

export type Align = "left" | "center" | "right" | null;

/** Cells of one GFM table row. `\|` is a literal pipe, and so is a pipe inside a `code span`. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let tick = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      tick = !tick;
      cell += ch;
    } else if (ch === "|" && !tick) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const DELIM_CELL = /^:?-+:?$/;

/** The `| --- | :-: |` row under a table header: its alignments, or null when the line isn't one. */
function delimiterRow(line: string): Align[] | null {
  if (!line.includes("|") || !/-/.test(line)) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const align = line.includes("|") && i + 1 < lines.length ? delimiterRow(lines[i + 1]!) : null;
    const header = align && splitRow(line);
    if (align && header && header.length === align.length) {
      flush();
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) {
        const cells = splitRow(lines[++i]!);
        rows.push(header.map((_, k) => cells[k] ?? ""));
      }
      blocks.push({ t: "table", align, header, rows });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const items = [li[2]!];
      while (i + 1 < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (next && /\d/.test(next[1]!) === ordered) {
          items.push(next[2]!);
          i++;
        } else if (lines[i + 1]!.match(/^\s{2,}\S/) && items.length) {
          items[items.length - 1] += " " + lines[++i]!.trim();
        } else break;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      const q = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1]!.startsWith(">")) q.push(lines[++i]!.replace(/^>\s?/, ""));
      blocks.push({ t: "quote", text: q.join("\n") });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export type InlineToken =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; text: string }
  | { t: "em"; text: string }
  | { t: "link"; text: string; url: string }
  | { t: "ticket"; key: string; text?: string };

/** A ticket key, as a whole string: the bare-word pattern INLINE uses, anchored. */
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)|(\b[A-Z][A-Z0-9]*-\d+\b)/g;

/**
 * Inline markup of one line. [label](x) is a link when x is http(s) or a file link (`harness://file/…`,
 * or a path with no scheme; see parseFileLink); other targets (javascript:, data:, anchors) keep only
 * the label. Bare URLs are autolinked only for http(s).
 * An UPPERCASE-NN word is a "ticket" token; renderers link it only when it names a ticket they
 * can open (ticketLinkable), so "UTF-8" or "SHA-256" stay plain text.
 * [label](KEY), whose target is a whole ticket key (`[RFAWC-726](RFACOM-2)`: a remote ID labelling
 * the local ticket), is a "ticket" token for KEY carrying the label as `text`; renderers show the
 * label, linked to KEY when it's linkable and plain otherwise. Bare keys have no `text`.
 */
export function inlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: "text", text: text.slice(last, idx) });
    const s = m[0];
    if (m[1]) out.push({ t: "code", text: s.slice(1, -1) });
    else if (m[2]) out.push({ t: "strong", text: s.slice(2, -2) });
    else if (m[3]) out.push({ t: "em", text: s.slice(1, -1) });
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      const [, label, url] = mm as unknown as [string, string, string];
      if (TICKET_KEY.test(url)) out.push({ t: "ticket", key: url, text: label });
      else out.push(/^https?:/.test(url) || parseFileLink(url) ? { t: "link", text: label, url } : { t: "text", text: label });
    } else if (m[5]) out.push({ t: "link", text: s, url: s });
    else if (m[6]) out.push({ t: "ticket", key: s });
    last = idx + s.length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** Plain-text preview of markdown for card snippets. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^.*$/gm, (line) => (delimiterRow(line) ? "" : /^\s*\|.*\|\s*$/.test(line) ? splitRow(line).join(" · ") : line))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
}
