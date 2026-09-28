import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TICKET_STATUSES, type Ticket } from "@harness/shared";
import { useStore } from "../state/store";
import {
  boardColumns,
  canLoadMoreSearch,
  childrenOf,
  COLUMN_EMPTY_TEXT,
  depChipTitle,
  dependencyStates,
  dimOnBoard,
  doneCount,
  hasCustomDriver,
  hideOnBoard,
  isReady,
  latestSummary,
  plainText,
  progressOf,
  scopeOf,
  searchColumns,
  searchStatusText,
  ticketByKey,
  type State,
} from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { DriverBadge, MenuButton, ReviewMark, STATUS_LABEL, StatusDot } from "../components/bits";
import { ModelBadge } from "../components/ModelSelect";
import { ConductorRollup, useHideChildren } from "../components/Conductor";
import { ProjectKey } from "../components/ProjectKey";
import { focusedTicket, leaves, openTicket, updatePanes, usePanes } from "../state/panes";
import { dragProps, ticketContextMenu } from "../components/paneDrag";
import { usePane, usePaneScope } from "../components/paneContext";
import { keysArea, runCommand, useCommands } from "../components/commands";
import { focusPaneBy } from "../components/paneFocus";
import { modality } from "../state/inputModality";
import { cursorPos, firstCard, moveCursor, resolveCursor, type CursorDir, type CursorPos } from "../state/boardNav";
import "./board.css";

/** How a card shows that its ticket is open: in the focused pane, in another pane, or not at all. */
type CardSelection = "focused" | "open" | null;

/** The board: pane content in the workspace (components/PaneWorkspace.tsx). */
export function BoardPane() {
  const { state, navigate, boardProjectId, loadMoreDone, setSearch, loadMoreSearch } = useStore();
  const [filter, setFilter] = useState("");
  const [hideChildren, toggleHideChildren] = useHideChildren();
  // The filter box searches the service (debounced in the store); a scope change re-runs it.
  useEffect(() => setSearch(filter), [filter, boardProjectId, setSearch]);
  useEffect(() => () => setSearch(""), [setSearch]);
  // Hovering a conductor highlights its children.
  const [hoverConductor, setHoverConductor] = useState<string | null>(null);
  const scope = usePaneScope();
  const paneId = usePane()?.paneId;
  const panes = usePanes(scope);
  // The click-a-card rule (panes.ts openTicket): reuse the ticket pane beside the board, or split.
  const openCard = useCallback((key: string) => updatePanes(scope, (s) => openTicket(s, key)), [scope]);
  const focusedKey = focusedTicket(panes)?.ticketKey ?? null;
  const openKeys = useMemo(() => new Set(leaves(panes.root).flatMap((l) => (l.content.kind === "ticket" ? [l.content.ticketKey] : []))), [panes.root]);
  const selection = (key: string): CardSelection => (key === focusedKey ? "focused" : openKeys.has(key) ? "open" : null);

  const projectId = boardProjectId;
  const project = projectId ? state.projects[projectId] : null;
  // While searching, the board shows the server's matches (every match, children included: the
  // user is looking for something specific, and hiding a hit would read as "not found").
  const search = state.search && state.search.q === filter.trim() && state.search.scope === scopeOf(projectId) ? state.search : null;
  const searching = !!filter.trim();
  const columns = searching ? searchColumns(state, projectId).columns : boardColumns(state, projectId);
  const visible = (t: Ticket) => searching || !hideOnBoard(t, hideChildren);
  const doneTotal = searching ? columns.done.length : doneCount(state, projectId, columns.done.length);
  const paging = searching ? undefined : state.donePaging[scopeOf(projectId)];
  const shown = TICKET_STATUSES.map((status) => columns[status].filter(visible));

  // The keyboard cursor (state/boardNav.ts): a card key, and the spot it was last seen at so a card
  // that leaves (moves column, filtered out) hands the cursor to whatever's now nearest there. With
  // no cursor yet it's the first card, which is also where pane focus lands.
  const grid = shown.map((ts) => ts.map((t) => t.key));
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const cursorAt = useRef<CursorPos | null>(null);
  const resolved = resolveCursor(grid, cursorKey, cursorAt.current);
  const cursor = resolved ?? firstCard(grid);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardEl = (key: string) => rootRef.current?.querySelector<HTMLElement>(`.card[data-key="${CSS.escape(key)}"]`) ?? null;
  const focusCard = (key: string | null) => {
    const el = key && cardEl(key);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  };
  const setCursor = (key: string) => {
    cursorAt.current = cursorPos(grid, key);
    setCursorKey(key);
  };
  useEffect(() => {
    cursorAt.current = cursorPos(grid, resolved);
    if (resolved !== cursorKey) setCursorKey(resolved);
    // The focused card left the DOM (its ticket moved or went, taking the focus with it): keep the
    // keyboard on the board, on the cursor.
    if (document.activeElement === document.body && modality() === "keyboard" && rootRef.current?.closest(".pane.active")) focusCard(cursor);
  });
  const move = (dir: CursorDir) => () => {
    const next = moveCursor(grid, cursor, dir);
    if (!next) return;
    setCursor(next);
    focusCard(next);
  };
  const owner = `board:${paneId ?? ""}`;
  useCommands(owner, {
    "board.left": move("left"),
    "board.right": move("right"),
    "board.up": move("up"),
    "board.down": move("down"),
    "board.first": move("first"),
    "board.last": move("last"),
    // Read when Enter arrives: on a button in the board (the header's, "Load more") Enter is the button's.
    get "board.open"() {
      const key = cursor;
      if (!key || document.activeElement?.closest("button, a[href], summary")) return null;
      return () => focusPaneBy(scope, (s) => openTicket(s, key));
    },
    "board.search": () => searchRef.current?.focus(),
  });
  /** Escape in the search box clears it, then (empty) goes back to the cards; never on to close the pane. */
  const searchKeys = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (filter) setFilter("");
    else focusCard(cursor);
  };

  return (
    <div
      className="board-pane"
      ref={rootRef}
      {...keysArea("board", owner)}
      // Focus on a card (a click, Tab, pane focus landing) puts the cursor there.
      onFocus={(e) => {
        const key = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.key;
        if (key && key !== cursorKey) setCursor(key);
      }}
    >
      <header className="view-header">
        <div className="view-title">
          {project ? (
            <>
              <ProjectKey project={project} size="lg" />
              {project.name}
            </>
          ) : (
            <>
              <Icon name="layers" />
              All projects
            </>
          )}
        </div>
        {project && (
          <span className="muted mono truncate header-path" title={project.path}>
            {project.path.replace(/^\/Users\/[^/]+/, "~")}
          </span>
        )}
        {project && (
          <button className="btn btn-ghost btn-icon btn-sm" title="Project settings" aria-label="Project settings" onClick={() => navigate({ view: "project", projectId: project.id })}>
            <Icon name="settings" size={13} />
          </button>
        )}
        <div className="grow" />
        <div className="search no-drag">
          <Icon name="hash" size={12} />
          <input
            placeholder="Search"
            aria-label="Search tickets"
            data-testid="board-search"
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={searchKeys}
          />
          {filter && (
            <button className="search-clear" aria-label="Clear search" title="Clear search" onClick={() => setFilter("")}>
              <Icon name="x" size={11} />
            </button>
          )}
          <MenuButton
            className="search-options"
            menuClassName="search-options-menu"
            gap={8}
            offsetX={5}
            trigger={(toggle, open) => (
              <button
                type="button"
                className={`search-options-btn ${hideChildren ? "" : "active"}`}
                aria-label="Search options"
                aria-haspopup="menu"
                aria-expanded={open}
                title="Search options"
                data-testid="search-options"
                onClick={toggle}
              >
                <Icon name="filter" size={12} />
              </button>
            )}
          >
            {() => (
              // Stays open on toggle so the board visibly updates underneath.
              <MenuCheckbox checked={!hideChildren} onToggle={toggleHideChildren} testId="show-children" title="Child tickets that need you always show">
                Show child tickets
              </MenuCheckbox>
            )}
          </MenuButton>
        </div>
      </header>
      {searching && (
        <div className="search-status" data-testid="search-status" role="status">
          {!search || search.ids === null ? <span className="spinner" /> : <Icon name="hash" size={12} />}
          <span>{search ? searchStatusText(search) : "Searching…"}</span>
          {search && canLoadMoreSearch(search) && (
            <button className="btn btn-sm" data-testid="search-load-more" onClick={loadMoreSearch}>
              Load more
            </button>
          )}
          {search?.loading && search.ids !== null && <span className="spinner" />}
          <div className="grow" />
          <button className="btn btn-ghost btn-sm" onClick={() => setFilter("")}>
            Clear
          </button>
        </div>
      )}
      <div className="board">
        {TICKET_STATUSES.map((status, i) => {
          const tickets = shown[i]!;
          return (
            <section key={status} className="column">
              <div className="column-head">
                <StatusDot status={status} />
                <span className="column-title">{STATUS_LABEL[status]}</span>
                <span className="column-count" data-testid={`count-${status}`}>{status === "done" && !searching ? doneTotal : tickets.length}</span>
              </div>
              <div className="column-body">
                {tickets.map((t) => (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    state={state}
                    selected={selection(t.key)}
                    isCursor={t.key === cursor}
                    showProject={!projectId}
                    related={!!hoverConductor && t.parentId === hoverConductor}
                    onHoverConductor={setHoverConductor}
                    onOpen={openCard}
                  />
                ))}
                {tickets.length === 0 && !(status === "done" && paging?.nextCursor) && (
                  <div className="column-empty">{searching ? (search?.ids ? "No matches" : "Searching…") : COLUMN_EMPTY_TEXT[status]}</div>
                )}
                {status === "done" && paging && (paging.nextCursor !== null || paging.error) && (
                  <LoadMore key={tickets.length} loading={paging.loading} error={paging.error} onLoad={loadMoreDone} />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A checkable menu row (the check sits in a fixed gutter so labels line up). */
function MenuCheckbox({ checked, onToggle, testId, title, children }: { checked: boolean; onToggle: () => void; testId?: string; title?: string; children: ReactNode }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="menu-item" data-testid={testId} title={title} onClick={onToggle}>
      <span className="menu-check">{checked && <Icon name="check" size={12} strokeWidth={2.25} />}</span>
      <span className="menu-label">{children}</span>
    </button>
  );
}

/**
 * "Load more" at the end of the Done column; also loads on its own when scrolled near (an
 * IntersectionObserver on the column's scroller). Keyed by the loaded count so it re-observes
 * after each page: a page that adds little (hidden children) keeps loading until the column fills.
 */
function LoadMore({ loading, error, onLoad }: { loading: boolean; error: string | null; onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoad(), {
      root: el.closest(".column-body"),
      rootMargin: "0px 0px 240px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onLoad, error]);
  return (
    <div ref={ref} className="load-more" data-testid="done-load-more">
      {loading ? (
        <span className="load-more-busy">
          <span className="spinner" /> Loading…
        </span>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={onLoad} title={error ? `Couldn't load: ${error}` : undefined}>
          {error ? "Retry" : "Load more"}
        </button>
      )}
    </div>
  );
}

// Cards re-render only when their own inputs change (the store updates many times a second
// while text streams).
const TicketCard = memo(function TicketCard({
  ticket: t,
  state,
  selected,
  isCursor,
  showProject,
  onOpen,
  related,
  onHoverConductor,
}: {
  ticket: Ticket;
  state: State;
  selected: CardSelection;
  /** The keyboard cursor: the board's one tab stop, and where pane focus lands. */
  isCursor: boolean;
  showProject: boolean;
  onOpen: (key: string) => void;
  related: boolean;
  onHoverConductor: (id: string | null) => void;
}) {
  const deps = dependencyStates(state, t);
  const children = t.kind === "conductor" ? childrenOf(state, t.id) : [];
  const progress = t.kind === "conductor" ? progressOf(children) : null;
  const dim = dimOnBoard(t);
  const summary = latestSummary(state, t.sessionId);
  const ready = isReady(t);
  const customDriver = hasCustomDriver(state, t);
  const project = state.projects[t.projectId];
  const parent = t.parentId ? state.tickets[t.parentId] : undefined;
  const scope = usePaneScope();

  return (
    <article
      className={`card ${selected === "focused" ? "selected" : selected === "open" ? "open" : ""} ${t.busy ? "busy" : ""} ${dim ? "child-dim" : ""} ${related ? "related" : ""} ${isCursor ? "cursor" : ""}`}
      data-key={t.key}
      data-parent={parent?.key}
      onMouseEnter={t.kind === "conductor" ? () => onHoverConductor(t.id) : undefined}
      onMouseLeave={t.kind === "conductor" ? () => onHoverConductor(null) : undefined}
      onClick={() => onOpen(t.key)}
      // Drag onto a half of the board or an open ticket to open it in a split there.
      {...dragProps(t.key, t.title)}
      onContextMenu={(e) => void ticketContextMenu(e, scope, t.key, () => onOpen(t.key))}
      role="button"
      aria-label={`${t.key} ${t.title || "Untitled"}`}
      tabIndex={isCursor ? 0 : -1}
      data-pane-autofocus={isCursor || undefined}
      // Enter is board.open (the dispatcher); Space, as on any button, does the same.
      onKeyDown={(e) => e.key === " " && e.target === e.currentTarget && (e.preventDefault(), runCommand("board.open", e.currentTarget))}
    >
      <div className="card-top">
        {showProject && project && <ProjectKey project={project} size="sm" />}
        <span className="card-key">{t.key}</span>
        {parent && (
          <span className="card-parent-chip" title={`Part of ${parent.key} · ${parent.title}`}>
            ↳ {parent.key}
          </span>
        )}
        <div className="grow" />
        {t.status === "review" && (
          <span className="card-reviews">
            <ReviewMark who="agent" state={t.agentReview} />
            <ReviewMark who="human" state={t.humanReview} />
          </span>
        )}
        {t.busy && <span className="spinner" title="Agent working" />}
        {t.externalRef && (
          <span className="badge" title={`Mirrored from ${t.externalRef.source}`}>
            <Icon name="link" />
            {t.externalRef.source}
          </span>
        )}
      </div>
      <div className="card-title">{t.title || "Untitled"}</div>

      {t.pendingApproval ? (
        <div className="card-approval" title={`The agent is waiting for permission to use ${t.pendingApproval.toolName}`}>
          <Icon name="lock" size={12} />
          <span>
            Needs approval: <strong>{t.pendingApproval.toolName.replace(/^mcp__[^_]+__/, "")}</strong>
          </span>
        </div>
      ) : t.status === "blocked" && t.blockedReason && (
        <div className="card-blocked">
          <Icon name="alert" size={12} />
          <span>{t.blockedReason}</span>
        </div>
      )}
      {summary && t.status !== "blocked" && !t.pendingApproval && <div className="card-summary">{plainText(summary.body)}</div>}

      {progress && <ConductorRollup progress={progress} />}

      {deps.length > 0 && (
        <div className="card-chips">
          {deps.map((d) => (
            <span key={d.key} className={`chip ${d.state}`} data-dep-state={d.state} title={depChipTitle(d)}>
              {d.state === "done" ? <Icon name="check" size={9} strokeWidth={3} /> : d.state === "pending" ? <Icon name="clock" size={9} /> : null}
              {d.ticket?.key ?? d.key}
            </span>
          ))}
        </div>
      )}

      {(customDriver || t.model || ready) && (
        <div className="card-foot">
          {customDriver && <DriverBadge driver={t.driver} />}
          <ModelBadge model={t.model} driver={t.driver} />
          <div className="grow" />
          {ready && (
            <span className="badge badge-green">
              <Icon name="check" strokeWidth={2.5} />
              Ready
            </span>
          )}
        </div>
      )}
    </article>
  );
}, cardPropsEqual);

type CardProps = { ticket: Ticket; state: State; selected: CardSelection; isCursor: boolean; showProject: boolean; related: boolean };
function cardPropsEqual(a: CardProps, b: CardProps) {
  if (a.ticket !== b.ticket || a.selected !== b.selected || a.isCursor !== b.isCursor || a.showProject !== b.showProject || a.related !== b.related) return false;
  const s1 = a.state;
  const s2 = b.state;
  if (s1.summaries[a.ticket.sessionId] !== s2.summaries[b.ticket.sessionId]) return false;
  if (s1.projects !== s2.projects || s1.settings !== s2.settings) return false;
  if (s1.keyAliases !== s2.keyAliases || s1.missingKeys !== s2.missingKeys) return false;
  // Deps, children and the parent live in the tickets map.
  if (s1.tickets !== s2.tickets && (a.ticket.dependsOn.length || a.ticket.kind === "conductor" || a.ticket.parentId)) return false;
  return true;
}

export function useTicket(key: string) {
  const { state } = useStore();
  return useMemo(() => ticketByKey(state, key), [state.tickets, state.keyAliases, key]);
}
