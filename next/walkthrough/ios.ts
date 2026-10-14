// The iPhone walkthrough: one install over a seeded daemon, one linear pass, a report per screen.
// Every screen is reached once, by `harness://` deep link where one exists and by a tap where none
// does (the command palette, last, so nothing has to dismiss it). Assertions read the accessibility
// tree. It exists for verification, never for spec screenshots.
//
//   bun run sim with-lock -- bun next/walkthrough/ios.ts [--no-build]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPairUrl, type TicketDetail } from "@harness/shared";
import { axeFor, hasAxe, screenKey, type AXElement } from "../../ios/Tools/axe";
import { installAndPair, openLink, seed, startDaemon, stopDaemon, buildApp } from "../../ios/Tools/dev-sim";
import { GREETINGS_PATH, GREETING_FOR } from "../../ios/Tools/fixtures";
import { parseState, PROBE_FILE, type DebugState } from "../../ios/Tools/probe";
import { acquireReady, exportDeveloperDir } from "../../ios/Tools/sim";
import { startCompacting, startUsageProxy, seedWorld, WORLD_FILES } from "./world";
import { walk } from "./walk";

const started = performance.now();
if (!hasAxe()) throw new Error("the walkthrough reads the UI tree with AXe: brew install cameroncooke/axe/axe");
exportDeveloperDir();
const app = process.argv.includes("--no-build") ? join(resolve(import.meta.dir, "../../ios"), "build/dd/Build/Products/Release-iphonesimulator/Harness.app") : await buildApp();
if (!existsSync(app)) throw new Error(`${app} doesn't exist; drop --no-build`);
const d = await startDaemon();
const seeded = await seed(d, WORLD_FILES);
const world = await seedWorld(d, seeded);
const usageProxy = startUsageProxy(d); // the app pairs through it: it answers GET /usage and forwards the rest
console.log(`built and seeded in ${Math.round(performance.now() - started)} ms`);
const slot = await acquireReady({ onWait: () => console.log("waiting for a shared simulator…") }, {});
const w = walk("iPhone walkthrough");
try {
  const axe = axeFor(slot.udid, process.env.DEVELOPER_DIR!);
  const t0 = performance.now();
  await installAndPair(slot.udid, axe, app, buildPairUrl(usageProxy.base, d.token));
  console.log(`installed and paired in ${Math.round(performance.now() - t0)} ms`);
  let previous = { url: "", key: screenKey(await axe.labels()) };
  const seen = (els: AXElement[]) => "on screen: " + els.map((e) => e.label ?? e.id).filter(Boolean).slice(0, 25).join(" | ");
  const has = (els: AXElement[], match: RegExp | string) => els.some((e) => (typeof match === "string" ? e.label === match : !!e.label && match.test(e.label)));
  /** The tree once `ok` holds (a screen draws after the link lands), or the last read after 8 s so the screen reports what it saw. */
  const untilTree = async (read: () => Promise<AXElement[]>, ok: (els: AXElement[]) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    let els = await read();
    while (!ok(els) && Date.now() < end) els = await read();
    return els;
  };
  /** The first element whose label passes `match`. */
  const find = (els: AXElement[], match: (label: string) => boolean) => els.find((e) => !!e.label && match(e.label));
  /** Taps the element whose label passes `match` (a tap is by exact label, and a label often carries live numbers). */
  const tapWhere = async (match: (label: string) => boolean) => {
    const e = find(await axe.nodes(), match);
    if (!e) throw new Error("nothing on screen to tap");
    await axe.tap(e.label!);
  };
  // The app's debug state (a SIM_CHECK build writes it into its container): the editor is a web view the tree can't see into.
  let container = "";
  const probe = (): DebugState | null => {
    try {
      container ||= Bun.spawnSync(["xcrun", "simctl", "get_app_container", slot.udid, "com.markhuot.harness", "data"], { env: process.env }).stdout.toString().trim();
      return parseState(readFileSync(join(container, "tmp", PROBE_FILE), "utf8"));
    } catch {
      container = "";
      return null;
    }
  };
  const untilProbe = async (ok: (s: DebugState) => boolean, ms = 10000) => {
    const end = Date.now() + ms;
    let s = probe();
    while (!(s && ok(s)) && Date.now() < end) {
      await Bun.sleep(100);
      s = probe();
    }
    return s;
  };
  /** Reaches `link`, then reads the tree once; the screen's checks all run on that one read. */
  const visit = async (link: string) => {
    previous = await openLink(slot.udid, axe, link, previous);
    return axe.nodes();
  };

  await w.screen("board", async (expect) => {
    const els = await untilTree(() => axe.nodes(), (e) => has(e, new RegExp(`^${seeded.review.key} `)));
    for (const col of ["Planning", "In progress", "Blocked", "Review", "Done"]) expect(`${col} column chip`, has(els, new RegExp(`^${col}, \\d+$`)));
    expect("review card", has(els, new RegExp(`^${seeded.review.key} `)), seen(els));
    expect("palette field", els.some((e) => e.id === "palette-field"));
  });
  await w.screen("ticket spec", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.review.key}?tab=spec`);
    expect("ticket key shown", has(els, new RegExp(`${seeded.review.key}`)));
    expect("spec tab", has(els, "Spec"));
  });
  await w.screen("ticket activity", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.review.key}?tab=activity`);
    expect("the reviewer's note", has(els, /The dummy reviewer approves/));
  });
  await w.screen("ticket details", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.notes.key}?tab=details`);
    expect("models row", has(els, /^Models, /));
    // sim-check agent-notes: the notes start collapsed and a tap on the header opens and closes them.
    const open = (e: AXElement[]) => has(e, /Where things live/) && e.some((x) => x.id === "agent-notes");
    expect("agent notes header", has(els, /^Agent notes/), seen(els));
    expect("agent notes start collapsed", !open(els));
    await axe.tap("Agent notes");
    expect("a tap opens the notes", open(await untilTree(() => axe.nodes(), open)));
    await axe.tap("Agent notes");
    expect("a second tap closes them", !open(await untilTree(() => axe.nodes(), (e) => !open(e))));
  });
  await w.screen("blocked ticket", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.blocked.key}`);
    expect("the question is asked", has(els, /Which Apple Developer team/));
  });
  await w.screen("prompts", async (expect) => {
    const els = await visit("harness://prompts");
    expect("agent review prompt", has(els, "Agent review"));
  });
  await w.screen("settings", async (expect) => {
    const els = await visit("harness://settings");
    expect("appearance section with a theme choice", has(els, "Appearance") && has(els, "Light theme"), seen(els));
    // sim-check save-on-blur: scroll to the General switch (swipe from the headings; the theme strips swallow a swipe) and press it.
    const row = (e: AXElement[]) => e.filter((x) => x.label === "Save on blur").sort((a, b) => (b.frame?.x ?? 0) - (a.frame?.x ?? 0))[0];
    let sw = row(els);
    for (let i = 0; i < 40 && !(sw?.frame && sw.frame.y > 140 && sw.frame.y < 560); i++) {
      await axe.swipe(200, 520, 200, 170);
      await Bun.sleep(350);
      sw = row(await axe.nodes());
    }
    expect("a Save on blur switch", !!sw?.frame, seen(els));
    if (sw?.frame) {
      await Bun.sleep(1200); // the scroll's momentum has to be over before a press lands where the switch was
      sw = row(await axe.nodes())!;
      const before = sw.value;
      await axe.press(sw.frame!.x + sw.frame!.width - 28, sw.frame!.y + sw.frame!.height / 2);
      const after = await untilTree(() => axe.nodes(), (e) => row(e)?.value !== before);
      expect("the press flips the switch", row(after)?.value !== before, `still ${before}`);
    }
  });

  // sim-check agents-filter: the Tasks and Agents chips filter the list, and the filter survives opening a row and coming back.
  await w.screen("agents & tasks filter", async (expect) => {
    let els = await visit(`harness://ticket/${world.tasks.key}?tab=agents`);
    const rows = (e: AXElement[]) => ({ agents: e.filter((x) => /^Sub-task \d+, /.test(x.label ?? "")).length, tasks: e.filter((x) => x.label?.startsWith("Count to 30")).length });
    const shows = (agents: number, tasks: number) => async () => {
      const e = await untilTree(() => axe.nodes(), (x) => rows(x).agents === agents && rows(x).tasks === tasks, 5000);
      return rows(e);
    };
    const chip = (name: string) => tapWhere((l) => l.startsWith(`${name}, `));
    els = await untilTree(() => axe.nodes(), (e) => rows(e).tasks > 0);
    expect("every row: the task and two sub-agents", rows(els).agents === 2 && rows(els).tasks === 1, seen(els));
    await chip("Tasks");
    await chip("Agents");
    await chip("Tasks");
    expect("Agents on and Tasks off leaves only the sub-agents", JSON.stringify(await shows(2, 0)()) === '{"agents":2,"tasks":0}', seen(await axe.nodes()));
    await tapWhere((l) => /^Sub-task \d+, /.test(l));
    await untilTree(() => axe.nodes(), (e) => has(e, "Back to Agents & tasks"));
    await axe.tap("Back to Agents & tasks");
    expect("the filter survives opening a row and coming back", JSON.stringify(await shows(2, 0)()) === '{"agents":2,"tasks":0}', seen(await axe.nodes()));
    await chip("Agents");
    expect("neither pressed shows every row again", JSON.stringify(await shows(2, 1)()) === '{"agents":2,"tasks":1}', seen(await axe.nodes()));
  });

  // sim-check file-link: a spec's file link opens the viewer on its lines, the file clean and syntax colored.
  await w.screen("file link", async (expect) => {
    let els = await visit(`harness://ticket/${world.fileLink.key}?tab=spec`);
    const link = find(els, (l) => l === "greetingFor fallback");
    expect("the spec's link", !!link?.frame, seen(els));
    if (!link?.frame) return;
    await axe.tapAt(link.frame.x + 30, link.frame.y + link.frame.height / 2); // the paragraph is full width, the link only its first words
    const range = `lines ${GREETING_FOR[0]}–${GREETING_FOR[1]}`;
    els = await untilTree(() => axe.nodes(), (e) => has(e, new RegExp(GREETINGS_PATH)) && has(e, new RegExp(range)));
    expect("the viewer shows the path and the linked range", has(els, new RegExp(GREETINGS_PATH)) && has(els, new RegExp(range)), seen(els));
    expect("a clean file isn't shown as modified", !has(els, "Modified") && !has(els, "Diff"), seen(els));
    const s = await untilProbe((x) => (x.editor?.markedLines.length ?? 0) > 0);
    const marked = s?.editor?.markedLines ?? [];
    expect("the linked function's lines are marked", marked.length === GREETING_FOR[1] - GREETING_FOR[0] + 1 && !!marked[0]?.startsWith("export function greetingFor"), `marked ${marked.length}`);
    expect("the code is syntax colored", (s?.editor?.colors ?? 0) >= 3, `colors ${s?.editor?.colors}`);
  });
  // sim-check terraform highlight: a .tf file written into the ticket's worktree comes up colored.
  await w.screen("terraform highlight", async (expect) => {
    const wd = (await d.api<TicketDetail>("GET", `/tickets/${world.fileLink.key}`)).ticket.workdir!;
    mkdirSync(join(wd, "infra"), { recursive: true });
    writeFileSync(join(wd, "infra/main.tf"), 'resource "aws_s3_bucket" "logs" {\n  bucket = "harness-logs"\n  tags   = { Name = "logs" }\n}\n');
    try {
      await visit(`harness://file/infra/main.tf?ticket=${world.fileLink.key}`);
      const s = await untilProbe((x) => (x.editor?.colors ?? 0) >= 3, 15000);
      expect("main.tf carries syntax colors", (s?.editor?.colors ?? 0) >= 3, `colors ${s?.editor?.colors}`);
    } finally {
      rmSync(join(wd, "infra"), { recursive: true, force: true });
    }
  });
  // sim-check open-file: ⌘P with a typed line range opens the file on those lines.
  await w.screen("open file palette", async (expect) => {
    await visit(`harness://ticket/${world.fileLink.key}?tab=spec`);
    await axe.keyCombo(227, 19);
    const sheet = await untilProbe((x) => x.router.sheet === "palette:files", 8000);
    expect("⌘P opens the palette in file mode", sheet?.router.sheet === "palette:files", `sheet ${sheet?.router.sheet}`);
    await axe.type(`greetings:${GREETING_FOR[0]}-${GREETING_FOR[1]}`);
    const els = await untilTree(() => axe.nodes(), (e) => has(e, new RegExp(GREETINGS_PATH)), 10000);
    expect("the file is listed", has(els, new RegExp(GREETINGS_PATH)), seen(els));
    await tapWhere((l) => l.includes(GREETINGS_PATH));
    const s = await untilProbe((x) => (x.editor?.markedLines.length ?? 0) > 0);
    expect("the typed lines are marked in the editor", s?.editor?.markedLines.length === GREETING_FOR[1] - GREETING_FOR[0] + 1, `marked ${s?.editor?.markedLines.length}`);
  });

  // sim-check context-gauge: where the gauge sits and how big its tap target is, its menu and the About popover.
  /** Taps below the content until `gone` holds: the About popover sits over the menu, and a tap outside closes only the top one. */
  const closeMenu = async (gone: (e: AXElement[]) => boolean) => {
    const root = (await axe.nodes())[0]!.frame!;
    for (let i = 0; i < 3; i++) {
      await axe.tapAt(root.width * 0.5, root.height * 0.9);
      await Bun.sleep(500);
      if (gone(await axe.nodes())) break;
    }
  };
  const gaugeGone = (e: AXElement[]) => !has(e, "Limit…") && !has(e, /^(How much conversation the next run|A cache miss is a model call)/);
  await w.screen("context gauge", async (expect) => {
    let els = await visit(`harness://ticket/${world.gauge.key}?tab=spec`);
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Context 82k/));
    const gauge = find(els, (l) => l.startsWith("Context 82k"));
    const key = find(els, (l) => l === world.gauge.key);
    const title = find(els, (l) => l.startsWith("Gauge gauge"));
    const g = gauge?.frame, k = key?.frame, t = title?.frame;
    expect("the gauge, the key and the title are on screen", !!g && !!k && !!t, seen(els));
    if (!g || !k || !t) return;
    expect("the gauge sits in the meta row below the title, beside the key", g.y + g.height / 2 > t.y + t.height && Math.abs(g.y + g.height / 2 - (k.y + k.height / 2)) <= 12 && g.x >= k.x, `gauge ${JSON.stringify(g)} key ${JSON.stringify(k)}`);
    expect("the tap target is at least 44 pt tall", g.height >= 43, `${g.height} pt`);
    await axe.tap(gauge!.label!);
    els = await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    expect("the menu lists Limit…", has(els, "Limit…"), seen(els));
    await axe.tap("About this gauge");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^How much conversation the next run/), 5000);
    expect("About this gauge explains it", has(els, /^How much conversation the next run/), seen(els));
    await closeMenu(gaugeGone);
  });
  await w.screen("context gauge limit", async (expect) => {
    await visit(`harness://ticket/${world.gauge.key}?tab=spec`);
    await untilTree(() => axe.nodes(), (e) => has(e, /^Context 82k/));
    await tapWhere((l) => l.startsWith("Context 82k"));
    await untilTree(() => axe.nodes(), (e) => has(e, "New session"), 5000);
    await axe.tap("New session");
    let els = await untilTree(() => axe.nodes(), (e) => has(e, "Start a new session?"), 5000);
    expect("New session asks first", has(els, "Start a new session?"), seen(els));
    for (let i = 0; i < 4 && has(await axe.nodes(), "Start a new session?"); i++) { // a tap while the alert animates in is swallowed
      await axe.tap("Cancel");
      await Bun.sleep(700);
    }
    expect("Cancel closes the confirmation", !has(await axe.nodes(), "Start a new session?"));
    await tapWhere((l) => l.startsWith("Context 82k"));
    await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    await axe.tap("Limit…");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^How many tokens the gauge counts up to/), 5000);
    expect("Limit… opens the limit sheet", has(els, /^How many tokens the gauge counts up to/), seen(els));
    // The sheet's Cancel isn't in the tree: it sits at the leading edge, 86 pt above the field's centre.
    const sheetUp = (e: AXElement[]) => has(e, /^How many tokens the gauge counts up to/);
    for (let i = 0; i < 4 && sheetUp(els); i++) { // the first taps after a presentation are swallowed
      const field = els.find((e) => e.id === "context-limit-field")?.frame;
      if (field) await axe.tapAt(61, field.y + field.height / 2 - 86);
      els = await untilTree(() => axe.nodes(), (e) => !sheetUp(e), 2500);
    }
    expect("Cancel closes the sheet", !has(els, /^How many tokens the gauge counts up to/), seen(els));
  });
  await w.screen("context gauge states", async (expect) => {
    let els = await visit(`harness://ticket/${world.gaugeMiss.key}?tab=spec`);
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Context 100k/));
    expect("the gauge counts the misses", has(els, /^Context 100k/), seen(els));
    await tapWhere((l) => l.startsWith("Context 100k"));
    await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    await tapWhere((l) => l.startsWith("3 cache misses"));
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^A cache miss is a model call/), 5000);
    expect("the misses row explains a cache miss", has(els, /^A cache miss is a model call/), seen(els));
    await closeMenu(gaugeGone);
    // A running compact run: the gauge says so and the composer is replaced.
    startCompacting(d, world.gaugeCompact);
    els = await visit(`harness://ticket/${world.gaugeCompact.key}?tab=spec`);
    els = await untilTree(() => axe.nodes(), (e) => has(e, "Context, compacting"));
    expect("the gauge reads compacting", has(els, "Context, compacting"), seen(els));
    expect("the composer says Compacting…", has(els, "Compacting…") && !has(els, "Message the agent"), seen(els));
  });
  // The one tap: the board's palette field opens the palette sheet.
  await w.screen("command palette", async (expect) => {
    previous = await openLink(slot.udid, axe, "harness://board", previous);
    const listed = (e: AXElement[]) => has(e, "Go to Inbox, Go to");
    /** Taps the board's field until the palette lists its commands: a tap during the sheet's dismissal is swallowed. */
    const openPalette = async () => {
      let e: AXElement[] = [];
      for (let i = 0; i < 4 && !listed(e); i++) {
        await axe.tap("Command palette");
        e = await untilTree(() => axe.nodes(), listed, 3000);
      }
      return e;
    };
    const closed = async () => {
      await untilTree(() => axe.nodes(), (e) => !listed(e));
      await Bun.sleep(800); // the sheet's dismissal animation
    };
    let els = await openPalette();
    expect("the palette lists commands", has(els, "Go to Inbox, Go to") && has(els, "Open Settings, Go to"), seen(els));
    // sim-check palette: running Show child tickets closes the palette and flips its label.
    await axe.tap("Show child tickets, General");
    await closed();
    await openPalette();
    const flipped = await untilTree(() => axe.nodes(), (e) => has(e, /^Hide child tickets/));
    expect("Show child tickets flips to Hide child tickets", has(flipped, /^Hide child tickets/), seen(flipped));
    await axe.tap("Hide child tickets, General"); // back to the default
    await closed();
    // A leading > shows only commands: the ticket matching the query isn't listed.
    await openPalette();
    await axe.type(">hello");
    await Bun.sleep(1500); // past the search's pause
    const commands = await axe.nodes();
    expect("a > query lists no ticket", !has(commands, new RegExp(`^${seeded.review.key} `)), seen(commands));
  });
  // sim-check palette: ⌘K over a ticket lists its actions; Copy ticket key copies it.
  await w.screen("ticket commands", async (expect) => {
    previous = await openLink(slot.udid, axe, `harness://ticket/${seeded.review.key}?tab=spec`, previous);
    await axe.keyCombo(227, 14);
    const els = await untilTree(() => axe.nodes(), (e) => has(e, /^Copy ticket key/));
    expect("the ticket's commands", has(els, /^Copy ticket key/), seen(els));
    await axe.tap("Copy ticket key, Ticket");
    await Bun.sleep(500);
    const copied = Bun.spawnSync(["xcrun", "simctl", "pbpaste", slot.udid], { env: process.env }).stdout.toString().trim();
    expect("Copy ticket key copies the key", copied === seeded.review.key, `copied "${copied}"`);
  });
  // sim-check usage: the sidebar's plan-usage gauges, read from the proxy's fixture. Last, since it relaunches the app.
  await w.screen("plan usage", async (expect) => {
    const showSidebar = async () => {
      previous = await openLink(slot.udid, axe, "harness://projects", { url: "", key: "" });
      return untilTree(() => axe.nodes(), (e) => has(e, "PLAN USAGE") && has(e, /^Claude Code 5-hour/));
    };
    const usageRows = async () => (await axe.nodes()).filter((e) => /^(Claude Code|GitHub Copilot)\b/.test(e.label ?? ""));
    let els = await showSidebar();
    expect("a gauge for each window", has(els, /^Claude Code 5-hour/) && has(els, /^Claude Code Weekly/), seen(els));
    const info = /^How much of your plan's usage limits/;
    for (let i = 0; i < 4 && !has(els, info); i++) { // the first tap after the sidebar draws is swallowed
      await axe.tap("About plan usage");
      els = await untilTree(() => axe.nodes(), (e) => has(e, info), 2500);
    }
    expect("the info popover explains the gauges", has(els, info), seen(els));
    // A tap outside closes it; start low on the sheet, since one on the backdrop above it closes the sidebar itself.
    for (const y of [400, 800, 400, 800, 60]) {
      if (!has(await axe.nodes(), info)) break;
      await axe.tapAt(200, y);
      await Bun.sleep(800);
    }
    if (!has(await axe.nodes(), "PLAN USAGE")) await showSidebar(); // a tap on the wrong layer closed the sidebar itself
    const choose = async (item: string) => {
      await axe.tap("Plan usage options");
      await untilTree(() => axe.nodes(), (e) => has(e, item), 5000);
      await axe.tap(item);
      await Bun.sleep(600);
    };
    await choose("Projected at reset");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Claude Code Weekly: on pace for 56% · 45% used, resets/));
    expect("Projected at reset shows the pace", has(els, /^Claude Code Weekly: on pace for 56% · 45% used, resets/), seen(els));
    await choose("GitHub Copilot");
    els = await untilTree(() => axe.nodes(), (e) => !has(e, /^Claude Code/));
    const copilot = await usageRows();
    expect("filtering to Copilot hides Claude's rows", copilot.length > 0 && copilot.every((e) => /^GitHub Copilot/.test(e.label!)), seen(els));
    // The choice is @AppStorage: it survives a relaunch.
    Bun.spawnSync(["xcrun", "simctl", "terminate", slot.udid, "com.markhuot.harness"]);
    Bun.spawnSync(["xcrun", "simctl", "launch", slot.udid, "com.markhuot.harness"]);
    await untilTree(() => axe.nodes(), (e) => has(e, /^Planning, \d+$/), 15000);
    await showSidebar().catch(() => []);
    const kept = await untilTree(() => axe.nodes(), (e) => has(e, /^GitHub Copilot/), 8000);
    expect("the filter survives a relaunch", has(kept, /^GitHub Copilot/) && !has(kept, /^Claude Code/), seen(kept));
    await choose("Hide");
    els = await untilTree(() => axe.nodes(), (e) => has(e, "PLAN USAGE") && !has(e, /^(Claude Code|GitHub Copilot)/), 5000);
    expect("Hide removes the rows and keeps the header", has(els, "PLAN USAGE") && !has(els, /^(Claude Code|GitHub Copilot)/), seen(els));
    await choose("All drivers");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Claude Code 5-hour|^Claude Code, 5-hour/), 5000);
    expect("All drivers brings the rows back", has(els, /^Claude Code/), seen(els));
  });
} finally {
  usageProxy.stop();
  await axe_terminate();
  slot.release();
  await stopDaemon(d);
}
async function axe_terminate() {
  Bun.spawnSync(["xcrun", "simctl", "terminate", slot.udid, "com.markhuot.harness"]);
}
const { failed } = w.summary();
console.log(`total ${Math.round(performance.now() - started)} ms including build, seed, install and pairing`);
process.exit(failed.length ? 1 : 0);
