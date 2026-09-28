// A terminal pane: a ghostty-web terminal (Ghostty's VT core compiled to WASM, drawn on a canvas)
// showing a login shell that lives in the main process (window.harness.terminal, main/terminals.ts).
//
// The shell outlives the pane's component. Switching boards, moving the pane or changing the theme
// unmounts or recreates the terminal, and the next mount re-attaches to the same shell by the
// content's sessionId, replaying its scrollback (createAttach in state/terminal.ts has the rules).
// Closing the pane is what ends the shell (the store's terminal lifecycle kills it).
//
// ghostty-web can't change colors after open(), so a theme change disposes the terminal and makes
// a new one; re-attaching makes that look like nothing happened.

import { useEffect, useRef, useState } from "react";
import { FitAddon, init, Terminal } from "ghostty-web";
import type { TerminalExit } from "../../main/types";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/bits";
import { usePaneScope } from "../components/paneContext";
import { MovePaneItems, PaneGrip } from "../components/paneHeader";
import { closePane, cwdName, paneLabel, setTerminalTitle, toggleZoom, updatePanes, type TerminalContent } from "../state/panes";
import { appOwnsKey, createAttach, exitLabel, terminalColors } from "../state/terminal";
import { currentColorTheme, currentTheme, useTheme } from "../state/theme";
import "./terminal.css";

/** Loads the WASM core once per page (it's inlined in the bundle, so there's nothing to fetch but a data: URL). */
let ghostty: Promise<void> | null = null;
const loadGhostty = () => (ghostty ??= init());

const FONT_SIZE = 12;

function monoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Menlo, monospace";
}

export function TerminalPane({ paneId, content, zoomed, focused }: { paneId: string; content: TerminalContent; zoomed: boolean; focused: boolean }) {
  const scope = usePaneScope();
  const { sessionId, cwd } = content;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [exit, setExit] = useState<TerminalExit | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Restart: the effect below makes a new terminal and ensures a new shell.
  const [generation, setGeneration] = useState(0);
  const theme = useTheme();
  const themeKey = `${theme.themeId}/${theme.resolved}`;

  useEffect(() => {
    const host = hostRef.current;
    const bridge = window.harness?.terminal;
    if (!host) return;
    if (!bridge) {
      setError("Terminals need the Harness desktop app.");
      return;
    }
    let disposed = false;
    let term: Terminal | null = null;
    const offs: (() => void)[] = [];
    setExit(null);
    setError(null);
    const attach = createAttach({
      write: (data) => term?.write(data),
      resizePty: (cols, rows) => void bridge.resize(sessionId, cols, rows).catch(() => {}),
      exited: (e) => setExit(e),
    });
    // Subscribed before ensure(), so nothing between its reply and the first live chunk is missed;
    // the attach drops whatever arrives before the reply (it's in the scrollback).
    offs.push(bridge.onData((id, data) => id === sessionId && attach.data(data)));
    offs.push(bridge.onExit((id, e) => id === sessionId && attach.exit(e)));

    void (async () => {
      await loadGhostty();
      if (disposed) return;
      term = new Terminal({
        fontFamily: monoFont(),
        fontSize: FONT_SIZE,
        cursorBlink: true,
        theme: terminalColors(currentColorTheme().tokens, currentTheme()),
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      fit.observeResize();
      // ghostty-web's contract is inverted from xterm's: true means "handled, don't process".
      term.attachCustomKeyEventHandler((e) => appOwnsKey(e));
      term.onData((data) => attach.isAttached && void bridge.write(sessionId, data).catch(() => {}));
      term.onResize(({ cols, rows }) => attach.isAttached && void bridge.resize(sessionId, cols, rows).catch(() => {}));
      term.onTitleChange((title) => updatePanes(scope, (s) => setTerminalTitle(s, paneId, title.trim())));
      const session = await bridge.ensure(sessionId, { cwd, cols: term.cols, rows: term.rows });
      if (disposed) return;
      attach.attached(session, { cols: term.cols, rows: term.rows });
      if (focusedRef.current) term.focus();
    })().catch((e: unknown) => !disposed && setError(`Couldn't start the terminal: ${(e as Error).message ?? e}`));

    return () => {
      disposed = true;
      for (const off of offs) off();
      termRef.current = null;
      term?.dispose();
    };
    // cwd only matters when the shell is first spawned; a changed cwd never re-attaches.
  }, [sessionId, themeKey, generation]);

  // Focusing the pane (a click, Tab, opening it) puts the keyboard in the terminal.
  useEffect(() => {
    if (focused && !exit) termRef.current?.focus();
  }, [focused, exit]);

  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));
  const restart = async () => {
    await window.harness?.terminal.kill(sessionId).catch(() => false);
    setGeneration((g) => g + 1);
  };
  // Edit → Copy (and ⌘C) with a selection copies it; the canvas has no DOM selection of its own.
  const copy = (e: React.ClipboardEvent) => {
    const term = termRef.current;
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
              <button className="danger" onClick={() => (closeMenu(), close())}>
                <Icon name="x" /> Close terminal
              </button>
            </>
          )}
        </MenuButton>
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
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={close} title="Close terminal" aria-label="Close pane">
          <Icon name="x" />
        </button>
      </div>
      <div className="terminal-body" onCopy={copy}>
        <div ref={hostRef} className="terminal-host" data-testid="terminal-host" />
        {(exit || error) && (
          <div className="terminal-exit" data-testid="terminal-exit" role="status">
            <Icon name={error ? "alert" : "terminal"} />
            <span className="grow">{error ?? exitLabel(exit!)}</span>
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
