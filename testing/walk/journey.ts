// The walkthrough's journey: one daemon, the Mac app, an iPhone and an iPad, nine steps that each
// build on the last: the app's basics (1 to 7), then the chief of staff (8a). Each step is something
// only the real apps together can show; the logic behind it is tested at the lower layers. It runs
// inside both simulator locks (walk/run.ts takes them), with the two UDIDs in WALK_IPHONE_UDID and
// WALK_IPAD_UDID. Every step waits on something observable (a /ws event, a DOM change, an
// accessibility label, a process's output) and every wait has a deadline. Nothing types into the Mac
// app but the file palette's query: tickets, chief messages and the shell's command go in through the API.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cos, Ticket } from "@harness/shared";
import { buildPairUrl } from "../../shared/src/pairing";
import { MOD } from "../lib/cdp";
import { startDaemon, type Daemon, type Socket } from "../lib/daemon";
import { columnCount, keyboardClearance, phone, screenState, type Phone } from "../lib/ios";
import { launchMac, type MacApp } from "../lib/mac";
import { killRecords, RunFile } from "../lib/procs";
import { until } from "../lib/wait";
import {
  COS_BLOCKED_SPEC,
  COS_BUILD_TITLE,
  COS_GROUP,
  COS_SPIKE_TITLE,
  EDIT_TEXT,
  EDITED_FILE,
  TERMINAL_ANSWER,
  TERMINAL_COMMAND,
  DUMMY_DONE_NOTE,
  DUMMY_HELLO,
  WALK_FILES,
  WALK_PROJECT,
  WALK_TICKET,
} from "../world/walk";

export interface Ctx {
  dir: string;
  repo: string;
  runs: RunFile;
  shots: string;
  daemon: Daemon;
  ws: Socket;
  mac: MacApp;
  phones: Phone[];
  projectId: string;
  /** The terminal's id, once step 6 opened it. */
  terminalId: string;
  /** Step 8a's world: the walk project's group, whose chief it opens. */
  cos: { groupId: string };
}

export interface Step {
  name: string;
  run(ctx: Ctx): Promise<void>;
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=walk", "-c", "user.email=walk@example.com", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

/** A checkout the project points at: the world's files in one commit on main. */
function seedRepo(dir: string): string {
  const repo = join(dir, "repo");
  for (const [path, text] of Object.entries(WALK_FILES)) {
    const file = join(repo, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

export interface Start {
  out: string;
  macUserData: string;
  phones: { name: "iPhone" | "iPad"; udid: string }[];
}

export async function begin(start: Start, runs: RunFile): Promise<Ctx> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-walk-")));
  const ctx: Ctx = {
    dir,
    repo: "",
    runs,
    shots: start.out,
    // Set as setup gets to them; teardown skips the ones a failed setup never reached.
    daemon: undefined as never,
    ws: undefined as never,
    // Step 1 launches it.
    mac: undefined as never,
    phones: start.phones.map((p) => phone(p.name, p.udid)),
    projectId: "",
    terminalId: "",
    cos: { groupId: "" },
  };
  try {
    ctx.repo = seedRepo(dir);
    ctx.daemon = await startDaemon(runs, join(dir, "home"));
    // Every phase of every run goes to the dummy driver; the default would be a real agent.
    const phase = { driver: "dummy", model: null };
    // The classifier is off so the chiefs' triage has no model to call: a batch of events escalates to its chief, which the dummy driver plays.
    await ctx.daemon.call("PATCH", "/settings", { classifier: "off", phaseModels: { plan: phase, work: phase, review: phase, adviser: phase, complete: phase } });
    const project = await ctx.daemon.call<{ id: string }>("POST", "/projects", { path: ctx.repo, key: WALK_PROJECT.key, name: WALK_PROJECT.name, skipAgentReview: true });
    ctx.projectId = project.id;
    ctx.ws = await ctx.daemon.socket();
    mkdirSync(start.out, { recursive: true });
  } catch (e) {
    await teardown(ctx);
    throw e;
  }
  return ctx;
}

const cardOnBoard = `.card[data-key="${WALK_TICKET.key}"]`;
const count = (status: string) => `document.querySelector('[data-testid="count-${status}"]')?.textContent?.trim()`;

export function steps(start: Start, built: { app: string }): Step[] {
  const shot = (ctx: Ctx, name: string) => ctx.mac.main.screenshot(join(ctx.shots, `${name}.png`));
  const phoneShots = (ctx: Ctx, name: string) => Promise.all(ctx.phones.map((p) => p.screenshot(join(ctx.shots, `${name}-${p.name.toLowerCase()}.png`))));
  const eachPhone = <T>(ctx: Ctx, f: (p: Phone) => Promise<T>) => Promise.all(ctx.phones.map(f));

  return [
    {
      name: "1. launch the Mac app against the daemon",
      async run(ctx) {
        ctx.mac = await launchMac(ctx.runs, { url: ctx.daemon.url, token: ctx.daemon.token, userData: start.macUserData });
        await ctx.mac.main.waitFor("the board with its columns and the connection", `document.querySelectorAll('.column').length === 5 && document.body.innerText.includes('Connected')`, 60_000);
        await ctx.mac.main.waitFor("the project in the sidebar", `document.body.innerText.includes(${JSON.stringify(WALK_PROJECT.name)})`);
        await shot(ctx, "01-mac-board");
      },
    },
    {
      name: "2. pair the iPhone and iPad",
      async run(ctx) {
        const link = buildPairUrl(ctx.daemon.url, ctx.daemon.token);
        await eachPhone(ctx, async (p) => {
          await p.install(built.app);
          await p.pair(link);
        });
        await phoneShots(ctx, "02-paired");
      },
    },
    {
      name: "3. a ticket made on the service shows in Planning on all three",
      async run(ctx) {
        const main = ctx.mac.main;
        // The New Ticket form's typing and submit are the Mac views tests' (testing/mac/draft.test.tsx): here the ticket comes through the API.
        await ctx.daemon.call("POST", "/tickets", { projectId: ctx.projectId, spec: WALK_TICKET.spec, start: false });
        await main.waitFor(`${WALK_TICKET.key} in Planning on the Mac`, `document.querySelector('.column:first-child ${cardOnBoard}') && ${count("planning")} === '1'`);
        // The planning run finishes before the ticket is moved: the move needs the plan.
        await ctx.ws.event("the planning run to succeed", (e) => e.kind === "run.upserted" && e.run.kind === "plan" && e.run.status === "succeeded");
        await eachPhone(ctx, (p) => p.see(`${WALK_TICKET.key} in Planning`, (l) => columnCount(l, "Planning") === 1 && l.some((x) => x.startsWith(`${WALK_TICKET.key} ${WALK_TICKET.spec}`))));
        await shot(ctx, "03-mac-planning");
        await phoneShots(ctx, "03-planning");
      },
    },
    {
      name: "4. approve the plan: the dummy session runs and shows on all three",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.click(cardOnBoard);
        await main.click("button.tab[data-tab=transcript]");
        // Watch the transcript grow: the lengths the dummy driver's opening message has had, in order.
        await main.evaluate(`(() => {
          window.__walkLengths = [];
          const read = () => { const el = [...document.querySelectorAll('.t-assistant')].find((e) => e.innerText.includes(${JSON.stringify(DUMMY_HELLO)})); if (el) { const n = el.innerText.length; if (window.__walkLengths.at(-1) !== n) window.__walkLengths.push(n); } };
          new MutationObserver(read).observe(document, { subtree: true, childList: true, characterData: true });
        })()`);
        await main.click("[data-testid=ticket-actions] button.btn-primary");
        await ctx.ws.event("the ticket to reach Review", (e) => e.kind === "ticket.upserted" && e.ticket.status === "review");
        await main.waitFor("the dummy driver's opening line and closing note in the transcript", `(() => { const t = document.querySelector('[data-testid="pane-ticket"]')?.innerText ?? ''; return t.includes(${JSON.stringify(DUMMY_HELLO)}) && t.includes(${JSON.stringify(DUMMY_DONE_NOTE)}); })()`);
        const lengths = await main.evaluate<number[]>("window.__walkLengths");
        if (lengths.length < 2) throw new Error(`the Mac showed the dummy driver's message in one piece, not streaming in (lengths seen: ${JSON.stringify(lengths)})`);
        await shot(ctx, "04-mac-transcript");
        await eachPhone(ctx, async (p) => {
          await p.see("the ticket in Review", (l) => columnCount(l, "Review") === 1 && columnCount(l, "Planning") === 0);
          await p.tap("Review, 1");
          await p.see(`${WALK_TICKET.key} card`, (l) => l.some((x) => x.startsWith(`${WALK_TICKET.key} ${WALK_TICKET.spec}`)));
          await p.tap(`${WALK_TICKET.key} ${WALK_TICKET.spec}`, { what: "the ticket's tabs", match: (l) => l.includes("Transcript") });
          await p.tap("Transcript", { what: "the dummy driver's opening line", match: (l) => l.some((x) => x.includes(DUMMY_HELLO)) });
        });
        await phoneShots(ctx, "04-transcript");
      },
    },
    {
      name: "4b. raise the keyboard on the ticket: the composer rides above it",
      async run(ctx) {
        // The phone's composer is a safe-area bar: the keyboard lifts it rather than covering it.
        const phone = ctx.phones.find((p) => p.name === "iPhone")!;
        // The keyboard's space bar is in the labels once it's up: a tap that didn't land is tapped again.
        await phone.tap("Message the agent", { what: "the keyboard up", match: (l) => l.includes("space") });
        // The keyboard slides in: its frame is read until it and the composer are both in the tree.
        let clearance = keyboardClearance("", "Message the agent");
        await until("the keyboard and the composer on the iPhone's screen", 15_000, async () => {
          clearance = keyboardClearance(await phone.ui(), "Message the agent");
          return clearance.keyboardTop !== null && clearance.elementBottom !== null;
        }).catch((e: Error) => {
          throw new Error(`${e.message} (${JSON.stringify(clearance)})`);
        });
        await phone.screenshot(join(ctx.shots, "04b-keyboard-iphone.png"));
        if (clearance.elementBottom! > clearance.keyboardTop!) throw new Error(`the composer ends at ${clearance.elementBottom}, under the keyboard that starts at ${clearance.keyboardTop}`);
      },
    },
    {
      name: "5. open a file from the palette; the editor draws it and saves an edit to the worktree",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.press("p", "KeyP", MOD.meta);
        // The palette lists files only for a query: the one string the walk types, into the palette's own input.
        await main.focus("[data-testid=palette-input]");
        await main.type("greeting");
        await main.click(`[data-testid=palette-row][data-path="${EDITED_FILE}"]`);
        const editor = `document.querySelector('.file-pane[data-file="${EDITED_FILE}"] [data-testid="file-editor"]')`;
        const firstLine = `${editor}?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')?.textContent`;
        await main.waitFor("the editor drawing greeting.ts's first line", `${editor}?.harnessEditor && ${firstLine}?.includes('export const greeting')`);
        // Typing is the editor component's own job (and the Mac views tests cover the dirty marker and Save):
        // the edit goes in through its handle (the new buffer, with the disk still holding what was loaded: the
        // state typing leaves), and what's ours here is the real Save reaching the real service.
        await main.evaluate(`(() => { const ed = ${editor}.harnessEditor; const loaded = ed.getContents(); ed.setContents(${JSON.stringify(EDIT_TEXT)} + loaded); ed.markSaved(loaded); })()`);
        await main.waitFor("the dirty marker", `document.querySelector('[data-testid="file-dirty"]')`);
        await main.click("[data-testid=file-save]");
        await main.waitFor("the file to be saved", `!document.querySelector('[data-testid="file-dirty"]')`);
        // The save went to the ticket's worktree through the service.
        const saved = await ctx.daemon.call<{ contents: string }>("GET", `/tickets/${WALK_TICKET.key}/file?path=${encodeURIComponent(EDITED_FILE)}`);
        if (!saved.contents.startsWith(EDIT_TEXT)) throw new Error(`the service has ${JSON.stringify(saved.contents)} for ${EDITED_FILE}, not the edit`);
        await shot(ctx, "05-mac-file-edited");
      },
    },
    {
      name: "6. open the terminal and pop it out into its own window",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.press("t", "KeyT", MOD.meta);
        await main.waitFor("the terminal pane", `document.querySelector('aside.terminal-pane [data-testid="terminal-host"]')`);
        const list = await until("one terminal on the service", 15_000, async () => {
          const l = await ctx.daemon.call<{ id: string; cols: number; rows: number }[]>("GET", "/terminals");
          return l.length === 1 ? l : undefined;
        });
        ctx.terminalId = list[0]!.id;
        // A real shell answers: the command goes in over the socket as another device would type it (the
        // Mac's keystrokes into the terminal are xterm's), and the output is read where it lives, on the service.
        const info = list[0]!;
        ctx.ws.send({ type: "terminal.attach", id: info.id, deviceId: "walk-checker", cols: info.cols, rows: info.rows });
        ctx.ws.send({ type: "terminal.write", id: info.id, data: `${TERMINAL_COMMAND}\r` });
        let seen = "";
        await ctx.ws.message(`the shell to print ${TERMINAL_ANSWER}`, (m) => {
          if ((m.type === "terminal.snapshot" || m.type === "terminal.output") && m.id === info.id) seen += m.data;
          return seen.includes(TERMINAL_ANSWER);
        });
        await shot(ctx, "06-mac-terminal");

        // The popout is a second BrowserWindow, created through the renderer → main IPC seam.
        await main.click("aside.terminal-pane [data-testid=pane-popout]");
        const popout = await ctx.mac.windowOf("the popout window", (url) => url.includes("#/popout/"));
        await popout.waitFor("the terminal inside the popout", `document.querySelector('aside.terminal-pane[data-terminal="${ctx.terminalId}"] [data-testid="terminal-host"]')`);
        await main.waitFor("the terminal to leave the main window", `!document.querySelector('aside.terminal-pane')`);
        await popout.screenshot(join(ctx.shots, "06-mac-popout.png"));
        await popout.click("[data-testid=pane-popin]");
        await main.waitFor("the terminal to come back to the main window", `document.querySelector('aside.terminal-pane[data-terminal="${ctx.terminalId}"]')`);
      },
    },
    {
      name: "7. relaunch each app and confirm the state survived",
      async run(ctx) {
        await ctx.mac.quit();
        ctx.mac = await launchMac(ctx.runs, { url: ctx.daemon.url, token: ctx.daemon.token, userData: start.macUserData });
        await ctx.mac.main.waitFor(`${WALK_TICKET.key} in Review after the relaunch`, `document.querySelector('.column ${cardOnBoard}') && ${count("review")} === '1' && document.body.innerText.includes('Connected')`, 60_000);
        await shot(ctx, "07-mac-relaunched");
        await eachPhone(ctx, async (p) => {
          // Step 4 left the ticket open on its Transcript tab. Home saves the state, then the app is killed.
          await p.background();
          await p.terminate();
          await p.launch();
          // Paired state is the keychain's (no pair link this time), and the open ticket comes back on the tab it was on.
          await p.see("the ticket open on its Transcript tab without pairing again", (l) => l.some((x) => x.includes(DUMMY_HELLO)), 60_000);
        });
        await phoneShots(ctx, "07-relaunched");
      },
    },
    {
      name: "8a. a project board's Chief of Staff button opens its group's chief: the tickets it makes and its count show on all three",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        // From the project's board, the title-bar button is its group's chief.
        await d.call("PATCH", `/projects/${ctx.projectId}`, { group: COS_GROUP });
        // No column is checked out of the box, so no event would reach the chief and the count would stay at zero.
        await d.call("PATCH", "/settings", { cosStatuses: ["planning", "in_progress", "blocked", "review", "done"] });
        ctx.cos.groupId = (await d.call<{ id: string; name: string }[]>("GET", "/groups")).find((g) => g.name === COS_GROUP)!.id;
        await main.evaluate(`location.hash = '#/board/${ctx.projectId}'`);
        await main.waitFor("the Chief of Staff button, scoped to the group", `document.querySelector('[data-testid="cos-callout"]')?.dataset.scope === 'group:${ctx.cos.groupId}'`);
        await shot(ctx, "08a-mac-board-title-bar");
        await main.click("[data-testid=cos-callout]");
        await main.waitFor("the chief's pane with its composer", `document.querySelector('[data-testid="cos-view"] [data-testid="cos-composer-input"]')`);
        const chief = await until("the group's chief on the service", 15_000, async () => (await d.call<Cos[]>("GET", "/cos")).find((c) => c.scope === `group:${ctx.cos.groupId}`));

        // The chat's typing and Send are the Mac views tests' (testing/mac/cos.test.tsx): the message goes in through the API the composer posts to.
        const create = (title: string, spec: string) => ({ name: "create_ticket", input: { title, spec, project_key: WALK_PROJECT.key, start: false } });
        const calls = [create(COS_SPIKE_TITLE, "Compare two caches and report which fits."), create(COS_BUILD_TITLE, "Build the cache layer the spike picks.")];
        await d.call("POST", `/cos/${chief.ticketId}/messages`, { text: `/tools ${JSON.stringify(calls)}` });
        await main.waitFor("a card in the chat for each ticket the chief made", `document.querySelectorAll('[data-testid="cos-view"] [data-testid="cos-ticket-card"]').length >= 2`);
        await shot(ctx, "08a-mac-chat");

        // The tickets are the chief's, in Planning, and their Activity says who made them.
        const tickets = await d.call<Ticket[]>("GET", `/tickets?projectId=${ctx.projectId}`);
        const made = [COS_SPIKE_TITLE, COS_BUILD_TITLE].map((title) => tickets.find((t) => t.title === title));
        if (made.some((t) => !t || t.status !== "planning")) throw new Error(`the chief's tickets aren't both in Planning: ${JSON.stringify(made.map((t) => t && [t.key, t.status]))}`);
        const activity = await d.call<{ body: string }[]>("GET", `/tickets/${made[0]!.key}/activity`);
        if (!activity.some((a) => a.body === `Chief of staff (${chief.key}) created it`)) throw new Error(`the spike's Activity doesn't name the chief: ${JSON.stringify(activity.map((a) => a.body))}`);

        // A ticket of the walk project blocking on a question is something waiting for the chief: the Mac's pill is what the service counts.
        await d.call<Ticket>("POST", "/tickets", { projectId: ctx.projectId, spec: COS_BLOCKED_SPEC("cache"), skipAgentReview: true });
        const pending = async () => (await d.call<{ byCos: Record<string, number> }>("GET", "/cos/events/badge")).byCos[chief.ticketId] ?? 0;
        const macPill = () => main.evaluate<string | null>(`document.querySelector('[data-testid="cos-callout-badge"]')?.textContent?.trim() ?? null`);
        await until("the Mac's pill to show what the service counts", 60_000, async () => {
          const n = await pending();
          return n >= 1 && (await macPill()) === String(n) ? n : undefined;
        });

        // The same chief on the phones: the link opens its chat, with a card for each ticket.
        await eachPhone(ctx, async (p) => {
          await p.open(`harness://cos/${ctx.cos.groupId}`, "the chief's chat with a card for each ticket", (l) => made.every((t) => l.some((x) => x.startsWith(`${t!.key}, ${t!.title}`))));
        });
        await phoneShots(ctx, "08a-chat");
      },
    },
    {
      name: "9. a parent hears its child: the Events tab appears on the Mac with the row, and Settings has the retention field",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        await main.evaluate(`location.hash = '#/board/${ctx.projectId}'`);
        const parent = await d.call<Ticket>("POST", "/tickets", { projectId: ctx.projectId, spec: "Conduct the cache work", kind: "conductor", start: false });
        await main.click(`.card[data-key="${parent.key}"]`);
        await main.waitFor("the new parent's tabs, with no Events tab yet", `document.querySelector('[data-testid="pane-ticket"] [role=tab][data-tab="spec"]') && !document.querySelector('[role=tab][data-tab="events"]')`);
        // The child runs to Review on the dummy driver; its parent hears each move (a `child` event).
        const child = await d.call<Ticket>("POST", "/tickets", { projectId: ctx.projectId, spec: "Build one cache", parentId: parent.key, skipAgentReview: true });
        await ctx.ws.event("the parent to gain events", (e) => e.kind === "ticket.upserted" && e.ticket.id === parent.id && e.ticket.hasEvents === true);
        await main.waitFor("the Events tab on the parent", `document.querySelector('[data-testid="pane-ticket"] [role=tab][data-tab="events"]')`);
        await main.click("[role=tab][data-tab=events]");
        await main.waitFor(`the child's row in the Events tab`, `document.querySelector('[data-testid="ticket-events"] [data-testid="cos-event"]')?.innerText.includes(${JSON.stringify(child.key)})`);
        await shot(ctx, "09-mac-events");

        await main.evaluate(`location.hash = '#/settings'`);
        await main.waitFor("the retention field", `document.querySelector('input[aria-label="Keep event history for"]')`);
        await main.evaluate(`document.querySelector('input[aria-label="Keep event history for"]').scrollIntoView({ block: 'center' })`);
        await shot(ctx, "09-mac-settings-retention");
      },
    },
    {
      name: "10. a label added through the API shows in the Mac sidebar and finds its ticket by label: search",
      async run(ctx) {
        const d = ctx.daemon;
        const label = "Walk label";
        const [first] = await d.call<Ticket[]>("GET", `/tickets?projectId=${ctx.projectId}&status=review`);
        if (!first) throw new Error("no ticket in Review to label");
        await d.call("PATCH", `/tickets/${first.key}`, { labels: [label] });
        await ctx.ws.event("the labels collection to list the label", (e) => e.kind === "labels.changed" && e.labels.some((l) => l.name === label));
        // In Review it counts toward the label, so the sidebar lists it; a search by label finds the ticket and no other.
        const found = await d.call<{ tickets: Ticket[] }>("GET", `/tickets/search?q=${encodeURIComponent(`label:"${label}"`)}`);
        if (found.tickets.length !== 1 || found.tickets[0]!.key !== first.key) throw new Error(`label: search found ${JSON.stringify(found.tickets.map((t) => t.key))}, expected only ${first.key}`);
        await ctx.mac.main.evaluate(`location.hash = '#/'`);
        await ctx.mac.main.waitFor("the label in the sidebar", `document.body.innerText.includes(${JSON.stringify(label)})`);
        await shot(ctx, "10-mac-labels");

        // The Details tab's field lists what the ticket lacks and offers to create a new name; the palette's
        // "Add label…" opens a picker for the same ticket and Enter on the create row labels it for real.
        const main = ctx.mac.main;
        await main.click(`.card[data-key="${first.key}"]`);
        await main.waitFor("the ticket's tabs", `document.querySelector('[data-testid="pane-ticket"] [role=tab][data-tab="details"]')`);
        await main.click("[role=tab][data-tab=details]");
        await main.waitFor("the labels field", `document.querySelector('[data-testid="label-add"]')`);
        await main.focus("[data-testid=label-add]");
        await main.type("Walk typeahead");
        await main.waitFor("the Create row", `document.querySelector('[data-testid="label-suggestions"] li[data-create]')`);
        await shot(ctx, "10-mac-label-typeahead");
        await main.evaluate(`(() => { const i = document.querySelector('[data-testid="label-add"]'); i.blur(); })()`);
        await main.press("k", "KeyK", MOD.meta);
        await main.focus("[data-testid=palette-input]");
        await main.type(">Add label");
        await main.press("Enter", "Enter");
        await main.waitFor("the label picker", `document.querySelector('[data-testid="label-picker-input"]')`);
        await main.type("Walk palette");
        await main.waitFor("the Create row", `document.querySelector('[data-testid="label-picker"] li[data-create]')`);
        await shot(ctx, "10-mac-label-palette");
        await main.press("Enter", "Enter");
        await ctx.ws.event("the new label to reach the collection", (e) => e.kind === "labels.changed" && e.labels.some((l) => l.name === "Walk palette"));
        const labeled = (await d.call<Ticket[]>("GET", `/tickets?projectId=${ctx.projectId}&status=review`)).find((t) => t.key === first.key);
        if (!labeled?.labels?.includes("Walk palette")) throw new Error(`the palette's Add label… left ${JSON.stringify(labeled?.labels)} on ${first.key}`);
      },
    },
  ];
}

/** The run in progress, for `interrupt` (a signal arrives while a step is awaiting). */
let active: { ctx: Ctx; start: Start } | undefined;

/** Tear down the run in progress and remove what it made, for SIGINT and SIGTERM. Does nothing once normal teardown has begun. */
export async function interrupt(): Promise<void> {
  const run = active;
  active = undefined;
  if (!run) return;
  await teardown(run.ctx);
  rmSync(run.ctx.dir, { recursive: true, force: true });
  rmSync(run.start.macUserData, { recursive: true, force: true });
}

export async function runSteps(start: Start, runs: RunFile, built: { app: string }, log: (m: string) => void = console.log): Promise<void> {
  const ctx = await begin(start, runs);
  active = { ctx, start };
  let passed = false;
  try {
    for (const step of steps(start, built)) {
      const t0 = performance.now();
      try {
        await step.run(ctx);
      } catch (e) {
        log(`✗ ${step.name}: ${(e as Error).message}`);
        await failureShots(ctx);
        throw e;
      }
      log(`✓ ${step.name} [${((performance.now() - t0) / 1000).toFixed(1)}s]`);
    }
    passed = true;
  } finally {
    // From here teardown is ours; a signal now must not run it a second time.
    const interrupted = active === undefined;
    active = undefined;
    if (!interrupted) await teardown(ctx);
    // A failed run keeps its home, checkout and Mac profile for a look; a passing one leaves nothing in the temp dir.
    if (passed) {
      rmSync(ctx.dir, { recursive: true, force: true });
      rmSync(start.macUserData, { recursive: true, force: true });
    } else if (!interrupted) log(`kept ${ctx.dir} (service home and checkout) and ${start.macUserData} (Mac profile) for inspection`);
  }
}

/** What each screen showed when a step failed, next to the run's other screenshots. */
async function failureShots(ctx: Ctx) {
  await ctx.mac?.main.screenshot(join(ctx.shots, "failure-mac.png")).catch(() => {});
  await Promise.all(ctx.phones.map((p) => p.screenshot(join(ctx.shots, `failure-${p.name.toLowerCase()}.png`)).catch(() => {})));
}

/** Quit the apps, remove the phones' installs, stop the daemon, and kill whatever the run file still lists. */
export async function teardown(ctx: Ctx) {
  await Promise.all(ctx.phones.map(async (p) => {
    await p.terminate().catch(() => {});
    await p.uninstall().catch(() => {});
  }));
  ctx.ws?.close();
  await ctx.mac?.quit().catch(() => {});
  await ctx.daemon?.stop().catch(() => {});
  await killRecords(ctx.runs.records());
}
