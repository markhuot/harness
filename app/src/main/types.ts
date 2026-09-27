// Shapes shared between the main process, the preload bridge and the renderer.

export interface Connection {
  baseUrl: string;
  token: string;
  source: "env" | "service";
  home?: string;
  pid?: number;
}

export interface ConnectionError {
  error: string;
  /** Command output / details for the error screen */
  output: string;
}

export type ConnectionResult = Connection | ConnectionError;

export type MenuCommand = "new-session" | "settings" | "inbox" | "board";

export interface HarnessBridge {
  getConnection(): Promise<ConnectionResult>;
  retryService(): Promise<ConnectionResult>;
  pickDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  platform: string;
}
