// Preload bridge: the renderer's only access to Electron. Exposed as window.harness.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HarnessBridge, MenuCommand, TerminalExit, ThemeState } from "./types";
import { stampTheme } from "./theme";

const bridge: HarnessBridge = {
  getConnection: () => ipcRenderer.invoke("harness:getConnection"),
  retryService: () => ipcRenderer.invoke("harness:retryService"),
  reloadToken: (rotated) => ipcRenderer.invoke("harness:reloadToken", rotated),
  pickDirectory: (opts) => ipcRenderer.invoke("harness:pickDirectory", opts),
  openExternal: (url) => ipcRenderer.invoke("harness:openExternal", url),
  revealInFinder: (path) => ipcRenderer.invoke("harness:revealInFinder", path),
  showContextMenu: (items) => ipcRenderer.invoke("harness:contextMenu", items),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand) => cb(cmd);
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
      const listener = (_e: IpcRendererEvent, id: string, data: string) => cb(id, data);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onExit: (cb) => {
      const listener = (_e: IpcRendererEvent, id: string, exit: TerminalExit) => cb(id, exit);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
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
