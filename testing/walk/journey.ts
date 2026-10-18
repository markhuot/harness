// The walkthrough's journey: one daemon, the Mac app, an iPhone and an iPad, seven steps that each
// build on the last. It runs inside both simulator locks (walk/run.ts takes them), with the two
// UDIDs in WALK_IPHONE_UDID and WALK_IPAD_UDID. Every step waits on something observable (a /ws
// event, a DOM change, an accessibility label, a process's output) and every wait has a deadline.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPairUrl } from "../../shared/src/pairing";
import { MOD } from "../lib/cdp";
import { startDaemon, type Daemon, type Socket } from "../lib/daemon";
import { columnCount, phone, type Phone } from "../lib/ios";
import { launchMac, type MacApp } from "../lib/mac";
import { killRecords, RunFile } from "../lib/procs";
import { until } from "../lib/wait";
import { EDIT_TEXT, EDITED_FILE, DUMMY_DONE_NOTE, DUMMY_HELLO, TERMINAL_ANSWER, TERMINAL_COMMAND, WALK_FILES, WALK_PROJECT, WALK_TICKET } from "../world/walk";

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
  };
  try {
    ctx.repo = seedRepo(dir);
    ctx.daemon = await startDaemon(runs, join(dir, "home"));
    // Every phase of every run goes to the dummy driver; the default would be a real agent.
    const phase = { driver: "dummy", model: null };
    await ctx.daemon.call("PATCH", "/settings", { phaseModels: { plan: phase, work: phase, review: phase, adviser: phase, complete: phase } });
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
          await p.tap(`${WALK_TICKET.key} ${WALK_TICKET.spec}`);
          await p.see("the ticket's tabs", (l) => l.includes("Transcript"));
          await p.tap("Transcript");
          await p.see("the dummy driver's opening line", (l) => l.some((x) => x.includes(DUMMY_HELLO)));
        });
        await phoneShots(ctx, "04-transcript");
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
