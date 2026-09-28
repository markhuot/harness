// The ticket's "Agents" tab: sub-agents the agent started inside its session (DESIGN.md
// "Sub-agents"), and one sub-agent's own transcript ("agent:<id>" tab). Live from the store:
// the ticket detail brings the list, subagent.upserted keeps it current.

import { useEffect, useMemo, useState } from "react";
import type { Subagent, SubagentStatus, Ticket } from "@harness/shared";
import { groupSubagents, SUBAGENT_STATUS_LABEL, subagentById, subagentDuration, subagentPath, subagentsOf, subagentTitle, subagentTypeLabel, plainText } from "@harness/shared/state";
import { useStore } from "../state/store";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Transcript } from "./Transcript";
import "./agents.css";

/** Re-render every second while something is running, so durations tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function SubagentStatusMark({ status }: { status: SubagentStatus }) {
  if (status === "running") return <span className="spinner" title="Running" />;
  return (
    <span className="agent-status" data-status={status} title={SUBAGENT_STATUS_LABEL[status]}>
      <Icon name={status === "succeeded" ? "check" : status === "failed" ? "x" : "stop"} size={11} strokeWidth={status === "stopped" ? 2 : 3} />
    </span>
  );
}

/** Only shown once the session has sub-agents (effectiveTab falls back to Summaries until then). */
export function AgentsTab({ ticket, onOpen }: { ticket: Ticket; onOpen: (subagentId: string) => void }) {
  const { state } = useStore();
  const list = subagentsOf(state, ticket.sessionId);
  const groups = useMemo(() => groupSubagents(list ?? []), [list]);
  const now = useNow(groups.running.length > 0);

  const sections: { id: string; label: string; items: Subagent[] }[] = [
    { id: "running", label: "Running", items: groups.running },
    { id: "finished", label: "Finished", items: groups.finished },
  ];
  return (
    <div className="agents-tab">
      {sections
        .filter((s) => s.items.length > 0)
        .map((s) => (
          <section key={s.id} className="children-group" data-group={s.id}>
            <div className="children-group-head">
              <span>{s.label}</span>
              <span className="column-count">{s.items.length}</span>
            </div>
            <div className="children-list card-surface">
              {s.items.map((a) => (
                <AgentRow key={a.id} agent={a} parent={a.parentId ? subagentById(state, ticket.sessionId, a.parentId) : null} now={now} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

function AgentRow({ agent: a, parent, now, onOpen }: { agent: Subagent; parent: Subagent | null; now: number; onOpen: (id: string) => void }) {
  const type = subagentTypeLabel(a);
  const preview = a.status !== "running" && a.result ? a.result : a.prompt;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`child-row agent-row ${a.status !== "running" ? "is-done" : ""}`}
      data-agent={a.id}
      data-status={a.status}
      onClick={() => onOpen(a.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(a.id))}
    >
      <div className="child-main">
        <div className="child-top">
          <SubagentStatusMark status={a.status} />
          <span className="child-title">{subagentTitle(a)}</span>
          {type && <span className="badge badge-outline mono">{type}</span>}
          <span className="agent-time" title={`${SUBAGENT_STATUS_LABEL[a.status]} · started ${new Date(a.startedAt).toLocaleTimeString()}`}>
            {subagentDuration(a, now)}
          </span>
          <Icon name="chevronRight" size={12} className="agent-go" />
        </div>
        {preview && <div className="child-summary">{plainText(preview)}</div>}
        {parent && (
          <div className="agent-via">
            <Icon name="bot" size={10} /> started by {subagentTitle(parent)}
          </div>
        )}
      </div>
    </div>
  );
}

/** One sub-agent: where it sits (Agents › parent › it), its task, and its transcript. */
export function SubagentView({ ticket, subagentId, onBack, onOpen }: { ticket: Ticket; subagentId: string; onBack: () => void; onOpen: (id: string) => void }) {
  const { state } = useStore();
  const agent = subagentById(state, ticket.sessionId, subagentId);
  const path = subagentPath(state, ticket.sessionId, subagentId);
  const now = useNow(agent?.status === "running");
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <div className="agent-view">
      <div className="agent-head">
        <nav className="agent-crumbs">
          <button className="btn btn-ghost btn-sm" onClick={onBack} data-testid="agents-back">
            <Icon name="chevronLeft" size={12} /> Agents
          </button>
          {path.slice(0, -1).map((p) => (
            <span key={p.id} className="agent-crumb">
              <Icon name="chevronRight" size={10} />
              <button className="link" onClick={() => onOpen(p.id)}>
                {subagentTitle(p)}
              </button>
            </span>
          ))}
        </nav>
        {agent ? (
          <div className="agent-title">
            <SubagentStatusMark status={agent.status} />
            <strong className="truncate">{subagentTitle(agent)}</strong>
            {subagentTypeLabel(agent) && <span className="badge badge-outline mono">{subagentTypeLabel(agent)}</span>}
            <span className="grow" />
            <span className="agent-time">
              {SUBAGENT_STATUS_LABEL[agent.status]} · {subagentDuration(agent, now)}
            </span>
          </div>
        ) : (
          <div className="agent-title muted">Loading…</div>
        )}
      </div>
      <Transcript
        sessionId={ticket.sessionId}
        subagentId={subagentId}
        onOpenSubagent={onOpen}
        emptyHint="The sub-agent's conversation will stream in here."
        header={
          agent?.prompt ? (
            <div className={`agent-prompt ${promptOpen ? "open" : ""}`}>
              <button className="t-label agent-prompt-toggle" onClick={() => setPromptOpen(!promptOpen)}>
                <Icon name={promptOpen ? "chevronDown" : "chevronRight"} size={11} /> Task from the agent
              </button>
              <div className="agent-prompt-body selectable">
                <Markdown text={agent.prompt} />
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}
