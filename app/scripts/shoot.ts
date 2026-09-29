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

// Child tickets are hidden by default; this opens the search options and flips the switch.
const showChildren = `document.querySelector("[data-testid=search-options]")?.click(); setTimeout(() => { document.querySelector("[data-testid=show-children]")?.click(); document.querySelector("[data-testid=search-options]")?.click(); }, 50)`;
const search = (q: string) =>
  `(() => { const el = document.querySelector("[data-testid=board-search]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
// Picks a project in the composer by key (the select is controlled, so set it the way React sees).
const pickProject = (key: string) =>
  `(() => { const el = document.querySelector(".project-picker select"); const opt = [...el.options].find((o) => o.textContent?.includes("(${key})")); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value); el.dispatchEvent(new Event("change", { bubbles: true })); })()`;
const collapseSidebar = `document.querySelector("[data-testid=sidebar-toggle]")?.click()`;
// The layout store follows storage events (another window, or this).
const layout = (l: object) =>
  `localStorage.setItem("harness.layout", ${JSON.stringify(JSON.stringify(l))}); dispatchEvent(new StorageEvent("storage", { key: "harness.layout" }))`;
// The pane store follows storage events too. Board | tickets, each ticket in its own pane, on the
// All projects board ("*": every board has its own panes).
const board = { type: "leaf", id: "b", content: { kind: "board" } };
const ticketPane = (id: string, ticketKey: string, tab = "summaries") => ({ type: "leaf", id, content: { kind: "ticket", ticketKey, tab } });
const panes = (children: object[], sizes: number[], focusedId: string) =>
  `localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": { root: { type: "split", id: "r", dir: "row", children, sizes }, focusedId, zoomedId: null } } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`;
// Starts dragging a card and holds it over a pane (fx/fy of the way across it) so the drop preview
// shows. executeJavaScript waits for the returned promise.
const holdDrag = (cardKey: string, paneId: string, fx: number, fy: number) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const dt = new DataTransfer();
  document.querySelector('.card[data-key="${cardKey}"]')?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await wait(100);
  const r = document.querySelector('[data-pane-id="${paneId}"]')?.getBoundingClientRect();
  if (r) document.querySelector("[data-testid=pane-drop-layer]")?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} }));
  await wait(300);
})()`;
// Opens the first watcher's edit form and keeps the Watchers section in view.
const editWatcher = `document.querySelector("#settings-watchers .settings-row button[title=Edit]")?.click(); setTimeout(() => document.getElementById("settings-watchers")?.scrollIntoView({ block: "start" }), 50)`;
// Opens the first watcher's edit form, then its Model combobox, typing `q` into the search.
const openModelCombo = (q: string) => `(async () => {
  ${editWatcher};
  let trigger = null;
  for (let i = 0; i < 40 && !trigger; i++) {
    await new Promise((r) => setTimeout(r, 100));
    trigger = document.querySelector("[data-testid=watcher-model] .model-combo-trigger");
  }
  trigger?.click();
  await new Promise((r) => setTimeout(r, 200));
  const input = document.querySelector(".model-combo-search");
  if (input && ${JSON.stringify(q)}) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
})()`;
// Opens the composer's first branch combobox (the ticket's branch), typing `q` into its search;
// with `pick`, then picks the first branch row.
const openBranchCombo = (q: string, pick = false) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let trigger = null;
  for (let i = 0; i < 40 && !trigger; i++) {
    await wait(100);
    trigger = document.querySelector(".new-session-branches [data-testid=branch-select] .model-combo-trigger");
  }
  trigger?.click();
  await wait(200);
  const input = document.querySelector(".branch-combo .model-combo-search");
  if (input && ${JSON.stringify(q)}) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await wait(400);
  if (${pick}) [...document.querySelectorAll(".branch-combo .model-combo-option")].find((o) => o.querySelector(".mono"))?.click();
})()`;
// Settings → Prompts: opens a prompt's editor and scrolls it into view; `then` runs after (with
// `area`, the editor's textarea, and `wait`), e.g. to type into it.
const openPrompt = (id: string, then = "") => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    await wait(100);
    row = document.querySelector('[data-prompt="${id}"]');
  }
  row?.click();
  await wait(200);
  const type = (el, text) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const area = () => document.querySelector("[data-testid=prompt-text]");
  ${then}
  await wait(150);
  row?.scrollIntoView({ block: "start" });
})()`;
const shots: { name: string; route: string; delay?: number; setup?: string }[] = [
  { name: "board", route: "#/board/all" },
  { name: "ticket", route: "#/board/all/ticket/NYTIMES-4" },
  { name: "plan", route: "#/board/all/ticket/NYTIMES-2" },
  { name: "transcript", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 4200 },
  { name: "blocked", route: "#/board/all/ticket/NYTIMES-3" },
  { name: "done", route: "#/board/all/ticket/NYTIMES-5" },
  { name: "reopen", route: "#/board/all/ticket/NYTIMES-5", setup: `[...document.querySelectorAll(".actions button")].find((b) => b.textContent?.includes("Re-open"))?.click()` },
  { name: "details", route: "#/board/all/ticket/HARNESS-1/details" },
  // A ticket in planning: its branch can still change (no worktree yet).
  { name: "details-planning", route: "#/board/all/ticket/NYTIMES-2/details" },
  { name: "browser", route: "#/board/all/ticket/NYTIMES-1/browser", delay: 3500 },
  { name: "inbox", route: "#/inbox" },
  { name: "inbox-watcher-error", route: "#/inbox", setup: `document.querySelector(".watcher-error")?.click()` },
  { name: "settings", route: "#/settings" },
  { name: "settings-general", route: "#/settings/general" },
  { name: "appearance", route: "#/settings/appearance" },
  { name: "watchers", route: "#/settings/watchers" },
  { name: "watcher-edit", route: "#/settings/watchers", setup: editWatcher },
  // The driver + model combobox open in the watcher form, then with a query typed.
  { name: "model-combobox-open", route: "#/settings/watchers", setup: openModelCombo("") },
  { name: "model-combobox-search", route: "#/settings/watchers", setup: openModelCombo("son") },
  { name: "project", route: `#/project/${hello}/settings` },
  { name: "approval", route: "#/board/all/ticket/HARNESS-9" },
  { name: "approval-config", route: "#/board/all/ticket/HARNESS-20" },
  { name: "compose", route: "#/compose" },
  { name: "compose-nogit", route: "#/compose", setup: pickProject("SITE") },
  // The composer with Skip agent review switched on.
  { name: "compose-skip-review", route: "#/compose", setup: `[...document.querySelectorAll(".new-session-options .switch")].find((l) => l.textContent === "Skip agent review")?.click()` },
  { name: "new-session", route: "#/compose", setup: `(async () => { let t = null; for (let i = 0; i < 40 && !t; i++) { await new Promise((r) => setTimeout(r, 100)); t = document.querySelector(".new-session-foot .model-combo-trigger"); } t?.click(); })()` },
  // The composer's branch picker with type-ahead open, then a branch checked out elsewhere picked.
  { name: "branch-picker", route: "#/compose", setup: openBranchCombo("de") },
  { name: "branch-picked", route: "#/compose", setup: openBranchCombo("medl", true) },
  { name: "branch-picker-new", route: "#/compose", setup: openBranchCombo("feature/new-login") },
  { name: "permissions", route: "#/settings/permissions" },
  // Prompts: the list, a built-in prompt, a customized one, a draft that doesn't validate, the
  // compare view, and a stored override that no longer validates (mock-service seeds both).
  { name: "prompts", route: "#/settings/prompts" },
  { name: "prompt-builtin", route: "#/settings/prompts", setup: openPrompt("system.work") },
  { name: "prompt-customized", route: "#/settings/prompts", setup: openPrompt("run.review") },
  { name: "prompt-invalid", route: "#/settings/prompts", setup: openPrompt("run.review", `type(area(), area().value.replace("{{brief}}", "{{breif}}"));`) },
  {
    name: "prompt-compare",
    route: "#/settings/prompts",
    setup: openPrompt("run.review", `document.querySelector("[data-testid=prompt-compare]")?.click();`),
  },
  { name: "prompt-broken", route: "#/settings/prompts", setup: openPrompt("system.files") },
  // Save and reset go through PATCH /settings and the reloaded catalog: Introduction turns
  // Customized, then back to Built-in (so the mock ends as it started for the next theme's shots).
  {
    name: "prompt-saved",
    route: "#/settings/prompts",
    setup: openPrompt(
      "system.intro",
      `[...document.querySelectorAll("[data-testid=prompt-editor] button")].find((b) => b.textContent?.includes("Customize"))?.click(); await wait(100); type(area(), area().value + "\\n\\nKeep replies short."); await wait(100); document.querySelector("[data-testid=prompt-save]")?.click(); await wait(600);`,
    ),
  },
  {
    name: "prompt-reset",
    route: "#/settings/prompts",
    setup: `window.confirm = () => true; ${openPrompt("system.intro", `[...document.querySelectorAll("[data-testid=prompt-editor] button")].find((b) => b.textContent?.includes("Reset"))?.click(); await wait(600);`)}`,
  },
  { name: "audit", route: "#/board/all/ticket/HARNESS-9/transcript" },
  { name: "streaming", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 700 },
  { name: "error", route: "#/board/all" },
  { name: "children", route: "#/board/all/ticket/HARNESS-1/children" },
  { name: "child", route: "#/board/all/ticket/HARNESS-6" },
  { name: "board-conductor", route: `#/board/${harness}`, setup: showChildren },
  { name: "board-hidden", route: `#/board/${harness}` },
  { name: "board-options", route: `#/board/${harness}`, setup: `document.querySelector("[data-testid=search-options]")?.click()` },
  { name: "board-search", route: "#/board/all", setup: search("the") },
  { name: "sidebar-collapsed", route: "#/board/all", setup: collapseSidebar },
  { name: "ticket-collapsed", route: "#/board/all/ticket/NYTIMES-4", setup: collapseSidebar },
  {
    name: "panel-resized",
    route: "#/board/all/ticket/HARNESS-1/children",
    setup: `${layout({ sidebarCollapsed: false, sidebarWidth: 280 })}; ${panes([board, ticketPane("t", "HARNESS-1", "children")], [0.3, 0.7], "t")}`,
  },
  {
    name: "split",
    route: "#/board/all/ticket/NYTIMES-3",
    delay: 3000,
    setup: panes([board, ticketPane("t1", "NYTIMES-4"), ticketPane("t2", "NYTIMES-3", "details")], [0.4, 0.3, 0.3], "t2"),
  },
  {
    // Mid-drag: a card held over the lower half of an open ticket, previewing a stacked split.
    name: "split-drop",
    route: "#/board/all/ticket/NYTIMES-4",
    setup: `${panes([board, ticketPane("t1", "NYTIMES-4")], [0.6, 0.4], "t1")}; ${holdDrag("NYTIMES-3", "t1", 0.5, 0.85)}`,
  },
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
