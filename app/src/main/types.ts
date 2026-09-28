// Shapes shared between the main process, the preload bridge and the renderer.

import type { ThemePatch, ThemePreference, ThemeState } from "./theme";
export type { ResolvedTheme, ThemePatch, ThemePreference, ThemeState } from "./theme";

export interface Connection {
  baseUrl: string;
  token: string;
  source: "env" | "service";
  /** Where the token lives (service connections); re-read after a token rotation */
  tokenPath?: string;
  home?: string;
  pid?: number;
}

export interface ConnectionError {
  error: string;
  /** Command output / details for the error screen */
  output: string;
}

export type ConnectionResult = Connection | ConnectionError;

export type MenuCommand = "new-session" | "settings" | "inbox" | "board" | "toggle-sidebar";

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
  /** Attach to `id`, spawning a login shell if it doesn't exist. Ignore `id`'s onData until this resolves. */
  ensure(id: string, opts: TerminalEnsureOptions): Promise<TerminalSession>;
  /** Send input; false when there's no running session */
  write(id: string, data: string): Promise<boolean>;
  resize(id: string, cols: number, rows: number): Promise<boolean>;
  /** End the shell and forget the session; false when there was none */
  kill(id: string): Promise<boolean>;
  /** Every session id (running or exited), to kill the ones no pane shows any more */
  list(): Promise<string[]>;
  onData(cb: (id: string, data: string) => void): () => void;
  onExit(cb: (id: string, exit: TerminalExit) => void): () => void;
}

export interface HarnessBridge {
  getConnection(): Promise<ConnectionResult>;
  retryService(): Promise<ConnectionResult>;
  /** Re-read the token file after POST /token/rotate (env connections take `rotated`). */
  reloadToken(rotated?: string): Promise<ConnectionResult>;
  pickDirectory(opts?: PickDirectoryOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** Reveal a file or folder in Finder */
  revealInFinder(path: string): Promise<void>;
  /** Pop up a native menu at the cursor; resolves with the chosen item id, or null when dismissed */
  showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  /** App appearance. getTheme is synchronous so the renderer can apply it before first paint. */
  getTheme(): ThemeState;
  /** Change the appearance and/or the light / dark theme picks (a bare preference still works) */
  setTheme(patch: ThemePreference | ThemePatch): Promise<ThemeState>;
  onThemeChange(cb: (state: ThemeState) => void): () => void;
  /** Keep View → Show Sidebar's checkmark in step with the renderer's sidebar */
  setSidebarVisible(visible: boolean): void;
  terminal: TerminalBridge;
  platform: string;
}
