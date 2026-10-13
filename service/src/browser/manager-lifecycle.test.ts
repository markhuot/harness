import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Server } from "bun";
import type { BrowserState } from "@harness/shared";
import { QUIET_CHROME_ARGS } from "./chrome.ts";
import { BrowserManager } from "./manager.ts";
import type { BrowserFrame } from "./types.ts";
import { chromePath, chromePages, fixtures, ids, isAlive, memoryTabStore, profileDir, until, withChrome } from "./test-support.ts";

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
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, chromeArgs: QUIET_CHROME_ARGS, navigationTimeoutMs: 10_000, idleTabMs: () => idleMs, now: () => clock, tabStore: store });
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

  // Closes Chrome here, as the file's last test, because a hook gets only 5 s and a busy machine can
  // take longer; the afterAll above then finds nothing left to close.
  test("closes Chrome", async () => {
    await browser.shutdown();
  }, 30_000);
});
