// ⌘K command palette: every command that applies where the focus was (the focused ticket's actions
// included), navigation (boards, inbox, settings sections) and tickets, fuzzy-ranked by
// state/palette.ts. ">" narrows it to commands and "#" to tickets.
//
// Keys, all on the input: ↑/↓, ⌃p/⌃n and ⌃k/⌃j move the highlight (wrapping), Home/End jump to the
// first and last row (the caret has ⌘←/⌘→ for that on the Mac), Enter runs the highlighted row and
// Escape closes. Running a row closes the palette and puts the focus back where it was first, so a
// command acts on (and a modal it opens returns to) the element the palette was opened from.

import "./palette.css";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Ticket } from "@harness/shared";
import { sortedProjects } from "@harness/shared/state";
import { useStore } from "../state/store";
import { commandKeys } from "../state/keys";
import { availableCommands, runCommand } from "../components/commands";
import { focusPaneBy } from "../components/paneFocus";
import { openTicket } from "../state/panes";
import { paneScopeOf } from "../state/route";
import { parsePaletteQuery, pushRecent, rankCommands, readRecents, recentRanks, type MatchRange, type PaletteItem } from "../state/palette";
import { StatusDot, STATUS_LABEL } from "../components/bits";

// Settings.tsx's sections (its list isn't exported).
const SETTINGS_SECTIONS = [
  ["appearance", "Appearance"],
  ["drivers", "Drivers"],
  ["general", "General"],
  ["models", "Models"],
  ["permissions", "Permissions"],
  ["network", "Network"],
  ["watchers", "Watchers"],
  ["projects", "Projects"],
] as const;

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;
/** Rows shown at most; the query narrows the rest. */
const MAX_ROWS = 60;

interface Entry extends PaletteItem {
  kind: "command" | "nav" | "ticket";
  group: string;
  /** Shortcut hint ("⇧⌘]"). */
  keys?: string;
  ticket?: Ticket;
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

export function CommandPalette({ origin, onClose, onShortcuts }: { origin: Element; onClose: () => void; onShortcuts: () => void }) {
  const { state, client, route, navigate } = useStore();
  const [raw, setRaw] = useState("");
  const [active, setActive] = useState(0);
  const [recents] = useState(readRecents);
  const [remote, setRemote] = useState<{ q: string; tickets: Ticket[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { kind, q } = parsePaletteQuery(raw);
  const wantTickets = kind === "tickets" || (kind === "all" && !!q);

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

  const openTicketKey = (key: string) => {
    const scope = route.view === "board" ? paneScopeOf(route) : null;
    if (scope) focusPaneBy(scope, (s) => openTicket(s, key));
    else navigate({ view: "board", projectId: null, ticketKey: key, tab: "summaries" });
  };

  const entries = useMemo((): Entry[] => {
    const ranks = recentRanks(recents);
    const out: Entry[] = [];
    if (kind !== "tickets") {
      const commands = availableCommands(origin);
      const have = new Set(commands.map((c) => c.spec.id));
      for (const { spec } of commands) {
        out.push({
          id: `cmd:${spec.id}`,
          kind: "command",
          label: spec.label,
          group: spec.group,
          keys: commandKeys(spec.id)[0],
          // The overlay's toggle would close it again if it were already open; open it outright.
          run: spec.id === "shortcuts" ? onShortcuts : () => void runCommand(spec.id, origin),
        });
      }
      const nav = (id: string, label: string, run: () => void, keywords?: string[]) => out.push({ id: `nav:${id}`, kind: "nav", label, group: "Go to", keywords, run });
      // Commands for the same places come first; these fill in what they don't cover.
      if (!have.has("board")) nav("board", "Board: All Projects", () => navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" }));
      for (const p of sortedProjects(state)) nav(`project:${p.id}`, `Board: ${p.name}`, () => navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "summaries" }), [p.key]);
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
        out.push({ id: `ticket:${t.key}`, kind: "ticket", label: `${t.key} ${t.title}`, group: "Ticket", ticket: t, run: () => openTicketKey(t.key) });
      };
      for (const t of Object.values(state.tickets)) ticket(t);
      if (remote?.q === q) for (const t of remote.tickets) ticket(t);
    }
    return out.map((e) => ({ ...e, recentRank: ranks.get(e.id) }));
    // origin's handlers are read when the palette opens and again as the query changes.
  }, [kind, wantTickets, q, origin, state, remote, recents, route, navigate, onShortcuts]);

  const rows = useMemo(() => {
    const ranked = rankCommands(q, entries);
    // The server matched these on more than the label (their description): keep them, after the rest.
    if (remote?.q === q) {
      const shown = new Set(ranked.map((r) => r.item.id));
      for (const t of remote.tickets) {
        const e = entries.find((x) => x.id === `ticket:${t.key}`);
        if (e && !shown.has(e.id)) ranked.push({ item: e, ranges: [], score: 0 });
      }
    }
    return ranked.slice(0, MAX_ROWS);
  }, [q, entries, remote]);

  useEffect(() => setActive(0), [raw]);
  const current = Math.min(active, rows.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, rows]);

  const finish = (entry?: Entry) => {
    onClose();
    if (origin.isConnected) (origin as HTMLElement).focus?.();
    if (!entry) return;
    pushRecent(entry.id);
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
  const placeholder = kind === "commands" ? "Run a command…" : kind === "tickets" ? "Find a ticket…" : "Search commands and tickets…  (> commands, # tickets)";

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
                // mousemove, not mouseenter: the list scrolling under a still pointer mustn't take the highlight.
                onMouseMove={() => i !== current && setActive(i)}
                // Keep the focus (and the caret) in the input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => finish(item)}
              >
                {t ? (
                  <>
                    <span className="palette-key">
                      <Highlighted text={t.key} ranges={ranges} />
                    </span>
                    <span className="palette-label">
                      <Highlighted text={t.title} ranges={ranges} offset={t.key.length + 1} />
                    </span>
                    <span className="palette-status">
                      <StatusDot status={t.status} />
                      {STATUS_LABEL[t.status]}
                    </span>
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
        {searching && (
          <div className="palette-note" role="status" data-testid="palette-searching">
            <span className="spinner" />
            Searching…
          </div>
        )}
        {!searching && rows.length === 0 && (
          <div className="palette-note" data-testid="palette-empty">
            {q ? "No matches" : kind === "tickets" ? "Type to find a ticket" : "Nothing to run here"}
          </div>
        )}
      </div>
    </div>
  );
}
