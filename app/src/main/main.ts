// Electron main process. Owns the window, the menu and the connection to the service.
// Agents run in the service; quitting the app never stops them.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, type MenuItemConstructorOptions } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureService } from "./service";
import type { ConnectionResult, MenuCommand } from "./types";

// The app root holds package.json, resources/ and dist/ — in dev and inside the packaged .app.
// (Not __dirname: bun build inlines it as the source directory.)
const appRoot = app.getAppPath();
const rendererIndex = join(appRoot, "dist", "renderer", "index.html");

app.setName("Harness");

// Debug / screenshot hooks (used by scripts/shoot.ts):
//   HARNESS_THEME=dark|light   force the theme
//   HARNESS_ROUTE=#/ticket/X   open the renderer at a route
//   HARNESS_CAPTURE=/path.png  capture the window after HARNESS_CAPTURE_DELAY ms, then quit
const debug = {
  theme: process.env.HARNESS_THEME as "dark" | "light" | undefined,
  route: process.env.HARNESS_ROUTE,
  capture: process.env.HARNESS_CAPTURE,
  captureDelay: Number(process.env.HARNESS_CAPTURE_DELAY ?? 2500),
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101113" : "#fbfbfc",
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
          const image = await win.webContents.capturePage();
          mkdirSync(dirname(debug.capture!), { recursive: true });
          writeFileSync(debug.capture!, image.toPNG());
          console.log(`captured ${debug.capture}`);
        } catch (e) {
          console.error("capture failed", e);
        }
        app.exit(0);
      }, debug.captureDelay);
    });
  }
  return win;
}

function sendMenu(cmd: MenuCommand) {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    createWindow();
    return;
  }
  win.webContents.send("menu", cmd);
  win.show();
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Harness",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => sendMenu("settings") },
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
        { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new-session") },
        { type: "separator" },
        { label: "Board", accelerator: "CmdOrCtrl+1", click: () => sendMenu("board") },
        { label: "Inbox", accelerator: "CmdOrCtrl+2", click: () => sendMenu("inbox") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
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
      submenu: [{ label: "Harness on GitHub", click: () => void shell.openExternal("https://github.com/markhuot") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC bridge (see preload.ts)
// ---------------------------------------------------------------------------

ipcMain.handle("harness:getConnection", () => getConnection());
ipcMain.handle("harness:retryService", () => getConnection(true));
ipcMain.handle("harness:pickDirectory", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const opts = { title: "Add project", buttonLabel: "Add project", properties: ["openDirectory", "createDirectory"] as const };
  const result = win ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] }) : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("harness:openExternal", async (_e, url: unknown) => {
  if (typeof url === "string" && /^(https?|mailto):/.test(url)) await shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (debug.theme) nativeTheme.themeSource = debug.theme;
else nativeTheme.themeSource = "system";

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

app.on("window-all-closed", () => {
  // macOS convention: keep the app alive without windows. Agents live in the service anyway.
  if (process.platform !== "darwin") app.quit();
});
