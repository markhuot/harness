import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { BrowserState } from "@harness/shared";
import { codeSignCloneRoot, findChrome } from "./chrome.ts";
import { BrowserManager, normalizeUrl } from "./manager.ts";
import { createBrowserService } from "./index.ts";
import type { BrowserFrame } from "./types.ts";
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
    server = Bun.serve({ port: 0, fetch: fixtures });
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
    expect(state).toEqual({ sessionId: "s-open", url: `${base}/`, title: "Home Page", loading: false });
    expect(await browser.state("s-open")).toEqual(state);
  }, 30_000);

  test("open surfaces network errors", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
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
      await until(async () => (await browser.state("s-crash")) === null, "tab to be forgotten");
      if (clone) await until(() => !existsSync(clone), "the killed Chrome's clone to be removed", 10_000);

      const state = await browser.open("s-crash", `${base}/page2`);
      expect(state.title).toBe("Page Two");
      expect(browser.chromePid).not.toBe(pid);
    } finally {
      if (clone && existsSync(clone)) rmSync(clone, { recursive: true, force: true });
    }
  }, 30_000);
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
