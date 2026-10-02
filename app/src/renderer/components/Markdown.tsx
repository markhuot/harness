// Markdown-ish rendering for agent summaries and transcript text: paragraphs, headings,
// bullet/numbered lists, fenced code (syntax highlighted, Code.tsx), tables, inline code, bold/italic, links, ticket keys. Parsing is shared with the
// iOS app (@harness/shared/state "markdown"); this builds React DOM nodes directly (no innerHTML),
// so agent output can't inject markup.
//
// Links to files (harness://file/…, or a plain path; shared/src/fileLinks.ts) open the file pane.
// Their path resolves in the ticket or project the text belongs to, which the view provides with
// FileLinkScope; from inside a pane the file docks beside it. http(s) links open in the browser.

import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { parseFileLink } from "@harness/shared";
import { inlineTokens, parseBlocks, ticketByKey, ticketLinkable } from "@harness/shared/state";
import type { FileLinkContext } from "../state/fileOpen";
import { useOptionalStore } from "../state/store";
import { FencedCode } from "./Code";
import { Icon } from "./Icon";
import { PaneContext, PaneScopeContext, useOpenTicket } from "./paneContext";

export { parseBlocks, plainText } from "@harness/shared/state";

/** How ticket keys (FOO-12) render: linked to the ticket when it can be opened, else plain text. */
export interface TicketLinks {
  /** The ticket's title for the tooltip ("" when it isn't loaded yet), or null to leave the key as text. */
  title: (key: string) => string | null;
  open: (key: string) => void;
}

const FileLinkScopeContext = createContext<FileLinkContext>({});

/** Where file links in the Markdown below resolve: the ticket (and project) whose text it is. */
export function FileLinkScope({ ticketKey, projectId, children }: FileLinkContext & { children: ReactNode }) {
  const value = useMemo(() => ({ ticketKey, projectId }), [ticketKey, projectId]);
  return <FileLinkScopeContext.Provider value={value}>{children}</FileLinkScopeContext.Provider>;
}

function MdLink({ url, children }: { url: string; children: ReactNode }) {
  const file = useMemo(() => parseFileLink(url), [url]);
  const store = useOptionalStore();
  const ctx = useContext(FileLinkScopeContext);
  const pane = useContext(PaneContext);
  const scope = useContext(PaneScopeContext);
  if (!file) {
    return (
      <a
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void window.harness?.openExternal(url);
        }}
      >
        {children}
      </a>
    );
  }
  const where = file.ticketKey ?? ctx.ticketKey;
  const lines = file.startLine ? (file.endLine ? `, lines ${file.startLine}–${file.endLine}` : `, line ${file.startLine}`) : "";
  return (
    <a
      href={url}
      className="file-link"
      data-testid="file-link"
      title={`Open ${file.path}${lines}${where ? ` (${where})` : ""}`}
      onClick={(e) => {
        e.preventDefault();
        store?.openFile(file, { ...ctx, paneId: pane?.paneId ?? null, scope: pane ? scope : null });
      }}
    >
      <Icon name="fileText" size={12} className="file-link-icon" />
      {children}
    </a>
  );
}

export function inline(text: string, tickets?: TicketLinks, onLink?: (url: string) => void): ReactNode[] {
  return inlineTokens(text).map((tok, k) => {
    switch (tok.t) {
      case "text":
        return tok.text;
      case "ticket": {
        const title = tickets?.title(tok.key);
        const label = tok.text ?? tok.key;
        if (title == null) return label;
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
            {label}
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
        if (!onLink) return <MdLink key={k} url={tok.url}>{tok.text}</MdLink>;
        return (
          <a
            key={k}
            href={tok.url}
            onClick={(e) => {
              e.preventDefault();
              onLink(tok.url);
            }}
          >
            {tok.text}
          </a>
        );
    }
  });
}

function withBreaks(text: string, tickets?: TicketLinks) {
  const parts = text.split("\n");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {inline(p, tickets)}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}

/**
 * Ticket keys link to the ticket (opening it the way a link in this pane does) when the store can
 * resolve them. Without a store (Markdown rendered on its own) they stay text.
 */
function useTicketLinks(): TicketLinks | undefined {
  const store = useOptionalStore();
  const openTicket = useOpenTicket();
  if (!store) return undefined;
  const { state } = store;
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
            return <FencedCode key={i} text={b.text} lang={b.lang} />;
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
