import { useMemo } from "react";
import { useAction, useStore } from "../state/store";
import { sortedProjects, triageSessions } from "../state/reducer";
import { Icon } from "../components/Icon";
import { MOD } from "../components/bits";

export function Sidebar({ onNewSession }: { onNewSession: () => void }) {
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
  const baseUrl = client.baseUrl.replace(/^https?:\/\//, "");

  return (
    <aside className="sidebar">
      <div className="sidebar-top" />
      <div className="sidebar-scroll">
        <button className="btn new-session-btn" onClick={onNewSession}>
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
            <NavItem
              key={p.id}
              label={p.name}
              title={p.path}
              prefix={<span className="project-key">{p.key.slice(0, 3)}</span>}
              active={onBoard && route.projectId === p.id}
              onClick={() => navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "summaries" })}
              count={openCounts[p.id]}
            />
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
