// A board card's right-click menu offers its ticket's own actions (state/ticketActions.ts), as
// the ticket's pane does, in the built app over the DevTools Protocol against the seeded world (the real daemon).
// The native menu can't be read (or captured) over CDP: HARNESS_MENU_LOG makes the main process record each
// menu's labels (a submenu's in brackets), and HARNESS_MENU_AUTOPICK picks an item without showing it.
//
//   bun run build && bun scripts/card-menu-check.ts [--shots=<dir>]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootWorld } from "./lib/world";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const world = await bootWorld();
const { base, token } = world;
const api = makeApi(base, token);
const counter = checker();
const { check } = counter;
const menuLog = `/tmp/harness-card-menu-${process.pid}.log`;
// "action:requestChanges" and "action:start" are a review card's and a planning card's own actions.
const app = await launchApp({ baseUrl: base, token, env: { HARNESS_MENU_LOG: menuLog, HARNESS_MENU_AUTOPICK: "action:requestChanges,action:start" } });
const { js, exists, clickText, screenshot } = app;

type Entry = string | [string, string[]];
const menus = () => (existsSync(menuLog) ? readFileSync(menuLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry[]) : []);
const names = (m: Entry[]) => m.map((i) => (Array.isArray(i) ? i[0] : i));
const rightClick = (key: string) => js(`document.querySelector('.card[data-key="${key}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
/** Right-click a card and wait for the menu it shows. */
const menuOf = async (key: string) => {
  const before = menus().length;
  await rightClick(key);
  return until(`${key}'s menu`, async () => menus().length > before && menus().at(-1)!);
};

try {
  const [project] = await api<{ id: string }[]>("GET", "/projects");
  const planned = await api<{ key: string }>("POST", "/tickets", { projectId: project!.id, spec: "Right-click me in planning", start: false });
  const reviewed = await api<{ key: string }>("POST", "/tickets", { projectId: project!.id, spec: "Right-click me in review", start: false });
  await api("PATCH", `/tickets/${reviewed.key}`, { status: "review" });
  // The daemon plans a new ticket first; wait for the runs to end, or Cancel run shows in place of Re-run agent review (and Approve plan for Start work).
  for (const { key } of [planned, reviewed]) await until(`${key} idle`, async () => !(await api<{ ticket: { busy: boolean } }>("GET", `/tickets/${key}`)).ticket.busy, 15000);
  await until("sidebar", () => exists(".card"), 15000);
  await js(`location.hash = "#/board/all"`);
  await until("both cards", async () => (await exists(`.card[data-key="${planned.key}"]`)) && (await exists(`.card[data-key="${reviewed.key}"]`)));
  await until("the review card in review", () => js<boolean>(`document.querySelector('.card[data-key="${reviewed.key}"]').closest(".column").querySelector(".column-title").textContent === "Review"`));

  const review = await menuOf(reviewed.key);
  {
    check("a review card's menu lists Open, then Approve, Request changes and the More items, then the splits", names(review).join("|").startsWith("Open|-|Approve|Request changes|Re-run agent review|Delete ticket|-|Open to the Right"), names(review).join("|"));
    const approve = review.find((i): i is [string, string[]] => Array.isArray(i))![1];
    check("Approve is a submenu of the ways to approve, taking no action after a separator", approve.at(-1) === "Approve and take no action" && approve.at(-2) === "-" && approve.some((l) => l.endsWith("…")), approve.join("|"));
    const notes = await until("Request changes (picked) opens the notes dialog", () => js<string | null>(`document.querySelector(".modal textarea")?.getAttribute("placeholder") ?? null`));
    check("picking Request changes opens the notes dialog on the board, without opening the ticket", notes === "What should the agent change?" && (await js<string>(`location.hash`)) === "#/board/all", String(notes));
    // A native menu can't be captured; the dialog its Request changes opens, over the board, can.
    await Bun.sleep(600);
    if (shots) await screenshot(join(shots, "mac-card-menu-request-changes.png"));
    await clickText(".modal-foot button", "Cancel");
    await until("dialog closed", async () => !(await exists(".modal")));

    const plan = await menuOf(planned.key);
    check("a planning card's menu offers Start work, Move to done and Delete ticket, and no review actions", names(plan).join("|").startsWith("Open|-|Start work|Move to done|Delete ticket|-|") && !names(plan).includes("Approve"), names(plan).join("|"));
    const started = await until("Start work (picked) starts the ticket", async () => (await api<{ ticket: { status: string } }>("GET", `/tickets/${planned.key}`)).ticket.status !== "planning", 10000);
    check("picking Start work from the card starts the ticket", started);
  }
} catch (e) {
  counter.fail();
  console.error("✗", (e as Error).message);
} finally {
  await app.close();
  await world.stop();
}
console.log(counter.failures ? `${counter.failures} check(s) failed` : "all checks passed");
process.exit(counter.failures ? 1 : 0);
