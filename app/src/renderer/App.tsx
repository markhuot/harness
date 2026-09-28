import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionError, ConnectionResult } from "../main/types";
import { StoreProvider, useStore } from "./state/store";
import { paneScopeOf } from "./state/route";
import { Icon } from "./components/Icon";
import { Sidebar } from "./views/Sidebar";
import { InboxView } from "./views/Inbox";
import { SettingsView } from "./views/Settings";
import { NewSessionModal } from "./views/NewSession";
import { ProjectSettingsView } from "./views/ProjectSettings";
import { ResizeHandle } from "./components/ResizeHandle";
import { PaneWorkspace } from "./components/PaneWorkspace";
import { sidebarBounds, toggleSidebar, updateLayout, useLayout } from "./state/layout";

interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

/** Connection source: the Electron bridge, or ?url=&token= when opened in a plain browser. */
async function resolveConnection(retry = false): Promise<ConnectionResult> {
  if (window.harness) return retry ? window.harness.retryService() : window.harness.getConnection();
  const q = new URLSearchParams(location.search);
  const url = q.get("url");
  const token = q.get("token");
  if (url && token) return { baseUrl: url, token, source: "env" };
  return { error: "Not running inside the Harness app.", output: "Open with ?url=http://127.0.0.1:7717&token=… to use in a browser." };
}

export function Root() {
  const [conn, setConn] = useState<ConnectionResult | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: "error" | "info" = "error") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);

  useEffect(() => {
    void resolveConnection().then(setConn);
  }, []);

  // Token rotation: Electron re-reads the token file; a plain browser takes the rotated token.
  const onTokenRotated = useCallback(async (rotated: string) => {
    const next: ConnectionResult = window.harness
      ? await window.harness.reloadToken(rotated)
      : { baseUrl: new URLSearchParams(location.search).get("url") ?? "", token: rotated, source: "env" };
    if ("error" in next) throw new Error(`${next.error} ${next.output}`.trim());
    if (!window.harness) {
      // Keep ?token= current so a reload still connects.
      const q = new URLSearchParams(location.search);
      q.set("token", rotated);
      history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
    }
    setConn(next);
  }, []);

  const retry = async () => {
    setRetrying(true);
    setConn(await resolveConnection(true));
    setRetrying(false);
  };

  return (
    <>
      {!conn ? (
        <Splash />
      ) : "error" in conn ? (
        <ErrorScreen error={conn} onRetry={retry} retrying={retrying} />
      ) : (
        <StoreProvider baseUrl={conn.baseUrl} token={conn.token} toast={toast} onTokenRotated={onTokenRotated}>
          <Shell />
        </StoreProvider>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === "error" ? "alert" : "checkCircle"} />
            <span className="selectable">{t.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Splash() {
  return (
    <div className="splash">
      <div className="titlebar-drag" />
      <div className="splash-inner">
        <div className="spinner" />
        <span>Starting the harness service…</span>
      </div>
    </div>
  );
}

function ErrorScreen({ error, onRetry, retrying }: { error: ConnectionError; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="splash">
      <div className="titlebar-drag" />
      <div className="error-card card-surface">
        <div className="error-icon">
          <Icon name="wifiOff" size={20} />
        </div>
        <h2>{error.error}</h2>
        <p className="dim">
          Harness runs your agents in a background service, and the app couldn't connect to it. Agents that are already
          running aren't affected.
        </p>
        {error.output && <pre className="error-output selectable">{error.output}</pre>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="muted grow" style={{ fontSize: 12 }}>
            Check with <code>harness service status</code>
          </span>
          <button className="btn btn-primary" onClick={onRetry} disabled={retrying}>
            {retrying ? <span className="spinner" style={{ borderTopColor: "var(--on-accent)" }} /> : <Icon name="refresh" />}
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

/** ⌃⌘S (View → Show Sidebar). The menu shows it; the renderer handles the key so it's testable. */
const isSidebarShortcut = (e: KeyboardEvent) => e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyS";

function Shell() {
  const { route, state } = useStore();
  const layout = useLayout();
  const appRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const setSidebarVar = (w: number | null) => {
    if (w === null) appRef.current?.style.removeProperty("--sidebar-width");
    else appRef.current?.style.setProperty("--sidebar-width", `${w}px`);
  };
  // false = closed; otherwise open, optionally preselecting a project ("New session in X").
  const [composer, setComposerState] = useState<false | { projectId: string | null }>(false);
  const setComposer = useCallback((open: boolean, projectId: string | null = null) => setComposerState(open ? { projectId } : false), []);

  useEffect(() => {
    // #/compose opens the composer on top of the board (handy for links, tests and screenshots).
    const compose = () => {
      if (location.hash !== "#/compose") return;
      location.hash = "#/board/all";
      setComposer(true);
    };
    compose();
    addEventListener("hashchange", compose);
    // A keypress the renderer handled shouldn't also arrive as the menu command.
    let keyToggledAt = 0;
    const off = window.harness?.onMenu((cmd) => {
      if (cmd === "toggle-sidebar") {
        if (Date.now() - keyToggledAt > 400) toggleSidebar();
      } else if (cmd === "new-session") setComposer(true);
      else if (cmd === "settings") location.hash = "#/settings";
      else if (cmd === "inbox") location.hash = "#/inbox";
      else if (cmd === "board") location.hash = "#/board/all";
    });
    // Outside Electron the menu accelerator doesn't exist; handle ⌘N here.
    const key = (e: KeyboardEvent) => {
      if (isSidebarShortcut(e)) {
        e.preventDefault();
        keyToggledAt = Date.now();
        toggleSidebar();
        return;
      }
      if (!window.harness && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setComposer(true);
      }
    };
    addEventListener("keydown", key);
    return () => {
      off?.();
      removeEventListener("keydown", key);
      removeEventListener("hashchange", compose);
    };
  }, []);

  return (
    <div
      ref={appRef}
      className={`app ${layout.sidebarCollapsed ? "sidebar-collapsed" : ""} ${window.harness?.platform === "darwin" ? "has-traffic-lights" : ""}`}
      style={layout.sidebarWidth ? ({ "--sidebar-width": `${layout.sidebarWidth}px` } as React.CSSProperties) : undefined}
    >
      <button
        className="btn btn-ghost btn-icon sidebar-toggle"
        data-testid="sidebar-toggle"
        aria-controls="app-sidebar"
        aria-expanded={!layout.sidebarCollapsed}
        aria-label={layout.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        title={`${layout.sidebarCollapsed ? "Show" : "Hide"} sidebar (⌃⌘S)`}
        onClick={toggleSidebar}
      >
        <Icon name="sidebar" />
      </button>
      <div className="sidebar-slot">
        <Sidebar ref={sidebarRef} collapsed={layout.sidebarCollapsed} onNewSession={(projectId) => setComposer(true, projectId ?? null)} />
        {!layout.sidebarCollapsed && (
          <ResizeHandle
            className="sidebar-resizer"
            testId="sidebar-resizer"
            label="Resize sidebar"
            target={sidebarRef}
            bounds={sidebarBounds}
            onPreview={setSidebarVar}
            onCommit={(w) => updateLayout({ sidebarWidth: w })}
            onReset={() => {
              setSidebarVar(null);
              updateLayout({ sidebarWidth: null });
            }}
          />
        )}
      </div>
      <main className="main">
        {!state.ready ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="spinner" />
          </div>
        ) : route.view === "inbox" ? (
          <InboxView />
        ) : route.view === "settings" ? (
          <SettingsView />
        ) : route.view === "project" ? (
          <ProjectSettingsView />
        ) : (
          <PaneWorkspace scope={paneScopeOf(route)!} />
        )}
      </main>
      {composer && <NewSessionModal initialProjectId={composer.projectId} onClose={() => setComposer(false)} />}
    </div>
  );
}
