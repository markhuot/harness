// Chrome extensions for the service's browser (Settings → Extensions).
//
// Two kinds, installed two ways:
// - Chrome Web Store extensions are Chrome's own installs. The service writes
//   <profile>/External Extensions/<id>.json, Chrome installs the store's build the next time it
//   starts (and keeps it updated), and the service turns it on through chrome://extensions, whose
//   page can call chrome.management, as a person clicking its switch would. Chrome's extension
//   policy applies to these exactly as to any install, and the store page's
//   chrome.webstorePrivate.getExtensionStatus says up front whether the policy allows one.
// - Unpacked folders (an extension being developed) are loaded over CDP (Extensions.loadUnpacked,
//   which --enable-unsafe-extension-debugging turns on). Chrome forgets those when it stops, so the
//   service loads them again after every launch. A policy that disables unpacked extensions makes
//   Chrome refuse them, with its own message.
//
// extensions.json in the extensions folder lists what the user added and whether each is on, so
// Settings can list them while Chrome isn't running, and so each launch can put Chrome in line.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserExtension, BrowserExtensionSource } from "@harness/shared";

/** A registry entry: an extension the user added, and whether they have it on. */
export interface StoredExtension {
  id: string;
  name: string;
  version: string;
  source: Exclude<BrowserExtensionSource, "chrome">;
  /** An unpacked extension's folder (Web Store extensions live in Chrome's profile). */
  path?: string;
  enabled: boolean;
  addedAt: number;
}

/** What an extension's manifest says that Settings and the browser pane show. */
export interface ManifestInfo {
  name: string;
  version: string;
  description?: string;
  /** It has a toolbar action (MV3 action, MV2 browser_action or page_action). */
  hasAction: boolean;
  /** Its options page, relative to the extension's folder. */
  optionsPage?: string;
}

const ID_RE = /^[a-p]{32}$/;

/** An extension ID from a bare ID or a Chrome Web Store link (either the current or the old store). Null when there's none. */
export function parseExtensionId(input: string): string | null {
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)chromewebstore\.google\.com$|^chrome\.google\.com$/.test(url.hostname)) return null;
  // /detail/<slug>/<id>, /detail/<id>, /webstore/detail/<slug>/<id>
  const id = url.pathname.split("/").filter(Boolean).reverse().find((part) => ID_RE.test(part));
  return id ?? null;
}

/** Resolve a "__MSG_name__" manifest string from the extension's default locale (then en). */
function localized(dir: string, manifest: any, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^__MSG_(.+)__$/.exec(value);
  if (!m) return value;
  const key = m[1]!.toLowerCase();
  for (const locale of [manifest.default_locale, "en", "en_US"]) {
    if (typeof locale !== "string") continue;
    try {
      const messages = JSON.parse(readFileSync(join(dir, "_locales", locale, "messages.json"), "utf8").replace(/^﻿/, ""));
      for (const [k, v] of Object.entries<any>(messages)) if (k.toLowerCase() === key && typeof v?.message === "string") return v.message;
    } catch {}
  }
  return value;
}

/** Read `dir`/manifest.json. Throws with a message for a folder that isn't an extension. */
export function readManifest(dir: string): ManifestInfo {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) throw new Error(`${dir} has no manifest.json, so it isn't an unpacked extension`);
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  if (!manifest || typeof manifest !== "object") throw new Error(`${file} isn't an extension manifest`);
  return {
    name: localized(dir, manifest, manifest.name) ?? "Unnamed extension",
    version: typeof manifest.version === "string" ? manifest.version : "",
    description: localized(dir, manifest, manifest.description),
    hasAction: !!(manifest.action ?? manifest.browser_action ?? manifest.page_action),
    optionsPage: typeof manifest.options_ui?.page === "string" ? manifest.options_ui.page : typeof manifest.options_page === "string" ? manifest.options_page : undefined,
  };
}

/** Where Chrome installed Web Store extension `id` in `profileDir` (its newest version's folder), or null. */
export function installedExtensionDir(profileDir: string, id: string): string | null {
  const root = join(profileDir, "Default", "Extensions", id);
  let versions: string[];
  try {
    versions = readdirSync(root).filter((v) => existsSync(join(root, v, "manifest.json")));
  } catch {
    return null;
  }
  if (!versions.length) return null;
  const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;
  return join(root, newest);
}

/** The file that tells Chrome to install Web Store extension `id` from the store when it starts. */
export function externalExtensionFile(profileDir: string, id: string): string {
  return join(profileDir, "External Extensions", `${id}.json`);
}

/** Ask Chrome to install `id` from the Chrome Web Store when it next starts. */
export function writeExternalExtension(profileDir: string, id: string): void {
  const file = externalExtensionFile(profileDir, id);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ external_update_url: "https://clients2.google.com/service/update2/crx" }));
}

/** Stop asking: Chrome uninstalls an external extension whose file is gone the next time it starts. */
export function removeExternalExtension(profileDir: string, id: string): void {
  rmSync(externalExtensionFile(profileDir, id), { force: true });
}

/**
 * What chrome.webstorePrivate.getExtensionStatus says about installing an extension, as an error
 * to refuse the install with (and its HTTP status), or null when it can be installed. "installed"
 * means the profile has it already (from an earlier install, or the organization's).
 */
export function webStoreStatusProblem(status: string, name: string): { status: number; message: string } | "installed" | null {
  switch (status) {
    case "installable":
      return null;
    case "enabled":
    case "disabled":
    case "terminated":
      return "installed";
    case "force_installed":
      return { status: 409, message: `Your organization already installs ${name} in this browser.` };
    case "can_request":
      return { status: 403, message: `Your organization's Chrome policy doesn't allow ${name}. You can ask your administrator to allow it from its Chrome Web Store page.` };
    case "request_pending":
      return { status: 403, message: `Your organization's Chrome policy doesn't allow ${name} yet: a request to allow it is waiting for your administrator.` };
    case "blocked_by_policy":
      return { status: 403, message: `Your organization's Chrome policy doesn't allow ${name}.` };
    case "blocklisted":
      return { status: 403, message: `Chrome blocks ${name} because it's on Google's list of harmful extensions.` };
    case "custodian_approval_required":
      return { status: 403, message: `${name} needs a parent's approval to install.` };
    case "deprecated_manifest_version":
      return { status: 422, message: `${name} is a Manifest V2 extension, which this version of Chrome no longer runs.` };
    case "corrupted":
      return { status: 422, message: `Chrome reports ${name} as corrupted.` };
    default:
      return { status: 422, message: `Chrome can't install ${name} (its Web Store status is "${status}").` };
  }
}

/** The extensions the user added, kept in <root>/extensions.json. */
export class ExtensionRegistry {
  private readonly file: string;

  constructor(readonly root: string) {
    this.file = join(root, "extensions.json");
  }

  list(): StoredExtension[] {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data?.extensions)
        ? data.extensions.filter((e: any) => typeof e?.id === "string" && (e.source === "webstore" || (e.source === "unpacked" && typeof e.path === "string")))
        : [];
    } catch {
      return [];
    }
  }

  get(id: string): StoredExtension | undefined {
    return this.list().find((e) => e.id === id);
  }

  /** Add an extension, or replace the entry with its ID. */
  put(entry: StoredExtension): void {
    this.write([...this.list().filter((e) => e.id !== entry.id), entry]);
  }

  remove(id: string): StoredExtension | undefined {
    const all = this.list();
    const found = all.find((e) => e.id === id);
    if (found) this.write(all.filter((e) => e.id !== id));
    return found;
  }

  private write(entries: StoredExtension[]): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ extensions: entries }, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * The public view of a registry entry: `dir` is the folder holding its manifest (an unpacked
 * folder, or Chrome's install of a Web Store extension; null before Chrome installed it), which
 * gives the current name, version, action and options page.
 */
export function describeExtension(entry: StoredExtension, dir: string | null, live: Pick<BrowserExtension, "status" | "error">): BrowserExtension {
  let info: ManifestInfo | null = null;
  try {
    if (dir) info = readManifest(dir);
  } catch {}
  const missing = entry.source === "unpacked" && !info;
  return {
    id: entry.id,
    name: info?.name ?? entry.name,
    version: info?.version ?? entry.version,
    description: info?.description,
    source: entry.source,
    path: entry.path,
    enabled: entry.enabled,
    hasAction: info?.hasAction ?? false,
    optionsUrl: info?.optionsPage ? `chrome-extension://${entry.id}/${info.optionsPage.replace(/^\/+/, "")}` : undefined,
    addedAt: entry.addedAt,
    status: missing ? "error" : live.status,
    error: missing ? `Its folder ${entry.path} is missing or has no readable manifest.json` : live.error,
  };
}
