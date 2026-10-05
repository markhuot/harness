// What Settings → Extensions and the browser's extensions menu say about each extension, on the
// Mac and on iPhone and iPad (HarnessKit's Extensions.swift ports it; fixtures/cases/extensions.ts).

import type { BrowserExtension, BrowserExtensionList } from "../protocol";

export interface ExtensionNote {
  /** A short label beside the name, when its status needs one. */
  badge?: string;
  /** A line under the name. */
  text?: string;
  tone: "normal" | "error";
}

export function extensionNote(ext: BrowserExtension): ExtensionNote {
  if (ext.source === "chrome") {
    return { badge: ext.byPolicy ? "Installed by your organization" : ext.enabled ? undefined : "Off", text: ext.description, tone: "normal" };
  }
  switch (ext.status) {
    case "loaded":
      return { text: ext.source === "webstore" ? ext.description : undefined, tone: "normal" };
    case "pending":
      return { badge: "Waiting", text: ext.source === "webstore" ? "Installs the next time the browser starts." : "Loads the next time the browser starts.", tone: "normal" };
    case "off":
      return { badge: "Off", tone: "normal" };
    case "blocked":
      return { badge: "Blocked", text: ext.error ?? "Your organization's Chrome policy doesn't allow it.", tone: "error" };
    case "error":
      return { badge: "Error", text: ext.error ?? "Chrome couldn't install or load it.", tone: "error" };
  }
}

/** How many extensions wait for a running browser to restart (one that isn't running picks them up when it next starts). */
export function extensionsWaiting(list: BrowserExtensionList): number {
  return list.running ? list.extensions.filter((e) => e.status === "pending").length : 0;
}

/** The extensions whose toolbar button can run now, by name: what the browser's extensions menu lists. */
export function runnableExtensions(list: BrowserExtensionList): BrowserExtension[] {
  return list.extensions.filter((e) => e.status === "loaded" && (e.hasAction || e.optionsUrl)).sort((a, b) => a.name.localeCompare(b.name));
}
