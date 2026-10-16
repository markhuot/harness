import { afterEach, beforeEach, expect, test } from "bun:test";
import { assertNoTimerLeaks, trackTimers } from "./leaks";
import { existsSync } from "node:fs";
import { createHarness } from "../../service/src/app";
import { QuietBrowser } from "../builders/harness";
import { tempDir } from "../builders/tmp";
import { FakeDriver, replyScript } from "./fake-driver";

beforeEach(trackTimers);
afterEach(assertNoTimerLeaks);

/** The in-memory composition L1 smoke-tests: everything wired, nothing outside the process. L2 owns what the API does. */
async function boot() {
  const driver = new FakeDriver();
  const home = tempDir();
  const harness = await createHarness({ home, port: 0, hostname: "127.0.0.1", dbPath: ":memory:", drivers: [driver], browser: new QuietBrowser(), watchers: null, pluginDirs: [] });
  return { harness, driver, home };
}

test("the composition boots on an ephemeral port with an in-memory database and answers /health", async () => {
  const { harness, home } = await boot();
  try {
    expect(harness.port).toBeGreaterThan(0);
    const res = await fetch(`${harness.url}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(existsSync(harness.paths.dbPath)).toBe(false);
    expect(harness.paths.home).toBe(home);
  } finally {
    await harness.stop();
  }
});

test("every route but /health needs the bearer token", async () => {
  const { harness } = await boot();
  try {
    expect((await fetch(`${harness.url}/projects`)).status).toBe(401);
    expect((await fetch(`${harness.url}/projects`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await fetch(`${harness.url}/projects`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: unknown[] }).data).toEqual([]);
  } finally {
    await harness.stop();
  }
});

test("the parts it composes share one store and bus: a ticket made through the orchestrator runs on the fake driver and shows over HTTP", async () => {
  const { harness, driver } = await boot();
  try {
    driver.script(replyScript("hello"));
    harness.store.settings.set({ phaseModels: Object.fromEntries(["plan", "work", "review", "adviser", "complete"].map((p) => [p, { driver: "fake", model: null }])) });
    const project = harness.orchestrator.createProject({ path: harness.paths.home, name: "Home", key: "HOME", useWorktrees: false });
    const ticket = await harness.orchestrator.createTicket({ projectId: project.id, spec: "Say hello", skipAgentReview: true });
    for (let i = 0; i < 1000 && !harness.orchestrator.isIdle(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const res = await fetch(`${harness.url}/tickets/${ticket.key}`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(((await res.json()) as { data: { ticket: { status: string } } }).data.ticket.status).toBe("review");
    expect(driver.requests).toHaveLength(1);
  } finally {
    await harness.stop();
  }
});

test("stop closes the port, and stopping again is harmless", async () => {
  const { harness } = await boot();
  const url = harness.url;
  await harness.stop();
  await expect(fetch(`${url}/health`)).rejects.toThrow();
  await expect(harness.stop()).resolves.toBeUndefined();
});
