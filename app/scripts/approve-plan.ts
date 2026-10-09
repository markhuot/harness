// Approve plan end-to-end against a REAL daemon (temp HARNESS_HOME, dummy driver): press Start
// while the plan run is still going, see Starts after planning and the card clock, then watch
// the work start by itself when the run ends.
//
//   bun run build && bun scripts/approve-plan.ts [screenshotDir]
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "approve-plan"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-approve-home-");
const projectDir = tempDir("harness-approve-project-");
const port = 7900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "150" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "approve", key: "APR" });
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  await until("app connected", () => a.exists(".conn.on"), 15000);
  const t = await api<{ key: string }>("POST", "/tickets", { projectId: project.id, spec: "Write a greeting module", start: false, plan: true, driver: "dummy" });
  await a.js(`location.hash = "#/board/all/ticket/${t.key}"`);
  const label = () => a.js<string | null>(`document.querySelector(".actions .btn-primary")?.textContent?.trim() ?? null`);
  const btn = await until("Approve plan button", async () => ((await label()) === "Approve plan" ? true : undefined), 15000);
  c.check("while the plan runs, the button reads Approve plan", !!btn, String(await label()));
  await a.screenshot(join(shots, "1-approve-plan.png"));
  await a.js(`[...document.querySelectorAll(".actions .btn-primary")].find((b) => b.textContent.includes("Approve plan")).click()`);
  const approved = await until("Starts after planning", () => a.js<boolean>(`document.body.innerText.includes("Starts after planning")`), 10000);
  const mid = await api<{ ticket: { status: string; startAfterPlan: boolean } }>("GET", `/tickets/${t.key}`);
  c.check("pressing it keeps the ticket in planning, approved", approved && mid.ticket.status === "planning" && mid.ticket.startAfterPlan, JSON.stringify(mid.ticket));
  await a.screenshot(join(shots, "2-starts-after-planning.png"));
  await a.js(`location.hash = "#/board/all"`);
  await until("card", () => a.exists(`.card[data-key="${t.key}"]`));
  const clock = await a.exists(`.card[data-key="${t.key}"] [data-testid=card-plan-approved]`);
  c.check("the board card shows the clock", clock);
  await a.screenshot(join(shots, "3-board-clock.png"));
  const started = await until("work started", async () => {
    const d = await api<{ ticket: { status: string; startAfterPlan: boolean } }>("GET", `/tickets/${t.key}`);
    return d.ticket.status !== "planning" ? d.ticket : undefined;
  }, 30000);
  c.check("when the plan run ends the work starts on its own", started.status === "in_progress" || started.status === "review", started.status);
  await a.js(`location.hash = "#/board/all/ticket/${t.key}"`);
  await Bun.sleep(500);
  await a.screenshot(join(shots, "4-work-started.png"));
} catch (e) {
  console.error(e);
  c.fail();
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  daemon.kill();
  cleanupTempDirs();
}
console.log(c.failures ? `${c.failures} failed` : "all passed");
process.exit(c.failures ? 1 : 0);
