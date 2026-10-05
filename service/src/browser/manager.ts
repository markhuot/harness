// BrowserService implementation: one Chrome, numbered tabs (page targets) per harness session.

import {
  BROWSER_DESKTOP,
  BROWSER_MAX_SIDE,
  BROWSER_MIN_SIDE,
  BROWSER_MOBILE,
  BROWSER_MOBILE_UA,
  type BrowserDevice,
  type BrowserElement,
  type BrowserElementQuery,
  type BrowserInput,
  type BrowserScreenshot,
  type BrowserSize,
  type BrowserState,
} from "@harness/shared";
import { imageSize } from "../attachments.ts";
import { findElementExpression, sameView, type PageElementReport } from "./element.ts";
import { CdpClient, CdpError, type CdpResult, type CdpSession } from "./cdp.ts";
import { ChromeProcess, findChrome } from "./chrome.ts";
import { MOD_CTRL, MOD_META, macEditingCommands, virtualKeyCode } from "./keys.ts";
import type {
  BrowserConsoleEntry,
  BrowserFrame,
  BrowserRequest,
  BrowserService,
  BrowserSizeChange,
  BrowserTabInfo,
  BrowserTabStore,
  BrowserTabSummary,
  StoredBrowserTab,
  TabOption,
} from "./types.ts";

export interface BrowserManagerOptions {
  profileDir: string;
  chromePath?: string;
  headless?: boolean;
  /** How long open() waits for the load event before returning anyway. */
  navigationTimeoutMs?: number;
  /** How long click/type wait for a navigation they triggered to finish. */
  settleTimeoutMs?: number;
  /** Per-CDP-command timeout. */
  commandTimeoutMs?: number;
  /** JPEG quality for the screencast. */
  screencastQuality?: number;
  /**
   * How long a tab nobody watches may go unused before its page is closed and the tab suspended
   * (read on every sweep, so a settings change applies at once). 0 or omitted: never.
   */
  idleTabMs?: () => number;
  /** Where sessions' tabs are kept, so a suspended tab (or every tab, after a restart) can reload. */
  tabStore?: BrowserTabStore;
  /** Clock for idle tracking (tests). */
  now?: () => number;
}

/** How often idle tabs are swept (and Chrome stopped once no tab has a page). */
const IDLE_SWEEP_MS = 30_000;
/** How long after the last page closes Chrome is stopped, when a close (not a sweep) emptied it. */
const STOP_GRACE_MS = 5_000;
/** Coalesces a session's tab writes (a page can change its title many times a second). */
const SAVE_DELAY_MS = 200;
/** How many network requests and console messages a tab keeps for browser_tabs (since its last navigation). */
const MAX_REQUESTS = 100;
const MAX_CONSOLE = 50;

interface Subscriber {
  onFrame: (f: BrowserFrame) => void;
  onState: (s: BrowserState) => void;
  /** The tab it asked for; null (or a tab that has closed) means the lowest open one. */
  want: number | null;
  /** The tab it was last sent state for, so a switch can hand it that tab's last frame. */
  watching?: number;
  lastStateKey?: string;
}

interface Entry {
  sessionId: string;
  subscribers: Map<string, Subscriber>;
  /** Tabs with a live Chrome page, by id. */
  tabs: Map<number, Tab>;
  /** Tabs whose page was closed (idle, done, Chrome stopped, a restart): they reload when used. */
  suspended: Map<number, StoredBrowserTab>;
  /** Suspended tabs whose page is being reopened, so concurrent calls share it. */
  reviving: Map<number, Promise<Tab>>;
  nextTabId: number;
  /** The ticket is done: a tab is suspended as soon as nobody watches it. An agent call clears it. */
  retired: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** What was last written to the store, so unchanged state isn't written again. */
  savedKey?: string;
  /** Tab 1 (or the next default tab) while it is being created, so concurrent calls share it. */
  creating?: Promise<Tab>;
}

interface Tab {
  id: number;
  entry: Entry;
  targetId: string;
  session: CdpSession;
  frameId: string;
  url: string;
  title: string;
  loading: boolean;
  /** The input mode and viewport it should have (what states report and the store keeps). */
  size: BrowserSize;
  /** With size.responsive: the subscriber whose stage it follows (the last to switch it on). */
  sizeOwner?: string;
  /** What Chrome was last told (applySize), so an unchanged size restarts nothing. */
  viewport: { width: number; height: number };
  device: BrowserDevice;
  /** Requests since the main frame last navigated, by CDP requestId, oldest first (at most MAX_REQUESTS). */
  requests: Map<string, BrowserRequest & { started: number }>;
  /** Console errors and warnings and uncaught exceptions since the main frame last navigated. */
  console: BrowserConsoleEntry[];
  screencasting: boolean;
  /** Bumped on every screencast (re)start so stale timers can tell they're stale. */
  screencastEpoch: number;
  /** Size the running screencast was started with; null when stopped. */
  castSize: { width: number; height: number } | null;
  castStarts: number;
  /** Serializes screencast start/stop (see syncScreencast). */
  castChain: Promise<void>;
  lastFrame?: BrowserFrame;
  /** Mouse buttons currently held (CDP `buttons` bitmask). */
  buttons: number;
  /** When an agent call or viewer input last used it, or a viewer last left it (see reapIdleTabs). */
  lastUsed: number;
  closed: boolean;
  gone: Promise<void>;
  markGone: () => void;
  offs: (() => void)[];
}

interface Browser {
  chrome: ChromeProcess;
  cdp: CdpClient;
  /** Chrome's own user agent, which a tab leaving "mobile" goes back to. */
  userAgent: string;
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

/** A session's tabs that have a live page, lowest id first. */
function openTabs(entry: Entry): Tab[] {
  return [...entry.tabs.values()].filter((t) => !t.closed).sort((a, b) => a.id - b.id);
}

/** Every tab of the session, live or suspended, lowest id first. */
function tabIds(entry: Entry): number[] {
  return [...new Set([...openTabs(entry).map((t) => t.id), ...entry.suspended.keys()])].sort((a, b) => a - b);
}

const hasTab = (entry: Entry, id: number) => liveTab(entry, id) !== undefined || entry.suspended.has(id);

function liveTab(entry: Entry, id: number | undefined): Tab | undefined {
  const tab = id === undefined ? undefined : entry.tabs.get(id);
  return tab && !tab.closed ? tab : undefined;
}

/** The tab a call without `tab` acts on: the lowest one, live or suspended. */
function defaultId(entry: Entry): number | undefined {
  return tabIds(entry)[0];
}

/** The tab a subscriber sees: the one it asked for while that exists, else the lowest one. */
function watchedId(entry: Entry, sub: Subscriber): number | undefined {
  return sub.want !== null && hasTab(entry, sub.want) ? sub.want : defaultId(entry);
}

/** The subscriber's tab when it has a live page (refresh reopens a watched suspended tab). */
function watchedTab(entry: Entry, sub: Subscriber): Tab | undefined {
  return liveTab(entry, watchedId(entry, sub));
}

function watchersOf(tab: Tab): Subscriber[] {
  return [...tab.entry.subscribers.values()].filter((sub) => watchedTab(tab.entry, sub) === tab);
}

function tabList(entry: Entry): BrowserTabSummary[] {
  return tabIds(entry).map((id) => {
    const t = liveTab(entry, id);
    if (t) {
      const failedRequests = [...t.requests.values()].filter(failed).length;
      return { id, url: t.url, title: t.title, loading: t.loading, size: { ...t.size }, failedRequests, consoleErrors: t.console.length };
    }
    const s = entry.suspended.get(id)!;
    return { id, url: s.url, title: s.title, loading: false, suspended: true, size: storedSize(s.size) };
  });
}

/** The protocol's tab list: without the agent-only counts browser_tabs shows. */
function protocolTabs(entry: Entry) {
  return tabList(entry).map(({ failedRequests: _f, consoleErrors: _c, ...t }) => t);
}

function stateOf(tab: Tab): BrowserState {
  return { sessionId: tab.entry.sessionId, tabId: tab.id, url: tab.url, title: tab.title, loading: tab.loading, size: { ...tab.size }, tabs: protocolTabs(tab.entry) };
}

function suspendedStateOf(entry: Entry, id: number): BrowserState {
  const s = entry.suspended.get(id)!;
  return { sessionId: entry.sessionId, tabId: id, url: s.url, title: s.title, loading: false, suspended: true, size: storedSize(s.size), tabs: protocolTabs(entry) };
}

/** A tab as stored. Responsive belongs to a live viewer, so it isn't kept. */
function record(tab: Tab): StoredBrowserTab {
  const { device, width, height } = tab.size;
  return { id: tab.id, url: tab.url, title: tab.title, size: { device, width, height } };
}

const clampSide = (n: number) => Math.max(BROWSER_MIN_SIDE, Math.min(BROWSER_MAX_SIDE, Math.round(n)));
/** A requested viewport side, clamped; undefined when it isn't a usable number. */
const side = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? clampSide(n) : undefined);
const presetOf = (device: BrowserDevice) => (device === "mobile" ? BROWSER_MOBILE : BROWSER_DESKTOP);

/** A stored tab's size; Desktop at its preset when it has none or it's unusable (a row from before sizes). */
function storedSize(size: StoredBrowserTab["size"]): BrowserSize {
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!size || (size.device !== "desktop" && size.device !== "mobile") || !ok(size.width) || !ok(size.height)) {
    return { device: "desktop", ...BROWSER_DESKTOP, responsive: false };
  }
  return { device: size.device, width: clampSide(size.width), height: clampSide(size.height), responsive: false };
}

/** A request that failed outright or got an error status. */
const failed = (r: BrowserRequest) => r.failure !== undefined || (r.status !== undefined && r.status >= 400);

/** A console argument as text: its value, or Chrome's description of an object. */
function consoleArg(arg: CdpResult): string {
  if (arg?.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return String(arg?.unserializableValue ?? arg?.description ?? arg?.type ?? "");
}

function noTabMessage(entry: Entry | undefined, id: number): string {
  const open = entry ? tabIds(entry) : [];
  return `No browser tab ${id}. ${open.length ? `Open tabs: ${open.join(", ")}.` : "This session has no open tabs."}`;
}

function exceptionMessage(details: CdpResult): string {
  return String(details?.exception?.description ?? details?.exception?.value ?? details?.text ?? "Unknown error");
}

export class BrowserManager implements BrowserService {
  private entries = new Map<string, Entry>();
  private browser?: Browser;
  private launching?: Promise<Browser>;
  /** Chrome being stopped because no tab had a page; a launch waits for it (one profile, one Chrome). */
  private stopping?: Promise<void>;
  /** Pages being created or reopened: Chrome isn't stopped under them. */
  private opening = 0;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly now: () => number;
  private sweeper?: ReturnType<typeof setInterval>;
  /** Sessions the store refused (no such session): logged once. */
  private unsaved = new Set<string>();
  /** shutdown() is running: nothing reopens a page (a watched tab would relaunch Chrome). */
  private shuttingDown = false;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** The running Chrome's code-sign clone directory (macOS), if attributed. */
  get chromeCloneDir(): string | undefined {
    return this.browser && !this.browser.chrome.exited ? this.browser.chrome.cloneDir : undefined;
  }

  /** PID of the running Chrome, if any (for diagnostics/tests). */
  get chromePid(): number | undefined {
    return this.browser && !this.browser.chrome.exited ? this.browser.chrome.pid : undefined;
  }

  // -------------------------------------------------------------------------
  // BrowserService
  // -------------------------------------------------------------------------

  async open(sessionId: string, url: string, opts: TabOption & { newTab?: boolean; size?: BrowserSizeChange } = {}): Promise<BrowserState> {
    const tab = opts.newTab ? await this.newTab(this.entry(sessionId)) : await this.agentTab(sessionId, opts.tab, false);
    // Before the navigation, so the page loads at that size with that user agent (no reload).
    if (opts.size) await this.setSize(tab, opts.size);
    await this.navigateAndWait(tab, normalizeUrl(url), this.navigationTimeoutMs);
    return this.currentState(tab);
  }

  async state(sessionId: string, opts: TabOption = {}): Promise<BrowserState | null> {
    const entry = this.peek(sessionId);
    const id = entry && (opts.tab ?? defaultId(entry));
    if (!entry || id === undefined) return null;
    const tab = liveTab(entry, id);
    if (tab) return this.currentState(tab);
    return entry.suspended.has(id) ? suspendedStateOf(entry, id) : null;
  }

  async tabs(sessionId: string): Promise<BrowserTabSummary[]> {
    const entry = this.peek(sessionId);
    if (!entry) return [];
    await Promise.all(openTabs(entry).map((t) => this.refreshTarget(t)));
    return tabList(entry);
  }

  async tabInfo(sessionId: string, id: number): Promise<BrowserTabInfo> {
    const entry = this.peek(sessionId);
    if (!entry || !hasTab(entry, id)) throw new Error(noTabMessage(entry, id));
    const tab = liveTab(entry, id);
    // A suspended tab's page is closed: it reports what was stored and isn't reopened for this.
    if (!tab) {
      const s = entry.suspended.get(id)!;
      return { id, url: s.url, title: s.title, loading: false, suspended: true, size: storedSize(s.size), requests: [], console: [] };
    }
    await this.refreshTarget(tab);
    const scroll = (await this.evalValue(tab, "[window.scrollX, window.scrollY]").catch(() => undefined)) as [number, number] | undefined;
    return {
      id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      size: { ...tab.size },
      ...(scroll ? { scroll: { x: Math.round(scroll[0]), y: Math.round(scroll[1]) } } : {}),
      requests: [...tab.requests.values()].map(({ started: _s, ...r }) => r),
      console: [...tab.console],
    };
  }

  async resize(sessionId: string, change: BrowserSizeChange, opts: TabOption = {}): Promise<BrowserState> {
    const tab = await this.agentTab(sessionId, opts.tab);
    await this.setSize(tab, change);
    // A new input mode reloads, like the Desktop | Mobile buttons, so the server sees the user agent too.
    if (change.device) await this.reloadAndWait(tab);
    return this.currentState(tab);
  }

  async content(sessionId: string, opts: TabOption & { selector?: string; format?: "text" | "html"; maxChars?: number } = {}): Promise<string> {
    const tab = await this.agentTab(sessionId, opts.tab);
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

  async click(sessionId: string, selector: string, opts: TabOption = {}): Promise<void> {
    const tab = await this.agentTab(sessionId, opts.tab);
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
        if (tab.device === "mobile") {
          // A tap: the page gets touch events, then the click a phone makes of them.
          await this.touch(tab, "touchStart", x, y);
          await this.touch(tab, "touchEnd", x, y);
          return;
        }
        await tab.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
        await tab.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await tab.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      } else {
        // Hidden or covered: fall back to a synthetic DOM click.
        await this.evalValue(tab, `document.querySelector(${JSON.stringify(selector)}).click()`);
      }
    });
  }

  async type(sessionId: string, selector: string, text: string, opts: TabOption & { submit?: boolean } = {}): Promise<void> {
    const tab = await this.agentTab(sessionId, opts.tab);
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

  async evaluate(sessionId: string, expression: string, opts: TabOption = {}): Promise<string> {
    const tab = await this.agentTab(sessionId, opts.tab);
    const res = await tab.session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(`Evaluation failed: ${exceptionMessage(res.exceptionDetails)}`);
    return this.serializeRemote(tab, res.result);
  }

  async screenshot(sessionId: string, opts: TabOption = {}): Promise<string> {
    const tab = await this.agentTab(sessionId, opts.tab);
    const res = await tab.session.send("Page.captureScreenshot", { format: "png" });
    return res.data as string;
  }

  async capture(sessionId: string, opts: TabOption = {}): Promise<BrowserScreenshot> {
    const tab = await this.agentTab(sessionId, opts.tab);
    const [shot, page] = await Promise.all([
      tab.session.send("Page.captureScreenshot", { format: "png" }),
      this.evalValue(tab, "[window.innerWidth, window.innerHeight, window.scrollX, window.scrollY]") as Promise<[number, number, number, number] | undefined>,
    ]);
    const data = shot.data as string;
    const size = imageSize("image/png", Buffer.from(data.slice(0, 64), "base64"));
    if (!size) throw new Error("The screenshot isn't a PNG");
    // The viewport as the page sees it (window.innerWidth/Height, scrollbars included, which the
    // screenshot also covers); the emulated size when the page can't say.
    const [w, h] = page && page[0] > 0 && page[1] > 0 ? [page[0], page[1]] : [tab.viewport.width, tab.viewport.height];
    await this.refreshTarget(tab);
    return {
      data,
      width: size.width,
      height: size.height,
      viewport: { width: w, height: h },
      scale: Math.round((size.width / w) * 1000) / 1000,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      scroll: { x: page?.[2] ?? 0, y: page?.[3] ?? 0 },
    };
  }

  async elementAt(sessionId: string, query: BrowserElementQuery): Promise<BrowserElement | null> {
    const entry = this.peek(sessionId);
    if (!entry || !hasTab(entry, query.tabId)) throw new Error(noTabMessage(entry, query.tabId));
    // A suspended tab's page is closed: reopening it would be a fresh load, not what was captured.
    const tab = liveTab(entry, query.tabId);
    if (!tab) return null;
    await this.refreshTarget(tab);
    const report = (await this.evalValue(tab, findElementExpression(query.x, query.y))) as PageElementReport | undefined;
    return report ? sameView(report, tab.url, query) : null;
  }

  async closeTab(sessionId: string, id: number): Promise<void> {
    const entry = this.peek(sessionId);
    if (!entry || !hasTab(entry, id)) throw new Error(noTabMessage(entry, id));
    const tab = liveTab(entry, id);
    entry.suspended.delete(id);
    if (tab) {
      this.dropTabs([tab], "forget");
      await this.closeTargets([tab]);
    } else {
      void this.refresh(entry).catch(() => {});
    }
    // Someone is watching: don't leave them on nothing.
    if (entry.subscribers.size > 0 && defaultId(entry) === undefined) await this.tab(sessionId);
    this.scheduleStop();
  }

  async input(sessionId: string, input: BrowserInput, opts: TabOption & { subscriberId?: string } = {}): Promise<void> {
    const entry = this.entry(sessionId);
    const sub = opts.subscriberId === undefined ? undefined : entry.subscribers.get(opts.subscriberId);
    if (input.type === "newTab") {
      const tab = await this.newTab(entry);
      if (sub && entry.subscribers.get(opts.subscriberId!) === sub) {
        sub.want = tab.id;
        await this.refresh(entry);
      }
      if (input.url) {
        const res = await tab.session.send("Page.navigate", { url: normalizeUrl(input.url) });
        if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
      }
      return;
    }
    // Without a tab, input goes to the tab the subscriber watches (reopened if it was suspended).
    const id = opts.tab ?? (sub ? watchedId(entry, sub) : undefined);
    if (input.type === "resize" || input.type === "device" || input.type === "size" || input.type === "responsive") {
      return this.sizeInput(entry, input, id, sub ? opts.subscriberId : undefined);
    }
    if (input.type === "closeTab") {
      const target = id ?? defaultId(entry);
      if (target === undefined) throw new Error("This session has no open tabs.");
      return this.closeTab(sessionId, target);
    }
    // Navigating a suspended tab needn't load its old URL first.
    const tab = await this.tab(sessionId, id, input.type !== "navigate");
    tab.lastUsed = this.now();
    const s = tab.session;
    switch (input.type) {
      case "mouse": {
        const x = input.x;
        const y = input.y;
        if (input.action === "wheel") {
          await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
          return;
        }
        // A touch device: the left button is a finger (a press, drag or tap); hover and the other buttons don't exist.
        if (tab.device === "mobile") {
          if ((input.button ?? "left") !== "left" && input.action !== "move") return;
          const held = (tab.buttons & 1) !== 0;
          if (input.action === "down") {
            tab.buttons |= 1;
            await this.touch(tab, "touchStart", x, y);
          } else if (input.action === "move" && held) {
            await this.touch(tab, "touchMove", x, y);
          } else if (input.action === "up" && held) {
            tab.buttons &= ~1;
            await this.touch(tab, "touchEnd", x, y);
          }
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
        // No nativeVirtualKeyCode (see keys.ts): on macOS it sends unhandled keys into a loop.
        const params: Record<string, unknown> = {
          type: input.action === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: input.key,
          code: input.code,
          modifiers,
          windowsVirtualKeyCode: vk,
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
    }
  }

  async subscribe(
    sessionId: string,
    subscriberId: string,
    onFrame: (f: BrowserFrame) => void,
    onState: (s: BrowserState) => void,
    opts: TabOption = {},
  ): Promise<void> {
    const entry = this.entry(sessionId);
    // A fresh record (no lastStateKey or watching), so the subscriber gets state and a frame at once.
    const sub: Subscriber = { onFrame, onState, want: opts.tab ?? null };
    // Resubscribing switches tabs: the one it leaves starts its idle time now.
    const prev = entry.subscribers.get(subscriberId);
    const left = prev && watchedTab(entry, prev);
    if (left) left.lastUsed = this.now();
    entry.subscribers.set(subscriberId, sub);
    const tab = await this.tab(sessionId, watchedId(entry, sub));
    if (entry.subscribers.get(subscriberId) !== sub) return; // unsubscribed (or resubscribed) while the tab was starting
    await this.refresh(entry);
    await this.currentState(tab);
  }

  async unsubscribe(sessionId: string, subscriberId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    const sub = entry?.subscribers.get(subscriberId);
    if (!entry || !sub) return;
    // Its idle time starts now, not when an agent last touched it.
    const left = watchedTab(entry, sub);
    if (left) left.lastUsed = this.now();
    entry.subscribers.delete(subscriberId);
    await this.refresh(entry);
  }

  /**
   * A viewer's size controls (DESIGN.md "Browser"). `resize` is its stage size, which counts only
   * from the viewer a Responsive tab follows; the rest are the Desktop | Mobile buttons, the
   * width × height inputs and the Responsive switch.
   */
  private async sizeInput(
    entry: Entry,
    input: Extract<BrowserInput, { type: "resize" | "device" | "size" | "responsive" }>,
    id: number | undefined,
    subscriberId: string | undefined,
  ): Promise<void> {
    if (input.type === "resize") {
      // Opening a pane never resizes a tab: only the viewer it follows does.
      const tab = liveTab(entry, id ?? defaultId(entry));
      if (!tab || !tab.size.responsive || subscriberId === undefined || tab.sizeOwner !== subscriberId) return;
      const width = side(input.width);
      const height = side(input.height);
      if (width === undefined || height === undefined) return;
      tab.size = { ...tab.size, width, height };
      await this.applySize(tab);
      this.emitStates(entry);
      return;
    }
    const tab = await this.tab(entry.sessionId, id);
    tab.lastUsed = this.now();
    switch (input.type) {
      case "device":
        await this.setSize(tab, { device: input.device });
        // Even when the mode didn't change: the button is a reset.
        await tab.session.send("Page.reload", {});
        return;
      case "size":
        return this.setSize(tab, { width: input.width, height: input.height });
      case "responsive": {
        if (!input.on) {
          tab.size = { ...tab.size, responsive: false };
          tab.sizeOwner = undefined;
          this.emitStates(entry);
          return;
        }
        if (subscriberId === undefined) throw new Error("Only a viewer can switch Responsive on (it follows that viewer's pane).");
        const width = side(input.width);
        const height = side(input.height);
        tab.size = { ...tab.size, responsive: true, ...(width !== undefined && height !== undefined ? { width, height } : {}) };
        // Last to switch it on wins: the earlier viewer's resizes stop counting.
        tab.sizeOwner = subscriberId;
        await this.applySize(tab);
        this.emitStates(entry);
        return;
      }
    }
  }

  /**
   * Set a tab's input mode and size, as a button, the inputs or an agent do: a new `device` starts
   * from its preset size, and anything set this way switches Responsive off (last set wins).
   */
  private async setSize(tab: Tab, change: BrowserSizeChange): Promise<void> {
    const device = change.device ?? tab.size.device;
    const base = change.device ? presetOf(change.device) : tab.size;
    tab.size = { device, width: side(change.width) ?? base.width, height: side(change.height) ?? base.height, responsive: false };
    tab.sizeOwner = undefined;
    await this.applySize(tab);
    this.emitStates(tab.entry);
  }

  /** Diagnostics: a tab's screencast status (default: the lowest open tab), or null without one. */
  screencastInfo(sessionId: string, opts: TabOption = {}): { active: boolean; starts: number; width: number; height: number } | null {
    const entry = this.entries.get(sessionId);
    const tab = entry && liveTab(entry, opts.tab ?? defaultId(entry));
    if (!tab) return null;
    return { active: tab.castSize !== null, starts: tab.castStarts, ...(tab.castSize ?? { width: 0, height: 0 }) };
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    this.opts.tabStore?.delete(sessionId);
    if (!entry) return;
    clearTimeout(entry.saveTimer);
    await entry.creating?.catch(() => undefined);
    await Promise.all([...entry.reviving.values()].map((p) => p.catch(() => undefined)));
    const tabs = openTabs(entry);
    entry.suspended.clear();
    this.dropTabs(tabs, "forget");
    await this.closeTargets(tabs);
    // Saving now would write the rows back: the session is gone.
    entry.savedKey = this.saveKey(entry);
    if (entry.subscribers.size === 0) this.entries.delete(sessionId);
    this.scheduleStop();
  }

  async suspendTabs(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return; // never opened since the service started: every tab is already suspended
    entry.retired = true;
    await entry.creating?.catch(() => undefined);
    await Promise.all([...entry.reviving.values()].map((p) => p.catch(() => undefined)));
    // A viewer's tab stays until the viewer leaves (refresh suspends it then, while retired).
    await this.suspend(openTabs(entry).filter((t) => watchersOf(t).length === 0));
  }

  /**
   * Suspend every tab nobody watches that no agent call or viewer input has used for idleTabMs:
   * its page closes and the tab stays, reloading when used. A watched tab is in use: it counts as
   * used now, so its idle time starts when the viewer leaves. Returns how many it suspended.
   */
  async reapIdleTabs(): Promise<number> {
    const idleMs = this.opts.idleTabMs?.() ?? 0;
    if (!(idleMs > 0)) return 0;
    const now = this.now();
    const idle: Tab[] = [];
    for (const entry of this.entries.values()) {
      for (const tab of openTabs(entry)) {
        if (watchersOf(tab).length > 0) tab.lastUsed = now;
        else if (now - tab.lastUsed >= idleMs) idle.push(tab);
      }
    }
    await this.suspend(idle);
    return idle.length;
  }

  /**
   * Stop Chrome when no tab has a page and nothing is opening one, so an idle service holds no
   * Chrome processes at all. The next call that needs a page relaunches it. Returns whether it stopped.
   */
  async stopChromeIfIdle(): Promise<boolean> {
    clearTimeout(this.stopTimer);
    const browser = this.browser;
    if (!browser || this.launching || this.stopping || this.opening > 0) return false;
    for (const entry of this.entries.values()) {
      if (openTabs(entry).length || entry.creating || entry.reviving.size) return false;
    }
    this.browser = undefined;
    this.stopping = (async () => {
      await browser.chrome.close({ cdp: browser.cdp });
      browser.cdp.close();
    })().finally(() => {
      this.stopping = undefined;
    });
    await this.stopping;
    return true;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.shutdownNow();
    } finally {
      this.shuttingDown = false;
    }
  }

  private async shutdownNow(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    clearTimeout(this.stopTimer);
    const browser = this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    // Every tab keeps its place: after a restart each one reloads from the store when used.
    for (const entry of this.entries.values()) {
      this.dropTabs(openTabs(entry), "suspend");
      this.saveNow(entry);
    }
    this.entries.clear();
    await this.stopping?.catch(() => {});
    if (!browser) return;
    // Graceful: Browser.close and wait for exit, so Chrome removes its code-sign clone.
    await browser.chrome.close({ cdp: browser.cdp });
    browser.cdp.close();
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
    await this.stopping?.catch(() => {});
    const old = this.browser;
    this.browser = undefined;
    if (old) {
      await old.chrome.close({ cdp: old.cdp });
      old.cdp.close();
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
      width: BROWSER_DESKTOP.width,
      height: BROWSER_DESKTOP.height,
    });
    let cdp: CdpClient;
    try {
      cdp = await CdpClient.connect(chrome.wsUrl, { timeoutMs: this.opts.commandTimeoutMs ?? 30_000 });
    } catch (e) {
      await chrome.close();
      throw e;
    }
    let userAgent = "";
    try {
      userAgent = (await cdp.send("Browser.getVersion")).userAgent ?? "";
    } catch {}
    const browser: Browser = { chrome, cdp, userAgent };

    cdp.onClose(() => {
      // Chrome died, was stopped, or the socket dropped: every tab is suspended (it reloads when
      // used, and a watched one reopens now); the next call that needs a page relaunches Chrome.
      for (const entry of this.entries.values()) this.dropTabs(openTabs(entry), "suspend");
      if (this.browser === browser) this.browser = undefined;
      if (!chrome.exited) void chrome.close();
    });
    void chrome.exitedPromise.then(() => cdp.close());

    cdp.on("Target.targetInfoChanged", (p) => {
      const info = p.targetInfo;
      const tab = this.tabByTarget(info?.targetId);
      if (!tab) return;
      tab.title = info.title ?? tab.title;
      tab.url = info.url ?? tab.url;
      this.emitStates(tab.entry);
    });
    // A tab opened a page (target=_blank, window.open): it becomes the session's next tab.
    cdp.on("Target.targetCreated", (p) => {
      const info = p.targetInfo;
      if (info?.type !== "page" || !info.openerId || this.tabByTarget(info.targetId)) return;
      const opener = this.tabByTarget(info.openerId);
      if (!opener) return;
      const entry = opener.entry;
      this.opening++;
      // It opens in the opener's mode and size, so a mobile page's link stays mobile.
      void this.attachTab(entry, entry.nextTabId++, info.targetId, browser, undefined, { ...opener.size, responsive: false })
        .catch(() => {})
        .finally(() => this.opening--);
    });
    // A page that closed itself (window.close()) takes its tab with it; Chrome reports the detach
    // before the destroy. Pages we close (suspended or closed) are dropped first, so they're no
    // longer found here, and a crash or Chrome going away suspends instead (targetCrashed, onClose).
    cdp.on("Target.targetDestroyed", (p) => {
      const tab = this.tabByTarget(p.targetId);
      if (tab) this.dropTabs([tab], "forget");
    });
    cdp.on("Target.detachedFromTarget", (p) => {
      for (const entry of this.entries.values()) {
        for (const tab of openTabs(entry)) if (tab.session.id === p.sessionId) this.dropTabs([tab], "forget");
      }
    });

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    this.browser = browser;
    if (!this.sweeper) {
      this.sweeper = setInterval(() => void this.sweep(), IDLE_SWEEP_MS);
      this.sweeper.unref?.();
    }
    return browser;
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  private async sweep(): Promise<void> {
    await this.reapIdleTabs().catch(() => {});
    await this.stopChromeIfIdle().catch(() => {});
  }

  /** The session's entry, created (with its stored tabs, all suspended) on first use. */
  private entry(sessionId: string): Entry {
    let e = this.entries.get(sessionId);
    if (e) return e;
    const stored = this.loadStored(sessionId);
    e = {
      sessionId,
      subscribers: new Map(),
      tabs: new Map(),
      suspended: new Map((stored?.tabs ?? []).map((t) => [t.id, t])),
      reviving: new Map(),
      nextTabId: Math.max(stored?.nextTabId ?? 1, ...(stored?.tabs ?? []).map((t) => t.id + 1)),
      retired: false,
    };
    e.savedKey = this.saveKey(e);
    this.entries.set(sessionId, e);
    return e;
  }

  /** The session's entry if it has one or has stored tabs; reads never create an empty one. */
  private peek(sessionId: string): Entry | undefined {
    return this.entries.get(sessionId) ?? (this.loadStored(sessionId) ? this.entry(sessionId) : undefined);
  }

  private loadStored(sessionId: string) {
    try {
      return this.opts.tabStore?.load(sessionId) ?? null;
    } catch (e) {
      console.error(`[browser] couldn't load ${sessionId}'s tabs:`, e);
      return null;
    }
  }

  private tabByTarget(targetId: string | undefined): Tab | undefined {
    if (!targetId) return undefined;
    for (const e of this.entries.values()) for (const t of e.tabs.values()) if (t.targetId === targetId) return t;
    return undefined;
  }

  /** An agent's call: like tab(), and the session is in use again (a done ticket re-opened, say). */
  private agentTab(sessionId: string, id?: number, reload = true): Promise<Tab> {
    this.entry(sessionId).retired = false;
    return this.tab(sessionId, id, reload);
  }

  /**
   * The tab a call acts on: `id` (which must exist), else the lowest tab, created when there is
   * none. A suspended tab reopens on its stored URL (`reload` false: on about:blank, for a caller
   * that navigates it anyway) and waits for that page to load.
   */
  private async tab(sessionId: string, id?: number, reload = true): Promise<Tab> {
    const entry = this.entry(sessionId);
    const target = id ?? defaultId(entry);
    if (target === undefined) {
      if (!entry.creating) {
        entry.creating = this.newTab(entry).finally(() => {
          entry.creating = undefined;
        });
      }
      return entry.creating;
    }
    const live = liveTab(entry, target);
    if (live) {
      live.lastUsed = this.now();
      return live;
    }
    if (!entry.suspended.has(target)) throw new Error(noTabMessage(entry, target));
    return this.revive(entry, target, reload ? "wait" : "blank");
  }

  /** A new tab with the session's next number. */
  private async newTab(entry: Entry): Promise<Tab> {
    entry.retired = false;
    const id = entry.nextTabId++;
    this.scheduleSave(entry);
    return this.createTab(entry, id);
  }

  private async createTab(entry: Entry, id: number, initial?: StoredBrowserTab): Promise<Tab> {
    this.opening++;
    try {
      const browser = await this.ensureBrowser();
      // newWindow: every tab gets its own (headless) window so it stays "visible";
      // background tabs don't paint, which would starve the screencast.
      const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
      return await this.attachTab(entry, id, targetId, browser, initial);
    } finally {
      this.opening--;
    }
  }

  /**
   * Give a suspended tab a page again, under its own number. "wait" loads its stored URL and waits
   * for it (an agent call), "go" starts loading it (a viewer), "blank" leaves it on about:blank.
   */
  private revive(entry: Entry, id: number, mode: "wait" | "go" | "blank"): Promise<Tab> {
    let p = entry.reviving.get(id);
    if (!p) {
      const stored = entry.suspended.get(id)!;
      p = (async () => {
        const tab = await this.createTab(entry, id, stored);
        if (mode === "blank" || !stored.url || stored.url === "about:blank") return tab;
        if (mode === "wait") await this.navigateAndWait(tab, stored.url, this.navigationTimeoutMs);
        else void tab.session.send("Page.navigate", { url: stored.url }).catch(() => {});
        return tab;
      })().finally(() => entry.reviving.delete(id));
      entry.reviving.set(id, p);
    } else if (mode === "wait") {
      // Joined a viewer's reopen, which doesn't wait for the page: an agent's call does.
      p = p.then(async (tab) => {
        await this.untilLoaded(tab);
        return tab;
      });
    }
    return p.then((tab) => {
      tab.lastUsed = this.now();
      return tab;
    });
  }

  /**
   * Attach to a page target (one we created, or a popup a tab opened) and make it tab `id`.
   * `initial`: a suspended tab being reopened, whose URL and title stand until its page reports its own.
   */
  private async attachTab(entry: Entry, id: number, targetId: string, browser: Browser, initial?: StoredBrowserTab, size?: BrowserSize): Promise<Tab> {
    const { cdp } = browser;
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
      id,
      entry,
      targetId,
      session,
      frameId: targetId,
      url: initial?.url ?? "about:blank",
      title: initial?.title ?? "",
      loading: false,
      size: size ?? storedSize(initial?.size),
      // A fresh page: no size applied yet, Chrome's own input and user agent.
      viewport: { width: 0, height: 0 },
      device: "desktop",
      requests: new Map(),
      console: [],
      screencasting: false,
      screencastEpoch: 0,
      castSize: null,
      castStarts: 0,
      castChain: Promise.resolve(),
      buttons: 0,
      lastUsed: this.now(),
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
        // What browser_tabs reports for the tab: its requests (console messages come with Runtime).
        session.send("Network.enable"),
        this.applySize(tab),
      ]);
      const { frameTree } = await session.send("Page.getFrameTree");
      tab.frameId = frameTree.frame.id;
      if (!initial) tab.url = frameTree.frame.url || tab.url; // a popup may already be on its page
    } catch (e) {
      this.dropTabs([tab], "forget");
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw e;
    }
    // Resized while this tab was starting: catch up.
    await this.applySize(tab);
    // Closed (or the session deleted) while its page was being reopened: the tab is gone.
    if (initial && entry.suspended.get(id) !== initial) {
      this.dropTabs([tab], "forget");
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw new Error(noTabMessage(entry, id));
    }
    entry.suspended.delete(id);
    entry.tabs.set(id, tab);
    await this.refresh(entry);
    return tab;
  }

  private attachListeners(tab: Tab): void {
    const s = tab.session;
    const isMain = (frameId: string | undefined) => frameId === tab.frameId;
    tab.offs.push(
      s.on("Page.frameNavigated", (p) => {
        if (p.frame.parentId) return;
        tab.frameId = p.frame.id;
        tab.console = [];
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
          tabId: tab.id,
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
      s.on("Network.requestWillBeSent", (p) => {
        // A new main-frame document starts the page's list over.
        if (p.type === "Document" && p.frameId === tab.frameId && p.requestId === p.loaderId && !p.redirectResponse) tab.requests.clear();
        const known = tab.requests.get(p.requestId);
        if (known) {
          // A redirect: the same request, now at its new URL.
          known.url = p.request.url;
          return;
        }
        tab.requests.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type ?? "Other", started: p.timestamp });
        if (tab.requests.size > MAX_REQUESTS) tab.requests.delete(tab.requests.keys().next().value!);
      }),
      s.on("Network.responseReceived", (p) => {
        const r = tab.requests.get(p.requestId);
        if (r && typeof p.response?.status === "number") r.status = p.response.status;
      }),
      s.on("Network.loadingFinished", (p) => {
        const r = tab.requests.get(p.requestId);
        if (r) r.durationMs = Math.max(0, Math.round((p.timestamp - r.started) * 1000));
      }),
      s.on("Network.loadingFailed", (p) => {
        const r = tab.requests.get(p.requestId);
        if (!r) return;
        r.failure = p.canceled ? "canceled" : p.blockedReason ? `blocked (${p.blockedReason})` : p.errorText || "failed";
        r.durationMs = Math.max(0, Math.round((p.timestamp - r.started) * 1000));
      }),
      s.on("Runtime.consoleAPICalled", (p) => {
        if (p.type !== "error" && p.type !== "warning" && p.type !== "assert") return;
        const frame = p.stackTrace?.callFrames?.[0];
        const text = (p.args ?? []).map(consoleArg).join(" ") || (p.type === "assert" ? "Assertion failed" : "");
        this.noteConsole(tab, { level: p.type === "warning" ? "warning" : "error", text, ...(frame?.url ? { source: `${frame.url}:${frame.lineNumber + 1}` } : {}) });
      }),
      s.on("Runtime.exceptionThrown", (p) => {
        const d = p.exceptionDetails;
        const text = String(d?.exception?.description ?? d?.text ?? "Uncaught exception");
        this.noteConsole(tab, { level: "error", text, ...(d?.url ? { source: `${d.url}:${(d.lineNumber ?? 0) + 1}` } : {}) });
      }),
      s.on("Inspector.targetCrashed", () => {
        this.dropTabs([tab], "suspend");
        this.browser?.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
      }),
    );
  }

  /**
   * Forget tabs' pages (closed, crashed, or Chrome gone), then move their viewers on once per
   * session. "suspend" keeps each tab (its URL and title) to reload later; "forget" removes it.
   */
  private dropTabs(tabs: Tab[], mode: "suspend" | "forget"): void {
    const entries = new Set<Entry>();
    for (const tab of tabs) {
      if (tab.closed) continue;
      tab.closed = true;
      tab.screencasting = false;
      tab.castSize = null;
      for (const off of tab.offs) off();
      tab.offs = [];
      tab.markGone();
      if (tab.entry.tabs.get(tab.id) === tab) {
        tab.entry.tabs.delete(tab.id);
        if (mode === "suspend") tab.entry.suspended.set(tab.id, record(tab));
      }
      entries.add(tab.entry);
    }
    for (const entry of entries) void this.refresh(entry).catch(() => {});
  }

  /** Close tabs' pages and keep the tabs, then stop Chrome soon if nothing has a page any more. */
  private async suspend(tabs: Tab[]): Promise<void> {
    if (!tabs.length) return;
    this.dropTabs(tabs, "suspend");
    await this.closeTargets(tabs);
    this.scheduleStop();
  }

  private closeTargets(tabs: Tab[]): Promise<unknown> {
    return Promise.all(
      tabs.map((tab) => this.browser?.cdp.send("Target.closeTarget", { targetId: tab.targetId }, undefined, 5000).catch(() => {})),
    );
  }

  /** Stop Chrome a moment after the last page closes (a sweep would get there too, within 30 s). */
  private scheduleStop(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => void this.stopChromeIfIdle().catch(() => {}), STOP_GRACE_MS);
    this.stopTimer.unref?.();
  }

  /**
   * After tabs open, close or suspend, or a subscriber switches: reopen a suspended tab someone
   * watches, suspend a done session's tabs nobody watches, run each tab's screencast only while
   * someone watches it, and send every subscriber its state (the tab list changed for all of them).
   */
  private async refresh(entry: Entry): Promise<void> {
    // Responsive ends when the viewer it follows leaves the tab (unsubscribed, switched, socket gone):
    // the tab keeps its size, and everyone sees the switch go off rather than stay on for no one.
    for (const tab of openTabs(entry)) {
      if (tab.sizeOwner === undefined) continue;
      const owner = entry.subscribers.get(tab.sizeOwner);
      if (owner && watchedId(entry, owner) === tab.id) continue;
      tab.sizeOwner = undefined;
      tab.size = { ...tab.size, responsive: false };
    }
    for (const sub of entry.subscribers.values()) {
      const id = watchedId(entry, sub);
      if (id !== undefined && entry.suspended.has(id) && !this.shuttingDown) void this.revive(entry, id, "go").catch(() => {});
    }
    if (entry.retired) {
      const unwatched = openTabs(entry).filter((t) => watchersOf(t).length === 0);
      if (unwatched.length) void this.suspend(unwatched);
    }
    this.emitStates(entry);
    await Promise.all(openTabs(entry).map((t) => this.syncScreencast(t)));
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private saveKey(entry: Entry): string {
    const tabs = tabIds(entry).map((id) => {
      const t = liveTab(entry, id);
      return t ? record(t) : entry.suspended.get(id)!;
    });
    return JSON.stringify({ nextTabId: entry.nextTabId, tabs });
  }

  /** Write the session's tabs soon (coalesced), when they changed since the last write. */
  private scheduleSave(entry: Entry): void {
    if (!this.opts.tabStore || entry.saveTimer) return;
    entry.saveTimer = setTimeout(() => this.saveNow(entry), SAVE_DELAY_MS);
    entry.saveTimer.unref?.();
  }

  private saveNow(entry: Entry): void {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = undefined;
    const store = this.opts.tabStore;
    if (!store) return;
    const key = this.saveKey(entry);
    if (key === entry.savedKey) return;
    try {
      store.save(entry.sessionId, JSON.parse(key));
      entry.savedKey = key;
    } catch (e) {
      // e.g. a session the database doesn't have: its tabs just don't survive a restart.
      if (!this.unsaved.has(entry.sessionId)) console.error(`[browser] couldn't save ${entry.sessionId}'s tabs:`, e);
      this.unsaved.add(entry.sessionId);
      entry.savedKey = key;
    }
  }

  /**
   * Tell Chrome the tab's size and input mode (tab.size). What hasn't changed since the last call is
   * skipped, so an unchanged size restarts nothing (a Responsive viewer resizes on every layout pass).
   */
  private async applySize(tab: Tab): Promise<void> {
    const { device, width, height } = tab.size;
    const switched = tab.device !== device;
    if (!switched && tab.viewport.width === width && tab.viewport.height === height) return;
    tab.viewport = { width, height };
    tab.device = device;
    await Promise.all([this.applyViewport(tab), switched ? this.applyDevice(tab) : undefined]);
    await this.syncScreencast(tab);
  }

  private applyViewport(tab: Tab): Promise<unknown> {
    return tab.session.send("Emulation.setDeviceMetricsOverride", {
      width: tab.viewport.width,
      height: tab.viewport.height,
      deviceScaleFactor: 1,
      // A phone's viewport: the page's <meta name="viewport"> applies.
      mobile: tab.device === "mobile",
    });
  }

  /**
   * "mobile": a touch device (touch events, `pointer: coarse`) with an iPhone user agent; clicks and
   * presses are sent as touches (touch()), not through setEmitTouchEventsForMouse, whose converted
   * mouse presses never answer Input.dispatchMouseEvent. "desktop": Chrome's own pointer and user agent. The user agent reaches
   * the server on the next load, which is why the Desktop | Mobile buttons reload.
   */
  private applyDevice(tab: Tab): Promise<unknown> {
    const mobile = tab.device === "mobile";
    const s = tab.session;
    return Promise.all([
      s.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }),
      s.send("Emulation.setUserAgentOverride", mobile ? { userAgent: BROWSER_MOBILE_UA, platform: "iPhone" } : { userAgent: this.browser?.userAgent ?? "" }),
    ]);
  }

  private noteConsole(tab: Tab, entry: BrowserConsoleEntry): void {
    tab.console.push(entry);
    if (tab.console.length > MAX_CONSOLE) tab.console.splice(0, tab.console.length - MAX_CONSOLE);
  }

  /**
   * Bring the tab's screencast in line with what it should be: running at the current
   * viewport while anyone watches it, stopped otherwise. Every start/stop goes through
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
    const want = watchersOf(tab).length > 0;
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
      this.deliverFrame(tab, { sessionId: tab.entry.sessionId, tabId: tab.id, data, width: tab.viewport.width, height: tab.viewport.height });
    } catch {}
  }

  private deliverFrame(tab: Tab, frame: BrowserFrame): void {
    tab.lastFrame = frame;
    // Only subscribers already told they're on this tab (state before frames).
    for (const sub of watchersOf(tab)) if (sub.watching === tab.id) safeCall(() => sub.onFrame(frame));
  }

  /** Re-read a tab's url and title from Chrome (targetInfoChanged sometimes carries an interim title). */
  private async refreshTarget(tab: Tab): Promise<void> {
    if (tab.closed || !this.browser) return;
    try {
      const { targetInfo } = await this.browser.cdp.send("Target.getTargetInfo", { targetId: tab.targetId });
      tab.url = targetInfo.url;
      tab.title = targetInfo.title;
    } catch {}
  }

  private async currentState(tab: Tab): Promise<BrowserState> {
    await this.refreshTarget(tab);
    this.emitStates(tab.entry);
    return stateOf(tab);
  }

  private emitState(tab: Tab): void {
    this.emitStates(tab.entry);
  }

  /**
   * Send each subscriber its tab's state when it changed. One that has just moved to a tab
   * (subscribe, a switch, its tab closed) also gets that tab's last frame straight away.
   */
  private emitStates(entry: Entry): void {
    this.scheduleSave(entry);
    for (const [subId, sub] of entry.subscribers) {
      const id = watchedId(entry, sub);
      if (id === undefined) continue;
      const tab = liveTab(entry, id);
      const state = { ...(tab ? stateOf(tab) : suspendedStateOf(entry, id)), sizeOwner: tab?.sizeOwner === subId };
      const key = JSON.stringify(state);
      if (key !== sub.lastStateKey) {
        sub.lastStateKey = key;
        safeCall(() => sub.onState(state));
      }
      // A suspended tab has no frames yet: it counts as watched once its page is back.
      const now = tab?.id;
      if (sub.watching !== now) {
        const left = sub.watching === undefined ? undefined : entry.tabs.get(sub.watching);
        if (left) left.lastUsed = this.now();
        sub.watching = now;
        const frame = tab?.lastFrame;
        if (frame) safeCall(() => sub.onFrame(frame));
      }
    }
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

  /** Reload a tab's page and wait (up to the navigation timeout) for it to load. */
  private async reloadAndWait(tab: Tab): Promise<void> {
    await tab.session.send("Page.reload", {});
    await this.untilLoaded(tab);
  }

  /** Wait (up to the navigation timeout) for a tab's page to stop loading. */
  private async untilLoaded(tab: Tab): Promise<void> {
    const deadline = Date.now() + this.navigationTimeoutMs;
    await Bun.sleep(50); // a navigation just sent may not have reported it started yet
    while (tab.loading && !tab.closed && Date.now() < deadline) await Bun.sleep(25);
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

  /** One finger on a touch ("mobile") tab: down, moving, or lifted. */
  private touch(tab: Tab, type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number): Promise<unknown> {
    return tab.session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 0 }] });
  }

  private async pressKey(tab: Tab, key: string, code: string, text?: string): Promise<void> {
    const vk = virtualKeyCode(key, code);
    await tab.session.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await tab.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
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

