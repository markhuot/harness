// Settings: appearance, drivers (each with its own settings) and the default model, general run settings, prompts, watchers, and the project list
// (each project's own settings live on its Project settings screen).

import { useEffect, useState, type ReactNode } from "react";
import type { DriverInfo, ModelInfo, Project, PublicSettings, Settings, Watcher } from "@harness/shared";
import { DEFAULT_BASE_BRANCH, settingsWatcherChoice, settingsWatcherChoicePatch, watcherCommandLine, watcherDriver } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { modelName, sortedProjects } from "@harness/shared/state";
import { useDriverModels } from "../state/models";
import { DriverModelSelect } from "../components/ModelSelect";
import { emptyWatcher, fromDraft, noSettings, toDraft, watcherDefaultChoice, type TriageSettings, type WatcherDraft } from "./settings/watcherDraft";
import { Icon } from "../components/Icon";
import "./settings.css";
import { relativeTime, Switch } from "../components/bits";
import { ProjectKey } from "../components/ProjectKey";
import { DriversSection } from "./settings/DriverSettings";
import { PermissionsSection } from "./settings/PermissionSettings";
import { NetworkSection } from "./settings/NetworkSettings";
import { AppearanceSection } from "./settings/AppearanceSettings";
import { PromptsSection } from "./settings/PromptSettings";
import { ServiceSection } from "./settings/ServiceSettings";

/** The settings page's sections, in order ([id, label]); the ⌘K palette lists them too. */
export const SETTINGS_SECTIONS = [
  ["appearance", "Appearance"],
  ["drivers", "Drivers"],
  ["general", "General"],
  ["service", "Service"],
  ["permissions", "Permissions"],
  ["network", "Network"],
  ["prompts", "Prompts"],
  ["watchers", "Watchers"],
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
            {SETTINGS_SECTIONS.map(([id, label]) => (
              <button key={id} onClick={() => scrollTo(id)}>
                {label}
              </button>
            ))}
          </nav>
          <AppearanceSection />
          <DriversSection />
          {state.settings ? (
            <GeneralSection settings={state.settings} />
          ) : (
            <Section id="general" title="General">
              <div className="card-surface empty">
                <div className="spinner" />
                Loading settings…
              </div>
            </Section>
          )}
          <ServiceSection />
          {state.settings && <PermissionsSection settings={state.settings} />}
          {state.settings && <NetworkSection settings={state.settings} />}
          <PromptsSection />
          <WatchersSection />
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

function GeneralSection({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();

  const save = (body: Partial<Settings>) => act(() => client.updateSettings(body));

  return (
    <Section id="general" title="General">
      <div className="card-surface settings-card">
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
        <Row title="Base branch" sub="New ticket branches start from it, and finished tickets merge into it.">
          <DraftInput className="input mono" value={settings.baseBranch ?? DEFAULT_BASE_BRANCH} placeholder={DEFAULT_BASE_BRANCH} onCommit={(v) => void save({ baseBranch: v.trim() || DEFAULT_BASE_BRANCH })} />
        </Row>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

function driverLabel(drivers: DriverInfo[], id: string): string {
  return drivers.find((x) => x.id === id)?.name ?? id;
}

function WatcherForm({
  initial,
  settings,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  initial: WatcherDraft;
  settings: TriageSettings;
  onCancel: () => void;
  onSubmit: (d: WatcherDraft) => Promise<boolean>;
  submitLabel: string;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof WatcherDraft>(k: K, v: WatcherDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const valid = d.name.trim() && d.command.trim();
  const resolved = watcherDefaultChoice(settings);

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
            placeholder="If this event is assigned to me and has actionable next steps, dispatch it to the NYTIMES project."
            onChange={(e) => set("prompt", e.target.value)}
          />
          <div className="field-hint">Optional. Tells triage what to do with this watcher's output, including which project to dispatch it to.</div>
        </div>
        <div className="field">
          <label>Working directory</label>
          <input className="input mono" value={d.cwd} placeholder="Optional" onChange={(e) => set("cwd", e.target.value)} />
        </div>
        <div className="field" data-testid="watcher-model">
          <label>Model</label>
          <DriverModelSelect value={d.choice} resolved={resolved} onChange={(c) => set("choice", c)} />
          <div className="field-hint">Driver and model for this watcher's triage sessions.</div>
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
  const settings: TriageSettings = state.settings ?? noSettings;

  return (
    <Section
      id="watchers"
      title="Watchers"
      desc="Any command that prints text, plus a prompt. Whatever it prints opens a triage session in the Inbox with that prompt. The prompt names the project to dispatch to."
      actions={
        editing !== "new" && (
          <button className="btn btn-sm" onClick={() => setEditing("new")}>
            <Icon name="plus" size={12} /> Add watcher
          </button>
        )
      }
    >
      {state.settings && <WatcherDefaults settings={state.settings} />}
      <div className="card-surface settings-card">
        {editing === "new" && (
          <WatcherForm
            initial={emptyWatcher}
            settings={settings}
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
              initial={toDraft(w, settings)}
              settings={settings}
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
                  <WatcherTriageLabel watcher={w} settings={settings} drivers={state.drivers} /> · last run {relativeTime(w.lastRunAt)}
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

/** "Claude Code · Opus": the driver a watcher triages on, plus the model when it or the watcher default picks one. */
function WatcherTriageLabel({ watcher, settings, drivers }: { watcher: Watcher; settings: TriageSettings; drivers: DriverInfo[] }) {
  const { client, epoch } = useStore();
  const driver = watcherDriver(watcher, settings);
  const model = driver ? (watcher.models?.[driver] || settings.watcherModels?.[driver] || null) : null;
  const { data } = useDriverModels(client, model ? driver : "", epoch);
  if (!driver) return <>Default driver</>;
  return (
    <>
      {driverLabel(drivers, driver)}
      {model && <> · {modelName(data?.models as ModelInfo[] | undefined, model)}</>}
    </>
  );
}

/** Driver + model for every watcher that doesn't pick its own. */
function WatcherDefaults({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  return (
    <div className="card-surface settings-card" style={{ marginBottom: 12 }} data-testid="watcher-defaults">
      <Row title="Default model" sub="Used by watchers that don't pick their own.">
        <DriverModelSelect
          value={settingsWatcherChoice(settings)}
          resolved={{ driver: settings.defaultDriver, model: settings.defaultModels[settings.defaultDriver] ?? null }}
          defaultLabel="Same as default"
          autoWidth
          onChange={(c) => void act(() => client.updateSettings(settingsWatcherChoicePatch(c, settings)))}
        />
      </Row>
    </div>
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
            <ProjectKey project={p} size="lg" />
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

