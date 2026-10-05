// ⌘K command palette: every command that applies where the focus was (the focused ticket's actions
// first, named as its buttons read: "Approve and merge", "Re-open…"), navigation (boards, inbox, settings sections), tickets and files, fuzzy-ranked by
// state/palette.ts. ">" narrows it to commands, "#" to tickets and "@" to files (⌘P opens it that
// way). Files are searched in one root: the focused ticket pane's ticket, else the board's project
// (paletteFileRoot), git-ignored files included; `path:12` or `path#L12-L20` opens at those lines.
// Without a prefix, a query that reads as a path adds a few files at the end.
//
// Keys, all on the input: ↑/↓, ⌃p/⌃n and ⌃k/⌃j move the highlight (wrapping), Home/End jump to the
// first and last row (the caret has ⌘←/⌘→ for that on the Mac), Enter runs the highlighted row and
// Escape closes. Running a row closes the palette and puts the focus back where it was first, so a
// command acts on (and a modal it opens returns to) the element the palette was opened from.

import "./palette.css";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { displayKey, keyLabel, projectGroups, secondaryKey, type FileMatch, type Ticket } from "@harness/shared";
import { sortedProjects, ticketByKey } from "@harness/shared/state";
import { useStore } from "../state/store";
import { commandKeys } from "../state/keys";
import { availableCommands, runCommand } from "../components/commands";
import { focusPaneBy } from "../components/paneFocus";
import { findLeaf, getPanes, openTicket } from "../state/panes";
import { paneScopeOf } from "../state/route";
import {
  fileItemId,
  looksLikePath,
  matchLabel,
  paletteFileRoot,
  parseFileQuery,
  parsePaletteQuery,
  pushRecent,
  rankCommands,
  readRecents,
  recentFilePaths,
  recentRanks,
  RECENT_FILES_KEY,
  RECENT_FILES_MAX,
  type MatchRange,
  type PaletteFileRoot,
  type PaletteItem,
  type Ranked,
} from "../state/palette";
import { StatusDot, STATUS_LABEL } from "../components/bits";
import { SETTINGS_SECTIONS } from "./Settings";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;
/** Files listed in files mode, and in the unprefixed palette when the query reads as a path. */
const FILE_LIMIT = 50;
const FILE_LIMIT_ALL = 5;
/** Rows shown at most; the query narrows the rest. */
const MAX_ROWS = 60;

interface Entry extends PaletteItem {
  kind: "command" | "nav" | "ticket" | "file";
  group: string;
  /** Shortcut hint ("⇧⌘]"). */
  keys?: string;
  ticket?: Ticket;
  /** A file row's path, relative to the root. */
  path?: string;
  /** A file git ignores (or in node_modules), per the search. */
  ignored?: boolean;
  run: () => void;
}

/** A label with its matched ranges marked. `offset` is where `text` starts in the ranked label. */
function Highlighted({ text, ranges, offset = 0 }: { text: string; ranges: MatchRange[]; offset?: number }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s0, e0] of ranges) {
    const s = Math.max(s0 - offset, at);
    const e = Math.min(e0 - offset, text.length);
    if (e <= s) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** A ticket row's key, as its label starts ("MH-62 · MH-124"): the local key muted, both marked. */
function TicketKeyHighlighted({ ticket, ranges }: { ticket: Ticket; ranges: MatchRange[] }) {
  const shown = displayKey(ticket);
  const local = secondaryKey(ticket);
  return (
    <span className="palette-key">
      <Highlighted text={shown} ranges={ranges} />
      {local && (
        <span className="key-local">
          {" · "}
          <Highlighted text={local} ranges={ranges} offset={shown.length + 3} />
        </span>
      )}
    </span>
  );
}

/** A file row: the name, then its folder dimmed, both with the query's matches marked. */
function FileLabel({ path, ranges }: { path: string; ranges: MatchRange[] }) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(dir.length);
  return (
    <span className="palette-label palette-file">
      <span className="palette-file-name">
        <Highlighted text={name} ranges={ranges} offset={dir.length} />
      </span>
      {dir && (
        <span className="palette-file-dir">
          <Highlighted text={dir} ranges={ranges} />
        </span>
      )}
    </span>
  );
}

const rootKey = (root: PaletteFileRoot | null) => (!root ? "" : "ticketKey" in root ? `t:${root.ticketKey}` : `p:${root.projectId}`);

export function CommandPalette({ origin, initial = "", onClose, onShortcuts }: { origin: Element; initial?: string; onClose: () => void; onShortcuts: () => void }) {
  const { state, client, route, navigate, openFile } = useStore();
  const [raw, setRaw] = useState(initial);
  const [active, setActive] = useState(0);
  const [recents] = useState(readRecents);
  const [fileRecents] = useState(() => readRecents(undefined, RECENT_FILES_KEY, RECENT_FILES_MAX));
  const [remote, setRemote] = useState<{ q: string; tickets: Ticket[] } | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<{ key: string; files: FileMatch[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { kind, q } = parsePaletteQuery(raw);
  const wantTickets = kind === "tickets" || (kind === "all" && !!q);
  const fileQuery = parseFileQuery(q);
  const wantFiles = kind === "files" || (kind === "all" && looksLikePath(fileQuery.search));

  // The pane the palette was opened over (on a board), and the folder its file browser searches.
  const [where] = useState(() => {
    const scope = route.view === "board" ? paneScopeOf(route) : null;
    const panes = scope ? getPanes(scope) : null;
    const leaf = panes?.focusedId ? findLeaf(panes.root, panes.focusedId) : null;
    const projectId = route.view === "board" || route.view === "project" ? route.projectId : null;
    return { scope, paneId: leaf?.id ?? null, root: paletteFileRoot(leaf?.content, projectId) };
  });
  const root = where.root;
  const rootTicket = root && "ticketKey" in root ? ticketByKey(state, root.ticketKey) : undefined;
  const rootLabel = !root ? null : "ticketKey" in root ? (rootTicket ? keyLabel(rootTicket) : root.ticketKey) : state.projects[root.projectId]?.name ?? "this project";

  // Put the focus back where it was when the palette goes away some other way (⌘K again). A row
  // that ran has already done that, and whatever it focused since (a composer, a confirm) keeps it.
  useEffect(
    () => () => {
      const a = document.activeElement;
      if ((!a || a === document.body) && origin.isConnected) (origin as HTMLElement).focus?.();
    },
    [origin],
  );

  // The server search, for tickets that aren't loaded (done ones, other pages). A response for a
  // query that's since changed is dropped.
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!wantTickets || !q) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      client
        .searchTickets({ q, limit: SEARCH_LIMIT })
        .then((page) => n === seq.current && setRemote({ q, tickets: page.tickets }))
        .catch(() => {})
        .finally(() => n === seq.current && setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [client, q, wantTickets]);

  // The file search: every file under the root, git-ignored ones (node_modules, .env) included.
  const fileSeq = useRef(0);
  const search = fileQuery.search;
  const filesKey = `${rootKey(root)}\u0000${search}`;
  useEffect(() => {
    const n = ++fileSeq.current;
    if (!wantFiles || !root || !search) {
      setSearchingFiles(false);
      return;
    }
    setSearchingFiles(true);
    const t = setTimeout(() => {
      const opts = { limit: FILE_LIMIT, ignored: true, kind: "file" as const };
      ("ticketKey" in root ? client.ticketFiles(root.ticketKey, search, opts) : client.projectFiles(root.projectId, search, opts))
        .then((files) => n === fileSeq.current && setRemoteFiles({ key: filesKey, files: files.filter((f) => f.kind === "file") }))
        .catch(() => n === fileSeq.current && setRemoteFiles({ key: filesKey, files: [] }))
        .finally(() => n === fileSeq.current && setSearchingFiles(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [client, root, search, filesKey, wantFiles]);

  const openTicketKey = (key: string) => {
    const scope = route.view === "board" ? paneScopeOf(route) : null;
    if (scope) focusPaneBy(scope, (s) => openTicket(s, key));
    else navigate({ view: "board", projectId: null, ticketKey: key, tab: "spec" });
  };

  const openPath = (path: string) => {
    if (!root) return;
    const { startLine, endLine } = fileQuery;
    const link = { path, absolute: path.startsWith("/"), startLine, endLine, ...root };
    openFile(link, { paneId: where.paneId, scope: where.scope });
  };

  const entries = useMemo((): Entry[] => {
    const ranks = recentRanks(recents);
    const out: Entry[] = [];
    if (kind !== "tickets" && kind !== "files") {
      const commands = availableCommands(origin);
      const have = new Set(commands.map((c) => c.spec.id));
      for (const { spec, label, keywords } of commands) {
        out.push({
          id: `cmd:${spec.id}`,
          kind: "command",
          label,
          keywords,
          group: spec.group,
          keys: commandKeys(spec.id)[0],
          // The overlay's toggle would close it again if it were already open; open it outright.
          run: spec.id === "shortcuts" ? onShortcuts : () => void runCommand(spec.id, origin),
        });
      }
      const nav = (id: string, label: string, run: () => void, keywords?: string[]) => out.push({ id: `nav:${id}`, kind: "nav", label, group: "Go to", keywords, run });
      // Commands for the same places come first; these fill in what they don't cover.
      if (!have.has("board")) nav("board", "Board: All Projects", () => navigate({ view: "board", projectId: null, ticketKey: null, tab: "spec" }));
      // Project groups next, as in the sidebar; "group" finds them all.
      for (const g of projectGroups(Object.values(state.projects))) {
        nav(`group:${g}`, `Board: ${g}`, () => navigate({ view: "board", projectId: null, group: g, ticketKey: null, tab: "spec" }), ["group"]);
      }
      for (const p of sortedProjects(state)) nav(`project:${p.id}`, `Board: ${p.name}`, () => navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "spec" }), [p.key]);
      if (!have.has("inbox")) nav("inbox", "Inbox", () => navigate({ view: "inbox", sessionId: null }));
      if (!have.has("settings")) nav("settings", "Settings", () => navigate({ view: "settings", section: null }));
      for (const [id, label] of SETTINGS_SECTIONS) nav(`settings:${id}`, `Settings: ${label}`, () => navigate({ view: "settings", section: id }));
      if (!have.has("new-session")) nav("new-session", "New Session…", () => runCommand("new-session", origin));
      if (!have.has("shortcuts")) nav("shortcuts", "Keyboard Shortcuts", onShortcuts);
    }
    if (wantTickets) {
      const seen = new Set<string>();
      const ticket = (t: Ticket) => {
        if (seen.has(t.key)) return;
        seen.add(t.key);
        // "MH-62 · MH-124 title": the remote ID and the key both match (the row marks either).
        out.push({ id: `ticket:${t.key}`, kind: "ticket", label: `${keyLabel(t)} ${t.title}`, group: "Ticket", ticket: t, run: () => openTicketKey(t.key) });
      };
      for (const t of Object.values(state.tickets)) ticket(t);
      if (remote?.q === q) for (const t of remote.tickets) ticket(t);
    }
    return out.map((e) => ({ ...e, recentRank: ranks.get(e.id) }));
    // origin's handlers are read when the palette opens and again as the query changes.
  }, [kind, wantTickets, q, origin, state, remote, recents, route, navigate, onShortcuts]);

  // File rows, in the server's order (it ranks them); the recently opened ones for an empty query.
  const fileRows = useMemo((): Ranked<Entry>[] => {
    if (!wantFiles || !root) return [];
    const file = (path: string, ignored = false): Ranked<Entry> => ({
      item: { id: fileItemId(root, path), kind: "file", label: path, group: "File", path, ignored, run: () => openPath(path) },
      ranges: search ? matchLabel(search.toLowerCase(), path)?.ranges ?? [] : [],
      score: 0,
    });
    if (!search) return kind === "files" ? recentFilePaths(fileRecents, root).map((p) => file(p)) : [];
    const files = remoteFiles?.key === filesKey ? remoteFiles.files : [];
    return files.slice(0, kind === "files" ? FILE_LIMIT : FILE_LIMIT_ALL).map((f) => file(f.path, !!f.ignored));
    // openPath reads the query's lines, which change with `q`.
  }, [wantFiles, root, search, kind, fileRecents, remoteFiles, filesKey, q]);

  const rows = useMemo(() => {
    if (kind === "files") return fileRows;
    const ranked = rankCommands(q, entries);
    // The server matched these on more than the label (their description): keep them, after the rest.
    if (remote?.q === q) {
      const shown = new Set(ranked.map((r) => r.item.id));
      for (const t of remote.tickets) {
        const e = entries.find((x) => x.id === `ticket:${t.key}`);
        if (e && !shown.has(e.id)) ranked.push({ item: e, ranges: [], score: 0 });
      }
    }
    return [...ranked.slice(0, MAX_ROWS - fileRows.length), ...fileRows];
  }, [kind, q, entries, remote, fileRows]);

  useEffect(() => setActive(0), [raw]);
  const current = Math.min(active, rows.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, rows]);

  const finish = (entry?: Entry) => {
    onClose();
    if (origin.isConnected) (origin as HTMLElement).focus?.();
    if (!entry) return;
    if (entry.kind === "file") pushRecent(entry.id, undefined, RECENT_FILES_KEY, RECENT_FILES_MAX);
    else pushRecent(entry.id);
    entry.run();
  };

  const move = (to: number) => rows.length && setActive(((to % rows.length) + rows.length) % rows.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.key === "ArrowDown" || (ctrl && (k === "n" || k === "j"))) move(current + 1);
    else if (e.key === "ArrowUp" || (ctrl && (k === "p" || k === "k"))) move(current - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const row = rows[current];
      if (row) finish(row.item);
    }
    else if (e.key === "Escape") finish();
    // Otherwise unhandled, except Tab: it would walk the focus off into the page behind.
    else if (e.key !== "Tab") handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const placeholder =
    kind === "commands"
      ? "Run a command…"
      : kind === "tickets"
        ? "Find a ticket…"
        : kind === "files"
          ? rootLabel
            ? `Find a file in ${rootLabel}…  (path:12 opens at a line)`
            : "Find a file…"
          : "Search commands and tickets…  (> commands, # tickets, @ files)";
  const lineHint = fileQuery.startLine ? `:${fileQuery.startLine}${fileQuery.endLine ? `-${fileQuery.endLine}` : ""}` : null;
  const busy = searching || searchingFiles;

  const emptyNote = (): string => {
    if (kind === "files") {
      if (!root) return "Focus a ticket, or open a project's board, to browse its files";
      return search ? "No matching files" : `Type to find a file in ${rootLabel}`;
    }
    return q ? "No matches" : kind === "tickets" ? "Type to find a ticket" : "Nothing to run here";
  };

  return (
    <div className="overlay palette-overlay" data-testid="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish()}>
      <div className="palette" role="dialog" aria-label="Command palette" data-testid="palette">
        <input
          className="palette-input"
          data-testid="palette-input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? optionId(current) : undefined}
          placeholder={placeholder}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {kind === "files" && rootLabel && (
          <div className="palette-root" data-testid="palette-root">
            Files in <strong>{rootLabel}</strong>
            {!search && rows.length > 0 && <span className="palette-root-hint">Recently opened</span>}
          </div>
        )}
        <div className="palette-list" id={listId} role="listbox" aria-label="Results" ref={listRef}>
          {rows.map(({ item, ranges }, i) => {
            const t = item.ticket;
            return (
              <div
                key={item.id}
                id={optionId(i)}
                className="palette-row"
                role="option"
                aria-selected={i === current}
                data-testid="palette-row"
                data-id={item.id}
                data-kind={item.kind}
                data-path={item.path}
                // mousemove, not mouseenter: the list scrolling under a still pointer mustn't take the highlight.
                onMouseMove={() => i !== current && setActive(i)}
                // Keep the focus (and the caret) in the input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => finish(item)}
              >
                {t ? (
                  <>
                    <TicketKeyHighlighted ticket={t} ranges={ranges} />
                    <span className="palette-label">
                      <Highlighted text={t.title} ranges={ranges} offset={keyLabel(t).length + 1} />
                    </span>
                    <span className="palette-status">
                      <StatusDot status={t.status} />
                      {STATUS_LABEL[t.status]}
                    </span>
                  </>
                ) : item.path !== undefined ? (
                  <>
                    <FileLabel path={item.path} ranges={ranges} />
                    {item.ignored && (
                      <span className="palette-ignored" data-testid="palette-ignored" title="Git ignores this file">
                        ignored
                      </span>
                    )}
                    {lineHint && <span className="palette-group palette-lines">{lineHint}</span>}
                    {kind !== "files" && <span className="palette-group">{item.group}</span>}
                  </>
                ) : (
                  <>
                    <span className="palette-label">
                      <Highlighted text={item.label} ranges={ranges} />
                    </span>
                    <span className="palette-group">{item.group}</span>
                    {item.keys && <span className="kbd">{item.keys}</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {busy && (
          <div className="palette-note" role="status" data-testid="palette-searching">
            <span className="spinner" />
            Searching…
          </div>
        )}
        {!busy && rows.length === 0 && (
          <div className="palette-note" data-testid="palette-empty">
            {emptyNote()}
          </div>
        )}
      </div>
    </div>
  );
}
