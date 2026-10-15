import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import type { BrowserState } from "@harness/shared";
import { BrowserManager } from "./manager.ts";
import type { BrowserFrame } from "./types.ts";
import { chromePath, fixtures, isAlive, profileDir, uaHits, until, withChrome } from "./test-support.ts";

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
      // A desktop tab reads as a person's Chrome from its first page: no "HeadlessChrome", no webdriver flag.
      expect(desktopUa).not.toContain("Headless");
      expect(await browser.evaluate("z-mobile", "navigator.webdriver")).toBe("false");
      expect(await browser.evaluate("z-mobile", "navigator.userAgentData.brands.map((b) => b.brand).join()")).not.toContain("Headless");
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

  // Closes Chrome here, as the file's last test, because a hook gets only 5 s and a busy machine can
  // take longer; the afterAll above then finds nothing left to close.
  test("closes Chrome", async () => {
    await browser.shutdown();
  }, 30_000);
});
