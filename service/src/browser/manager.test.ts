import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { BrowserState } from "@harness/shared";
import { codeSignCloneRoot, findChrome } from "./chrome.ts";
import { BrowserManager, normalizeUrl } from "./manager.ts";
import { createBrowserService } from "./index.ts";
import type { BrowserFrame, StoredBrowserTabs } from "./types.ts";
import { tempDir } from "@harness/shared/testing";

const chromePath = findChrome();
if (!chromePath) {
  console.warn("[browser tests] Chrome not found (set HARNESS_CHROME_PATH); skipping Chrome integration tests.");
}
const withChrome = chromePath ? describe : describe.skip;

// One Chrome profile for the whole file (Chrome instances here run one at a time).
const profileDir = chromePath ? tempDir("harness-browser-test-") : "";

// The viewport tag a responsive site has, so a "mobile" tab lays the page out at its own width.
const html = (body: string, title = "Fixture", head = `<meta name="viewport" content="width=device-width, initial-scale=1">`) =>
  new Response(`<!doctype html><html><head>${head}<title>${title}</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const LONG = "abcdefghij".repeat(50);

function fixtures(req: Request): Response {
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
const uaHits: string[] = [];

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("normalizeUrl", () => {
  test("adds https:// to bare hosts and http:// to loopback", () => {
    expect(normalizeUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeUrl("  news.ycombinator.com ")).toBe("https://news.ycombinator.com");
    expect(normalizeUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
    // "localhostfoo.com" is not loopback.
    expect(normalizeUrl("localhostfoo.com")).toBe("https://localhostfoo.com");
  });

  test("leaves URLs with a scheme alone", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("data:text/html,hi")).toBe("data:text/html,hi");
    expect(normalizeUrl("file:///tmp/x.html")).toBe("file:///tmp/x.html");
    expect(normalizeUrl("")).toBe("about:blank");
  });
});

withChrome("BrowserManager (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;
  let browser: BrowserManager;

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000 });
  });

  afterAll(async () => {
    await browser?.shutdown();
    void server?.stop(true);
  });

  test("state is null before a session has a tab; open returns title and url", async () => {
    expect(await browser.state("s-open")).toBeNull();
    const state = await browser.open("s-open", `${base}/`);
    expect(state).toEqual({
      sessionId: "s-open",
      tabId: 1,
      url: `${base}/`,
      title: "Home Page",
      loading: false,
      size: { device: "desktop", width: 1280, height: 800, responsive: true },
      tabs: [{ id: 1, url: `${base}/`, title: "Home Page", loading: false, size: { device: "desktop", width: 1280, height: 800, responsive: true } }],
    });
    expect(await browser.state("s-open")).toEqual(state);
  }, 30_000);

  test("open surfaces network errors", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = dead.port;
    await dead.stop(true);
    await expect(browser.open("s-open", `http://127.0.0.1:${port}/`)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  }, 30_000);

  describe("content", () => {
    beforeAll(async () => {
      await browser.open("s-content", `${base}/`);
    });

    test("full page text", async () => {
      const text = await browser.content("s-content");
      expect(text).toContain("Welcome home");
      expect(text).toContain("Second item");
      // innerText, not textContent: display:none content is excluded and there is no markup.
      expect(text).not.toContain("hidden clicked");
      expect(text).not.toContain("<h1>");
    });

    test("selector joins every match with a blank line", async () => {
      expect(await browser.content("s-content", { selector: ".item" })).toBe("First item\n\nSecond item");
    });

    test("html format returns outerHTML", async () => {
      expect(await browser.content("s-content", { selector: "h1", format: "html" })).toBe("<h1>Welcome home</h1>");
      const full = await browser.content("s-content", { format: "html" });
      expect(full.startsWith("<html>")).toBe(true);
      expect(full).toContain("<title>Home Page</title>");
    });

    test("missing selector throws; invalid selector throws", async () => {
      await expect(browser.content("s-content", { selector: ".does-not-exist" })).rejects.toThrow(/No elements match selector: \.does-not-exist/);
      await expect(browser.content("s-content", { selector: "[[bad" })).rejects.toThrow(/not a valid selector/);
    });

    test("maxChars truncates with a marker, and only when needed", async () => {
      const cut = await browser.content("s-content", { selector: "#long", maxChars: 25 });
      expect(cut.startsWith(LONG.slice(0, 25))).toBe(true);
      expect(cut).not.toContain(LONG.slice(0, 26));
      expect(cut).toContain(`[truncated: showing 25 of ${LONG.length} characters]`);
      expect(await browser.content("s-content", { selector: "#long", maxChars: LONG.length })).toBe(LONG);
    });
  });

  describe("click / type", () => {
    test("click runs the element's handler", async () => {
      await browser.open("s-click", `${base}/`);
      expect(await browser.content("s-click", { selector: "#out" })).toBe("idle");
      await browser.click("s-click", "#btn");
      expect(await browser.content("s-click", { selector: "#out" })).toBe("Clicked!");
    }, 30_000);

    test("click falls back to el.click() for non-hittable elements", async () => {
      await browser.open("s-click", `${base}/`);
      await browser.click("s-click", "#hidden");
      expect(await browser.content("s-click", { selector: "#out" })).toBe("hidden clicked");
    }, 30_000);

    test("click on a missing element throws", async () => {
      await expect(browser.click("s-click", "#nope")).rejects.toThrow(/No element matches selector: #nope/);
    });

    test("type replaces the value and submit navigates, waiting for the result page", async () => {
      await browser.open("s-type", `${base}/form`);
      await browser.type("s-type", "#q", "hello world", { submit: true });
      const state = await browser.state("s-type");
      expect(state?.url).toBe(`${base}/result?q=hello+world`);
      expect(state?.title).toBe("Result");
      // "old value" was replaced, not appended to.
      expect(await browser.content("s-type", { selector: "#echo" })).toBe("You searched: hello world");
    }, 30_000);

    test("type without submit leaves the page in place", async () => {
      await browser.open("s-type", `${base}/form`);
      await browser.type("s-type", "#q", "draft");
      expect(await browser.evaluate("s-type", "document.getElementById('q').value")).toBe('"draft"');
      expect((await browser.state("s-type"))?.url).toBe(`${base}/form`);
      await expect(browser.type("s-type", "#missing", "x")).rejects.toThrow(/No element matches/);
    }, 30_000);
  });

  describe("evaluate / screenshot", () => {
    beforeAll(async () => {
      await browser.open("s-eval", `${base}/`);
    });

    test("returns JSON of values, awaits promises", async () => {
      expect(await browser.evaluate("s-eval", "({ a: 1, list: [1, 'two'], title: document.title })")).toBe(
        '{"a":1,"list":[1,"two"],"title":"Home Page"}',
      );
      expect(await browser.evaluate("s-eval", "new Promise(r => setTimeout(() => r(42), 20))")).toBe("42");
      expect(await browser.evaluate("s-eval", "undefined")).toBe("undefined");
      expect(await browser.evaluate("s-eval", "0/0")).toBe("NaN");
      expect(await browser.evaluate("s-eval", "document.getElementById('btn')")).toBe('"button#btn"');
      // Cyclic / non-serializable objects are described rather than failing.
      expect(await browser.evaluate("s-eval", "window")).toBe('"Window"');
    });

    test("surfaces thrown exceptions and rejected promises", async () => {
      await expect(browser.evaluate("s-eval", "throw new Error('kaboom')")).rejects.toThrow(/kaboom/);
      await expect(browser.evaluate("s-eval", "Promise.reject(new TypeError('nope'))")).rejects.toThrow(/TypeError: nope/);
      await expect(browser.evaluate("s-eval", "this is not js")).rejects.toThrow(/SyntaxError/);
    });

    test("screenshot is a PNG of the viewport", async () => {
      const png = Buffer.from(await browser.screenshot("s-eval"), "base64");
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // IHDR width/height (big-endian at offsets 16 and 20) match the 1280x800 viewport.
      expect(png.readUInt32BE(16)).toBe(1280);
      expect(png.readUInt32BE(20)).toBe(800);
    });

    test("capture is the viewport's PNG with its CSS size, scale and tab", async () => {
      const shot = await browser.capture("s-eval");
      const png = Buffer.from(shot.data, "base64");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([shot.width, shot.height]);
      expect([shot.width, shot.height, shot.viewport, shot.scale]).toEqual([1280, 800, { width: 1280, height: 800 }, 1]);
      expect([shot.tabId, shot.url, shot.title]).toEqual([1, `${base}/`, "Home Page"]);
      await expect(browser.capture("s-eval", { tab: 9 })).rejects.toThrow();
    });
  });

  test("sessions get isolated tabs", async () => {
    await browser.open("iso-a", `${base}/`);
    await browser.open("iso-b", `${base}/page2`);
    await browser.evaluate("iso-a", "window.mine = 'a'");
    expect(await browser.evaluate("iso-b", "window.mine")).toBe("undefined");
    expect((await browser.state("iso-a"))?.title).toBe("Home Page");
    expect((await browser.state("iso-b"))?.title).toBe("Page Two");
    // Closing one session leaves the other alone.
    await browser.close("iso-a");
    expect(await browser.state("iso-a")).toBeNull();
    expect((await browser.state("iso-b"))?.title).toBe("Page Two");
  }, 30_000);

  describe("elementAt", () => {
    const centre = async (selector: string) =>
      JSON.parse(await browser.evaluate("s-el", `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as {
        x: number;
        y: number;
      };

    beforeAll(async () => {
      await browser.open("s-el", `${base}/elements`);
    });

    test("names the element under a point: a unique id, nth-of-type steps, escaping, and its text", async () => {
      const shot = await browser.capture("s-el");
      expect(shot.scroll).toEqual({ x: 0, y: 0 });
      const at = async (selector: string) => browser.elementAt("s-el", { tabId: shot.tabId, ...(await centre(selector)), url: shot.url, scroll: shot.scroll, viewport: shot.viewport });
      // The third button: two siblings share its tag; form is the only one of its kind.
      expect(await at("#login button:nth-of-type(3)")).toEqual({ path: "#login > form > button:nth-of-type(3)", text: "Sign in" });
      // "dup" is on two elements, so it isn't an anchor: the chain goes up to body.
      expect(await at("div#dup span")).toEqual({ path: "body > div:nth-of-type(2) > span", text: "Not unique" });
      expect(await at("button#dup")).toEqual({ path: "#login > form > button:nth-of-type(2)", text: "Two" });
      expect(await at("section p:nth-of-type(2)")).toEqual({ path: "body > section > p:nth-of-type(2)", text: "Second para" });
      const escaped = await at("em");
      expect(escaped).toEqual({ path: "#a\\:b\\.c > em", text: "Escaped" });
      // The selector finds the same element in the page.
      expect(await browser.evaluate("s-el", `document.querySelector(${JSON.stringify(escaped!.path)}).textContent`)).toBe('"Escaped"');
      // The element itself can be the anchor; its text is cut to MAX_ANNOTATION_TEXT.
      expect(await at("#long")).toEqual({ path: "#long", text: LONG.slice(0, 200) });
    }, 30_000);

    test("answers null once the tab scrolled or navigated since the screenshot, and never scrolls it", async () => {
      await browser.open("s-el", `${base}/elements`);
      const shot = await browser.capture("s-el");
      const point = await centre("em");
      await browser.evaluate("s-el", "window.scrollTo(0, 120)");
      expect(await browser.elementAt("s-el", { tabId: shot.tabId, ...point, url: shot.url, scroll: shot.scroll, viewport: shot.viewport })).toBeNull();
      expect(await browser.evaluate("s-el", "window.scrollY")).toBe("120");
      // A screenshot taken there matches again (and reports the scroll).
      const scrolled = await browser.capture("s-el");
      expect(scrolled.scroll).toEqual({ x: 0, y: 120 });
      expect(await browser.elementAt("s-el", { tabId: shot.tabId, x: point.x, y: point.y - 120, url: scrolled.url, scroll: scrolled.scroll, viewport: scrolled.viewport })).toEqual({ path: "#a\\:b\\.c > em", text: "Escaped" });
      expect(await browser.elementAt("s-el", { tabId: shot.tabId, ...point, url: scrolled.url, scroll: { x: 0, y: 120.6 }, viewport: scrolled.viewport })).not.toBeNull();
      await browser.open("s-el", `${base}/page2`);
      expect(await browser.elementAt("s-el", { tabId: shot.tabId, ...point, url: shot.url, scroll: { x: 0, y: 0 }, viewport: shot.viewport })).toBeNull();
      await expect(browser.elementAt("s-el", { tabId: 9, ...point, url: shot.url, scroll: shot.scroll, viewport: shot.viewport })).rejects.toThrow();
    }, 30_000);

    test("answers null once the tab was resized since the screenshot (a viewer's pane changed), and matches again at the new size", async () => {
      await browser.open("s-halves", `${base}/halves`);
      const shot = await browser.capture("s-halves");
      expect(shot.viewport).toEqual({ width: 1280, height: 800 });
      const query = { tabId: shot.tabId, x: 700, y: 100, url: shot.url, scroll: shot.scroll, viewport: shot.viewport };
      expect(await browser.elementAt("s-halves", query)).toEqual({ path: "#b", text: "Right" });
      // Wider: (700, 100) is now over the left half. Narrower: it's outside the page. Either way, null.
      await browser.resize("s-halves", { width: 1600, height: 800 });
      await until(async () => (await browser.evaluate("s-halves", "window.innerWidth")) === "1600", "the tab to be 1600 wide");
      expect(await browser.evaluate("s-halves", "document.elementFromPoint(700, 100).id")).toBe('"a"');
      expect(await browser.elementAt("s-halves", query)).toBeNull();
      await browser.resize("s-halves", { width: 480, height: 800 });
      await until(async () => (await browser.evaluate("s-halves", "window.innerWidth")) === "480", "the tab to be 480 wide");
      expect(await browser.elementAt("s-halves", query)).toBeNull();
      // A screenshot at the new size names what's there now.
      const again = await browser.capture("s-halves");
      expect(await browser.elementAt("s-halves", { ...query, x: 300, viewport: again.viewport })).toEqual({ path: "#b", text: "Right" });
    }, 30_000);
  });

  describe("tabs", () => {
    test("new tabs count up; calls without a tab use the lowest open one; each tab keeps its own page", async () => {
      await browser.open("t-many", `${base}/`);
      const two = await browser.open("t-many", `${base}/page2`, { newTab: true });
      const three = await browser.open("t-many", `${base}/form`, { newTab: true });
      expect([two.tabId, three.tabId]).toEqual([2, 3]);
      expect(three.tabs?.map((t) => [t.id, t.title])).toEqual([[1, "Home Page"], [2, "Page Two"], [3, "Form"]]);

      // Each tab is its own page: JS state, content and navigation don't leak between them.
      await browser.evaluate("t-many", "window.mine = 'two'", { tab: 2 });
      expect(await browser.evaluate("t-many", "window.mine")).toBe("undefined");
      expect(await browser.evaluate("t-many", "window.mine", { tab: 2 })).toBe('"two"');
      expect(await browser.content("t-many", { selector: "h1", tab: 2 })).toBe("Second page");
      await browser.type("t-many", "#q", "tabs", { submit: true, tab: 3 });
      expect(await browser.content("t-many", { selector: "#echo", tab: 3 })).toBe("You searched: tabs");
      expect((await browser.state("t-many"))?.title).toBe("Home Page");
      await browser.click("t-many", "#btn");
      expect(await browser.content("t-many", { selector: "#out" })).toBe("Clicked!");

      // Navigating a given tab leaves the others where they were.
      await browser.open("t-many", `${base}/`, { tab: 2 });
      expect((await browser.tabs("t-many")).map((t) => t.title)).toEqual(["Home Page", "Home Page", "Result"]);

      // Closing tab 1 makes tab 2 the default; numbers aren't reused.
      await browser.closeTab("t-many", 1);
      expect((await browser.state("t-many"))?.tabId).toBe(2);
      expect((await browser.open("t-many", `${base}/page2`, { newTab: true })).tabId).toBe(4);
      expect((await browser.tabs("t-many")).map((t) => t.id)).toEqual([2, 3, 4]);
      await browser.close("t-many");
      expect(await browser.tabs("t-many")).toEqual([]);
    }, 30_000);

    test("an unknown tab is an error naming the open ones, and never opens a tab", async () => {
      await browser.open("t-bad", `${base}/`);
      await expect(browser.content("t-bad", { tab: 7 })).rejects.toThrow("No browser tab 7. Open tabs: 1.");
      await expect(browser.closeTab("t-bad", 7)).rejects.toThrow("No browser tab 7");
      await expect(browser.open("t-bad", `${base}/`, { tab: 2 })).rejects.toThrow("No browser tab 2");
      await expect(browser.evaluate("t-none", "1", { tab: 1 })).rejects.toThrow("This session has no open tabs.");
      expect(await browser.state("t-bad", { tab: 7 })).toBeNull();
      expect((await browser.tabs("t-bad")).map((t) => t.id)).toEqual([1]);
      expect(await browser.tabs("t-none")).toEqual([]);
    }, 30_000);

    test("parallel callers each get their own new tab", async () => {
      const opened = await Promise.all([1, 2, 3].map(() => browser.open("t-par", `${base}/page2`, { newTab: true })));
      expect(opened.map((s) => s.tabId).sort()).toEqual([1, 2, 3]);
      await browser.close("t-par");
    }, 30_000);

    test("each subscriber watches one tab; only watched tabs screencast; switching sends that tab's state and frames", async () => {
      await browser.open("t-cast", `${base}/anim`);
      await browser.open("t-cast", `${base}/page2`, { newTab: true });
      const frames: BrowserFrame[] = [];
      const states: BrowserState[] = [];
      await browser.subscribe("t-cast", "v", (f) => frames.push(f), (s) => states.push(s));
      expect(states.at(-1)).toMatchObject({ tabId: 1, title: "Anim", tabs: [{ id: 1 }, { id: 2 }] });
      await until(() => frames.length >= 2, "frames from tab 1");
      expect(frames.every((f) => f.tabId === 1)).toBe(true);
      expect(browser.screencastInfo("t-cast", { tab: 2 })!.active).toBe(false);

      // Subscribing again with a tab switches: tab 1 stops casting, tab 2 starts.
      frames.length = 0;
      await browser.subscribe("t-cast", "v", (f) => frames.push(f), (s) => states.push(s), { tab: 2 });
      expect(states.at(-1)).toMatchObject({ tabId: 2, title: "Page Two" });
      expect(browser.screencastInfo("t-cast", { tab: 1 })!.active).toBe(false);
      expect(browser.screencastInfo("t-cast", { tab: 2 })!.active).toBe(true);
      await until(() => frames.some((f) => f.tabId === 2), "a frame from tab 2", 3000);
      expect(frames.every((f) => f.tabId === 2)).toBe(true);

      // A second viewer on tab 1 casts it again without moving the first.
      const other: BrowserFrame[] = [];
      await browser.subscribe("t-cast", "w", (f) => other.push(f), () => {}, { tab: 1 });
      await until(() => other.length >= 2, "frames for the second viewer");
      expect(other.every((f) => f.tabId === 1)).toBe(true);
      expect(browser.screencastInfo("t-cast", { tab: 2 })!.active).toBe(true);

      // Every viewer hears about tabs opening, whichever tab it's on.
      const before = states.length;
      await browser.open("t-cast", `${base}/`, { newTab: true });
      await until(() => states.slice(before).some((s) => s.tabId === 2 && s.tabs?.length === 3), "the tab list to grow");

      await browser.unsubscribe("t-cast", "v");
      await browser.unsubscribe("t-cast", "w");
      expect(browser.screencastInfo("t-cast", { tab: 1 })!.active).toBe(false);
      expect(browser.screencastInfo("t-cast", { tab: 2 })!.active).toBe(false);
      await browser.close("t-cast");
    }, 30_000);

    test("viewer input: newTab moves that viewer to the new tab, closeTab moves it back, closing the last leaves a blank tab", async () => {
      await browser.open("t-input", `${base}/`);
      const states: BrowserState[] = [];
      await browser.subscribe("t-input", "v", () => {}, (s) => states.push(s));
      await browser.subscribe("t-input", "bystander", () => {}, () => {});

      await browser.input("t-input", { type: "newTab", url: `${base}/page2` }, { subscriberId: "v" });
      await until(() => states.find((s) => s.tabId === 2 && s.title === "Page Two"), "the viewer on tab 2");
      // Input without a tab goes to the tab the viewer watches, not the default.
      await browser.input("t-input", { type: "navigate", url: `${base}/form` }, { subscriberId: "v" });
      await until(async () => (await browser.state("t-input", { tab: 2 }))?.title === "Form", "tab 2 navigated");
      expect((await browser.state("t-input"))?.title).toBe("Home Page");
      // The bystander stayed on tab 1.
      await browser.input("t-input", { type: "navigate", url: `${base}/page2` }, { subscriberId: "bystander" });
      await until(async () => (await browser.state("t-input", { tab: 1 }))?.title === "Page Two", "tab 1 navigated");

      // Closing the watched tab moves the viewer to the lowest open tab.
      await browser.input("t-input", { type: "closeTab" }, { subscriberId: "v" });
      await until(() => states.at(-1)?.tabId === 1 && states.at(-1)?.tabs?.length === 1, "the viewer back on tab 1");

      // Closing the last tab (an explicit tab this time) leaves a fresh blank one for the viewers.
      await browser.input("t-input", { type: "closeTab" }, { tab: 1, subscriberId: "v" });
      await until(() => states.at(-1)?.tabId === 3, "a blank tab 3");
      expect(states.at(-1)).toMatchObject({ url: "about:blank", tabs: [{ id: 3 }] });

      await browser.unsubscribe("t-input", "v");
      await browser.unsubscribe("t-input", "bystander");
      await browser.close("t-input");
    }, 30_000);

    test("pages a tab opens (target=_blank, window.open) become the session's next tabs, and still paint", async () => {
      await browser.open("t-pop", `${base}/popup`);
      await browser.click("t-pop", "#blank");
      await until(async () => (await browser.tabs("t-pop")).find((t) => t.id === 2 && t.title === "Page Two"), "the link's tab");
      await browser.click("t-pop", "#open");
      await until(async () => (await browser.tabs("t-pop")).find((t) => t.id === 3 && t.title === "Form"), "the window.open tab");
      expect(await browser.content("t-pop", { selector: "h1", tab: 2 })).toBe("Second page");
      // Both the opener and its popup still screencast.
      for (const tab of [1, 2]) {
        const frames: BrowserFrame[] = [];
        await browser.subscribe("t-pop", "v", (f) => frames.push(f), () => {}, { tab });
        await until(() => frames.some((f) => f.tabId === tab), `a frame from tab ${tab}`, 3000);
      }
      await browser.unsubscribe("t-pop", "v");
      // A page closing itself drops its tab.
      await browser.evaluate("t-pop", "window.close()", { tab: 3 });
      await until(async () => (await browser.tabs("t-pop")).length === 2, "the closed popup's tab to go");
      await browser.close("t-pop");
    }, 30_000);

    test("each tab keeps its own size; new tabs start at desktop 1280×800", async () => {
      // Not the home page: its long unbroken line would make a phone zoom out to fit it.
      await browser.open("t-size", `${base}/page2`);
      await browser.open("t-size", `${base}/page2`, { newTab: true });
      await browser.input("t-size", { type: "size", width: 800, height: 600 }, { tab: 1 });
      await browser.input("t-size", { type: "device", device: "mobile" }, { tab: 2 });
      await until(async () => (await browser.evaluate("t-size", "innerWidth", { tab: 2 }).catch(() => "")) === "393", "tab 2 to be mobile");
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight, navigator.maxTouchPoints]", { tab: 1 })).toBe("[800,600,0]");
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0]", { tab: 2 })).toBe("[393,852,true]");
      await browser.open("t-size", `${base}/`, { newTab: true });
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight]", { tab: 3 })).toBe("[1280,800]");
      expect((await browser.tabs("t-size")).map((t) => [t.id, t.size?.device, t.size?.width, t.size?.height])).toEqual([
        [1, "desktop", 800, 600],
        [2, "mobile", 393, 852],
        [3, "desktop", 1280, 800],
      ]);
      await browser.close("t-size");
    }, 30_000);
  });

  describe("screencast", () => {
    test("subscribe yields frames with dimensions; unsubscribe stops them", async () => {
      await browser.open("s-cast", `${base}/anim`);
      const frames: BrowserFrame[] = [];
      const states: BrowserState[] = [];
      await browser.subscribe("s-cast", "viewer-1", (f) => frames.push(f), (s) => states.push(s));
      await until(() => frames.length >= 2, "two frames");
      const f = frames[0]!;
      expect(f.sessionId).toBe("s-cast");
      expect(f.width).toBe(1280);
      expect(f.height).toBe(800);
      const jpeg = Buffer.from(f.data, "base64");
      expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      // The newcomer is told the current state immediately.
      expect(states[0]).toMatchObject({ sessionId: "s-cast", title: "Anim" });

      await browser.unsubscribe("s-cast", "viewer-1");
      await Bun.sleep(150); // let in-flight frames drain
      const count = frames.length;
      await Bun.sleep(500); // the page keeps animating
      expect(frames.length).toBe(count);
    }, 30_000);

    test("is ref-counted: frames continue until the last subscriber leaves", async () => {
      await browser.open("s-ref", `${base}/anim`);
      const a: BrowserFrame[] = [];
      const b: BrowserFrame[] = [];
      await browser.subscribe("s-ref", "a", (f) => a.push(f), () => {});
      await browser.subscribe("s-ref", "b", (f) => b.push(f), () => {});
      await browser.unsubscribe("s-ref", "a");
      const before = b.length;
      await until(() => b.length > before + 2, "frames for b after a left");
      await browser.unsubscribe("s-ref", "b");
    }, 30_000);

    test("a static page still delivers an initial frame", async () => {
      await browser.open("s-static", `${base}/page2`);
      const frames: BrowserFrame[] = [];
      await browser.subscribe("s-static", "v", (f) => frames.push(f), () => {});
      await until(() => frames.length >= 1, "initial frame", 3000);
      await browser.unsubscribe("s-static", "v");
    }, 30_000);

    test("concurrent resizes + subscribe don't wedge the screencast; unchanged resize is a no-op", async () => {
      await browser.open("s-race", `${base}/anim`);
      const frames: BrowserFrame[] = [];
      const late: BrowserFrame[] = [];
      // v1 drives the tab's size (Responsive), then everything fires at once, like a viewer whose
      // layout settles while another subscribes.
      await browser.subscribe("s-race", "v1", (f) => frames.push(f), () => {});
      await browser.input("s-race", { type: "responsive", on: true, width: 800, height: 500 }, { subscriberId: "v1" });
      const v1 = { subscriberId: "v1" };
      await Promise.all([
        browser.input("s-race", { type: "resize", width: 900, height: 700 }, v1),
        browser.input("s-race", { type: "resize", width: 1000, height: 650 }, v1),
        browser.subscribe("s-race", "v2", (f) => late.push(f), () => {}),
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }, v1),
      ]);
      const info = browser.screencastInfo("s-race")!;
      expect(info).toMatchObject({ active: true, width: 1024, height: 640 });

      // Frames keep flowing at the final size after the dust settles.
      frames.length = 0;
      await until(() => frames.filter((f) => f.width === 1024 && f.height === 640).length >= 3, "frames after resizes");
      expect(late.length).toBeGreaterThan(0);

      // Same size again (as viewers send on every layout pass): no restart.
      await Promise.all([
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }, v1),
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }, v1),
      ]);
      expect(browser.screencastInfo("s-race")!.starts).toBe(info.starts);
      // A real change does restart, exactly once.
      await browser.input("s-race", { type: "resize", width: 800, height: 600 }, v1);
      expect(browser.screencastInfo("s-race")).toMatchObject({ active: true, width: 800, height: 600, starts: info.starts + 1 });
      frames.length = 0;
      await until(() => frames.some((f) => f.width === 800), "frames after real resize");

      await Promise.all([browser.unsubscribe("s-race", "v1"), browser.unsubscribe("s-race", "v2")]);
      expect(browser.screencastInfo("s-race")!.active).toBe(false);
    }, 30_000);

    test("state callbacks fire on navigation and title change", async () => {
      await browser.open("s-state", `${base}/`);
      const states: BrowserState[] = [];
      await browser.subscribe("s-state", "watcher", () => {}, (s) => states.push(s));
      states.length = 0;
      await browser.open("s-state", `${base}/page2`);
      await until(() => states.find((s) => s.url === `${base}/page2` && s.title === "Page Two" && !s.loading), "page2 state");
      expect(states.some((s) => s.loading)).toBe(true);
      await browser.evaluate("s-state", "document.title = 'Renamed'");
      await until(() => states.find((s) => s.title === "Renamed"), "title change state");
      // The title watcher's binding is hidden from page scripts.
      expect(await browser.evaluate("s-state", "typeof window.__harnessTitleChanged")).toBe('"undefined"');
      await browser.unsubscribe("s-state", "watcher");
    }, 30_000);
  });

  describe("input", () => {
    test("mouse down/up at page coordinates clicks the element there", async () => {
      await browser.open("s-input", `${base}/pad`);
      // Outside the target: no hit.
      await browser.input("s-input", { type: "mouse", action: "down", x: 20, y: 20 });
      await browser.input("s-input", { type: "mouse", action: "up", x: 20, y: 20 });
      expect(await browser.evaluate("s-input", "window.hits")).toBe("[]");
      await browser.input("s-input", { type: "mouse", action: "move", x: 200, y: 200 });
      await browser.input("s-input", { type: "mouse", action: "down", x: 200, y: 200, button: "left", clickCount: 1 });
      await browser.input("s-input", { type: "mouse", action: "up", x: 200, y: 200, button: "left", clickCount: 1 });
      expect(await browser.evaluate("s-input", "window.hits")).toBe('[{"x":200,"y":200}]');
    }, 30_000);

    test("text and key events edit a focused field (Backspace needs its key code)", async () => {
      await browser.open("s-input", `${base}/pad`);
      await browser.evaluate("s-input", "document.getElementById('field').focus()");
      await browser.input("s-input", { type: "text", text: "hello" });
      await browser.input("s-input", { type: "key", action: "down", key: "Backspace", code: "Backspace" });
      await browser.input("s-input", { type: "key", action: "up", key: "Backspace", code: "Backspace" });
      await browser.input("s-input", { type: "key", action: "down", key: "!", code: "Digit1", text: "!", modifiers: 8 });
      await browser.input("s-input", { type: "key", action: "up", key: "!", code: "Digit1", modifiers: 8 });
      expect(await browser.evaluate("s-input", "document.getElementById('field').value")).toBe('"hell!"');
    }, 30_000);

    test("keys the page doesn't handle reach it once, not in an endless redispatch loop", async () => {
      // With a nativeVirtualKeyCode, macOS Chrome redispatched every unhandled key (Shift,
      // Escape, Meta…) back to the page forever, pegging the CPU and stalling every command.
      await browser.open("s-input", `${base}/pad`);
      await browser.evaluate(
        "s-input",
        "document.getElementById('field').focus(); window.downs = []; addEventListener('keydown', (e) => downs.push(e.key))",
      );
      const press = async (key: string, code: string, modifiers = 0) => {
        await browser.input("s-input", { type: "key", action: "down", key, code, modifiers });
        await browser.input("s-input", { type: "key", action: "up", key, code, modifiers: 0 });
      };
      await press("Shift", "ShiftLeft", 8);
      await press("Meta", "MetaLeft", 4);
      await press("Alt", "AltLeft", 1);
      await press("Escape", "Escape");
      await press("F5", "F5");
      await Bun.sleep(300);
      expect(await browser.evaluate("s-input", "window.downs")).toBe('["Shift","Meta","Alt","Escape","F5"]');
    }, 30_000);

    test("arrow keys and ⌘A editing still work", async () => {
      await browser.open("s-input", `${base}/pad`);
      await browser.evaluate("s-input", "document.getElementById('field').focus()");
      const field = () => browser.evaluate("s-input", "document.getElementById('field').value");
      const press = async (key: string, code: string, modifiers = 0, text?: string) => {
        await browser.input("s-input", { type: "key", action: "down", key, code, modifiers, ...(text ? { text } : {}) });
        await browser.input("s-input", { type: "key", action: "up", key, code, modifiers });
      };
      await browser.input("s-input", { type: "text", text: "hello" });
      await press("ArrowLeft", "ArrowLeft");
      await press("ArrowLeft", "ArrowLeft");
      await press("X", "KeyX", 8, "X");
      expect(await field()).toBe('"helXlo"');
      if (process.platform === "darwin") {
        await press("a", "KeyA", 4);
        await press("Backspace", "Backspace");
        expect(await field()).toBe('""');
      }
    }, 30_000);

    test("navigate, back, forward and reload", async () => {
      await browser.open("s-nav", `${base}/`);
      await browser.input("s-nav", { type: "navigate", url: `127.0.0.1:${server.port}/page2` });
      await until(async () => (await browser.state("s-nav"))?.title === "Page Two", "navigate to page2");
      expect((await browser.state("s-nav"))?.url).toBe(`${base}/page2`); // http:// was prepended for loopback

      await browser.input("s-nav", { type: "back" });
      await until(async () => (await browser.state("s-nav"))?.title === "Home Page", "back to home");
      await browser.input("s-nav", { type: "forward" });
      await until(async () => (await browser.state("s-nav"))?.title === "Page Two", "forward to page2");

      await until(async () => !(await browser.state("s-nav"))?.loading, "load finished");
      await browser.evaluate("s-nav", "window.marker = 1");
      await browser.input("s-nav", { type: "reload" });
      await until(async () => (await browser.evaluate("s-nav", "window.marker").catch(() => "1")) === "undefined", "reload clears JS state");
    }, 30_000);

    test("the width × height inputs change the viewport", async () => {
      await browser.open("s-resize", `${base}/`);
      await browser.input("s-resize", { type: "size", width: 800, height: 600 });
      expect(await browser.evaluate("s-resize", "[innerWidth, innerHeight]")).toBe("[800,600]");
      const png = Buffer.from(await browser.screenshot("s-resize"), "base64");
      expect(png.readUInt32BE(16)).toBe(800);
    }, 30_000);
  });

  describe("sizes", () => {
    const state = (states: BrowserState[]) => states.at(-1)!;

    test("Mobile is touch with an iPhone user agent, which the server sees too; Desktop puts it all back", async () => {
      await browser.open("z-mobile", `${base}/touch`);
      const desktopUa = JSON.parse(await browser.evaluate("z-mobile", "navigator.userAgent")) as string;
      await browser.input("z-mobile", { type: "device", device: "mobile" });
      await until(async () => (await browser.evaluate("z-mobile", "innerWidth").catch(() => "")) === "393", "the tab to be mobile");
      await until(async () => !(await browser.state("z-mobile"))?.loading, "the reload");
      expect(await browser.evaluate("z-mobile", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0, matchMedia('(pointer: coarse)').matches, 'ontouchstart' in window]")).toBe(
        "[393,852,true,true,true]",
      );
      expect(JSON.parse(await browser.evaluate("z-mobile", "navigator.userAgent"))).toMatch(/iPhone.*Mobile.*Safari/);
      // An agent's click arrives as a tap: touches, then the click a phone makes of them.
      await browser.click("z-mobile", "#tap");
      expect(JSON.parse(await browser.evaluate("z-mobile", "window.seen"))).toEqual(["touchstart", "touchend", "mousedown", "click"]);
      // So does a viewer's press and release; hover isn't sent at all.
      await browser.evaluate("z-mobile", "window.seen = []");
      for (const action of ["move", "down", "up"] as const) await browser.input("z-mobile", { type: "mouse", action, x: 50, y: 30, button: "left" });
      await until(async () => (await browser.evaluate("z-mobile", "window.seen.join()")) === '"touchstart,touchend,mousedown,click"', "the viewer's tap");
      // The server gets the iPhone user agent from the reload the button does.
      uaHits.length = 0;
      await browser.open("z-mobile", `${base}/ua`);
      expect(uaHits.at(-1)).toMatch(/iPhone/);

      await browser.input("z-mobile", { type: "device", device: "desktop" });
      await until(async () => (await browser.evaluate("z-mobile", "innerWidth").catch(() => "")) === "1280", "the tab to be desktop");
      await until(async () => uaHits.length >= 2 && !(await browser.state("z-mobile"))?.loading, "the reload");
      expect(uaHits.at(-1)).toBe(desktopUa);
      expect(await browser.evaluate("z-mobile", "[innerHeight, navigator.maxTouchPoints, matchMedia('(pointer: coarse)').matches, navigator.userAgent === " + JSON.stringify(desktopUa) + "]")).toBe(
        "[800,0,false,true]",
      );
      await browser.close("z-mobile");
    }, 30_000);

    test("pressing the selected button still resets and reloads; the inputs resize without one, keeping the mode", async () => {
      await browser.open("z-reset", `${base}/page2`);
      await browser.input("z-reset", { type: "device", device: "mobile" });
      await until(async () => (await browser.evaluate("z-reset", "innerWidth").catch(() => "")) === "393", "mobile");
      await until(async () => !(await browser.state("z-reset"))?.loading, "the reload");
      // A tablet: touch at 1280×800, with no reload (the marker survives).
      await browser.evaluate("z-reset", "window.marker = 1");
      await browser.input("z-reset", { type: "size", width: 1280, height: 800 });
      expect(await browser.evaluate("z-reset", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0, window.marker]")).toBe("[1280,800,true,1]");
      expect((await browser.state("z-reset"))?.size).toEqual({ device: "mobile", width: 1280, height: 800, responsive: false });
      // Mobile again: back to the phone size, and the page reloads (the marker is gone).
      await browser.input("z-reset", { type: "device", device: "mobile" });
      await until(async () => (await browser.evaluate("z-reset", "String(window.marker)").catch(() => "")) === '"undefined"', "the reload");
      expect(await browser.evaluate("z-reset", "[innerWidth, innerHeight]")).toBe("[393,852]");
      // Sizes are clamped, and junk is ignored.
      await browser.input("z-reset", { type: "size", width: 20, height: 99_999 });
      expect((await browser.state("z-reset"))?.size).toMatchObject({ width: 100, height: 4096 });
      await browser.input("z-reset", { type: "size", width: Number.NaN, height: 500 });
      expect((await browser.state("z-reset"))?.size).toMatchObject({ width: 100, height: 500 });
      // A mode the protocol doesn't have is refused and changes nothing.
      await expect(browser.input("z-reset", { type: "device", device: "tablet" as "mobile" })).rejects.toThrow(/Unknown browser device/);
      expect((await browser.state("z-reset"))?.size).toEqual({ device: "mobile", width: 100, height: 500, responsive: false });
      await browser.close("z-reset");
    }, 30_000);

    test("a new tab follows a viewer's pane; only that viewer's resizes count, and the last to switch Responsive on wins", async () => {
      await browser.open("z-resp", `${base}/page2`);
      // No viewer: it keeps the desktop size.
      expect((await browser.state("z-resp"))?.size).toEqual({ device: "desktop", width: 1280, height: 800, responsive: true });
      expect((await browser.tabInfo("z-resp", 1)).following).toBe(false);
      const a: BrowserState[] = [];
      const b: BrowserState[] = [];
      await browser.subscribe("z-resp", "a", () => {}, (s) => a.push(s));
      expect(state(a).sizeOwner).toBe(true);
      expect((await browser.tabInfo("z-resp", 1)).following).toBe(true);
      await browser.input("z-resp", { type: "resize", width: 600, height: 400 }, { subscriberId: "a" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[600,400]");
      // A second pane opening resizes nothing: the tab already follows a.
      await browser.subscribe("z-resp", "b", () => {}, (s) => b.push(s));
      await browser.input("z-resp", { type: "resize", width: 300, height: 300 }, { subscriberId: "b" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[600,400]");
      expect([state(a).sizeOwner, state(b).sizeOwner]).toEqual([true, false]);
      // Mobile switches it off: the phone size stays whatever the panes do.
      await browser.input("z-resp", { type: "device", device: "mobile" }, { subscriberId: "a" });
      await until(async () => (await browser.evaluate("z-resp", "innerWidth").catch(() => "")) === "393", "mobile");
      await browser.input("z-resp", { type: "resize", width: 640, height: 480 }, { subscriberId: "a" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[393,852]");
      expect([state(a).sizeOwner, state(b).sizeOwner]).toEqual([false, false]);
      // a switches it on again: it follows a's pane and stays touch.
      await browser.input("z-resp", { type: "responsive", on: true, width: 700, height: 500 }, { subscriberId: "a" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0]")).toBe("[700,500,true]");
      expect(state(b).size).toEqual({ device: "mobile", width: 700, height: 500, responsive: true });
      // b takes over: a's pane stops counting.
      await browser.input("z-resp", { type: "responsive", on: true, width: 900, height: 600 }, { subscriberId: "b" });
      await browser.input("z-resp", { type: "resize", width: 640, height: 480 }, { subscriberId: "a" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[900,600]");
      expect([state(a).sizeOwner, state(b).sizeOwner]).toEqual([false, true]);
      // The inputs switch it off.
      await browser.input("z-resp", { type: "size", width: 1000, height: 700 }, { subscriberId: "a" });
      expect(state(b)).toMatchObject({ size: { device: "mobile", width: 1000, height: 700, responsive: false }, sizeOwner: false });
      await browser.input("z-resp", { type: "resize", width: 640, height: 480 }, { subscriberId: "b" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[1000,700]");
      // The owner leaving hands the tab to the viewer still on it.
      await browser.input("z-resp", { type: "responsive", on: true, width: 800, height: 520 }, { subscriberId: "b" });
      await browser.unsubscribe("z-resp", "b");
      expect(state(a)).toMatchObject({ size: { width: 800, height: 520, responsive: true }, sizeOwner: true });
      await browser.input("z-resp", { type: "resize", width: 810, height: 530 }, { subscriberId: "a" });
      expect(await browser.evaluate("z-resp", "[innerWidth, innerHeight]")).toBe("[810,530]");
      // With nobody left on it, it keeps its size (and stays Responsive for the next viewer).
      await browser.open("z-resp", `${base}/page2`, { newTab: true });
      await browser.subscribe("z-resp", "a", () => {}, (s) => a.push(s), { tab: 2 });
      expect((await browser.state("z-resp", { tab: 1 }))?.size).toEqual({ device: "mobile", width: 810, height: 530, responsive: true });
      expect(state(a)).toMatchObject({ tabId: 2, sizeOwner: true });
      // Without a viewer there's no pane to follow.
      await expect(browser.input("z-resp", { type: "responsive", on: true }, { tab: 1 })).rejects.toThrow(/viewer/);
      await browser.unsubscribe("z-resp", "a");
      await browser.close("z-resp");
    }, 30_000);

    test("an agent's size: open loads straight into it, resize changes one tab and ends a viewer's Responsive", async () => {
      uaHits.length = 0;
      await browser.open("z-agent", `${base}/ua`, { size: { device: "mobile" } });
      // One load, already as an iPhone at the phone size.
      expect(uaHits).toHaveLength(1);
      expect(uaHits[0]).toMatch(/iPhone/);
      expect(await browser.evaluate("z-agent", "innerWidth")).toBe("393");
      await browser.open("z-agent", `${base}/page2`, { newTab: true });
      const states: BrowserState[] = [];
      await browser.subscribe("z-agent", "v", () => {}, (s) => states.push(s), { tab: 2 });
      await browser.input("z-agent", { type: "responsive", on: true, width: 700, height: 500 }, { subscriberId: "v" });
      const st = await browser.resize("z-agent", { device: "mobile", width: 1024, height: 1366 }, { tab: 2 });
      expect(st.size).toEqual({ device: "mobile", width: 1024, height: 1366, responsive: false });
      expect(states.at(-1)?.sizeOwner).toBe(false);
      expect(await browser.evaluate("z-agent", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0]", { tab: 2 })).toBe("[1024,1366,true]");
      // Width alone keeps the mode and the height.
      await browser.resize("z-agent", { width: 800 }, { tab: 2 });
      expect((await browser.state("z-agent", { tab: 2 }))?.size).toEqual({ device: "mobile", width: 800, height: 1366, responsive: false });
      expect((await browser.state("z-agent", { tab: 1 }))?.size).toEqual({ device: "mobile", width: 393, height: 852, responsive: false });
      await browser.unsubscribe("z-agent", "v");
      await browser.close("z-agent");
    }, 30_000);

    test("in Mobile a page without a viewport tag lays out at 980 wide and is shown shrunk, as on a phone", async () => {
      await browser.open("z-legacy", `${base}/legacy`, { size: { device: "mobile" } });
      expect(await browser.evaluate("z-legacy", "[innerWidth, screen.width]")).toBe("[980,393]");
      const shot = await browser.capture("z-legacy");
      expect([shot.width, shot.viewport.width]).toEqual([393, 980]);
      await browser.close("z-legacy");
    }, 30_000);

    test("a page a mobile tab opens is mobile too", async () => {
      await browser.open("z-pop", `${base}/popup`, { size: { device: "mobile" } });
      await browser.evaluate("z-pop", "document.getElementById('open').click()");
      await until(async () => (await browser.tabs("z-pop")).length === 2, "the popup's tab");
      await until(async () => (await browser.evaluate("z-pop", "innerWidth", { tab: 2 }).catch(() => "")) === "393", "the popup at the phone size");
      expect((await browser.tabs("z-pop"))[1]?.size).toEqual({ device: "mobile", width: 393, height: 852, responsive: false });
      await browser.close("z-pop");
    }, 30_000);

    test("tabInfo has the page's requests and console since it last navigated; counts show in the list", async () => {
      await browser.open("z-info", `${base}/noisy`);
      const info = (await until(async () => {
        const i = await browser.tabInfo("z-info", 1);
        return i.console.length >= 3 && i.requests.filter((r) => r.status !== undefined || r.failure).length >= 3 ? i : null;
      }, "the noisy page's requests and messages"))!;
      expect(info).toMatchObject({ id: 1, url: `${base}/noisy`, title: "Noisy", loading: false, size: { device: "desktop", width: 1280, height: 800 }, scroll: { x: 0, y: 0 } });
      const byUrl = (u: string) => info.requests.find((r) => r.url === u);
      expect(byUrl(`${base}/noisy`)).toMatchObject({ method: "GET", type: "Document", status: 200 });
      expect(byUrl(`${base}/missing`)).toMatchObject({ type: "Fetch", status: 404 });
      expect(byUrl("http://127.0.0.1:1/refused")?.failure).toMatch(/ERR_/);
      expect(info.console.map((c) => [c.level, c.text])).toEqual([
        ["error", "boom Object"],
        ["warning", "careful"],
        ["error", expect.stringContaining("late failure")],
      ]);
      expect(info.console[0]?.source).toBe(`${base}/noisy:2`);
      const [listed] = await browser.tabs("z-info");
      expect([listed?.failedRequests, listed?.consoleErrors]).toEqual([2, 3]);
      // A new page starts both over.
      await browser.open("z-info", `${base}/page2`);
      const after = await browser.tabInfo("z-info", 1);
      expect(after.console).toEqual([]);
      expect(after.requests.map((r) => r.url)).toEqual([`${base}/page2`]);
      await expect(browser.tabInfo("z-info", 9)).rejects.toThrow(/No browser tab 9/);
      await browser.close("z-info");
    }, 30_000);
  });

  test("relaunches Chrome on next use after a crash", async () => {
    await browser.open("s-crash", `${base}/`);
    const pid = browser.chromePid!;
    // SIGKILL means Chrome can't delete its ~2 GB code-sign clone; we must, and only that one.
    const clone = browser.chromeCloneDir;
    expect(isAlive(pid)).toBe(true);
    try {
      process.kill(pid, "SIGKILL");
      await until(() => !isAlive(pid), "chrome to die");
      // The tab outlives Chrome: suspended on its page, which reloads on the next call.
      await until(async () => (await browser.state("s-crash"))?.suspended === true, "the tab to be suspended");
      expect(await browser.state("s-crash")).toMatchObject({ tabId: 1, url: `${base}/`, title: "Home Page", suspended: true });
      if (clone) await until(() => !existsSync(clone), "the killed Chrome's clone to be removed", 10_000);

      expect(await browser.content("s-crash", { selector: "h1" })).toBe("Welcome home");
      expect(browser.chromePid).not.toBe(pid);
      const state = await browser.open("s-crash", `${base}/page2`);
      expect(state).toMatchObject({ tabId: 1, title: "Page Two" });
      expect(browser.chromePid).not.toBe(pid);
    } finally {
      if (clone && existsSync(clone)) rmSync(clone, { recursive: true, force: true });
    }
  }, 30_000);
});

/** An in-memory BrowserTabStore (the database's browser_tabs), so a test can play a restart. */
function memoryTabStore() {
  const rows = new Map<string, StoredBrowserTabs>();
  return {
    rows,
    load: (id: string) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    save: (id: string, state: StoredBrowserTabs) => void rows.set(id, structuredClone(state)),
    delete: (id: string) => void rows.delete(id),
  };
}

/** URLs of the page targets Chrome itself reports (its DevTools /json/list), not our bookkeeping. */
async function chromePages(browser: BrowserManager): Promise<string[]> {
  const chrome = (browser as any).browser?.chrome;
  if (!chrome) return [];
  const res = await fetch(`http://${new URL(chrome.wsUrl).host}/json/list`);
  const targets = (await res.json()) as { type: string; url: string }[];
  return targets.filter((t) => t.type === "page").map((t) => t.url);
}

const ids = (tabs: { id: number; suspended?: boolean }[]) => tabs.map((t) => (t.suspended ? `${t.id}z` : `${t.id}`));

withChrome("BrowserManager tab lifecycle (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;
  let browser: BrowserManager;
  let store: ReturnType<typeof memoryTabStore>;
  let clock = 1_000_000;
  let idleMs = 60_000;

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
    store = memoryTabStore();
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, idleTabMs: () => idleMs, now: () => clock, tabStore: store });
  });

  afterAll(async () => {
    await browser?.shutdown();
    void server?.stop(true);
  });

  const pages = () => chromePages(browser);

  test("suspendTabs closes every page in Chrome but keeps the tabs, which reload when used", async () => {
    await browser.open("lc-done", `${base}/popup?lc-done`);
    await browser.open("lc-done", `${base}/page2?lc-done`, { newTab: true });
    await browser.click("lc-done", "#open"); // window.open: a popup becomes tab 3
    await until(async () => (await browser.tabs("lc-done")).length === 3, "the popup's tab");
    await browser.open("lc-other", `${base}/?lc-other`);
    await browser.evaluate("lc-done", "window.mine = 'old'");
    await until(async () => (await pages()).some((u) => u.endsWith("/form")), "the popup in Chrome");

    await browser.suspendTabs("lc-done");

    await until(async () => !(await pages()).some((u) => u.includes("lc-done") || u.endsWith("/form")), "the session's pages to leave Chrome");
    expect(await pages()).toContain(`${base}/?lc-other`);
    const tabs = await browser.tabs("lc-done");
    expect(tabs.map((t) => [t.id, t.url, t.title, t.suspended])).toEqual([
      [1, `${base}/popup?lc-done`, "Popup", true],
      [2, `${base}/page2?lc-done`, "Page Two", true],
      [3, `${base}/form`, "Form", true],
    ]);
    expect(await browser.state("lc-done", { tab: 2 })).toMatchObject({ tabId: 2, url: `${base}/page2?lc-done`, suspended: true });
    await until(() => store.rows.get("lc-done")?.tabs.length === 3, "the tabs to be stored");
    expect(store.rows.get("lc-done")!.nextTabId).toBe(4);

    // A call reopens the tab it needs on its own URL, with a fresh page; the others stay suspended.
    expect(await browser.content("lc-done", { selector: "h1", tab: 2 })).toBe("Second page");
    expect(await browser.evaluate("lc-done", "window.mine")).toBe("undefined"); // tab 1, reopened
    expect(ids(await browser.tabs("lc-done"))).toEqual(["1", "2", "3z"]);
    expect((await browser.open("lc-done", `${base}/?lc-done-new`, { newTab: true })).tabId).toBe(4);
  }, 30_000);

  test("the stored URL follows the page: links, in-page navigation and title changes", async () => {
    await browser.open("lc-nav", `${base}/links?lc-nav`);
    // Let the tab's first write land, so what follows has to be written by the navigation itself.
    await until(() => store.rows.get("lc-nav")?.tabs[0]?.title === "Links", "the first write");
    await Bun.sleep(300);
    await browser.click("lc-nav", "#go"); // a same-tab link
    await until(async () => (await browser.state("lc-nav"))?.title === "Page Two", "the link to load");
    await browser.evaluate("lc-nav", "history.pushState({}, '', '/page2?moved#here'); document.title = 'Renamed'");
    await until(() => store.rows.get("lc-nav")?.tabs[0]?.url === `${base}/page2?moved#here` && store.rows.get("lc-nav")?.tabs[0]?.title === "Renamed", "the store to follow");
    await browser.suspendTabs("lc-nav");
    expect(await browser.state("lc-nav")).toMatchObject({ url: `${base}/page2?moved#here`, suspended: true });
    // Coming back lands where the user was, not where the tab started.
    expect(await browser.content("lc-nav", { selector: "h1" })).toBe("Second page");
    expect((await browser.state("lc-nav"))?.url).toBe(`${base}/page2?moved#here`);
  }, 30_000);

  test("a done ticket's watched tab keeps its page until the viewer leaves; an agent call un-retires it", async () => {
    await browser.open("lc-view", `${base}/?lc-view-1`);
    await browser.open("lc-view", `${base}/page2?lc-view-2`, { newTab: true });
    const states: BrowserState[] = [];
    await browser.subscribe("lc-view", "v", () => {}, (s) => states.push(s), { tab: 2 });
    await browser.suspendTabs("lc-view");
    expect(ids(await browser.tabs("lc-view"))).toEqual(["1z", "2"]);
    await until(() => states.at(-1)?.tabs?.find((t) => t.id === 1)?.suspended === true, "the viewer told tab 1 is suspended");
    await browser.unsubscribe("lc-view", "v");
    await until(async () => ids(await browser.tabs("lc-view")).join() === "1z,2z", "tab 2 suspended once nobody watches");
    await until(async () => !(await pages()).some((u) => u.includes("lc-view")), "both pages out of Chrome");

    // Re-opened: an agent uses it, so a viewer leaving no longer suspends anything.
    await browser.content("lc-view", { tab: 2 });
    await browser.subscribe("lc-view", "w", () => {}, () => {}, { tab: 2 });
    await browser.unsubscribe("lc-view", "w");
    await Bun.sleep(100);
    expect(ids(await browser.tabs("lc-view"))).toEqual(["1z", "2"]);
  }, 30_000);

  test("watching a suspended tab reopens it on its URL and streams it", async () => {
    await browser.open("lc-watch", `${base}/anim?lc-watch`);
    await browser.suspendTabs("lc-watch");
    expect(ids(await browser.tabs("lc-watch"))).toEqual(["1z"]);
    const frames: BrowserFrame[] = [];
    const states: BrowserState[] = [];
    await browser.subscribe("lc-watch", "v", (f) => frames.push(f), (s) => states.push(s));
    await until(() => frames.length >= 2, "frames from the reopened tab");
    await until(() => states.at(-1)?.title === "Anim" && !states.at(-1)?.suspended, "a live state");
    expect(states.at(-1)?.url).toBe(`${base}/anim?lc-watch`);
    await browser.unsubscribe("lc-watch", "v");
  }, 30_000);

  test("closing a tab removes it for good, suspended or not", async () => {
    await browser.open("lc-close", `${base}/?lc-close-1`);
    await browser.open("lc-close", `${base}/page2?lc-close-2`, { newTab: true });
    await browser.suspendTabs("lc-close");
    await browser.closeTab("lc-close", 1);
    expect(ids(await browser.tabs("lc-close"))).toEqual(["2z"]);
    await until(() => store.rows.get("lc-close")?.tabs.map((t) => t.id).join() === "2", "the store to drop tab 1");
    await expect(browser.content("lc-close", { tab: 1 })).rejects.toThrow("No browser tab 1. Open tabs: 2.");
    await browser.close("lc-close");
    expect(await browser.tabs("lc-close")).toEqual([]);
    expect(store.rows.has("lc-close")).toBe(false);
  }, 30_000);

  test("suspendTabs also closes the page of a tab that was still being created", async () => {
    const opening = browser.open("lc-race", `${base}/?lc-race`).catch((e) => e);
    await browser.suspendTabs("lc-race");
    await opening;
    await until(async () => !(await pages()).some((u) => u.includes("lc-race")), "the half-made page to leave Chrome");
    expect((await browser.tabs("lc-race")).every((t) => t.suspended)).toBe(true);
  }, 30_000);

  test("idle tabs nobody watches are suspended; use and watching keep them; 0 turns it off", async () => {
    idleMs = 60_000;
    await browser.open("lc-idle", `${base}/?lc-idle-1`);
    await browser.open("lc-idle", `${base}/page2?lc-idle-2`, { newTab: true });
    await browser.open("lc-busy", `${base}/?lc-busy`);
    await browser.open("lc-input", `${base}/?lc-input`);
    await browser.open("lc-watch2", `${base}/?lc-watch2`);
    await browser.subscribe("lc-watch2", "w", () => {}, () => {});
    clock += 59_000;
    await browser.content("lc-busy"); // used just before the deadline
    await browser.input("lc-input", { type: "mouse", action: "move", x: 1, y: 1 });
    expect(await browser.reapIdleTabs()).toBe(0); // nothing is a full minute idle yet

    clock += 1_000;
    await browser.reapIdleTabs(); // every other test's tabs here are idle too; only these matter
    expect(ids(await browser.tabs("lc-idle"))).toEqual(["1z", "2z"]);
    await until(async () => !(await pages()).some((u) => u.includes("lc-idle")), "the idle pages to leave Chrome");
    expect(ids(await browser.tabs("lc-busy"))).toEqual(["1"]);
    expect(ids(await browser.tabs("lc-input"))).toEqual(["1"]);
    expect(ids(await browser.tabs("lc-watch2"))).toEqual(["1"]);

    // A watched tab is never idle; once the viewer leaves, it gets a full idle period from then.
    clock += 600_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-watch2"))).toEqual(["1"]);
    expect(ids(await browser.tabs("lc-busy"))).toEqual(["1z"]);
    await browser.unsubscribe("lc-watch2", "w");
    clock += 59_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-watch2"))).toEqual(["1"]);
    clock += 1_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-watch2"))).toEqual(["1z"]);

    // 0 means never; the setting is read on every sweep.
    await browser.open("lc-off", `${base}/?lc-off`);
    idleMs = 0;
    clock += 3_600_000;
    expect(await browser.reapIdleTabs()).toBe(0);
    expect(ids(await browser.tabs("lc-off"))).toEqual(["1"]);
    idleMs = 60_000;
    expect(await browser.reapIdleTabs()).toBeGreaterThan(0);
    expect(ids(await browser.tabs("lc-off"))).toEqual(["1z"]);
  }, 30_000);

  test("only the watched tab of a session keeps its page through the reaper", async () => {
    idleMs = 60_000;
    await browser.open("lc-two", `${base}/?lc-two-1`);
    await browser.open("lc-two", `${base}/page2?lc-two-2`, { newTab: true });
    await browser.subscribe("lc-two", "w", () => {}, () => {}, { tab: 2 });
    clock += 120_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-two"))).toEqual(["1z", "2"]);
    // Switching the viewer to a new tab starts tab 2's idle time at the switch (not the last sweep).
    clock += 30_000;
    await browser.input("lc-two", { type: "newTab" }, { subscriberId: "w" });
    clock += 59_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-two"))).toEqual(["1z", "2", "3"]);
    clock += 1_000;
    await browser.reapIdleTabs();
    expect(ids(await browser.tabs("lc-two"))).toEqual(["1z", "2z", "3"]);
    await browser.unsubscribe("lc-two", "w");
  }, 30_000);
});

withChrome("BrowserManager restarts and stopping Chrome (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => void server?.stop(true));

  test("tabs survive a restart from the store: listed suspended, reopened where they were, numbering carries on", async () => {
    const store = memoryTabStore();
    const first = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: store });
    try {
      await first.open("rs", `${base}/?rs-1`);
      await first.open("rs", `${base}/links?rs-2`, { newTab: true });
      await first.click("rs", "#go", { tab: 2 });
      await until(async () => (await first.state("rs", { tab: 2 }))?.title === "Page Two", "tab 2's link");
      await until(() => store.rows.get("rs")?.tabs[1]?.title === "Page Two", "the link written");
      // Changed right before stopping: only the flush on shutdown can write it.
      await first.evaluate("rs", "document.title = 'Last words'", { tab: 1 });
      await until(async () => (await first.tabs("rs"))[0]?.title === "Last words", "the new title");
      // A tablet-sized touch tab: its mode and size come back after the restart.
      await first.resize("rs", { device: "mobile", width: 1024, height: 1366 }, { tab: 2 });
    } finally {
      await first.shutdown(); // flushes the store
    }
    expect(store.rows.get("rs")).toEqual({
      nextTabId: 3,
      tabs: [
        { id: 1, url: `${base}/?rs-1`, title: "Last words", size: { device: "desktop", width: 1280, height: 800, responsive: true } },
        { id: 2, url: `${base}/page2`, title: "Page Two", size: { device: "mobile", width: 1024, height: 1366, responsive: false } },
      ],
    });

    const second = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: store });
    try {
      expect(await second.tabs("rs")).toEqual([
        { id: 1, url: `${base}/?rs-1`, title: "Last words", loading: false, suspended: true, size: { device: "desktop", width: 1280, height: 800, responsive: true } },
        { id: 2, url: `${base}/page2`, title: "Page Two", loading: false, suspended: true, size: { device: "mobile", width: 1024, height: 1366, responsive: false } },
      ]);
      expect(second.chromePid).toBeUndefined(); // listing them didn't start Chrome
      expect(await second.content("rs", { selector: "h1", tab: 2 })).toBe("Second page");
      expect(await second.evaluate("rs", "[innerWidth, innerHeight, navigator.maxTouchPoints > 0, /iPhone/.test(navigator.userAgent)]", { tab: 2 })).toBe("[1024,1366,true,true]");
      expect((await second.open("rs", `${base}/?rs-3`, { newTab: true })).tabId).toBe(3);
      expect(await second.tabs("nobody")).toEqual([]);
      expect(await second.state("nobody")).toBeNull();
    } finally {
      await second.shutdown();
    }
  }, 60_000);

  test("shutdown with a viewer watching leaves Chrome stopped (the watched tab isn't reopened)", async () => {
    const store = memoryTabStore();
    const service = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: store });
    await service.open("sd", `${base}/?sd`);
    await service.subscribe("sd", "viewer", () => {}, () => {});
    const pid = service.chromePid!;
    await service.shutdown();
    await Bun.sleep(500);
    expect(isAlive(pid)).toBe(false);
    expect(service.chromePid).toBeUndefined();
    expect(store.rows.get("sd")?.tabs).toEqual([{ id: 1, url: `${base}/?sd`, title: "Home Page", size: { device: "desktop", width: 1280, height: 800, responsive: true } }]);
  }, 60_000);

  test("restartBrowser keeps every tab: each reloads its URL in the new Chrome, a watched one at once", async () => {
    const service = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: memoryTabStore() });
    try {
      await service.open("rb", `${base}/?rb-1`);
      await service.open("rb", `${base}/page2?rb-2`, { newTab: true });
      await service.subscribe("rb", "viewer", () => {}, () => {}, { tab: 1 });
      const pid = service.chromePid!;
      await service.restartBrowser();
      expect(service.chromePid).toBeDefined();
      expect(service.chromePid).not.toBe(pid);
      expect(isAlive(pid)).toBe(false);
      // The watched tab came back with its page; the other waits, suspended, until it's used.
      await until(async () => {
        const first = (await service.tabs("rb"))[0];
        return !!first && !first.suspended && first.url === `${base}/?rb-1`;
      }, "the watched tab reopening at its URL", 10_000);
      expect((await service.tabs("rb")).map((t) => [t.id, t.url, !!t.suspended])).toEqual([
        [1, `${base}/?rb-1`, false],
        [2, `${base}/page2?rb-2`, true],
      ]);
      expect(await service.content("rb", { selector: "h1", tab: 2 })).toBe("Second page");
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  test("Chrome stops once no tab has a page, and the next call relaunches it", async () => {
    const service = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: memoryTabStore() });
    try {
      await service.open("st", `${base}/?st`);
      expect(await service.stopChromeIfIdle()).toBe(false); // a live page
      const pid = service.chromePid!;
      await service.suspendTabs("st");
      expect(await service.stopChromeIfIdle()).toBe(true);
      expect(isAlive(pid)).toBe(false);
      expect(service.chromePid).toBeUndefined();
      expect(ids(await service.tabs("st"))).toEqual(["1z"]);
      expect(await service.stopChromeIfIdle()).toBe(false); // nothing to stop

      expect(await service.content("st", { selector: "h1" })).toBe("Welcome home");
      expect(service.chromePid).toBeDefined();
      expect(service.chromePid).not.toBe(pid);
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});

withChrome("BrowserManager extensions (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => void server?.stop(true));

  /** An unpacked extension: a content script that marks every page, and a toolbar popup. */
  function unpackedExtension(): string {
    const dir = tempDir("harness-ext-src-");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Harness test extension",
        version: "1.2.3",
        action: { default_popup: "popup.html" },
        content_scripts: [{ matches: ["<all_urls>"], js: ["mark.js"], run_at: "document_start" }],
      }),
    );
    writeFileSync(join(dir, "mark.js"), `document.documentElement.dataset.harnessExt = "ran";`);
    writeFileSync(join(dir, "popup.html"), `<!doctype html><title>Ext popup</title><h1 id="pop">Popup body</h1>`);
    return dir;
  }

  const marked = async (service: BrowserManager, session: string, tab?: number) =>
    JSON.parse(await service.evaluate(session, "document.documentElement.dataset.harnessExt ?? 'none'", { tab }));
  const mine = async (service: BrowserManager) => (await service.extensions()).extensions.filter((e) => e.source !== "chrome");

  // A Chrome enrolled in cloud management fetches its policy a few seconds after a new profile's
  // first launch, and loads unpacked extensions until then. Let it fetch (and cache) the policy
  // first, so the test sees what an established profile does.
  async function settlePolicy() {
    if (!existsSync("/Library/Managed Preferences/com.google.Chrome.plist")) return;
    const warm = new BrowserManager({ profileDir, chromePath: chromePath!, tabStore: memoryTabStore() });
    try {
      await warm.open("warm", "about:blank");
      const cached = join(profileDir, "Policy", "Machine Level User Cloud Policy");
      const deadline = Date.now() + 20_000;
      while (!existsSync(cached) && Date.now() < deadline) await Bun.sleep(250);
    } finally {
      await warm.shutdown();
    }
  }

  // On a computer whose Chrome policy doesn't allow unpacked extensions (a managed Mac), the test
  // checks the refusal; elsewhere it checks everything else.
  test("an unpacked extension loads, runs, opens its popup as a tab, comes back after a restart, turns off and is removed — or is refused by policy, leaving nothing behind", async () => {
    await settlePolicy();
    const extensionsDir = tempDir("harness-ext-");
    const src = unpackedExtension();
    const opts = { profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: memoryTabStore(), extensionsDir };
    const first = new BrowserManager(opts);
    let id: string;
    try {
      let added;
      try {
        added = await first.addExtension({ path: src });
      } catch (e) {
        expect((e as { status?: number }).status).toBe(403);
        expect((e as Error).message).toContain("policy");
        expect(await mine(first)).toEqual([]);
        expect(existsSync(join(src, "manifest.json"))).toBe(true); // the user's folder stays
        await first.open("ex", `${base}/?refused`);
        expect(await marked(first, "ex")).toBe("none");
        console.warn("[browser tests] Chrome's policy refused the unpacked test extension; checked the refusal only.");
        return;
      }
      id = added.id;
      expect(added).toMatchObject({ name: "Harness test extension", version: "1.2.3", source: "unpacked", path: src, enabled: true, status: "loaded", hasAction: true });
      await first.open("ex", `${base}/?ext`);
      expect(await marked(first, "ex")).toBe("ran");

      const { tab } = await first.runExtensionAction("ex", id);
      expect(tab).toBe(2);
      expect(await first.content("ex", { selector: "#pop", tab: 2 })).toBe("Popup body");
      expect((await first.tabs("ex")).map((t) => t.url)).toEqual([`${base}/?ext`, `chrome-extension://${id}/popup.html`]);
    } finally {
      await first.shutdown();
    }

    // A new Chrome knows nothing of it: the registry loads it again.
    const second = new BrowserManager(opts);
    try {
      expect((await mine(second)).map((e) => [e.id, e.status])).toEqual([[id, "pending"]]); // until Chrome starts
      await second.open("ex2", `${base}/?again`);
      expect(await marked(second, "ex2")).toBe("ran");
      expect((await mine(second))[0]?.status).toBe("loaded");

      expect((await second.setExtensionEnabled(id, false)).status).toBe("off");
      await second.open("ex2", `${base}/?off`);
      expect(await marked(second, "ex2")).toBe("none");
      await expect(second.runExtensionAction("ex2", id)).rejects.toThrow(/turned off/);

      expect((await second.setExtensionEnabled(id, true)).status).toBe("loaded");
      await second.open("ex2", `${base}/?on`);
      expect(await marked(second, "ex2")).toBe("ran");

      await second.removeExtension(id);
      expect(await mine(second)).toEqual([]);
      expect(existsSync(join(src, "manifest.json"))).toBe(true); // an unpacked folder is the user's
      await second.open("ex2", `${base}/?removed`);
      expect(await marked(second, "ex2")).toBe("none");
    } finally {
      await second.shutdown();
    }
  }, 90_000);

  // Talks to the Chrome Web Store, so it runs only when asked: HARNESS_NETWORK_TESTS=1.
  (process.env.HARNESS_NETWORK_TESTS ? test : test.skip)(
    "a Web Store extension installs through Chrome, turns off and on, opens its popup on a page, and is uninstalled when Chrome restarts",
    async () => {
      await settlePolicy();
      const REACT = "fmkadmapgofadopljbjfkapdkoienihi";
      const service = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 20_000, tabStore: memoryTabStore(), extensionsDir: tempDir("harness-ext-") });
      try {
        // No tab has a page, so Chrome restarts at once to install it.
        const added = await service.addExtension({ webstore: `https://chromewebstore.google.com/detail/react-developer-tools/${REACT}` });
        expect(added).toMatchObject({ id: REACT, name: "React Developer Tools", source: "webstore", status: "loaded", hasAction: true });
        expect(existsSync(join(profileDir, "External Extensions", `${REACT}.json`))).toBe(true);
        await expect(service.addExtension({ webstore: REACT })).rejects.toThrow(/already installed/);

        expect((await service.setExtensionEnabled(REACT, false)).status).toBe("off");
        expect((await service.setExtensionEnabled(REACT, true)).status).toBe("loaded");

        await service.open("ws", "https://react.dev/");
        await Bun.sleep(2000); // its content script reports React to its service worker
        const { tab } = await service.runExtensionAction("ws", REACT);
        expect(tab).toBe(2);
        const popup = (await service.tabs("ws")).find((t) => t.id === 2)!;
        expect(popup.url).toStartWith(`chrome-extension://${REACT}/popups/`);
        expect(popup.size!.width).toBeLessThan(1280); // the popup's own size, not an emulated viewport

        // A blocked extension (an organization's allowlist) is refused before anything is installed.
        if (existsSync("/Library/Managed Preferences/com.google.Chrome.plist")) {
          await expect(service.addExtension({ webstore: "eimadpbcbfnmbkopoojfekhnkhdbieeh" })).rejects.toThrow(/policy/);
        }

        await service.removeExtension(REACT);
        expect((await service.extensions()).extensions.map((e) => e.id)).not.toContain(REACT);
        expect(existsSync(join(profileDir, "External Extensions", `${REACT}.json`))).toBe(false);
        await service.restartBrowser();
        await until(() => !existsSync(join(profileDir, "Default", "Extensions", REACT)), "Chrome uninstalling it", 15_000);
      } finally {
        await service.shutdown();
      }
    },
    120_000,
  );

  test("bad input is refused before Chrome starts", async () => {
    const service = new BrowserManager({ profileDir, chromePath: chromePath!, tabStore: memoryTabStore(), extensionsDir: tempDir("harness-ext-") });
    try {
      await expect(service.addExtension({ webstore: "https://example.com/not-the-store" })).rejects.toThrow(/isn't a Chrome Web Store link/);
      await expect(service.addExtension({ path: join(tempDir("harness-ext-empty-"), "nope") })).rejects.toThrow(/isn't a folder/);
      await expect(service.addExtension({ path: tempDir("harness-ext-empty-") })).rejects.toThrow(/no manifest.json/);
      await expect(service.setExtensionEnabled("a".repeat(32), true)).rejects.toThrow(/No extension/);
      await expect(service.removeExtension("a".repeat(32))).rejects.toThrow(/No extension/);
      expect(await service.extensions()).toEqual({ extensions: [], running: false });
      expect(service.chromePid).toBeUndefined();
      const without = new BrowserManager({ profileDir, chromePath: chromePath! });
      await expect(without.extensions()).rejects.toThrow(/doesn't support extensions/);
    } finally {
      await service.shutdown();
    }
  });
});

withChrome("createBrowserService shutdown", () => {
  test("shutdown closes Chrome gracefully: process gone, no code-sign clone left, later call relaunches", async () => {
    const cloneRoot = codeSignCloneRoot();
    if (!cloneRoot) console.warn("[browser tests] code_sign_clone dir not found; skipping clone-leak assertions.");
    const service = createBrowserService({ profileDir, chromePath: chromePath! }) as BrowserManager;
    try {
      expect(service.chromePid).toBeUndefined(); // lazy: nothing launched yet
      for (let round = 0; round < 2; round++) {
        await service.open("s", "about:blank");
        const pid = service.chromePid!;
        expect(isAlive(pid)).toBe(true);
        // Only this Chrome's own clone is checked: the clone root is shared with every other
        // Chrome on the machine (other test runs, the daemon), so its listing isn't ours to assert on.
        // Chrome 154+ deletes the clone itself shortly after startup; older versions keep it until exit.
        const clone = service.chromeCloneDir;
        if (clone) expect(dirname(clone)).toBe(cloneRoot!);
        await service.shutdown();
        expect(isAlive(pid)).toBe(false);
        expect(service.chromePid).toBeUndefined();
        expect(await service.state("s")).toBeNull();
        if (clone) expect(existsSync(clone)).toBe(false);
      }
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});
