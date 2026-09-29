import { useEffect, useMemo, useState } from "react";
import type { Ticket } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { dependentsOf } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { driverLabel, relativeTime, StatusDot, useNow } from "../components/bits";
import { useOpenTicket } from "../components/paneContext";
import { TicketSettings } from "../components/TicketSettings";

export function TicketDetails({ ticket }: { ticket: Ticket }) {
  const { state, client } = useStore();
  const openTicket = useOpenTicket();
  const act = useAction();
  const now = useNow();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);

  // Follow server-side changes unless the user is mid-edit.
  useEffect(() => {
    setTitle(ticket.title);
  }, [ticket.title]);
  useEffect(() => {
    setDescription(ticket.description);
  }, [ticket.description]);

  // The detail's dependents (done ones may not be loaded) merged with live ones.
  const dependents = useMemo(() => dependentsOf(state, ticket), [state.tickets, state.dependents, state.keyAliases, ticket]);
  const runs = useMemo(
    () => Object.values(state.runs).filter((r) => r.sessionId === ticket.sessionId).sort((a, b) => b.createdAt - a.createdAt),
    [state.runs, ticket.sessionId],
  );
  const editable = ticket.status !== "done";
  const project = state.projects[ticket.projectId];

  const open = (key: string) => openTicket(key);

  const saveTitle = () => {
    if (title.trim() && title !== ticket.title) void act(() => client.updateTicket(ticket.key, { title: title.trim() }));
  };
  const descDirty = description !== ticket.description;
  const saveDescription = () => void act(() => client.updateTicket(ticket.key, { description }), "Saved");

  return (
    <div className="details">
      <div className="field">
        <label>Title</label>
        <input
          className="input"
          value={title}
          disabled={!editable}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
      </div>
      <div className="field">
        <label>{ticket.status === "planning" ? "Plan / brief" : "Brief"}</label>
        <textarea
          className="textarea mono-ish"
          rows={Math.min(18, Math.max(5, description.split("\n").length + 1))}
          value={description}
          disabled={!editable}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && descDirty && saveDescription()}
        />
        {descDirty && (
          <div className="row">
            <span className="field-hint grow">Unsaved changes</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setDescription(ticket.description)}>
              Revert
            </button>
            <button className="btn btn-sm btn-primary" onClick={saveDescription}>
              Save
            </button>
          </div>
        )}
      </div>

      {/* The settings rows (the same ones a draft's Options shows), then what's read-only. */}
      <TicketSettings ticket={ticket} project={project} onPatch={(patch) => void act(() => client.updateTicket(ticket.key, patch))}>
        {dependents.length > 0 && (
          <>
            <dt>Blocks</dt>
            <dd className="stack">
              {dependents.map((c) =>
                c.ticket ? (
                  <TicketLink key={c.key} t={c.ticket} onOpen={open} />
                ) : (
                  <span key={c.key} className="ticket-link muted mono" title={`Looking up ${c.key}…`}>
                    {c.key}
                  </span>
                ),
              )}
            </dd>
          </>
        )}
        <dt>Workdir</dt>
        <dd className="mono selectable">{ticket.workdir ?? <span className="muted">Not prepared yet</span>}</dd>
        {ticket.externalRef && (
          <>
            <dt>External</dt>
            <dd>
              {ticket.externalRef.url ? (
                <a onClick={() => void window.harness?.openExternal(ticket.externalRef!.url!)}>
                  {ticket.externalRef.key} <Icon name="external" size={11} />
                </a>
              ) : (
                ticket.externalRef.key
              )}
              <span className="muted"> · via {ticket.externalRef.source}</span>
            </dd>
          </>
        )}
        <dt>Allowed tools</dt>
        <dd>
          {ticket.allowedTools.length ? (
            <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
              {ticket.allowedTools.map((tool) => (
                <span key={tool} className="chip done" title={`${tool} runs without asking on this ticket`}>
                  <Icon name="check" size={9} strokeWidth={3} />
                  {tool}
                </span>
              ))}
            </div>
          ) : (
            <span className="muted">None granted</span>
          )}
        </dd>
        <dt>Auto-start</dt>
        <dd>{ticket.autoStart ? "When dependencies are done" : <span className="muted">Off</span>}</dd>
        <dt>Created</dt>
        <dd title={new Date(ticket.createdAt).toLocaleString()}>{relativeTime(ticket.createdAt, now)}</dd>
        <dt>Updated</dt>
        <dd title={new Date(ticket.updatedAt).toLocaleString()}>{relativeTime(ticket.updatedAt, now)}</dd>
      </TicketSettings>

      {runs.length > 0 && (
        <>
          <div className="section-title" style={{ margin: "18px 0 8px" }}>
            Runs
          </div>
          <div className="runs card-surface">
            {runs.map((r) => (
              <div key={r.id} className="run-row">
                <span className={`run-status run-${r.status}`}>{r.status === "running" || r.status === "queued" ? <span className="spinner" /> : null}{r.status}</span>
                <span className="run-kind">{r.kind}</span>
                <span className="muted">{driverLabel(r.driver, state.drivers)}</span>
                <span className="grow truncate muted" title={r.error ?? r.prompt}>
                  {r.error ? <span style={{ color: "var(--red)" }}>{r.error}</span> : r.prompt.split("\n")[0]}
                </span>
                <span className="muted run-time">
                  {r.startedAt && r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : relativeTime(r.createdAt, now)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TicketLink({ t, onOpen }: { t: Ticket; onOpen: (key: string) => void }) {
  return (
    <button className="ticket-link" onClick={() => onOpen(t.key)}>
      <StatusDot status={t.status} />
      <span className="mono">{t.key}</span>
      <span className="truncate">{t.title}</span>
    </button>
  );
}
