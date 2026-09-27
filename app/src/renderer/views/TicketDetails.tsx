import { useEffect, useMemo, useState } from "react";
import type { Ticket } from "@harness/shared";
import { isTicketKey } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { childrenOf, dependencyStates } from "../state/reducer";
import { Icon } from "../components/Icon";
import { driverLabel, relativeTime, StatusDot, useNow } from "../components/bits";
import { ModelSelect } from "../components/ModelSelect";
import { inheritedModel } from "../state/models";

export function TicketDetails({ ticket }: { ticket: Ticket }) {
  const { state, client, navigate, route } = useStore();
  const act = useAction();
  const now = useNow();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [deps, setDeps] = useState(ticket.dependsOn.join(", "));

  // Follow server-side changes unless the user is mid-edit.
  useEffect(() => {
    setTitle(ticket.title);
  }, [ticket.title]);
  useEffect(() => {
    setDescription(ticket.description);
  }, [ticket.description]);
  useEffect(() => {
    setDeps(ticket.dependsOn.join(", "));
  }, [ticket.dependsOn.join(",")]);

  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const children = childrenOf(state, ticket.id);
  const dependents = useMemo(() => Object.values(state.tickets).filter((t) => t.dependsOn.includes(ticket.key)), [state.tickets, ticket.key]);
  const depStates = dependencyStates(state, ticket);
  const runs = useMemo(
    () => Object.values(state.runs).filter((r) => r.sessionId === ticket.sessionId).sort((a, b) => b.createdAt - a.createdAt),
    [state.runs, ticket.sessionId],
  );
  const editable = ticket.status !== "done";

  const open = (key: string) => navigate({ view: "board", projectId: route.view === "board" ? route.projectId : null, ticketKey: key, tab: "summaries" });

  const saveTitle = () => {
    if (title.trim() && title !== ticket.title) void act(() => client.updateTicket(ticket.key, { title: title.trim() }));
  };
  const descDirty = description !== ticket.description;
  const saveDescription = () => void act(() => client.updateTicket(ticket.key, { description }), "Saved");
  const parsedDeps = deps
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const badDeps = parsedDeps.filter((d) => !isTicketKey(d));
  const depsDirty = parsedDeps.join(",") !== ticket.dependsOn.join(",");
  const saveDeps = () => {
    if (!depsDirty || badDeps.length) return;
    void act(() => client.updateTicket(ticket.key, { dependsOn: parsedDeps }));
  };

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

      <div className="field">
        <label>Depends on</label>
        <input
          className="input mono"
          placeholder="e.g. NYTIMES-3, NYTIMES-4"
          value={deps}
          disabled={!editable}
          onChange={(e) => setDeps(e.target.value)}
          onBlur={saveDeps}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        {badDeps.length > 0 ? (
          <span className="field-hint" style={{ color: "var(--red)" }}>
            Not a ticket key: {badDeps.join(", ")}
          </span>
        ) : (
          depStates.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {depStates.map((d) => (
                <button key={d.key} className={`chip link-chip ${d.done ? "done" : "pending"}`} onClick={() => d.ticket && open(d.key)} disabled={!d.ticket}>
                  {d.ticket && <StatusDot status={d.ticket.status} />}
                  {d.key}
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <dl className="props">
        <dt>Driver</dt>
        <dd>
          <select
            className="select"
            value={ticket.driver}
            disabled={!editable || ticket.busy}
            onChange={(e) => void act(() => client.updateTicket(ticket.key, { driver: e.target.value }))}
          >
            {!state.drivers.some((d) => d.id === ticket.driver) && <option value={ticket.driver}>{ticket.driver}</option>}
            {state.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {!d.available ? " (unavailable)" : ""}
              </option>
            ))}
          </select>
        </dd>
        <dt>Model</dt>
        <dd title="Applies from the next run">
          <ModelSelect
            driver={ticket.driver}
            value={ticket.model}
            disabled={!editable}
            inherited={inheritedModel(ticket.driver, "ticket", state.projects[ticket.projectId], state.settings)}
            onChange={(m) => void act(() => client.updateTicket(ticket.key, { model: m }))}
          />
        </dd>
        {parent && (
          <>
            <dt>Conductor</dt>
            <dd>
              <TicketLink t={parent} onOpen={open} />
            </dd>
          </>
        )}
        {children.length > 0 && (
          <>
            <dt>Children</dt>
            <dd className="stack">
              {children.map((c) => (
                <TicketLink key={c.id} t={c} onOpen={open} />
              ))}
            </dd>
          </>
        )}
        {dependents.length > 0 && (
          <>
            <dt>Blocks</dt>
            <dd className="stack">
              {dependents.map((c) => (
                <TicketLink key={c.id} t={c} onOpen={open} />
              ))}
            </dd>
          </>
        )}
        <dt>Workdir</dt>
        <dd className="mono selectable">{ticket.workdir ?? <span className="muted">Not prepared yet</span>}</dd>
        {ticket.branch && (
          <>
            <dt>Branch</dt>
            <dd className="mono selectable">{ticket.branch}</dd>
          </>
        )}
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
            <span className="muted">Every tool asks first</span>
          )}
        </dd>
        <dt>Auto-start</dt>
        <dd>{ticket.autoStart ? "When dependencies are done" : <span className="muted">Off</span>}</dd>
        <dt>Created</dt>
        <dd title={new Date(ticket.createdAt).toLocaleString()}>{relativeTime(ticket.createdAt, now)}</dd>
        <dt>Updated</dt>
        <dd title={new Date(ticket.updatedAt).toLocaleString()}>{relativeTime(ticket.updatedAt, now)}</dd>
      </dl>

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
