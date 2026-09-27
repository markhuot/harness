import { useEffect, useRef, useState } from "react";
import type { TicketKind } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { composerProject, sortedProjects } from "../state/reducer";
import { Icon } from "../components/Icon";
import { MOD, Modal, Switch } from "../components/bits";

const LAST_PROJECT = "harness.lastProject";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export function NewSessionModal({ onClose }: { onClose: () => void }) {
  const { state, client, route, navigate } = useStore();
  const act = useAction();
  const projects = sortedProjects(state);
  const routeProject = route.view === "board" ? route.projectId : null;
  const [chosen, setProjectId] = useState("");
  // Derived, not stored: stays valid when projects load after mount or the chosen one is deleted.
  const projectId = composerProject(state, chosen, [routeProject, readLast()]);
  const [prompt, setPrompt] = useState("");
  const [start, setStart] = useState(true);
  const [kind, setKind] = useState<TicketKind>("task");
  const project = state.projects[projectId];
  const defaultDriver = project?.defaultDriver ?? state.settings?.defaultDriver ?? state.drivers[0]?.id ?? "";
  const [driver, setDriver] = useState(defaultDriver);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Driver follows the project default until the user picks one explicitly.
  const touchedDriver = useRef(false);
  useEffect(() => {
    if (!touchedDriver.current) setDriver(defaultDriver);
  }, [defaultDriver]);

  const addProject = async () => {
    const path = await window.harness?.pickDirectory();
    if (!path) return;
    const p = await act(() => client.createProject({ path }));
    if (p) setProjectId(p.id);
    ref.current?.focus();
  };

  const submit = async () => {
    if (!prompt.trim() || !projectId || busy) return;
    setBusy(true);
    const t = await act(() => client.createTicket({ projectId, prompt: prompt.trim(), start, kind, driver: driver || undefined }));
    setBusy(false);
    if (!t) return;
    try {
      localStorage.setItem(LAST_PROJECT, projectId);
    } catch {}
    onClose();
    navigate({ view: "board", projectId: routeProject, ticketKey: t.key, tab: start ? "transcript" : "summaries" });
  };

  return (
    <Modal onClose={onClose} width={680}>
      <div className="modal-head new-session-head">
        <div className="project-picker">
          {project && <span className="project-key">{project.key.slice(0, 3)}</span>}
          <select className="select bare" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.key})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={addProject}>
          <Icon name="folder" /> Add project…
        </button>
        <div className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          New session
        </span>
      </div>
      <div className="modal-body">
        <textarea
          ref={ref}
          autoFocus
          className="new-session-prompt"
          placeholder={
            kind === "conductor"
              ? "Describe a larger job. The conductor splits it into tickets and steers them…"
              : start
                ? "What should the agent do?"
                : "What do you want to plan? The agent drafts a plan for you to refine…"
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="modal-foot">
        <div className="segmented">
          <button className={kind === "task" ? "on" : ""} onClick={() => setKind("task")}>
            Task
          </button>
          <button className={kind === "conductor" ? "on" : ""} onClick={() => setKind("conductor")} title="Orchestrates child tickets">
            Conductor
          </button>
        </div>
        <select
          className="select"
          style={{ width: "auto", minHeight: 26, height: 26, fontSize: 12 }}
          value={driver}
          onChange={(e) => {
            touchedDriver.current = true;
            setDriver(e.target.value);
          }}
        >
          {state.drivers.map((d) => (
            <option key={d.id} value={d.id} disabled={!d.available}>
              {d.name}
              {!d.authenticated ? " · not signed in" : ""}
            </option>
          ))}
        </select>
        <div className="grow" />
        <Switch checked={start} onChange={setStart} label="Start immediately" />
        <button className="btn btn-primary" disabled={!prompt.trim() || !projectId || busy} onClick={submit}>
          {busy ? <span className="spinner" /> : null}
          {start ? "Start session" : "Plan first"}
          <span className="kbd">{MOD}↩</span>
        </button>
      </div>
    </Modal>
  );
}
