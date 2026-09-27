// Settings: drivers, general run settings, watchers, mappings and projects.

import { useEffect, useState, type ReactNode } from "react";
import type { DriverInfo, Project, PublicSettings, Settings, Watcher } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { sortedProjects } from "../state/reducer";
import { Icon } from "../components/Icon";
import "./settings.css";
import { relativeTime } from "../components/bits";

const PERMISSION_MODES: Settings["claudePermissionMode"][] = ["bypassPermissions", "acceptEdits", "auto", "dontAsk"];

const SECTIONS = [
  ["drivers", "Drivers"],
  ["general", "General"],
  ["watchers", "Watchers"],
  ["mappings", "Mappings"],
  ["projects", "Projects"],
] as const;

function scrollTo(name: string) {
  document.getElementById(`settings-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SettingsView() {
  const { state, route } = useStore();
  const section = route.view === "settings" ? route.section : null;

  useEffect(() => {
    if (!section) return;
    const t = setTimeout(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [section]);

  return (
    <div className="view">
      <div className="view-header">
        <div className="view-title">Settings</div>
      </div>
      <div className="view-body">
        <div className="settings-col">
          <nav className="settings-nav">
            {SECTIONS.map(([id, label]) => (
              <button key={id} onClick={() => scrollTo(id)}>
                {label}
              </button>
            ))}
          </nav>
          <DriversSection />
          {state.settings ? (
            <GeneralSection settings={state.settings} drivers={state.drivers} />
          ) : (
            <Section id="general" title="General">
              <div className="card-surface empty">
                <div className="spinner" />
                Loading settings…
              </div>
            </Section>
          )}
          <WatchersSection />
          <MappingsSection />
          <ProjectsSection />
        </div>
      </div>
    </div>
  );
}

function Section({ id, title, desc, actions, children }: { id: string; title: string; desc?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" id={`settings-${id}`}>
      <div className="settings-section-head">
        <div className="section-title">{title}</div>
        {actions}
      </div>
      {desc && <div className="settings-section-desc">{desc}</div>}
      {children}
    </section>
  );
}

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-title">{title}</div>
        {sub && <div className="settings-row-sub">{sub}</div>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function driverBadge(d: DriverInfo) {
  if (!d.available) return <span className="badge badge-red">Unavailable</span>;
  if (!d.authenticated) return <span className="badge badge-amber">Not signed in</span>;
  return (
    <span className="badge badge-green">
      <Icon name="check" /> Ready
    </span>
  );
}

function DriversSection() {
  const { state, client, dispatch, epoch, toast } = useStore();
  const act = useAction();
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    setLoading(true);
    const drivers = await act(() => client.listDrivers());
    if (drivers) dispatch({ type: "drivers", drivers });
    setLoading(false);
  };

  useEffect(() => {
    if (epoch > 0) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  const login = async (d: DriverInfo) => {
    const res = await act(() => client.loginDriver(d.id));
    if (!res) return;
    if (res.url) await window.harness?.openExternal(res.url);
    if (res.message) toast(res.message, "info");
  };

  return (
    <Section
      id="drivers"
      title="Drivers"
      actions={
        <button className="btn btn-ghost btn-sm" onClick={reload} disabled={loading} title="Refresh drivers">
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          Refresh
        </button>
      }
    >
      <div className="card-surface settings-card">
        {state.drivers.length === 0 && <div className="empty">No drivers reported by the service.</div>}
        {state.drivers.map((d) => (
          <div className="settings-row" key={d.id}>
            <div className="settings-row-main">
              <div className="settings-row-title">
                {d.name}
                {driverBadge(d)}
                {state.settings?.defaultDriver === d.id && <span className="badge badge-accent">Default</span>}
              </div>
              <div className="settings-row-sub">{d.description}</div>
              {d.detail && <div className="settings-row-sub">{d.detail}</div>}
            </div>
            <div className="settings-row-actions">
              {d.supportsLogin && (
                <button className="btn btn-sm" onClick={() => login(d)}>
                  <Icon name="key" size={12} />
                  {d.authenticated ? "Log in again" : "Log in"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

/** Text input with a local draft that commits on blur / Enter. */
function DraftInput({ value, onCommit, placeholder, type = "text", className = "input" }: { value: string; onCommit: (v: string) => void; placeholder?: string; type?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className={className}
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

function GeneralSection({ settings, drivers }: { settings: PublicSettings; drivers: DriverInfo[] }) {
  const { client } = useStore();
  const act = useAction();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);

  const save = (body: Partial<Settings>) => act(() => client.updateSettings(body));

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    const ok = await act(() => client.updateSettings({ anthropicApiKey: apiKey.trim() }), "API key saved");
    if (ok) {
      setApiKey("");
      setReplacing(false);
    }
  };

  const driverOptions = drivers.some((d) => d.id === settings.defaultDriver) ? drivers : [...drivers, { id: settings.defaultDriver, name: settings.defaultDriver } as DriverInfo];

  return (
    <Section id="general" title="General">
      <div className="card-surface settings-card">
        <Row title="Default driver" sub="Used for new sessions unless the project overrides it.">
          <select className="select" value={settings.defaultDriver} onChange={(e) => save({ defaultDriver: e.target.value })}>
            {driverOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Max concurrent runs" sub="Agent runs across all sessions. Extra runs wait in the queue.">
          <DraftInput
            type="number"
            value={String(settings.maxConcurrentRuns)}
            onCommit={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n)) save({ maxConcurrentRuns: Math.min(32, Math.max(1, n)) });
            }}
          />
        </Row>
      </div>

      <div className="settings-section-head" style={{ marginTop: 20 }}>
        <div className="section-title">Claude Code</div>
      </div>
      <div className="card-surface settings-card">
        <Row title="Permission mode" sub="Passed to the claude CLI. Plan runs always use plan mode.">
          <select className="select" value={settings.claudePermissionMode} onChange={(e) => save({ claudePermissionMode: e.target.value as Settings["claudePermissionMode"] })}>
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Model" sub="Leave empty to use the CLI default.">
          <DraftInput value={settings.claudeModel ?? ""} placeholder="Default" className="input mono" onCommit={(v) => save({ claudeModel: v.trim() || null })} />
        </Row>
      </div>

      <div className="settings-section-head" style={{ marginTop: 20 }}>
        <div className="section-title">Anthropic API</div>
      </div>
      <div className="card-surface settings-card">
        <Row title="Model">
          <DraftInput value={settings.anthropicModel} className="input mono" onCommit={(v) => v.trim() && save({ anthropicModel: v.trim() })} />
        </Row>
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-title">API key</div>
            <div className="settings-row-sub">Stored by the service; falls back to ANTHROPIC_API_KEY.</div>
          </div>
          <div className="settings-control" style={{ width: 320 }}>
            {settings.anthropicApiKeySet && !replacing ? (
              <>
                <span className="settings-key-saved grow">
                  <Icon name="checkCircle" size={13} /> Key saved
                </span>
                <button className="btn btn-sm" onClick={() => setReplacing(true)}>
                  Replace
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => void act(() => client.updateSettings({ anthropicApiKey: null }), "API key cleared")}>
                  Clear
                </button>
              </>
            ) : (
              <>
                <input
                  className="input mono"
                  type="password"
                  placeholder="sk-ant-…"
                  value={apiKey}
                  autoFocus={replacing}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                    if (e.key === "Escape") setReplacing(false);
                  }}
                />
                <button className="btn btn-sm btn-primary" disabled={!apiKey.trim()} onClick={saveKey}>
                  Save
                </button>
                {replacing && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setReplacing(false)}>
                    Cancel
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

interface WatcherDraft {
  name: string;
  command: string;
  args: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: number;
  enabled: boolean;
  driver: string;
}

const emptyWatcher: WatcherDraft = { name: "", command: "", args: "", cwd: "", mode: "loop", intervalSec: 300, enabled: true, driver: "" };

function toDraft(w: Watcher): WatcherDraft {
  return { name: w.name, command: w.command, args: w.args.join("\n"), cwd: w.cwd ?? "", mode: w.mode, intervalSec: w.intervalSec, enabled: w.enabled, driver: w.driver ?? "" };
}

function fromDraft(d: WatcherDraft): Partial<Watcher> & { name: string; command: string } {
  return {
    name: d.name.trim(),
    command: d.command.trim(),
    args: d.args.split("\n").map((a) => a.trim()).filter(Boolean),
    cwd: d.cwd.trim() || null,
    mode: d.mode,
    intervalSec: Math.max(1, Math.round(d.intervalSec) || 60),
    enabled: d.enabled,
    driver: d.driver || null,
  };
}

function WatcherForm({ initial, drivers, onCancel, onSubmit, submitLabel }: { initial: WatcherDraft; drivers: DriverInfo[]; onCancel: () => void; onSubmit: (d: WatcherDraft) => Promise<boolean>; submitLabel: string }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof WatcherDraft>(k: K, v: WatcherDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const valid = d.name.trim() && d.command.trim();

  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        const ok = await onSubmit(d);
        setBusy(false);
        if (ok) onCancel();
      }}
    >
      <div className="settings-form-grid">
        <div className="field">
          <label>Name</label>
          <input className="input" value={d.name} autoFocus placeholder="jira" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label>Command</label>
          <input className="input mono" value={d.command} placeholder="node" onChange={(e) => set("command", e.target.value)} />
        </div>
        <div className="field span-2">
          <label>Arguments</label>
          <textarea className="textarea mono" rows={2} value={d.args} placeholder={"~/Sites/Jira/watch-jira.js"} onChange={(e) => set("args", e.target.value)} />
          <div className="field-hint">One argument per line. Executed without a shell; each line should print NDJSON work items.</div>
        </div>
        <div className="field">
          <label>Working directory</label>
          <input className="input mono" value={d.cwd} placeholder="Optional" onChange={(e) => set("cwd", e.target.value)} />
        </div>
        <div className="field">
          <label>Triage driver</label>
          <select className="select" value={d.driver} onChange={(e) => set("driver", e.target.value)}>
            <option value="">Default</option>
            {drivers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Mode</label>
          <div className="row">
            <div className="segmented">
              <button type="button" className={d.mode === "loop" ? "on" : ""} onClick={() => set("mode", "loop")}>
                Loop
              </button>
              <button type="button" className={d.mode === "interval" ? "on" : ""} onClick={() => set("mode", "interval")}>
                Interval
              </button>
            </div>
            {d.mode === "interval" && (
              <>
                <input className="input" type="number" min={1} style={{ width: 90 }} value={d.intervalSec} onChange={(e) => set("intervalSec", Number(e.target.value))} />
                <span className="muted">sec</span>
              </>
            )}
          </div>
          <div className="field-hint">{d.mode === "loop" ? "Re-runs as soon as the command exits." : "Runs on a fixed schedule."}</div>
        </div>
        <div className="field">
          <label>Enabled</label>
          <div className="row" style={{ height: 30 }}>
            <Switch checked={d.enabled} onChange={(v) => set("enabled", v)} label={d.enabled ? "On" : "Off"} />
          </div>
        </div>
      </div>
      <div className="settings-form-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {busy && <span className="spinner" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function WatchersSection() {
  const { state, client } = useStore();
  const act = useAction();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const watchers = Object.values(state.watchers).sort((a, b) => a.name.localeCompare(b.name));
  const driverName = (id: string | null) => (id ? (state.drivers.find((d) => d.id === id)?.name ?? id) : "Default driver");

  return (
    <Section
      id="watchers"
      title="Watchers"
      desc="Commands that emit work items. Each new item opens a triage session in the Inbox."
      actions={
        editing !== "new" && (
          <button className="btn btn-sm" onClick={() => setEditing("new")}>
            <Icon name="plus" size={12} /> Add watcher
          </button>
        )
      }
    >
      <div className="card-surface settings-card">
        {editing === "new" && (
          <WatcherForm
            initial={emptyWatcher}
            drivers={state.drivers}
            submitLabel="Create watcher"
            onCancel={() => setEditing(null)}
            onSubmit={async (d) => !!(await act(() => client.createWatcher(fromDraft(d)), "Watcher created"))}
          />
        )}
        {watchers.length === 0 && editing !== "new" && (
          <div className="empty">
            <Icon name="eye" />
            <strong>No watchers yet</strong>
            Add a command like watch-jira to feed work into triage.
          </div>
        )}
        {watchers.map((w) =>
          editing === w.id ? (
            <WatcherForm
              key={w.id}
              initial={toDraft(w)}
              drivers={state.drivers}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={async (d) => !!(await act(() => client.updateWatcher(w.id, fromDraft(d)), "Watcher saved"))}
            />
          ) : (
            <div className="settings-row" key={w.id}>
              <Switch checked={w.enabled} onChange={(v) => void act(() => client.updateWatcher(w.id, { enabled: v }))} />
              <div className="settings-row-main">
                <div className="settings-row-title">
                  {w.name}
                  <span className="badge">{w.mode === "loop" ? "Loop" : `Every ${w.intervalSec}s`}</span>
                  {!w.enabled && <span className="badge badge-outline">Paused</span>}
                </div>
                <div className="settings-row-sub mono" title={[w.command, ...w.args].join(" ")}>
                  {[w.command, ...w.args].join(" ")}
                </div>
                <div className="settings-row-sub">
                  {driverName(w.driver)} · last run {relativeTime(w.lastRunAt)}
                  {w.cwd && <> · in <span className="mono">{w.cwd}</span></>}
                </div>
                {w.lastError && <div className="settings-row-err">{w.lastError}</div>}
              </div>
              <div className="settings-row-actions">
                <button className="btn btn-sm" onClick={() => void act(() => client.runWatcher(w.id), "Watcher started")}>
                  <Icon name="play" size={11} /> Run now
                </button>
                <button className="btn btn-sm btn-ghost btn-icon" title="Edit" onClick={() => setEditing(w.id)}>
                  <Icon name="edit" size={13} />
                </button>
                <button
                  className="btn btn-sm btn-ghost btn-icon btn-danger"
                  title="Delete"
                  onClick={() => {
                    if (confirm(`Delete watcher “${w.name}”?`)) void act(() => client.deleteWatcher(w.id), "Watcher deleted");
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ),
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

function MappingsSection() {
  const { state, client } = useStore();
  const act = useAction();
  const projects = sortedProjects(state);
  const [pattern, setPattern] = useState("");
  const [projectId, setProjectId] = useState("");
  const [notes, setNotes] = useState("");
  const mappings = Object.values(state.mappings).sort((a, b) => a.pattern.localeCompare(b.pattern));
  const pid = projectId || projects[0]?.id || "";

  const add = async () => {
    if (!pattern.trim() || !pid) return;
    const ok = await act(() => client.createMapping({ pattern: pattern.trim(), projectId: pid, notes: notes.trim() }));
    if (ok) {
      setPattern("");
      setNotes("");
    }
  };

  return (
    <Section id="mappings" title="Mappings" desc="Route external ticket keys to local projects. A key prefix (FOO matches FOO-123) or /regex/. Longest prefix wins.">
      <div className="card-surface settings-card">
        {mappings.length > 0 && (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Project</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => {
                const p = state.projects[m.projectId];
                return (
                  <tr key={m.id}>
                    <td className="pattern">{m.pattern}</td>
                    <td>
                      {p ? (
                        <span className="row" style={{ gap: 6 }}>
                          <span className="badge mono">{p.key}</span>
                          {p.name}
                        </span>
                      ) : (
                        <span className="muted">Unknown project</span>
                      )}
                    </td>
                    <td className="dim">{m.notes || <span className="muted">—</span>}</td>
                    <td className="actions">
                      <button className="btn btn-sm btn-ghost btn-icon btn-danger" title="Delete mapping" onClick={() => void act(() => client.deleteMapping(m.id))}>
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {mappings.length === 0 && <div className="empty">No mappings. Triage will pick a project on its own.</div>}
        <form
          className="settings-add-row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input mono" style={{ width: 150 }} placeholder="FOO or /^FOO-\d+/" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <select className="select" style={{ width: 190 }} value={pid} onChange={(e) => setProjectId(e.target.value)} disabled={!projects.length}>
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
          <input className="input grow" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={!pattern.trim() || !pid}>
            Add
          </button>
        </form>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function ProjectRow({ p, drivers }: { p: Project; drivers: DriverInfo[] }) {
  const { client } = useStore();
  const act = useAction();
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-title">
          <span className="badge mono">{p.key}</span>
          {p.name}
        </div>
        <div className="settings-row-sub mono" title={p.path}>
          {p.path}
        </div>
        <div className="row" style={{ gap: 16, marginTop: 6 }}>
          <Switch checked={p.useWorktrees} onChange={(v) => void act(() => client.updateProject(p.id, { useWorktrees: v }))} label="Worktree per ticket" />
          <Switch checked={p.requireHumanReview} onChange={(v) => void act(() => client.updateProject(p.id, { requireHumanReview: v }))} label="Require human review" />
        </div>
      </div>
      <div className="settings-row-actions">
        <select className="select" style={{ width: 150, height: 28, minHeight: 28 }} value={p.defaultDriver ?? ""} onChange={(e) => void act(() => client.updateProject(p.id, { defaultDriver: e.target.value || null }))}>
          <option value="">Default driver</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm btn-ghost btn-icon btn-danger"
          title="Delete project"
          onClick={() => {
            if (confirm(`Delete project ${p.key}? Its tickets will be removed from the board.`)) void act(() => client.deleteProject(p.id), "Project deleted");
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}

function ProjectsSection() {
  const { state } = useStore();
  const projects = sortedProjects(state);
  return (
    <Section id="projects" title="Projects">
      <div className="card-surface settings-card">
        {projects.length === 0 && <div className="empty">No projects yet. Add one from the sidebar.</div>}
        {projects.map((p) => (
          <ProjectRow key={p.id} p={p} drivers={state.drivers} />
        ))}
      </div>
    </Section>
  );
}
