import { memo, useEffect, useMemo, useRef, useState } from "react";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
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
  isChild,
  isReady,
  latestSummary,
  plainText,
  positionForDrop,
  progressOf,
  scopeOf,
  searchColumns,
  searchStatusText,
  ticketByKey,
  type State,
} from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { DriverBadge, KindBadge, MOD, ReviewMark, STATUS_LABEL, StatusDot } from "../components/bits";
import { ModelBadge } from "../components/ModelSelect";
import { TicketDetail } from "./TicketDetail";
import { ConductorRollup, useHideChildren } from "../components/Conductor";
import "./board.css";

const DRAG_MIME = "application/x-harness-ticket";

/** Insertion index for a drag at clientY: before the first card whose middle is below it. */
function dropIndex(body: Element, clientY: number, draggingKey: string | null): number {
  const cards = [...body.querySelectorAll<HTMLElement>(".card[data-key]")].filter((c) => c.dataset.key !== draggingKey);
  const i = cards.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return clientY < r.top + r.height / 2;
  });
  return i === -1 ? cards.length : i;
}

export function BoardView({ onNewSession }: { onNewSession: () => void }) {
  const { state, route, navigate, client, dispatch, refresh, boardProjectId, loadMoreDone, setSearch, loadMoreSearch } = useStore();
  const act = useAction();
  const [filter, setFilter] = useState("");
  const [hideChildren, toggleHideChildren] = useHideChildren();
  // The filter box searches the service (debounced in the store); a scope change re-runs it.
  useEffect(() => setSearch(filter), [filter, boardProjectId, setSearch]);
  useEffect(() => () => setSearch(""), [setSearch]);
  // Hovering a conductor highlights its children.
  const [hoverConductor, setHoverConductor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ status: TicketStatus; index: number } | null>(null);
  const dragging = useRef<string | null>(null);
  if (route.view !== "board") return null;

  const projectId = boardProjectId;
  const project = projectId ? state.projects[projectId] : null;
  // While searching, the board shows the server's matches (every match, children included: the
  // user is looking for something specific, and hiding a hit would read as "not found").
  const search = state.search && state.search.q === filter.trim() && state.search.scope === scopeOf(projectId) ? state.search : null;
  const searching = !!filter.trim();
  const columns = searching ? searchColumns(state, projectId).columns : boardColumns(state, projectId);
  const visible = (t: Ticket) => searching || !hideOnBoard(t, hideChildren);
  const hasChildren = Object.values(state.tickets).some((t) => isChild(t) && (!projectId || t.projectId === projectId));
  const doneTotal = searching ? columns.done.length : doneCount(state, projectId, columns.done.length);
  const paging = searching ? undefined : state.donePaging[scopeOf(projectId)];

  const open = (key: string) => navigate({ view: "board", projectId, ticketKey: key, tab: "summaries" });

  const move = async (key: string, status: TicketStatus, index: number) => {
    const t = Object.values(state.tickets).find((x) => x.key === key);
    if (!t) return;
    // Done is ordered by completion time, so only the status matters there.
    const others = columns[status].filter(visible).filter((x) => x.id !== t.id);
    const position = status === "done" ? undefined : positionForDrop(others, index);
    if (t.status === status) {
      // Dropped back where it already sits (the column is in display order without it).
      const current = columns[status].filter(visible).findIndex((x) => x.id === t.id);
      if (status === "done" || current === index) return;
    }
    const body = { ...(t.status !== status ? { status } : {}), ...(position !== undefined ? { position } : {}) };
    // Optimistic: the service's ticket.upserted will confirm (or refresh corrects it).
    dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: { ...t, ...body, updatedAt: t.updatedAt } } });
    const res = await act(() => client.updateTicket(key, body));
    if (!res) void refresh();
  };

  const total = searching
    ? (search?.ids ? search.total : Object.values(columns).reduce((n, c) => n + c.length, 0))
    : Object.entries(columns).reduce((n, [status, c]) => n + (status === "done" ? doneTotal : c.length), 0);

  return (
    <div className="board-layout">
      <div className="board-pane">
        <header className="view-header">
          <div className="view-title">
            {project ? (
              <>
                <span className="project-key lg">{project.key.slice(0, 3)}</span>
                {project.name}
              </>
            ) : (
              <>
                <Icon name="layers" />
                All projects
              </>
            )}
            <span className="muted" style={{ fontWeight: 400 }}>
              {total}
            </span>
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
          {hasChildren && (
            <button
              type="button"
              role="switch"
              aria-checked={!hideChildren}
              aria-label="Show child tickets"
              className="btn btn-ghost btn-sm children-toggle no-drag"
              data-testid="show-children"
              title={hideChildren ? "Show child tickets (ones that need you always show)" : "Hide child tickets (ones that need you stay visible)"}
              onClick={toggleHideChildren}
            >
              <Icon name="conductor" size={13} />
              <span className="children-toggle-label">Show child tickets</span>
              <span className="switch-track" aria-hidden="true" />
            </button>
          )}
          <div className="search no-drag">
            <Icon name="hash" size={12} />
            <input
              placeholder="Search"
              aria-label="Search tickets"
              data-testid="board-search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && filter && (e.stopPropagation(), setFilter(""))}
            />
            {filter && (
              <button className="search-clear" aria-label="Clear search" title="Clear search" onClick={() => setFilter("")}>
                <Icon name="x" size={11} />
              </button>
            )}
          </div>
          <button className="btn btn-primary board-new" onClick={onNewSession} title={`New session (${MOD}N)`} aria-label="New session">
            <Icon name="plus" strokeWidth={2.25} />
            <span className="board-new-label">New session</span>
            <span className="kbd">{MOD}N</span>
          </button>
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
          {TICKET_STATUSES.map((status) => {
            const tickets = columns[status].filter(visible);
            return (
              <section
                key={status}
                className={`column ${dragOver?.status === status ? "drag-over" : ""}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const body = e.currentTarget.querySelector(".column-body");
                  const index = body ? dropIndex(body, e.clientY, dragging.current) : 0;
                  if (dragOver?.status !== status || dragOver.index !== index) setDragOver({ status, index });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const key = e.dataTransfer.getData(DRAG_MIME);
                  const body = e.currentTarget.querySelector(".column-body");
                  const index = body ? dropIndex(body, e.clientY, key) : 0;
                  dragging.current = null;
                  if (key) void move(key, status, index);
                }}
              >
                <div className="column-head">
                  <StatusDot status={status} />
                  <span className="column-title">{STATUS_LABEL[status]}</span>
                  <span className="column-count" data-testid={`count-${status}`}>{status === "done" && !searching ? doneTotal : tickets.length}</span>
                </div>
                <div className={`column-body ${dragOver?.status === status && status !== "done" && dragOver.index >= tickets.filter((t) => t.key !== dragging.current).length ? "drop-end" : ""}`}>
                  {tickets.map((t) => (
                    <TicketCard
                      key={t.id}
                      dropBefore={
                        dragOver?.status === status &&
                        status !== "done" &&
                        t.key !== dragging.current &&
                        tickets.filter((x) => x.key !== dragging.current).indexOf(t) === dragOver.index
                      }
                      onDragStart={(key) => (dragging.current = key)}
                      ticket={t}
                      state={state}
                      selected={route.ticketKey === t.key}
                      showProject={!projectId}
                      related={!!hoverConductor && t.parentId === hoverConductor}
                      onHoverConductor={setHoverConductor}
                      onOpen={open}
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
      {route.ticketKey && <TicketDetail key={route.ticketKey} ticketKey={route.ticketKey} />}
    </div>
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
  showProject,
  onOpen,
  onDragStart,
  dropBefore,
  related,
  onHoverConductor,
}: {
  ticket: Ticket;
  state: State;
  selected: boolean;
  showProject: boolean;
  onOpen: (key: string) => void;
  onDragStart: (key: string) => void;
  dropBefore: boolean;
  related: boolean;
  onHoverConductor: (id: string | null) => void;
}) {
  const deps = dependencyStates(state, t);
  const children = t.kind === "conductor" ? childrenOf(state, t.id) : [];
  const progress = t.kind === "conductor" ? progressOf(children) : null;
  const dim = dimOnBoard(t);
  const summary = latestSummary(state, t.sessionId);
  const ready = isReady(t);
  const project = state.projects[t.projectId];
  const parent = t.parentId ? state.tickets[t.parentId] : undefined;

  return (
    <article
      className={`card ${selected ? "selected" : ""} ${t.busy ? "busy" : ""} ${dropBefore ? "drop-before" : ""} ${dim ? "child-dim" : ""} ${related ? "related" : ""}`}
      data-key={t.key}
      data-parent={parent?.key}
      onMouseEnter={t.kind === "conductor" ? () => onHoverConductor(t.id) : undefined}
      onMouseLeave={t.kind === "conductor" ? () => onHoverConductor(null) : undefined}
      draggable
      onDragStart={(e) => {
        onDragStart(t.key);
        e.dataTransfer.setData(DRAG_MIME, t.key);
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
      onClick={() => onOpen(t.key)}
    >
      <div className="card-top">
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

      <div className="card-foot">
        {showProject && project && <span className="project-key sm">{project.key.slice(0, 3)}</span>}
        {hasCustomDriver(state, t) && <DriverBadge driver={t.driver} />}
        <ModelBadge model={t.model} driver={t.driver} />
        <KindBadge ticket={t} />
        <div className="grow" />
        {ready && (
          <span className="badge badge-green">
            <Icon name="check" strokeWidth={2.5} />
            Ready
          </span>
        )}
      </div>
    </article>
  );
}, cardPropsEqual);

type CardProps = { ticket: Ticket; state: State; selected: boolean; showProject: boolean; dropBefore: boolean; related: boolean };
function cardPropsEqual(a: CardProps, b: CardProps) {
  if (a.ticket !== b.ticket || a.selected !== b.selected || a.showProject !== b.showProject || a.dropBefore !== b.dropBefore || a.related !== b.related) return false;
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
