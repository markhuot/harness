// Markdown-ish rendering for specs, Activity and transcript text: paragraphs, headings,
// nested bullet/numbered lists, fenced code (syntax highlighted, Code.tsx), tables, attachment images
// and videos, inline code, bold/italic, links, ticket keys. Parsing is shared with the
// iOS app (@harness/shared/state "markdown"); this builds React DOM nodes directly (no innerHTML),
// so agent output can't inject markup.
//
// Links to files (harness://file/…, or a plain path; shared/src/fileLinks.ts) open the file pane.
// Their path resolves in the ticket or project the text belongs to, which the view provides with
// FileLinkScope; from inside a pane the file docks beside it. http(s) links open in the browser.
//
// `![alt](attachment:<id>)` alone on its line is a figure: the attachment across the full width with
// its alt text as the caption. `![alt](attachment:<id> "thumb")` is a 100×100 thumbnail, and a line of
// them a row. Either opens the lightbox on a click (stepping through every image in the text). The
// parser turns remote and file images into links, so nothing here loads a URL an agent wrote.

import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { parseFileLink, type AttachmentKind, type Attachment } from "@harness/shared";
import {
  inlineTokens,
  mediaIn,
  parseBlocks,
  specAttachmentPath,
  ticketByKey,
  ticketLinkable,
  type Block,
  type DiffBlock,
  type DiffItem,
  type DiffRun,
  type EditBlock,
  type InlineToken,
  type Media,
} from "@harness/shared/state";
import type { FileLinkContext } from "../state/fileOpen";
import { useOptionalStore } from "../state/store";
import { Lightbox, Missing } from "./Attachments";
import { DiffCodeBlock, FencedCode } from "./Code";
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
  return inlineTokens(text).map((tok, k) => inlineToken(tok, k, tickets, onLink));
}

function inlineToken(tok: InlineToken, k: number, tickets?: TicketLinks, onLink?: (url: string) => void): ReactNode {
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
    case "img":
      return <MdMedia key={k} media={tok} />;
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

/** The images in a piece of markdown, for the lightbox: what kind each turned out to be, and opening one. */
interface MediaScope {
  kind: (m: Media) => AttachmentKind;
  /** An image that failed to load as one is tried as a video; the lightbox then shows it as a video too. */
  learn: (id: string, kind: AttachmentKind) => void;
  open: (id: string) => void;
}

const MediaScopeContext = createContext<MediaScope | null>(null);

const defaultKind = (m: Media): AttachmentKind => (m.video ? "video" : "image");

/**
 * An attachment in markdown: the image (fitted to the width, across it in a figure, or cropped to a
 * square as a thumbnail), or a video's first frame with a play badge, opening the lightbox when
 * clicked. Without a store there's no URL to load, so it's the alt text (nothing when `captioned`:
 * the caption beside it already shows it).
 */
function MdMedia({ media, figure, captioned }: { media: Media; figure?: boolean; captioned?: boolean }) {
  const store = useOptionalStore();
  const scope = useContext(MediaScopeContext);
  const [own, setOwn] = useState<AttachmentKind | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!store) return captioned ? null : <>{media.alt}</>;
  const url = store.client.attachmentUrl(media.id);
  const kind = own ?? scope?.kind(media) ?? defaultKind(media);
  const label = media.alt || (kind === "video" ? "Video" : "Image");
  const fail = () => {
    // The parser guesses the kind from a name; an id without one may still be a video.
    if (kind === "image" && !media.video) {
      setOwn("video");
      scope?.learn(media.id, "video");
    } else setFailed(url);
  };
  return (
    <button
      className={`md-media ${figure ? "is-figure" : ""} ${media.thumb ? "is-thumb" : ""} ${failed === url ? "is-missing" : ""}`}
      title={media.alt || undefined}
      aria-label={`Open ${label}`}
      data-testid="md-media"
      onClick={() => scope?.open(media.id)}
    >
      {failed === url ? (
        <Missing name={label} />
      ) : kind === "image" ? (
        <img key={url} src={url} alt={media.alt} loading="lazy" decoding="async" draggable={false} onError={fail} />
      ) : (
        <>
          {/* #t= makes WebKit paint a frame for the poster instead of a black box. */}
          <video key={url} src={`${url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} onError={fail} />
          <span className="attachment-play">
            <Icon name="play" size={12} />
          </span>
        </>
      )}
    </button>
  );
}

/** A list and the lists nested in its items. Bullets change with depth (• ◦ ▪), see .md-list in styles.css. */
function MdList({ block, depth, tickets }: { block: Extract<Block, { t: "ul" | "ol" }>; depth: number; tickets?: TicketLinks }) {
  const items = block.items.map((it, j) => (
    <li key={j}>
      {inline(it.text, tickets)}
      {it.children.map((child, k) => (
        <MdBlock key={k} block={child} depth={depth + 1} tickets={tickets} />
      ))}
    </li>
  ));
  const className = `md-list depth-${depth % 3}`;
  return block.t === "ol" ? (
    <ol className={className} start={block.start}>
      {items}
    </ol>
  ) : (
    <ul className={className}>{items}</ul>
  );
}

function MdBlock({ block: b, depth = 0, tickets }: { block: Block; depth?: number; tickets?: TicketLinks }) {
  switch (b.t) {
    case "p":
      return <p>{withBreaks(b.text, tickets)}</p>;
    case "h": {
      const H = `h${Math.min(b.level, 4)}` as "h1";
      return <H>{inline(b.text, tickets)}</H>;
    }
    case "ul":
    case "ol":
      return <MdList block={b} depth={depth} tickets={tickets} />;
    case "img":
      return (
        <figure className="md-figure" data-testid="md-figure">
          <MdMedia media={b} figure captioned={!!b.alt} />
          {b.alt && <figcaption>{b.alt}</figcaption>}
        </figure>
      );
    case "thumbs":
      return (
        <div className="md-thumbs" data-testid="md-thumbs">
          {b.items.map((m, k) => (
            <figure key={k} className="md-thumb">
              <MdMedia media={m} captioned={!!m.alt} />
              {m.alt && <figcaption title={m.alt}>{m.alt}</figcaption>}
            </figure>
          ))}
        </div>
      );
    case "code":
      return <FencedCode text={b.text} lang={b.lang} />;
    case "quote":
      return <blockquote>{withBreaks(b.text, tickets)}</blockquote>;
    case "table":
      return (
        <div className="md-table">
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
      return <hr />;
  }
}

/** The lightbox for a piece of markdown's attachments, around its rendered blocks. */
function MarkdownFrame({ media, className, children }: { media: Media[]; className?: string; children: ReactNode }) {
  const [learned, setLearned] = useState<Record<string, AttachmentKind>>({});
  const [open, setOpen] = useState<number | null>(null);
  const kind = useCallback((m: Media) => learned[m.id] ?? defaultKind(m), [learned]);
  const scope = useMemo<MediaScope>(
    () => ({
      kind,
      learn: (id, k) => setLearned((prev) => (prev[id] === k ? prev : { ...prev, [id]: k })),
      open: (id) => {
        const i = media.findIndex((m) => m.id === id);
        if (i >= 0) setOpen(i);
      },
    }),
    [kind, media],
  );
  const list = useMemo<Attachment[]>(
    () => media.map((m) => ({ id: m.id, kind: kind(m), mimeType: "", name: m.alt || m.id, size: 0 })),
    [media, kind],
  );
  return (
    <MediaScopeContext.Provider value={scope}>
      <div className={`md selectable ${className ?? ""}`}>{children}</div>
      {open !== null && list.length > 0 && (
        <Lightbox list={list} index={Math.min(open, list.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} annotate={(a) => ({ input: { path: specAttachmentPath(a.id), name: a.name } })} />
      )}
    </MediaScopeContext.Provider>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const media = useMemo(() => mediaIn(blocks), [blocks]);
  const tickets = useTicketLinks();
  return (
    <MarkdownFrame media={media} className={className}>
      {blocks.map((b, i) => (
        <MdBlock key={i} block={b} tickets={tickets} />
      ))}
    </MarkdownFrame>
  );
}

// ---------------------------------------------------------------- changes

/** Runs of a changed text: added words in <ins>, removed ones in <del>, "\n" as line breaks. */
function diffRuns(runs: DiffRun[], tickets?: TicketLinks): ReactNode[] {
  return runs.map((run, k) => {
    const parts = run.t !== "ticket" && run.t !== "img" ? run.text.split("\n") : null;
    const node = parts ? (
      parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {p && inlineToken({ ...run, text: p } as InlineToken, i, tickets)}
        </Fragment>
      ))
    ) : (
      inlineToken(run, 0, tickets)
    );
    if (run.change === "add") return <ins key={k}>{node}</ins>;
    if (run.change === "del") return <del key={k}>{node}</del>;
    return <Fragment key={k}>{node}</Fragment>;
  });
}

function DiffListItem({ item, depth, tickets }: { item: DiffItem; depth: number; tickets?: TicketLinks }) {
  if (item.change !== "edit")
    return (
      <li className={item.change === "same" ? undefined : `md-diff-item is-${item.change}`}>
        {inline(item.item.text, tickets)}
        {item.item.children.map((child, k) => (
          <MdBlock key={k} block={child} depth={depth + 1} tickets={tickets} />
        ))}
      </li>
    );
  return (
    <li>
      {diffRuns(item.runs, tickets)}
      {item.children.map((child, k) => (
        <MdDiffBlock key={k} diff={child} depth={depth + 1} tickets={tickets} />
      ))}
    </li>
  );
}

/** A block in both revisions with its changes marked, laid out like MdBlock lays out the Block. */
function MdEditBlock({ block: b, depth, tickets }: { block: EditBlock; depth: number; tickets?: TicketLinks }) {
  switch (b.t) {
    case "p":
      return <p>{diffRuns(b.runs, tickets)}</p>;
    case "quote":
      return <blockquote>{diffRuns(b.runs, tickets)}</blockquote>;
    case "h": {
      const H = `h${Math.min(b.level, 4)}` as "h1";
      return <H>{diffRuns(b.runs, tickets)}</H>;
    }
    case "ul":
    case "ol": {
      const items = b.items.map((it, j) => <DiffListItem key={j} item={it} depth={depth} tickets={tickets} />);
      const className = `md-list depth-${depth % 3}`;
      return b.t === "ol" ? (
        <ol className={className} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      );
    }
    case "code":
      return <DiffCodeBlock lines={b.lines} lang={b.lang} />;
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {b.header.map((cell, j) => (
                  <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                    {diffRuns(cell, tickets)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className={row.change === "add" || row.change === "del" ? `md-diff-row is-${row.change}` : undefined}>
                  {row.change === "edit"
                    ? row.cells.map((cell, j) => (
                        <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                          {diffRuns(cell, tickets)}
                        </td>
                      ))
                    : row.cells.map((cell, j) => (
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
  }
}

function MdDiffBlock({ diff, depth = 0, tickets }: { diff: DiffBlock; depth?: number; tickets?: TicketLinks }) {
  if (diff.change === "edit") return <MdEditBlock block={diff.block} depth={depth} tickets={tickets} />;
  const block = <MdBlock block={diff.block} depth={depth} tickets={tickets} />;
  if (diff.change === "same") return block;
  return (
    <div className={`md-diff-block is-${diff.change}`} data-diff={diff.change}>
      {block}
    </div>
  );
}

/**
 * Two revisions of a markdown text (older first) rendered as the newer one, with what changed
 * marked in place (@harness/shared/state specDiff): added words and blocks green, removed ones red
 * and struck through. Unchanged blocks render exactly as Markdown renders them. `diff` is
 * specDiff(before, after), computed by the caller, which usually needs it too (diffUnchanged).
 */
export function MarkdownDiff({ diff, before, after, className }: { diff: DiffBlock[]; before: string; after: string; className?: string }) {
  const media = useMemo(() => {
    const seen = new Set<string>();
    return [...mediaIn(parseBlocks(after)), ...mediaIn(parseBlocks(before))].filter((m) => !seen.has(m.id) && seen.add(m.id));
  }, [before, after]);
  const tickets = useTicketLinks();
  return (
    <MarkdownFrame media={media} className={`md-diff ${className ?? ""}`}>
      {diff.map((d, i) => (
        <MdDiffBlock key={i} diff={d} tickets={tickets} />
      ))}
    </MarkdownFrame>
  );
}
