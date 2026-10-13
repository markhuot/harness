// Waits (browser_wait and wait_for) against real Chrome, through the tools the agent calls. The cart
// fixture is in wait-support.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { browserClick, browserContent, browserEval, browserScreenshot, browserWait } from "../tools";
import { fakeContext, fakeOps, fakeSession } from "../tools/fakes";
import type { ToolContext } from "../tools/types";
import { BrowserManager } from "./manager.ts";
import { all, chromePath, firstPixel, fixtures, profileDir, scratch, texts, withChrome } from "./wait-support.ts";

withChrome("waits and browser_run (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;
  let browser: BrowserManager;
  let n = 0;
  /** A fresh session (its own tabs) and run for each test. */
  const ctxFor = (): ToolContext =>
    fakeContext({
      runId: `run-${++n}`,
      session: fakeSession({ id: `wait-${n}` }),
      browser,
      cwd: scratch,
      ops: fakeOps({ fileOutputScope: async () => ({ scratchDir: scratch, readOnly: false }) }),
    });

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000 });
  });

  afterAll(async () => {
    await browser?.shutdown();
    void server?.stop(true);
  });

  describe("one wait engine", () => {
    test("browser_wait sees a button gone across the reload, and wait_for on browser_click does the same", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/cart?n=2`);
      const clicked = await browserClick.execute({ selector: "button[data-remove-item]" }, ctx);
      // Without a wait, the click returns while the page is still busy: the button is still there.
      expect(await browser.evaluate(ctx.session.id, "document.querySelectorAll('[data-remove-item]').length")).toBe("2");
      expect(clicked.isError).toBeUndefined();
      const waited = await browserWait.execute({ selector: "button[aria-label='Remove item 2']", state: "gone" }, ctx);
      expect(waited.isError).toBeUndefined();
      expect(all(waited)).toMatch(/"button\[aria-label='Remove item 2'\]" gone after \d+\.\ds; now at .*\/cart\?n=1/);

      const again = await browserClick.execute({ selector: "button[data-remove-item]", wait_for: { selector: "button[data-remove-item]", state: "gone" } }, ctx);
      expect(again.isError).toBeUndefined();
      expect(all(again)).toContain("Clicked button[data-remove-item]");
      expect(all(again)).toMatch(/Waited: "button\[data-remove-item\]" gone after/);
      expect(await browser.evaluate(ctx.session.id, "location.search")).toBe('"?n=0"');
    }, 30_000);

    test("click with wait_for idle returns only once the request and the reload are done", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/cart?n=2`);
      const started = Date.now();
      const r = await browserClick.execute({ selector: "button[data-remove-item]", wait_for: { idle: true } }, ctx);
      expect(r.isError).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(700);
      expect(all(r)).toContain("Waited: network idle after");
      // Straight after, with no sleep: the reloaded page.
      expect(await browser.evaluate(ctx.session.id, "document.getElementById('count').textContent")).toBe('"1 items"');
    }, 30_000);

    test("an idle wait that times out names the request still in flight", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/hanging`);
      const r = await browserWait.execute({ idle: true, timeout: 1 }, ctx);
      expect(r.isError).toBe(true);
      expect(all(r)).toMatch(/Requests still in flight: GET http:\/\/127\.0\.0\.1:\d+\/hang \(/);
    }, 30_000);

    test("a bad selector fails at once instead of waiting out the timeout", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const started = Date.now();
      const r = await browserWait.execute({ selector: "button[", timeout: 10 }, ctx);
      expect(r.isError).toBe(true);
      expect(all(r)).toContain("isn't a valid CSS selector");
      expect(Date.now() - started).toBeLessThan(3_000);
    }, 30_000);

    test("a wait condition is checked before the tool acts", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/busy`);
      const r = await browserClick.execute({ selector: "#b", wait_for: { timeout: 3 } }, ctx);
      expect(r.isError).toBe(true);
      expect(all(r)).toContain("Say what to wait for");
      expect(await browser.evaluate(ctx.session.id, "document.getElementById('b').textContent")).toBe('"Go"');
    }, 30_000);

    test("a click on a busy element says so", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/busy`);
      const r = await browserClick.execute({ selector: "#b" }, ctx);
      expect(all(r)).toContain("inside an element marked aria-busy");
    }, 30_000);
  });

  describe("read tools wait before reading", () => {
    test("browser_screenshot with wait_for captures the page after the condition holds", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/late?ms=500`);
      const r = await browserScreenshot.execute({ wait_for: { selector: ".done" } }, ctx);
      expect(r.isError).toBeUndefined();
      const image = r.content.find((c) => c.type === "image") as { data: string };
      expect(firstPixel(image.data)).toEqual([0, 128, 0]);
      expect(all(r)).toContain('Waited: ".done" visible after');
    }, 30_000);

    test("browser_content with wait_for includes what appeared", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/late?ms=500`);
      const r = await browserContent.execute({ wait_for: { text: "All done" } }, ctx);
      expect(r.isError).toBeUndefined();
      expect(texts(r).at(-1)).toContain("All done");
    }, 30_000);

    test("a read whose wait times out still returns what it read", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/late?ms=60000`);
      const shot = await browserScreenshot.execute({ wait_for: { selector: ".done", timeout: 0.5 } }, ctx);
      expect(shot.isError).toBe(true);
      expect(shot.content.some((c) => c.type === "image")).toBe(true);
      expect(firstPixel((shot.content.find((c) => c.type === "image") as { data: string }).data)).toEqual([255, 255, 255]);
      const read = await browserContent.execute({ selector: "#box", format: "html", wait_for: { selector: ".done", timeout: 0.5 } }, ctx);
      expect(read.isError).toBe(true);
      expect(all(read)).toContain("Timed out");
      expect(texts(read).at(-1)).toContain('id="box"');
    }, 30_000);
  });

  describe("browser_eval", () => {
    test("objects come back as JSON, elements and cycles described, in one atomic read", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const r = await browserEval.execute(
        { expression: "(() => { const o = { el: document.getElementById('x'), m: new Map([['k', 1]]), s: new Set([1, 2]), d: new Date(0) }; o.self = o; return new Promise((res) => setTimeout(() => res(o), 50)); })()" },
        ctx,
      );
      expect(JSON.parse(all(r))).toEqual({ el: "h1#x.title.big", m: { k: 1 }, s: [1, 2], d: "1970-01-01T00:00:00.000Z", self: "[Circular]" });
    }, 30_000);

    test("a navigation while the expression runs is a clear error that points to browser_run", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const err = await browserEval
        .execute({ expression: "new Promise((r) => { setTimeout(() => { location.href = '/cart?n=1' }, 50); setTimeout(r, 3000); })" }, ctx)
        .then(
          () => "",
          (e) => String(e),
        );
      expect(err).toMatch(/The page navigated to http:\/\/127\.0\.0\.1:\d+\/cart\?n=1 while the expression ran/);
      expect(err).toContain("browser_run");
    }, 30_000);
  });

  describe("count, value and attribute", () => {
    test("browser_click's wait_for waits for a list to empty with count 0", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const r = await browserClick.execute({ selector: "#clear", wait_for: { selector: "#list li", count: 0 } }, ctx);
      expect(r.isError).toBeUndefined();
      expect(all(r)).toContain('"#list li" count 0');
      expect(await browser.evaluate(ctx.session.id, "document.querySelectorAll('#list li').length")).toBe("0");
    }, 30_000);

    test("a timeout reports the last count, value and attribute it saw", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const count = await browserWait.execute({ selector: "#list li", count: 3, timeout: 0.5 }, ctx);
      expect(count.isError).toBe(true);
      expect(all(count)).toContain("Last check: 1 element matched, want 3 (1 visible, 1 enabled).");
      const value = await browserWait.execute({ selector: "#q", value: "x", timeout: 0.5 }, ctx);
      expect(all(value)).toContain(`The first match's value was "".`);
      const attr = await browserWait.execute({ selector: "#toggle", attribute: { name: "aria-expanded", value: "true" }, timeout: 0.5 }, ctx);
      expect(all(attr)).toContain(`The first match's aria-expanded was "false".`);
      const missing = await browserWait.execute({ selector: "#toggle", attribute: { name: "aria-pressed" }, timeout: 0.5 }, ctx);
      expect(all(missing)).toContain("The first match has no aria-pressed attribute.");
      // A hidden element still has its attribute: these fields don't ask for visibility.
      expect((await browserWait.execute({ selector: "#hint", attribute: { name: "style" }, timeout: 0.5 }, ctx)).isError).toBeUndefined();
      expect((await browserWait.execute({ selector: "#hint", state: "visible", attribute: { name: "style" }, timeout: 0.5 }, ctx)).isError).toBe(true);
    }, 30_000);
  });

});

