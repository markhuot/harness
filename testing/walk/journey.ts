// The walkthrough's journey: one daemon, the Mac app, an iPhone and an iPad, sixteen steps that each
// build on the last: the app's basics (1 to 7), then the chief of staff (8a to 8e). It runs inside both simulator locks (walk/run.ts takes them), with the two
// UDIDs in WALK_IPHONE_UDID and WALK_IPAD_UDID. Every step waits on something observable (a /ws
// event, a DOM change, an accessibility label, a process's output) and every wait has a deadline.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cos, CosEvent, CosEventPage, Ticket } from "@harness/shared";
import { buildPairUrl } from "../../shared/src/pairing";
import { MOD } from "../lib/cdp";
import { startDaemon, type Daemon, type Socket } from "../lib/daemon";
import { columnCount, keyboardClearance, phone, screenState, type Phone } from "../lib/ios";
import { launchMac, type MacApp } from "../lib/mac";
import { killRecords, RunFile } from "../lib/procs";
import { until } from "../lib/wait";
import {
  COS_AWAY_GROUP,
  COS_AWAY_PROJECT,
  COS_BLOCKED_SPEC,
  COS_BUILD_TITLE,
  COS_GROUP,
  COS_OFF_PROJECT,
  COS_REMINDER_TITLE,
  COS_SPIKE_TITLE,
  COS_WATCHER_SOURCE,
  COS_WATCHER_TEXT,
  EDIT_TEXT,
  EDITED_FILE,
  DUMMY_DONE_NOTE,
  DUMMY_HELLO,
  TERMINAL_ANSWER,
  TERMINAL_COMMAND,
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
  /** Step 8a's world: the blocked tickets by project key, and the ids the later chief steps use. */
  cos: { blocked: Record<string, string>; groupId: string; groupChief: Cos | null; allChief: Cos | null };
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
    cos: { blocked: {}, groupId: "", groupChief: null, allChief: null },
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
      name: "3. create a ticket on the Mac; both phones see it",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.press("n", "KeyN", MOD.meta);
        await main.focus("textarea[aria-label=Spec]");
        await main.type(WALK_TICKET.spec);
        await main.click("[data-testid=draft-plan]");
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
        await phone.tap("Message the agent", { what: "the keyboard up", match: () => true });
        let clearance = keyboardClearance(await phone.ui(), "Message the agent");
        for (let i = 0; i < 20 && clearance.keyboardTop === null; i++) {
          await Bun.sleep(500);
          clearance = keyboardClearance(await phone.ui(), "Message the agent");
        }
        await phone.screenshot(join(ctx.shots, "04b-keyboard-iphone.png"));
        if (clearance.keyboardTop === null || clearance.elementBottom === null) throw new Error(`the keyboard or the composer isn't on the iPhone's screen (${JSON.stringify(clearance)})`);
        if (clearance.elementBottom > clearance.keyboardTop) throw new Error(`the composer ends at ${clearance.elementBottom}, under the keyboard that starts at ${clearance.keyboardTop}`);
      },
    },
    {
      name: "4c. ⌥⌘= steps the open ticket pane to the next preset width",
      async run(ctx) {
        const main = ctx.mac.main;
        const ticketWidth = `Math.round(document.querySelector('.pane-ticket').getBoundingClientRect().width)`;
        await main.click(".pane-ticket button.tab[data-tab=spec]");
        const before = await main.evaluate<number>(ticketWidth);
        await shot(ctx, "04c-mac-cycle-width-before");
        await main.press("=", "Equal", MOD.meta | MOD.alt);
        await main.waitFor("the ticket pane to change width", `${ticketWidth} !== ${before}`);
        await shot(ctx, "04c-mac-cycle-width-after");
      },
    },
    {
      name: "4d. project settings renames the group for every project in it",
      async run(ctx) {
        const main = ctx.mac.main;
        const row = `[...document.querySelectorAll('.settings-row')].find((r) => r.innerText.startsWith('Group name'))`;
        const previous = await main.evaluate<string>(`location.hash`);
        await ctx.daemon.call("PATCH", `/projects/${ctx.projectId}`, { group: "Walk group" });
        await main.evaluate(`location.hash = '#/project/${ctx.projectId}/settings'`);
        await main.waitFor("the Group name row", `${row}`);
        await main.evaluate(`${row}.scrollIntoView({ block: 'center' })`);
        await shot(ctx, "04d-mac-project-settings-group-name");
        const groups = await ctx.daemon.call<{ id: string; name: string }[]>("GET", "/groups");
        if (!groups.some((g) => g.name === "Walk group")) throw new Error(`the service has no "Walk group": ${JSON.stringify(groups)}`);
        await main.evaluate(`location.hash = ${JSON.stringify(previous)}`);
        // Leaving the settings page closes the ticket pane the next steps use: open it again.
        await main.waitFor("the board", `document.querySelector(${JSON.stringify(cardOnBoard)})`);
        if (!(await main.evaluate<boolean>(`!!document.querySelector('.pane-ticket')`))) await main.click(cardOnBoard);
        await main.waitFor("the ticket pane", `document.querySelector('.pane-ticket')`);
      },
    },
    {
      name: "5. edit a file in the Mac app's editor",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.press("p", "KeyP", MOD.meta);
        await main.waitFor("the file palette", `document.querySelector('input')`);
        await main.type("greeting");
        await main.waitFor("greeting.ts in the palette", `document.body.innerText.includes('greeting.ts')`);
        await main.press("Enter", "Enter");
        const editor = `document.querySelector('[data-testid="file-editor"]')`;
        await main.waitFor("the editor on greeting.ts", `${editor}?.harnessEditor && ${editor}.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
        await main.evaluate(`(() => { const ed = ${editor}.harnessEditor; ed.focus(); ed.setSelection(0); })()`);
        await main.type(EDIT_TEXT);
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
      name: "5b. wrap a file type's long lines, and read a markdown file rendered",
      async run(ctx) {
        const main = ctx.mac.main;
        const pane = (file: string) => `document.querySelector('.file-pane[data-file="${file}"]')`;
        const editor = `${pane(EDITED_FILE)}.querySelector('[data-testid="file-editor"]')`;
        const lastLine = `(() => { const lines = ${editor}.querySelector('diffs-container').shadowRoot.querySelectorAll('[data-line]'); return lines[lines.length - 1]; })()`;
        const pickFromMenu = async (file: string, item: string) => {
          await main.click(`.file-pane[data-file="${file}"] button[title="More"]`);
          await main.click(`[data-testid="${item}"]`);
        };
        // A line much wider than the pane: one row tall until it wraps.
        await main.evaluate(`(() => { const ed = ${editor}.harnessEditor; ed.focus(); ed.setSelection(ed.getContents().length); })()`);
        await main.type(`// ${"a long line that has to wrap ".repeat(14)}`);
        const height = () => main.evaluate<number>(`${lastLine}.getBoundingClientRect().height`);
        const single = await height();
        await pickFromMenu(EDITED_FILE, "view-wrap");
        await main.waitFor("the long line wrapped", `${lastLine}.getBoundingClientRect().height > ${single * 1.5}`);
        if (!(await main.evaluate<boolean>(`${editor}.harnessEditor.probe().wrap`))) throw new Error("the editor doesn't report wrap");
        const stored = await main.evaluate<string>(`localStorage.getItem('harness.wrap')`);
        if (stored !== '{".ts":true}') throw new Error(`wrap is stored as ${stored}, not for .ts only`);
        await shot(ctx, "05b-mac-file-wrapped");
        await pickFromMenu(EDITED_FILE, "view-wrap");
        await main.waitFor("the long line scrolling sideways again", `${lastLine}.getBoundingClientRect().height <= ${single * 1.1}`);
        // The long line was only for the wrap check: leave greeting.ts as saved.
        await main.click(`.file-pane[data-file="${EDITED_FILE}"] [data-testid=file-save]`);

        await main.press("p", "KeyP", MOD.meta);
        await main.waitFor("the file palette", `document.querySelector('input')`);
        await main.type("README");
        await main.waitFor("README.md in the palette", `document.body.innerText.includes('README.md')`);
        await main.press("Enter", "Enter");
        await main.waitFor("README.md open", `${pane("README.md")}?.querySelector('[data-testid="file-editor"]')`);
        await pickFromMenu("README.md", "view-rendered");
        await main.waitFor("the rendered README", `${pane("README.md")}.querySelector('[data-testid="file-rendered"]')?.innerText.includes('A project for the walkthrough.')`);
        await shot(ctx, "05b-mac-file-rendered");
        await pickFromMenu("README.md", "view-source");
        await main.waitFor("the source again", `!${pane("README.md")}.querySelector('[data-testid="file-rendered"]')`);

        // The Spec tab's Source view: the spec's markdown in the same editor, wrapped by the .md setting.
        await main.click("button.tab[data-tab=spec]");
        await main.click("[data-testid=spec-more]");
        await main.click("[data-testid=view-source]");
        await main.waitFor("the spec's source in the editor", `document.querySelector('[data-testid="spec-source"] diffs-container')?.shadowRoot?.querySelector('[data-line]')?.textContent.trim().length > 0`);
        await main.click("[data-testid=spec-more]");
        await main.waitFor("the Spec menu", `document.querySelector('[data-testid="view-wrap"]')`);
        await shot(ctx, "05b-mac-spec-menu-source");
        await main.click("[data-testid=view-rendered]");
        await main.waitFor("the rendered spec again", `document.querySelector('[data-testid="spec-doc"]') && !document.querySelector('[data-testid="spec-source"]')`);
      },
    },
    {
      name: "6. open the terminal and pop it out into its own window",
      async run(ctx) {
        const main = ctx.mac.main;
        await main.press("t", "KeyT", MOD.meta);
        await main.waitFor("the terminal pane", `document.querySelector('aside.terminal-pane [data-testid="terminal-host"]')`);
        const list = await until("one terminal on the service", 15_000, async () => {
          const l = await ctx.daemon.call<{ id: string }[]>("GET", "/terminals");
          return l.length === 1 ? l : undefined;
        });
        ctx.terminalId = list[0]!.id;
        await main.focus("aside.terminal-pane textarea");
        await main.type(TERMINAL_COMMAND);
        await main.press("Enter", "Enter");
        // The terminal is a canvas: what the shell printed is read where it lives, on the service.
        const info = (await ctx.daemon.call<{ id: string; cols: number; rows: number }[]>("GET", "/terminals"))[0]!;
        ctx.ws.send({ type: "terminal.attach", id: info.id, deviceId: "walk-checker", cols: info.cols, rows: info.rows });
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
      name: "8a. a project board's Chief of Staff button opens its group's chief; asked for a spike and a build ticket, it makes both",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        // The world the chief steps share: a second project in the walk's group where the chief may not unblock, a project in another
        // group, and a blocked ticket in each of the three (the dummy driver blocks on `/block`).
        const project = async (key: string, name: string, group: string, cosCanUnblock: boolean) => {
          const path = join(ctx.dir, name);
          mkdirSync(path, { recursive: true });
          const p = await d.call<{ id: string }>("POST", "/projects", { path, key, name, group, useWorktrees: false, skipAgentReview: true });
          await d.call("PATCH", `/projects/${p.id}`, { cosCanUnblock });
          return p;
        };
        const off = await project(COS_OFF_PROJECT.key, COS_OFF_PROJECT.name, COS_GROUP, false);
        const away = await project(COS_AWAY_PROJECT.key, COS_AWAY_PROJECT.name, COS_AWAY_GROUP, true);
        await d.call("PATCH", `/projects/${ctx.projectId}`, { cosCanUnblock: true });
        for (const [key, id, what] of [[WALK_PROJECT.key, ctx.projectId, "cache"], [COS_OFF_PROJECT.key, off.id, "queue"], [COS_AWAY_PROJECT.key, away.id, "database"]] as const) {
          const t = await d.call<Ticket>("POST", "/tickets", { projectId: id, spec: COS_BLOCKED_SPEC(what), skipAgentReview: true });
          ctx.cos.blocked[key] = t.key;
        }
        await until("the three tickets to be blocked on a question", 60_000, async () => {
          const all = await Promise.all(Object.values(ctx.cos.blocked).map((k) => d.call<{ ticket: Ticket }>("GET", `/tickets/${k}`)));
          return all.every((x) => x.ticket.status === "blocked") ? true : undefined;
        });
        ctx.cos.groupId = (await d.call<{ id: string; name: string }[]>("GET", "/groups")).find((g) => g.name === COS_GROUP)!.id;

        // From the project's board, the title-bar button is its group's chief.
        await main.evaluate(`location.hash = '#/board/${ctx.projectId}'`);
        await main.waitFor("the Chief of Staff button, scoped to the group", `document.querySelector('[data-testid="cos-callout"]')?.dataset.scope === 'group:${ctx.cos.groupId}'`);
        await shot(ctx, "08a-mac-board-title-bar");
        await main.click("[data-testid=cos-callout]");
        await main.waitFor("the chief's pane with its composer", `document.querySelector('[data-testid="cos-view"] [data-testid="cos-composer-input"]')`);
        const create = (title: string, spec: string) => ({ name: "create_ticket", input: { title, spec, project_key: WALK_PROJECT.key, start: false } });
        const calls = [create(COS_SPIKE_TITLE, "Compare two caches and report which fits."), create(COS_BUILD_TITLE, "Build the cache layer the spike picks.")];
        await main.focus("[data-testid=cos-composer-input]");
        await main.type(`/tools ${JSON.stringify(calls)}`);
        await main.click("[data-testid=cos-send]");
        await main.waitFor("a card in the chat for each ticket the chief made", `document.querySelectorAll('[data-testid="cos-view"] [data-testid="cos-ticket-card"]').length >= 2`);
        await shot(ctx, "08a-mac-chat");

        // The tickets are the chief's, in Planning, and their Activity says who made them.
        ctx.cos.groupChief = (await d.call<Cos[]>("GET", "/cos")).find((c) => c.scope === `group:${ctx.cos.groupId}`)!;
        const tickets = await d.call<Ticket[]>("GET", `/tickets?projectId=${ctx.projectId}`);
        const made = [COS_SPIKE_TITLE, COS_BUILD_TITLE].map((title) => tickets.find((t) => t.title === title));
        if (made.some((t) => !t || t.status !== "planning")) throw new Error(`the chief's tickets aren't both in Planning: ${JSON.stringify(made.map((t) => t && [t.key, t.status]))}`);
        const activity = await d.call<{ body: string }[]>("GET", `/tickets/${made[0]!.key}/activity`);
        if (!activity.some((a) => a.body === `Chief of staff (${ctx.cos.groupChief!.key}) created it`)) throw new Error(`the spike's Activity doesn't name the chief: ${JSON.stringify(activity.map((a) => a.body))}`);

        // The same chief on the phones: the link opens its chat, with a card for each ticket.
        await eachPhone(ctx, async (p) => {
          await p.open(`harness://cos/${ctx.cos.groupId}`, "the chief's chat with a card for each ticket", (l) => made.every((t) => l.some((x) => x.startsWith(`${t!.key}, ${t!.title}`))));
        });
        await phoneShots(ctx, "08a-chat");
      },
    },
    {
      name: "8b. a watcher's output lands in the All chief's Inbox, and the title-bar count pill shows on all three",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        await main.evaluate(`location.hash = '#/board/all'`);
        await main.waitFor("the All projects board's Chief of Staff button", `document.querySelector('[data-testid="cos-callout"]')?.dataset.scope === 'all'`);
        await main.click("[data-testid=cos-callout]");
        await main.waitFor("the All chief's pane", `document.querySelector('[data-testid="cos-view"][data-scope="all"]')`);
        ctx.cos.allChief = (await d.call<Cos[]>("GET", "/cos")).find((c) => c.scope === "all")!;
        const event = await d.call<CosEvent | null>("POST", "/watchers/inject", { source: COS_WATCHER_SOURCE, text: COS_WATCHER_TEXT });
        if (!event || event.cosId !== ctx.cos.allChief.ticketId) throw new Error(`the injected output isn't an event of the All chief: ${JSON.stringify(event)}`);

        // The phones keep whichever board they were on, so a change on a walk-project ticket gives the group's chief something waiting too.
        await d.call("PATCH", `/tickets/${WALK_TICKET.key}`, { title: "Renamed in step 8b" });

        // The pill is what the service counts for the chief; wait for both to agree, on a count of at least the new event.
        const pending = async () => (await d.call<{ byCos: Record<string, number> }>("GET", "/cos/events/badge")).byCos[ctx.cos.allChief!.ticketId] ?? 0;
        const macPill = () => ctx.mac.main.evaluate<string | null>(`document.querySelector('[data-testid="cos-callout-badge"]')?.textContent?.trim() ?? null`);
        await until("the Mac's pill to show what the service counts", 30_000, async () => {
          const n = await pending();
          return n >= 1 && (await macPill()) === String(n) ? n : undefined;
        });
        await main.click("[role=tab][data-tab=inbox]");
        await main.waitFor("the watcher's item in the Inbox", `[...document.querySelectorAll('[data-testid="cos-event"]')].some((r) => r.innerText.includes('Watcher') && r.innerText.includes(${JSON.stringify(COS_WATCHER_TEXT)}))`);
        await shot(ctx, "08b-mac-inbox");

        // The phones' board: the same button with a count, then the All chief's Inbox tab with the item.
        await eachPhone(ctx, async (p) => {
          await p.open("harness://board", "the board", (l) => screenState(l) === "board");
          await p.seeValue("the Chief of Staff button's count", "Chief of Staff", (v) => v !== null && /^\d+ waiting$/.test(v));
          await p.open("harness://cos", "the All chief's tabs", (l) => l.includes("Chat") && l.some((x) => x.startsWith("Inbox")));
          const tab = (await p.labels()).find((x) => x.startsWith("Inbox"))!;
          await p.tap(tab, { what: "the watcher's item in the Inbox", match: (l) => l.some((x) => x.includes(COS_WATCHER_TEXT)) });
        });
        await phoneShots(ctx, "08b-inbox");
      },
    },
    {
      name: "8c. the chief answers a blocked ticket where can-unblock is on, and is refused where it is off or the ticket is in another group",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        const { blocked, groupChief } = ctx.cos;
        const ask = (key: string, text: string) => ({ name: "message_ticket", input: { key, text } });
        // [dummy:unblock] makes the ticket's own chat run pick the work back up once the chief has answered.
        const calls = [ask(blocked[WALK_PROJECT.key]!, "Use Redis [dummy:unblock]"), ask(blocked[COS_OFF_PROJECT.key]!, "Use SQS [dummy:unblock]"), ask(blocked[COS_AWAY_PROJECT.key]!, "Use Postgres [dummy:unblock]")];
        await main.evaluate(`location.hash = '#/board/${ctx.projectId}'`);
        await main.waitFor("the group's Chief of Staff button", `document.querySelector('[data-testid="cos-callout"]')?.dataset.scope === 'group:${ctx.cos.groupId}'`);
        await main.click("[data-testid=cos-callout]");
        await main.waitFor("the chief's composer", `document.querySelector('[data-testid="cos-view"][data-scope="group:${ctx.cos.groupId}"] [data-testid="cos-composer-input"]')`);
        await main.click("[role=tab][data-tab=chat]");
        await main.focus("[data-testid=cos-composer-input]");
        await main.type(`/tools ${JSON.stringify(calls)}`);
        await main.click("[data-testid=cos-send]");
        await until("the walk project's ticket to leave Blocked", 60_000, async () => {
          const t = await d.call<{ ticket: Ticket }>("GET", `/tickets/${blocked[WALK_PROJECT.key]}`);
          return t.ticket.status !== "blocked" ? true : undefined;
        });
        await main.waitFor("the chief to say the other two were refused", `[...document.querySelectorAll('[data-testid="cos-view"] [data-testid="cos-msg-assistant"]')].filter((m) => m.innerText.includes('was refused')).length >= 2`);
        await shot(ctx, "08c-mac-unblock");

        // What the chief changed is on the ticket's Activity under its name; the other two stayed blocked and untouched.
        const bodies = async (key: string) => (await d.call<{ body: string }[]>("GET", `/tickets/${key}/activity`)).map((a) => a.body);
        if (!(await bodies(blocked[WALK_PROJECT.key]!)).includes(`Chief of staff (${groupChief!.key}) sent it a message`)) throw new Error("the answered ticket's Activity doesn't name the chief");
        for (const key of [COS_OFF_PROJECT.key, COS_AWAY_PROJECT.key]) {
          const t = (await d.call<{ ticket: Ticket }>("GET", `/tickets/${blocked[key]}`)).ticket;
          if (t.status !== "blocked") throw new Error(`${t.key} left Blocked, but the chief isn't allowed to answer it`);
          if ((await bodies(t.key)).some((b) => b.startsWith("Chief of staff"))) throw new Error(`${t.key}'s Activity shows the chief acted on it`);
        }
      },
    },
    {
      name: "8d. a reminder the chief sets fires on time: it is in the Inbox, handled by no run",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        const { groupChief } = ctx.cos;
        // A few seconds from now, in the Mac's own time zone (the service reads a bare time that way); the scheduler ticks every 30 seconds.
        const at = new Date(Date.now() + 10_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
        const call = { name: "schedule_create", input: { kind: "reminder", title: COS_REMINDER_TITLE, at: when } };
        await main.focus("[data-testid=cos-composer-input]");
        await main.type(`/tools ${JSON.stringify([call])}`);
        await main.click("[data-testid=cos-send]");
        const fired = await until("the reminder to fire", 90_000, async () => {
          const page = await d.call<CosEventPage>("GET", `/cos/${groupChief!.ticketId}/events?limit=200`);
          return page.items.find((e) => e.sourceKind === "schedule" && e.title.includes(COS_REMINDER_TITLE));
        });
        if (fired.handledBy !== null || fired.wakeId !== null) throw new Error(`the reminder started a run: ${JSON.stringify(fired)}`);
        await main.click("[role=tab][data-tab=inbox]");
        await main.waitFor("the reminder in the Inbox", `[...document.querySelectorAll('[data-testid="cos-event"]')].some((r) => r.innerText.includes('Schedule') && r.innerText.includes(${JSON.stringify(COS_REMINDER_TITLE)}))`);
        await shot(ctx, "08d-mac-reminder");
      },
    },
    {
      name: "8e. turning a chief off hands its pending events to the next owner; turning chiefs off in Settings stops events and runs",
      async run(ctx) {
        const main = ctx.mac.main;
        const d = ctx.daemon;
        const { groupChief, allChief, blocked } = ctx.cos;
        const cosRunsSince = (from: number) => ctx.ws.messages.slice(from).filter((m) => m.type === "event" && m.event.kind === "run.upserted" && m.event.run.kind === "cos").length;
        const owner = async (title: string) => {
          const page = await d.call<CosEventPage>("GET", `/cos/${groupChief!.ticketId}/events?limit=200`);
          return page.items.find((e) => e.title.includes(title));
        };
        // A change on a walk-project ticket is a pending event of its group's chief.
        const marker = "Renamed in step 8e";
        await d.call("PATCH", `/tickets/${blocked[WALK_PROJECT.key]}`, { title: marker });
        const pending = await until("the chief's pending event", 15_000, async () => {
          const e = await owner(marker);
          return e && e.status === "pending" ? e : undefined;
        });
        if (pending.cosId !== groupChief!.ticketId) throw new Error(`the event isn't the group chief's: ${JSON.stringify(pending)}`);
        const seen = ctx.ws.messages.length;

        // The group's chief goes off: its pending event is the All chief's now, and no run starts for either.
        await d.call("PATCH", `/cos/${groupChief!.ticketId}`, { enabled: false });
        const moved = await until("the event to move to the All chief", 15_000, async () => {
          const page = await d.call<CosEventPage>("GET", `/cos/${allChief!.ticketId}/events?limit=200`);
          return page.items.find((e) => e.id === pending.id && e.cosId === allChief!.ticketId);
        });
        if (moved.status !== "pending") throw new Error(`the moved event isn't pending: ${moved.status}`);

        // The app setting off: nobody owns it, and the chief's pane says nothing is triaged or run.
        await main.evaluate(`location.hash = '#/settings/cos'`);
        const toggle = `input[role=switch][aria-label="Chief of staff enabled"]`;
        await main.waitFor("the Chief of staff enabled switch, on", `document.querySelector(${JSON.stringify(toggle)})?.checked === true`);
        await main.click(toggle);
        await main.waitFor("the switch off", `document.querySelector(${JSON.stringify(toggle)})?.checked === false`);
        await shot(ctx, "08e-mac-settings-cos");
        const unowned = await until("the event to have no owner", 15_000, async () => {
          const page = await d.call<CosEventPage>("GET", `/cos/${allChief!.ticketId}/events?limit=200`);
          return page.items.find((e) => e.id === pending.id && e.cosId === null);
        });
        if (unowned.status !== "pending") throw new Error(`the unowned event isn't pending: ${unowned.status}`);
        await Bun.sleep(1500);
        if (cosRunsSince(seen) > 0) throw new Error("a chief of staff run started while chiefs were off");
        // Back on: the event is the All chief's again (the group chief is still off).
        await main.click(toggle);
        await until("the event to be the All chief's again", 15_000, async () => {
          const page = await d.call<CosEventPage>("GET", `/cos/${allChief!.ticketId}/events?limit=200`);
          return page.items.find((e) => e.id === pending.id && e.cosId === allChief!.ticketId);
        });
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
