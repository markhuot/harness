// Project groups end to end in the built app, against the REAL service (throwaway HARNESS_HOME):
// project settings' Group field starts a group from a typed name and completes a prefix to an
// existing group on Enter; the sidebar lists the groups under All projects, alphabetically; a
// group's board shows only its projects' tickets (Done paged from the service, search narrowed to
// the group); the command palette goes to a group's board; and a project leaving its group leaves
// the board.
//
//   bun run build && bun scripts/groups-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-groups-home-");
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
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  await app.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = (name: string, key: string) => api<Project>("POST", "/projects", { path: tempDir(`harness-groups-${name}-`), name, key });
  const ticket = (p: Project, title: string) => api<Ticket>("POST", "/tickets", { projectId: p.id, spec: title, title, driver: "dummy", start: false });
  const alpha = await project("alpha", "ALPHA");
  const beta = await project("beta", "BETA");
  const gamma = await project("gamma", "GAMMA");
  const a1 = await ticket(alpha, "alpha planning");
  const a2 = await ticket(alpha, "alpha finished");
  await api("PATCH", `/tickets/${a2.key}`, { status: "done" });
  const b1 = await ticket(beta, "beta planning");
  const g1 = await ticket(gamma, "gamma planning");

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, key, type } = app;
  await until("sidebar shows the projects", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("gamma")`), 10000);
  const groupOf = async (p: Project) => (await api<Project[]>("GET", "/projects")).find((x) => x.id === p.id)?.group ?? null;

  /** Open a project's settings, type into the Group picker and press Enter. */
  const setGroup = async (p: Project, typed: string, shotName?: string) => {
    await go(`#/project/${p.id}/settings`);
    await until("group picker", () => exists('[data-testid="group-select"] button'), 10000);
    await js(`document.querySelector('[data-testid="group-select"] button').click()`);
    await until("group search", () => exists('input[aria-label="Search groups"]'));
    await type('input[aria-label="Search groups"]', typed);
    await Bun.sleep(100);
    const rows = await js<string[]>(`[...document.querySelectorAll('[aria-label="Groups"] [role=option]')].map(o => o.textContent)`);
    if (shotName) await shot(shotName);
    await key("Enter", "Enter", 13);
    return rows;
  };

  // 1. A new group from a typed name; a prefix completes to it.
  await setGroup(alpha, "Work");
  check("Enter on a new name starts that group", (await until("alpha in Work", async () => (await groupOf(alpha)) === "Work").catch(() => false)) === true, String(await groupOf(alpha)));
  const rows = await setGroup(beta, "wo", "groups-picker");
  check("a typed prefix lists the existing group first, then the typed name as new", rows[0] === "Work" && rows.some((r) => r.includes('New group "wo"')), JSON.stringify(rows));
  check("Enter on a prefix joins the group it completes to", (await until("beta in Work", async () => (await groupOf(beta)) === "Work").catch(() => false)) === true, String(await groupOf(beta)));
  await until("picker shows the group", () => js<boolean>(`document.querySelector('[data-testid="group-select"] button')?.textContent.includes("Work")`), 5000);
  await shot("groups-settings");
  await setGroup(gamma, "Personal");
  await until("gamma in Personal", async () => (await groupOf(gamma)) === "Personal");

  // 2. The sidebar lists the groups under All projects, alphabetically.
  await until("sidebar groups", () => js<boolean>(`document.querySelectorAll('[data-testid="nav-group"]').length === 2`), 5000);
  const nav = await js<string[]>(`[...document.querySelector(".sidebar .nav").querySelectorAll(".nav-item")].map(e => e.querySelector(".grow")?.textContent)`);
  check("groups follow All projects in alphabetical order", JSON.stringify(nav) === JSON.stringify(["Inbox", "All projects", "Personal", "Work"]), JSON.stringify(nav));

  // 3. A group's board: only its projects' tickets, Done included.
  await js(`[...document.querySelectorAll('[data-testid="nav-group"]')].find(e => e.textContent.includes("Work")).click()`);
  await until("group board", () => js<boolean>(`location.hash === "#/board/group/Work" && !!document.querySelector('[data-testid="pane-board"]')`), 10000);
  // The board on screen's cards (other boards' workspaces can stay mounted, hidden).
  const cards = () => js<string[]>(`[...document.querySelectorAll('.card[data-key]')].filter(c => c.offsetParent !== null).map(c => c.dataset.key)`);
  await until("group cards", async () => (await cards()).includes(a2.key), 10000).catch(() => {});
  const shown = await cards();
  check("the Work board shows alpha's and beta's tickets, Done included", [a1.key, a2.key, b1.key].every((k) => shown.includes(k)), JSON.stringify(shown));
  check("the Work board leaves out gamma's", !shown.includes(g1.key), JSON.stringify(shown));
  const title = await js<string>(`document.querySelector('[data-testid="pane-board"] .view-title')?.textContent ?? ""`);
  check("the board is titled with the group", title.includes("Work"), title);
  const active = await js<string>(`document.querySelector('.sidebar [aria-current=page]')?.textContent ?? ""`);
  check("the group is the sidebar's current item", active.includes("Work"), active);
  await shot("groups-board");

  // 4. Search on the group's board stays in the group.
  await type('[data-testid="board-search"]', "planning");
  await until("search results", () => js<boolean>(`/match/.test(document.querySelector('[data-testid="pane-board"]')?.textContent ?? "")`), 10000).catch(() => {});
  await Bun.sleep(400);
  const hits = await cards();
  check("searching the group's board finds its tickets only", hits.includes(a1.key) && hits.includes(b1.key) && !hits.includes(g1.key), JSON.stringify(hits));
  await type('[data-testid="board-search"]', "");

  // 5. The command palette goes to a group's board.
  await go("#/board/all");
  await until("all board", () => js<boolean>(`location.hash.startsWith("#/board/all")`), 5000);
  await key("k", "KeyK", 75, 4);
  await until("palette", () => exists("[data-testid=palette-input]"), 5000);
  await type("[data-testid=palette-input]", "board: pers");
  await until("palette row", () => js<boolean>(`[...document.querySelectorAll("[data-testid=palette-row]")].some(r => r.textContent.includes("Board: Personal"))`), 5000);
  await shot("groups-palette");
  await key("Enter", "Enter", 13);
  check("the palette's Board: Personal opens that group's board", await until("personal board", () => js<boolean>(`location.hash === "#/board/group/Personal"`), 5000).then(() => true, () => false));
  await until("only gamma's card", async () => (await cards()).join() === g1.key, 5000).catch(() => {});
  check("the Personal board shows gamma's ticket and no other", (await cards()).join() === g1.key, JSON.stringify(await cards()));
  await shot("groups-personal");

  // 6. Leaving the group takes the project's tickets off its board; the last project out removes it from the sidebar.
  await api("PATCH", `/projects/${gamma.id}`, { group: null });
  await until("gamma off Personal", async () => !(await cards()).includes(g1.key), 5000).catch(() => {});
  check("a project leaving its group leaves the group's board", !(await cards()).includes(g1.key), JSON.stringify(await cards()));
  const left = await until("sidebar drops Personal", () => js<boolean>(`[...document.querySelectorAll('[data-testid="nav-group"]')].map(e => e.textContent).join() === "Work"`), 5000).then(() => true, () => false);
  check("a group nobody carries leaves the sidebar", left);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
  await shot("groups-failure").catch(() => {});
  const text = await app?.js<string>(`document.querySelector(".main")?.innerText.slice(0, 1500) ?? ""`).catch(() => "");
  if (text) console.log(`--- on screen ---\n${text}`);
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall group checks passed");
process.exit(counter.failures ? 1 : 0);
