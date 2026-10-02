// Markdown-ish parsing for agent summaries and transcript text: paragraphs, headings, nested bullet /
// numbered lists, fenced code, quotes, rules, GFM pipe tables, attachment images and videos, and
// inline code / bold / italic / links / images. Pure: each
// client renders the blocks and tokens with its own primitives (DOM on desktop, <Text> on iOS), so
// agent output can never inject markup.

import { parseFileLink } from "../fileLinks";

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul"; items: ListItem[] }
  /** `start` is the first item's number ("3." starts at 3). */
  | { t: "ol"; start: number; items: ListItem[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { t: "hr" }
  /** An `![alt](attachment:<id>)` alone on its line. */
  | ({ t: "img" } & Media);

/** A list item: its text (continuation lines joined with spaces) and the lists nested under it. */
export interface ListItem {
  text: string;
  children: Block[];
}

/**
 * An attachment shown inline. `video` comes from a .mp4/.webm/.mov id or alt text; renderers that
 * know the attachment's kind may use that instead.
 */
export interface Media {
  alt: string;
  id: string;
  video: boolean;
}

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

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/** Columns of a line's leading whitespace: a tab counts as 4, any other `\s` character as 1. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of /^\s*/.exec(line)![0]) n += ch === "\t" ? 4 : 1;
  return n;
}

/**
 * The list whose first item is `lines[start]`, and the index of its last line. An item indented 2+
 * columns past this list's marker starts a list nested under the item before it; one indented
 * less than `outer` (the parent's marker + 2, 0 at the top) belongs to the parent. A sibling of the
 * other kind (bullet vs number) ends the list. A non-item line indented 2+ past the marker (2+ at
 * the top) continues the last item's text; anything else, a blank line included, ends the list.
 */
function parseList(lines: string[], start: number, outer: number): { block: Block; end: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = indentOf(lines[start]!);
  const ordered = /\d/.test(first[1]!);
  const items: ListItem[] = [{ text: first[2]!, children: [] }];
  const last = () => items[items.length - 1]!;
  let i = start;
  while (i + 1 < lines.length) {
    const line = lines[i + 1]!;
    const at = indentOf(line);
    const li = LIST_ITEM.exec(line);
    if (li && at >= indent + 2) {
      const sub = parseList(lines, i + 1, indent + 2);
      last().children.push(sub.block);
      i = sub.end;
    } else if (li) {
      if (at < outer || /\d/.test(li[1]!) !== ordered) break;
      items.push({ text: li[2]!, children: [] });
      i++;
    } else if (line.trim() && at >= (outer ? indent + 2 : 2)) {
      last().text += " " + line.trim();
      i++;
    } else break;
  }
  if (!ordered) return { block: { t: "ul", items }, end: i };
  // Past 9 digits the number isn't exact everywhere; start those at 1.
  const digits = first[1]!.slice(0, -1);
  return { block: { t: "ol", start: digits.length <= 9 ? Number(digits) : 1, items }, end: i };
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
    const img = IMAGE_LINE.exec(line);
    const media = img && image(img[1]!, img[2]!);
    if (media?.t === "img") {
      flush();
      blocks.push(media);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const list = parseList(lines, i, 0);
      blocks.push(list.block);
      i = list.end;
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
  | { t: "ticket"; key: string; text?: string }
  | ({ t: "img" } & Media);

/** A ticket key, as a whole string: the bare-word pattern INLINE uses, anchored. */
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)|(\b[A-Z][A-Z0-9]*-\d+\b)|(!\[[^\]]*\]\([^)\s]+\))/g;

// Starts with a letter or digit, so `attachment:..` can't become `/attachments/..` (the service root, token attached).
const ATTACHMENT_SRC = /^attachment:([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const VIDEO_NAME = /\.(mp4|webm|mov)$/i;

/**
 * What `![alt](src)` may show. `attachment:<id>` is an image (or video) the service serves; http(s)
 * and file sources become a link labelled with the alt text (remote images are never fetched, so
 * agent text can't load tracking pixels), and anything else keeps only the alt text.
 */
function image(alt: string, src: string): InlineToken {
  const a = ATTACHMENT_SRC.exec(src);
  if (a) return { t: "img", alt, id: a[1]!, video: VIDEO_NAME.test(a[1]!) || VIDEO_NAME.test(alt) };
  if (/^https?:/.test(src) || parseFileLink(src)) return { t: "link", text: alt || src, url: src };
  return { t: "text", text: alt };
}

/**
 * Inline markup of one line. [label](x) is a link when x is http(s) or a file link (`harness://file/…`,
 * or a path with no scheme; see parseFileLink); other targets (javascript:, data:, anchors) keep only
 * the label. Bare URLs are autolinked only for http(s).
 * An UPPERCASE-NN word is a "ticket" token; renderers link it only when it names a ticket they
 * can open (ticketLinkable), so "UTF-8" or "SHA-256" stay plain text.
 * [label](KEY), whose target is a whole ticket key (`[RFAWC-726](RFACOM-2)`: a remote ID labelling
 * the local ticket), is a "ticket" token for KEY carrying the label as `text`; renderers show the
 * label, linked to KEY when it's linkable and plain otherwise. Bare keys have no `text`.
 * ![alt](src) is an "img" token for an attachment, else a link or text (see `image`).
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
    else if (m[7]) {
      const [, alt, src] = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(s) as unknown as [string, string, string];
      out.push(image(alt, src));
    }
    last = idx + s.length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/**
 * Every attachment in `blocks`, first appearance first, once per id: what a viewer steps through.
 * Paragraph and quote text goes line by line, as the renderers split it.
 */
export function mediaIn(blocks: Block[]): Media[] {
  const out = new Map<string, Media>();
  const add = (m: Media) => {
    if (!out.has(m.id)) out.set(m.id, { alt: m.alt, id: m.id, video: m.video });
  };
  const text = (s: string) => {
    for (const line of s.split("\n")) for (const tok of inlineTokens(line)) if (tok.t === "img") add(tok);
  };
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === "img") add(b);
      else if (b.t === "p" || b.t === "h" || b.t === "quote") text(b.text);
      else if (b.t === "ul" || b.t === "ol")
        for (const it of b.items) {
          text(it.text);
          walk(it.children);
        }
      else if (b.t === "table") for (const row of [b.header, ...b.rows]) row.forEach(text);
    }
  };
  walk(blocks);
  return [...out.values()];
}

/** Plain-text preview of markdown for card snippets. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^.*$/gm, (line) => (delimiterRow(line) ? "" : /^\s*\|.*\|\s*$/.test(line) ? splitRow(line).join(" · ") : line))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
}
