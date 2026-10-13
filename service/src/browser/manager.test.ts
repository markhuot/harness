import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { BrowserState } from "@harness/shared";
import { BrowserManager, normalizeUrl } from "./manager.ts";
import type { BrowserFrame } from "./types.ts";
import { chromePath, fixtures, html, LONG, profileDir, until, withChrome } from "./test-support.ts";

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

    test("full_page captures the whole page and selector one element, leaving the viewport alone", async () => {
      await browser.open("s-tall", `${base}/tall`);
      const dims = async (opts: Parameters<BrowserManager["screenshot"]>[1]) => {
        const png = Buffer.from(await browser.screenshot("s-tall", opts), "base64");
        return [png.readUInt32BE(16), png.readUInt32BE(20)] as const;
      };
      const [fullW, fullH] = await dims({ fullPage: true });
      expect(fullH).toBe(3000);
      expect(fullW).toBeGreaterThan(1200);
      expect(await dims({ selector: "#card" })).toEqual([300, 500]);
      // The element is found even when scrolled out of view, from wherever the page is scrolled.
      await browser.evaluate("s-tall", "window.scrollTo(0, 2600)");
      expect(await dims({ selector: "#top" })).toEqual([fullW, 2500]);
      expect(await dims({})).toEqual([1280, 800]);
      expect(await browser.evaluate("s-tall", "[innerWidth, innerHeight]")).toBe("[1280,800]");
      await expect(browser.screenshot("s-tall", { selector: "#nope" })).rejects.toThrow(/No element matches selector: #nope/);
      await expect(browser.screenshot("s-tall", { selector: "#empty" })).rejects.toThrow(/no size/);
    }, 30_000);
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

  // Closes Chrome here, as the file's last test, because a hook gets only 5 s and a busy machine can
  // take longer; the afterAll above then finds nothing left to close.
  test("closes Chrome", async () => {
    await browser.shutdown();
  }, 30_000);
});
