// Markdown-ish rendering for agent summaries and transcript text: paragraphs, headings,
// bullet/numbered lists, fenced code (syntax highlighted, Code.tsx), tables, inline code, bold/italic, links. Parsing is shared with the
// iOS app (@harness/shared/state "markdown"); this builds React DOM nodes directly (no innerHTML),
// so agent output can't inject markup.
//
// Links to files (harness://file/…, or a plain path; shared/src/fileLinks.ts) open the file pane.
// Their path resolves in the ticket or project the text belongs to, which the view provides with
// FileLinkScope; from inside a pane the file docks beside it. http(s) links open in the browser.

import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { parseFileLink } from "@harness/shared";
import { inlineTokens, parseBlocks } from "@harness/shared/state";
import type { FileLinkContext } from "../state/fileOpen";
import { useOptionalStore } from "../state/store";
import { FencedCode } from "./Code";
import { Icon } from "./Icon";
import { PaneContext, PaneScopeContext } from "./paneContext";

export { parseBlocks, plainText } from "@harness/shared/state";

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
            return <FencedCode key={i} text={b.text} lang={b.lang} />;
          case "quote":
            return <blockquote key={i}>{withBreaks(b.text)}</blockquote>;
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((cell, j) => (
                        <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, j) => (
                          <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                            {inline(cell)}
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
