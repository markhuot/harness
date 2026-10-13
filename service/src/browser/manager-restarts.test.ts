import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { BrowserManager } from "./manager.ts";
import { chromePath, fixtures, ids, isAlive, memoryTabStore, profileDir, until, withChrome } from "./test-support.ts";

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
