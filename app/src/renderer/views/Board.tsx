import { memo, useMemo, useRef, useState } from "react";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { boardColumns, childrenOf, dependencyStates, isReady, latestSummary, positionForDrop, type State } from "../state/reducer";
import { Icon } from "../components/Icon";
import { DriverBadge, KindBadge, MOD, ReviewMark, STATUS_LABEL, StatusDot } from "../components/bits";
import { plainText } from "../components/Markdown";
import { ModelBadge } from "../components/ModelSelect";
import { TicketDetail } from "./TicketDetail";
import { ConductorRollup, useHideChildren } from "../components/Conductor";
import { dimOnBoard, hideOnBoard, isChild, progressOf } from "../state/conductor";

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
  const { state, route, navigate, client, dispatch, refresh } = useStore();
  const act = useAction();
  const [filter, setFilter] = useState("");
  const [hideChildren, toggleHideChildren] = useHideChildren();
  // Hovering a conductor highlights its children.
  const [hoverConductor, setHoverConductor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ status: TicketStatus; index: number } | null>(null);
  const dragging = useRef<string | null>(null);
  if (route.view !== "board") return null;

  const projectId = route.projectId && state.projects[route.projectId] ? route.projectId : null;
  const project = projectId ? state.projects[projectId] : null;
  const columns = boardColumns(state, projectId);
  const q = filter.trim().toLowerCase();
  const visible = (t: Ticket) => !hideOnBoard(t, hideChildren) && (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
  const hasChildren = Object.values(columns).some((c) => c.some(isChild));
  const hiddenCount = hideChildren ? Object.values(columns).reduce((n, c) => n + c.filter((t) => hideOnBoard(t, true)).length, 0) : 0;

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

  const total = Object.values(columns).reduce((n, c) => n + c.length, 0);

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
              className={`btn btn-ghost btn-sm toggle-btn no-drag ${hideChildren ? "" : "btn-icon"}`}
              aria-pressed={hideChildren}
              aria-label="Hide child tickets"
              data-testid="hide-children"
              title={hideChildren ? "Showing only conductor children that need you. Click to show all." : "Hide child tickets (ones that need you stay visible)"}
              onClick={toggleHideChildren}
            >
              <Icon name={hideChildren ? "eye" : "conductor"} size={13} />
              {hideChildren && <span data-testid="hidden-count">{hiddenCount} hidden</span>}
            </button>
          )}
          <div className="search no-drag">
            <Icon name="hash" size={12} />
            <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={onNewSession}>
            <Icon name="plus" strokeWidth={2.25} />
            New session
            <span className="kbd">{MOD}N</span>
          </button>
        </header>
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
                  <span className="column-count">{tickets.length}</span>
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
                  {tickets.length === 0 && <div className="column-empty">{q ? "No matches" : emptyText[status]}</div>}
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

const emptyText: Record<TicketStatus, string> = {
  planning: "Sessions you want to plan first",
  in_progress: "Agents at work show up here",
  blocked: "Nothing waiting on you",
  review: "Nothing to review",
  done: "Finished work",
};

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
      className={`card ${selected ? "selected" : ""} ${t.busy ? "busy" : ""} ${dropBefore ? "drop-before" : ""} ${dim ? "child-dim" : ""} ${related ? "related" : ""} ${t.kind === "conductor" ? "conductor-card" : ""}`}
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
            <span key={d.key} className={`chip ${d.done ? "done" : "pending"}`} title={d.done ? `${d.key} is done` : `Waiting on ${d.key}`}>
              {d.done ? <Icon name="check" size={9} strokeWidth={3} /> : <Icon name="clock" size={9} />}
              {d.key}
            </span>
          ))}
        </div>
      )}

      <div className="card-foot">
        {showProject && project && <span className="project-key sm">{project.key.slice(0, 3)}</span>}
        <DriverBadge driver={t.driver} />
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
  if (s1.projects !== s2.projects) return false;
  // Deps, children and the parent live in the tickets map.
  if (s1.tickets !== s2.tickets && (a.ticket.dependsOn.length || a.ticket.kind === "conductor" || a.ticket.parentId)) return false;
  return true;
}

export function useTicket(key: string) {
  const { state } = useStore();
  return useMemo(() => Object.values(state.tickets).find((t) => t.key === key), [state.tickets, key]);
}
