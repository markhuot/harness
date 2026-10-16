import { afterEach, expect, test } from "bun:test";
import { BrowserManager, normalizeUrl } from "../../../service/src/browser/manager";
import { addProject, addTicket, makeStore } from "../../builders/store";
import { fakeClock } from "../../builders/clock";
import { tempDir } from "../../builders/tmp";

const managers: BrowserManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

test("a URL with a scheme is left alone; a bare host gets https, and localhost and loopback get http", () => {
  expect(normalizeUrl("https://x.test/a?b=1#c")).toBe("https://x.test/a?b=1#c");
  expect(normalizeUrl("ftp://x")).toBe("ftp://x");
  expect(normalizeUrl("example.com/path")).toBe("https://example.com/path");
  expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  for (const local of ["localhost:3000", "localhost/x", "127.0.0.1:8080/y", "0.0.0.0", "[::1]:3000/", "localhost?q=1"]) expect(normalizeUrl(local)).toBe(`http://${local}`);
  expect(normalizeUrl("localhostile.com")).toBe("https://localhostile.com");
  for (const special of ["about:blank", "data:text/html,hi", "javascript:alert(1)", "mailto:a@b.c", "file:///tmp/x", "view-source:https://x"]) expect(normalizeUrl(special)).toBe(special);
  expect(normalizeUrl("   ")).toBe("about:blank");
});

/** A manager over the real tab store, with no Chrome: it can only describe tabs it has stored. */
function rig(idleMinutes = 0) {
  const clock = fakeClock(1_000_000);
  const store = makeStore({ now: clock });
  const ticket = addTicket(store, addProject(store));
  const manager = new BrowserManager({ profileDir: tempDir(), tabStore: store.browserTabs, now: clock, idleTabMs: () => idleMinutes * 60_000 });
  managers.push(manager);
  const save = (tabs: { id: number; url: string; title: string; size?: never }[], nextTabId = 10) => store.browserTabs.save(ticket.sessionId, { nextTabId, tabs });
  return { manager, store, ticket, clock, sessionId: ticket.sessionId, save };
}

test("a session with no stored tabs has no browser state and no tabs, and asking doesn't start Chrome", async () => {
  const r = rig();
  expect(await r.manager.state(r.sessionId)).toBeNull();
  expect(await r.manager.tabs(r.sessionId)).toEqual([]);
  expect(r.manager.chromePid).toBeUndefined();
});

test("tabs stored by an earlier process come back suspended, lowest id first, with their stored size or a default", async () => {
  const r = rig();
  r.save([
    { id: 4, url: "https://b.test/", title: "B" },
    { id: 2, url: "https://a.test/", title: "A", size: { device: "mobile", width: 390, height: 844, responsive: false } as never },
  ]);
  const tabs = await r.manager.tabs(r.sessionId);
  expect(tabs.map((t) => [t.id, t.url, t.suspended])).toEqual([[2, "https://a.test/", true], [4, "https://b.test/", true]]);
  expect(tabs[0]!.size).toEqual({ device: "mobile", width: 390, height: 844, responsive: false });
  expect(tabs[1]!.size).toMatchObject({ device: "desktop", responsive: true });
  const state = await r.manager.state(r.sessionId);
  expect(state).toMatchObject({ tabId: 2, suspended: true, loading: false, url: "https://a.test/", sessionId: r.sessionId });
  expect((state!.tabs ?? []).map((t) => t.id)).toEqual([2, 4]);
  expect(await r.manager.state(r.sessionId, { tab: 4 })).toMatchObject({ tabId: 4, title: "B" });
  expect(await r.manager.state(r.sessionId, { tab: 99 })).toBeNull();
  expect(r.manager.chromePid).toBeUndefined();
});

test("a suspended tab's info is what was stored, without reopening its page", async () => {
  const r = rig();
  r.save([{ id: 1, url: "https://a.test/", title: "A" }]);
  expect(await r.manager.tabInfo(r.sessionId, 1)).toMatchObject({ id: 1, url: "https://a.test/", suspended: true, requests: [], console: [] });
  await expect(r.manager.tabInfo(r.sessionId, 7)).rejects.toThrow("No browser tab 7. Open tabs: 1.");
  await expect(r.manager.tabInfo("other-session", 1)).rejects.toThrow("This session has no open tabs.");
});

test("closing a suspended tab forgets it, and a tab that isn't there says which ones are", async () => {
  const r = rig();
  r.save([{ id: 1, url: "https://a.test/", title: "A" }, { id: 2, url: "https://b.test/", title: "B" }]);
  await r.manager.closeTab(r.sessionId, 1);
  expect((await r.manager.tabs(r.sessionId)).map((t) => t.id)).toEqual([2]);
  await expect(r.manager.closeTab(r.sessionId, 1)).rejects.toThrow("Open tabs: 2.");
});

test("reaping idle tabs does nothing without live pages, and nothing at all when the idle time is 0", async () => {
  expect(await rig(0).manager.reapIdleTabs()).toBe(0);
  const r = rig(30);
  r.save([{ id: 1, url: "https://a.test/", title: "A" }]);
  r.clock.advance(3 * 3600_000);
  expect(await r.manager.reapIdleTabs()).toBe(0);
});

test("shutting down with no Chrome running is a no-op, and can be done twice", async () => {
  const r = rig();
  await r.manager.shutdown();
  await r.manager.shutdown();
  expect(await r.manager.tabs(r.sessionId)).toEqual([]);
});
