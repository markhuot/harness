import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchInfo, PermissionMode, TicketKind, TriageChoice } from "@harness/shared";
import { resolveBaseBranch, resolvePermissionMode } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { composerProject, inheritedModel, newSessionPlaceholder, sortedProjects, tildify } from "@harness/shared/state";
import { MOD, Modal, Switch } from "../components/bits";
import { DriverModelSelect } from "../components/ModelSelect";
import { PermissionModeSelect } from "../components/PermissionModeSelect";
import { ProjectKey } from "../components/ProjectKey";
import { Icon } from "../components/Icon";
import { MentionTextarea } from "../components/MentionTextarea";
import { BranchSelect } from "../components/BranchSelect";
import { inheritedBaseLabel, newTicketBranchLabel, predictedTicketKey, ticketBranchHint } from "../components/branchPicker";

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
  // Driver + model in one pick. Default follows the project's driver and model (then the settings').
  const [choice, setChoice] = useState<TriageChoice>({ driver: null, model: null });
  // null = inherit (project → settings)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const inheritedMode = resolvePermissionMode(null, project, state.settings ?? { permissionMode: "auto" }).mode;
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => (projectId ? client.projectFiles(projectId, q) : Promise.resolve([])), [client, projectId]);

  // The worktree switch follows the project default until it's flipped. It only shows for git
  // projects (elsewhere there's no worktree to make).
  const projectWorktrees = project?.useWorktrees ?? true;
  const [worktree, setWorktree] = useState(projectWorktrees);
  const touchedWorktree = useRef(false);
  useEffect(() => {
    if (!touchedWorktree.current) setWorktree(projectWorktrees);
  }, [projectWorktrees]);
  const canWorktree = project?.isGit !== false;

  // Branch and base branch, for a git project whose ticket gets a worktree. null = the default
  // (harness/<key>; the project's / app's base). They reset when the project changes.
  const [branch, setBranch] = useState<{ name: string; info?: BranchInfo } | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  useEffect(() => {
    setBranch(null);
    setBaseBranch(null);
  }, [projectId]);
  const showBranches = !!project?.isGit && worktree;
  const nextKey = project ? predictedTicketKey(project, (k) => !!state.tickets[k]) : "";
  const inheritedBase = resolveBaseBranch(null, project, state.settings);
  const base = baseBranch ?? inheritedBase.branch;
  const branchHint = ticketBranchHint(branch?.name ?? null, branch?.info, base, tildify);

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
    const branches = showBranches ? { branch: branch?.name ?? null, baseBranch } : {};
    const t = await act(() =>
      client.createTicket({ projectId, prompt: prompt.trim(), start, kind, driver: choice.driver ?? (defaultDriver || undefined), model: choice.model, permissionMode, useWorktree, ...branches }),
    );
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
        <DriverModelSelect
          compact
          value={choice}
          onChange={setChoice}
          resolved={{ driver: defaultDriver || null, model: defaultDriver ? inheritedModel(defaultDriver, "ticket", project, state.settings) : null }}
        />
        <PermissionModeSelect compact value={permissionMode} inherited={inheritedMode} onChange={setPermissionMode} />
        {showBranches && (
          <div className="new-session-branches">
            <BranchSelect
              compact
              projectId={projectId}
              value={branch?.name ?? null}
              onChange={(name, info) => setBranch(name === null ? null : { name, info })}
              defaultLabel={newTicketBranchLabel(nextKey)}
              newLabel={(name) => `Create ${name} from ${base}`}
            />
            <span className="muted" title="The base branch: a new branch starts from it, and the work merges into it when the ticket completes">based on</span>
            <BranchSelect
              compact
              label="Base branch"
              projectId={projectId}
              value={baseBranch}
              onChange={(name) => setBaseBranch(name)}
              defaultLabel={inheritedBaseLabel(inheritedBase)}
              newLabel={(name) => `Use ${name}`}
            />
            <span className={`field-hint new-session-branch-hint ${branchHint.warn ? "warn" : ""}`}>
              {branchHint.warn && <Icon name="alert" size={11} />}
              {branchHint.text}
            </span>
          </div>
        )}
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
