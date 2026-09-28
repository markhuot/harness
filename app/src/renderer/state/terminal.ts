// Terminal panes, the pure parts: where a new terminal opens and in which folder, how a pane
// attaches to its shell in the main process (window.harness.terminal), which keys the app keeps
// from the shell, and the terminal's colors. The pane itself is views/TerminalPane.tsx; the pane
// content and its placement live with the other pane operations in panes.ts. Tested in
// terminal.test.ts.

import type { Project } from "@harness/shared";
import { ALL_SCOPE, scopeOf, type ResolvedTheme } from "@harness/shared/state";
import { over, toHex, type ThemeTokens } from "@harness/shared/themes";
import type { TerminalExit, TerminalSession } from "../../main/types";
import type { Route } from "./route";

/** The folder a terminal in `scope` starts in: the project's folder, or home (`~`) on All projects or for a project that isn't loaded. */
export function terminalCwd(scope: string, projects: Readonly<Record<string, Pick<Project, "path">>>): string {
  if (scope === ALL_SCOPE) return "~";
  return projects[scope]?.path || "~";
}

/**
 * Which board a new terminal goes on: the board on screen; a project's own board from its
 * settings page; otherwise (Inbox, Settings) the board last shown, else All projects.
 */
export function terminalScope(route: Route, lastBoardScope: string | null): string {
  if (route.view === "board") return scopeOf(route.projectId);
  if (route.view === "project") return route.projectId;
  return lastBoardScope ?? ALL_SCOPE;
}

// ---------------------------------------------------------------------------
// Attaching to a shell
// ---------------------------------------------------------------------------

/** Where an attach sends things: the screen (`write`, `exited`) and the PTY (`resizePty`). */
export interface AttachSink {
  write(data: string): void;
  resizePty(cols: number, rows: number): void;
  exited(exit: TerminalExit): void;
}

export interface Attach {
  /** An onData event for this pane's session. */
  data(data: string): void;
  /** An onExit event for this pane's session. */
  exit(exit: TerminalExit): void;
  /** ensure() resolved with `session`, while the pane is `size`. */
  attached(session: TerminalSession, size: { cols: number; rows: number }): void;
  /** Detach again (a restart is about to ensure a new shell): events are dropped until the next `attached`. */
  detach(): void;
  readonly isAttached: boolean;
}

/**
 * The bridge's attach contract. On re-attach the manager folds output it hadn't sent yet into the
 * scrollback ensure() returns, so every event for the session that arrives before ensure resolves
 * is dropped (buffering it would print it twice). Then the scrollback is written once, and live
 * data applies from there on. ensure() ignores cols/rows for a shell that already exists, so a
 * re-attached pane (which may have remounted at another size) resizes the PTY to itself; a fresh
 * shell was spawned at the size asked for, so it's only resized if the pane changed meanwhile. A shell that exited while nothing showed it reports the
 * exit in the session.
 */
export function createAttach(sink: AttachSink): Attach {
  let attached = false;
  return {
    data(data) {
      if (attached && data) sink.write(data);
    },
    exit(exit) {
      if (attached) sink.exited(exit);
    },
    attached(session, size) {
      if (session.scrollback) sink.write(session.scrollback);
      attached = true;
      if (!session.created || session.cols !== size.cols || session.rows !== size.rows) sink.resizePty(size.cols, size.rows);
      if (session.exit) sink.exited(session.exit);
    },
    detach() {
      attached = false;
    },
    get isAttached() {
      return attached;
    },
  };
}

/** "Process exited (code 1)", or the signal that killed it. */
export function exitLabel(exit: TerminalExit): string {
  return exit.signal ? `Process exited (signal ${exit.signal})` : `Process exited (code ${exit.exitCode})`;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Keys the terminal leaves to the app instead of sending to the shell. As in Terminal.app and
 * Ghostty, ⌘ shortcuts never reach the shell (the menu or the app handles ⌘N, ⌘T, ⌘W, ⌘1…), except
 * ⌘C and ⌘V, which the terminal handles itself as copy and paste. ⌃ and ⌥ keys all go to the shell.
 */
export function appOwnsKey(e: Pick<KeyboardEvent, "metaKey" | "code">): boolean {
  return e.metaKey && e.code !== "KeyC" && e.code !== "KeyV";
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** The subset of ghostty-web's ITheme we set (all #rrggbb: its VT core only parses hex and rgb()). */
export interface TerminalColors {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** ANSI slots the theme tokens have no color for (Harness themes have no blue/cyan or greys of their own). */
const BASE: Record<ResolvedTheme, Pick<TerminalColors, "black" | "blue" | "cyan" | "white" | "brightBlack" | "brightBlue" | "brightCyan" | "brightWhite">> = {
  light: { black: "#1f2328", blue: "#0969da", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightBlue: "#218bff", brightCyan: "#3192aa", brightWhite: "#8c959f" },
  dark: { black: "#484f58", blue: "#58a6ff", cyan: "#39c5cf", white: "#b1bac4", brightBlack: "#6e7681", brightBlue: "#79c0ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc" },
};

/**
 * The terminal's colors from the theme on screen: the pane background and text, the accent as the
 * cursor, the selection color, and the theme's red/green/amber/violet tones for those ANSI colors.
 * Translucent tokens are flattened over the background.
 */
export function terminalColors(tokens: ThemeTokens, resolved: ResolvedTheme): TerminalColors {
  const bg = toHex(over(tokens.bg, "#ffffff"));
  const hex = (c: string) => toHex(over(c, bg));
  return {
    ...BASE[resolved],
    foreground: hex(tokens.text),
    background: bg,
    cursor: hex(tokens.accent),
    cursorAccent: bg,
    selectionBackground: hex(tokens.selection),
    selectionForeground: hex(tokens.text),
    red: hex(tokens.red),
    green: hex(tokens.green),
    yellow: hex(tokens.amber),
    magenta: hex(tokens.violet),
    brightRed: hex(tokens.red),
    brightGreen: hex(tokens.green),
    brightYellow: hex(tokens.amber),
    brightMagenta: hex(tokens.violet),
  };
}
