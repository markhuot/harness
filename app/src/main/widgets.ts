// The Mac desktop widgets (ios/Widgets, built as HarnessMacWidgets.appex and embedded by
// scripts/package.ts). The widget is a sandboxed extension: it can't read ~/.harness/token, so the
// app writes where the service is into the App Group container they share, and the widget fetches
// the board from the service itself. A bundled helper (Contents/MacOS/harness-widgets-reload)
// reloads the widget when the board changes while the app runs (the renderer sends
// renderer/state/widgets.ts widgetSignature). harness:// links from the widget
// open the ticket in the main window.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionResult } from "./types";

/** The team-prefixed App Group (WidgetShared.macAppGroup), which needs no provisioning profile. */
export const WIDGET_APP_GROUP = "47P4ZSALX4.com.markhuot.harness";
/** WidgetShared.hostFile */
export const WIDGET_HOST_FILE = "widget-host.json";
/** The helper scripts/package.ts compiles from ios/Widgets/macOS/reload-widgets.swift. */
export const WIDGET_RELOAD_HELPER = "harness-widgets-reload";

export function widgetGroupDir(home: string): string {
  return join(home, "Library", "Group Containers", WIDGET_APP_GROUP);
}

/** WidgetHost (HarnessKit) as JSON; null when there's no connection to hand the widget. */
export interface WidgetHost {
  baseUrl: string;
  token: string;
  name?: string;
  lightTheme?: string;
  darkTheme?: string;
}

export function widgetHost(conn: ConnectionResult | null, themes: { lightTheme: string; darkTheme: string }): WidgetHost | null {
  if (!conn || "error" in conn || !conn.token) return null;
  return { baseUrl: conn.baseUrl, token: conn.token, name: "This Mac", lightTheme: themes.lightTheme, darkTheme: themes.darkTheme };
}

/**
 * Writes (or with null, removes) the host file atomically. The token is in it, so it's readable
 * only by this user; the group container is already private to the app and its widget.
 */
export function writeWidgetHost(dir: string, host: WidgetHost | null): void {
  const file = join(dir, WIDGET_HOST_FILE);
  if (!host) return rmSync(file, { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(host), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Calls `reload` when the signature changes: right away the first time, then at most once per
 * `minGapMs`, with a trailing call so the last change always lands.
 */
export class WidgetReloader {
  private last: string | null = null;
  private pending: string | null = null;
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly reload: () => void,
    private readonly minGapMs = 5_000,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  changed(signature: string): void {
    if (signature === (this.pending ?? this.last)) return;
    this.pending = signature;
    if (this.timer !== null) return;
    const wait = this.lastAt + this.minGapMs - this.now();
    if (wait <= 0) return this.fire();
    this.timer = this.schedule(() => {
      this.timer = null;
      this.fire();
    }, wait);
  }

  private fire(): void {
    if (this.pending === null || this.pending === this.last) return void (this.pending = null);
    this.last = this.pending;
    this.pending = null;
    this.lastAt = this.now();
    this.reload();
  }
}

/** harness://ticket/<key> → the main window's route for it; harness://board → the board. */
export function routeForLink(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "harness:") return null;
  if (u.hostname === "board") return "#/board/all";
  if (u.hostname !== "ticket") return null;
  const key = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!key || key.includes("/")) return null;
  return `#/board/all/ticket/${encodeURIComponent(key)}`;
}
