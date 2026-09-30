// Pop-out windows, the pure parts: checking what the renderer asks for, where a new window goes,
// and which menu commands a pop-out leaves to the main window. main.ts owns the windows themselves;
// the renderer side is renderer/components/PopoutWindow.tsx. Tested in popouts.test.ts.

import type { PopoutOpenOptions, ScreenRect } from "./types";

/** The smallest a pop-out window gets (a ticket pane's minimum width, and a usable height). */
export const POPOUT_MIN = { width: 360, height: 240 } as const;
/** The size a pop-out starts at, at least: a pane squeezed beside others is roomier on its own. */
export const POPOUT_START = { width: 560, height: 420 } as const;
/** How far a new pop-out sits from where its pane was, so it reads as a new window. */
export const POPOUT_OFFSET = 28;

const POPOUT_ID = /^[A-Za-z0-9-]{1,64}$/;

const isRect = (v: unknown): v is ScreenRect =>
  !!v && typeof v === "object" && (["x", "y", "width", "height"] as const).every((k) => Number.isFinite((v as Record<string, unknown>)[k]));

/** The renderer's open request, checked: a plain id, a pop-out route for that id, and bounds that are numbers. Null when unusable. */
export function parsePopoutOptions(raw: unknown): PopoutOpenOptions | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, route, bounds } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !POPOUT_ID.test(id)) return null;
  if (typeof route !== "string" || !route.startsWith(`#/popout/${id}/`)) return null;
  return isRect(bounds) ? { id, route, bounds } : { id, route };
}

/**
 * Where a pop-out window opens: its pane's spot, nudged down and right by POPOUT_OFFSET, at least
 * POPOUT_START in size, and kept inside the display's work area (shrunk to fit when it's bigger).
 * With no pane bounds it's centered in the work area.
 */
export function popoutBounds(pane: ScreenRect | undefined, workArea: ScreenRect): ScreenRect {
  const width = Math.min(Math.max(Math.round(pane?.width ?? 0), POPOUT_START.width), workArea.width);
  const height = Math.min(Math.max(Math.round(pane?.height ?? 0), POPOUT_START.height), workArea.height);
  const wantX = pane ? Math.round(pane.x) + POPOUT_OFFSET : workArea.x + (workArea.width - width) / 2;
  const wantY = pane ? Math.round(pane.y) + POPOUT_OFFSET : workArea.y + (workArea.height - height) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi));
  return {
    x: clamp(wantX, workArea.x, workArea.x + workArea.width - width),
    y: clamp(wantY, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/**
 * Menu commands (renderer/state/keys.ts ids) that belong to the main window even while a pop-out
 * has focus: a pop-out holds one pane, with no board, sidebar or other views to go to. The rest
 * (closing the pane, the palette, a ticket's tabs) go to the focused window.
 */
const MAIN_WINDOW_COMMANDS = new Set(["new-session", "new-terminal", "board", "inbox", "settings", "toggle-sidebar"]);

export const commandGoesToMain = (cmd: string) => MAIN_WINDOW_COMMANDS.has(cmd);
