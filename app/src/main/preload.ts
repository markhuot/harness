// Preload bridge: the renderer's only access to Electron. Exposed as window.harness.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HarnessBridge, MenuCommand, ThemeState } from "./types";

const bridge: HarnessBridge = {
  getConnection: () => ipcRenderer.invoke("harness:getConnection"),
  retryService: () => ipcRenderer.invoke("harness:retryService"),
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
  setTheme: (preference) => ipcRenderer.invoke("harness:setTheme", preference),
  onThemeChange: (cb) => {
    const listener = (_e: IpcRendererEvent, state: ThemeState) => cb(state);
    ipcRenderer.on("theme", listener);
    return () => ipcRenderer.removeListener("theme", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("harness", bridge);

// Stamp the resolved theme on <html> as early as possible (the renderer keeps it current).
try {
  const { resolved } = bridge.getTheme();
  const stamp = () => document.documentElement && (document.documentElement.dataset.theme = resolved);
  if (!stamp()) document.addEventListener("readystatechange", stamp, { once: true });
} catch {}
