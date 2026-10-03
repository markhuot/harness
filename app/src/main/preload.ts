// Preload bridge: the renderer's only access to Electron. Exposed as window.harness.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { ConnectionResult, HarnessBridge, MenuCommand, TerminalExit, ThemeState } from "./types";
import { stampTheme } from "./theme";

const bridge: HarnessBridge = {
  getConnection: () => ipcRenderer.invoke("harness:getConnection"),
  retryService: () => ipcRenderer.invoke("harness:retryService"),
  onConnection: (cb) => {
    const listener = (_e: IpcRendererEvent, conn: ConnectionResult) => cb(conn);
    ipcRenderer.on("harness:connection", listener);
    return () => ipcRenderer.removeListener("harness:connection", listener);
  },
  reloadToken: (rotated) => ipcRenderer.invoke("harness:reloadToken", rotated),
  restartService: () => ipcRenderer.invoke("harness:restartService"),
  setServiceMode: (mode) => ipcRenderer.invoke("harness:setServiceMode", mode),
  pickDirectory: (opts) => ipcRenderer.invoke("harness:pickDirectory", opts),
  openExternal: (url) => ipcRenderer.invoke("harness:openExternal", url),
  revealInFinder: (path) => ipcRenderer.invoke("harness:revealInFinder", path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  showContextMenu: (items) => ipcRenderer.invoke("harness:contextMenu", items),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand, viaKey?: boolean) => cb(cmd, !!viaKey);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.removeListener("menu", listener);
  },
  getTheme: () => ipcRenderer.sendSync("harness:getThemeSync") as ThemeState,
  setTheme: (patch) => ipcRenderer.invoke("harness:setTheme", patch),
  onThemeChange: (cb) => {
    const listener = (_e: IpcRendererEvent, state: ThemeState) => cb(state);
    ipcRenderer.on("theme", listener);
    return () => ipcRenderer.removeListener("theme", listener);
  },
  setSidebarVisible: (visible) => ipcRenderer.send("harness:sidebarVisible", visible),
  terminal: {
    ensure: (id, opts) => ipcRenderer.invoke("harness:terminal:ensure", id, opts),
    write: (id, data) => ipcRenderer.invoke("harness:terminal:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke("harness:terminal:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("harness:terminal:kill", id),
    list: () => ipcRenderer.invoke("harness:terminal:list"),
    onData: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string, end: number) => cb(id, data, end);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onExit: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, exit: TerminalExit) => cb(id, exit);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },
  popout: {
    open: (opts) => ipcRenderer.invoke("harness:popout:open", opts),
    close: (id) => ipcRenderer.invoke("harness:popout:close", id),
    showMain: (route) => ipcRenderer.invoke("harness:popout:showMain", route),
    list: () => ipcRenderer.invoke("harness:popout:list"),
    onClosed: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string) => cb(id);
      ipcRenderer.on("popout:closed", listener);
      return () => ipcRenderer.removeListener("popout:closed", listener);
    },
    onNavigate: (cb) => {
      const listener = (_e: IpcRendererEvent, route: string) => cb(route);
      ipcRenderer.on("navigate", listener);
      return () => ipcRenderer.removeListener("navigate", listener);
    },
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("harness", bridge);

// Stamp the theme on <html> as early as possible (the renderer keeps it current): data-theme,
// data-theme-id and the tokens as custom properties, so the first paint is already in the theme.
try {
  const state = bridge.getTheme();
  const stamp = () => !!document.documentElement && (stampTheme(document.documentElement, state), true);
  if (!stamp()) document.addEventListener("readystatechange", stamp, { once: true });
} catch {}
