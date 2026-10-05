// The browser's extensions: what Settings → Extensions lists and changes. extensions.ts explains
// how each kind installs; this keeps Chrome in line with the registry across launches.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AddBrowserExtensionBody, BrowserExtension, BrowserExtensionList } from "@harness/shared";
import { HarnessError } from "../orchestrator/errors.ts";
import type { CdpClient } from "./cdp.ts";
import {
  ExtensionRegistry,
  describeExtension,
  installedExtensionDir,
  parseExtensionId,
  readManifest,
  removeExternalExtension,
  webStoreStatusProblem,
  writeExternalExtension,
  type ManifestInfo,
  type StoredExtension,
} from "./extensions.ts";

export interface ExtensionHostOptions {
  profileDir: string;
  extensionsDir: string;
  /** The running Chrome's connection, starting Chrome when it isn't running. */
  start(): Promise<CdpClient>;
  /** The running Chrome's connection, or undefined; never starts Chrome. */
  live(): CdpClient | undefined;
  /** Restart Chrome (every tab's page closes and reloads), resolving once it's running again. */
  restart(): Promise<void>;
  /** Whether any session's tab has a page, which a restart would reload under it. */
  hasPages(): boolean;
  /** Keep Chrome from being stopped as idle while `fn` runs. */
  hold<T>(fn: () => Promise<T>): Promise<T>;
  now?: () => number;
  /**
   * How long after loading an unpacked extension to watch for Chrome turning it off, which is how
   * an organization's policy acts on one it doesn't allow when the policy arrives after the load.
   */
  policyWaitMs?: number;
  /** How long a launch waits for Chrome to install Web Store extensions from the store. */
  installWaitMs?: number;
}

/** chrome.management's view of an installed extension. */
interface ChromeExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** "admin" (an organization's policy), "normal", "sideload" (External Extensions), "development" (unpacked)… */
  installType: string;
  optionsUrl?: string;
  /** false: Chrome won't turn it on, as for one the organization's policy doesn't allow. */
  mayEnable?: boolean;
}

const blockedState = (name: string): LoadState => ({ status: "blocked", error: `Your organization's Chrome policy doesn't allow ${name}.` });

/** What went wrong (or right) the last time Chrome installed or loaded an extension. */
type LoadState = { status: "loaded" | "blocked" | "error"; error?: string };

/** The page chrome://extensions, whose chrome.management lists extensions and turns them on and off. */
interface ExtensionsPage {
  getAll(): Promise<ChromeExtension[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Chrome's refusal to load an unpacked folder, as a state: "disabled by the administrator" is policy. */
function refusal(message: string): LoadState {
  if (/disabled by (the|your) administrator/i.test(message)) {
    return { status: "blocked", error: "Your organization's Chrome policy doesn't allow unpacked extensions in this browser." };
  }
  return { status: "error", error: message };
}

export class ExtensionHost {
  /** Chrome's command-line flag for CDP's Extensions domain (unpacked folders, toolbar actions). */
  static readonly chromeArgs = ["--enable-unsafe-extension-debugging"];

  readonly registry: ExtensionRegistry;
  private states = new Map<string, LoadState>();
  /** chrome.management's view the last time it was read: Web Store installs and the organization's. */
  private chrome = new Map<string, ChromeExtension>();
  /** Web Store extensions removed while Chrome ran: off, and gone once Chrome restarts. Hidden until then. */
  private uninstalling = new Set<string>();
  /** This launch's Web Store sync (waiting for installs, turning them on or off). */
  private syncing: Promise<void> = Promise.resolve();
  /** Serializes changes, so two of them don't load, check and write the registry over each other. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: ExtensionHostOptions) {
    this.registry = new ExtensionRegistry(opts.extensionsDir);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Chrome just started (`cdp`), before any tab opened: load the unpacked folders that are on (Chrome
   * forgot them), then, without holding up the launch, wait for Chrome to install the Web Store
   * extensions and turn each on or off to match the registry.
   */
  async launched(cdp: CdpClient): Promise<void> {
    this.chrome.clear();
    for (const entry of this.registry.list()) {
      if (entry.source !== "unpacked" || !entry.enabled) continue;
      try {
        const { id } = await cdp.send("Extensions.loadUnpacked", { path: entry.path });
        if (id === entry.id) this.states.set(entry.id, { status: "loaded" });
        else {
          await cdp.send("Extensions.uninstall", { id }).catch(() => {});
          this.states.set(entry.id, { status: "error", error: `Its folder now holds extension ${id}, not ${entry.id}` });
        }
      } catch (e) {
        this.states.set(entry.id, refusal(errorText(e)));
      }
    }
    if (this.registry.list().some((e) => e.source === "webstore")) {
      this.syncing = this.opts.hold(() => this.syncWebStore(cdp)).catch(() => {});
    }
  }

  /** Resolves once this launch's Web Store sync is done. */
  synced(): Promise<void> {
    return this.syncing;
  }

  /** Everything in the browser: what Settings added, then what Chrome has from elsewhere (an organization's policy). */
  async list(): Promise<BrowserExtensionList> {
    const cdp = this.opts.live();
    if (cdp) await this.opts.hold(() => this.withExtensionsPage(cdp, async (page) => this.remember(await page.getAll()))).catch(() => {});
    return this.snapshot(!!this.opts.live());
  }

  /** Install from the Chrome Web Store, or load an unpacked folder. Validates the input before starting Chrome. */
  async add(body: AddBrowserExtensionBody): Promise<BrowserExtension> {
    if (body && typeof body === "object" && "webstore" in body) {
      const id = parseExtensionId(String(body.webstore ?? ""));
      if (!id) throw new HarnessError(400, "That isn't a Chrome Web Store link or a 32-letter extension ID");
      const existing = this.registry.get(id);
      if (existing) throw new HarnessError(409, `${existing.name} is already installed`);
      return this.serial(() => this.addWebStore(id));
    }
    const raw = body && typeof body === "object" && "path" in body ? String(body.path ?? "").trim() : "";
    if (!raw) throw new HarnessError(400, "Pass webstore (a Chrome Web Store link or extension ID) or path (an unpacked extension's folder)");
    const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HarnessError(400, `${path} isn't a folder`);
    let info: ManifestInfo;
    try {
      info = readManifest(path);
    } catch (e) {
      throw new HarnessError(400, errorText(e));
    }
    return this.serial(() => this.addUnpacked(path, info));
  }

  /** Turn an extension Settings added on or off: now when Chrome is running, else when it next starts. */
  async setEnabled(id: string, enabled: boolean): Promise<BrowserExtension> {
    const entry = this.mine(id);
    return this.serial(async () => {
      const cdp = this.opts.live();
      if (entry.source === "unpacked") {
        if (cdp && enabled) await this.loadChecked(cdp, entry.path!, entry.name, id);
        else if (cdp) await cdp.send("Extensions.uninstall", { id }).catch(() => {});
        if (!enabled) this.states.delete(id);
      } else if (cdp) {
        const installed = await this.withExtensionsPage(cdp, async (page) => (await page.getAll()).find((e) => e.id === id));
        if (enabled && installed && !installed.enabled && installed.mayEnable === false) throw new HarnessError(403, blockedState(entry.name).error!);
        if (installed) {
          try {
            await this.switchExtension(cdp, id, enabled);
          } catch (e) {
            throw new HarnessError(422, `Chrome couldn't turn ${entry.name} ${enabled ? "on" : "off"}: ${errorText(e)}`);
          }
        }
        this.states.delete(id);
        // Chrome reports the change a moment after it answers.
        await this.withExtensionsPage(cdp, async (page) => {
          const deadline = this.now() + 2000;
          let all = await page.getAll();
          while (installed && all.find((e) => e.id === id)?.enabled !== enabled && this.now() < deadline) {
            await Bun.sleep(100);
            all = await page.getAll();
          }
          this.remember(all);
        });
      }
      const next = { ...entry, enabled };
      this.registry.put(next);
      return this.describe(next);
    });
  }

  /**
   * Uninstall an extension Settings added. An unpacked folder leaves Chrome at once (the folder
   * itself stays). A Web Store extension is turned off at once and uninstalled by Chrome when it
   * next starts and finds its External Extensions file gone: chrome.management.uninstall needs a
   * person to confirm a dialog, which this Chrome never shows.
   */
  async remove(id: string): Promise<void> {
    const entry = this.mine(id);
    await this.serial(async () => {
      const cdp = this.opts.live();
      if (entry.source === "unpacked") await cdp?.send("Extensions.uninstall", { id }).catch(() => {});
      else {
        removeExternalExtension(this.opts.profileDir, id);
        this.uninstalling.add(id);
        if (cdp && this.chrome.get(id)?.enabled !== false) await this.switchExtension(cdp, id, false).catch(() => {});
      }
      this.chrome.delete(id);
      this.registry.remove(id);
      this.states.delete(id);
    });
  }

  /** Extension `id`, when it's on and running (for its toolbar action). Throws 404 or 409 saying why not. */
  runnable(id: string): BrowserExtension {
    const ext = this.snapshot(true).extensions.find((e) => e.id === id);
    if (!ext) throw new HarnessError(404, `No extension ${id} is installed`);
    if (ext.status === "off") throw new HarnessError(409, `${ext.name} is turned off`);
    if (ext.status !== "loaded") throw new HarnessError(409, ext.error ?? `${ext.name} isn't running in the browser yet`);
    return ext;
  }

  // ---------------------------------------------------------------------------

  private async addWebStore(id: string): Promise<BrowserExtension> {
    return this.opts.hold(async () => {
      const cdp = await this.opts.start();
      const { name, status } = await this.storeStatus(cdp, id);
      const problem = webStoreStatusProblem(status, name);
      if (problem && problem !== "installed") throw new HarnessError(problem.status, problem.message);
      writeExternalExtension(this.opts.profileDir, id);
      const entry: StoredExtension = { id, name, version: "", source: "webstore", enabled: true, addedAt: this.now() };
      this.registry.put(entry);
      this.states.delete(id);
      this.uninstalling.delete(id);
      if (problem === "installed") {
        // The profile has it already (from before, or removed but not yet uninstalled): turn it on.
        const installed = await this.withExtensionsPage(cdp, async (page) => (await page.getAll()).find((e) => e.id === id));
        if (installed && !installed.enabled && installed.mayEnable === false) this.states.set(id, blockedState(name));
        else if (installed && !installed.enabled) await this.switchExtension(cdp, id, true).catch((e) => this.states.set(id, { status: "error", error: errorText(e) }));
        await this.withExtensionsPage(cdp, async (page) => this.remember(await page.getAll()));
      } else if (!this.opts.hasPages()) {
        // Chrome installs it when it starts, and no page would reload: restart now and wait for it.
        await this.opts.restart();
        await this.synced();
      }
      // The store's answer can come before Chrome has the organization's policy (a new profile's
      // first minutes): Chrome then installs the extension but won't turn it on. Undo the install;
      // Chrome removes it when it next starts without its file.
      const state = this.states.get(id);
      if (state?.status === "blocked") {
        removeExternalExtension(this.opts.profileDir, id);
        this.uninstalling.add(id);
        this.registry.remove(id);
        this.states.delete(id);
        this.chrome.delete(id);
        throw new HarnessError(403, state.error!);
      }
      return this.describe(this.registry.get(id) ?? entry);
    });
  }

  private async addUnpacked(path: string, info: ManifestInfo): Promise<BrowserExtension> {
    return this.opts.hold(async () => {
      const cdp = await this.opts.start();
      const id = await this.loadChecked(cdp, path, info.name);
      const previous = this.registry.get(id);
      if (previous?.source === "webstore") {
        await cdp.send("Extensions.uninstall", { id }).catch(() => {});
        throw new HarnessError(409, `${previous.name} (extension ${id}) is installed from the Chrome Web Store; remove it before loading its folder`);
      }
      const entry: StoredExtension = { id, name: info.name, version: info.version, source: "unpacked", path, enabled: true, addedAt: previous?.addedAt ?? this.now() };
      this.registry.put(entry);
      return this.describe(entry);
    });
  }

  /** Load an unpacked folder and watch it for policyWaitMs; Chrome refusing it or turning it off throws (403 for policy). */
  private async loadChecked(cdp: CdpClient, path: string, name: string, expectedId?: string): Promise<string> {
    let id: string;
    try {
      ({ id } = await cdp.send("Extensions.loadUnpacked", { path }));
    } catch (e) {
      const state = refusal(errorText(e));
      if (state.status === "blocked") throw new HarnessError(403, state.error!);
      throw new HarnessError(422, `Chrome couldn't load ${name}: ${errorText(e)}`);
    }
    if (expectedId && id !== expectedId) {
      await cdp.send("Extensions.uninstall", { id }).catch(() => {});
      throw new HarnessError(422, `${path} now holds extension ${id}, not ${expectedId}`);
    }
    if (await this.turnedOff(cdp, id, this.opts.policyWaitMs ?? 2000)) {
      await cdp.send("Extensions.uninstall", { id }).catch(() => {});
      throw new HarnessError(
        403,
        `Chrome turned ${name} off as soon as it loaded, which is what an organization's Chrome policy does to an extension it doesn't allow. Ask whoever manages this computer to allow extension ${id}.`,
      );
    }
    this.states.set(id, { status: "loaded" });
    return id;
  }

  /** Whether Chrome reports unpacked extension `id` off (or gone) at any point over the next `ms`. */
  private async turnedOff(cdp: CdpClient, id: string, ms: number): Promise<boolean> {
    const deadline = this.now() + ms;
    do {
      try {
        const { extensions = [] } = await cdp.send("Extensions.getExtensions");
        const ext = (extensions as { id: string; enabled: boolean }[]).find((e) => e.id === id);
        if (!ext?.enabled) return true;
      } catch {
        return false;
      }
      await Bun.sleep(Math.min(200, Math.max(0, deadline - this.now())));
    } while (this.now() < deadline);
    return false;
  }

  /** Wait (installWaitMs) for Chrome to install the registry's Web Store extensions, then turn each on or off to match. */
  private async syncWebStore(cdp: CdpClient): Promise<void> {
    const wanted = () => this.registry.list().filter((e) => e.source === "webstore");
    const all = await this.withExtensionsPage(cdp, async (page) => {
      const deadline = this.now() + (this.opts.installWaitMs ?? 30_000);
      let all = await page.getAll();
      this.remember(all);
      while (wanted().some((e) => e.enabled && !all.some((c) => c.id === e.id)) && this.now() < deadline) {
        await Bun.sleep(500);
        all = await page.getAll();
      }
      return all;
    });
    for (const entry of wanted()) {
      const installed = all.find((c) => c.id === entry.id);
      if (!installed) {
        if (entry.enabled) {
          this.states.set(entry.id, {
            status: "error",
            error: "Chrome didn't install it from the Chrome Web Store. The store may be unreachable, or your organization's Chrome policy may no longer allow it.",
          });
        }
        continue;
      }
      this.states.delete(entry.id);
      if (entry.enabled && !installed.enabled && installed.mayEnable === false) this.states.set(entry.id, blockedState(entry.name));
      else if (installed.enabled !== entry.enabled) {
        await this.switchExtension(cdp, entry.id, entry.enabled).catch((e) => this.states.set(entry.id, { status: "error", error: errorText(e) }));
      }
    }
    await this.withExtensionsPage(cdp, async (page) => this.remember(await page.getAll()));
  }

  /** chrome.management.setEnabled, as a person flipping the extension's switch in chrome://extensions. */
  private switchExtension(cdp: CdpClient, id: string, enabled: boolean): Promise<void> {
    return this.withExtensionsPage(cdp, (page) => page.setEnabled(id, enabled));
  }

  /** Open `url` in a page of its own (not a session's tab), run `fn` with an evaluator for it, and close it. */
  private async withPage<T>(cdp: CdpClient, url: string, fn: (evaluate: (expression: string) => Promise<any>) => Promise<T>): Promise<T> {
    const { targetId } = await cdp.send("Target.createTarget", { url, newWindow: true, background: true });
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const session = cdp.session(sessionId);
      return await fn(async (expression) => {
        const r = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Script error"));
        return r.result?.value;
      });
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  /** chrome://extensions, once its chrome.management is there. */
  private withExtensionsPage<T>(cdp: CdpClient, fn: (page: ExtensionsPage) => Promise<T>): Promise<T> {
    return this.withPage(cdp, "chrome://extensions", async (evaluate) => {
      await this.until(() => evaluate(`document.readyState === "complete" && typeof chrome?.management?.getAll === "function"`), 10_000, "chrome://extensions didn't load");
      // `fn` takes the API's callback. Chrome never answers some calls (turning on an extension its
      // policy keeps off), so each gets 10 seconds.
      const call = (fn: string) =>
        evaluate(
          `new Promise((resolve, reject) => { setTimeout(() => reject(new Error("Chrome didn't answer")), 10000); (${fn})(() => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(true)); })`,
        );
      return fn({
        getAll: () =>
          evaluate(
            `new Promise((resolve) => chrome.management.getAll((list) => resolve(list.filter((e) => e.type === "extension").map((e) => ({ id: e.id, name: e.name, version: e.version, description: e.description, enabled: e.enabled, installType: e.installType, optionsUrl: e.optionsUrl || undefined, mayEnable: e.mayEnable })))))`,
          ),
        setEnabled: async (id, enabled) => void (await call(`(cb) => chrome.management.setEnabled(${JSON.stringify(id)}, ${enabled}, cb)`)),
      });
    });
  }

  /**
   * The extension's Chrome Web Store page: its name (none when the store has no such extension) and
   * chrome.webstorePrivate's verdict on installing it here, which applies the organization's policy.
   */
  private storeStatus(cdp: CdpClient, id: string): Promise<{ name: string; status: string }> {
    return this.withPage(cdp, `https://chromewebstore.google.com/detail/${id}`, async (evaluate) => {
      await this.until(
        () =>
          evaluate(
            `document.readyState === "complete" && (location.pathname.endsWith("/error") || !!document.querySelector("h1")) && typeof chrome?.webstorePrivate?.getExtensionStatus === "function"`,
          ),
        30_000,
        "The Chrome Web Store didn't load. Check this computer's internet connection and try again.",
        504,
      );
      const name: string = await evaluate(`location.pathname.endsWith("/error") ? "" : (document.querySelector("h1")?.textContent ?? "").trim()`);
      if (!name) throw new HarnessError(404, `The Chrome Web Store has no extension ${id}`);
      const status: string = await evaluate(
        `new Promise((resolve) => chrome.webstorePrivate.getExtensionStatus(${JSON.stringify(id)}, undefined, (s) => resolve(String(s ?? chrome.runtime.lastError?.message ?? ""))))`,
      );
      return { name, status };
    });
  }

  private async until(check: () => Promise<unknown>, ms: number, message: string, status = 500): Promise<void> {
    const deadline = this.now() + ms;
    while (!(await check().catch(() => false))) {
      if (this.now() >= deadline) throw new HarnessError(status, message);
      await Bun.sleep(200);
    }
  }

  private remember(all: ChromeExtension[]): void {
    this.chrome = new Map(all.map((e) => [e.id, e]));
    for (const id of this.uninstalling) if (!this.chrome.has(id)) this.uninstalling.delete(id);
  }

  private mine(id: string): StoredExtension {
    const entry = this.registry.get(id);
    if (entry) return entry;
    if (this.chrome.has(id)) throw new HarnessError(409, `${this.chrome.get(id)!.name} wasn't added in Settings, so Settings doesn't change it`);
    throw new HarnessError(404, `No extension ${id} is installed`);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private describe(entry: StoredExtension): BrowserExtension {
    const dir = entry.source === "unpacked" ? entry.path! : installedExtensionDir(this.opts.profileDir, entry.id);
    if (!entry.enabled) return describeExtension(entry, dir, { status: "off" });
    const state = this.states.get(entry.id);
    if (state) return describeExtension(entry, dir, state);
    if (entry.source === "webstore" && this.chrome.get(entry.id)?.enabled) return describeExtension(entry, dir, { status: "loaded" });
    return describeExtension(entry, dir, { status: "pending" });
  }

  private snapshot(running: boolean): BrowserExtensionList {
    const entries = this.registry.list();
    const mine = new Set(entries.map((e) => e.id));
    const extensions = entries.map((e) => this.describe(e));
    for (const c of this.chrome.values()) {
      if (mine.has(c.id) || this.uninstalling.has(c.id) || c.installType === "development") continue;
      const dir = installedExtensionDir(this.opts.profileDir, c.id);
      let hasAction = false;
      try {
        if (dir) hasAction = readManifest(dir).hasAction;
      } catch {}
      extensions.push({
        id: c.id,
        name: c.name,
        version: c.version,
        description: c.description || undefined,
        source: "chrome",
        byPolicy: c.installType === "admin" || undefined,
        enabled: c.enabled,
        status: c.enabled ? "loaded" : "off",
        hasAction,
        optionsUrl: c.optionsUrl,
      });
    }
    return { extensions, running };
  }
}
