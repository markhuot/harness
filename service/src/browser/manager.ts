// BrowserService implementation: one Chrome, one tab (page target) per harness session.

import type { BrowserInput, BrowserState } from "@harness/shared";
import { CdpClient, CdpError, type CdpResult, type CdpSession } from "./cdp.ts";
import { ChromeProcess, findChrome } from "./chrome.ts";
import { MOD_CTRL, MOD_META, macEditingCommands, virtualKeyCode } from "./keys.ts";
import type { BrowserFrame, BrowserService } from "./types.ts";

export interface BrowserManagerOptions {
  profileDir: string;
  chromePath?: string;
  headless?: boolean;
  /** Default viewport for new tabs (CSS px). */
  viewport?: { width: number; height: number };
  /** How long open() waits for the load event before returning anyway. */
  navigationTimeoutMs?: number;
  /** How long click/type wait for a navigation they triggered to finish. */
  settleTimeoutMs?: number;
  /** Per-CDP-command timeout. */
  commandTimeoutMs?: number;
  /** JPEG quality for the screencast. */
  screencastQuality?: number;
}

interface Subscriber {
  onFrame: (f: BrowserFrame) => void;
  onState: (s: BrowserState) => void;
}

interface Entry {
  sessionId: string;
  subscribers: Map<string, Subscriber>;
  tab?: Tab;
  tabPromise?: Promise<Tab>;
}

interface Tab {
  entry: Entry;
  targetId: string;
  session: CdpSession;
  frameId: string;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  screencasting: boolean;
  /** Bumped on every screencast (re)start so stale timers can tell they're stale. */
  screencastEpoch: number;
  /** Size the running screencast was started with; null when stopped. */
  castSize: { width: number; height: number } | null;
  castStarts: number;
  /** Serializes screencast start/stop (see syncScreencast). */
  castChain: Promise<void>;
  lastFrame?: BrowserFrame;
  lastStateKey?: string;
  /** Mouse buttons currently held (CDP `buttons` bitmask). */
  buttons: number;
  closed: boolean;
  gone: Promise<void>;
  markGone: () => void;
  offs: (() => void)[];
}

interface Browser {
  chrome: ChromeProcess;
  cdp: CdpClient;
}

const TITLE_BINDING = "__harnessTitleChanged";
// Runs in every document before page scripts. Grabs the binding and hides it from the page.
const TITLE_WATCH_SCRIPT = `(() => {
  const notify = globalThis.${TITLE_BINDING};
  try { delete globalThis.${TITLE_BINDING}; } catch {}
  if (typeof notify !== "function" || window !== window.top) return;
  let last = null;
  const check = () => {
    const t = document.title;
    if (t !== last) { last = t; try { notify(t); } catch {} }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

const BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 };

/**
 * Normalize a user/agent-provided URL. Anything with a scheme is left alone; bare hosts get
 * https:// (http:// for localhost and loopback addresses, where TLS is almost never set up).
 */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) return "about:blank";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
  if (/^(about|data|javascript|blob|view-source|chrome|mailto|file):/i.test(url)) return url;
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$|\?|#)/i.test(url)) return `http://${url}`;
  return `https://${url}`;
}

function truncate(text: string, maxChars?: number): string {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: showing ${maxChars} of ${text.length} characters]`;
}

function exceptionMessage(details: CdpResult): string {
  return String(details?.exception?.description ?? details?.exception?.value ?? details?.text ?? "Unknown error");
}

export class BrowserManager implements BrowserService {
  private entries = new Map<string, Entry>();
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private readonly viewport: { width: number; height: number };
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 10_000;
  }

  /** PID of the running Chrome, if any (for diagnostics/tests). */
  get chromePid(): number | undefined {
    return this.browser && !this.browser.chrome.exited ? this.browser.chrome.pid : undefined;
  }

  // -------------------------------------------------------------------------
  // BrowserService
  // -------------------------------------------------------------------------

  async open(sessionId: string, url: string): Promise<BrowserState> {
    const tab = await this.tab(sessionId);
    await this.navigateAndWait(tab, normalizeUrl(url), this.navigationTimeoutMs);
    return this.currentState(tab);
  }

  async state(sessionId: string): Promise<BrowserState | null> {
    const tab = this.entries.get(sessionId)?.tab;
    if (!tab || tab.closed) return null;
    return this.currentState(tab);
  }

  async content(sessionId: string, opts: { selector?: string; format?: "text" | "html"; maxChars?: number } = {}): Promise<string> {
    const tab = await this.tab(sessionId);
    const format = opts.format ?? "text";
    const selector = opts.selector ?? null;
    const result = (await this.evalValue(
      tab,
      `(() => {
        const sel = ${JSON.stringify(selector)};
        const html = ${JSON.stringify(format === "html")};
        const read = (el) => html ? el.outerHTML : (typeof el.innerText === "string" ? el.innerText : (el.textContent || ""));
        if (sel === null) {
          return { count: 1, parts: [html ? document.documentElement.outerHTML : read(document.body || document.documentElement)] };
        }
        const els = Array.from(document.querySelectorAll(sel));
        return { count: els.length, parts: els.map(read) };
      })()`,
    )) as { count: number; parts: string[] };
    if (selector !== null && result.count === 0) throw new Error(`No elements match selector: ${selector}`);
    return truncate(result.parts.join("\n\n"), opts.maxChars);
  }

  async click(sessionId: string, selector: string): Promise<void> {
    const tab = await this.tab(sessionId);
    await this.settle(tab, async () => {
      const box = (await this.evalValue(
        tab,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return { found: true, hittable: false };
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { found: true, x, y, hittable: !!hit && (hit === el || el.contains(hit)) };
        })()`,
      )) as { found: boolean; hittable?: boolean; x?: number; y?: number };
      if (!box.found) throw new Error(`No element matches selector: ${selector}`);
      if (box.hittable && box.x !== undefined && box.y !== undefined) {
        const { x, y } = box;
        await tab.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
        await tab.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await tab.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      } else {
        // Hidden or covered: fall back to a synthetic DOM click.
        await this.evalValue(tab, `document.querySelector(${JSON.stringify(selector)}).click()`);
      }
    });
  }

  async type(sessionId: string, selector: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    const tab = await this.tab(sessionId);
    const r = (await this.evalValue(
      tab,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        el.focus();
        // Replace existing content: select it so insertText overwrites.
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          try { el.select(); } catch {}
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(range);
        }
        const active = document.activeElement;
        return { found: true, focused: active === el || el.contains(active) };
      })()`,
    )) as { found: boolean; focused?: boolean };
    if (!r.found) throw new Error(`No element matches selector: ${selector}`);
    if (!r.focused) throw new Error(`Element is not focusable: ${selector}`);
    if (text) {
      await tab.session.send("Input.insertText", { text });
    } else {
      await this.pressKey(tab, "Backspace", "Backspace");
    }
    if (opts.submit) {
      await this.settle(tab, () => this.pressKey(tab, "Enter", "Enter", "\r"));
    }
  }

  async evaluate(sessionId: string, expression: string): Promise<string> {
    const tab = await this.tab(sessionId);
    const res = await tab.session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(`Evaluation failed: ${exceptionMessage(res.exceptionDetails)}`);
    return this.serializeRemote(tab, res.result);
  }

  async screenshot(sessionId: string): Promise<string> {
    const tab = await this.tab(sessionId);
    const res = await tab.session.send("Page.captureScreenshot", { format: "png" });
    return res.data as string;
  }

  async input(sessionId: string, input: BrowserInput): Promise<void> {
    const tab = await this.tab(sessionId);
    const s = tab.session;
    switch (input.type) {
      case "mouse": {
        const x = input.x;
        const y = input.y;
        if (input.action === "wheel") {
          await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
          return;
        }
        if (input.action === "move") {
          const held = (["left", "right", "middle"] as const).find((b) => tab.buttons & BUTTON_BITS[b]!);
          await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: held ?? "none", buttons: tab.buttons });
          return;
        }
        const button = input.button ?? "left";
        const bit = BUTTON_BITS[button] ?? 1;
        tab.buttons = input.action === "down" ? tab.buttons | bit : tab.buttons & ~bit;
        await s.send("Input.dispatchMouseEvent", {
          type: input.action === "down" ? "mousePressed" : "mouseReleased",
          x,
          y,
          button,
          buttons: tab.buttons,
          clickCount: input.clickCount ?? 1,
        });
        return;
      }
      case "key": {
        const modifiers = input.modifiers ?? 0;
        const vk = virtualKeyCode(input.key, input.code);
        let text = input.text;
        if (input.key === "Enter") text = "\r";
        // Shortcuts must not insert their character.
        if (modifiers & (MOD_CTRL | MOD_META)) text = undefined;
        const params: Record<string, unknown> = {
          type: input.action === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: input.key,
          code: input.code,
          modifiers,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        };
        if (text && input.action === "down") {
          params.text = text;
          params.unmodifiedText = text;
        }
        const commands = input.action === "down" ? macEditingCommands(input.code, modifiers) : undefined;
        if (commands) params.commands = commands;
        await s.send("Input.dispatchKeyEvent", params);
        return;
      }
      case "text":
        if (input.text) await s.send("Input.insertText", { text: input.text });
        return;
      case "navigate": {
        const res = await s.send("Page.navigate", { url: normalizeUrl(input.url) });
        if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
        return;
      }
      case "back":
      case "forward": {
        const hist = await s.send("Page.getNavigationHistory");
        const idx = hist.currentIndex + (input.type === "back" ? -1 : 1);
        const entry = hist.entries?.[idx];
        if (entry) await s.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        return;
      }
      case "reload":
        await s.send("Page.reload", {});
        return;
      case "resize": {
        const width = Math.max(100, Math.min(4096, Math.round(input.width)));
        const height = Math.max(100, Math.min(4096, Math.round(input.height)));
        // Viewers send resize on every layout pass; an unchanged size must not restart anything.
        if (tab.viewport.width === width && tab.viewport.height === height) return;
        tab.viewport = { width, height };
        await this.applyViewport(tab);
        await this.syncScreencast(tab);
        return;
      }
    }
  }

  async subscribe(
    sessionId: string,
    subscriberId: string,
    onFrame: (f: BrowserFrame) => void,
    onState: (s: BrowserState) => void,
  ): Promise<void> {
    const entry = this.entry(sessionId);
    entry.subscribers.set(subscriberId, { onFrame, onState });
    const tab = await this.tab(sessionId);
    if (!entry.subscribers.has(subscriberId)) return; // unsubscribed while the tab was starting
    await this.syncScreencast(tab);
    // Give the newcomer something to render straight away.
    const state = await this.currentState(tab);
    safeCall(() => onState(state));
    if (tab.lastFrame) {
      const frame = tab.lastFrame;
      safeCall(() => onFrame(frame));
    }
  }

  async unsubscribe(sessionId: string, subscriberId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.subscribers.delete(subscriberId);
    if (entry.subscribers.size > 0) return;
    const tab = entry.tab;
    if (tab && !tab.closed) await this.syncScreencast(tab);
  }

  /** Diagnostics: the session's screencast status, or null without a tab. */
  screencastInfo(sessionId: string): { active: boolean; starts: number; width: number; height: number } | null {
    const tab = this.entries.get(sessionId)?.tab;
    if (!tab || tab.closed) return null;
    return { active: tab.castSize !== null, starts: tab.castStarts, ...(tab.castSize ?? { width: 0, height: 0 }) };
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const tab = entry.tab ?? (await entry.tabPromise?.catch(() => undefined));
    if (tab && !tab.closed) {
      this.dropTab(tab);
      await this.browser?.cdp.send("Target.closeTarget", { targetId: tab.targetId }, undefined, 5000).catch(() => {});
    }
    if (entry.subscribers.size === 0) this.entries.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    const browser = this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    for (const entry of this.entries.values()) if (entry.tab) this.dropTab(entry.tab);
    this.entries.clear();
    if (!browser) return;
    if (!browser.cdp.closed) {
      await browser.cdp.send("Browser.close", {}, undefined, 2000).catch(() => {});
      browser.cdp.close();
    }
    await browser.chrome.kill();
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  private async ensureBrowser(): Promise<Browser> {
    const b = this.browser;
    if (b && !b.cdp.closed && !b.chrome.exited) return b;
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = undefined;
      });
    }
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const old = this.browser;
    this.browser = undefined;
    if (old) {
      old.cdp.close();
      await old.chrome.kill();
    }
    const chromePath = findChrome(this.opts.chromePath);
    if (!chromePath) {
      throw new Error(
        "Chrome not found. Install Google Chrome or set HARNESS_CHROME_PATH to a Chrome/Chromium executable.",
      );
    }
    const headlessEnv = process.env.HARNESS_CHROME_HEADLESS;
    const headless = this.opts.headless ?? !(headlessEnv === "0" || headlessEnv === "false");
    const chrome = await ChromeProcess.launch({
      chromePath,
      profileDir: this.opts.profileDir,
      headless,
      width: this.viewport.width,
      height: this.viewport.height,
    });
    let cdp: CdpClient;
    try {
      cdp = await CdpClient.connect(chrome.wsUrl, { timeoutMs: this.opts.commandTimeoutMs ?? 30_000 });
    } catch (e) {
      await chrome.kill();
      throw e;
    }
    const browser: Browser = { chrome, cdp };

    cdp.onClose(() => {
      // Chrome died or the socket dropped: forget every tab; the next call relaunches.
      for (const entry of this.entries.values()) if (entry.tab) this.dropTab(entry.tab);
      if (this.browser === browser) this.browser = undefined;
      if (!chrome.exited) void chrome.kill();
    });
    void chrome.exitedPromise.then(() => cdp.close());

    cdp.on("Target.targetInfoChanged", (p) => {
      const info = p.targetInfo;
      const tab = this.tabByTarget(info?.targetId);
      if (!tab) return;
      tab.title = info.title ?? tab.title;
      tab.url = info.url ?? tab.url;
      this.emitState(tab);
    });
    cdp.on("Target.targetDestroyed", (p) => {
      const tab = this.tabByTarget(p.targetId);
      if (tab) this.dropTab(tab);
    });
    cdp.on("Target.detachedFromTarget", (p) => {
      for (const entry of this.entries.values()) {
        if (entry.tab && entry.tab.session.id === p.sessionId) this.dropTab(entry.tab);
      }
    });

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    this.browser = browser;
    return browser;
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  private entry(sessionId: string): Entry {
    let e = this.entries.get(sessionId);
    if (!e) this.entries.set(sessionId, (e = { sessionId, subscribers: new Map() }));
    return e;
  }

  private tabByTarget(targetId: string | undefined): Tab | undefined {
    if (!targetId) return undefined;
    for (const e of this.entries.values()) if (e.tab?.targetId === targetId) return e.tab;
    return undefined;
  }

  private async tab(sessionId: string): Promise<Tab> {
    const entry = this.entry(sessionId);
    if (entry.tab && !entry.tab.closed) return entry.tab;
    if (!entry.tabPromise) {
      entry.tabPromise = this.createTab(entry).finally(() => {
        entry.tabPromise = undefined;
      });
    }
    return entry.tabPromise;
  }

  private async createTab(entry: Entry): Promise<Tab> {
    const browser = await this.ensureBrowser();
    const { cdp } = browser;
    // newWindow: each session gets its own (headless) window so every tab stays
    // "visible" — background tabs don't paint, which would starve the screencast.
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    let sessionId: string;
    try {
      ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
    } catch (e) {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw e;
    }
    const session = cdp.session(sessionId);
    let markGone!: () => void;
    const gone = new Promise<void>((r) => (markGone = r));
    const tab: Tab = {
      entry,
      targetId,
      session,
      frameId: targetId,
      url: "about:blank",
      title: "",
      loading: false,
      viewport: { ...this.viewport },
      screencasting: false,
      screencastEpoch: 0,
      castSize: null,
      castStarts: 0,
      castChain: Promise.resolve(),
      buttons: 0,
      closed: false,
      gone,
      markGone,
      offs: [],
    };
    this.attachListeners(tab);
    try {
      await Promise.all([
        session.send("Page.enable"),
        session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
        // Keep focus/blur and :focus working even though no window has OS focus.
        session.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
        // Chrome doesn't report document.title changes after load; watch them in-page.
        // Runtime.bindingCalled is only delivered while the Runtime domain is enabled.
        session.send("Runtime.enable"),
        session.send("Runtime.addBinding", { name: TITLE_BINDING }),
        session.send("Page.addScriptToEvaluateOnNewDocument", { source: TITLE_WATCH_SCRIPT }),
        this.applyViewport(tab),
      ]);
      const { frameTree } = await session.send("Page.getFrameTree");
      tab.frameId = frameTree.frame.id;
    } catch (e) {
      this.dropTab(tab);
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw e;
    }
    entry.tab = tab;
    if (entry.subscribers.size > 0) await this.syncScreencast(tab);
    return tab;
  }

  private attachListeners(tab: Tab): void {
    const s = tab.session;
    const isMain = (frameId: string | undefined) => frameId === tab.frameId;
    tab.offs.push(
      s.on("Page.frameNavigated", (p) => {
        if (p.frame.parentId) return;
        tab.frameId = p.frame.id;
        tab.url = p.frame.url + (p.frame.urlFragment ?? "");
        this.emitState(tab);
      }),
      s.on("Page.navigatedWithinDocument", (p) => {
        if (!isMain(p.frameId)) return;
        tab.url = p.url;
        this.emitState(tab);
      }),
      s.on("Page.frameStartedLoading", (p) => {
        if (!isMain(p.frameId)) return;
        tab.loading = true;
        this.emitState(tab);
      }),
      s.on("Page.frameStoppedLoading", (p) => {
        if (!isMain(p.frameId)) return;
        tab.loading = false;
        this.emitState(tab);
        // targetInfoChanged sometimes only carries the interim (URL) title; re-read it.
        void this.currentState(tab);
      }),
      s.on("Page.loadEventFired", () => {
        tab.loading = false;
        this.emitState(tab);
        void this.currentState(tab);
      }),
      s.on("Page.lifecycleEvent", (p) => {
        if (!isMain(p.frameId)) return;
        if (p.name === "init") tab.loading = true;
        else if (p.name === "load") tab.loading = false;
        else if (p.name === "DOMContentLoaded") return void this.currentState(tab);
        else return;
        this.emitState(tab);
      }),
      s.on("Page.screencastFrame", (p) => {
        s.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
        if (!tab.screencasting) return;
        const frame: BrowserFrame = {
          sessionId: tab.entry.sessionId,
          data: p.data,
          width: Math.round(p.metadata?.deviceWidth ?? tab.viewport.width),
          height: Math.round(p.metadata?.deviceHeight ?? tab.viewport.height),
        };
        this.deliverFrame(tab, frame);
      }),
      s.on("Runtime.bindingCalled", (p) => {
        if (p.name !== TITLE_BINDING || typeof p.payload !== "string") return;
        tab.title = p.payload;
        this.emitState(tab);
      }),
      s.on("Inspector.targetCrashed", () => {
        this.dropTab(tab);
        this.browser?.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
      }),
    );
  }

  private dropTab(tab: Tab): void {
    if (tab.closed) return;
    tab.closed = true;
    tab.screencasting = false;
    tab.castSize = null;
    for (const off of tab.offs) off();
    tab.offs = [];
    tab.markGone();
    if (tab.entry.tab === tab) tab.entry.tab = undefined;
  }

  private applyViewport(tab: Tab): Promise<unknown> {
    return tab.session.send("Emulation.setDeviceMetricsOverride", {
      width: tab.viewport.width,
      height: tab.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * Bring the tab's screencast in line with what it should be: running at the current
   * viewport while anyone is subscribed, stopped otherwise. Every start/stop goes through
   * this per-tab chain, so overlapping subscribe/unsubscribe/resize calls can't interleave
   * their CDP commands (Chrome rejects a second start with "Screencast is already active").
   */
  private syncScreencast(tab: Tab): Promise<void> {
    const run = tab.castChain.then(() => this.reconcileScreencast(tab));
    tab.castChain = run.catch(() => {});
    return run;
  }

  private async reconcileScreencast(tab: Tab): Promise<void> {
    if (tab.closed) return;
    const want = tab.entry.subscribers.size > 0;
    const size = tab.castSize;
    if (want && size && size.width === tab.viewport.width && size.height === tab.viewport.height) return;
    if (size) {
      tab.screencasting = false;
      tab.castSize = null;
      tab.lastFrame = undefined;
      await tab.session.send("Page.stopScreencast").catch(() => {});
    }
    if (!want || tab.closed) return;
    try {
      await this.startScreencast(tab);
    } catch (e) {
      // Out of sync with Chrome (e.g. a start we never saw complete): stop, then retry once.
      if (!(e instanceof CdpError) || !/already active/i.test(e.message)) throw e;
      await tab.session.send("Page.stopScreencast").catch(() => {});
      await this.startScreencast(tab);
    }
  }

  private async startScreencast(tab: Tab): Promise<void> {
    const width = tab.viewport.width;
    const height = tab.viewport.height;
    tab.lastFrame = undefined;
    await tab.session.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.opts.screencastQuality ?? 60,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    tab.castSize = { width, height };
    tab.castStarts++;
    tab.screencasting = true;
    // Chrome only emits screencast frames when something paints; a static page may sit
    // silent. If nothing has arrived shortly after starting, seed viewers with a snapshot.
    const epoch = ++tab.screencastEpoch;
    setTimeout(() => void this.primeFrame(tab, epoch), 250);
  }

  private async primeFrame(tab: Tab, epoch: number): Promise<void> {
    if (tab.closed || !tab.screencasting || tab.screencastEpoch !== epoch || tab.lastFrame) return;
    try {
      const { data } = await tab.session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.opts.screencastQuality ?? 60,
      });
      if (tab.closed || !tab.screencasting || tab.screencastEpoch !== epoch || tab.lastFrame) return;
      this.deliverFrame(tab, { sessionId: tab.entry.sessionId, data, width: tab.viewport.width, height: tab.viewport.height });
    } catch {}
  }

  private deliverFrame(tab: Tab, frame: BrowserFrame): void {
    tab.lastFrame = frame;
    for (const sub of tab.entry.subscribers.values()) safeCall(() => sub.onFrame(frame));
  }

  private async currentState(tab: Tab): Promise<BrowserState> {
    if (!tab.closed && this.browser) {
      try {
        const { targetInfo } = await this.browser.cdp.send("Target.getTargetInfo", { targetId: tab.targetId });
        tab.url = targetInfo.url;
        tab.title = targetInfo.title;
        this.emitState(tab);
      } catch {}
    }
    return { sessionId: tab.entry.sessionId, url: tab.url, title: tab.title, loading: tab.loading };
  }

  private emitState(tab: Tab): void {
    const state: BrowserState = { sessionId: tab.entry.sessionId, url: tab.url, title: tab.title, loading: tab.loading };
    const key = JSON.stringify(state);
    if (key === tab.lastStateKey) return;
    tab.lastStateKey = key;
    for (const sub of tab.entry.subscribers.values()) safeCall(() => sub.onState(state));
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  private async navigateAndWait(tab: Tab, url: string, timeoutMs: number): Promise<void> {
    const loaded = new Set<string>();
    let wake: (() => void) | undefined;
    const off = tab.session.on("Page.lifecycleEvent", (p) => {
      if (p.name !== "load") return;
      loaded.add(p.loaderId);
      wake?.();
    });
    try {
      const res = await tab.session.send("Page.navigate", { url });
      if (res.errorText) throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
      const loaderId: string | undefined = res.loaderId;
      if (!loaderId || loaded.has(loaderId)) return; // same-document navigation, or already loaded
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        wake = () => {
          if (loaded.has(loaderId)) done();
        };
        void tab.gone.then(done);
      });
    } finally {
      off();
    }
  }

  /**
   * Run an action that may trigger a navigation (click, Enter). If a main-frame navigation
   * starts within a short grace window, wait for it to finish loading.
   */
  private async settle(tab: Tab, action: () => Promise<void>): Promise<void> {
    let requested = false;
    let started = false;
    const offs = [
      tab.session.on("Page.frameRequestedNavigation", (p) => {
        if (p.frameId === tab.frameId) requested = true;
      }),
      tab.session.on("Page.frameStartedLoading", (p) => {
        if (p.frameId === tab.frameId) started = true;
      }),
    ];
    try {
      await action();
      await Bun.sleep(50);
      if (!requested && !started && !tab.loading) return;
      const deadline = Date.now() + this.settleTimeoutMs;
      // A requested navigation can take a moment to actually start loading.
      const startBy = Date.now() + 1000;
      while (!tab.closed && Date.now() < deadline) {
        if (!tab.loading && (started || Date.now() > startBy)) break;
        await Bun.sleep(25);
      }
    } finally {
      for (const off of offs) off();
    }
  }

  private async pressKey(tab: Tab, key: string, code: string, text?: string): Promise<void> {
    const vk = virtualKeyCode(key, code);
    await tab.session.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await tab.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  // -------------------------------------------------------------------------
  // Evaluation helpers
  // -------------------------------------------------------------------------

  /** Evaluate an internal expression and return its JSON value; page exceptions become errors. */
  private async evalValue(tab: Tab, expression: string): Promise<unknown> {
    const res = await tab.session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(exceptionMessage(res.exceptionDetails).split("\n")[0]);
    }
    return res.result?.value;
  }

  /** Turn a RemoteObject into a JSON string without re-running the user's expression. */
  private async serializeRemote(tab: Tab, obj: CdpResult): Promise<string> {
    if (!obj) return "undefined";
    if (obj.unserializableValue !== undefined) return String(obj.unserializableValue);
    if (obj.type === "undefined") return "undefined";
    if (!obj.objectId) return JSON.stringify(obj.value) ?? "undefined";
    try {
      if (obj.subtype === "node") return JSON.stringify(obj.description ?? "Node");
      if (obj.type === "function") return JSON.stringify(obj.description ?? "function");
      const res = await tab.session.send("Runtime.callFunctionOn", {
        objectId: obj.objectId,
        functionDeclaration: "function () { return this; }",
        returnByValue: true,
      });
      if (res.exceptionDetails) return JSON.stringify(obj.description ?? null);
      return JSON.stringify(res.result?.value) ?? "undefined";
    } catch (e) {
      // e.g. cyclic objects ("Object reference chain is too long") — describe instead.
      if (e instanceof CdpError) return JSON.stringify(obj.description ?? obj.className ?? "Object");
      throw e;
    } finally {
      tab.session.send("Runtime.releaseObject", { objectId: obj.objectId }).catch(() => {});
    }
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error("[browser] subscriber callback threw:", e);
  }
}
