// The iPhone walkthrough: one install over a seeded daemon, one linear pass, a report per screen.
// Every screen is reached once, by `harness://` deep link where one exists and by a tap where none
// does (the command palette, last, so nothing has to dismiss it). Assertions read the accessibility
// tree. It exists for verification, never for spec screenshots.
//
//   bun run sim with-lock -- bun next/walkthrough/ios.ts [--no-build]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPairUrl, type TicketDetail } from "@harness/shared";
import { axeFor, hasAxe, type AXElement } from "../../ios/Tools/axe";
import { installAndPair, seed, startDaemon, stopDaemon, buildApp } from "../../ios/Tools/dev-sim";
import { GREETINGS_PATH, GREETING_FOR } from "../../ios/Tools/fixtures";
import { parseState, PROBE_FILE, settled as probeSettled, type DebugState } from "../../ios/Tools/probe";
import { acquireReady, exportDeveloperDir } from "../../ios/Tools/sim";
import { until } from "@harness/shared/testing/daemon";
import { FAKE_CLAUDE_ENV, REVIEW_PROMPT, REVIEW_PROMPT_ID, startCompacting, startUsageProxy, seedWorld, WORLD_FILES } from "./world";
import { walk } from "./walk";

const started = performance.now();
let restStatsOut = () => ({ n: 0, ms: 0, missed: 0 });
if (!hasAxe()) throw new Error("the walkthrough reads the UI tree with AXe: brew install cameroncooke/axe/axe");
exportDeveloperDir();
const app = process.argv.includes("--no-build") ? join(resolve(import.meta.dir, "../../ios"), "build/dd/Build/Products/Release-iphonesimulator/Harness.app") : await buildApp();
if (!existsSync(app)) throw new Error(`${app} doesn't exist; drop --no-build`);
const d = await startDaemon(FAKE_CLAUDE_ENV);
const seeded = await seed(d, WORLD_FILES);
const world = await seedWorld(d, seeded);
const usageProxy = startUsageProxy(d); // the app pairs through it: it answers GET /usage and forwards the rest
console.log(`built and seeded in ${Math.round(performance.now() - started)} ms`);
const slot = await acquireReady({ onWait: () => console.log("waiting for a shared simulator…") }, {});
// A screenshot of what a failing screen saw, when WALK_SHOTS names a directory.
const w = walk("iPhone walkthrough", (name) => {
  if (process.env.WALK_SHOTS) Bun.spawnSync(["xcrun", "simctl", "io", slot.udid, "screenshot", join(process.env.WALK_SHOTS, `${name.replace(/\W+/g, "-")}.png`)], { env: process.env });
});
try {
  const rawAxe = axeFor(slot.udid, process.env.DEVELOPER_DIR!, { strict: true });
  // One tree read serves every look at the screen until something acts on it: a read taken while the app was at rest is kept
  // for 1.5 s, and any tap, swipe, key or typing (any AXe call but a read), or any change in the app's debug state, drops it.
  let cache: { els: AXElement[]; at: number; sig: string } | null = null;
  const stateSig = () => {
    const s = probe();
    return s ? JSON.stringify([s.settled, s.busy, s.router, s.focus, s.editor]) : "";
  };
  const calm = () => {
    const s = probe();
    return !!s && s.settled && s.quietMs >= 100;
  };
  const cachedTree = () => (cache && cache.sig && Date.now() - cache.at < 1500 && cache.sig === stateSig() ? cache.els : null);
  const axe = Object.fromEntries(
    Object.entries(rawAxe).map(([k, f]) => [
      k,
      k === "nodes"
        ? async () => {
            const sig = stateSig();
            const rested = calm();
            const els = await rawAxe.nodes();
            cache = rested && calm() && stateSig() === sig ? { els, at: Date.now(), sig } : null;
            return els;
          }
        : k === "labels" ? f : (...a: unknown[]) => { cache = null; return (f as (...x: unknown[]) => unknown)(...a); },
    ]),
  ) as typeof rawAxe;
  const t0 = performance.now();
  await installAndPair(slot.udid, axe, app, buildPairUrl(usageProxy.base, d.token));
  console.log(`installed and paired in ${Math.round(performance.now() - t0)} ms`);
  const seen = (els: AXElement[]) => "on screen: " + els.map((e) => e.label ?? e.id).filter(Boolean).slice(0, 25).join(" | ");
  const has = (els: AXElement[], match: RegExp | string) => els.some((e) => (typeof match === "string" ? e.label === match : !!e.label && match.test(e.label)));
  /** The tree once `ok` holds (a screen draws after the link lands), or the last read after 8 s so the screen reports what it saw. */
  const untilTree = async (read: () => Promise<AXElement[]>, ok: (els: AXElement[]) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    const hit = cachedTree();
    if (hit && ok(hit)) return hit;
    // Wait for the app to stop moving before the first read, and between reads for the debug state to change (1 s at most, for
    // data that lands without a visible change): a read costs ~350 ms, and one taken mid-animation is rarely the one that passes.
    await atRest();
    let els = await read();
    while (!ok(els) && Date.now() < end) {
      const sig = stateSig();
      const until = Math.min(end, Date.now() + 1000);
      while (stateSig() === sig && Date.now() < until) await Bun.sleep(50);
      els = await read();
    }
    return els;
  };
  /** The first element whose label passes `match`. */
  const find = (els: AXElement[], match: (label: string) => boolean) => els.find((e) => !!e.label && match(e.label));
  const sameFrame = (a: AXElement | undefined, b: AXElement | undefined) => !!a?.frame && !!b?.frame && JSON.stringify(a.frame) === JSON.stringify(b.frame);
  /**
   * The element `pick` finds once the app is at rest (the debug probe says nothing is animating,
   * scrolling or loading), from one read of the tree. A sheet, popover or alert that is still animating
   * in swallows a tap. Without a probe, once two reads in a row put the element in the same place.
   */
  const settled = async (pick: (els: AXElement[]) => AXElement | undefined, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    let prev: AXElement | undefined;
    for (let first = true; ; first = false) {
      const resting = await atRest();
      const els = (first && resting ? cachedTree() : null) ?? (await axe.nodes());
      const e = pick(els);
      if (e && (resting || sameFrame(e, prev))) return e;
      if (Date.now() > end) throw new Error(`${what} never settled on screen; ${e ? "it kept moving" : "it isn't in the tree"}; ${els.map((x) => x.id ?? x.label).filter(Boolean).slice(0, 40).join(" | ")}`);
      prev = e;
    }
  };
  /** The tree once the app is at rest: a scroll's momentum is over. Without a probe, once nothing in it moves between two reads. */
  const quiet = async (ms = 8000) => {
    if (await atRest()) return axe.nodes();
    return framesStill(ms);
  };
  const framesStill = async (ms: number) => {
    const end = Date.now() + ms;
    const sig = (els: AXElement[]) => JSON.stringify(els.map((e) => e.frame));
    let els = await axe.nodes();
    for (let prev = ""; sig(els) !== prev && Date.now() < end; ) {
      prev = sig(els);
      els = await axe.nodes();
    }
    return els;
  };
  /** Waits for the app to be at rest without reading the tree (for a caller that only needs the motion over); the tree comparison is the fallback when the probe doesn't answer. */
  const rest = async (ms = 8000) => {
    if (!(await atRest())) await framesStill(ms);
  };
  /** Taps the element with this accessibilityIdentifier once it has settled: straight away when the app is at rest, which needs no read of the tree, else after finding it. */
  const tapId = async (id: string) => {
    if (await atRest()) {
      try {
        await axe.tapId(id);
        return;
      } catch {
        // not drawn yet: find it below
      }
    }
    await settled((els) => els.find((e) => e.id === id), id);
    await axe.tapId(id);
  };
  /** Taps the element whose label passes `match`, by its identifier when it has one (a label often carries live numbers), else by its exact label. */
  const tapWhere = async (match: (label: string) => boolean) => {
    const e = await settled((els) => find(els, match), "the element to tap");
    await (e.id ? axe.tapId(e.id) : axe.tap(e.label!));
  };
  /** Closes the topmost popover: UIKit draws a full-screen dismiss region under each, the last in the tree is the top one, and a tap near its bottom edge is outside the popover. */
  const dismissPopover = async () => {
    const region = await settled((els) => els.filter((e) => e.id === "PopoverDismissRegion").at(-1), "a popover's dismiss region");
    const f = region.frame!;
    await axe.tapAt(f.x + f.width / 2, f.y + f.height * 0.9);
  };
  /** Taps the middle of the element's frame, for a control a tap by label doesn't reach (a small radio button in a list row). */
  const tapCenter = async (match: (label: string) => boolean) => {
    const f = (await settled((els) => find(els, match), "the element to tap")).frame!;
    await axe.tapAt(f.x + f.width / 2, f.y + f.height / 2);
  };
  /** Taps the element labelled exactly `label` once it has settled (an alert's or a menu's button has no identifier). */
  const tapLabel = (label: string) => tapWhere((l) => l === label);
  /** A text field holds the focus, which the app's debug state names; the keyboard isn't in the tree. Typing before it does drops keys. */
  const untilKeyboard = async () => {
    const s = await untilProbe((x) => !!x.focus);
    if (!s?.focus) throw new Error(`no field took the focus; ${seen(await axe.nodes())}`);
    await rest(); // the keyboard has finished sliding in
  };
  /** Closes every docked ticket sheet, which cover the next screen's controls: opening Projects does it in one step, whatever the count. */
  const clearDock = async () => {
    if (!probe()?.router.dock.length) return;
    await open("harness://projects");
    const s = await untilProbe((x) => x.router.dock.length === 0);
    if (s?.router.dock.length) throw new Error(`the dock didn't clear; ${seen(await axe.nodes())}`);
    await open("harness://board");
  };
  /** Taps the field and types into it once it holds the focus. */
  const typeInto = async (match: (label: string) => boolean, text: string) => {
    await tapWhere(match);
    await untilKeyboard();
    await axe.type(text);
  };
  /** The field's text, as VoiceOver reads it. */
  const valueOf = (els: AXElement[], match: (label: string) => boolean) => find(els, match)?.value ?? "";
  const ticketOf = async (key: string) => (await d.api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
  const prompts = async () => d.api<{ id: string; override: string | null }[]>("GET", "/prompts");
  const override = async (id: string) => (await prompts()).find((p) => p.id === id)!.override;
  /** The app is up showing something: its root element is "Harness". A crash leaves SpringBoard's tree. */
  const appUp = (els: AXElement[]) => els[0]?.label === "Harness";
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
  /** The app is at rest, which its debug probe says; false when the probe isn't answering (the callers fall back to comparing reads of the tree). */
  const restStats = { n: 0, ms: 0, missed: 0 };
  restStatsOut = () => restStats;
  const atRest = async (ms = 800) => {
    const t = performance.now();
    const s = await probeSettled(async () => probe(), { quietMs: 100, fresh: 2, ms }).catch(() => null);
    restStats.n++;
    restStats.ms += performance.now() - t;
    const ok = !!s && s !== "frozen";
    if (!ok) {
      restStats.missed++;
      if (process.env.WALK_TIMING) { const x = probe(); console.log(`  atRest missed: ${s === "frozen" ? "frozen" : x ? `settled=${x.settled} busy=[${x.busy}] quietMs=${x.quietMs} focus=${x.focus ?? ""}` : "no probe"}`); }
    }
    return ok;
  };
  /** Opens a link in the running app and returns once the router has moved to it (a link to the screen already open leaves it alone: it waits 1 s for a change) and the app is at rest. */
  const open = async (link: string) => {
    const route = (s: DebugState | null) => (s ? JSON.stringify(s.router) : "");
    const before = route(probe());
    const r = Bun.spawnSync(["xcrun", "simctl", "openurl", slot.udid, link], { env: process.env });
    if (r.exitCode !== 0) throw new Error(`simctl openurl ${link}: ${r.stderr.toString().trim()}`);
    await untilProbe((x) => route(x) !== before, 1000);
    await atRest();
  };
  /** Reaches `link`, then reads the tree once; the screen's checks all run on that one read. */
  const visit = async (link: string, ready?: (els: AXElement[]) => boolean) => {
    await open(link);
    // `ready` says it's the screen the link names (a screen draws after its data lands).
    return ready ? untilTree(() => axe.nodes(), ready) : axe.nodes();
  };
  const composerUp = (e: AXElement[]) => has(e, /^Message the agent/);
  /**
   * Starts the app again (a pairing survives it) with its animations off: the walkthrough checks what a screen shows, and a
   * transition is only time spent waiting for it to end. WALK_ANIMATIONS=1 keeps them, for a run that wants the real motion.
   */
  const relaunch = () => {
    probe(); // finds the container
    Bun.spawnSync(["xcrun", "simctl", "terminate", slot.udid, "com.markhuot.harness"]);
    rmSync(join(container, "tmp", PROBE_FILE), { force: true }); // the old launch's state must not pass for the new one's
    const env = process.env.WALK_ANIMATIONS === "1" ? process.env : { ...process.env, SIMCTL_CHILD_HARNESS_NO_ANIMATIONS: "1" };
    Bun.spawnSync(["xcrun", "simctl", "launch", slot.udid, "com.markhuot.harness"], { env });
  };
  relaunch();

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
    await tapId("agent-notes-toggle");
    expect("a tap opens the notes", open(await untilTree(() => axe.nodes(), open)));
    await tapId("agent-notes-toggle");
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
    // sim-check save-on-blur: jump to the General section (no swipes) and press the switch.
    const sw = (e: AXElement[]) => e.find((x) => x.id === "settings-save-on-blur");
    const cur = await visit("harness://settings?section=general", (e) => !!sw(e)?.frame);
    expect("a Save on blur switch", !!sw(cur)?.frame, seen(cur));
    if (sw(cur)?.frame) {
      const el = await settled(sw, "the Save on blur switch");
      const before = el.value;
      await axe.press(el.frame!.x + el.frame!.width / 2, el.frame!.y + el.frame!.height / 2); // a Toggle ignores the instant tap `tapId` sends
      const after = await untilTree(() => axe.nodes(), (e) => sw(e)?.value !== before);
      expect("the press flips the switch", sw(after)?.value !== before, `still ${before}`);
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
    const chip = (name: string) => tapId(`agents-filter-${name.toLowerCase()}`);
    els = await untilTree(() => axe.nodes(), (e) => rows(e).tasks > 0);
    expect("every row: the task and two sub-agents", rows(els).agents === 2 && rows(els).tasks === 1, seen(els));
    await chip("Tasks");
    await chip("Agents");
    await chip("Tasks");
    expect("Agents on and Tasks off leaves only the sub-agents", JSON.stringify(await shows(2, 0)()) === '{"agents":2,"tasks":0}', seen(await axe.nodes()));
    await tapWhere((l) => /^Sub-task \d+, /.test(l));
    await tapId("agents-back");
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
  /** Dismisses the menu and whatever popover sits over it: each tap on the popover scrim closes the top one. */
  const closeMenu = async (gone: (e: AXElement[]) => boolean) => {
    for (let i = 0; i < 3 && !gone(await axe.nodes()); i++) {
      await dismissPopover();
      await untilTree(() => axe.nodes(), gone, 3000);
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
    await tapId("ticket-context-gauge");
    els = await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    expect("the menu lists Limit…", has(els, "Limit…"), seen(els));
    await tapId("ticket-context-about");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^How much conversation the next run/), 5000);
    expect("About this gauge explains it", has(els, /^How much conversation the next run/), seen(els));
    await closeMenu(gaugeGone);
  });
  await w.screen("context gauge limit", async (expect) => {
    await visit(`harness://ticket/${world.gauge.key}?tab=spec`);
    await untilTree(() => axe.nodes(), (e) => has(e, /^Context 82k/));
    await tapId("ticket-context-gauge");
    await untilTree(() => axe.nodes(), (e) => has(e, "New session"), 5000);
    await tapId("ticket-context-new-session");
    let els = await untilTree(() => axe.nodes(), (e) => has(e, "Start a new session?"), 5000);
    expect("New session asks first", has(els, "Start a new session?"), seen(els));
    await tapLabel("Cancel");
    els = await untilTree(() => axe.nodes(), (e) => !has(e, "Start a new session?"), 5000);
    expect("Cancel closes the confirmation", !has(els, "Start a new session?"));
    await tapId("ticket-context-gauge");
    await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    await tapId("ticket-context-limit");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^How many tokens the gauge counts up to/), 5000);
    expect("Limit… opens the limit sheet", has(els, /^How many tokens the gauge counts up to/), seen(els));
    await tapId("context-limit-cancel");
    els = await untilTree(() => axe.nodes(), (e) => !has(e, /^How many tokens the gauge counts up to/), 5000);
    expect("Cancel closes the sheet", !has(els, /^How many tokens the gauge counts up to/), seen(els));
  });
  await w.screen("context gauge states", async (expect) => {
    let els = await visit(`harness://ticket/${world.gaugeMiss.key}?tab=spec`);
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Context 100k/));
    expect("the gauge counts the misses", has(els, /^Context 100k/), seen(els));
    await tapId("ticket-context-gauge");
    await untilTree(() => axe.nodes(), (e) => has(e, "Limit…"), 5000);
    await tapId("ticket-context-misses-row");
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
  // sim-check routes: every screen a link can open comes up without taking the app down.
  await w.screen("routes", async (expect) => {
    const enc = encodeURIComponent;
    const pluginLoaded = (e: AXElement[]) => has(e, "Changes") && !has(e, "In progress");
    const routes: [string, string, (e: AXElement[]) => boolean][] = [
      ["projects", "harness://projects", (e) => has(e, "PLAN USAGE")],
      ["ticket with code", `harness://ticket/${world.code.key}?tab=spec`, (e) => has(e, /export const greeting/)],
      ["conductor's children", `harness://ticket/${world.conductor.key}?tab=children`, (e) => has(e, /Add a greet helper/)],
      ["a nested sub-agent", `harness://ticket/${world.approvable.key}?tab=${enc(`agent:${world.nestedAgent.id}`)}`, (e) => has(e, "Back to Agents & tasks")],
      ["a pending approval", `harness://ticket/${world.approval.key}`, (e) => has(e, "Allow once")],
      ["the Changes tab", `harness://ticket/${world.changes.key}?tab=plugin:git:changes`, pluginLoaded],
      ["New session", `harness://new?projectId=${seeded.project.id}`, (e) => has(e, /^Spec/)],
      ["the Inbox", "harness://inbox", (e) => has(e, /empty name/)],
      ["Connect", "harness://connect", appUp],
    ];
    for (const [name, link, ready] of routes) {
      await open(link);
      const els = await untilTree(() => axe.nodes(), (e) => appUp(e) && ready(e));
      expect(`${name} opens`, appUp(els) && ready(els), seen(els));
    }
    // Connect is a sheet: close it, or it covers every screen after.
    await tapLabel("Cancel");
    await untilTree(() => axe.nodes(), (e) => !has(e, "Connect to a Mac"));
  });

  // sim-check blocked-composer: a message to a blocked ticket is sent from the composer, and the Transcript opens.
  await w.screen("blocked composer", async (expect) => {
    await clearDock();
    await visit(`harness://ticket/${seeded.blocked.key}`, composerUp);
    // The dummy picks the work back up only when told to.
    await typeInto((l) => l.startsWith("Message the agent"), "[dummy:unblock]");
    await tapId("composer-send");
    // A sent message opens the Transcript, where its run rows show: the ticket opened on its Spec.
    const els = await untilTree(() => axe.nodes(), (e) => e.some((x) => x.id?.startsWith("run-header")));
    expect("the Transcript is shown", els.some((x) => x.id?.startsWith("run-header")), seen(els));
  });
  // sim-check approve-and: the Approve menu's Approve and… takes typed instructions and approves.
  await w.screen("approve and…", async (expect) => {
    await clearDock();
    await visit(`harness://ticket/${world.approvable.key}?tab=spec`, (e) => e.some((x) => x.id === "ticket-approve-more"));
    await tapId("ticket-approve-more");
    await tapLabel("Approve and…");
    await untilKeyboard(); // the sheet focuses its field
    await axe.type("v2");
    await quiet(); // the field takes no value in the tree, so the typing has landed once the screen is still
    await tapId("approve-and-submit");
    const t = await until(`${world.approvable.key} approved`, async () => (((x) => (x.humanReview === "approved" ? x : null))(await ticketOf(world.approvable.key))), 15000, 100).catch(() => null);
    expect("Approve sends the instructions and approves the ticket", !!t, `humanReview ${(await ticketOf(world.approvable.key)).humanReview}`);
  });
  // sim-check prompt-editor: a bad variable shows inline and can't save; Save stores the fixed override; Reset (confirmed) clears it.
  await w.screen("prompt editor", async (expect) => {
    await clearDock();
    const field = (l: string) => l === "Work run instructions prompt";
    const saveShortcut = () => axe.keyCombo(227, 22); // ⌘S: the header's buttons aren't in the tree, and Save has this shortcut only while enabled
    await visit("harness://prompt/system.work", (e) => e.some((x) => x.id === "prompt-customize"));
    await tapId("prompt-customize");
    await untilTree(() => axe.nodes(), (e) => has(e, "Compare with built-in"));
    await typeInto(field, " {{brnch}}");
    let els = await untilTree(() => axe.nodes(), (e) => has(e, /^Unknown variable \{\{brnch\}\}/));
    expect("an unknown variable shows inline", has(els, /^Unknown variable \{\{brnch\}\}/), seen(els));
    await saveShortcut(); // disabled while invalid, so the shortcut isn't there; a save would be in flight by the time the tree has been read twice
    await quiet();
    expect("an invalid prompt isn't saved", (await override("system.work")) === null);
    await axe.keys(Array(10).fill(42)); // takes the bad variable's ten characters back out
    await axe.type(" x{{branch}}");
    await untilTree(() => axe.nodes(), (e) => !has(e, /^Unknown variable/));
    await saveShortcut();
    const saved = await until("override saved", async () => ((v) => (v?.includes("x{{branch}}") ? v : null))(await override("system.work")), 8000, 100).catch(() => null);
    expect("Save stores the fixed override", !!saved, `override ${JSON.stringify(await override("system.work"))}`);
    await untilTree(() => axe.nodes(), (e) => e.some((x) => x.id === "prompt-reset"));
    // Typing left the editor scrolled to the end of the long prompt, past the button: the section link opens it at the buttons.
    await visit("harness://prompt/system.work?section=actions", (e) => e.some((x) => x.id === "prompt-reset" && !!x.frame && x.frame.y < 400));
    await tapId("prompt-reset");
    await tapLabel("Reset"); // the confirmation alert; `settled` waits out its presentation
    const cleared = await until("override cleared", async () => ((await override("system.work")) === null ? true : null), 8000, 100).catch(() => null);
    expect("Reset to built-in, confirmed, clears the override", !!cleared);
    els = await untilTree(() => axe.nodes(), (e) => e.some((x) => x.id === "prompt-customize"));
    expect("the prompt is read-only again", els.some((x) => x.id === "prompt-customize"), seen(els));
  });
  // sim-check prompt-editor: a tapped variable goes in at the cursor, and the next key follows it.
  await w.screen("prompt variable chip", async (expect) => {
    await clearDock();
    const field = (l: string) => l === "Agent review prompt";
    const els = await visit(`harness://prompt/${REVIEW_PROMPT_ID}`, (e) => e.some((x) => x.id === "prompt-reset"));
    const f = await settled((e) => find(e, field), "the editor field");
    await axe.tapAt(f.frame!.x + f.frame!.width - 20, f.frame!.y + f.frame!.height - 16); // past the end of the text: the caret goes to the end
    await untilKeyboard();
    await tapId("prompt-var-key");
    await untilTree(() => axe.nodes(), (e) => valueOf(e, field).endsWith("{{key}}"));
    await axe.type("Z");
    const typed = await untilTree(() => axe.nodes(), (e) => valueOf(e, field).endsWith("{{key}}Z"));
    expect("the variable is inserted at the caret and the next key follows it", valueOf(typed, field).endsWith("then the diff.{{key}}Z"), `the field reads ${JSON.stringify(valueOf(typed, field).slice(-40))}; focus ${probe()?.focus}; ${seen(typed)}`);
    await axe.keyCombo(227, 22);
    const saved = await until("override saved", async () => ((v) => (v !== REVIEW_PROMPT ? v : null))(await override(REVIEW_PROMPT_ID)), 8000, 100).catch(() => null);
    expect("Save stores the text with the variable", !!saved?.endsWith("then the diff.{{key}}Z"), `override ${JSON.stringify(saved?.slice(-30))}`);
    await d.api("PATCH", "/settings", { prompts: { [REVIEW_PROMPT_ID]: REVIEW_PROMPT } });
  });
  // sim-check models-picker: a tap on a model in the Models picker saves it to the phase.
  await w.screen("models picker", async (expect) => {
    await clearDock();
    await visit(`harness://ticket/${world.branchPlan.key}?tab=details`, (e) => has(e, /^Models, /));
    await tapWhere((l) => l.startsWith("Models, "));
    // Narrow the list first: the sheet is lazy, and a long driver list ahead of Dummy's can leave its rows out of the tree.
    await typeInto((l) => l === "Search models", "slow");
    await quiet(); // the list re-filters as the text lands, and a tap on a row that is still moving misses
    await tapCenter((l) => l.startsWith("Work, ") && l.endsWith("Dummy Slow"));
    const picked = await until("work model saved", async () => (((x) => (x.phaseModels?.work?.driver === "dummy" && x.phaseModels.work.model === "dummy-slow" ? x : null))(await ticketOf(world.branchPlan.key))), 8000, 100).catch(() => null);
    expect("the pick is saved to the Work phase", !!picked, `phaseModels ${JSON.stringify((await ticketOf(world.branchPlan.key)).phaseModels)}`);
    await tapLabel("Done"); // the sheet stays open after a pick
  });
  // sim-check file-edit: the file editor edits, shows the unsaved dot and writes the file with Save.
  await w.screen("file editor save", async (expect) => {
    await clearDock();
    const wd = (await ticketOf(world.fileLink.key)).workdir!;
    const path = join(wd, GREETINGS_PATH);
    const original = readFileSync(path, "utf8");
    const dot = (e: AXElement[]) => has(e, "Unsaved changes");
    try {
      await visit(`harness://file/${GREETINGS_PATH}?ticket=${world.fileLink.key}`, (e) => has(e, new RegExp(GREETINGS_PATH)));
      await untilProbe((x) => !!x.editor && !x.busy.includes("editor")); // the page has loaded and said it's ready
      const save = await settled((e) => find(e, (l) => l === "Save"), "Save");
      const root = (await axe.nodes())[0]!.frame!;
      await axe.tapAt(root.width / 2, save.frame!.y + save.frame!.height + 120); // into the editor below the info bar
      await untilKeyboard();
      await axe.type("qzx"); // short, and not in the file
      const dirty = await untilTree(() => axe.nodes(), dot);
      expect("a keystroke marks the file unsaved", dot(dirty), seen(dirty));
      expect("the edit hasn't reached the disk before Save", !readFileSync(path, "utf8").includes("qzx"));
      await tapLabel("Save");
      const clean = await untilTree(() => axe.nodes(), (e) => !dot(e));
      expect("Save clears the unsaved dot", !dot(clean), seen(clean));
      expect("the editor agrees it's clean", (await untilProbe((x) => x.editor?.dirty === false))?.editor?.dirty === false);
      expect("Save wrote the edit to the file", readFileSync(path, "utf8").includes("qzx"));
    } finally {
      writeFileSync(path, original); // the file is the ticket's, and the file link screens read it as clean
    }
    await visit("harness://board"); // the file screen stays pushed otherwise
  });
  // sim-check mentions: New session and the composer complete @-mentions and /commands from a tap, and launch.
  await w.screen("mentions and commands", async (expect) => {
    await clearDock();
    const keys = async (projectId: string) => new Set((await d.api<{ key: string; draft?: boolean }[]>("GET", `/tickets?projectId=${projectId}`)).filter((t) => !t.draft).map((t) => t.key));
    const launched = (projectId: string, before: Set<string>) => until("ticket launched", async () => ([...(await keys(projectId))].find((k) => !before.has(k)) ?? null), 10000, 100).catch(() => null);
    const spec = (l: string) => l.startsWith("Spec");
    const newSession = (projectId: string) => visit(`harness://new?projectId=${projectId}`, (e) => has(e, /^Spec/));
    // Start session is ⌘↩ and Plan first ⇧⌘↩: the toolbar's buttons aren't in the tree.
    const start = () => axe.keyCombo(227, 40);
    const planFirst = () => axe.keyCombo([227, 225], 40);

    let before = await keys(seeded.project.id);
    await newSession(seeded.project.id);
    await typeInto(spec, "Summarize @READ");
    let els = await untilTree(() => axe.nodes(), (e) => has(e, "README.md"));
    expect("@READ lists README.md", has(els, "README.md"), seen(els));
    await tapLabel("README.md");
    await rest(); // the list closes and the composer shrinks
    await start();
    expect("Start session launches the ticket", !!(await launched(seeded.project.id, before)));

    before = await keys(seeded.project.id);
    await newSession(seeded.project.id);
    await typeInto(spec, "Plan the readme");
    await planFirst();
    const planned = await launched(seeded.project.id, before);
    expect("Plan first launches a ticket", !!planned);
    els = await untilTree(() => axe.nodes(), (e) => has(e, "Show changes")); // the Spec tab's revision bar is on no other tab
    expect("Plan first opens the ticket on its Spec tab", has(els, "Show changes"), seen(els));

    const texts = async () => (await d.api<{ content: { text?: string } }[]>("GET", `/sessions/${(await ticketOf(world.messaging.key)).sessionId}/transcript`)).map((e) => e.content.text ?? "");
    await visit(`harness://ticket/${world.messaging.key}?tab=transcript`, composerUp);
    await typeInto((l) => l.startsWith("Message the agent"), "see @src/a");
    els = await untilTree(() => axe.nodes(), (e) => has(e, "src/app.ts"));
    expect("@src/a lists src/app.ts", has(els, "src/app.ts"), seen(els));
    await tapLabel("src/app.ts");
    await rest(); // the list closes and the composer shrinks, which moves Send
    await tapId("composer-send");
    // iOS may capitalize the first word, so the message is compared without case.
    const sent = await until("message with the mention", async () => ((await texts()).some((t) => t.toLowerCase() === "see @src/app.ts") ? true : null), 10000, 100).catch(() => null);
    expect("Send posts the message with the mention", !!sent, `transcript ends ${JSON.stringify((await texts()).slice(-4))}`);

    before = await keys(world.slash.id);
    await newSession(world.slash.id);
    await typeInto(spec, "/co");
    els = await untilTree(() => axe.nodes(), (e) => has(e, "/code-walk"), 15000); // the first lookup starts the (fake) CLI
    expect("/co lists the agent's commands and only those", has(els, "/code-walk") && has(els, "/commit-and-pr") && !has(els, "/vercel:deploy"), seen(els));
    await tapLabel("/code-walk");
    // The picked command fills the field (Commands.insertCommand is covered in HarnessKit), so Start needs no more typing.
    els = await untilTree(() => axe.nodes(), (e) => valueOf(e, spec).trim() === "/code-walk" && !has(e, "/code-walk"));
    expect("the picked command fills the field and closes the list", valueOf(els, spec).trim() === "/code-walk", `the field reads ${JSON.stringify(valueOf(els, spec))}`);
    await start();
    expect("the slash command's ticket launches", !!(await launched(world.slash.id, before)));
  });
  // sim-check drafts: moving the caret keeps what's typed, on the field and in the draft the service stored.
  await w.screen("composer draft", async (expect) => {
    await clearDock();
    const composer = (l: string) => l.startsWith("Message the agent");
    const draft = async () => (await ticketOf(world.drafting.key)).messageDraft?.text.toLowerCase() ?? null;
    await visit(`harness://ticket/${world.drafting.key}?tab=transcript`, composerUp);
    await typeInto(composer, "started on the phone");
    await until("the draft saved", async () => ((await draft()) === "started on the phone" ? true : null), 8000, 100);
    const el = await settled((e) => find(e, composer), "the composer");
    const y = el.frame!.y + el.frame!.height / 2;
    // Near the start of the text, then back near its end: each tap only moves the caret.
    for (const x of [el.frame!.x + 22, el.frame!.x + el.frame!.width / 2]) {
      await axe.tapAt(x, y);
      const els = await quiet();
      expect(`the field still reads the draft after a tap at x=${Math.round(x)}`, valueOf(els, composer).toLowerCase() === "started on the phone", `reads ${JSON.stringify(valueOf(els, composer))}`);
    }
    expect("the stored draft is unchanged", (await draft()) === "started on the phone", `draft ${JSON.stringify(await draft())}`);
  });

  // The one tap: the board's palette field opens the palette sheet.
  await w.screen("command palette", async (expect) => {
    await clearDock();
    await open("harness://board");
    const listed = (e: AXElement[]) => has(e, "Go to Inbox, Go to");
    /** Taps the board's field (once the board under the last sheet has stopped moving) and waits for the palette's commands. */
    const openPalette = async () => {
      await tapId("palette-field");
      return untilTree(() => axe.nodes(), listed);
    };
    /** The palette is gone and the board has stopped moving, so the next tap lands. */
    const closed = async () => {
      await untilTree(() => axe.nodes(), (e) => !listed(e));
      await quiet();
    };
    let els = await openPalette();
    expect("the palette lists commands", has(els, "Go to Inbox, Go to") && has(els, "Open Settings, Go to"), seen(els));
    // sim-check palette: running Show child tickets closes the palette and flips its label.
    await tapLabel("Show child tickets, General");
    await closed();
    await openPalette();
    const flipped = await untilTree(() => axe.nodes(), (e) => has(e, /^Hide child tickets/));
    expect("Show child tickets flips to Hide child tickets", has(flipped, /^Hide child tickets/), seen(flipped));
    await tapLabel("Hide child tickets, General"); // back to the default
    await closed();
    // The > prefix (commands only) is PaletteTests' to cover; no typing here.
  });
  // sim-check palette: ⌘K over a ticket lists its actions; Copy ticket key copies it.
  await w.screen("ticket commands", async (expect) => {
    await open(`harness://ticket/${seeded.review.key}?tab=spec`);
    await axe.keyCombo(227, 14);
    const els = await untilTree(() => axe.nodes(), (e) => has(e, /^Copy ticket key/));
    expect("the ticket's commands", has(els, /^Copy ticket key/), seen(els));
    await tapLabel("Copy ticket key, Ticket");
    const pasteboard = () => Bun.spawnSync(["xcrun", "simctl", "pbpaste", slot.udid], { env: process.env }).stdout.toString().trim();
    await untilTree(() => axe.nodes(), (e) => !has(e, /^Copy ticket key/)); // the command ran and the palette closed
    const copied = pasteboard();
    expect("Copy ticket key copies the key", copied === seeded.review.key, `copied "${copied}"`);
  });
  // sim-check usage: the sidebar's plan-usage gauges, read from the proxy's fixture. Last, since it relaunches the app.
  await w.screen("plan usage", async (expect) => {
    const showSidebar = async () => {
      await open("harness://projects");
      return untilTree(() => axe.nodes(), (e) => has(e, "PLAN USAGE") && has(e, /^Claude Code 5-hour/));
    };
    const usageRows = async () => (await axe.nodes()).filter((e) => /^(Claude Code|GitHub Copilot)\b/.test(e.label ?? ""));
    let els = await showSidebar();
    expect("a gauge for each window", has(els, /^Claude Code 5-hour/) && has(els, /^Claude Code Weekly/), seen(els));
    const info = /^How much of your plan's usage limits/;
    await tapId("plan-usage-info");
    els = await untilTree(() => axe.nodes(), (e) => has(e, info), 5000);
    expect("the info popover explains the gauges", has(els, info), seen(els));
    await dismissPopover();
    await rest(); // the popover has closed
    const choose = async (item: string) => {
      await tapId("plan-usage-options");
      await untilTree(() => axe.nodes(), (e) => has(e, item), 5000); // tapLabel reuses this read of the open menu
      await tapLabel(item);
      await rest(); // the menu has closed: the next read is of the screen behind it
    };
    await choose("Projected at reset");
    els = await untilTree(() => axe.nodes(), (e) => has(e, /^Claude Code Weekly: on pace for 56% · 45% used, resets/));
    expect("Projected at reset shows the pace", has(els, /^Claude Code Weekly: on pace for 56% · 45% used, resets/), seen(els));
    await choose("GitHub Copilot");
    els = await untilTree(() => axe.nodes(), (e) => !has(e, /^Claude Code/));
    const copilot = await usageRows();
    expect("filtering to Copilot hides Claude's rows", copilot.length > 0 && copilot.every((e) => /^GitHub Copilot/.test(e.label!)), seen(els));
    // The choice is @AppStorage: it survives a relaunch.
    relaunch();
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
if (process.env.WALK_TIMING) console.log(`atRest: ${restStatsOut().n} waits, ${Math.round(restStatsOut().ms)} ms, ${restStatsOut().missed} timed out`);
const { failed } = w.summary();
console.log(`total ${Math.round(performance.now() - started)} ms including build, seed, install and pairing`);
process.exit(failed.length ? 1 : 0);
