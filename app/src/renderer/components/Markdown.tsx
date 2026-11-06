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
// parser turns remote and file images into links, so nothing here loads a URL an agent wrote. Each
// one is the ticket's own Attachment record (SpecAttachmentsScope: TicketDetail.attachments), so
// annotating it adds that attachment, by its id, to the message being written.

import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { parseFileLink, resolveFileRelative, type AttachmentKind, type Attachment } from "@harness/shared";
import {
  inlineTokens,
  mediaIn,
  parseBlocks,
  ticketByKey,
  ticketLinkable,
  type Block,
  type DiffBlock,
  type DiffItem,
  type DiffRun,
  type EditBlock,
  type InlineToken,
  type Media,
  type State,
} from "@harness/shared/state";
import type { FileLinkContext } from "../state/fileOpen";
import { useLinkStore } from "../state/store";
import { mediaAttachment } from "../state/promptAttachmentFiles";
import { Lightbox, Missing } from "./Attachments";
import { DiffCodeBlock, FencedCode } from "./Code";
import { Icon } from "./Icon";
import { PaneContext, PaneScopeContext, useOpenTicket } from "./paneContext";

export { parseBlocks, plainText } from "@harness/shared/state";

const SpecAttachmentsContext = createContext<readonly Attachment[] | undefined>(undefined);

/** The ticket's spec media (TicketDetail.attachments) that `attachment:<id>` in the Markdown below refers to. */
export function SpecAttachmentsScope({ attachments, children }: { attachments: readonly Attachment[] | undefined; children: ReactNode }) {
  return <SpecAttachmentsContext.Provider value={attachments}>{children}</SpecAttachmentsContext.Provider>;
}

/** How ticket keys (FOO-12) render: linked to the ticket when it can be opened, else plain text. */
export interface TicketLinks {
  /** The ticket's title for the tooltip ("" when it isn't loaded yet), or null to leave the key as text. */
  title: (key: string) => string | null;
  open: (key: string) => void;
}

const FileLinkScopeContext = createContext<FileLinkContext & { /** The file the text belongs to: relative links resolve from its directory */ file?: string }>({});

/** Where file links in the Markdown below resolve: the ticket (and project) whose text it is. */
export function FileLinkScope({ ticketKey, projectId, file, children }: FileLinkContext & { file?: string; children: ReactNode }) {
  const value = useMemo(() => ({ ticketKey, projectId, file }), [ticketKey, projectId, file]);
  return <FileLinkScopeContext.Provider value={value}>{children}</FileLinkScopeContext.Provider>;
}

function MdLink({ url, children }: { url: string; children: ReactNode }) {
  const store = useLinkStore();
  const { file: from, ...ctx } = useContext(FileLinkScopeContext);
  const file = useMemo(() => parseFileLink(from ? resolveFileRelative(from, url) : url), [url, from]);
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
/**
 * Ticket links for a piece of markdown. Stable until the slices it reads change, so a streamed
 * token or any other store event doesn't re-render every block of every Markdown on screen.
 */
function useTicketLinks(): TicketLinks | undefined {
  const store = useLinkStore();
  const openTicket = useOpenTicket();
  const { tickets, keyAliases, missingKeys, projects } = store ?? {};
  return useMemo(() => {
    if (!tickets || !keyAliases || !missingKeys || !projects) return undefined;
    // ticketLinkable and ticketByKey read only these slices of the state.
    const slice = { tickets, keyAliases, missingKeys, projects } as Pick<State, "tickets" | "keyAliases" | "missingKeys" | "projects"> as State;
    return { title: (key) => (ticketLinkable(slice, key) ? (ticketByKey(slice, key)?.title ?? "") : null), open: (key) => openTicket(key) };
  }, [tickets, keyAliases, missingKeys, projects, openTicket]);
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

/** The kind to show: the ticket's record of it says (an image's alt text often has no extension to go by). */
const knownKind = (known: readonly Attachment[] | undefined, id: string): AttachmentKind | undefined => {
  const k = known?.find((a) => a.id === id)?.kind;
  return k === "image" || k === "video" ? k : undefined;
};

/**
 * An attachment in markdown: the image (fitted to the width, across it in a figure, or cropped to a
 * square as a thumbnail), or a video's first frame with a play badge, opening the lightbox when
 * clicked. Without a store there's no URL to load, so it's the alt text (nothing when `captioned`:
 * the caption beside it already shows it).
 */
function MdMedia({ media, figure, captioned }: { media: Media; figure?: boolean; captioned?: boolean }) {
  const store = useLinkStore();
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

/**
 * A task item's checkbox (`- [ ]` / `- [x]`) or a question's circle (`- ( )` / `- (x)`, DESIGN.md
 * "Open questions"): read-only, since agents own the text it's in. `was` marks one a revision
 * checked, answered or reopened.
 */
function TaskBox({ checked, question, was }: { checked: boolean; question?: boolean; was?: boolean }) {
  const toggled = was !== undefined && was !== checked;
  if (!question)
    return (
      <input
        type="checkbox"
        className={`md-task-box is-checklist ${toggled ? "is-toggled" : ""}`}
        checked={checked}
        disabled
        readOnly
        aria-label={checked ? "Done" : "Not done"}
        data-testid="md-task-box"
        data-checked={checked}
      />
    );
  // A question for the human: an open one is a question mark in an amber circle, an answered one
  // a check in the same outlined circle (matching the iPhone app).
  return (
    <svg
      className={`md-task-box ${checked ? "is-done" : "is-open"} ${toggled ? "is-toggled" : ""}`}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={checked ? "Answered" : "Question"}
      data-testid="md-task-box"
      data-checked={checked}
    >
      <circle cx="12" cy="12" r="10" />
      <path d={checked ? "M8 12.5l2.8 2.8L16.5 9.5" : "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"} />
    </svg>
  );
}

/**
 * The answer box under each open question item (`- ( )`, DESIGN.md "Open questions"), for the one
 * rendering that answers them: the Spec tab's current spec in a narrow pane
 * (views/QuestionAnswers.tsx). Everywhere else a question shows only its circle.
 */
const TaskAnswerContext = createContext<((question: string) => ReactNode) | null>(null);

export function TaskAnswerScope({ render, children }: { render: ((question: string) => ReactNode) | null; children: ReactNode }) {
  return <TaskAnswerContext.Provider value={render}>{children}</TaskAnswerContext.Provider>;
}

/** A list and the lists nested in its items. Bullets change with depth (• ◦ ▪), see .md-list in styles.css; task items show a checkbox and questions a circle instead. */
function MdList({ block, depth, tickets }: { block: Extract<Block, { t: "ul" | "ol" }>; depth: number; tickets?: TicketLinks }) {
  const answer = useContext(TaskAnswerContext);
  const items = block.items.map((it, j) => {
    // A question keeps its row (and its box's focus) by its text, not its place in the list.
    const question = answer && it.question && it.checked === false && it.text.trim() ? it.text.trim() : null;
    return (
      <li key={question ? `q:${question}` : j} className={question ? "md-task is-question" : it.checked !== undefined ? "md-task" : undefined} data-testid={question ? "spec-question" : undefined}>
        {it.checked !== undefined && <TaskBox checked={it.checked} question={it.question} />}
        {inline(it.text, tickets)}
        {question && <div className="md-task-answer">{answer!(question)}</div>}
        {it.children.map((child, k) => (
          <MdBlock key={k} block={child} depth={depth + 1} tickets={tickets} />
        ))}
      </li>
    );
  });
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
      // A quote holds any markdown, like a list item: its text is parsed again as blocks.
      return (
        <blockquote>
          {parseBlocks(b.text).map((child, k) => (
            <MdBlock key={k} block={child} depth={depth + 1} tickets={tickets} />
          ))}
        </blockquote>
      );
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
  const known = useContext(SpecAttachmentsContext);
  const kind = useCallback((m: Media) => learned[m.id] ?? knownKind(known, m.id) ?? defaultKind(m), [learned, known]);
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
    () =>
      media.map((m) => {
        const a = mediaAttachment(m, known, kind(m));
        // A video that only played as one (its record says otherwise, or there's none) shows as one.
        return a.kind === kind(m) ? a : { ...a, kind: kind(m) };
      }),
    [media, kind, known],
  );
  return (
    <MediaScopeContext.Provider value={scope}>
      <div className={`md selectable ${className ?? ""}`}>{children}</div>
      {open !== null && list.length > 0 && (
        <Lightbox list={list} index={Math.min(open, list.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} annotate={(a) => ({ attachment: a })} />
      )}
    </MediaScopeContext.Provider>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const media = useMemo(() => mediaIn(blocks), [blocks]);
  const tickets = useTicketLinks();
  // The same elements while the text and links hold, so React skips the blocks on a re-render.
  const body = useMemo(() => blocks.map((b, i) => <MdBlock key={i} block={b} tickets={tickets} />), [blocks, tickets]);
  return (
    <MarkdownFrame media={media} className={className}>
      {body}
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
      <li className={`${item.change === "same" ? "" : `md-diff-item is-${item.change}`} ${item.item.checked !== undefined ? "md-task" : ""}`.trim() || undefined}>
        {item.item.checked !== undefined && <TaskBox checked={item.item.checked} question={item.item.question} />}
        {inline(item.item.text, tickets)}
        {item.item.children.map((child, k) => (
          <MdBlock key={k} block={child} depth={depth + 1} tickets={tickets} />
        ))}
      </li>
    );
  return (
    <li className={item.checked !== undefined ? "md-task" : undefined}>
      {item.checked !== undefined && <TaskBox checked={item.checked} question={item.question} was={item.wasChecked} />}
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
  const body = useMemo(() => diff.map((d, i) => <MdDiffBlock key={i} diff={d} tickets={tickets} />), [diff, tickets]);
  return (
    <MarkdownFrame media={media} className={`md-diff ${className ?? ""}`}>
      {body}
    </MarkdownFrame>
  );
}
