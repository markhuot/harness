// Markdown-ish rendering for agent summaries and transcript text: paragraphs, headings,
// bullet/numbered lists, fenced code, tables, inline code, bold/italic, links, ticket keys. Parsing is shared with the
// iOS app (@harness/shared/state "markdown"); this builds React DOM nodes directly (no innerHTML),
// so agent output can't inject markup.

import { Fragment, type ReactNode } from "react";
import { inlineTokens, parseBlocks, ticketByKey, ticketLinkable } from "@harness/shared/state";
import { useStore } from "../state/store";
import { useOpenTicket } from "./paneContext";

export { parseBlocks, plainText } from "@harness/shared/state";

/** How ticket keys (FOO-12) render: linked to the ticket when it can be opened, else plain text. */
export interface TicketLinks {
  /** The ticket's title for the tooltip ("" when it isn't loaded yet), or null to leave the key as text. */
  title: (key: string) => string | null;
  open: (key: string) => void;
}

export function inline(text: string, tickets?: TicketLinks, onLink?: (url: string) => void): ReactNode[] {
  return inlineTokens(text).map((tok, k) => {
    switch (tok.t) {
      case "text":
        return tok.text;
      case "ticket": {
        const title = tickets?.title(tok.key);
        if (title == null) return tok.key;
        return (
          <a
            key={k}
            href={`#${tok.key}`}
            data-ticket-key={tok.key}
            title={title || undefined}
            onClick={(e) => {
              e.preventDefault();
              tickets!.open(tok.key);
            }}
          >
            {tok.key}
          </a>
        );
      }
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

function withBreaks(text: string, tickets: TicketLinks) {
  const parts = text.split("\n");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {inline(p, tickets)}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}

/** Ticket keys link to the ticket (opening it the way a link in this pane does) when the store can resolve them. */
function useTicketLinks(): TicketLinks {
  const { state } = useStore();
  const openTicket = useOpenTicket();
  return { title: (key) => (ticketLinkable(state, key) ? (ticketByKey(state, key)?.title ?? "") : null), open: (key) => openTicket(key) };
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  const tickets = useTicketLinks();
  return (
    <div className={`md selectable ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{withBreaks(b.text, tickets)}</p>;
          case "h": {
            const H = `h${Math.min(b.level, 4)}` as "h1";
            return <H key={i}>{inline(b.text, tickets)}</H>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, tickets)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, tickets)}</li>
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
            return <blockquote key={i}>{withBreaks(b.text, tickets)}</blockquote>;
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((cell, j) => (
                        <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                          {inline(cell, tickets)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                            {inline(cell, tickets)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
