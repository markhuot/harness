// Torn-off tabs end to end in the built app, against the REAL service (throwaway HARNESS_HOME) and
// real headless Chrome: a dummy ticket's agent opens two browser tabs, then
//   1. Transcript is dragged off the ticket pane beside its Spec; the ticket pane keeps the tab
//      with a placeholder, and Return to this window brings it back;
//   2. the composer is torn off and a message is sent from it;
//   3. a setting is changed on a torn-off Details pane;
//   4. both browser tabs are torn off, and both canvases stream their own page side by side,
//      while the ticket's own Browser shows a placeholder over the canvas for a torn-off chip;
//   5. dragging out of the window opens pop-outs: from a tab, a card (a closed ticket and an open
//      one) and a pane grip; Return to this window closes a pop-out.
//
// Drags are synthesized in the page (DragEvent with a DataTransfer), which runs the same handlers
// a real drag does: dragstart on the source, dragover/drop on the workspace's drop layer, dragend
// with the drop's effect and the pointer's screen position. A drag "out of the window" is a dragend
// with dropEffect "none" and a screen point past the window's edge.
//
//   bun run build && bun scripts/tear-off-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket, TranscriptEntry } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-tear-home-");
const projectDir = tempDir("harness-tear-project-");
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "5" },
  stdout: "ignore",
  stderr: "inherit",
});

/** A page that fills the viewport with one colour, so a canvas tells which tab it shows. */
const page = (title: string, colour: string) =>
  `data:text/html,<title>${title}</title><body style="margin:0;height:100vh;background:${encodeURIComponent(colour)}"><h1>${title}</h1></body>`;

/** In the page: synthesize a harness drag from `src`, dropped on a pane's half, or let go outside the window. */
const DRAG_HELPER = `window.__drag = async (src, to) => {
  const el = typeof src === "string" ? document.querySelector(src) : src;
  if (!el) return "no source " + src;
  const dt = new DataTransfer();
  el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 80));
  if (to.out) {
    dt.dropEffect = "none";
    el.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt, screenX: window.screenX + window.outerWidth + 120, screenY: window.screenY + 140 }));
    return "out";
  }
  const pane = document.querySelector('[data-pane-id="' + to.pane + '"]');
  const layer = document.querySelector("[data-testid=pane-drop-layer]");
  if (!pane || !layer) return "no target";
  const r = pane.getBoundingClientRect();
  const x = r.left + r.width * to.fx, y = r.top + r.height * to.fy;
  layer.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  await new Promise((r) => setTimeout(r, 80));
  const preview = !!document.querySelector("[data-testid=pane-drop-preview]");
  layer.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  dt.dropEffect = "move";
  el.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt, screenX: window.screenX + x, screenY: window.screenY + y }));
  return preview ? "dropped" : "dropped without preview";
};`;

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "tear", key: "TEAR" });
  const calls = [
    { name: "browser_open", input: { url: page("Alpha", "#c33") } },
    { name: "browser_open", input: { url: page("Beta", "#3c3"), new_tab: true } },
  ];
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `/tools ${JSON.stringify(calls)}`, driver: "dummy", start: true });
  const other = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "A second ticket, never opened", driver: "dummy", start: false });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const a = app;
  const { js, go, frame, targets } = a;
  const shot = async (name: string) => {
    if (!shots) return;
    await Bun.sleep(500);
    await a.screenshot(join(shots, `${name}-${theme}.png`));
  };
  await until("app connected", () => a.exists(".conn.on"), 15000);
  await js(DRAG_HELPER);
  const drag = (src: string, to: { pane?: string; fx?: number; fy?: number; out?: boolean }) => js<string>(`window.__drag(${JSON.stringify(src)}, ${JSON.stringify(to)})`);
  const paneOf = (sel: string) => js<string | null>(`document.querySelector(${JSON.stringify(sel)})?.closest("[data-pane-id]")?.dataset.paneId ?? null`);
  const tornPane = (id: string) => js<string | null>(`document.querySelector('.pane-ticketTab [data-torn-tab=${JSON.stringify(id)}]')?.closest("[data-pane-id]")?.dataset.paneId ?? null`);
  // Single quotes inside, so these drop into double-quoted strings in the page's JS.
  const ticketPane = `.pane-ticket[data-pane-ticket='${ticket.key}']`;
  const tab = (t: string) => `${ticketPane} .tabs [data-tab='${t}']`;

  // The agent opens its two tabs first, so the browser has something to tear off.
  const current = async () => (await api<{ ticket: Ticket }>("GET", `/tickets/${ticket.key}`)).ticket;
  await until("the agent's run is over", async () => {
    const t = await current();
    return !t.busy && t.status === "review";
  }, 60000);
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("ticket pane", () => a.exists(tab("transcript")), 15000);
  const ticketPaneId = (await paneOf(ticketPane))!;

  // 1. Transcript off the ticket pane, beside its Spec.
  check("dragging Transcript onto the ticket pane's right half previews and drops", (await drag(tab("transcript"), { pane: ticketPaneId, fx: 0.9, fy: 0.5 })) === "dropped");
  const transcriptPane = await until("torn-off Transcript pane", () => tornPane("transcript"), 8000);
  check("the torn-off pane is slim: key and tab name, no tab strip", await js<boolean>(`(() => { const p = document.querySelector('[data-pane-id="${transcriptPane}"]');
    return p.querySelector("[data-testid=torn-tab-name]")?.textContent === "Transcript" && !p.querySelector(".tabs") && p.querySelector(".detail-key")?.textContent.includes(${JSON.stringify(ticket.key)}); })()`));
  check("it shows the transcript", await until("transcript in the torn-off pane", () => js<boolean>(`!!document.querySelector('[data-pane-id="${transcriptPane}"] .detail-body .transcript, [data-pane-id="${transcriptPane}"] .detail-body [data-testid=transcript]')`), 8000).catch(() => false));
  check("the ticket pane stays on the Spec beside it", await a.exists(`${tab("spec")}.on`));
  check("Transcript keeps its place in the strip with a torn-off mark", await a.exists(`${tab("transcript")} [data-testid=torn-mark]`));
  await shot("1-transcript-beside-spec");
  await js(`document.querySelector(${JSON.stringify(tab("transcript"))}).click()`);
  await until("placeholder", () => a.exists(`${ticketPane} [data-testid=torn-placeholder]`));
  check("selecting it shows where it went", (await js<string>(`document.querySelector("${ticketPane} [data-testid=torn-placeholder]").textContent`)).includes("Transcript is in another pane"));
  await shot("2-return-placeholder");
  await js(`document.querySelector("${ticketPane} [data-testid=torn-return]").click()`);
  await until("torn-off pane closed", async () => !(await tornPane("transcript")));
  check("Return to this window closes the pane and shows Transcript in the ticket", (await a.exists(`${tab("transcript")}.on`)) && !(await a.exists(`${ticketPane} [data-testid=torn-placeholder]`)));

  // 2. The composer, torn off below the ticket; a message sent from there.
  check("the composer's grip drags it off", (await drag(`${ticketPane} [data-testid=composer-grip]`, { pane: ticketPaneId, fx: 0.5, fy: 0.95 })) === "dropped");
  const composerPane = await until("torn-off composer", () => tornPane("composer"), 8000);
  check("the ticket shows a one-line Return to this window bar where the composer was", (await a.exists(`${ticketPane} [data-testid=composer-return]`)) && !(await a.exists(`${ticketPane} [data-testid=composer]`)));
  check("there's one composer for the ticket", (await js<number>(`document.querySelectorAll('[data-pane-ticket="${ticket.key}"] [data-testid=composer]').length`)) === 1);
  await a.type(`[data-pane-id="${composerPane}"] .composer-input`, "Sent from a torn-off composer");
  await js(`document.querySelector('[data-pane-id="${composerPane}"] [data-testid=composer-send]').click()`);
  const sent = await until(
    "the message reached the transcript",
    async () => (await api<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=0`)).some((e) => JSON.stringify(e.content).includes("Sent from a torn-off composer")),
    15000,
  ).catch(() => false);
  check("a message sent from the torn-off composer reaches the agent", !!sent);
  await shot("3-composer-torn-off");
  await js(`document.querySelector("${ticketPane} [data-testid=composer-return] [data-testid=torn-return]").click()`);
  await until("composer back", () => a.exists(`${ticketPane} [data-testid=composer]`));
  check("Return to this window puts the composer back in the ticket", !(await tornPane("composer")));

  // 3. Details torn off: its settings change the ticket.
  await drag(tab("details"), { pane: ticketPaneId, fx: 0.9, fy: 0.5 });
  const detailsPane = await until("torn-off Details", () => tornPane("details"), 8000);
  const skip = `[data-pane-id="${detailsPane}"] label.switch`;
  const before = (await current()).skipAgentReview ?? false;
  await until("Details settings", () => a.exists(skip));
  await js(`[...document.querySelectorAll(${JSON.stringify(skip)})].find(l => l.textContent.includes("Skip agent review")).querySelector("input").click()`);
  const flipped = await until("setting saved", async () => ((await current()).skipAgentReview ?? false) !== before, 8000).catch(() => false);
  check("Skip agent review switched on a torn-off Details pane saves to the ticket", !!flipped);
  await shot("4-details-torn-off");
  await js(`document.querySelector('[data-pane-id="${detailsPane}"] [data-testid=pane-close]').click()`);
  await until("Details closed", async () => !(await tornPane("details")));
  check("closing the torn-off pane any other way brings the tab back", !(await a.exists(`${tab("details")} [data-testid=torn-mark]`)));

  // 4. Both browser tabs torn off, streaming side by side.
  await js(`document.querySelector(${JSON.stringify(tab("browser"))}).click()`);
  const chip = (title: string) => `[data-pane-id="${ticketPaneId}"] .browser-tab-select[title^="${title}"]`;
  await until("the browser's two chips", () => js<number>(`document.querySelectorAll('[data-pane-id="${ticketPaneId}"] .browser-tab-select').length`).then((n) => n === 2), 30000);
  check("a browser chip drags off", (await drag(chip("Alpha"), { pane: ticketPaneId, fx: 0.9, fy: 0.5 })) === "dropped");
  const alphaPane = await until("Alpha's pane", () => tornPane("browser:1"), 8000);
  await drag(chip("Beta"), { pane: alphaPane, fx: 0.5, fy: 0.9 });
  const betaPane = await until("Beta's pane", () => tornPane("browser:2"), 8000);
  // Sampled at the canvas's centre: each tab keeps its own 1280 × 800, letterboxed into its pane.
  const tint = (paneId: string) =>
    js<string>(`(() => { const c = document.querySelector('[data-pane-id="${paneId}"] .browser-canvas'); if (!c || !c.width) return "";
      const d = c.getContext("2d").getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.5), 1, 1).data;
      return d[0] > 150 && d[1] < 100 ? "red" : d[1] > 150 && d[0] < 100 ? "green" : ""; })()`);
  const drawn = (paneId: string, colour: string) => until(`a ${colour} frame in ${paneId}`, async () => (await tint(paneId)) === colour, 20000).catch(() => false);
  check("the Alpha pane streams Alpha (red)", await drawn(alphaPane, "red"), await tint(alphaPane));
  check("the Beta pane streams Beta (green) at the same time", await drawn(betaPane, "green"), await tint(betaPane));
  check("…and Alpha still streams beside it", (await tint(alphaPane)) === "red");
  check("pinned panes have no chip strip", !(await a.exists(`[data-pane-id="${alphaPane}"] .browser-tabs`)) && !(await a.exists(`[data-pane-id="${betaPane}"] .browser-tabs`)));
  check(
    "pinned panes have no + (the ticket's Browser keeps it at the strip's end)",
    !(await a.exists(`[data-pane-id="${alphaPane}"] [data-testid=browser-new-tab]`)) &&
      !(await a.exists(`[data-pane-id="${betaPane}"] [data-testid=browser-new-tab]`)) &&
      (await a.exists(`[data-pane-id="${ticketPaneId}"] .browser-tab-strip > [data-testid=browser-new-tab]`)),
  );
  check("the header names the page", (await js<string>(`document.querySelector('[data-pane-id="${betaPane}"] .torn-browser-title')?.textContent ?? ""`)) === "Beta");
  check("the ticket's Browser covers a torn-off chip's canvas with the way back", await until("chip placeholder", () => a.exists(`[data-pane-id="${ticketPaneId}"] .browser-torn [data-testid=torn-return]`), 8000).catch(() => false));
  // Input goes to each viewer's own tab: a reload in Beta's pane leaves Alpha streaming.
  await js(`document.querySelector('[data-pane-id="${betaPane}"] .browser-bar button[title="Reload"]').click()`);
  check("after input in one pane, both still draw their own tab", (await drawn(betaPane, "green")) && (await tint(alphaPane)) === "red");
  await shot("5-two-browser-tabs");
  await js(`document.querySelector('[data-pane-id="${ticketPaneId}"] .browser-torn [data-testid=torn-return]').click()`);
  await until("a pinned pane returned", async () => !(await tornPane("browser:1")) || !(await tornPane("browser:2")));
  check("Return to this window on a chip closes its pane", true);

  // 5. Out of the window.
  const popouts = async () => (await targets("page", "#/popout/")).length;
  const popoutCount = await popouts();
  const openedPopout = async (what: string, n: number) => until(what, async () => (await popouts()) === n, 10000).catch(() => false);
  check("a tab dragged out of the window opens in a window of its own", (await drag(tab("activity"), { out: true })) === "out" && (await openedPopout("Activity pop-out", popoutCount + 1)));
  await until("Activity shows torn off in another window", () => a.exists(`${tab("activity")} [data-testid=torn-mark]`));
  const win = await frame("#/popout/", "page");
  await until("pop-out rendered", () => win.js<boolean>(`!!document.querySelector(".popout-window [data-torn-tab=activity]")`), 15000);
  check("the pop-out shows the torn-off Activity tab", true);
  if (shots) {
    const r = await win.cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, `6-activity-window-${theme}.png`), Buffer.from(r.result.data, "base64"));
  }
  await js(`document.querySelector(${JSON.stringify(tab("activity"))}).click()`);
  await until("window placeholder", () => js<boolean>(`document.querySelector("${ticketPane} [data-testid=torn-placeholder]")?.textContent.includes("in another window")`));
  check("its placeholder says it's in another window", true);
  await js(`document.querySelector("${ticketPane} [data-testid=torn-return]").click()`);
  check("Return to this window closes the pop-out", await openedPopout("Activity window closed", popoutCount));

  // A card whose ticket is closed opens it in a window; one whose ticket is open moves its pane.
  const card = (key: string) => `.pane-board .card[data-key="${key}"]`;
  await until("cards", () => a.exists(card(other.key)));
  await drag(card(other.key), { out: true });
  check("a closed ticket's card dragged out opens the ticket in a window", await openedPopout("card pop-out", popoutCount + 1));
  check("…without opening it on the board", !(await a.exists(`.pane-ticket[data-pane-ticket="${other.key}"]`)));
  await drag(card(ticket.key), { out: true });
  check("an open ticket's card dragged out moves its pane into a window", await openedPopout("open card pop-out", popoutCount + 2));
  check("…and it leaves the board", await until("ticket pane left", async () => !(await a.exists(ticketPane))).then(() => true, () => false));

  // A pane grip dragged out pops its pane out: a torn-off tab's here (the Beta tab still torn off, or Alpha).
  const pinnedLeft = (await tornPane("browser:2")) ?? (await tornPane("browser:1"));
  check("a torn-off pane is still on the board", !!pinnedLeft);
  await drag(`[data-pane-id="${pinnedLeft}"] [data-testid=pane-grip]`, { out: true });
  check("a pane grip dragged out pops its pane out", await openedPopout("grip pop-out", popoutCount + 3));
  check("…and it leaves the board", !(await a.exists(`[data-pane-id="${pinnedLeft}"]`)));
  await shot("7-after-drag-outs");
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
  if (app && shots) await app.screenshot(join(shots, "failure.png")).catch(() => {});
  const text = await app?.js<string>(`document.querySelector(".main")?.innerText.slice(0, 1500) ?? ""`).catch(() => "");
  if (text) console.log(`--- on screen ---\n${text}`);
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall tear-off checks passed");
process.exit(counter.failures ? 1 : 0);
