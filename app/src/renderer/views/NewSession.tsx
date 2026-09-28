import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode, TicketKind } from "@harness/shared";
import { resolvePermissionMode } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { composerProject, inheritedModel, newSessionPlaceholder, sortedProjects } from "@harness/shared/state";
import { MOD, Modal, Switch } from "../components/bits";
import { ModelSelect } from "../components/ModelSelect";
import { PermissionModeSelect } from "../components/PermissionModeSelect";
import { ProjectKey } from "../components/ProjectKey";
import { MentionTextarea } from "../components/MentionTextarea";

const LAST_PROJECT = "harness.lastProject";
const ADD_PROJECT = "__add";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export function NewSessionModal({ onClose, initialProjectId = null }: { onClose: () => void; initialProjectId?: string | null }) {
  const { state, client, route, navigate } = useStore();
  const act = useAction();
  const projects = sortedProjects(state);
  const routeProject = route.view === "board" ? route.projectId : null;
  const [chosen, setProjectId] = useState(initialProjectId ?? "");
  // Derived, not stored: stays valid when projects load after mount or the chosen one is deleted.
  const projectId = composerProject(state, chosen, [routeProject, readLast()]);
  const [prompt, setPrompt] = useState("");
  const [start, setStart] = useState(true);
  const [kind, setKind] = useState<TicketKind>("task");
  const project = state.projects[projectId];
  const defaultDriver = project?.defaultDriver ?? state.settings?.defaultDriver ?? state.drivers[0]?.id ?? "";
  const [driver, setDriver] = useState(defaultDriver);
  // null = inherit (project → settings → driver default). Model ids are per driver: reset on switch.
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => setModel(null), [driver]);
  // null = inherit (project → settings)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const inheritedMode = resolvePermissionMode(null, project, state.settings ?? { permissionMode: "auto" }).mode;
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => (projectId ? client.projectFiles(projectId, q) : Promise.resolve([])), [client, projectId]);

  // Driver follows the project default until the user picks one explicitly.
  const touchedDriver = useRef(false);
  useEffect(() => {
    if (!touchedDriver.current) setDriver(defaultDriver);
  }, [defaultDriver]);

  // Same for the worktree switch, which only shows for git projects (elsewhere there's no worktree to make).
  const projectWorktrees = project?.useWorktrees ?? true;
  const [worktree, setWorktree] = useState(projectWorktrees);
  const touchedWorktree = useRef(false);
  useEffect(() => {
    if (!touchedWorktree.current) setWorktree(projectWorktrees);
  }, [projectWorktrees]);
  const canWorktree = project?.isGit !== false;

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
    const useWorktree = canWorktree ? worktree : null;
    const t = await act(() => client.createTicket({ projectId, prompt: prompt.trim(), start, kind, driver: driver || undefined, model, permissionMode, useWorktree }));
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
          {project && <ProjectKey project={project} />}
          <select
            className="select bare"
            value={projectId}
            onChange={(e) => {
              // The last option adds a project; the select stays controlled, so it snaps back until one is added.
              if (e.target.value === ADD_PROJECT) void addProject();
              else setProjectId(e.target.value);
            }}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.key})
              </option>
            ))}
            <option value={ADD_PROJECT}>Add project…</option>
          </select>
        </div>
      </div>
      <div className="modal-body">
        <MentionTextarea
          ref={ref}
          autoFocus
          className="new-session-prompt"
          placeholder={newSessionPlaceholder(kind, start)}
          value={prompt}
          onValueChange={setPrompt}
          search={searchFiles}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="modal-foot new-session-foot">
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
        <ModelSelect compact driver={driver} value={model} onChange={setModel} inherited={inheritedModel(driver, "ticket", project, state.settings)} />
        <PermissionModeSelect compact value={permissionMode} inherited={inheritedMode} onChange={setPermissionMode} />
        <div className="new-session-actions">
          <div className="new-session-options">
            <Switch checked={start} onChange={setStart} label="Start immediately" />
            {canWorktree && (
              <Switch
                checked={worktree}
                onChange={(v) => {
                  touchedWorktree.current = true;
                  setWorktree(v);
                }}
                label="Use worktree"
                title="Off: the agent works directly in the project directory"
              />
            )}
          </div>
          <button className="btn btn-primary" disabled={!prompt.trim() || !projectId || busy} onClick={submit}>
            {busy ? <span className="spinner" /> : null}
            {start ? "Start session" : "Plan first"}
            <span className="kbd">{MOD}↩</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
