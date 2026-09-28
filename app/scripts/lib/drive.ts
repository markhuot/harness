// Helpers for driving the built Electron app over the Chrome DevTools Protocol (smoke.ts,
// real-service.ts). No test framework: small checks that print ✓/✗.
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "@harness/shared/testing";

export const appDir = resolve(import.meta.dir, "..", "..");

export async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}${last ? ` (${(last as Error).message})` : ""}`);
}

export function checker() {
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };
  return { check, fail: () => failures++, get failures() { return failures; } };
}

export function api(base: string, token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { data?: T; error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
    return json.data as T;
  };
}

export async function waitHealthy(base: string, ms = 10000) {
  await until(`${base}/health`, async () => (await fetch(base + "/health")).ok, ms);
}

/**
 * Wait for a process that was sent SIGTERM to exit, escalating to SIGKILL. Removing a profile dir
 * while Electron is still shutting down would race its final writes and leave files behind.
 */
export async function stopped(proc: { exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void }, ms = 5000): Promise<void> {
  const timedOut = await Promise.race([proc.exited.then(() => false), Bun.sleep(ms).then(() => true)]);
  if (!timedOut) return;
  proc.kill("SIGKILL");
  await proc.exited;
}

/** Launch the built app (dist/, or with `packaged` the app `bun run package` made) against a service and attach over CDP. */
export async function launchApp(opts: { baseUrl: string; token: string; theme?: "light" | "dark"; env?: Record<string, string>; packaged?: boolean }) {
  const cdpPort = 9300 + Math.floor(Math.random() * 600);
  const bin = opts.packaged
    ? join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app", "Contents", "MacOS", "Harness")
    : join(appDir, "..", "node_modules", ".bin", "electron");
  // Keep rendering (transitions, rAF, timers) while the window is behind others or on another
  // Space: an occluded window otherwise freezes CSS transitions and the checks that wait on them.
  const keepRendering = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
  // Electron's profile (GPUCache, Local Storage, …). close() removes it once Electron has exited;
  // tempDir's exit listener is the backstop for a script that never gets to close().
  const userData = tempDir("harness-drive-");
  const proc = Bun.spawn([bin, ...(opts.packaged ? [] : [appDir]), `--remote-debugging-port=${cdpPort}`, ...keepRendering], {
    env: {
      ...process.env,
      HARNESS_URL: opts.baseUrl,
      HARNESS_TOKEN: opts.token,
      HARNESS_USER_DATA: userData,
      HARNESS_DEBUG: "1",
      ...(opts.theme ? { HARNESS_THEME: opts.theme } : {}),
      ...opts.env,
    },
    stdout: "inherit",
    stderr: "ignore",
  });

  let ws: WebSocket;
  try {
    const target = await until(
      "devtools target",
      async () => {
        const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        return list.find((t) => t.type === "page" && t.url.startsWith("file://"));
      },
      15000,
    );
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
  } catch (e) {
    // The caller never gets a close() for an app that didn't attach, so stop it here.
    proc.kill();
    await stopped(proc);
    rmSync(userData, { recursive: true, force: true });
    throw e;
  }
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const listeners = new Set<(method: string, params: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)!(msg);
    else if (msg.method) for (const fn of listeners) fn(msg.method, msg.params);
  };
  /** Listen to CDP events (enable the domain first, e.g. Network.enable). */
  const on = (fn: (method: string, params: any) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const cdp = (method: string, params: object = {}) =>
    new Promise<any>((r) => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const js = async <T = unknown>(expression: string): Promise<T> => {
    const res = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "eval failed");
    return res.result?.result?.value as T;
  };
  const exists = (sel: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
  // React-controlled inputs need the native setter + an input event.
  const type = (sel: string, text: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const key = async (k: string, code: string, vk: number, modifiers = 0) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const cmdEnter = () => key("Enter", "Enter", 13, 4);
  const clickText = (sel: string, text: string) =>
    js<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled);
      if (!el) return false; el.click(); return true; })()`);
  const go = (hash: string) => js(`location.hash = ${JSON.stringify(hash)}`);
  const screenshot = async (file: string) => {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log(`  📸 ${file}`);
  };
  /** Quit Electron, wait for it to exit (SIGKILL after 5 s), then remove its profile dir. */
  const close = async () => {
    try {
      ws.close();
    } catch {}
    proc.kill();
    await stopped(proc);
    rmSync(userData, { recursive: true, force: true });
  };
  /** Evaluate in a child frame's own target (plugin iframes are out-of-process: a separate CDP target). */
  const frame = async (urlPart: string) => {
    const t = await until(
      `frame target ${urlPart}`,
      async () => ((await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]).find((x) => x.type === "iframe" && x.url.includes(urlPart)),
      15000,
    );
    const fws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (fws.onopen = r));
    let n = 0;
    const waiting = new Map<number, (v: any) => void>();
    const events: { method: string; params: any }[] = [];
    fws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)!(msg);
      else if (msg.method) events.push(msg);
    };
    const fcdp = (method: string, params: object = {}) =>
      new Promise<any>((r) => {
        const i = ++n;
        waiting.set(i, r);
        fws.send(JSON.stringify({ id: i, method, params }));
      });
    const fjs = async <T = unknown>(expression: string): Promise<T> => {
      const res = await fcdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "eval failed");
      return res.result?.result?.value as T;
    };
    return { url: t.url, js: fjs, cdp: fcdp, events, close: () => fws.close() };
  };
  return { proc, cdpPort, cdp, on, js, exists, type, key, cmdEnter, clickText, go, screenshot, frame, close };
}
