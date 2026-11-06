// Markdown as plain HTML for the clipboard: what the Spec tab's "Copy spec" puts beside the raw
// markdown, so a paste into a rich editor (Mail, Docs, Notes) keeps headings, lists, tables and
// emphasis while "Paste and Match Style" gets the markdown. Built from the same parse the renderers
// use (parseBlocks / inlineTokens), with every piece of text escaped, so the output carries no markup
// the source didn't ask for. The iOS app has a port: HarnessKit's Markdown.html.
//
// What only Harness can show becomes text: an attachment is its alt text in italics (its URL needs
// the service and a token), a ticket key is its label, a file link (`harness://file/…`) is its label;
// only http(s) links stay links. A task item or question leads with ☐ (open) or ☑ (done).

import { inlineTokens, parseBlocks, type Block, type ListItem } from "./markdown";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** One line of inline markup. */
function inline(text: string): string {
  return inlineTokens(text)
    .map((tok) => {
      switch (tok.t) {
        case "text":
          return escapeHtml(tok.text);
        case "code":
          return `<code>${escapeHtml(tok.text)}</code>`;
        case "strong":
          return `<strong>${escapeHtml(tok.text)}</strong>`;
        case "em":
          return `<em>${escapeHtml(tok.text)}</em>`;
        case "link":
          return /^https?:/.test(tok.url) ? `<a href="${escapeHtml(tok.url)}">${escapeHtml(tok.text)}</a>` : escapeHtml(tok.text);
        case "ticket":
          return escapeHtml(tok.text ?? tok.key);
        case "img":
          return tok.alt ? `<em>${escapeHtml(tok.alt)}</em>` : "";
      }
    })
    .join("");
}

/** Text whose lines each read as inline markup, kept on their own lines. */
const lines = (text: string) => text.split("\n").map(inline).join("<br>");

function item(it: ListItem): string {
  const box = it.checked === undefined ? "" : it.checked ? "☑ " : "☐ ";
  return `<li>${box}${lines(it.text)}${blocks(it.children)}</li>`;
}

function block(b: Block): string {
  switch (b.t) {
    case "p":
      return `<p>${lines(b.text)}</p>`;
    case "h":
      return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
    case "ul":
      return `<ul>${b.items.map(item).join("")}</ul>`;
    case "ol":
      return `<ol${b.start === 1 ? "" : ` start="${b.start}"`}>${b.items.map(item).join("")}</ol>`;
    case "code":
      return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    case "quote":
      return `<blockquote><p>${lines(b.text)}</p></blockquote>`;
    case "hr":
      return "<hr>";
    case "table": {
      const cell = (tag: "th" | "td", text: string, k: number) => {
        const align = b.align[k];
        return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inline(text)}</${tag}>`;
      };
      const head = `<thead><tr>${b.header.map((h, k) => cell("th", h, k)).join("")}</tr></thead>`;
      const body = b.rows.length ? `<tbody>${b.rows.map((r) => `<tr>${r.map((c, k) => cell("td", c, k)).join("")}</tr>`).join("")}</tbody>` : "";
      return `<table>${head}${body}</table>`;
    }
    case "img":
      return b.alt ? `<p><em>${escapeHtml(b.alt)}</em></p>` : "";
    case "thumbs": {
      const alts = b.items.map((m) => m.alt).filter(Boolean);
      return alts.length ? `<p>${alts.map((a) => `<em>${escapeHtml(a)}</em>`).join(" ")}</p>` : "";
    }
  }
}

function blocks(list: Block[]): string {
  return list.map(block).join("");
}

/** `md` as an HTML fragment (no <html> or <body>), for the clipboard's text/html. */
export function markdownToHtml(md: string): string {
  return blocks(parseBlocks(md));
}
