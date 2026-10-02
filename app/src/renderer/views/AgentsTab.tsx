// The ticket's "Agents & tasks" tab: sub-agents the agent started inside its session and the
// background tasks it left running (DESIGN.md "Sub-agents", "Background tasks"), one sub-agent's
// own transcript, and one task's output ("agent:<id>" tab). Live from the store: the ticket detail
// brings the list, subagent.upserted keeps it current.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Subagent, SubagentStatus, Ticket } from "@harness/shared";
import {
  isTask,
  plainText,
  sortSubagents,
  SUBAGENT_STATUS_LABEL,
  subagentById,
  subagentDuration,
  subagentPath,
  subagentsOf,
  subagentTitle,
  subagentTypeLabel,
  TAB_LABEL,
  TASK_OUTPUT_POLL_MS,
  taskOutputOf,
} from "@harness/shared/state";
import { useStore } from "../state/store";
import { pollTaskOutput } from "../state/taskOutputPoll";
import { useStickToBottom } from "../components/stickToBottom";
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

/** Only shown once the session has sub-agents or tasks (effectiveTab falls back to Spec until then). */
export function AgentsTab({ ticket, onOpen }: { ticket: Ticket; onOpen: (subagentId: string) => void }) {
  const { state } = useStore();
  const list = subagentsOf(state, ticket.sessionId);
  const sorted = useMemo(() => sortSubagents(list ?? []), [list]);
  const now = useNow(sorted.some((a) => a.status === "running"));

  return (
    <div className="agents-tab">
      <div className="children-list card-surface">
        {sorted.map((a) => (
          <AgentRow key={a.id} agent={a} parent={a.parentId ? subagentById(state, ticket.sessionId, a.parentId) : null} now={now} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function AgentRow({ agent: a, parent, now, onOpen }: { agent: Subagent; parent: Subagent | null; now: number; onOpen: (id: string) => void }) {
  const type = subagentTypeLabel(a);
  const task = isTask(a);
  // A task's command is its title or sits under it; an agent shows its task, then its report.
  const preview = a.status !== "running" && a.result ? a.result : task ? (a.description.trim() ? a.command : null) : a.prompt;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`child-row agent-row ${a.status !== "running" ? "is-done" : ""}`}
      data-agent={a.id}
      data-status={a.status}
      data-kind={a.kind ?? "agent"}
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
        {preview && <div className={`child-summary ${task && preview === a.command ? "mono" : ""}`}>{task ? preview : plainText(preview)}</div>}
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
            <Icon name="chevronLeft" size={12} /> {TAB_LABEL.agents}
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

/** One background task: its command, its output (polled while it runs) and how it ended. */
export function TaskView({ ticket, subagentId, onBack }: { ticket: Ticket; subagentId: string; onBack: () => void }) {
  const { state, client, dispatch, epoch } = useStore();
  const sessionId = ticket.sessionId;
  const task = subagentById(state, sessionId, subagentId);
  const output = taskOutputOf(state, sessionId, subagentId);
  const running = task?.status === "running";
  const now = useNow(running);
  const [error, setError] = useState<string | null>(null);

  // The poll asks whether it's still running at each read; a status change wakes it for the final read.
  const runningRef = useRef(running);
  runningRef.current = running;
  const poll = useRef<ReturnType<typeof pollTaskOutput> | null>(null);
  useEffect(() => {
    setError(null);
    const p = pollTaskOutput({
      read: (offset) => client.taskOutput(sessionId, subagentId, offset),
      running: () => runningRef.current,
      onOutput: (out) => {
        setError(null);
        dispatch({ type: "taskOutput", sessionId, subagentId, output: out });
      },
      onError: (e) => setError(e.message),
      intervalMs: TASK_OUTPUT_POLL_MS,
    });
    poll.current = p;
    return () => p.stop();
  }, [client, dispatch, sessionId, subagentId, epoch]);
  useEffect(() => poll.current?.wake(), [running]);

  const scroller = useStickToBottom<HTMLDivElement>();
  const empty = !output?.text;

  return (
    <div className="agent-view task-view">
      <div className="agent-head">
        <nav className="agent-crumbs">
          <button className="btn btn-ghost btn-sm" onClick={onBack} data-testid="agents-back">
            <Icon name="chevronLeft" size={12} /> {TAB_LABEL.agents}
          </button>
        </nav>
        {task ? (
          <div className="agent-title">
            <SubagentStatusMark status={task.status} />
            <strong className="truncate">{subagentTitle(task)}</strong>
            {subagentTypeLabel(task) && <span className="badge badge-outline mono">{subagentTypeLabel(task)}</span>}
            <span className="grow" />
            <span className="agent-time">
              {SUBAGENT_STATUS_LABEL[task.status]} · {subagentDuration(task, now)}
            </span>
          </div>
        ) : (
          <div className="agent-title muted">Loading…</div>
        )}
        {task?.command && <pre className="task-command selectable">{task.command}</pre>}
      </div>
      <div className="task-output" ref={scroller} data-state={output ? (output.available ? (empty ? "empty" : "text") : "unavailable") : "loading"}>
        {output?.truncated && <div className="task-note">Showing the latest output only</div>}
        {error && (
          <div className="t-error">
            <Icon name="alert" /> Couldn't read the output: {error}
          </div>
        )}
        {!output && !error && (
          <div className="empty">
            <div className="spinner" />
          </div>
        )}
        {output && !output.available && empty && <div className="task-note">Output isn't available</div>}
        {output?.available && empty && (running ? <div className="task-note">Waiting for output…</div> : <div className="task-note">No output</div>)}
        {!empty && <pre className="task-output-text selectable">{output!.text}</pre>}
      </div>
      {task?.result && (
        <div className="task-result selectable">
          <div className="t-label">Result</div>
          <Markdown text={task.result} />
        </div>
      )}
    </div>
  );
}
