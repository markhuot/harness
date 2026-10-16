// A terminal pane: a view of a shell the service hosts, drawn by ghostty-web (Ghostty's VT core
// compiled to WASM, on a canvas) through the shared terminal bundle (terminal/). The iPhone attaches
// to the same shell: the service restores the screen with a snapshot, then streams output, and sizes
// the shell to the smallest visible client. This pane draws at that size, centered, so it can be
// smaller than the pane when a phone is attached.
//
// The shell outlives the pane. Closing the pane leaves it running (it is still in the palette and on
// the phone); "End terminal" in the menu hangs it up. A terminal the service no longer has (it
// restarted) reads as ended.
//
// ghostty-web can't change colors after open(), so a theme change rebuilds the view; attaching again
// makes that look like nothing happened.

import { useEffect, useRef, useState } from "react";
import { createTerminalView, isTerminalMessage, loadGhostty, type TerminalView } from "@harness/terminal";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/bits";
import { usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { closePane, cwdName, paneLabel, replaceContent, setTerminalTitle, terminalContent, toggleZoom, updatePanes, type TerminalContent } from "../state/panes";
import { useStore } from "../state/store";
import { appOwnsKey, exitLabel, menuKey, terminalColors, terminalCounts } from "../state/terminal";
import { currentColorTheme, currentTheme, useTheme } from "../state/theme";
import { deviceIdNow } from "../state/usePresence";
import "./terminal.css";

const FONT_SIZE = 12;

function monoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Menlo, monospace";
}

export function TerminalPane({ paneId, content, zoomed, covered, focused }: { paneId: string; content: TerminalContent; zoomed: boolean; covered: boolean; focused: boolean }) {
  const scope = usePaneScope();
  const popout = usePopout();
  const { client, socket, onTerminalMessage, endTerminal, terminals } = useStore();
  const { sessionId, cwd } = content;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  /** Re-attaches or detaches the live view when the pane is covered or uncovered. */
  const syncRef = useRef<(() => void) | null>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  /** null while it runs; the exit code (or null for one the service lost) once it has ended. */
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "62×18" while the shell is smaller than this pane could show (another device is smaller). */
  const [shared, setShared] = useState<string | null>(null);
  const theme = useTheme();
  const themeKey = `${theme.themeId}/${theme.resolved}`;
  const info = terminals.find((t) => t.id === sessionId);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let view: TerminalView | null = null;
    const offs: (() => void)[] = [];
    // Capture phase on the terminal's parent, so the terminal (listening on `host`) never sees these.
    const body = host.parentElement!;
    const keepMenuKey = (e: KeyboardEvent) => menuKey(e) && e.stopPropagation();
    body.addEventListener("keydown", keepMenuKey, true);
    offs.push(() => body.removeEventListener("keydown", keepMenuKey, true));
    setExit(null);
    setError(null);

    void (async () => {
      const [ghostty, deviceId] = await Promise.all([loadGhostty(), deviceIdNow()]);
      if (disposed) return;
      let viewport: { cols: number; rows: number } | null = null;
      let attached = false;
      const counts = () => terminalCounts({ windowVisible: document.visibilityState === "visible", covered: coveredRef.current });
      const attach = () => {
        if (!viewport || !counts()) return;
        socket.attachTerminal(sessionId, deviceId, viewport.cols, viewport.rows);
        attached = true;
      };
      const detach = () => {
        if (!attached) return;
        socket.detachTerminal(sessionId);
        attached = false;
      };
      const noteSize = () => {
        const v = view?.viewport();
        const t = view?.term;
        setShared(v && t && (t.cols < v.cols || t.rows < v.rows) ? `${t.cols}×${t.rows}` : null);
      };
      view = createTerminalView(ghostty, {
        container: host,
        id: sessionId,
        theme: terminalColors(currentColorTheme().tokens, currentTheme()),
        fontFamily: monoFont(),
        fontSize: FONT_SIZE,
        onData: (data) => socket.writeTerminal(sessionId, data),
        onViewport: (v) => {
          viewport = v;
          if (attached) socket.resizeTerminal(sessionId, v.cols, v.rows);
          else attach();
          noteSize();
        },
        onTitle: (title) => updatePanes(scope, (s) => setTerminalTitle(s, paneId, title.trim())),
        onResync: () => {
          detach();
          attach();
        },
        onExit: (code) => setExit({ code }),
        // ghostty-web's contract is inverted from xterm's: true means "handled, don't process". Menu
        // keys never get here (keepMenuKey); this keeps ⌃⌘ shortcuts from the shell.
        keyHandler: (e) => appOwnsKey(e),
      });
      viewRef.current = view;
      // For scripts/terminal-pane-check.ts, which reads the screen (a canvas) through the buffer API.
      (host as HTMLElement & { harnessTerminal?: unknown; harnessTerminalView?: TerminalView }).harnessTerminal = view.term;
      (host as HTMLElement & { harnessTerminalView?: TerminalView }).harnessTerminalView = view;
      view.term.onResize(noteSize);
      offs.push(
        onTerminalMessage((msg) => {
          if (isTerminalMessage(msg)) view?.handle(msg);
        }),
      );
      // A hidden window or a covered pane doesn't count toward the shell's size (it would
      // shrink it for nobody to see).
      const sync = () => (counts() ? attach() : detach());
      syncRef.current = sync;
      document.addEventListener("visibilitychange", sync);
      offs.push(() => {
        document.removeEventListener("visibilitychange", sync);
        syncRef.current = null;
      });
      offs.push(detach);
      attach();
      if (focusedRef.current) view.focus();
    })().catch((e: unknown) => !disposed && setError(`Couldn't start the terminal: ${(e as Error).message ?? e}`));

    return () => {
      disposed = true;
      for (const off of offs) off();
      viewRef.current = null;
      view?.dispose();
    };
  }, [sessionId, themeKey, socket, onTerminalMessage]);

  useEffect(() => syncRef.current?.(), [covered]);

  // Focusing the pane (a click, Tab, opening it) puts the keyboard in the terminal.
  useEffect(() => {
    if (focused && !exit) viewRef.current?.focus();
  }, [focused, exit]);

  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));
  // A new shell in the same folder, in this pane.
  const restart = async () => {
    try {
      const next = await client.createTerminal({ cwd, projectId: info?.projectId ?? null, deviceId: await deviceIdNow() });
      updatePanes(scope, (s) => replaceContent(s, paneId, terminalContent(next)));
    } catch (e) {
      setError(`Couldn't start a terminal: ${(e as Error).message}`);
    }
  };
  const end = () => void endTerminal(sessionId).catch(() => {});
  // Edit → Copy (and ⌘C) with a selection copies it; the canvas has no DOM selection of its own.
  const copy = (e: React.ClipboardEvent) => {
    const term = viewRef.current?.term;
    if (!term?.hasSelection()) return;
    e.clipboardData.setData("text/plain", term.getSelection());
    e.preventDefault();
  };

  const label = paneLabel(content);
  return (
    <aside className="terminal-pane" data-terminal={sessionId}>
      <div className="view-header detail-titlebar terminal-titlebar">
        <PaneGrip paneId={paneId} chip={cwdName(cwd)} title={label} />
        <Icon name="terminal" />
        <span className="terminal-title truncate" title={cwd}>
          {label}
        </span>
        {content.title && <span className="terminal-cwd truncate mono" title={cwd}>{cwdName(cwd)}</span>}
        {shared && (
          <span className="terminal-shared mono" data-testid="terminal-shared" title="Another device is attached at a smaller size, so this terminal is drawn smaller than the pane">
            {shared}
          </span>
        )}
        <div className="grow" />
        <MenuButton
          trigger={(toggle) => (
            <button className="btn btn-ghost btn-icon" onClick={toggle} title="More">
              <Icon name="more" />
            </button>
          )}
        >
          {(closeMenu) => (
            <>
              <button onClick={() => (closeMenu(), void navigator.clipboard.writeText(cwd))}>
                <Icon name="folder" /> Copy folder path
              </button>
              <button onClick={() => (closeMenu(), void restart())}>
                <Icon name="refresh" /> Restart shell
              </button>
              <hr />
              <MovePaneItems paneId={paneId} onDone={closeMenu} />
              <button onClick={() => (closeMenu(), close())}>
                <Icon name="x" /> Close pane
              </button>
              <button className="danger" onClick={() => (closeMenu(), end(), close())}>
                <Icon name="x" /> End terminal
              </button>
            </>
          )}
        </MenuButton>
        <PaneWindowButton paneId={paneId} />
        {!popout && (
          <button
            className="btn btn-ghost btn-icon"
            data-testid="pane-zoom"
            aria-pressed={zoomed}
            onClick={zoom}
            title={zoomed ? "Restore pane" : "Maximize pane"}
            aria-label={zoomed ? "Restore pane" : "Maximize pane"}
          >
            <Icon name={zoomed ? "shrink" : "expand"} />
          </button>
        )}
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={close} title="Close pane (the shell keeps running)" aria-label="Close pane">
          <Icon name="x" />
        </button>
      </div>
      <div className="terminal-body" onCopy={copy}>
        <div ref={hostRef} className="terminal-host" data-testid="terminal-host" />
        {(exit || error) && (
          <div className="terminal-exit" data-testid="terminal-exit" role="status">
            <Icon name={error ? "alert" : "terminal"} />
            <span className="grow">{error ?? exitLabel(exit!.code)}</span>
            {!error && (
              <button className="btn btn-sm" data-testid="terminal-restart" onClick={() => void restart()}>
                <Icon name="refresh" /> Restart
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={close}>
              Close
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
