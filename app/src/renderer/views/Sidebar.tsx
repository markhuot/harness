import { useMemo, type Ref } from "react";
import type { Project } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { sortedProjects, triageSessions } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { MOD } from "../components/bits";
import { ProjectKey } from "../components/ProjectKey";

export function Sidebar({ onNewSession, collapsed = false, ref }: { onNewSession: (projectId?: string) => void; collapsed?: boolean; ref?: Ref<HTMLElement> }) {
  const { state, route, navigate, client } = useStore();
  const act = useAction();
  const projects = sortedProjects(state);

  const openCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of Object.values(state.tickets)) if (t.status !== "done") c[t.projectId] = (c[t.projectId] ?? 0) + 1;
    return c;
  }, [state.tickets]);
  const totalOpen = Object.values(openCounts).reduce((a, b) => a + b, 0);
  const triaging = triageSessions(state).filter((s) => s.triageStatus === "triaging" || s.busy).length;

  const addProject = async () => {
    const path = await window.harness?.pickDirectory();
    if (!path) return;
    const p = await act(() => client.createProject({ path }));
    if (p) navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "summaries" });
  };

  const onBoard = route.view === "board";
  const openSettings = (p: Project) => navigate({ view: "project", projectId: p.id });

  const removeProject = async (p: Project) => {
    // Done tickets page in, so ask the service how many there are.
    const mine = Object.values(state.tickets).filter((t) => t.projectId === p.id);
    const done = await client
      .ticketPage({ status: "done", projectId: p.id, limit: 1 })
      .then((page) => page.total)
      .catch(() => mine.filter((t) => t.status === "done").length);
    const n = mine.filter((t) => t.status !== "done").length + done;
    const what = n ? `its ${n} ticket${n === 1 ? "" : "s"} and their transcripts` : "the project";
    if (!confirm(`Remove ${p.name} (${p.key}) from Harness?\n\nThis deletes ${what}. Files on disk, branches and worktrees are left alone.`)) return;
    const ok = await act(() => client.deleteProject(p.id), "Project removed");
    if (ok && ((route.view === "board" && route.projectId === p.id) || (route.view === "project" && route.projectId === p.id))) {
      navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" });
    }
  };

  const projectMenu = async (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    const bridge = window.harness;
    // Outside Electron (plain browser dev) there's no native menu; settings is the useful default.
    if (!bridge?.showContextMenu) return openSettings(p);
    const choice = await bridge.showContextMenu([
      { id: "settings", label: "Project settings…" },
      { id: "new", label: `New session in ${p.name}` },
      { type: "separator" },
      { id: "reveal", label: "Reveal in Finder" },
      { type: "separator" },
      { id: "remove", label: "Remove project…" },
    ]);
    if (choice === "settings") openSettings(p);
    else if (choice === "new") onNewSession(p.id);
    else if (choice === "reveal") void bridge.revealInFinder(p.path);
    else if (choice === "remove") void removeProject(p);
  };
  const baseUrl = client.baseUrl.replace(/^https?:\/\//, "");

  return (
    // Collapsed: kept mounted (so it animates back) but inert: out of the tab order and a11y tree.
    <aside className="sidebar" id="app-sidebar" ref={ref} inert={collapsed}>
      <div className="sidebar-inner">
        <div className="sidebar-top" />
        <div className="sidebar-scroll">
          <button className="btn new-session-btn" onClick={() => onNewSession()}>
            <Icon name="plus" strokeWidth={2.25} />
            <span className="grow" style={{ textAlign: "left" }}>
              New session
            </span>
            <span className="kbd">{MOD}N</span>
          </button>

          <nav className="nav">
            <NavItem
              icon="inbox"
              label="Inbox"
              active={route.view === "inbox"}
              onClick={() => navigate({ view: "inbox", sessionId: null })}
              badge={triaging ? <span className="nav-live">{triaging}</span> : undefined}
            />
            <NavItem
              icon="layers"
              label="All projects"
              active={onBoard && route.projectId === null}
              onClick={() => navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" })}
              count={totalOpen}
            />
          </nav>

          <div className="nav-section">
            <span className="section-title">Projects</span>
            <button className="btn btn-ghost btn-icon btn-sm" title="Add project…" onClick={addProject}>
              <Icon name="plus" />
            </button>
          </div>
          <nav className="nav">
            {projects.map((p) => (
              <div
                key={p.id}
                className={`nav-row ${route.view === "project" && route.projectId === p.id ? "settings-open" : ""}`}
                data-project-id={p.id}
                onContextMenu={(e) => void projectMenu(e, p)}
              >
                <NavItem
                  label={p.name}
                  title={p.path}
                  prefix={<ProjectKey project={p} />}
                  active={(onBoard && route.projectId === p.id) || (route.view === "project" && route.projectId === p.id)}
                  onClick={() => navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "summaries" })}
                  count={openCounts[p.id]}
                />
                <button className="nav-gear" title={`${p.name} settings`} aria-label={`${p.name} settings`} onClick={() => openSettings(p)}>
                  <Icon name="settings" size={13} />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <button className="nav-item nav-add" onClick={addProject}>
                <Icon name="folder" />
                Add a project folder…
              </button>
            )}
          </nav>
        </div>

        <div className="sidebar-foot">
          <NavItem icon="settings" label="Settings" active={route.view === "settings"} onClick={() => navigate({ view: "settings", section: null })} />
          <div className={`conn ${state.connected ? "on" : "off"}`} title={client.baseUrl}>
            <span className="conn-dot" />
            <span className="grow truncate">{state.connected ? "Connected" : "Reconnecting…"}</span>
            <span className="muted mono conn-url">{baseUrl}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavItem(props: {
  icon?: Parameters<typeof Icon>[0]["name"];
  prefix?: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
  count?: number;
  badge?: React.ReactNode;
}) {
  return (
    <button className={`nav-item ${props.active ? "active" : ""}`} onClick={props.onClick} title={props.title}>
      {props.icon && <Icon name={props.icon} />}
      {props.prefix}
      <span className="grow truncate">{props.label}</span>
      {props.badge}
      {!props.badge && props.count ? <span className="nav-count">{props.count}</span> : null}
    </button>
  );
}
