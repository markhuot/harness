// Project settings (#/project/<id>/settings): everything that belongs to one project — name,
// identifier (ticket key prefix), folder, default driver, worktrees, human review, delete.

import { useEffect, useMemo, useState } from "react";
import type { DriverInfo, Project } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { previewProjectKey, tildify } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Switch } from "../components/bits";
import { DraftInput, Row, Section } from "./Settings";
import "./settings.css";
import { ProjectModelRows } from "./settings/ModelSettings";
import { ProjectPermissionRow } from "./settings/PermissionSettings";

export function ProjectSettingsView() {
  const { state, route, navigate } = useStore();
  const project = route.view === "project" ? state.projects[route.projectId] : undefined;

  if (!project) {
    return (
      <div className="view">
        <div className="view-header">
          <div className="view-title">Project settings</div>
        </div>
        <div className="empty" style={{ flex: 1 }}>
          <Icon name="folder" />
          <strong>This project no longer exists</strong>
          <button className="btn btn-sm" onClick={() => navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" })}>
            Back to all projects
          </button>
        </div>
      </div>
    );
  }
  return <ProjectSettings key={project.id} project={project} />;
}

function ProjectSettings({ project }: { project: Project }) {
  const { state, client, navigate } = useStore();
  const act = useAction();
  const save = (body: Parameters<typeof client.updateProject>[1], ok?: string) => act(() => client.updateProject(project.id, body), ok);
  const tickets = Object.values(state.tickets).filter((t) => t.projectId === project.id);
  const openBoard = () => navigate({ view: "board", projectId: project.id, ticketKey: null, tab: "summaries" });

  const changePath = async () => {
    const path = await window.harness?.pickDirectory({ title: `Move ${project.name}`, buttonLabel: "Use this folder", defaultPath: project.path });
    if (path && path !== project.path) await save({ path }, "Project folder updated");
  };

  const remove = async () => {
    const n = tickets.length;
    const what = n ? `its ${n} ticket${n === 1 ? "" : "s"} and their transcripts` : "the project";
    if (!confirm(`Remove ${project.name} (${project.key}) from Harness?\n\nThis deletes ${what}. Files on disk, branches and worktrees are left alone.`)) return;
    const ok = await act(() => client.deleteProject(project.id), "Project removed");
    if (ok) navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" });
  };

  return (
    <div className="view project-settings">
      <div className="view-header">
        <button className="btn btn-ghost btn-sm" onClick={openBoard} title="Back to the board">
          <Icon name="chevronLeft" size={13} />
          Board
        </button>
        <div className="view-title">
          <span className="project-key lg">{project.key.slice(0, 3)}</span>
          {project.name}
          <span className="muted" style={{ fontWeight: 400 }}>
            Project settings
          </span>
        </div>
      </div>
      <div className="view-body">
        <div className="settings-col">
          <Section id="project-general" title="General">
            <div className="card-surface settings-card">
              <Row title="Name" sub="Shown in the sidebar and on the board.">
                <DraftInput value={project.name} onCommit={(v) => v.trim() && void save({ name: v.trim() })} />
              </Row>
              <KeyRow project={project} />
              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-title">Folder</div>
                  <div className="settings-row-sub mono selectable" title={project.path}>
                    {tildify(project.path)}
                  </div>
                </div>
                <div className="settings-row-actions">
                  <button className="btn btn-sm" onClick={() => void window.harness?.revealInFinder(project.path)} disabled={!window.harness}>
                    <Icon name="folder" size={12} />
                    Reveal in Finder
                  </button>
                  <button className="btn btn-sm" onClick={changePath} disabled={!window.harness}>
                    Change…
                  </button>
                </div>
              </div>
            </div>
          </Section>

          <Section id="project-agents" title="Agents">
            <div className="card-surface settings-card">
              <Row title="Default driver" sub="Used for new sessions in this project.">
                <DriverSelect value={project.defaultDriver} drivers={state.drivers} fallback={state.settings?.defaultDriver} onChange={(v) => void save({ defaultDriver: v })} />
              </Row>
              <ProjectModelRows project={project} save={save} />
              <ProjectPermissionRow project={project} save={save} />
              <Row title="Worktree per ticket" sub={<>Each ticket works on its own branch (harness/&lt;key&gt;) when the folder is a git repo.</>}>
                <Switch checked={project.useWorktrees} onChange={(v) => void save({ useWorktrees: v })} />
              </Row>
              <Row title="Require human review" sub="When off, the agent reviewer alone can clear a ticket for completion.">
                <Switch checked={project.requireHumanReview} onChange={(v) => void save({ requireHumanReview: v })} />
              </Row>
            </div>
          </Section>

          <Section id="project-danger" title="Danger zone">
            <div className="card-surface settings-card danger-card">
              <Row
                title="Remove project"
                sub={`Deletes ${tickets.length ? `${tickets.length} ticket${tickets.length === 1 ? "" : "s"} and their history` : "the project"} from Harness. Files on disk are left alone.`}
              >
                <button className="btn btn-sm btn-danger-solid" onClick={remove}>
                  <Icon name="trash" size={12} />
                  Remove project…
                </button>
              </Row>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function DriverSelect({ value, drivers, fallback, onChange }: { value: string | null; drivers: DriverInfo[]; fallback?: string; onChange: (v: string | null) => void }) {
  const fallbackName = drivers.find((d) => d.id === fallback)?.name ?? fallback;
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Global default{fallbackName ? ` (${fallbackName})` : ""}</option>
      {drivers.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

/** Identifier (ticket key prefix) with live validation and a rename preview. */
function KeyRow({ project }: { project: Project }) {
  const { state, client } = useStore();
  const act = useAction();
  const [draft, setDraft] = useState(project.key);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(project.key), [project.key]);

  const preview = useMemo(
    () => previewProjectKey(project, Object.values(state.projects), Object.values(state.tickets), draft),
    [project, state.projects, state.tickets, draft],
  );

  const commit = async () => {
    if (!preview.changed || preview.error || busy) return;
    setBusy(true);
    const n = preview.renames.length;
    await act(() => client.updateProject(project.id, { key: preview.key }), `Renamed to ${preview.key}${n ? ` · ${n} ticket${n === 1 ? "" : "s"} renumbered` : ""}`);
    setBusy(false);
  };

  const tone = preview.error ? "error" : preview.changed ? "change" : "";
  return (
    <div className="settings-row key-row">
      <div className="settings-row-main">
        <div className="settings-row-title">Identifier</div>
        <div className={`settings-row-sub key-preview ${tone}`} data-testid="key-preview">
          {preview.error && <Icon name="alert" size={11} />}
          {preview.message}
        </div>
      </div>
      <div className="settings-control key-control">
        <input
          className={`input mono key-input ${preview.error ? "invalid" : ""}`}
          value={draft}
          maxLength={20}
          spellCheck={false}
          aria-invalid={!!preview.error}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setDraft(project.key);
          }}
        />
        {preview.changed && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={() => setDraft(project.key)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={commit} disabled={!!preview.error || busy}>
              {busy && <span className="spinner" />}
              Rename
            </button>
          </>
        )}
      </div>
    </div>
  );
}
