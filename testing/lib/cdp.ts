// A small Chrome DevTools Protocol client for the Mac app: browser-level connection (so a window
// opened later, a popout, shows up as its own target on the `Target` events) plus a page handle
// with waits that run inside the page.

import { writeFileSync } from "node:fs";
import { deferred, withDeadline } from "./wait";

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  attached?: boolean;
}

/** The set of targets the browser has told us about, kept from its Target.* events. */
export class TargetTracker {
  private targets = new Map<string, TargetInfo>();

  apply(method: string, params: Record<string, unknown>): void {
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = params.targetInfo as TargetInfo;
      this.targets.set(info.targetId, info);
    } else if (method === "Target.targetDestroyed") {
      this.targets.delete(params.targetId as string);
    }
  }

  /** The app's windows: page targets, not the DevTools, extensions or workers. */
  pages(): TargetInfo[] {
    return [...this.targets.values()].filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  }

  /** The page whose URL satisfies `match` and that isn't in `exclude` (a window already claimed), if any. */
  find(match: (url: string) => boolean, exclude: Set<string> = new Set()): TargetInfo | undefined {
    return this.pages().find((t) => match(t.url) && !exclude.has(t.targetId));
  }
}

type Waiter = (m: { method?: string; params?: Record<string, unknown> }) => void;

export class Cdp {
  readonly tracker = new TargetTracker();
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Waiter>();
  private opened_ = deferred<void>();
  closed = false;
  /** How long a command may go unanswered before it fails. */
  sendDeadlineMs = 30_000;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.opened_.resolve();
    this.ws.onerror = () => this.opened_.reject(new Error(`could not open ${url}`));
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
      for (const l of this.listeners) l({});
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
        else p?.resolve(m.result);
        return;
      }
      if (m.method) {
        this.tracker.apply(m.method, m.params ?? {});
        for (const l of this.listeners) l(m);
      }
    };
  }

  /** Resolves once the socket is open. */
  opened(): Promise<void> {
    return this.opened_.promise;
  }

  async connect(): Promise<void> {
    await withDeadline("the DevTools socket to open", 15_000, this.opened_.promise);
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const p = deferred<unknown>();
    this.pending.set(id, { method, resolve: p.resolve, reject: p.reject });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    // A renderer or browser that stops answering with its socket still open would hang every caller, teardown included.
    return withDeadline(`the DevTools answer to ${method}`, this.sendDeadlineMs, p.promise as Promise<T>, () => "no answer").catch((e) => {
      this.pending.delete(id);
      throw e;
    });
  }

  /** The first Target event that makes `ready()` return something, checked against what is already known first. */
  waitTarget(what: string, ready: () => TargetInfo | undefined, ms = 30_000): Promise<TargetInfo> {
    const now = ready();
    if (now) return Promise.resolve(now);
    const found = deferred<TargetInfo>();
    const listener: Waiter = (m) => {
      if (!m.method) return found.reject(new Error(`DevTools closed before ${what}`));
      const hit = ready();
      if (hit) found.resolve(hit);
    };
    this.listeners.add(listener);
    return withDeadline(what, ms, found.promise, () => this.tracker.pages().map((t) => t.url).join(" | ")).finally(() => this.listeners.delete(listener));
  }

  async attach(target: TargetInfo): Promise<Page> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const page = new Page(this, sessionId, target);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }

  close() {
    this.ws.close();
  }
}

/**
 * What a failed wait says about the page besides its text: whether the window has focus, whether Chromium
 * thinks it's visible (a hidden or occluded one stops animation frames), and what holds the keyboard focus.
 */
export const PAGE_STATE = `(() => {
  const a = document.activeElement;
  const what = !a || a === document.body ? 'body' : a.tagName.toLowerCase() + (a.dataset?.testid ? '[data-testid=' + a.dataset.testid + ']' : '') + (a.getAttribute('aria-label') ? '[aria-label=' + a.getAttribute('aria-label') + ']' : '');
  return 'focus ' + document.hasFocus() + ', ' + document.visibilityState + ', active ' + what;
})()`;

export class Page {
  private waits = 0;

  constructor(readonly cdp: Cdp, readonly sessionId: string, readonly target: TargetInfo) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  /** Evaluate in the page; a promise is awaited. A thrown error becomes a rejection with its message. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /**
   * Wait until `expression` (evaluated in the page) is truthy, re-checking on every DOM mutation, not
   * on a timer. Resolves with its value. At the deadline fails with `what` and the last value seen.
   */
  async waitFor<T = unknown>(what: string, expression: string, ms = 30_000): Promise<T> {
    // Per-call keys, so two waits on one page don't overwrite each other's stop and last-seen values.
    const key = `__walk${this.waits++}`;
    // Re-checks on DOM mutations and on every frame: a mutation observer on `document` sees neither
    // changes inside a shadow root nor expando properties on an element.
    const script = `new Promise((resolve) => {
      let frame = 0;
      const done = (r) => { obs.disconnect(); cancelAnimationFrame(frame); resolve(r); };
      const check = () => { try { const v = (${expression}); if (v) { done({ ok: true, v: v instanceof Node ? true : v }); return true; } window.${key}Last = v; } catch (e) { window.${key}Last = 'threw: ' + e.message; } return false; };
      const obs = new MutationObserver(check);
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => { if (!check()) frame = requestAnimationFrame(tick); };
      window.${key}Stop = () => done({ ok: false });
      tick();
    })`;
    // A page that reloads while it's being waited on (the Mac app does once, soon after it opens) destroys
    // the context the wait runs in: the wait starts again in the new one; the deadline still bounds it.
    const lost = /Execution context was destroyed|Cannot find context|Inspected target navigated or closed/;
    let abandoned = false;
    const run = (async () => {
      while (!abandoned) {
        try {
          return await this.evaluate<{ ok: boolean; v: T }>(script);
        } catch (e) {
          if (!(e instanceof Error && lost.test(e.message))) throw e;
          await new Promise<void>((res) => setTimeout(res, 50));
        }
      }
      return { ok: false, v: undefined as T };
    })();
    try {
      const r = await withDeadline(what, ms, run, () => undefined);
      return r.v;
    } catch (e) {
      abandoned = true;
      const last = await this.evaluate<string>(`(window.${key}Stop && window.${key}Stop(), String(JSON.stringify(window.${key}Last) ?? 'false') + ' on ' + location.hash + ' (' + ${PAGE_STATE} + ') / ' + (document.body?.innerText ?? '').slice(0, 200))`).catch(() => "(page not answering)");
      if (e instanceof Error && e.name === "DeadlineError") throw new Error(`${e.message.replace(/last seen: .*$/, "")}last seen: ${last.replace(/\s+/g, " ")}`);
      throw e;
    }
  }

  /** The viewport-centre of the first element matching `selector`, once it is visible. */
  private async centre(what: string, selector: string, ms: number): Promise<{ x: number; y: number }> {
    return this.waitFor<{ x: number; y: number }>(
      `${what} (${selector}) to be visible`,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
      ms,
    );
  }

  /** A real mouse click at the element's centre. */
  async click(selector: string, ms = 30_000): Promise<void> {
    const { x, y } = await this.centre("click target", selector, ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async focus(selector: string, ms = 30_000): Promise<void> {
    await this.centre("focus target", selector, ms);
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  }

  /** Type into whatever is focused, as input events. */
  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** A key chord such as {key:"t", code:"KeyT", modifiers: META}. */
  async press(key: string, code: string, modifiers = 0): Promise<void> {
    const vk: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 };
    const base = { key, code, modifiers, windowsVirtualKeyCode: vk[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0) };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
