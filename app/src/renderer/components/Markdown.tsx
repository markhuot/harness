// Markdown-ish rendering for agent summaries and transcript text: paragraphs, headings,
// bullet/numbered lists, fenced code, inline code, bold/italic, links. Builds React nodes
// directly (no innerHTML), so agent output can't inject markup.

import { Fragment, type ReactNode } from "react";

type Block =
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

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;

export function inline(text: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const link = (url: string, label: ReactNode) => (
    <a
      key={k++}
      href={url}
      onClick={(e) => {
        e.preventDefault();
        onLink ? onLink(url) : void window.harness?.openExternal(url);
      }}
    >
      {label}
    </a>
  );
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const s = m[0];
    if (m[1]) out.push(<code key={k++}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{s.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{s.slice(1, -1)}</em>);
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      out.push(/^https?:/.test(mm[2]!) ? link(mm[2]!, mm[1]) : mm[1]);
    } else if (m[5]) out.push(link(s, s));
    last = idx + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string) {
  const parts = text.split("\n");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {inline(p)}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md selectable ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{withBreaks(b.text)}</p>;
          case "h": {
            const H = `h${Math.min(b.level, 4)}` as "h1";
            return <H key={i}>{inline(b.text)}</H>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={i}>{withBreaks(b.text)}</blockquote>;
          case "hr":
            return <hr key={i} />;
        }
      })}
    </div>
  );
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
