import { expect, test } from "bun:test";
import { Cdp, TargetTracker, type TargetInfo } from "./cdp";

const info = (targetId: string, url: string, type = "page"): TargetInfo => ({ targetId, type, url });
const created = (t: TargetInfo) => ({ targetInfo: t }) as Record<string, unknown>;

test("the main window and a popout are separate pages, told apart by URL, and a claimed one isn't found twice", () => {
  const t = new TargetTracker();
  t.apply("Target.targetCreated", created(info("main", "file:///app/index.html#/board/all")));
  const isPopout = (url: string) => url.includes("#/popout/");
  expect(t.find(isPopout)).toBeUndefined();

  t.apply("Target.targetCreated", created(info("pop", "file:///app/index.html#/popout/abc/terminal")));
  expect(t.find(isPopout)?.targetId).toBe("pop");
  expect(t.find(isPopout, new Set(["pop"]))).toBeUndefined();
  expect(t.find((u) => u.startsWith("file://") && !isPopout(u))?.targetId).toBe("main");
});

test("a window that navigates is found at its new URL, and a closed one is gone", () => {
  const t = new TargetTracker();
  t.apply("Target.targetCreated", created(info("w", "about:blank")));
  t.apply("Target.targetInfoChanged", created(info("w", "file:///app/index.html#/popout/x")));
  expect(t.pages().map((p) => p.url)).toEqual(["file:///app/index.html#/popout/x"]);
  t.apply("Target.targetDestroyed", { targetId: "w" });
  expect(t.pages()).toEqual([]);
});

test("DevTools, workers and other non-page targets are not app windows", () => {
  const t = new TargetTracker();
  t.apply("Target.targetCreated", created(info("d", "devtools://devtools/bundled/inspector.html")));
  t.apply("Target.targetCreated", created(info("s", "file:///app/worker.js", "service_worker")));
  t.apply("Target.targetCreated", created(info("b", "", "browser")));
  expect(t.pages()).toEqual([]);
});

test("events that aren't about targets change nothing", () => {
  const t = new TargetTracker();
  t.apply("Page.loadEventFired", {});
  expect(t.pages()).toEqual([]);
});

test("a command the browser never answers fails at its deadline naming the method, instead of hanging teardown", async () => {
  const server = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")), websocket: { message() {} } });
  try {
    const cdp = new Cdp(`ws://localhost:${server.port}`);
    cdp.sendDeadlineMs = 50;
    await cdp.opened();
    await expect(cdp.send("Browser.close")).rejects.toThrow(/timed out after 50ms waiting for the DevTools answer to Browser\.close/);
    cdp.close();
  } finally {
    server.stop(true);
  }
});
