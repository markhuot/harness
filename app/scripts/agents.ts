// Sub-agents end-to-end against a REAL daemon (temp HARNESS_HOME, random port; never ~/.harness):
// a dummy `/agents 3` ticket, its Agents & tasks tab, a sub-agent's transcript, then a `/bgtask`
// ticket's background Bash task and its output view, in light and dark.
//
//   bun run build && bun scripts/agents.ts [screenshotDir]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { startDaemon } from "@harness/shared/testing/daemon";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";
import { checkAgentsTab } from "./lib/agents-check";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "agents"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-agents-home-");
const projectDir = tempDir("harness-agents-project-");
const daemon = await startDaemon({ home, delayMs: 60, logs: "inherit" });
const { port, base } = daemon;

const c = checker();
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  const { token } = daemon;
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "agents", key: "AGT" });
  for (const theme of ["light", "dark"] as const) {
    app = await launchApp({ baseUrl: base, token, theme });
    const a = app;
    await until("app connected", () => a.exists(".conn.on"), 15000);
    await checkAgentsTab({ api, app: a, check: c.check, project, shot: (name) => a.screenshot(join(shots, `${name}-${theme}.png`)) });
    await app.close();
    app = null;
  }
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  await app?.close();
  await daemon.stop();
  // Only now that nothing writes into them (and tempDir's exit listener covers a crash).
  await cleanupTempDirs();
}
console.log(c.failures ? `${c.failures} check(s) failed` : "all checks passed");
process.exit(c.failures ? 1 : 0);
