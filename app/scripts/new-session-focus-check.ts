// The New session pane from the keyboard, in the built app against the REAL service (throwaway
// HARNESS_HOME, dummy driver):
//   1. changing the project from the keyboard keeps the focus on the project picker, before the
//      draft is saved, as the change saves it, and when it moves a saved draft to another project
//      (its key changes);
//   2. Shift+Tab from the prompt reaches the project picker first, then Task | Conductor, which is
//      a single tab stop whose arrow keys change the kind, while the picker still shows left of it.
//
//   bun run build && bun scripts/new-session-focus-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-nsfocus-home-");
const dirA = tempDir("harness-nsfocus-a-");
const dirB = tempDir("harness-nsfocus-b-");

const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1" },
  stdout: "ignore",
  stderr: "inherit",
});

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  await api<Project>("POST", "/projects", { path: dirA, name: "alpha", key: "ALP" });
  await api<Project>("POST", "/projects", { path: dirB, name: "beta", key: "BET" });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, key } = app;
  await until("sidebar shows the projects", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("beta")`), 10000);

  const pane = '[data-testid="draft-pane"]';
  const select = `${pane} .project-picker select`;
  const active = () =>
    js<string>(`(() => { const a = document.activeElement; if (!a || a === document.body) return "body";
      if (a.matches(${JSON.stringify(select)})) return "project";
      if (a.matches(".draft-prompt")) return "prompt";
      if (a.closest('[data-testid="draft-kind"]')) return "kind:" + a.textContent.trim();
      return a.tagName + "." + a.className; })()`);
  const kind = () => js<string>(`[...document.querySelectorAll('${pane} [data-testid="draft-kind"] [role=radio]')].find(b => b.getAttribute("aria-checked") === "true")?.textContent.trim() ?? ""`);
  /** Pick a project the way the keyboard does: the focused select's value changes, then "change". */
  const pick = (k: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(select)}); el.focus(); window.__picker = el; window.__pane = document.querySelector(${JSON.stringify(pane)}); const opt = [...el.options].find((o) => o.textContent.includes("(${k})"));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const draftKey = () => js<string | null>(`document.querySelector(${JSON.stringify(pane)})?.dataset.draftKey ?? null`);
  /** What's left of the editor the last pick was made in (a remount replaces it). */
  const kept = () => js<string>(`JSON.stringify({ picker: window.__picker?.isConnected, pane: window.__pane?.isConnected })`);
  const shiftTab = () => key("Tab", "Tab", 9, 8);
  const tab = () => key("Tab", "Tab", 9);

  await go("#/compose");
  await until("New session pane", () => exists(`${pane} .draft-prompt`), 10000);
  await until("the prompt has the focus", async () => (await active()) === "prompt", 5000).catch(() => null);
  check("the New session pane focuses the prompt", (await active()) === "prompt", await active());

  // --- 1. The project picker keeps the focus.
  const picked = async (what: string, detail: string) => {
    await Bun.sleep(800);
    const where = await active();
    check(`${what} keeps the focus on the picker`, where === "project", `${detail}: ${where} ${await kept()}`);
  };
  // Nothing typed yet: a project change alone doesn't save the New session.
  await pick("BET");
  await picked("changing the project of an empty New session", "unsaved");
  check("…and doesn't save it", (await draftKey()) === null);
  // Typed in, then the project changes at once: the change goes with (or right after) the first save.
  await app.type(`${pane} .draft-prompt`, "Keep the focus where it was");
  await pick("ALP");
  await until("the draft is saved", draftKey, 10000);
  await picked("changing the project as the New session is saved", `${await draftKey()}`);
  // A saved draft moves to another project: its key changes.
  await pick("BET");
  await until("the draft moves to BET", async () => (await draftKey())?.startsWith("BET-"), 10000);
  await picked("moving a saved draft to another project", `${await draftKey()}`);
  await pick("ALP");
  await until("the draft moves back to ALP", async () => (await draftKey())?.startsWith("ALP-"), 10000);
  await picked("…and back again", `${await draftKey()}`);
  if (shots) await app.screenshot(join(shots, `mac-new-session-project-focus-${theme}.png`));
  await js(`document.querySelector('${pane} .draft-prompt').focus()`);

  // --- 2. Tab order and the Task | Conductor radio group.
  await shiftTab();
  check("Shift+Tab from the prompt focuses the project picker", (await active()) === "project", await active());
  await shiftTab();
  check("a second Shift+Tab focuses Task | Conductor (the checked one)", (await active()) === "kind:Task", await active());
  await shiftTab();
  check("a third Shift+Tab leaves the New session's body", !["project", "prompt"].includes(await active()) && !(await active()).startsWith("kind:"), await active());
  await tab();
  check("Tab comes back to Task | Conductor", (await active()) === "kind:Task", await active());
  await tab();
  check("Tab from Task | Conductor goes to the project picker (one stop for the toggle)", (await active()) === "project", await active());
  await tab();
  check("…then to the prompt", (await active()) === "prompt", await active());
  const layout = await js<{ picker: number; kind: number }>(`({ picker: document.querySelector('${pane} .project-picker').getBoundingClientRect().left, kind: document.querySelector('${pane} [data-testid="draft-kind"]').getBoundingClientRect().left })`);
  check("the project picker still shows left of Task | Conductor", layout.picker < layout.kind, JSON.stringify(layout));
  await shiftTab();
  await shiftTab();
  await key("ArrowRight", "ArrowRight", 39);
  await until("Conductor checked", async () => (await kind()) === "Conductor", 3000).catch(() => null);
  check("→ on Task | Conductor picks Conductor and moves the focus to it", (await kind()) === "Conductor" && (await active()) === "kind:Conductor", `${await kind()} / ${await active()}`);
  if (shots) await app.screenshot(join(shots, `mac-new-session-kind-${theme}.png`));
  await key("ArrowLeft", "ArrowLeft", 37);
  await until("Task checked", async () => (await kind()) === "Task", 3000).catch(() => null);
  check("← picks Task again", (await kind()) === "Task" && (await active()) === "kind:Task", `${await kind()} / ${await active()}`);
  await key("ArrowDown", "ArrowDown", 40);
  await until("Conductor checked", async () => (await kind()) === "Conductor", 3000).catch(() => null);
  check("↓ picks Conductor too", (await kind()) === "Conductor", await kind());
  await key("ArrowUp", "ArrowUp", 38);
  await until("Task checked", async () => (await kind()) === "Task", 3000).catch(() => null);
  check("↑ picks Task", (await kind()) === "Task", await kind());
  check("Task | Conductor has one tab stop", await js<boolean>(`[...document.querySelectorAll('${pane} [data-testid="draft-kind"] [role=radio]')].filter(b => b.tabIndex === 0).length === 1`));
} catch (e) {
  console.error(e);
  counter.fail();
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall checks passed");
process.exit(counter.failures ? 1 : 0);
