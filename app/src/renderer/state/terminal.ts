// Terminal panes, the pure parts: where a new terminal opens and in which folder, how a pane
// attaches to its shell in the main process (window.harness.terminal), which keys the app keeps
// from the shell, and the terminal's colors. The pane itself is views/TerminalPane.tsx; the pane
// content and its placement live with the other pane operations in panes.ts. Tested in
// terminal.test.ts.

import type { HarnessEvent, Project, TerminalInfo, Ticket } from "@harness/shared";
import { ALL_SCOPE } from "@harness/shared/state";
import { paneScopeOf, type Route } from "./route";

/**
 * The folder a terminal in `scope` starts in. With a ticket focused: the folder its agent works in
 * (its worktree or the project checkout), else its project's folder before it has started.
 * Otherwise the project's folder, or home (`~`) on All projects, a group's board, or for a project
 * that isn't loaded.
 */
export function terminalCwd(
  scope: string,
  projects: Readonly<Record<string, Pick<Project, "path">>>,
  ticket: Pick<Ticket, "workdir" | "projectId"> | null = null,
): string {
  if (ticket) return ticket.workdir || projects[ticket.projectId]?.path || "~";
  if (scope === ALL_SCOPE) return "~";
  return projects[scope]?.path || "~";
}

/**
 * Which board a new terminal goes on: the board on screen; a project's own board from its
 * settings page; otherwise (Inbox, Settings) the board last shown, else All projects.
 */
export function terminalScope(route: Route, lastBoardScope: string | null): string {
  if (route.view === "board") return paneScopeOf(route)!;
  if (route.view === "project") return route.projectId;
  return lastBoardScope ?? ALL_SCOPE;
}

// ---------------------------------------------------------------------------
// The service's terminals
// ---------------------------------------------------------------------------

/** The list after a terminal.created / updated / removed event (any other event leaves it as it is). */
export function applyTerminalEvent(list: readonly TerminalInfo[], event: HarnessEvent): readonly TerminalInfo[] {
  switch (event.kind) {
    case "terminal.created":
    case "terminal.updated": {
      const i = list.findIndex((t) => t.id === event.terminal.id);
      if (i === -1) return [...list, event.terminal];
      const next = list.slice();
      next[i] = event.terminal;
      return next;
    }
    case "terminal.removed":
      return list.some((t) => t.id === event.id) ? list.filter((t) => t.id !== event.id) : list;
    default:
      return list;
  }
}

/** A home folder (macOS or Linux layout) shortened to `~` for display. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** A terminal's palette row: what it is (its title, else the program), and where it is and what runs. */
export function terminalRow(t: Pick<TerminalInfo, "title" | "process" | "cwd" | "state">): { label: string; subtitle: string; keywords: string[] } {
  const label = t.title.trim() || t.process || "Terminal";
  const subtitle = [tildePath(t.cwd), t.state === "exited" ? "ended" : t.process].filter(Boolean).join(" · ");
  return { label, subtitle, keywords: [t.cwd, t.process, t.title].filter(Boolean) };
}

/** The project scope a terminal opens in on this Mac: its project's board, All projects when it has none or the project is gone. */
export function terminalOpenScope(t: Pick<TerminalInfo, "projectId">, projects: Readonly<Record<string, unknown>>): string {
  return t.projectId && projects[t.projectId] ? t.projectId : ALL_SCOPE;
}

/** "Process exited (code 1)"; a terminal the service no longer has (it restarted) has no code. */
export function exitLabel(exitCode: number | null): string {
  return exitCode === null ? "This terminal has ended" : `Process exited (code ${exitCode})`;
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

/**
 * Of the keys the app owns, the ones the terminal must not even see. The terminal marks every key
 * it handles with preventDefault, and a prevented ⌘ key never reaches the native menu, so menu
 * shortcuts (⌘T, ⌘N, ⌘1…) are kept from it entirely and go unhandled, as they do from a text field.
 * ⌃⌘ keys are the renderer's own (⌃⌘S toggles the sidebar in a window listener), so those still go
 * through it and on to that listener.
 */
export const menuKey = (e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "code">): boolean => appOwnsKey(e) && !e.ctrlKey;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

// The terminal's colors from the theme on screen (shared with the iPhone's terminal sheet).
export { terminalColors, type TerminalColors } from "@harness/terminal";
