// Markdown-ish rendering for agent summaries and transcript text: paragraphs, headings,
// bullet/numbered lists, fenced code, inline code, bold/italic, links. Parsing is shared with the
// iOS app (@harness/shared/state "markdown"); this builds React DOM nodes directly (no innerHTML),
// so agent output can't inject markup.

import { Fragment, type ReactNode } from "react";
import { inlineTokens, parseBlocks } from "@harness/shared/state";

export { parseBlocks, plainText } from "@harness/shared/state";

export function inline(text: string, onLink?: (url: string) => void): ReactNode[] {
  return inlineTokens(text).map((tok, k) => {
    switch (tok.t) {
      case "text":
        return tok.text;
      case "code":
        return <code key={k}>{tok.text}</code>;
      case "strong":
        return <strong key={k}>{tok.text}</strong>;
      case "em":
        return <em key={k}>{tok.text}</em>;
      case "link":
        return (
          <a
            key={k}
            href={tok.url}
            onClick={(e) => {
              e.preventDefault();
              onLink ? onLink(tok.url) : void window.harness?.openExternal(tok.url);
            }}
          >
            {tok.text}
          </a>
        );
    }
  });
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
