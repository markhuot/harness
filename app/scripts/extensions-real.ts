// Settings → Extensions and the browser's extensions menu end-to-end against a REAL daemon, real
// headless Chrome and the real Chrome Web Store (temp HARNESS_HOME, random port; never ~/.harness).
// Installs React Developer Tools while a ticket's tab is open (so it waits for a restart), restarts
// the browser, runs its toolbar button from the ticket's browser (its popup opens as a tab), turns
// it off and removes it. On a Mac whose Chrome policy blocks extensions it doesn't list, it also
// checks that Dark Reader is refused.
//
//   bun run build && bun scripts/extensions-real.ts [screenshotDir]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserExtensionList, Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const REACT = "fmkadmapgofadopljbjfkapdkoienihi";
const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
const managed = existsSync("/Library/Managed Preferences/com.google.Chrome.plist");

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "extensions-real"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-ext-home-");
const projectDir = tempDir("harness-ext-project-");
const port = 7900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;

const pages = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(`<!doctype html><title>Plain page</title><body style="font:16px system-ui;padding:40px"><h1>A page without React</h1>`, { headers: { "content-type": "text/html" } }),
});

const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "5" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const list = () => api<BrowserExtensionList>("GET", "/browser-extensions");
  const statusOf = async (id: string) => (await list()).extensions.find((e) => e.id === id)?.status;
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "ext", key: "EXT" });
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  const { js } = a;
  const shot = (name: string) => a.screenshot(join(shots, `${name}.png`));
  await until("app connected", () => a.exists(".conn.on"), 15000);
  // Confirmations (Restart browser, Remove) answer yes.
  await js(`window.confirm = () => true`);

  // A ticket with a page open, so the browser is busy when the extension is added.
  const calls = [{ name: "browser_open", input: { url: `http://127.0.0.1:${pages.port}/` } }];
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `/tools ${JSON.stringify(calls)}`, driver: "dummy", start: true });
  await until("the ticket's page", async () => (await api<{ url: string } | null>("GET", `/browser/${ticket.sessionId}`))?.url.includes(String(pages.port)), 30000);

  // Let a new profile fetch its organization's policy before asking the store about it.
  if (managed) await until("Chrome's cached policy", async () => existsSync(join(home, "chrome-profile", "Policy", "Machine Level User Cloud Policy")), 20000);

  await a.go("#/settings/extensions");
  await until("extensions section", () => a.exists("[data-testid=extensions-section]"), 10000);
  await Bun.sleep(500);
  await shot("1-empty");

  // 1. Added from its Web Store link while a page is open: it waits for the browser to restart.
  await a.type("[data-testid=extensions-webstore]", `https://chromewebstore.google.com/detail/react-developer-tools/${REACT}`);
  await js(`document.querySelector("[data-testid=extensions-add]").click()`);
  const row = (id: string) => `[data-testid=extension-row][data-id="${id}"]`;
  await until("React Developer Tools row", () => a.exists(row(REACT)), 30000);
  check("a Web Store extension added while a tab is open waits for a restart", (await statusOf(REACT)) === "pending" && (await a.exists("[data-testid=extensions-waiting]")), String(await statusOf(REACT)));
  await shot("2-waiting");

  // 2. Restart browser installs it.
  await js(`document.querySelector("[data-testid=extensions-restart]").click()`);
  await until("installed", () => a.exists(`${row(REACT)}[data-status=loaded]`), 60000).catch(() => {});
  check("Restart browser installs it", (await statusOf(REACT)) === "loaded", String(await statusOf(REACT)));
  check("its name and version come from Chrome's install", /React Developer Tools\s*\d+\.\d+/.test(await js<string>(`document.querySelector(${JSON.stringify(row(REACT))}).textContent`)));
  await shot("3-installed");

  // 3. Dark Reader isn't on the organization's allowlist: refused, nothing added.
  if (managed) {
    await a.type("[data-testid=extensions-webstore]", DARK_READER);
    await js(`document.querySelector("[data-testid=extensions-add]").click()`);
    await until("refusal", () => a.exists("[data-testid=extensions-add-error]"), 30000).catch(() => {});
    const err = await js<string>(`document.querySelector("[data-testid=extensions-add-error]")?.textContent ?? ""`);
    check("an extension the policy doesn't allow is refused, and says so", err.includes("policy") && !(await a.exists(row(DARK_READER))), err);
    await shot("4-blocked");
  }

  // 4. The ticket's browser: the puzzle menu runs its toolbar button, and the popup opens as a tab.
  await a.go(`#/board/${project.id}/ticket/${ticket.key}/browser`);
  await until("browser bar", () => a.exists("[data-testid=browser-extensions]:not([disabled])"), 30000);
  await Bun.sleep(1500); // the page reloaded after the restart; the extension sees it
  await js(`document.querySelector("[data-testid=browser-extensions]").click()`);
  await until("menu item", () => a.exists(`[data-testid=browser-extension-action][data-id="${REACT}"]`), 10000);
  await shot("5-menu");
  await js(`document.querySelector('[data-testid=browser-extension-action][data-id="${REACT}"]').click()`);
  const popupShown = await until("the popup tab", async () => (await js<string>(`document.querySelector(".browser-url-input")?.value ?? ""`)).startsWith(`chrome-extension://${REACT}/`), 15000).then(
    () => true,
    () => false,
  );
  check("its popup opens as a tab, and the view switches to it", popupShown, await js<string>(`document.querySelector(".browser-url-input")?.value ?? ""`));
  await Bun.sleep(1500);
  await shot("6-popup");

  // 5. Off, then removed.
  await a.go("#/settings/extensions");
  await until("row", () => a.exists(row(REACT)), 10000);
  await js(`document.querySelector(${JSON.stringify(`${row(REACT)} [role=switch]`)}).click()`);
  await until("off", () => a.exists(`${row(REACT)}[data-status=off]`), 15000).catch(() => {});
  check("its switch turns it off", (await statusOf(REACT)) === "off", String(await statusOf(REACT)));
  await shot("7-off");
  await js(`document.querySelector(${JSON.stringify(`${row(REACT)} [aria-label^=Remove]`)}).click()`);
  await until("removed", async () => !(await a.exists(row(REACT))), 15000).catch(() => {});
  check("Remove takes it out of the list", !(await a.exists(row(REACT))) && (await statusOf(REACT)) === undefined);
} catch (e) {
  console.error(e);
  c.fail();
} finally {
  await app?.close();
  daemon.kill();
  await daemon.exited;
  pages.stop(true);
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall checks passed");
process.exit(c.failures ? 1 : 0);
