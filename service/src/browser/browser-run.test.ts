// browser_run scripts against real Chrome. The cart fixture is in wait-support.ts.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { browserWait, browserRun, browserRunStatus, browserRunStop, stopBrowserJobs } from "../tools";
import { fakeContext, fakeOps, fakeSession } from "../tools/fakes";
import type { ToolContext, ToolResult } from "../tools/types";
import { BrowserManager } from "./manager.ts";
import { all, chromePath, fixtures, pidAlive, profileDir, scratch, withChrome } from "./wait-support.ts";

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
        "expect(2).toBe(2) ✓",
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
      // Its own log line, and the failure names it as the step, as a page expectation's does.
      expect(text).toContain("expect(1).toBe(3) ✗ Expected: 3; Received: 1");
      expect(text).toContain("Step: expect(1).toBe(3)");
    }, 30_000);

    test("each value expectation logs one line, through .not, .resolves and Bun's asymmetric matchers", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const script = `const items = await evaluate(() => [...document.querySelectorAll("#list li")].map((li) => li.textContent));
expect(items).toEqual(["Item 1"]);
expect(items).not.toContain("Item 9");
expect(items).toEqual(expect.arrayContaining(["Item 1"]));
await expect(Promise.resolve(items.length)).resolves.toBe(1);
await expect(Promise.reject(new Error("nope"))).rejects.toThrow("nope");
await expect("#list li").toHaveCount(1);
return "ok";`;
      const { reports, last } = await drain(ctx, await browserRun.execute({ script, wait: 20 }, ctx));
      const log = reports.join("\n");
      expect(all(last)).toContain('Result: "ok"');
      for (const line of [
        `expect(["Item 1"]).toEqual(["Item 1"]) ✓`,
        `expect(["Item 1"]).not.toContain("Item 9") ✓`,
        `expect(["Item 1"]).toEqual(expect.arrayContaining(…)) ✓`,
        `expect(Promise).resolves.toBe(1) ✓`,
        `expect(Promise).rejects.toThrow("nope") ✓`,
        `expect("#list li").toHaveCount(1) ✓`,
      ]) {
        expect(log).toContain(line);
      }
      // A page matcher is logged once, by the service, not again by the child.
      expect(log.split('expect("#list li").toHaveCount(1)').length).toBe(2);
    }, 30_000);

    test("a text expectation that fails says what the elements said instead", async () => {
      const ctx = ctxFor();
      await browser.open(ctx.session.id, `${base}/form`);
      const one = await drain(ctx, await browserRun.execute({ script: `await expect("#list").toContainText("Item 9", { timeout: 0.5 });`, wait: 10 }, ctx));
      expect(all(one.last)).toContain(`Last check: 0 elements matched (0 visible, 0 enabled). Without the text, 1 element matches, and its text was "Item 1".`);
      const many = await drain(
        ctx,
        await browserRun.execute({ script: `for (let i = 0; i < 4; i++) await click("#add");\nawait expect("#list li").toHaveCount(5);\nawait expect("#list li").toContainText("Item 9", { timeout: 0.5 });`, wait: 20 }, ctx),
      );
      expect(all(many.last)).toContain(`Without the text, 5 elements match, and their text was "Item 1", "Item 2", "Item 3" and 2 more.`);
      // A ref that's there but lacks the text is "there", with its text.
      const ref = await drain(
        ctx,
        await browserRun.execute({ script: `const ref = /Toggle.*ref=(e\\d+)/.exec(await snapshot())[1];\nawait expect({ ref }).toContainText("Nope", { timeout: 0.5 });`, wait: 10 }, ctx),
      );
      expect(all(ref.last)).toMatch(/Last check: ref e\d+ was there \(0 visible, 0 enabled\)\. Its text was "Toggle"\./);
      // No selector means the whole page: its text isn't quoted back.
      const page = await browserWait.execute({ text: "Nowhere on the page", timeout: 0.5 }, ctx);
      expect(all(page)).toContain("Last check: 0 elements matched");
      expect(all(page)).not.toContain("Without the text");
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

