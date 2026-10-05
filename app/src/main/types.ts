// Shapes shared between the main process, the preload bridge and the renderer.

import type { ThemePatch, ThemePreference, ThemeState } from "./theme";
export type { ResolvedTheme, ThemePatch, ThemePreference, ThemeState } from "./theme";

/**
 * Who runs the service the app is connected to: "app", its own child process (the default); "login",
 * launchd, which starts it at login and keeps it running after the app quits; "external", a
 * service someone started by hand.
 */
export type ServiceMode = "app" | "login" | "external";

export interface Connection {
  baseUrl: string;
  token: string;
  source: "env" | "service";
  /** Service connections: who runs it (see ServiceMode) */
  mode?: ServiceMode;
  /** Where the token lives (service connections); re-read after a token rotation */
  tokenPath?: string;
  home?: string;
  pid?: number;
  /**
   * A login item still running the service another build of the app installed: this build's
   * plist would restart it, which waits while `busy` agents are running (`service ensure` defers).
   */
  deferred?: { busy: number };
}

export interface ConnectionError {
  error: string;
  /** Command output / details for the error screen */
  output: string;
}

export type ConnectionResult = Connection | ConnectionError;

/** A keyboard command id (renderer/state/keys.ts) the native menu sends back to the renderer. */
export type MenuCommand = string;

/** A native context-menu entry. `id` comes back from showContextMenu when chosen. */
export type ContextMenuItem =
  | { type?: "item"; id: string; label: string; enabled?: boolean; danger?: boolean }
  | { type: "separator" };

export interface PickDirectoryOptions {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
}

/** How a terminal's shell ended. `signal` is set when a signal killed it. */
export interface TerminalExit {
  exitCode: number;
  signal: number | null;
}

/** A terminal session as ensure() returns it. */
export interface TerminalSession {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  /** True when this call spawned the shell; false when it re-attached to an existing session */
  created: boolean;
  /** Output so far (bounded), for a remounted pane to replay before appending onData */
  scrollback: string;
  /**
   * The output offset the scrollback ends at (UTF-16 code units of all output so far). Each onData
   * chunk carries the offset it ends at, so a pane writes only the part of a chunk past this: data
   * events and ensure()'s reply travel separately and can arrive in either order.
   */
  end: number;
  /** Set once the shell has exited; the session stays until kill() */
  exit: TerminalExit | null;
}

export interface TerminalEnsureOptions {
  /** Starting directory; `~` expands, and a missing directory falls back to home */
  cwd?: string;
  cols: number;
  rows: number;
}

/** Built-in terminals (PTYs in the main process), keyed by the renderer's pane leaf id. */
export interface TerminalBridge {
  /** Attach to `id`, spawning a login shell if it doesn't exist. Hold `id`'s onData until this resolves, then keep what ends past `end`. */
  ensure(id: string, opts: TerminalEnsureOptions): Promise<TerminalSession>;
  /** Send input; false when there's no running session */
  write(id: string, data: string): Promise<boolean>;
  resize(id: string, cols: number, rows: number): Promise<boolean>;
  /** End the shell and forget the session; false when there was none */
  kill(id: string): Promise<boolean>;
  /** Every session id (running or exited), to kill the ones no pane shows any more */
  list(): Promise<string[]>;
  /** `end` is the output offset just past `data` (see TerminalSession.end). */
  onData(cb: (id: string, data: string, end: number) => void): () => void;
  onExit(cb: (id: string, exit: TerminalExit) => void): () => void;
}

/** A rectangle in screen coordinates. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoutOpenOptions {
  /** The pop-out's id (its pane scope is `popout:<id>`, see renderer/state/panes.ts) */
  id: string;
  /** The hash route the window opens at (#/popout/<id>/<fromScope>) */
  route: string;
  /** Where the pane was on screen; the window opens near it (and at its size) */
  bounds?: ScreenRect;
  /** A screen point the window opens under (a drag released outside a window); wins over bounds' spot */
  at?: { x: number; y: number };
}

/** Pop-out windows: one pane each, in its own window (renderer/components/PopoutWindow.tsx). */
export interface PopoutBridge {
  open(opts: PopoutOpenOptions): Promise<void>;
  /** The pop-out's pane is gone (closed, or back on a board): close its window, if it's still open. */
  close(id: string): Promise<void>;
  /** Bring the main window forward at `route` (opening one if there's none). */
  showMain(route: string): Promise<void>;
  /** The ids of the pop-out windows that are open */
  list(): Promise<string[]>;
  /** Someone closed a pop-out's window: its pane closes with it. Sent to the main window. */
  onClosed(cb: (id: string) => void): () => void;
  /** The main process asks this window to go to a route (showMain). */
  onNavigate(cb: (route: string) => void): () => void;
}

export interface HarnessBridge {
  getConnection(): Promise<ConnectionResult>;
  retryService(): Promise<ConnectionResult>;
  /** The main process replaced the connection (a deferred service reload settled, or a restart). */
  onConnection(cb: (conn: ConnectionResult) => void): () => void;
  /** Re-read the token file after POST /token/rotate (env connections take `rotated`). */
  reloadToken(rotated?: string): Promise<ConnectionResult>;
  /** Restart the service now (the app's child, or launchd's job); running agents are stopped. */
  restartService(): Promise<{ ok: true } | ConnectionError>;
  /**
   * Hand the service to launchd ("login": it starts at login and outlives the app) or take it back
   * as the app's child ("app"). Either way the service restarts and running agents are stopped.
   * Resolves with the new connection; `error` is set when the switch failed (the connection is
   * then whatever could be restored).
   */
  setServiceMode(mode: "app" | "login"): Promise<{ connection: ConnectionResult; error?: ConnectionError }>;
  pickDirectory(opts?: PickDirectoryOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** Reveal a file or folder in Finder */
  revealInFinder(path: string): Promise<void>;
  /**
   * Where a File from a drop, a paste or a file input is on disk (webUtils.getPathForFile; Electron
   * removed File.path). Null for one that isn't a file on disk (an image dragged out of a browser,
   * pasted image data).
   */
  pathForFile(file: File): string | null;
  /** Pop up a native menu at the cursor; resolves with the chosen item id, or null when dismissed */
  showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** `viaKey`: the item's shortcut was pressed rather than the item clicked. */
  onMenu(cb: (cmd: MenuCommand, viaKey: boolean) => void): () => void;
  /** App appearance. getTheme is synchronous so the renderer can apply it before first paint. */
  getTheme(): ThemeState;
  /** Change the appearance and/or the light / dark theme picks (a bare preference still works) */
  setTheme(patch: ThemePreference | ThemePatch): Promise<ThemeState>;
  onThemeChange(cb: (state: ThemeState) => void): () => void;
  /** Keep View → Show Sidebar's checkmark in step with the renderer's sidebar */
  setSidebarVisible(visible: boolean): void;
  /** The board's widget signature (renderer/state/widgets.ts) changed: reload the desktop widget */
  widgetsChanged(signature: string): void;
  terminal: TerminalBridge;
  popout: PopoutBridge;
  platform: string;
}
