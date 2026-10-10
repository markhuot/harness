// The ticket pane's header against the REAL service (dummy driver, throwaway HARNESS_HOME): the
// title in the title bar (and truncated when the pane is narrow), no More menu up there, the key,
// status pill and model in the hero, and the hero's […] menu: Move to done, Cancel run while a run
// is busy, and Delete ticket. A screenshot of each state.
//
//   bun run build && bun scripts/ticket-header.ts [screenshotDir] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project, Ticket, TicketDetail } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots", "ticket-header"));
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
mkdirSync(shots, { recursive: true });

const home = tempDir("harness-header-home-");
const projectDir = tempDir("harness-header-project-");
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  // Slow runs, so a ticket stays busy long enough to open its menu.
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "500" },
  stdout: "ignore",
  stderr: "inherit",
});

const LONG = "Make the ticket's header shorter by moving the title to the top and tucking the rarely used actions into a menu";
const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  await Bun.sleep(400);
  await app!.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "hello", key: "HELLO" });
  app = await launchApp({ baseUrl: base, token, theme });
  const { js, exists, go, clickText, cdp } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("hello")`), 10000);
  const idle = (k: string) => until(`${k} idle`, async () => !(await api<TicketDetail>("GET", `/tickets/${k}`)).ticket.busy, 60000);
  const moreItems = async () => {
    await js(`document.querySelector(".actions [data-testid=ticket-more]").click()`);
    return until("the More menu", async () => {
      const t = await js<string[]>(`[...document.querySelectorAll(".menu button")].map(b => b.textContent.trim())`);
      return t.length > 0 && t;
    });
  };
  const closeMenu = async () => {
    await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await until("menu closed", async () => !(await exists(".menu")));
  };

  // Planning, idle: the title leads the pane, the hero starts with the key.
  const t1 = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: LONG, title: LONG, driver: "dummy", start: false });
  await idle(t1.key);
  await go(`#/board/${project.id}/ticket/${t1.key}`);
  await until("the hero", () => exists(".detail-hero"), 10000);
  const bar = await js<{ title: string; barText: string; more: boolean; heroFirst: string }>(`(() => {
    const bar = document.querySelector(".pane-ticket .detail-titlebar, .detail .detail-titlebar");
    return {
      title: bar.querySelector(".detail-title")?.textContent ?? "",
      barText: bar.textContent,
      more: !!bar.querySelector("button[title=More]"),
      heroFirst: [...document.querySelectorAll(".detail-meta > *")].slice(0, 3).map(e => e.textContent.trim()).join(" | "),
    };
  })()`);
  check("the title bar shows the ticket's title", bar.title === LONG, bar.title);
  check("the title bar has no key, status or More menu", !bar.barText.includes(t1.key) && !bar.more, bar.barText);
  check("the hero has no large title", !(await exists("h1.detail-title")));
  check("the hero's first row is the project, key, then status", /^\S+ \| HELLO-\d+ \| \S+/.test(bar.heroFirst), bar.heroFirst);
  const idleItems = await moreItems();
  check("an idle planning ticket's More menu: Move to done, Delete ticket", idleItems.join("|") === "Move to done|Delete ticket", idleItems.join("|"));
  await shot("more-planning");
  await closeMenu();

  // A narrow window: the long title truncates in the title bar instead of pushing the buttons out.
  await cdp("Emulation.setDeviceMetricsOverride", { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(300);
  const narrow = await js<{ clipped: boolean; buttonsInside: boolean }>(`(() => {
    const bar = document.querySelector(".detail .detail-titlebar");
    const t = bar.querySelector(".detail-title");
    const r = bar.getBoundingClientRect();
    const close = bar.querySelector("[data-testid=pane-close]").getBoundingClientRect();
    return { clipped: getComputedStyle(t).textOverflow === "ellipsis" && t.scrollWidth > t.clientWidth, buttonsInside: close.right <= r.right + 0.5 };
  })()`);
  check("a narrow pane truncates the title, with the pane buttons still inside", narrow.clipped && narrow.buttonsInside, JSON.stringify(narrow));
  await shot("narrow");
  await cdp("Emulation.clearDeviceMetricsOverride");

  // Busy: Cancel run joins the menu.
  const t2 = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Busy ticket", title: "Busy ticket", driver: "dummy", start: false });
  await idle(t2.key);
  await api("POST", `/tickets/${t2.key}/start`);
  await go(`#/board/${project.id}/ticket/${t2.key}`);
  await until("busy", async () => (await api<TicketDetail>("GET", `/tickets/${t2.key}`)).ticket.busy, 10000);
  const busyItems = await moreItems();
  check("a busy ticket's More menu adds Cancel run", busyItems.includes("Cancel run") && busyItems.includes("Move to done") && busyItems.at(-1) === "Delete ticket", busyItems.join("|"));
  check("the action row has no separate Cancel run button", await js<boolean>(`![...document.querySelectorAll(".actions > button")].some(b => b.textContent.includes("Cancel run"))`));
  check("a running ticket shows a disabled Working… button", await js<boolean>(`(() => { const b = document.querySelector(".actions [data-testid=working]"); return !!b && b.disabled && b.textContent.includes("Working"); })()`));
  await shot("more-busy");
  await closeMenu();

  // Review: Approve and friends first, then the […], without Move to done.
  await until("review", async () => (await api<TicketDetail>("GET", `/tickets/${t2.key}`)).ticket.status === "review", 120000);
  await idle(t2.key);
  await until("approve", () => exists("[data-testid=approve-primary]"), 10000);
  const reviewItems = await moreItems();
  check("in review the More menu is Re-run agent review, then Delete ticket", /^(Re-run|Run) agent review\|Delete ticket$/.test(reviewItems.join("|")), reviewItems.join("|"));
  check("…and the action row has no separate rerun button", await js<boolean>(`![...document.querySelectorAll(".actions > button")].some(b => /agent review/i.test(b.textContent))`));
  check("…and it's the last thing in the action row", await js<boolean>(`!!document.querySelector(".actions")?.lastElementChild?.querySelector("[data-testid=ticket-more]")`));
  await shot("more-review");
  await closeMenu();

  // Delete still confirms, then removes the ticket.
  await js(`window.confirm = () => true`);
  await go(`#/board/${project.id}/ticket/${t1.key}`);
  await moreItems();
  await clickText(".menu button", "Delete ticket");
  await until("deleted", async () => (await api<Ticket[]>("GET", "/tickets")).every((t) => t.key !== t1.key), 10000);
  check("Delete ticket removes the ticket", true);
} catch (e) {
  console.error(e);
  c.fail();
} finally {
  await app?.close();
  daemon.kill();
  await daemon.exited;
  cleanupTempDirs();
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall checks passed");
process.exit(c.failures ? 1 : 0);
