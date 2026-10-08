// Waits (browser_wait and wait_for) and browser_run scripts against real Chrome, through the tools
// the agent calls. The cart fixture behaves like the one in ACAMS-33 that made an agent sleep
// between clicks: "Remove" makes a slow request, marks the page aria-busy meanwhile, then reloads
// with one item fewer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Server } from "bun";
import type { ToolResultContent } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { browserClick, browserContent, browserEval, browserScreenshot, browserWait, browserRun, browserRunStatus, browserRunStop, stopBrowserJobs } from "../tools";
import { fakeContext, fakeOps, fakeSession } from "../tools/fakes";
import type { ToolContext, ToolResult } from "../tools/types";
import { findChrome } from "./chrome.ts";
import { BrowserManager } from "./manager.ts";

const chromePath = findChrome();
const withChrome = chromePath ? describe : describe.skip;
const profileDir = chromePath ? tempDir("harness-wait-test-") : "";
const scratch = tempDir("harness-wait-scratch-");

const html = (body: string, title = "Fixture") =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body style="margin:0">${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

function fixtures(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/cart": {
      const n = Number(url.searchParams.get("n") ?? "0");
      const items = Array.from({ length: n }, (_, i) => `<li>Item ${i + 1} <button data-remove-item aria-label="Remove item ${i + 1}">Remove</button></li>`).join("");
      return html(
        `<main id="cart"><ul>${items}</ul><p id="count">${n} items</p></main>
         <script>
           for (const b of document.querySelectorAll("[data-remove-item]")) b.addEventListener("click", async () => {
             document.getElementById("cart").setAttribute("aria-busy", "true");
             await fetch("/slow?ms=700");
             location.href = "/cart?n=${n - 1}";
           });
         </script>`,
        "Cart",
      );
    }
    case "/slow":
      return Bun.sleep(Number(url.searchParams.get("ms") ?? "500")).then(() => new Response("ok"));
    case "/hang":
      return new Promise<Response>(() => {});
    case "/hanging":
      return html(`<p>waiting</p><script>fetch("/hang")</script>`, "Hanging");
    case "/busy":
      return html(`<div aria-busy="true"><button id="b" onclick="this.textContent='pressed'">Go</button></div>`, "Busy");
    case "/late": {
      const ms = Number(url.searchParams.get("ms") ?? "500");
      return html(
        `<div id="box" style="position:fixed;inset:0;background:rgb(255,255,255)"></div>
         <script>setTimeout(() => {
           const d = document.createElement("div"); d.className = "done"; d.textContent = "All done";
           document.body.append(d); document.getElementById("box").style.background = "rgb(0,128,0)";
         }, ${ms})</script>`,
        "Late",
      );
    }
    case "/plain":
      return html(`<h1 id="x" class="title big">Plain</h1>`, "Plain");
    case "/form":
      // Each button changes the page a moment after the click, so an expectation has to wait for it.
      return html(
        `<input id="q"><ul id="list"><li>Item 1</li></ul>
         <button id="add">Add</button> <button id="clear">Clear</button>
         <button id="toggle" aria-expanded="false">Toggle</button> <button id="go">Go</button>
         <a id="link" href="/plain" data-x>Link</a> <p id="hint" style="display:none">Hint</p>
         <iframe id="f" srcdoc="<p id='inner'>Inside</p>"></iframe>
         <script>
           const list = document.getElementById("list");
           const later = (id, ms, fn) => document.getElementById(id).addEventListener("click", () => setTimeout(fn, ms));
           later("add", 300, () => { const li = document.createElement("li"); li.textContent = "Item " + (list.children.length + 1); list.append(li); });
           later("clear", 500, () => list.replaceChildren());
           later("toggle", 200, () => document.getElementById("toggle").setAttribute("aria-expanded", "true"));
           later("go", 200, () => { location.href = "/plain?done=1"; });
         </script>`,
        "Form",
      );
    default:
      return new Response("not found", { status: 404 });
  }
}

const texts = (r: ToolResult) => r.content.filter((c): c is Extract<ToolResultContent, { type: "text" }> => c.type === "text").map((c) => c.text);
const all = (r: ToolResult) => texts(r).join("\n");

/** The first pixel of a PNG (always stored raw: no filter has a left or upper neighbour there). */
function firstPixel(base64: string): [number, number, number] {
  const png = Buffer.from(base64, "base64");
  const colorType = png[25];
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  expect([2, 6]).toContain(colorType!);
  return [raw[1]!, raw[2]!, raw[3]!];
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

    test("a wait times out at 15 s by default, and a longer timeout outlasts it", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/late?ms=16000`);
      const started = Date.now();
      const failed = await browserWait.execute({ selector: ".done" }, ctx);
      const took = Date.now() - started;
      expect(failed.isError).toBe(true);
      expect(took).toBeGreaterThanOrEqual(15_000);
      expect(took).toBeLessThan(16_000);
      expect(all(failed)).toContain('Timed out after 15.');
      expect(all(failed)).toContain("Last check: 0 elements matched");
      // The element shows up at 16 s: a 20 s timeout sees it.
      const met = await browserWait.execute({ selector: ".done", timeout: 20 }, ctx);
      expect(met.isError).toBeUndefined();
      expect(all(met)).toContain('".done" visible after');
    }, 60_000);

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

  describe("browser_run", () => {
    /** Poll a job to its end; every report's text, in order. */
    async function drain(ctx: ToolContext, first: ToolResult): Promise<{ reports: string[]; last: ToolResult }> {
      const reports = [all(first)];
      let last = first;
      const job = Number(/Job (\d+)/.exec(all(first))![1]);
      while (/: running \(/.test(all(last))) {
        last = await browserRunStatus.execute({ job, wait: 10 }, ctx);
        reports.push(all(last));
      }
      return { reports, last };
    }

    test("a loop clears the cart across reloads and returns the count", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/cart?n=3`);
      const script = `let removed = 0;
while (await evaluate(() => document.querySelectorAll("[data-remove-item]").length)) {
  log(await evaluate(() => document.querySelector("[data-remove-item]").ariaLabel));
  await click("[data-remove-item]", { wait_for: { idle: true } });
  removed++;
}
return removed;`;
      const { reports, last } = await drain(ctx, await browserRun.execute({ script, wait: 30 }, ctx));
      const log = reports.join("\n");
      expect(last.isError).toBeUndefined();
      expect(all(last)).toContain("Result: 3");
      expect(log).toContain("script Remove item 1");
      expect(log).toContain('evaluate("() => document.querySelectorAll(\\"[data-remove-item]\\").length") → 3');
      expect(log).toMatch(/step\s+click\("\[data-remove-item\]", \{"wait_for":\{"idle":true\}\}\) → Clicked/);
      expect(log).toContain("→ navigated to");
      expect(await browser.evaluate(ctx.session.id, "document.getElementById('count').textContent")).toBe('"0 items"');
    }, 60_000);

    test("a short wait returns the job running with the lines so far, and status gives the rest once", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const first = await browserRun.execute({ script: `log("first line");\nawait sleep(1500);\nlog("second line");\nreturn 1;`, wait: 0.7 }, ctx);
      expect(all(first)).toMatch(/: running \(/);
      expect(all(first)).toContain("first line");
      expect(all(first)).not.toContain("second line");
      const { reports, last } = await drain(ctx, first);
      const later = reports.slice(1).join("\n");
      expect(later).toContain("second line");
      expect(later).not.toContain("first line");
      expect(all(last)).toContain("Result: 1");
    }, 30_000);

    test("the log has the script's console, the page's console and errors, and failed requests, tagged", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const script = `console.log("from the script", { n: 1 });
console.warn("careful");
await evaluate(() => { console.error("page-side error"); setTimeout(() => { throw new Error("boom") }); fetch("/missing"); });
await sleep(500);`;
      const { reports } = await drain(ctx, await browserRun.execute({ script, wait: 10 }, ctx));
      const log = reports.join("\n");
      expect(log).toMatch(/script\s+from the script \{ n: 1 \}/);
      expect(log).toMatch(/script\s+warn: careful/);
      expect(log).toMatch(/page\s+error: page-side error/);
      expect(log).toMatch(/page\s+uncaught: Error: boom/);
      expect(log).toMatch(/page\s+✗ GET http:\/\/127\.0\.0\.1:\d+\/missing 404/);
      // The human sees the same lines in the transcript.
      const mirrored = (ctx.ops as ReturnType<typeof fakeOps>).calls.filter((c) => c.method === "statusLine").map((c) => String(c.args[0])).join("\n");
      expect(mirrored).toContain("from the script");
      expect(mirrored).toContain("page-side error");
    }, 30_000);

    test("a failing step reports the script line, the step, the page and a screenshot", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const script = `log("before");\n\nawait click("#nope");\nlog("never");`;
      const { last } = await drain(ctx, await browserRun.execute({ script, wait: 10 }, ctx));
      expect(last.isError).toBe(true);
      const text = all(last);
      expect(text).toContain("Failed: No element matches selector: #nope");
      expect(text).toContain("Where: script line 3, column");
      expect(text).toContain('Step: click("#nope")');
      expect(text).toMatch(/Page: http:\/\/127\.0\.0\.1:\d+\/plain/);
      expect(text).not.toContain("never");
      const shot = last.content.find((c) => c.type === "image") as { data: string } | undefined;
      expect(shot).toBeDefined();
      const saved = /saved to (\S+\.png)/.exec(text)![1]!;
      expect(readFileSync(saved).subarray(1, 4).toString()).toBe("PNG");
    }, 30_000);

    test("a thrown error on line 1 points at the script's own column", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const { last } = await drain(ctx, await browserRun.execute({ script: `throw new Error("first line fails");`, wait: 10 }, ctx));
      expect(all(last)).toContain("Failed: first line fails");
      expect(all(last)).toContain("Where: script line 1, column 1");
    }, 30_000);

    test("the timeout, browser_run_stop and the run ending each kill the script's process", async () => {
      const pidOf = (r: ToolResult) => Number(/pid (\d+)/.exec(all(r))![1]);

      const timedCtx = ctxFor();
      await browser.open(timedCtx.session.id, `${base}/plain`);
      const timed = await browserRun.execute({ script: `await sleep(60000);`, timeout: 1, wait: 0.2 }, timedCtx);
      const timedPid = pidOf(timed);
      expect(pidAlive(timedPid)).toBe(true);
      const { last } = await drain(timedCtx, timed);
      expect(all(last)).toContain("Stopped: Timed out after 1s.");
      await Bun.sleep(100);
      expect(pidAlive(timedPid)).toBe(false);

      const stopCtx = ctxFor();
      await browser.open(stopCtx.session.id, `${base}/plain`);
      const running = await browserRun.execute({ script: `await sleep(60000);`, wait: 0.2 }, stopCtx);
      const job = Number(/Job (\d+)/.exec(all(running))![1]);
      // One job per tab at a time.
      expect(all(await browserRun.execute({ script: `1`, wait: 0 }, stopCtx))).toContain(`Job ${job} is still running on tab 1`);
      const stopped = await browserRunStop.execute({ job }, stopCtx);
      expect(all(stopped)).toContain("stopped after");
      await Bun.sleep(100);
      expect(pidAlive(pidOf(running))).toBe(false);

      const runCtx = ctxFor();
      await browser.open(runCtx.session.id, `${base}/plain`);
      const ended = await browserRun.execute({ script: `await sleep(60000);`, wait: 0.2 }, runCtx);
      stopBrowserJobs(runCtx.runId);
      const after = await browserRunStatus.execute({ job: Number(/Job (\d+)/.exec(all(ended))![1]), wait: 0 }, runCtx);
      expect(all(after)).toContain("Stopped: the run ended.");
      await Bun.sleep(100);
      expect(pidAlive(pidOf(ended))).toBe(false);
    }, 30_000);

    test("do, then expect: every page matcher waits until it holds, and each passes as one log line", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const script = `await expect("#hint").toBeHidden();
await expect("#hint").not.toBeVisible();
await expect("#add").toBeEnabled();
await click("#add");
await expect("#list li").toHaveCount(2);
await expect("#list").toContainText("Item 2");
await expect("#list").not.toContainText("Item 9");
await type("#q", "hello");
await expect("#q").toHaveValue("hello");
await expect("#link").toHaveAttribute("data-x");
const snap = await snapshot();
const ref = /Toggle.*ref=(e\\d+)/.exec(snap)[1];
await click("#toggle");
await expect({ ref }).toHaveAttribute("aria-expanded", "true");
await expect({ selector: "#inner", frame: "#f" }).toContainText("Inside");
expect(await evaluate(() => document.querySelectorAll("#list li").length)).toBe(2);
await click("#go");
await expect(page).toHaveURL(/done=1/);
await expect({ ref }).toBeHidden();
return "ok";`;
      const { reports, last } = await drain(ctx, await browserRun.execute({ script, wait: 30 }, ctx));
      const log = reports.join("\n");
      expect(all(last)).toContain('Result: "ok"');
      for (const line of [
        'expect("#hint").not.toBeVisible() ✓',
        'expect("#list li").toHaveCount(2) ✓',
        'expect("#list").not.toContainText("Item 9") ✓',
        'expect("#q").toHaveValue("hello") ✓',
        'expect({"ref":"e',
        'expect({"selector":"#inner","frame":"#f"}).toContainText("Inside") ✓',
        "expect(page).toHaveURL(/done=1/) ✓",
      ]) {
        expect(log).toContain(line);
      }
    }, 60_000);

    test("an expectation retries until the page catches up", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/late?ms=1500`);
      const { last } = await drain(ctx, await browserRun.execute({ script: `await expect(".done").toContainText("All done");\nreturn 1;`, wait: 10 }, ctx));
      expect(all(last)).toContain("Result: 1");
    }, 30_000);

    test("a failing page expectation stops the job with the line, the matcher, the last check, the page and a screenshot", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const script = `log("before");\nawait expect("#list li").toHaveCount(5, { timeout: 1 });\nlog("never");`;
      const { last } = await drain(ctx, await browserRun.execute({ script, wait: 10 }, ctx));
      expect(last.isError).toBe(true);
      const text = all(last);
      expect(text).toContain('Failed: expect("#list li").toHaveCount(5, {"timeout":1})\nTimed out after 1.');
      expect(text).toContain("Last check: 1 element matched, want 5");
      expect(text).toContain("Where: script line 2, column");
      expect(text).toContain('Step: expect("#list li").toHaveCount(5, {"timeout":1})');
      expect(text).toMatch(/Page: http:\/\/127\.0\.0\.1:\d+\/form/);
      expect(text).toContain("saved to");
      expect(last.content.some((c) => c.type === "image")).toBe(true);
      expect(text).not.toContain("never");
      // { timeout: 1 } fails in about a second, not the default 5.
      expect(Number(/failed after (\d+\.\d)s/.exec(text)![1])).toBeLessThan(4);
    }, 30_000);

    test("a page expectation's failure names the value it last saw", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const { last } = await drain(ctx, await browserRun.execute({ script: `await type("#q", "abc");\nawait expect("#q").toHaveValue("xyz", { timeout: 0.5 });`, wait: 10 }, ctx));
      expect(all(last)).toContain(`The first match's value was "abc".`);
      expect(all(last)).toContain("Where: script line 2, column");
    }, 30_000);

    test("a failing plain expect gives Bun's Expected/Received and the script line", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const script = `log("before");\nexpect(await evaluate(() => document.querySelectorAll("#list li").length)).toBe(3);\nlog("never");`;
      const { last } = await drain(ctx, await browserRun.execute({ script, wait: 10 }, ctx));
      expect(last.isError).toBe(true);
      const text = all(last);
      expect(text).toContain("Failed: expect(received).toBe(expected)");
      expect(text).toContain("Expected: 3");
      expect(text).toContain("Received: 1");
      expect(text).toContain("Where: script line 2, column");
      expect(text).not.toContain("never");
    }, 30_000);

    test(".not with no inverse, and a matcher on the wrong target, say what to write instead", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const not = await drain(ctx, await browserRun.execute({ script: `await expect("#list li").not.toHaveCount(1);`, wait: 10 }, ctx));
      expect(all(not.last)).toContain("Failed: expect(\"#list li\").not.toHaveCount(1)\n.not.toHaveCount() has nothing to wait for; expect the count you want instead: toHaveCount(n).");
      const url = await drain(ctx, await browserRun.execute({ script: `await expect("#list").toHaveURL("/form");`, wait: 10 }, ctx));
      expect(all(url.last)).toContain("toHaveURL checks the page: expect(page).toHaveURL(url).");
      const missing = await drain(ctx, await browserRun.execute({ script: `await expect("#list").toContainText();`, wait: 10 }, ctx));
      expect(all(missing.last)).toContain("toContainText needs the text.");
    }, 30_000);

    test("another session can't read a job", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/plain`);
      const r = await browserRun.execute({ script: `return 2;`, wait: 5 }, ctx);
      const job = Number(/Job (\d+)/.exec(all(r))![1]);
      const other = await browserRunStatus.execute({ job, wait: 0 }, ctxFor());
      expect(other.isError).toBe(true);
      expect(all(other)).toContain(`No browser_run job ${job} in this session`);
    }, 30_000);
  });
});
