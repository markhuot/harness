// Git plugin end-to-end against a REAL daemon (temp HARNESS_HOME, random port; never ~/.harness):
// a dummy ticket edits its worktree, the Changes tab shows it in light and dark, then refreshes live.
//
//   bun run build && bun scripts/changes.ts [screenshotDir]
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";
import { checkChangesTab } from "./lib/changes-check";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "changes"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-changes-home-");
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DELAY_MS: "5" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  await until("app connected", () => a.exists(".conn.on"), 15000);
  const setTheme = async (t: "light" | "dark") => {
    await a.js(`window.harness.setTheme(${JSON.stringify(t)})`);
    await until(`app theme ${t}`, () => a.js<boolean>(`document.documentElement.dataset.theme === ${JSON.stringify(t)}`));
  };
  await setTheme("light");
  await checkChangesTab({
    api,
    app: a,
    check: c.check,
    shot: async (name) => {
      const theme = await a.js<string>(`document.documentElement.dataset.theme`);
      await a.screenshot(join(shots, `${name.replace(/-dark$/, "")}-${theme}.png`));
    },
    setTheme,
  });
  // Dark again for a final wide shot of the live-refreshed state.
  await setTheme("dark");
  await Bun.sleep(900);
  await a.screenshot(join(shots, "10-changes-live-dark.png"));
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  await app?.close();
  daemon.kill();
  await daemon.exited;
  // HARNESS_HOME and the seeded repo, now that nothing writes into them (and tempDir's exit
  // listener covers a crash).
  await cleanupTempDirs();
}
console.log(c.failures ? `${c.failures} check(s) failed` : "all checks passed");
process.exit(c.failures ? 1 : 0);
