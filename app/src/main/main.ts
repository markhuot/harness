// Electron main process. Owns the window, the menu and the connection to the service.
// Agents run in the service; quitting the app never stops them.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, type MenuItemConstructorOptions } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodePtySpawn } from "./pty";
import { ensureService, reloadToken, restartService } from "./service";
import { TerminalManager } from "./terminals";
import type { ContextMenuItem, ConnectionResult, MenuCommand, PickDirectoryOptions, ThemePatch, ThemeState } from "./types";
import { COMMAND_BY_ID, commandAccelerator } from "../renderer/state/keys";
import { applyPatch, effectiveSource, forcedAppearance, parseForcedTheme, parseForcedThemeId, parseStoredChoice, storedChoiceFields, themeStateFor, windowBackground } from "./theme";

// The app root holds package.json, resources/ and dist/ — in dev and inside the packaged .app.
// (Not __dirname: bun build inlines it as the source directory.)
const appRoot = app.getAppPath();
const rendererIndex = join(appRoot, "dist", "renderer", "index.html");

app.setName("Harness");

// Debug / screenshot hooks (used by scripts/shoot.ts, scripts/smoke.ts):
//   HARNESS_THEME=dark|light   force the theme (overrides Settings → Appearance)
//   HARNESS_THEME_ID=<id>      force one color theme, e.g. catppuccin-mocha (and its appearance)
//   HARNESS_MENU_AUTOPICK=id,… context menus pick the first of these items instead of popping up (smoke tests)
//   HARNESS_ROUTE=#/ticket/X   open the renderer at a route
//   HARNESS_CAPTURE=/path.png  capture the window after HARNESS_CAPTURE_DELAY ms, then quit
//   HARNESS_CAPTURE_SETUP=js   run this in the renderer just before the capture (e.g. click a
//                              toggle); the capture profile's localStorage is cleared afterwards
const debug = {
  theme: { appearance: parseForcedTheme(process.env.HARNESS_THEME), theme: parseForcedThemeId(process.env.HARNESS_THEME_ID) },
  route: process.env.HARNESS_ROUTE,
  capture: process.env.HARNESS_CAPTURE,
  captureDelay: Number(process.env.HARNESS_CAPTURE_DELAY ?? 2500),
  captureSetup: process.env.HARNESS_CAPTURE_SETUP,
};
if (process.env.HARNESS_USER_DATA) app.setPath("userData", process.env.HARNESS_USER_DATA);
else if (debug.capture) app.setPath("userData", join(app.getPath("temp"), "harness-capture-profile"));

let connection: Promise<ConnectionResult> | null = null;
function getConnection(force = false) {
  if (!connection || force) connection = ensureService(appRoot);
  return connection;
}

// ---------------------------------------------------------------------------
// Window bounds persistence
// ---------------------------------------------------------------------------

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}
const boundsFile = () => join(app.getPath("userData"), "window-state.json");

function loadBounds(): Bounds {
  const fallback: Bounds = { width: 1440, height: 900 };
  if (debug.capture) return fallback;
  try {
    const b = JSON.parse(readFileSync(boundsFile(), "utf8")) as Bounds;
    if (!(b.width > 400 && b.height > 300)) return fallback;
    // Only restore a position that is still on a connected display.
    if (b.x !== undefined && b.y !== undefined) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width - 100 && b.y! < a.y + a.height - 100;
      });
      if (!visible) return { width: b.width, height: b.height };
    }
    return b;
  } catch {
    return fallback;
  }
}

function saveBounds(win: BrowserWindow) {
  if (debug.capture) return;
  try {
    const b = win.getNormalBounds();
    mkdirSync(dirname(boundsFile()), { recursive: true });
    writeFileSync(boundsFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

// ---------------------------------------------------------------------------
// Appearance: preference persisted in userData/preferences.json, applied via nativeTheme
// (window chrome, vibrancy, scrollbars, prefers-color-scheme) and pushed to renderers, which
// mirror the resolved theme on <html data-theme>.
// ---------------------------------------------------------------------------

const prefsFile = () => join(app.getPath("userData"), "preferences.json");

function readPrefs(): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(prefsFile(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let themeChoice = (() => {
  try {
    return parseStoredChoice(readFileSync(prefsFile(), "utf8"));
  } catch {
    return parseStoredChoice(null);
  }
})();

function themeState(): ThemeState {
  return themeStateFor(themeChoice, nativeTheme.shouldUseDarkColors, debug.theme);
}

function applyTheme() {
  nativeTheme.themeSource = effectiveSource(themeChoice.appearance, forcedAppearance(debug.theme));
}

function setThemeChoice(patch: ThemePatch) {
  themeChoice = applyPatch(themeChoice, patch);
  try {
    mkdirSync(dirname(prefsFile()), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...storedChoiceFields(themeChoice) }, null, 2));
  } catch (e) {
    console.error("could not save preferences", e);
  }
  applyTheme(); // fires nativeTheme "updated" when the resolved theme changes
  broadcastTheme();
}

let lastBroadcast = "";
function broadcastTheme() {
  const state = themeState();
  const sig = JSON.stringify(state);
  if (sig === lastBroadcast) return;
  lastBroadcast = sig;
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(windowBackground(state));
    w.webContents.send("theme", state);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const bounds = loadBounds();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 560,
    title: "Harness",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: windowBackground(themeState()),
    show: false,
    webPreferences: {
      preload: join(appRoot, "dist", "main", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The renderer is a file:// page (Origin: null) talking to http://127.0.0.1:<port>. The
      // service answers CORS preflights for null/file:// origins, so same-origin checks stay on.
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow = win;
  if (bounds.maximized) win.maximize();

  win.once("ready-to-show", () => {
    if (!debug.capture) win.show();
  });
  if (debug.capture) win.showInactive();

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveBounds(win), 400);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("close", () => saveBounds(win));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // External links open in the default browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  win.webContents.on("preload-error", (_e, path, error) => console.error(`preload error in ${path}:`, error));
  if (debug.capture || process.env.HARNESS_DEBUG) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "error" || e.level === "warning") console.error(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
  }

  void win.loadFile(rendererIndex, debug.route ? { hash: debug.route.replace(/^#/, "") } : undefined);

  if (debug.capture) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (debug.captureSetup) {
            await win.webContents.executeJavaScript(debug.captureSetup);
            await new Promise((r) => setTimeout(r, 400));
          }
          const image = await win.webContents.capturePage();
          mkdirSync(dirname(debug.capture!), { recursive: true });
          writeFileSync(debug.capture!, image.toPNG());
          console.log(`captured ${debug.capture}`);
          // Shots share one profile: don't let one shot's UI preferences leak into the next.
          await win.webContents.executeJavaScript("try { localStorage.clear() } catch {}");
        } catch (e) {
          console.error("capture failed", e);
        }
        app.exit(0);
      }, debug.captureDelay);
    });
  }
  return win;
}

/** `viaKey`: the item's shortcut was pressed (Electron's triggeredByAccelerator), not the item clicked. */
function sendMenu(cmd: MenuCommand, viaKey = false) {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    // With no window there's no pane to close; anything else opens one.
    if (cmd !== "pane.close") createWindow();
    return;
  }
  win.webContents.send("menu", cmd, viaKey);
  win.show();
}

/**
 * A menu item for a keyboard command (renderer/state/keys.ts): its label and ⌘ chord come from the
 * registry, and choosing it sends the command's id to the renderer, which runs it where the focus
 * is. The renderer handles the same keys itself; the menu is what reaches them from a plugin
 * iframe or a terminal, which keep keys from the page.
 */
function commandItem(id: string, label?: string): MenuItemConstructorOptions {
  return {
    label: label ?? COMMAND_BY_ID.get(id)?.label ?? id,
    accelerator: commandAccelerator(id),
    click: (_item, _win, event) => sendMenu(id, !!event.triggeredByAccelerator),
  };
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Harness",
      submenu: [
        { role: "about" },
        { type: "separator" },
        commandItem("settings", "Settings…"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        commandItem("new-session", "New Session"),
        commandItem("new-terminal"),
        commandItem("open-file"),
        { type: "separator" },
        commandItem("board", "Board"),
        commandItem("inbox", "Inbox"),
        { type: "separator" },
        // ⌘W closes the focused pane, or the window when the board (or no pane) has focus.
        commandItem("pane.close"),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // ⌃⌘S is the macOS standard (Finder, Mail, Notes' HIG entry); ⌘0 is already Actual Size.
        // The renderer handles the key itself and reports the state back for the checkmark.
        { id: "toggle-sidebar", label: "Show Sidebar", type: "checkbox", checked: true, accelerator: commandAccelerator("toggle-sidebar"), click: (_i, _w, e) => sendMenu("toggle-sidebar", !!e.triggeredByAccelerator) },
        commandItem("palette"),
        { type: "separator" },
        commandItem("tab.next"),
        commandItem("tab.prev"),
        { type: "separator" },
        commandItem("pane.left"),
        commandItem("pane.right"),
        commandItem("pane.up"),
        commandItem("pane.down"),
        commandItem("pane.zoom", "Maximize Pane"),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [commandItem("shortcuts"), { type: "separator" }, { label: "Harness on GitHub", click: () => void shell.openExternal("https://github.com/markhuot") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC bridge (see preload.ts)
// ---------------------------------------------------------------------------

ipcMain.handle("harness:getConnection", () => getConnection());
ipcMain.handle("harness:retryService", () => getConnection(true));
ipcMain.handle("harness:restartService", async () => restartService(appRoot, await getConnection()));
ipcMain.handle("harness:reloadToken", async (_e, rotated: unknown) => {
  const next = reloadToken(await getConnection(), typeof rotated === "string" ? rotated : undefined);
  // Keep the refreshed token for later getConnection() calls (reloads, new windows).
  if (!("error" in next)) connection = Promise.resolve(next);
  return next;
});
ipcMain.handle("harness:pickDirectory", async (e, raw: PickDirectoryOptions | undefined) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const opts: Electron.OpenDialogOptions = {
    title: str(raw?.title) ?? "Add project",
    buttonLabel: str(raw?.buttonLabel) ?? "Add project",
    defaultPath: str(raw?.defaultPath),
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("harness:revealInFinder", (_e, path: unknown) => {
  if (typeof path === "string" && path.startsWith("/")) shell.showItemInFolder(path);
});
ipcMain.handle("harness:contextMenu", (e, raw: unknown) => {
  const items = Array.isArray(raw) ? (raw as ContextMenuItem[]) : [];
  const autopick = process.env.HARNESS_MENU_AUTOPICK?.split(",");
  if (autopick) {
    const hit = items.find((i) => i.type !== "separator" && autopick.includes(i.id) && i.enabled !== false);
    return hit && hit.type !== "separator" ? hit.id : null;
  }
  return new Promise<string | null>((resolve) => {
    const template: MenuItemConstructorOptions[] = items.map((i) =>
      i.type === "separator" ? { type: "separator" } : { label: String(i.label), enabled: i.enabled !== false, click: () => resolve(String(i.id)) },
    );
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    // On macOS the close callback can fire before the item's click; give the click a beat to win.
    Menu.buildFromTemplate(template).popup({ window: win, callback: () => void setTimeout(() => resolve(null), 100) });
  });
});
ipcMain.on("harness:getThemeSync", (e) => {
  e.returnValue = themeState();
});
ipcMain.handle("harness:setTheme", (_e, patch: unknown) => {
  // Older renderers send the bare preference string.
  setThemeChoice(typeof patch === "string" ? { preference: patch as ThemePatch["preference"] } : (patch as ThemePatch));
  return themeState();
});
ipcMain.on("harness:sidebarVisible", (_e, visible: unknown) => {
  const item = Menu.getApplicationMenu()?.getMenuItemById("toggle-sidebar");
  if (item && typeof visible === "boolean") item.checked = visible;
});
ipcMain.handle("harness:openExternal", async (_e, url: unknown) => {
  if (typeof url === "string" && /^(https?|mailto):/.test(url)) await shell.openExternal(url);
});

// Terminals: PTYs live here, keyed by the renderer's pane leaf id, and outlive pane remounts.
// Output and exits go to every window; the renderer picks its ids. node-pty loads on first use.
const broadcast = (channel: string, ...args: unknown[]) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
};
let terminalManager: TerminalManager | null = null;
const terminals = () =>
  (terminalManager ??= new TerminalManager({
    spawn: nodePtySpawn(),
    events: { data: (id, data, end) => broadcast("terminal:data", id, data, end), exit: (id, exit) => broadcast("terminal:exit", id, exit) },
  }));
ipcMain.handle("harness:terminal:ensure", (_e, id: unknown, opts: unknown) => terminals().ensure(id, opts));
ipcMain.handle("harness:terminal:write", (_e, id: unknown, data: unknown) => terminals().write(id, data));
ipcMain.handle("harness:terminal:resize", (_e, id: unknown, cols: unknown, rows: unknown) => terminals().resize(id, cols, rows));
ipcMain.handle("harness:terminal:kill", (_e, id: unknown) => terminalManager?.kill(id) ?? false);
ipcMain.handle("harness:terminal:list", () => terminalManager?.list() ?? []);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

applyTheme();
nativeTheme.on("updated", broadcastTheme);

app.whenReady().then(() => {
  // Packaged builds get the icon from the bundle; show it in the Dock during `bun run dev` too.
  if (!app.isPackaged && process.platform === "darwin") {
    const icon = nativeImage.createFromPath(join(appRoot, "resources", "icon.icns"));
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
  buildMenu();
  void getConnection(); // start ensuring the service while the window loads
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never leave shells behind: SIGHUP every PTY on the way out (closing the PTYs hangs up the rest).
app.on("will-quit", () => terminalManager?.killAll());
process.on("exit", () => terminalManager?.killAll());

app.on("window-all-closed", () => {
  // macOS convention: keep the app alive without windows. Agents live in the service anyway.
  if (process.platform !== "darwin") app.quit();
});
