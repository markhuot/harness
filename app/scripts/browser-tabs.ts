// Browser tabs end-to-end against a REAL daemon and real headless Chrome (temp HARNESS_HOME, random
// port; never ~/.harness): an agent opens three tabs, the app's strip shows, switches and closes them.
//
//   bun run build && bun scripts/browser-tabs.ts [screenshotDir]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { startDaemon } from "@harness/shared/testing/daemon";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";
import { checkBrowserTabs } from "./lib/browser-tabs-check";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "browser-tabs"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-tabs-home-");
const projectDir = tempDir("harness-tabs-project-");
const daemon = await startDaemon({ home, delayMs: 5, logs: "inherit" });
const { port, base } = daemon;

const c = checker();
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  const { token } = daemon;
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "tabs", key: "TABS" });
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  await until("app connected", () => a.exists(".conn.on"), 15000);
  await checkBrowserTabs({ api, app: a, check: c.check, project, shot: (name) => a.screenshot(join(shots, `${name}.png`)) });
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  await app?.close();
  await daemon.stop();
  await cleanupTempDirs();
}
console.log(c.failures ? `${c.failures} check(s) failed` : "all checks passed");
process.exit(c.failures ? 1 : 0);
