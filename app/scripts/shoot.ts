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
const mh = projects.find((p) => p.key === "MH")?.id ?? projects[0]!.id;

// Child tickets are hidden by default; this opens the search options and flips the switch.
const showChildren = `document.querySelector("[data-testid=search-options]")?.click(); setTimeout(() => { document.querySelector("[data-testid=show-children]")?.click(); document.querySelector("[data-testid=search-options]")?.click(); }, 50)`;
const search = (q: string) =>
  `(() => { const el = document.querySelector("[data-testid=board-search]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`;
// A New session pane's setup: waits for the draft editor, then runs `body` with helpers that always
// find the current editor (typing a prompt saves the draft, and its pane re-renders as the ticket's):
// draft() the pane, typeIn(text), pickProject(key), options() to toggle Options, wait(ms).
const inDraft = (body: string) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const draft = () => document.querySelector(".draft-pane");
  for (let i = 0; i < 40 && !draft()?.querySelector(".draft-prompt"); i++) await wait(100);
  const typeIn = async (text) => { const el = draft().querySelector(".draft-prompt"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); await wait(500); };
  const pickProject = async (key) => { const el = draft().querySelector(".project-picker select"); const opt = [...el.options].find((o) => o.textContent?.includes("(" + key + ")")); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value); el.dispatchEvent(new Event("change", { bubbles: true })); await wait(150); };
  const options = async () => { draft().querySelector("[data-testid=draft-options]")?.click(); await wait(250); };
  ${body}
})()`;
const collapseSidebar = `document.querySelector("[data-testid=sidebar-toggle]")?.click()`;
// The layout store follows storage events (another window, or this).
const layout = (l: object) =>
  `localStorage.setItem("harness.layout", ${JSON.stringify(JSON.stringify(l))}); dispatchEvent(new StorageEvent("storage", { key: "harness.layout" }))`;
// The pane store follows storage events too. Board | tickets, each ticket in its own pane, on the
// All projects board ("*": every board has its own panes).
const board = { type: "leaf", id: "b", content: { kind: "board" } };
const ticketPane = (id: string, ticketKey: string, tab = "spec") => ({ type: "leaf", id, content: { kind: "ticket", ticketKey, tab } });
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
// In a draft's Options (opened first), opens the Branch combobox, typing `q` into its search; with
// `pick`, then picks the first branch row.
const openBranchCombo = (q: string, pick = false) =>
  inDraft(`
  await pickProject("NYTIMES");
  await options();
  draft().querySelector("[data-testid=ticket-settings] [data-testid=branch-select] .model-combo-trigger")?.click();
  await wait(200);
  const input = document.querySelector(".branch-combo .model-combo-search");
  if (input && ${JSON.stringify(q)}) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await wait(400);
  if (${pick}) { [...document.querySelectorAll(".branch-combo .model-combo-option")].find((o) => o.querySelector(".mono"))?.click(); await wait(600); }
`);
// Opens the driver + model combobox inside `scope` once it renders.
const openCombo = (scope: string) => `(async () => {
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    await new Promise((r) => setTimeout(r, 100));
    t = document.querySelector(${JSON.stringify(`${scope} .model-combo-trigger`)});
  }
  t?.scrollIntoView({ block: "center" });
  t?.click();
})()`;

// Settings → Prompts: opens a prompt's editor and scrolls it into view; `then` runs after (with
// `area`, the editor's textarea, and `wait`), e.g. to type into it.
const openDriver = (id: string) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    await wait(100);
    row = document.querySelector('[data-driver-row="${id}"]');
  }
  row?.click();
  await wait(200);
  row?.scrollIntoView({ block: "start" });
})()`;
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
// Scrolls `sel` to the middle of its scroller once it renders.
const scrollToEl = (sel: string) => `(async () => {
  let el = null;
  for (let i = 0; i < 40 && !el; i++) {
    await new Promise((r) => setTimeout(r, 100));
    el = document.querySelector(${JSON.stringify(sel)});
  }
  el?.scrollIntoView({ block: "center" });
})()`;
const shots: { name: string; route: string; delay?: number; setup?: string }[] = [
  { name: "board", route: "#/board/all" },
  { name: "ticket", route: "#/board/all/ticket/NYTIMES-4" },
  { name: "spec-media", route: "#/board/all/ticket/HARNESS-2", setup: `setTimeout(() => document.querySelector("[data-testid=md-thumbs]")?.scrollIntoView({ block: "end" }), 300)` },
  { name: "spec-media-lightbox", route: "#/board/all/ticket/HARNESS-2", setup: `setTimeout(() => document.querySelector("[data-testid=md-thumbs] .md-media")?.click(), 300)` },
  { name: "plan", route: "#/board/all/ticket/NYTIMES-2" },
  { name: "transcript", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 4200 },
  { name: "blocked", route: "#/board/all/ticket/NYTIMES-3" },
  { name: "done", route: "#/board/all/ticket/NYTIMES-5" },
  { name: "reopen", route: "#/board/all/ticket/NYTIMES-5", setup: `[...document.querySelectorAll(".actions button")].find((b) => b.textContent?.includes("Re-open"))?.click()` },
  { name: "details", route: "#/board/all/ticket/HARNESS-1/details" },
  // A ticket in planning: its branch can still change (no worktree yet).
  { name: "details-planning", route: "#/board/all/ticket/NYTIMES-2/details" },
  // Its one Model combobox (driver + model) open.
  { name: "details-model", route: "#/board/all/ticket/NYTIMES-2/details", setup: openCombo(".props") },
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
  // New session: an empty New session pane beside the board, and one on a project that isn't git.
  { name: "compose", route: "#/compose", setup: inDraft(`await pickProject("NYTIMES");`) },
  { name: "compose-nogit", route: "#/compose", setup: inDraft(`await pickProject("SITE"); await options();`) },
  // HARNESS skips the human review by default: the switch starts on, and the summary stays empty.
  { name: "compose-review-defaults", route: "#/compose", setup: inDraft(`await pickProject("HARNESS"); await options();`) },
  { name: "permissions", route: "#/settings/permissions" },
  // Settings → Drivers: the driver list with the Default model under it, a driver opened into its
  // own settings (Anthropic API carries the API key), and the Default model combobox open.
  { name: "settings-drivers", route: "#/settings/drivers" },
  { name: "settings-driver-open", route: "#/settings/drivers", setup: openDriver("anthropic-api") },
  { name: "settings-models-open", route: "#/settings/drivers", setup: openCombo("[data-testid=default-model]") },
  { name: "project-model-open", route: `#/project/${hello}/settings`, setup: openCombo("[data-testid=project-models]") },
  // Prompts: the list, a built-in prompt, a customized one, a draft that doesn't validate, the
  // compare view, and a stored override that no longer validates (mock-service seeds both).
  { name: "prompts", route: "#/settings/prompts" },
  { name: "prompt-builtin", route: "#/settings/prompts", setup: openPrompt("system.work") },
  { name: "prompt-customized", route: "#/settings/prompts", setup: openPrompt("run.review") },
  { name: "prompt-invalid", route: "#/settings/prompts", setup: openPrompt("run.review", `type(area(), area().value.replace("{{key}}", "{{kye}}"));`) },
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
  // Remote IDs: the native MH-62 beside MH-124 and MH-130, both linked to Jira's MH-62.
  { name: "remote-ids", route: `#/board/${mh}` },
  { name: "remote-linked", route: `#/board/${mh}/ticket/MH-124/details`, setup: scrollToEl("[data-testid=external-row] .ticket-link") },
  { name: "remote-id-field", route: `#/board/${mh}/ticket/MH-130/details`, setup: scrollToEl("[data-testid=remote-id]") },
  { name: "remote-id-native", route: `#/board/${mh}/ticket/MH-62/details`, setup: scrollToEl("[data-testid=linked-row] .ticket-link") },
  // OPS-41 is only a remote ID: the pane lists the two tickets linked to it.
  { name: "remote-only", route: `#/board/${mh}/ticket/OPS-41` },
  { name: "board-conductor", route: `#/board/${harness}`, setup: showChildren },
  { name: "board-hidden", route: `#/board/${harness}` },
  { name: "board-options", route: `#/board/${harness}`, setup: `document.querySelector("[data-testid=search-options]")?.click()` },
  { name: "board-search", route: "#/board/all", setup: search("the") },
  // The command palette's boards: All projects (⌘1) beside each project's.
  {
    name: "palette-boards",
    route: `#/board/${harness}`,
    setup: `dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", key: "k", metaKey: true, bubbles: true })); setTimeout(() => { const el = document.querySelector("[data-testid=palette] input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "board"); el.dispatchEvent(new Event("input", { bubbles: true })); }, 300)`,
  },
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
  // Drafts last: these save drafts in the mock, which the shots above shouldn't show.
  // A saved draft with Options open (Skip agent review on), and its Model combobox open.
  {
    name: "draft-options",
    route: "#/compose",
    setup: inDraft(`await pickProject("NYTIMES"); await typeIn("Try a darker masthead on the opinion pages"); await options(); [...draft().querySelectorAll(".switch")].find((l) => l.textContent === "Skip agent review")?.click(); await wait(600);`),
  },
  { name: "new-session", route: "#/compose", setup: inDraft(`await pickProject("NYTIMES"); await options(); draft().querySelector("[data-testid=ticket-settings] .model-combo-trigger")?.click();`) },
  // The Branch picker with type-ahead open, a new name typed, then a branch checked out in another worktree (the warning).
  { name: "branch-picker", route: "#/compose", setup: openBranchCombo("de") },
  { name: "branch-picker-new", route: "#/compose", setup: openBranchCombo("feature/new-login") },
  { name: "branch-warning", route: "#/compose", setup: openBranchCombo("medl", true) },
  // A draft beside a launched ticket.
  {
    name: "draft-beside-ticket",
    route: "#/board/all/ticket/NYTIMES-4",
    setup: `${panes([board, ticketPane("t1", "NYTIMES-4")], [0.5, 0.5], "t1")}; setTimeout(() => (location.hash = "#/compose"), 300); ${inDraft(`await wait(400); await pickProject("NYTIMES"); await typeIn("Add a print stylesheet for recipe cards");`)}`,
  },
  // Closing a draft with something in it asks first.
  { name: "draft-close", route: "#/compose", setup: inDraft(`await pickProject("NYTIMES"); await typeIn("Audit the cookie banner copy"); draft().querySelector("[data-testid=pane-close]")?.click();`) },
  // The drafts above, as cards in Planning.
  { name: "draft-card", route: "#/board/all", setup: `setTimeout(() => document.querySelector(".card.draft")?.scrollIntoView({ block: "center" }), 300)` },
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
