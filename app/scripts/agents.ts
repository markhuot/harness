// Sub-agents end-to-end against a REAL daemon (temp HARNESS_HOME, random port; never ~/.harness):
// a dummy `/agents 3` ticket, its Agents tab, a sub-agent's transcript, in light and dark.
//
//   bun run build && bun scripts/agents.ts [screenshotDir]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Project } from "@harness/shared";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";
import { checkAgentsTab } from "./lib/agents-check";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "agents"));
mkdirSync(shots, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "harness-agents-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "harness-agents-project-"));
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  // Slow enough to see sub-agents running.
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DELAY_MS: "60" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "agents", key: "AGT" });
  for (const theme of ["light", "dark"] as const) {
    app = await launchApp({ baseUrl: base, token, theme });
    const a = app;
    await until("app connected", () => a.exists(".conn.on"), 15000);
    await checkAgentsTab({ api, app: a, check: c.check, project, shot: (name) => a.screenshot(join(shots, `${name}-${theme}.png`)) });
    app.close();
    app = null;
  }
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  app?.close();
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
console.log(c.failures ? `${c.failures} check(s) failed` : "all checks passed");
process.exit(c.failures ? 1 : 0);
