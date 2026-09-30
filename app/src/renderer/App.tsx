import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionError, ConnectionResult } from "../main/types";
import { StoreProvider, useStore } from "./state/store";
import { paneScopeOf } from "./state/route";
import { Icon } from "./components/Icon";
import { Sidebar } from "./views/Sidebar";
import { InboxView } from "./views/Inbox";
import { SettingsView } from "./views/Settings";
import { ProjectSettingsView } from "./views/ProjectSettings";
import { ResizeHandle } from "./components/ResizeHandle";
import { PaneWorkspace } from "./components/PaneWorkspace";
import { ServiceBanner } from "./components/ServiceBanner";
import { sidebarBounds, toggleSidebar, updateLayout, useLayout } from "./state/layout";
import { GLOBAL_OWNER, commandOrigin, useCommands, useKeyboardDispatcher } from "./components/commands";
import { usePaneCommands } from "./components/paneCommands";
import { CommandPalette } from "./views/CommandPalette";
import { ShortcutsOverlay } from "./views/Shortcuts";
import { PopoutWindow } from "./components/PopoutWindow";
import { closePopoutPane, retainPopoutPanes } from "./state/panes";

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
          <AppWindow />
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

/** The main window, or a pop-out window (one pane, components/PopoutWindow.tsx), by the route it opened at. */
function AppWindow() {
  const { route } = useStore();
  return route.view === "popout" ? <PopoutWindow id={route.id} fromScope={route.fromScope} /> : <Shell />;
}

/**
 * The main window's side of pop-out windows: a window someone closed takes its pane with it, and
 * at startup, pop-outs whose windows aren't open any more (the app quit with them open) go. The
 * main process also sends it back to a board when a pane is put back there.
 */
function usePopoutWindows() {
  useEffect(() => {
    const popout = window.harness?.popout;
    if (!popout) return;
    let live = true;
    void popout
      .list()
      .then((ids) => live && retainPopoutPanes(new Set(ids)))
      .catch(() => {});
    const offClosed = popout.onClosed(closePopoutPane);
    const offNavigate = popout.onNavigate((route) => {
      if (location.hash !== route) location.hash = route;
    });
    return () => {
      live = false;
      offClosed();
      offNavigate();
    };
  }, []);
}

function Shell() {
  const { route, state, openTerminal, openCompose, navigate } = useStore();
  usePopoutWindows();
  const layout = useLayout();
  const appRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const setSidebarVar = (w: number | null) => {
    if (w === null) appRef.current?.style.removeProperty("--sidebar-width");
    else appRef.current?.style.setProperty("--sidebar-width", `${w}px`);
  };
  // The palette remembers where the focus was, so its commands act there (and focus goes back).
  // `initial` is its starting query ("@" for Open File…); `n` remounts an open palette that switches to it.
  const [palette, setPalette] = useState<{ origin: Element; initial: string; n: number } | null>(null);
  const paletteSeq = useRef(0);
  const [shortcuts, setShortcuts] = useState(false);

  useEffect(() => {
    // #/compose opens a New session pane on the All projects board (handy for links, tests and screenshots).
    const compose = () => {
      if (location.hash !== "#/compose") return;
      history.replaceState(history.state, "", "#/board/all");
      dispatchEvent(new HashChangeEvent("hashchange"));
      openCompose();
    };
    compose();
    addEventListener("hashchange", compose);
    return () => removeEventListener("hashchange", compose);
  }, [openCompose]);

  // Every shortcut and menu command goes through the registry (state/keys.ts).
  useKeyboardDispatcher();
  usePaneCommands(route.view === "board" ? paneScopeOf(route) : null, !layout.sidebarCollapsed);
  useCommands(GLOBAL_OWNER, {
    palette: () => setPalette((open) => (open ? null : { origin: commandOrigin() ?? document.body, initial: "", n: ++paletteSeq.current })),
    // An open palette keeps the origin it was opened from (the focus is in its input now).
    "open-file": () => {
      const n = ++paletteSeq.current;
      setPalette((open) => ({ origin: open?.origin ?? commandOrigin() ?? document.body, initial: "@", n }));
    },
    shortcuts: () => setShortcuts((open) => !open),
    "new-session": () => openCompose(),
    // A terminal needs the desktop app's PTYs.
    "new-terminal": !!window.harness && (() => openTerminal()),
    board: () => navigate({ view: "board", projectId: null, ticketKey: null, tab: "summaries" }),
    inbox: () => navigate({ view: "inbox", sessionId: null }),
    settings: () => navigate({ view: "settings", section: null }),
    "toggle-sidebar": toggleSidebar,
  });

  return (
    <div
      ref={appRef}
      className={`app ${layout.sidebarCollapsed ? "sidebar-collapsed" : ""} ${window.harness?.platform === "darwin" ? "has-traffic-lights" : ""}`}
      style={layout.sidebarWidth ? ({ "--sidebar-width": `${layout.sidebarWidth}px` } as React.CSSProperties) : undefined}
    >
      <div className="sidebar-slot">
        <Sidebar
          ref={sidebarRef}
          collapsed={layout.sidebarCollapsed}
          onNewSession={(projectId) => openCompose(projectId ?? null)}
          onNewTerminal={openTerminal}
        />
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
        <ServiceBanner />
      </main>
      {/* After the sidebar and main: Electron builds the window's drag area from app-region boxes in
          document order, so this no-drag button has to follow the drag headers it sits on (the
          sidebar top, the collapsed board header), or they re-cover it and a real click drags the
          window instead. */}
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
      {palette && <CommandPalette key={palette.n} origin={palette.origin} initial={palette.initial} onClose={() => setPalette(null)} onShortcuts={() => setShortcuts(true)} />}
      {shortcuts && <ShortcutsOverlay onClose={() => setShortcuts(false)} />}
    </div>
  );
}
