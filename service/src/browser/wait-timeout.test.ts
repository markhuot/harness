// The default wait timeout, in its own file because it waits out 15 real seconds: apart from the
// other wait tests it runs alongside them rather than after them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { browserWait } from "../tools";
import { fakeContext, fakeOps, fakeSession } from "../tools/fakes";
import type { ToolContext } from "../tools/types";
import { BrowserManager } from "./manager.ts";
import { all, chromePath, fixtures, profileDir, scratch, withChrome } from "./wait-support.ts";

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
  }, 30_000); // closing Chrome can take a while on a busy machine

  describe("default timeout", () => {
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

  });
});

