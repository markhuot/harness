// Markdown-ish parsing for agent summaries and transcript text: paragraphs, headings, bullet /
// numbered lists, fenced code, quotes, rules, and inline code / bold / italic / links. Pure: each
// client renders the blocks and tokens with its own primitives (DOM on desktop, <Text> on iOS), so
// agent output can never inject markup.

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" };

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
  | { t: "link"; text: string; url: string };

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;

/** Inline markup of one line. Links are only produced for http(s) URLs; other [label](x) keep the label. */
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
      out.push(/^https?:/.test(mm[2]!) ? { t: "link", text: mm[1]!, url: mm[2]! } : { t: "text", text: mm[1]! });
    } else if (m[5]) out.push({ t: "link", text: s, url: s });
    last = idx + s.length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** Plain-text preview of markdown for card snippets. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
}
