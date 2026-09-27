// Preload bridge: the renderer's only access to Electron. Exposed as window.harness.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HarnessBridge, MenuCommand } from "./types";

const bridge: HarnessBridge = {
  getConnection: () => ipcRenderer.invoke("harness:getConnection"),
  retryService: () => ipcRenderer.invoke("harness:retryService"),
  pickDirectory: () => ipcRenderer.invoke("harness:pickDirectory"),
  openExternal: (url) => ipcRenderer.invoke("harness:openExternal", url),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand) => cb(cmd);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.removeListener("menu", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("harness", bridge);
