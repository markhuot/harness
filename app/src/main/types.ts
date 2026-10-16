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
  | { type?: "item"; id: string; label: string; enabled?: boolean; danger?: boolean; submenu?: ContextMenuItem[] }
  | { type: "separator" };

export interface PickDirectoryOptions {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
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
  /** This install's stable id (a UUID kept in userData): the device presence and pushes are for. */
  deviceId(): Promise<string>;
  /** Whether the person is away (screen locked, system asleep or idle): windows then report no presence. */
  isAway(): Promise<boolean>;
  onAwayChange(cb: (away: boolean) => void): () => void;
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
  popout: PopoutBridge;
  platform: string;
}
