// Settings: appearance, drivers (each with its own settings) and the default model, general run settings, network, notifications, the browser's extensions, prompts, the chief of staff switches, and the project list
// (each project's own settings live on its Project settings screen).

import { useEffect, useState, type ReactNode } from "react";
import type { Project, PublicSettings, Settings } from "@harness/shared";
import { DEFAULT_BASE_BRANCH, DEFAULT_BROWSER_IDLE_TAB_MINUTES, DEFAULT_CONTEXT_GAUGE_LIMIT, MAX_BROWSER_IDLE_TAB_MINUTES} from "@harness/shared";
import { limitError, parseLimit } from "../state/contextGauge";
import { useAction, useStore } from "../state/store";
import { modelName, sortedProjects } from "@harness/shared/state";
import { useDriverModels } from "../state/models";
import { DriverModelSelect } from "../components/ModelSelect";
import { Icon } from "../components/Icon";
import "./settings.css";
import { relativeTime, Switch } from "../components/bits";
import { ProjectKey } from "../components/ProjectKey";
import { DriversSection } from "./settings/DriverSettings";
import { PermissionsSection } from "./settings/PermissionSettings";
import { NetworkSection } from "./settings/NetworkSettings";
import { NotificationsSection } from "./settings/NotificationSettings";
import { AppearanceSection } from "./settings/AppearanceSettings";
import { PromptsSection } from "./settings/PromptSettings";
import { ServiceSection } from "./settings/ServiceSettings";
import { ExtensionsSection } from "./settings/ExtensionSettings";

/** The settings page's sections, in order ([id, label]); the ⌘K palette lists them too. */
export const SETTINGS_SECTIONS = [
  ["appearance", "Appearance"],
  ["drivers", "Drivers"],
  ["general", "General"],
  ["service", "Service"],
  ["permissions", "Permissions"],
  ["network", "Network"],
  ["notifications", "Notifications"],
  ["extensions", "Extensions"],
  ["prompts", "Prompts"],
  ["cos", "Chief of staff"],
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
          {state.settings && <NotificationsSection settings={state.settings} />}
          <ExtensionsSection />
          <PromptsSection />
          {state.settings && <CosSection settings={state.settings} />}
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
  const { client, toast } = useStore();
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
        <Row title="Context gauge limit" sub="Tokens, 10k to 2M. The ticket header's gauge turns red past it. Also set from the gauge's menu.">
          <DraftInput
            value={String(settings.contextGaugeLimit ?? DEFAULT_CONTEXT_GAUGE_LIMIT)}
            onCommit={(v) => {
              const n = parseLimit(v);
              const bad = limitError(n);
              if (bad) toast(bad, "error");
              else save({ contextGaugeLimit: n });
            }}
          />
        </Row>
        <Row title="Suspend unused browser tabs after" sub="Minutes. Frees memory; pages reload when opened. 0 means never.">
          <DraftInput
            type="number"
            value={String(settings.browserIdleTabMinutes ?? DEFAULT_BROWSER_IDLE_TAB_MINUTES)}
            onCommit={(v) => {
              const n = Math.round(Number(v));
              if (v.trim() && Number.isFinite(n)) save({ browserIdleTabMinutes: Math.min(MAX_BROWSER_IDLE_TAB_MINUTES, Math.max(0, n)) });
            }}
          />
        </Row>
        <Row title="Save files on blur" sub="The file viewer saves your edits when the editor, the pane or the app loses focus, and when a pane with edits closes. Off, you save with ⌘S or the Save button.">
          <Switch checked={settings.saveOnBlur ?? false} ariaLabel="Save files on blur" onChange={(v) => void save({ saveOnBlur: v })} />
        </Row>
        <Row title="Base branch" sub="New ticket branches start from it, and finished tickets merge into it.">
          <DraftInput className="input mono" value={settings.baseBranch ?? DEFAULT_BASE_BRANCH} placeholder={DEFAULT_BASE_BRANCH} onCommit={(v) => void save({ baseBranch: v.trim() || DEFAULT_BASE_BRANCH })} />
        </Row>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Chief of staff: the app's defaults; each project may override them (its own settings screen)
// ---------------------------------------------------------------------------

export const COS_SWITCHES = [
  { key: "cosEnabled", title: "Chief of staff enabled", sub: "Chiefs of staff triage ticket moves, watcher items and schedules for the projects they cover. Off, no chief gets events or runs.", fallback: true },
  { key: "cosCanUnblock", title: "Chief of staff can unblock tickets", sub: "A chief may answer a blocked ticket itself, learning from how you answered before. Off, it only tells you.", fallback: false },
] as const;

function CosSection({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  return (
    <Section id="cos" title="Chief of staff" desc="A chief of staff triages what happens on a board and acts on it. Each group, and All projects, has its own, switched on or off from the switch in its pane. A project can override these two.">
      <div className="card-surface settings-card">
        {COS_SWITCHES.map((s) => (
          <Row key={s.key} title={s.title} sub={s.sub}>
            <Switch checked={settings[s.key] ?? s.fallback} ariaLabel={s.title} onChange={(v) => void act(() => client.updateSettings({ [s.key]: v }))} />
          </Row>
        ))}
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

