import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
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

const html = (body: string, title = "Fixture") =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
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
    default:
      return new Response("not found", { status: 404 });
  }
}

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
      tabs: [{ id: 1, url: `${base}/`, title: "Home Page", loading: false }],
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

    test("resize applies to every tab, and to tabs opened later", async () => {
      await browser.open("t-size", `${base}/`);
      await browser.open("t-size", `${base}/`, { newTab: true });
      await browser.input("t-size", { type: "resize", width: 800, height: 600 });
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight]", { tab: 1 })).toBe("[800,600]");
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight]", { tab: 2 })).toBe("[800,600]");
      await browser.open("t-size", `${base}/`, { newTab: true });
      expect(await browser.evaluate("t-size", "[innerWidth, innerHeight]", { tab: 3 })).toBe("[800,600]");
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
      // Fire everything at once, like a viewer whose layout settles while it subscribes.
      await Promise.all([
        browser.subscribe("s-race", "v1", (f) => frames.push(f), () => {}),
        browser.input("s-race", { type: "resize", width: 900, height: 700 }),
        browser.input("s-race", { type: "resize", width: 1000, height: 650 }),
        browser.subscribe("s-race", "v2", (f) => late.push(f), () => {}),
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }),
      ]);
      const info = browser.screencastInfo("s-race")!;
      expect(info).toMatchObject({ active: true, width: 1024, height: 640 });

      // Frames keep flowing at the final size after the dust settles.
      frames.length = 0;
      await until(() => frames.filter((f) => f.width === 1024 && f.height === 640).length >= 3, "frames after resizes");
      expect(late.length).toBeGreaterThan(0);

      // Same size again (as viewers send on every layout pass): no restart.
      await Promise.all([
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }),
        browser.input("s-race", { type: "resize", width: 1024, height: 640 }),
      ]);
      expect(browser.screencastInfo("s-race")!.starts).toBe(info.starts);
      // A real change does restart, exactly once.
      await browser.input("s-race", { type: "resize", width: 800, height: 600 });
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

    test("resize changes the viewport", async () => {
      await browser.open("s-resize", `${base}/`);
      await browser.input("s-resize", { type: "resize", width: 800, height: 600 });
      expect(await browser.evaluate("s-resize", "[innerWidth, innerHeight]")).toBe("[800,600]");
      const png = Buffer.from(await browser.screenshot("s-resize"), "base64");
      expect(png.readUInt32BE(16)).toBe(800);
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
    } finally {
      await first.shutdown(); // flushes the store
    }
    expect(store.rows.get("rs")).toEqual({
      nextTabId: 3,
      tabs: [
        { id: 1, url: `${base}/?rs-1`, title: "Last words" },
        { id: 2, url: `${base}/page2`, title: "Page Two" },
      ],
    });

    const second = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: store });
    try {
      expect(await second.tabs("rs")).toEqual([
        { id: 1, url: `${base}/?rs-1`, title: "Last words", loading: false, suspended: true },
        { id: 2, url: `${base}/page2`, title: "Page Two", loading: false, suspended: true },
      ]);
      expect(second.chromePid).toBeUndefined(); // listing them didn't start Chrome
      expect(await second.content("rs", { selector: "h1", tab: 2 })).toBe("Second page");
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
    expect(store.rows.get("sd")?.tabs).toEqual([{ id: 1, url: `${base}/?sd`, title: "Home Page" }]);
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
