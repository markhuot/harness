// Settings: appearance, drivers, general run settings, watchers, mappings, and the project list
// (each project's own settings live on its Project settings screen).

import { useEffect, useState, type ReactNode } from "react";
import type { DriverInfo, Project, PublicSettings, Settings, Watcher } from "@harness/shared";
import { watcherCommandLine } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { sortedProjects } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import "./settings.css";
import { relativeTime, Switch } from "../components/bits";
import { ModelsSection } from "./settings/ModelSettings";
import { PermissionsSection } from "./settings/PermissionSettings";
import { NetworkSection } from "./settings/NetworkSettings";
import { AppearanceSection } from "./settings/AppearanceSettings";

const SECTIONS = [
  ["appearance", "Appearance"],
  ["drivers", "Drivers"],
  ["general", "General"],
  ["models", "Models"],
  ["permissions", "Permissions"],
  ["network", "Network"],
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
          <AppearanceSection />
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
          {state.settings && <ModelsSection settings={state.settings} />}
          {state.settings && <PermissionsSection settings={state.settings} />}
          {state.settings && <NetworkSection settings={state.settings} />}
          <WatchersSection />
          <MappingsSection />
          <ProjectsSection />
        </div>
      </div>
    </div>
  );
}

export function Section({ id, title, desc, actions, children }: { id: string; title: string; desc?: ReactNode; actions?: ReactNode; children: ReactNode }) {
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

export function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
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
export function DraftInput({ value, onCommit, placeholder, type = "text", className = "input" }: { value: string; onCommit: (v: string) => void; placeholder?: string; type?: string; className?: string }) {
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
        <div className="section-title">Anthropic API</div>
      </div>
      <div className="card-surface settings-card">
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
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: number;
  enabled: boolean;
  driver: string;
}

const emptyWatcher: WatcherDraft = { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: 300, enabled: true, driver: "" };

function toDraft(w: Watcher): WatcherDraft {
  return { name: w.name, command: watcherCommandLine(w), prompt: w.prompt ?? "", cwd: w.cwd ?? "", mode: w.mode, intervalSec: w.intervalSec, enabled: w.enabled, driver: w.driver ?? "" };
}

function fromDraft(d: WatcherDraft): Partial<Watcher> & { name: string; command: string } {
  return {
    name: d.name.trim(),
    // Always saved as a shell command line, which converts legacy direct-exec watchers
    command: d.command.trim(),
    args: [],
    prompt: d.prompt.trim(),
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
        <div className="field span-2">
          <label>Command</label>
          <textarea
            className="textarea mono"
            rows={2}
            value={d.command}
            placeholder={"~/Sites/Jira/watch-jira.js\nwhile true; do curl -s https://example.com/events; sleep 60; done"}
            onChange={(e) => set("command", e.target.value)}
          />
          <div className="field-hint">Runs in your login shell, so pipes, PATH and loops work. Whatever it prints shows up in the Inbox.</div>
        </div>
        <div className="field span-2">
          <label>Prompt</label>
          <textarea
            className="textarea"
            rows={2}
            value={d.prompt}
            placeholder="If this event is assigned to me and has actionable next steps, dispatch it to an agent."
            onChange={(e) => set("prompt", e.target.value)}
          />
          <div className="field-hint">Optional. Tells triage what to do with this watcher's output.</div>
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
      desc="Any command that prints text, plus a prompt. Whatever it prints opens a triage session in the Inbox with that prompt."
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
            Add a command whose output should be triaged, like watch-jira or a curl loop.
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
              <Switch ariaLabel={`Enable ${w.name}`} checked={w.enabled} onChange={(v) => void act(() => client.updateWatcher(w.id, { enabled: v }))} />
              <div className="settings-row-main">
                <div className="settings-row-title">
                  {w.name}
                  <span className="badge">{w.mode === "loop" ? "Loop" : `Every ${w.intervalSec}s`}</span>
                  {!w.enabled && <span className="badge badge-outline">Paused</span>}
                </div>
                <div className="settings-row-sub mono" title={watcherCommandLine(w)}>
                  {watcherCommandLine(w)}
                </div>
                {w.prompt && (
                  <div className="settings-row-sub" title={w.prompt}>
                    {w.prompt}
                  </div>
                )}
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
    <Section id="mappings" title="Mappings" desc="Routing hints for triage. Keys in watcher output that match a mapping are pointed out to triage with their project. A key prefix (FOO matches FOO-123) or /regex/. Longest prefix wins.">
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
// Projects: a directory; per-project settings live on #/project/<id>/settings
// ---------------------------------------------------------------------------

function ProjectsSection() {
  const { state, navigate } = useStore();
  const projects = sortedProjects(state);
  const driverName = (p: Project) => (p.defaultDriver ? (state.drivers.find((d) => d.id === p.defaultDriver)?.name ?? p.defaultDriver) : null);
  return (
    <Section id="projects" title="Projects" desc="Name, identifier, folder, driver and review settings are set per project.">
      <div className="card-surface settings-card">
        {projects.length === 0 && <div className="empty">No projects yet. Add one from the sidebar.</div>}
        {projects.map((p) => (
          <button key={p.id} className="settings-row link" onClick={() => navigate({ view: "project", projectId: p.id })}>
            <span className="project-key lg">{p.key.slice(0, 3)}</span>
            <div className="settings-row-main">
              <div className="settings-row-title">
                {p.name}
                <span className="badge mono">{p.key}</span>
              </div>
              <div className="settings-row-sub mono" title={p.path}>
                {p.path.replace(/^\/Users\/[^/]+/, "~")}
                {driverName(p) && <span className="dim"> · {driverName(p)}</span>}
              </div>
            </div>
            <Icon name="chevronRight" size={14} />
          </button>
        ))}
      </div>
    </Section>
  );
}

