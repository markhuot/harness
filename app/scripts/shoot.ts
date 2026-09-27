// Visual check: boot the mock service, launch the built app against it once per route/theme and
// capture the window via webContents.capturePage (HARNESS_CAPTURE, see src/main/main.ts).
//
//   bun scripts/shoot.ts [outDir] [--only=board-light,ticket-dark] [--themes=harness-dark,catppuccin-mocha]
//
// --themes takes color theme ids (default: harness-light,harness-dark, saved as -light / -dark);
// other themes are saved as <shot>-<theme id>.png.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findTheme } from "@harness/shared/themes";

const appDir = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const themeIds = process.argv.find((a) => a.startsWith("--themes="))?.slice(9).split(",") ?? ["harness-light", "harness-dark"];
const unknown = themeIds.filter((id) => !findTheme(id));
if (unknown.length) throw new Error(`unknown theme ids: ${unknown.join(", ")}`);
const themeLabel = (id: string) => (id === "harness-light" ? "light" : id === "harness-dark" ? "dark" : id);
mkdirSync(outDir, { recursive: true });

const port = 7700 + Math.floor(Math.random() * 90);
const token = "shoot-token";
const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token },
  stdout: "ignore",
  stderr: "inherit",
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(base + "/health")).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const projects = (await (await fetch(base + "/projects", { headers: { authorization: `Bearer ${token}` } })).json()).data as { id: string; key: string }[];
const hello = projects.find((p) => p.key === "HELLOHARNESS")?.id ?? projects[0]!.id;
const harness = projects.find((p) => p.key === "HARNESS")?.id ?? projects[0]!.id;

// Child tickets are hidden by default; this flips the toolbar switch to show them.
const showChildren = `document.querySelector("[data-testid=show-children]")?.click()`;
const search = (q: string) =>
  `(() => { const el = document.querySelector("[data-testid=board-search]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const collapseSidebar = `document.querySelector("[data-testid=sidebar-toggle]")?.click()`;
// The layout store follows storage events (another window, or this).
const layout = (l: object) =>
  `localStorage.setItem("harness.layout", ${JSON.stringify(JSON.stringify(l))}); dispatchEvent(new StorageEvent("storage", { key: "harness.layout" }))`;
const shots: { name: string; route: string; delay?: number; setup?: string }[] = [
  { name: "board", route: "#/board/all" },
  { name: "ticket", route: "#/board/all/ticket/NYTIMES-4" },
  { name: "transcript", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 4200 },
  { name: "blocked", route: "#/board/all/ticket/NYTIMES-3" },
  { name: "details", route: "#/board/all/ticket/HARNESS-1/details" },
  { name: "browser", route: "#/board/all/ticket/NYTIMES-1/browser", delay: 3500 },
  { name: "inbox", route: "#/inbox" },
  { name: "settings", route: "#/settings" },
  { name: "appearance", route: "#/settings/appearance" },
  { name: "project", route: `#/project/${hello}/settings` },
  { name: "approval", route: "#/board/all/ticket/HARNESS-9" },
  { name: "compose", route: "#/compose" },
  { name: "permissions", route: "#/settings/permissions" },
  { name: "audit", route: "#/board/all/ticket/HARNESS-9/transcript" },
  { name: "streaming", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 700 },
  { name: "error", route: "#/board/all" },
  { name: "children", route: "#/board/all/ticket/HARNESS-1/children" },
  { name: "child", route: "#/board/all/ticket/HARNESS-6" },
  { name: "board-conductor", route: `#/board/${harness}`, setup: showChildren },
  { name: "board-hidden", route: `#/board/${harness}` },
  { name: "board-search", route: "#/board/all", setup: search("the") },
  { name: "sidebar-collapsed", route: "#/board/all", setup: collapseSidebar },
  { name: "ticket-collapsed", route: "#/board/all/ticket/NYTIMES-4", setup: collapseSidebar },
  { name: "panel-resized", route: "#/board/all/ticket/HARNESS-1/children", setup: layout({ sidebarCollapsed: false, sidebarWidth: 280, detailWidth: 860 }) },
];

const electron = join(appDir, "..", "node_modules", ".bin", "electron");
try {
  for (const themeId of themeIds) {
    const theme = themeLabel(themeId);
    for (const s of shots) {
      const name = `${s.name}-${theme}`;
      if (only && !only.includes(name) && !only.includes(s.name)) continue;
      const file = join(outDir, `${name}.png`);
      const env: Record<string, string | undefined> = {
        ...process.env,
        HARNESS_URL: base,
        HARNESS_TOKEN: token,
        HARNESS_THEME_ID: themeId,
        HARNESS_ROUTE: s.route,
        HARNESS_CAPTURE: file,
        HARNESS_CAPTURE_DELAY: String(s.delay ?? 2500),
        ...(s.setup ? { HARNESS_CAPTURE_SETUP: s.setup } : {}),
      };
      if (s.name === "error") {
        // Exercise the real ensure path against a repo root with no service in it.
        delete env.HARNESS_URL;
        delete env.HARNESS_TOKEN;
        env.HARNESS_REPO_ROOT = "/nonexistent/harness";
      }
      const p = Bun.spawn([electron, appDir], { env, stdout: "inherit", stderr: "inherit" });
      const timer = setTimeout(() => p.kill(), 20_000);
      await p.exited;
      clearTimeout(timer);
    }
  }
} finally {
  mock.kill();
}
console.log(`screenshots in ${outDir}`);
