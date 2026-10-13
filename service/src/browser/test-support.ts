// Shared by the real-Chrome BrowserManager test files (manager*.test.ts): one fixture site, a
// profile directory per file, and small helpers. Each file has its own Chrome, so the files run
// in parallel under the test runner.

import { describe } from "bun:test";
import type { BrowserManager } from "./manager.ts";
import type { StoredBrowserTabs } from "./types.ts";
import { tempDir } from "@harness/shared/testing";
import { describeIf } from "@harness/shared/testing/skip";
import { findChrome } from "./chrome.ts";

export const chromePath = findChrome();
export const withChrome = describeIf(chromePath, "Chrome not found (set HARNESS_CHROME_PATH): the real-Chrome browser tests skipped");

// One Chrome profile per test file, so files running in parallel never share one.
export const profileDir = chromePath ? tempDir("harness-browser-test-") : "";

// The viewport tag a responsive site has, so a "mobile" tab lays the page out at its own width.
export const html = (body: string, title = "Fixture", head = `<meta name="viewport" content="width=device-width, initial-scale=1">`) =>
  new Response(`<!doctype html><html><head>${head}<title>${title}</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export const LONG = "abcdefghij".repeat(50);

export function fixtures(req: Request): Response {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/":
      return html(
        `<h1>Welcome home</h1>
         <div class="item">First item</div>
         <div class="item">Second item</div>
         <p id="long">${LONG}</p>
         <button id="btn" onclick="document.getElementById('out').textContent = 'Clicked!'">Press</button>
         <div id="out">idle</div>
         <div id="hidden" style="display:none" onclick="document.getElementById('out').textContent = 'hidden clicked'">x</div>`,
        "Home Page",
      );
    case "/page2":
      return html(`<h1>Second page</h1>`, "Page Two");
    case "/links":
      return html(`<a id="go" href="/page2" style="display:block;width:200px;height:40px">same tab</a>`, "Links");
    case "/popup":
      return html(
        `<a id="blank" href="/page2" target="_blank" style="display:block;width:200px;height:40px">new tab</a>
         <button id="open" onclick="window.open('/form')">window.open</button>`,
        "Popup",
      );
    case "/form":
      return html(
        `<form action="/result" method="get">
           <input id="q" name="q" value="old value">
           <button type="submit">Go</button>
         </form>`,
        "Form",
      );
    case "/result":
      return html(`<p id="echo">You searched: ${url.searchParams.get("q") ?? ""}</p>`, "Result");
    case "/pad":
      return html(
        `<style>body{margin:0}#target{position:absolute;left:100px;top:150px;width:200px;height:100px;background:#09f}</style>
         <div id="target"></div>
         <input id="field" style="position:absolute;left:0;top:400px">
         <script>
           window.hits = [];
           document.getElementById('target').addEventListener('click', (e) => window.hits.push({ x: e.clientX, y: e.clientY }));
         </script>`,
        "Pad",
      );
    case "/anim":
      return html(
        `<div id="box" style="width:100px;height:100px"></div>
         <script>let n = 0; setInterval(() => { document.getElementById('box').style.background = 'hsl(' + (n++ * 37 % 360) + ',80%,50%)'; }, 30);</script>`,
        "Anim",
      );
    case "/elements":
      return html(
        `<style>body{margin:0} p,button,em,span{display:block;height:30px;margin:0;padding:0;border:0}</style>
         <div id="login"><form><button>One</button><button id="dup">Two</button><button>  Sign
           in   </button></form></div>
         <div id="dup"><span>Not unique</span></div>
         <section><p>First</p><p>Second para</p></section>
         <div id="a:b.c"><em>Escaped</em></div>
         <p id="long">${LONG}</p>
         <div style="height:3000px"></div>`,
        "Elements",
      );
    case "/tall":
      return html(
        `<style>body{margin:0} #top{height:2500px;background:#fc0} #card{position:absolute;left:40px;top:2200px;width:300px;height:500px;background:#09f}</style>
         <div id="top"></div><div style="height:500px"></div><div id="card"></div><div id="empty"></div>`,
        "Tall",
      );
    case "/halves":
      return html(
        `<style>body{margin:0} div{position:fixed;top:0;bottom:0;width:50%} #a{left:0;background:#fc0} #b{right:0;background:#09f}</style>
         <div id="a">Left</div><div id="b">Right</div>`,
        "Halves",
      );
    case "/ua":
      // What the server saw: the user agent of each load of this page, in order.
      uaHits.push(req.headers.get("user-agent") ?? "");
      return html(`<p id="ua">${req.headers.get("user-agent") ?? ""}</p>`, "UA");
    case "/legacy":
      return html(`<p>No viewport tag</p>`, "Legacy", "");
    case "/touch":
      return html(
        `<button id="tap" style="display:block;width:200px;height:60px">tap</button>
         <script>
           window.seen = [];
           const b = document.getElementById('tap');
           for (const t of ['touchstart', 'touchend', 'mousedown', 'click']) b.addEventListener(t, () => window.seen.push(t));
         </script>`,
        "Touch",
      );
    case "/noisy":
      return html(
        `<script>
           console.error('boom', { code: 7 });
           console.warn('careful');
           console.log('not reported');
           fetch('/missing').catch(() => {});
           fetch('http://127.0.0.1:1/refused').catch(() => {});
           setTimeout(() => { throw new Error('late failure'); }, 0);
         </script>`,
        "Noisy",
      );
    default:
      return new Response("not found", { status: 404 });
  }
}

/** The User-Agent of every load of /ua, in order. */
export const uaHits: string[] = [];

export async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An in-memory BrowserTabStore (the database's browser_tabs), so a test can play a restart. */
export function memoryTabStore() {
  const rows = new Map<string, StoredBrowserTabs>();
  return {
    rows,
    load: (id: string) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    save: (id: string, state: StoredBrowserTabs) => void rows.set(id, structuredClone(state)),
    delete: (id: string) => void rows.delete(id),
  };
}

/** URLs of the page targets Chrome itself reports (its DevTools /json/list), not our bookkeeping. */
export async function chromePages(browser: BrowserManager): Promise<string[]> {
  const chrome = (browser as any).browser?.chrome;
  if (!chrome) return [];
  const res = await fetch(`http://${new URL(chrome.wsUrl).host}/json/list`);
  const targets = (await res.json()) as { type: string; url: string }[];
  return targets.filter((t) => t.type === "page").map((t) => t.url);
}

export const ids = (tabs: { id: number; suspended?: boolean }[]) => tabs.map((t) => (t.suspended ? `${t.id}z` : `${t.id}`));
