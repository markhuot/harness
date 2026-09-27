// Shapes shared between the main process, the preload bridge and the renderer.

import type { ThemePreference, ThemeState } from "./theme";
export type { ResolvedTheme, ThemePreference, ThemeState } from "./theme";

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
  setTheme(preference: ThemePreference): Promise<ThemeState>;
  onThemeChange(cb: (state: ThemeState) => void): () => void;
  /** Keep View → Show Sidebar's checkmark in step with the renderer's sidebar */
  setSidebarVisible(visible: boolean): void;
  platform: string;
}
