import { useCallback, useMemo, useRef, type Ref } from "react";
import { projectGroups, type Project } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { sortedProjects, triageSessions } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { MenuButton, MOD } from "../components/bits";
import { ProjectKey } from "../components/ProjectKey";
import { forgetProjectPanes } from "../state/panes";
import { keysArea, runCommand, useCommands } from "../components/commands";
import { useRovingList } from "../components/useRovingList";
import { countSegments, sidebarCounts, type StatusCounts } from "../state/sidebarCounts";

export function Sidebar({
  onNewSession,
  onNewTerminal,
  collapsed = false,
  ref,
}: {
  onNewSession: (projectId?: string) => void;
  /** A terminal on the board on screen (omitted), or on `projectId`'s board. */
  onNewTerminal: (projectId?: string) => void;
  collapsed?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const { state, route, navigate, client } = useStore();
  const act = useAction();
  const projects = sortedProjects(state);
  const groups = useMemo(() => projectGroups(Object.values(state.projects)), [state.projects]);

  // One roving list: New session, the nav items, each project and Settings are j/k stops; the
  // chevron, Add project and the project gears stay on Tab after the list's stop.
  const local = useRef<HTMLElement | null>(null);
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      local.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  useRovingList(local, { owner: "sidebar" });
  useCommands("sidebar", { "sidebar.exit": () => runCommand("pane.right") });

  const counts = useMemo(() => sidebarCounts(Object.values(state.tickets), (id) => state.projects[id]?.group), [state.tickets, state.projects]);
  const triaging = triageSessions(state).filter((s) => s.triageStatus === "triaging" || s.busy).length;

  const addProject = async () => {
    const path = await window.harness?.pickDirectory();
    if (!path) return;
    const p = await act(() => client.createProject({ path }));
    if (p) navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "spec" });
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
    // Its board's panes go, and its tickets close on All projects (project.deleted does the same
    // when another client removes it).
    if (ok) forgetProjectPanes(p.id, p.key);
    if (ok && ((route.view === "board" && route.projectId === p.id) || (route.view === "project" && route.projectId === p.id))) {
      navigate({ view: "board", projectId: null, ticketKey: null, tab: "spec" });
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
      { id: "terminal", label: `New terminal in ${p.name}` },
      { type: "separator" },
      { id: "reveal", label: "Reveal in Finder" },
      { type: "separator" },
      { id: "remove", label: "Remove project…" },
    ]);
    if (choice === "settings") openSettings(p);
    else if (choice === "new") onNewSession(p.id);
    else if (choice === "terminal") onNewTerminal(p.id);
    else if (choice === "reveal") void bridge.revealInFinder(p.path);
    else if (choice === "remove") void removeProject(p);
  };
  const baseUrl = client.baseUrl.replace(/^https?:\/\//, "");

  return (
    // Collapsed: kept mounted (so it animates back) but inert: out of the tab order and a11y tree.
    <aside className="sidebar" id="app-sidebar" ref={setRef} inert={collapsed} {...keysArea("list sidebar", "sidebar")}>
      <div className="sidebar-inner">
        <div className="sidebar-top" />
        <div className="sidebar-scroll">
          {/* A split button: the main part is New session (⌘N), the chevron offers a terminal too. */}
          <div className="new-session-split" role="group" aria-label="New">
            <button className="btn new-session-btn" data-testid="new-session" data-roving-item onClick={() => onNewSession()}>
              <Icon name="plus" strokeWidth={2.25} />
              <span className="grow" style={{ textAlign: "left" }}>
                New session
              </span>
              <span className="kbd">{MOD}N</span>
            </button>
            <MenuButton
              className="new-session-more"
              align="right"
              trigger={(toggle, open) => (
                <button className="btn new-session-chevron" data-testid="new-menu" aria-haspopup="menu" aria-expanded={open} aria-label="More ways to start" title="New session or terminal" onClick={toggle}>
                  <Icon name="chevron" strokeWidth={2.25} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button role="menuitem" onClick={() => (close(), onNewSession())}>
                    <Icon name="plus" /> <span className="grow">New session</span> <span className="kbd">{MOD}N</span>
                  </button>
                  <button role="menuitem" data-testid="new-terminal" onClick={() => (close(), onNewTerminal())}>
                    <Icon name="terminal" /> <span className="grow">New terminal</span> <span className="kbd">{MOD}T</span>
                  </button>
                </>
              )}
            </MenuButton>
          </div>

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
              active={onBoard && route.projectId === null && !route.group}
              onClick={() => navigate({ view: "board", projectId: null, ticketKey: null, tab: "spec" })}
              counts={counts.total}
            />
            {/* Project groups (set in each project's settings), each a board of its projects. */}
            {groups.map((g) => (
              <NavItem
                key={g}
                icon="folder"
                label={g}
                testId="nav-group"
                active={onBoard && route.group === g}
                onClick={() => navigate({ view: "board", projectId: null, group: g, ticketKey: null, tab: "spec" })}
                counts={counts.byGroup[g]}
              />
            ))}
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
                  onClick={() => navigate({ view: "board", projectId: p.id, ticketKey: null, tab: "spec" })}
                  counts={counts.byProject[p.id]}
                />
                <button className="nav-gear" title={`${p.name} settings`} aria-label={`${p.name} settings`} onClick={() => openSettings(p)}>
                  <Icon name="settings" size={13} />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <button className="nav-item nav-add" data-roving-item onClick={addProject}>
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
  counts?: StatusCounts;
  badge?: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      className={`nav-item ${props.active ? "active" : ""}`}
      data-roving-item
      data-testid={props.testId}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
      title={props.title}
    >
      {props.icon && <Icon name={props.icon} />}
      {props.prefix}
      <span className="grow truncate">{props.label}</span>
      {props.badge}
      {!props.badge && <CountPill counts={props.counts} />}
    </button>
  );
}

const LABEL = { in_progress: "in progress", blocked: "blocked", review: "in review" } as const;

/** In progress, blocked and review as one pill of colored segments, leaving out the zeros. */
function CountPill({ counts }: { counts?: StatusCounts }) {
  const segs = countSegments(counts);
  if (!segs.length) return null;
  const label = segs.map((s) => `${s.n} ${LABEL[s.status]}`).join(", ");
  return (
    <span className="nav-count" role="img" aria-label={label} title={label}>
      {segs.map((s) => (
        <span key={s.status} className="nav-count-seg" style={{ ["--seg" as string]: `var(--c-${s.status})` }}>
          {s.n}
        </span>
      ))}
    </span>
  );
}
