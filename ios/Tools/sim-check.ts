// Simulator checks against a REAL daemon on a throwaway HARNESS_HOME:
//   1. boots service/src/daemon.ts (temp home, random port, dummy driver, HARNESS_DUMMY_DELAY_MS=1)
//   2. seeds a project and only the tickets the run's selection needs (a conductor with children, a
//      /browse ticket, an approval, a blocked question, a plan-first ticket, a git-worktree ticket
//      with changes, sub-agents, a background task, a draft…), while it builds the app for
//      the simulator with `bun ios/Tools/build.ts sim` (XcodeGen, then an unoptimized simulator build
//      into ios/build/dd; skip with --no-build, override with --app=)
//   3. on the shared simulator ("harness-shared", see ios/Tools/sim.ts and CLAUDE.md → Simulators),
//      held under its lock for the whole run so other agents wait rather than install over it,
//      installs the app and pairs it via `simctl openurl harness://pair?…`
//
//   VALIDATING and SHOOTING are separate. A validation run (the default, and every mode) is checks
//   only: it takes no screenshots, except the "…-failed" one a failing check leaves. Shots are opt-in:
//
//   --screens           the whole shot catalog (screens() below), each in light and dark, to
//                       ios/build/screens/ (screens-ipad/ with --ipad). Never part of validation.
//   --only=name,name    just those entries: catalog screens are shot, checks and chains (named in
//                       interactionChains(), e.g. approve-and, prompt-editor, file-link) run. Only
//                       the tickets they need are seeded. An unknown name lists the known ones.
//   --shot=<link>       one light and dark pair of any route, no code needed:
//                         --shot='harness://ticket/{headings}?tab=spec'
//                       {name} is a seeded ticket's key (hello, changes, conductor, blocked, plan,
//                       agents, branchPlan, quick, draft, code, headings, fileLink, linked,
//                       tasks, approval, browse; watchers seeds the watchers and inbox item).
//                       --prepare='scroll:Models, ;tap:Label' reaches a state a link can't (steps
//                       split on ;), --name= names the file. It fails only if the app crashes.
//   --shots             also keep the screenshots chains take along the way, in a --only run.
//
//   The default walk-through validates: each route the checks don't visit is opened once and the app
//   checked for a crash (no shot, no theme flip), then the real-tap chains (blocked
//   composer, Approve and…, prompt editor, Models picker, card preview, Agents &
//   tasks filter, file link). Only what needs a simulator lives here (native scrolling, the
//   keyboard, gestures, media, crashes, memory, persistence across a relaunch); routing, counting,
//   layout math, request bodies and state rules are tested in swift test (HarnessKit) and the
//   service's bun test (approve, start, take no action, Allow once…).
//
//   A step that gets stuck doesn't stall the ones after it: a deep link that never shows its screen
//   dismisses any menu, alert or sheet, goes back to the board, and relaunches the app if that fails;
//   each check has a 90 s cap (checked at every wait). Every check runs in one mode only.
//
//   --themes=catppuccin-mocha,rose-pine-dawn: per theme, applies it with the settings deep link
//      (harness://settings?darkTheme=…) and saves board-<id>.png + settings-<id>.png
//
//   The modes below replace the default walk-through and use one simulator (validation, no shots):
//
//   --paging: seeds 125+ done tickets (one old "haystack" ticket deep in the history) and a conductor
//      with done children; checks the Done column scrolls into older pages, and the board's search
//      field finds the unloaded done ticket (what's hidden by default is BoardColumnsTests and
//      PrefsTests)
//
//   --stick: a ticket with a long spec, a long transcript and a long Activity feed (messages that
//      have the dummy resume and resubmit the work, so each adds a submit and a review to Activity);
//      swipes the Transcript tab and checks it follows new content at the bottom, stays put once
//      scrolled up, and follows again after scrolling back down; the Activity tab opens at the
//      bottom and follows; the hero collapses on scrolling the Spec (the rest is HeroDisclosureTests);
//      a sideways swipe moves between the tabs
//
//   --keyboard: with the on-screen keyboard up, the ticket composer sits right on top of it, and the
//      prompt editor and New session's prompt (which grows with no cap) keep the cursor above it as
//      the text grows, and the sheet's background (not the dimmed board) shows behind the keyboard's
//      rounded corners; keyboard-*.png. A headless simulator
//      always has a hardware keyboard, so the run turns the device's own keyboard minimization off
//      (no other simulator changes) and puts it back after; text goes in by tapping the on-screen keys
//
//   --mentions: in New session's Spec field and the ticket composer, typing `@…` lists the project's
//      files and tapping one completes it; typing `/co` in New session on a claude-code project (the fake
//      CLI) lists its commands and a tap completes one; the toolbar launches the draft, and Plan first
//      lands on the ticket's Spec tab (what the run gets is drafts.test.ts); mentions-*.png, new-session-toolbar*.png
//
//   --drafts: typing in the ticket composer, then moving the caret, keeps what's typed and the
//      saved draft (the draft rules are MessageDraftsTests)
//
//   --attachments (needs ffmpeg): a spec with a tall, a wide and a small PNG as a row of "thumb"
//      thumbnails and an H.264 clip as a captioned figure (stored by update_spec), plus an attachment:
//      reference to a file that doesn't exist; checks every inline image shows in the Spec tab (the
//      thumbnails as 100 pt squares, the figure across the width), a tap opens the viewer on that
//      attachment, an image smaller than the screen opens centred, swiping pages, Close and
//      swipe-down close it; attachments-*.png
//
//   --sheets: the iPhone's ticket sheet on its own: a board card opens its ticket in a sheet, a
//      conductor's child pushes inside it and the back swipe returns, dragging it to the bottom docks
//      it under the board as a bar titled by its key, a tap on the bar restores it where it was (its
//      composer no higher than before), Projects closes it, the bar's ✕ sends it away, a flick down
//      from full size sends it away without docking. Then several docked: a second ticket joins as a
//      second card, a long press on the title and a swipe along the dock switch, three show two
//      cards and "1 more…", which expands into the list, a card's ✕ and a swipe down close only the
//      top, the dock comes back after a relaunch, Projects closes them all.
//
//   --memory: the app's footprint with none, 5 and 20 docked tickets (about 45 s on its own; the rule
//      that only 5 stay mounted is in RouterSheetTests).
//
//   --ipad: the walk-through's routes on an iPad simulator instead ("harness-shared-ipad", kept between runs, an iPad Pro
//      11-inch) in whatever orientation it is in (simctl can't rotate one), plus the tab tear-off.
//      --ipad --sheets runs the side panel's checks: a card opens it trailing-aligned and its header
//      names the ticket once, its edge resizes it, docked it's a card in the bottom-right corner that
//      restores its path, a card's ✕ closes just its ticket, New session and its draft prompt,
//      pop-out moves its ticket into a window, and several docked tickets wait as cards left of the
//      panel, never over the sidebar. The iPhone's real-tap checks and the modes above tap at iPhone
//      coordinates, so they don't run here. SIM_CHECK_LANDSCAPE=1 runs the panel on a landscape-only
//      build (ios/ARCHITECTURE.md § iPad layout), mapping taps and rotating shots.
//
//   --usage: the sidebar's plan-usage gauges, against a proxy that fakes GET /usage
//      in front of the daemon. Add --shots to keep its screenshots; --ipad for the split view's sidebar.
//
//   --grep=<pattern>: runs only the checks whose names match, in whichever sequence you chose
//      (e.g. `--sheets --grep="dirty file"`, or `--only=sheet-checks --grep=dock`). A pattern is a
//      case-insensitive substring, or a regular expression written /like this/flags. The rest are
//      skipped, not run and not reported. A check that leans on what an earlier one left on screen
//      declares it (`needs` in check()), and those earlier checks run first as setup, so a selected
//      check never runs against state nobody built. A pattern that matches nothing fails, listing the
//      nearest check names. Applies to the modes and chains that run checks; screens (--screens, --shot)
//      have no checks to pick, and the walk-through still visits its screens and shots, so --grep
//      saves little there.
//
//   --reuse: attaches to what the last `--keep` run left (its daemon, seeded tickets and paired app)
//      instead of building, installing, resetting the keychain, seeding and pairing again, so
//      editing one check and rerunning it with --grep takes seconds, not minutes. It uses the app
//      already built (no build; add --rebuild to build first). If the built app differs from the one
//      installed (a hash of its files, kept with the state) or the simulators differ, it installs and
//      pairs again but still uses the daemon and seeds. With no kept state, or state for another
//      mode or seed, a dead daemon or an old format, it says why and does a full run instead. It
//      keeps its state when it ends, as --keep does, so the next --reuse finds it. Checks change
//      tickets, so a reused run starts from what the last one left: `bun run sim reap --kept` stops
//      kept daemons and removes their dirs when you want a clean start. Not available with --usage.
//
//      bun run sim-check --sheets --keep                    # the first run: full, and left running
//      bun run sim-check --sheets --reuse --grep="dirty file"   # then edit and rerun in seconds
//
//   It runs on the shared harness-shared simulator under its lock, e.g. `--only=connect`; --udid
//      still names a specific existing device.
//
//   It stops before starting when the disk has less than 5 GiB free, and removes its temp dirs
//   ($TMPDIR/harness-sim-home-*, harness-sim-projects-*) however it ends, unless --keep.
//
//   Every run prints its slowest steps and writes them all to timings.json in its screens folder. It also
//      writes sim-check-profile.json there (spawns by program, fixed sleeps by line, poll iterations and
//      stalled waits, per chain and check), prints the heaviest, and says how it differs from the last run.
//
//   DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer bun ios/Tools/sim-check.ts [--no-build] [--app=path] [--shards=N] [--udid=…,…] [--keep | --reuse [--rebuild]] [--grep=pattern] [--help] [--screens | --only=name,name | --shot=link [--prepare=…]] [--themes=id,id] [--paging] [--stick] [--keyboard] [--mentions] [--drafts] [--attachments] [--sheets] [--memory] [--usage] [--ipad]
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildPairUrl, reviewPassed, type ActivityEntry, type Project, type PromptEntry, type Ticket, type TicketDetail, type TicketPage, type TranscriptEntry, type Watcher } from "@harness/shared";
import { findTheme } from "@harness/shared/themes";
import { freePort, startDaemon as startDaemonShared, until as untilShared, type TestDaemon } from "@harness/shared/testing/daemon";
import { startDaemonProxy } from "@harness/shared/testing/proxy";
import { git, readSetting, seedRepo, seedDummySettings, setSessionContext, startCompactRun as startCompactRunAt, writeSetting } from "@harness/shared/testing/seed";
import { setSpawnObserver, acquire, acquireReady, daemonAnswers, checkDisk, ensureDevice, lockHolder, markKept, isSharedDevice, reap, releaseLock, SHARED_IPAD_DEVICE, tryLock, writeRunOwner, exportDeveloperDir } from "./sim";
import { CheckSelector, noMatchMessage, parseGrep } from "./sim-grep";
import { chooseKept, claimKept, staleAppNote, hashApp, hashService, listKept, MARKER_KEY, planApp, readReuseState, REUSE_VERSION, writeReuseState, type ReuseState, type Want } from "./sim-reuse";
import { callerSite, diffProfiles, Profile, summarize, type ProfileData } from "./profile";
import { PROBE_FILE, parseState, settled as probeSettled, waitFor as probeWaitFor, type DebugState } from "./probe";
import { parsePrepare, plan as planRun, resolveShot, SEED_NAMES, type Entry, type Plan, type SeedName } from "./sim-select";

/** ios/: screenshots go to its build/ folder. */
const here = resolve(import.meta.dir, "..");
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (flag("help") || args.includes("-h")) {
  // The header comment above is the help: its lines up to the usage one.
  const src = readFileSync(import.meta.path, "utf8").split("\n");
  const end = src.findIndex((l) => l.startsWith("import "));
  console.log(src.slice(0, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
// Also on process.env, for code that spawns with env: process.env (Bun.spawn without an env option uses the startup environment, not later writes), so spawns here pass `env` explicitly.
const DEVELOPER_DIR = exportDeveloperDir();
const env = { ...process.env, DEVELOPER_DIR };
const ipad = args.includes("--ipad");
const shots = join(here, "build", `screens${ipad ? "-ipad" : ""}`);
const appPath = process.argv.find((a) => a.startsWith("--app="))?.slice(6) ?? join(here, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const only = opt("only")?.split(",").filter(Boolean);
/** --screens, --only=<name> and --shot=<link> take screenshots; every other run only checks. */
const shotLink = opt("shot");
const memoryOnly = flag("memory");
const themeShots = opt("themes")?.split(",").filter(Boolean) ?? [];
const shotsWanted = flag("screens") || flag("shots") || !!only || !!shotLink || themeShots.length > 0;
const pagingOnly = flag("paging");
const stickOnly = flag("stick");
const keyboardOnly = flag("keyboard");
const mentionsOnly = flag("mentions");
const attachmentsOnly = flag("attachments");
const draftsOnly = flag("drafts");
const sheetsOnly = flag("sheets");
const usageOnly = flag("usage");
/** --reuse attaches to the last --keep run's daemon, seeds and app, and keeps them in turn. */
const reuse = flag("reuse");
const keep = flag("keep") || reuse;
const walkThrough = !(pagingOnly || stickOnly || keyboardOnly || mentionsOnly || attachmentsOnly || draftsOnly || sheetsOnly || memoryOnly || usageOnly);
if (ipad && !walkThrough && !sheetsOnly && !usageOnly) throw new Error("--ipad takes the walk-through's screens, --sheets or --usage, not --paging, --stick, --keyboard, --mentions, --drafts or --attachments");
if (reuse && usageOnly) throw new Error("--reuse doesn't apply to --usage: its proxy and pair link are new every run");
if (opt("grep") !== undefined) parseGrep(opt("grep")!); // a bad pattern fails before anything starts
const shardCount = walkThrough ? Math.max(1, Number(opt("shards") ?? 1) || 1) : 1;
if (opt("grep") !== undefined && shardCount > 1) throw new Error("--grep runs checks in order on one simulator; drop --shards");
for (const id of themeShots) if (!findTheme(id)) throw new Error(`--themes: unknown theme ${id}`);
checkDisk();

async function sh(cmd: string[], opts: { cwd?: string; quiet?: boolean; allowFail?: boolean; env?: Record<string, string> } = {}) {
  const t = performance.now();
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? here, env: { ...env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  profile.spawn(cmd, performance.now() - t);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} → ${code}\n${err || out}`);
  return out.trim();
}
const simctl = (...a: string[]) => sh(["xcrun", "simctl", ...a], { allowFail: false });

// ---------------------------------------------------------------- timing
const started = performance.now();
const timings: { label: string; ms: number }[] = [];
const profile = new Profile(args);
setSpawnObserver((cmd, ms) => profile.spawn(cmd, ms));
/** A fixed sleep, counted in the profile against the line that asked for it. */
const sleep = (ms: number) => (profile.sleep(ms, callerSite(new Error().stack, /profile\.ts|at sleep /)), Bun.sleep(ms));
/** Counts a spawn that streams its output (ffmpeg, a recording) and has no one place to time it; returns the command. */
const counted = (cmd: string[]) => (profile.spawn(cmd, 0), cmd);
/** Runs fn and records how long it took under label (printed, and written to timings.json at the end). */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await profile.span(label.startsWith("check: ") ? "check" : label.startsWith("chain: ") ? "chain" : "phase", label.replace(/^(check|chain): /, "").trim(), fn);
  } finally {
    timings.push({ label, ms: Math.round(performance.now() - t) });
  }
}
function reportTimings() {
  const total = Math.round(performance.now() - started);
  const rows = [...timings].sort((a, b) => b.ms - a.ms);
  console.log(`\ntimings (total ${(total / 1000).toFixed(1)} s):`);
  for (const r of rows.slice(0, 40)) console.log(`  ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.label}`);
  mkdirSync(shots, { recursive: true });
  const file = join(shots, "sim-check-profile.json");
  const prev: ProfileData | null = existsSync(file) ? (() => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } })() : null;
  const now = profile.data();
  console.log("\n" + summarize(now).join("\n"));
  if (prev?.version === 1) console.log("\n" + diffProfiles(prev, now).join("\n"));
  writeFileSync(file, JSON.stringify(now, null, 2) + "\n");
  writeFileSync(join(shots, "timings.json"), JSON.stringify({ args, total, timings }, null, 2) + "\n");
}

// ---------------------------------------------------------------- checks
type Result = [name: string, ok: boolean, detail: string];
const results: Result[] = [];
/** The running check's hard time cap: every `until` inside it gives up once the cap passes. */
const capOf = new AsyncLocalStorage<{ deadline: number; name: string }>();
const CHECK_CAP_MS = 90_000;
type CheckBody = { fn: () => Promise<string | boolean>; capMs: number };
/** --grep: which checks run. Every check is announced to it, in source order, so setup can be found. */
const selector = new CheckSelector<CheckBody>(opt("grep") === undefined ? null : parseGrep(opt("grep")!));
async function runCheck(name: string, { fn, capMs }: CheckBody): Promise<Result> {
  try {
    const v = await timed(`check: ${name}`, () => capOf.run({ deadline: Date.now() + capMs, name }, fn));
    return [name, v !== false, typeof v === "string" ? v : ""];
  } catch (e) {
    return [name, false, (e as Error).message.split("\n")[0]!];
  }
}
/**
 * Runs one named check; a thrown error or `false` fails it. The result prints right away. A check
 * that outlives `capMs` fails at its next wait instead of stalling every step after it.
 *
 * `needs` names (exactly) the earlier checks that leave the screen as this one starts from. Under
 * --grep they run first as setup when this one is selected; without it every check runs in order
 * and `needs` changes nothing. A check that skips setup because it starts with its own `goto` needs
 * nothing.
 */
async function check(name: string, fn: () => Promise<string | boolean>, capMs = CHECK_CAP_MS, needs?: readonly string[]) {
  const { run, setup } = selector.visit(name, needs, { fn, capMs });
  if (!run) return;
  for (const s of setup) {
    const r = await runCheck(s.name, s.body);
    console.log(`  ${r[1] ? "·" : "✗"} setup for "${name}": ${r[0]}${r[2] ? ` — ${r[2]}` : ""}`);
    if (!r[1]) {
      const failed: Result = [name, false, `its setup "${s.name}" failed: ${r[2]}`];
      results.push(failed);
      console.log(`✗ ${failed[0]} — ${failed[2]}`);
      return;
    }
  }
  const r = await runCheck(name, { fn, capMs });
  results.push(r);
  console.log(`${r[1] ? "✓" : "✗"} ${r[0]}${r[2] ? ` — ${r[2]}` : ""}`);
}

// ---------------------------------------------------------------- AXe
// AXe (brew install cameroncooke/axe/axe) drives taps. It looks for SimulatorKit under
// Developer/Library/PrivateFrameworks, which Xcode 27 moved to Contents/SharedFrameworks, so give
// it a symlinked Xcode bundle with the framework where it expects it. It lives outside the repo:
// inside it, bun test walks its thousands of links and runs out of file descriptors.
function xcodeShim(): string {
  const real = resolve(DEVELOPER_DIR, "..");
  const root = join(homedir(), "Library", "Caches", "harness-sim-check", "xcode-shim");
  const contents = join(root, "Xcode.app", "Contents");
  const dev = join(contents, "Developer");
  if (existsSync(join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"))) return dev;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(dev, "Library", "PrivateFrameworks"), { recursive: true });
  const link = (from: string, to: string) => Bun.spawnSync(counted(["ln", "-s", from, to]));
  for (const e of readdirSync(real)) if (e !== "Developer") link(join(real, e), join(contents, e));
  for (const e of readdirSync(DEVELOPER_DIR)) if (e !== "Library") link(join(DEVELOPER_DIR, e), join(dev, e));
  for (const e of readdirSync(join(DEVELOPER_DIR, "Library"))) if (e !== "PrivateFrameworks") link(join(DEVELOPER_DIR, "Library", e), join(dev, "Library", e));
  const priv = join(DEVELOPER_DIR, "Library", "PrivateFrameworks");
  if (existsSync(priv)) for (const e of readdirSync(priv)) link(join(priv, e), join(dev, "Library", "PrivateFrameworks", e));
  link(join(real, "SharedFrameworks", "SimulatorKit.framework"), join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"));
  return dev;
}
const hasAxe = Bun.spawnSync(["which", "axe"]).exitCode === 0;
let shim = "";
/**
 * SIM_CHECK_LANDSCAPE=1: the app was built landscape-only (ios/ARCHITECTURE.md § iPad layout), so
 * the simulator stays portrait while the app draws sideways. AXe's tree reads in the app's
 * landscape points but its touches land in the device's portrait ones: a point (x, y) is
 * (portrait width − y, x) there. axe() maps every tap, swipe and touch, and shot() rotates.
 */
const landscape = !!process.env.SIM_CHECK_LANDSCAPE;
/** The app's landscape height (the portrait width) on each simulator. */
const landscapeHeight = new Map<string, number>();
async function toDevice(a: string[]): Promise<string[]> {
  const udid = a[a.indexOf("--udid") + 1]!;
  // The shorter side, whichever way the tree reads while the app is still coming up.
  if (!landscapeHeight.has(udid)) landscapeHeight.set(udid, ((f) => Math.min(f.width, f.height))((await tree(udid))[0]!.frame));
  const h = landscapeHeight.get(udid)!;
  const out = [...a];
  for (const [xf, yf] of [["-x", "-y"], ["--start-x", "--start-y"], ["--end-x", "--end-y"]] as const) {
    const xi = a.indexOf(xf);
    const yi = a.indexOf(yf);
    if (xi < 0 || yi < 0) continue;
    out[xi + 1] = String(Math.round(h - Number(a[yi + 1])));
    out[yi + 1] = a[xi + 1]!;
  }
  return out;
}
async function axe(...a: string[]) {
  if (!hasAxe) return "";
  shim ||= xcodeShim();
  if (landscape && ["tap", "swipe", "touch"].includes(a[0]!) && a.includes("--udid")) a = await toDevice(a);
  const t = performance.now();
  const p = Bun.spawn(["axe", ...a], { env: { ...env, DEVELOPER_DIR: shim }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  profile.spawn(["axe", ...a], performance.now() - t);
  if (process.env.SIM_CHECK_DEBUG) {
    const ms = Math.round(performance.now() - t);
    if (code !== 0) console.log(`    axe ${a[0]} → ${code}: ${(err || out).trim().split("\n")[0]}`);
    else if (ms > 1500) console.log(`    axe ${a[0]} took ${ms} ms`);
  }
  return out;
}
async function labels(udid: string): Promise<string[]> {
  // AXe's JSON escapes "/" (src\/app.ts); labels are compared as they read on screen.
  return [...(await axe("describe-ui", "--udid", udid)).matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!.replace(/\\\//g, "/"));
}
async function tapLabel(udid: string, label: string) {
  await axe("tap", "--label", label, "--udid", udid);
}
interface AXNode {
  AXLabel: string | null;
  AXValue?: string | null;
  /** The view's accessibilityIdentifier. */
  AXUniqueId?: string | null;
  frame: { x: number; y: number; width: number; height: number };
  children?: AXNode[];
}
async function tree(udid: string): Promise<AXNode[]> {
  const out = await axe("describe-ui", "--udid", udid);
  return JSON.parse(out.slice(out.indexOf("["))) as AXNode[];
}
/** Every node on screen, flattened. */
const RUN_HEADER = /^(Planning|Work|Review|Complete|Chat|Conductor) • /;

async function nodes(udid: string): Promise<AXNode[]> {
  const all: AXNode[] = [];
  const walk = (n: AXNode) => (all.push(n), (n.children ?? []).forEach(walk));
  (await tree(udid)).forEach(walk);
  return all;
}
async function findElement(udid: string, match: (label: string) => boolean): Promise<AXNode | null> {
  const walk = (n: AXNode): AXNode | null => (n.AXLabel && match(n.AXLabel) ? n : (n.children ?? []).map(walk).find(Boolean) ?? null);
  try {
    return (await tree(udid)).map(walk).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
async function tapWhere(udid: string, label: string | ((l: string) => boolean), opts: { longPress?: number; timeout?: number } = {}) {
  const match = typeof label === "string" ? (l: string) => l === label : label;
  const el = await until(`element ${label}`, () => findElement(udid, match), opts.timeout ?? 8000).catch(async (e) => {
    throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 12).join(" | ")}`);
  });
  const x = String(Math.round(el.frame.x + el.frame.width / 2));
  const y = String(Math.round(el.frame.y + el.frame.height / 2));
  if (opts.longPress) await axe("touch", "-x", x, "-y", y, "--down", "--up", "--delay", String(opts.longPress), "--udid", udid);
  else await axe("tap", "-x", x, "-y", y, "--udid", udid);
}
/**
 * Taps a header item by its label when AXe can see it (toolbar items usually are), else at the
 * point where it sits in the header.
 */
async function tapHeader(udid: string, label: string | ((l: string) => boolean), at: { x: number; y: number }) {
  const match = typeof label === "string" ? (l: string) => l === label : label;
  const el = await until(`header ${label}`, () => findElement(udid, match), 1500).catch(() => null);
  const x = el ? el.frame.x + el.frame.width / 2 : at.x;
  const y = el ? el.frame.y + el.frame.height / 2 : at.y;
  await axe("tap", "-x", String(Math.round(x)), "-y", String(Math.round(y)), "--udid", udid);
}
/**
 * Closes an open menu without choosing anything: an action sheet by its Cancel, a Menu by its
 * "Dismiss context menu" backdrop. The backdrop covers the whole screen, so its center can sit
 * under one of the menu's rows; tap near its bottom edge, below any menu that opens from the top.
 */
async function dismissMenu(udid: string) {
  const el = await until("menu backdrop or Cancel", () => findElement(udid, (l) => l === "Cancel" || l === "Dismiss context menu"), 8000);
  const x = Math.round(el.frame.x + el.frame.width / 2);
  const y = Math.round(el.AXLabel === "Cancel" ? el.frame.y + el.frame.height / 2 : el.frame.y + el.frame.height - 60);
  await axe("tap", "-x", String(x), "-y", String(y), "--udid", udid);
}
/**
 * Scrolls the screen's scroll view with slow swipes (no fling) until an element `match` accepts
 * sits in the upper middle of the screen. Elements scrolled far out of view may be missing from
 * the tree, so it swipes a fixed distance until one shows up, then just far enough. One above the
 * screen (or under the header) is scrolled back down to.
 *
 * A ticket's hero collapses while the Spec scrolls forward, which moves the tab body up by the
 * difference. The swipes aim at 420 (forward) and 220 (back), so the element lands inside the
 * 140–520 band whether or not the hero collapses.
 */
async function scrollTo(udid: string, match: (label: string) => boolean, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const el = await findElement(udid, match);
    if (el && el.frame.y >= 140 && el.frame.y <= 520) return;
    if (el && el.frame.y < 140) {
      const by = Math.min(420, Math.round(220 - el.frame.y));
      await axe("swipe", "--start-x", "200", "--start-y", "300", "--end-x", "200", "--end-y", String(300 + by), "--duration", "0.8", "--udid", udid);
      await atRest(udid, 400);
      continue;
    }
    const by = el && el.frame.y > 520 ? Math.min(420, Math.round(el.frame.y - 420)) : 380;
    await axe("swipe", "--start-x", "200", "--start-y", "740", "--end-x", "200", "--end-y", String(740 - by), "--duration", "0.8", "--udid", udid);
    await atRest(udid, 400);
  }
  throw new Error("scrollTo: element never came into view");
}
const until = async <T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 20000, every = 150): Promise<T> => {
  const t = performance.now();
  let looks = 0;
  try {
    return await untilShared(label, fn, ms, every, () => {
      looks++;
      const cap = capOf.getStore();
      if (cap && Date.now() > cap.deadline) throw new Error(`"${cap.name}" ran past its ${Math.round(CHECK_CAP_MS / 1000)} s cap (waiting for ${label})`);
    });
  } finally {
    profile.poll(label, looks, performance.now() - t);
  }
};
// ---------------------------------------------------------------- debug state probe
// The app (a SIM_CHECK build, which build.ts's simulator build is) writes its router, dock and
// editor state, and whether it is settled, to a JSON file in its container: see Tools/probe.ts.
// A file read beats the accessibility tree (no describe-ui round trip, and a web view's page isn't
// in the tree at all), and beats a URL route plus a daemon post (nothing to wait for, and it works
// before pairing). The tree stays for taps and for what the user reads on screen.
const containers = new Map<string, string>();
async function probe(udid: string): Promise<DebugState | null> {
  try {
    let dir = containers.get(udid);
    if (!dir) containers.set(udid, (dir = await simctl("get_app_container", udid, BUNDLE, "data")));
    return parseState(await Bun.file(join(dir, "tmp", PROBE_FILE)).text());
  } catch {
    containers.delete(udid); // the app was reinstalled, or isn't up
    return null;
  }
}
/** Waits until `pred` holds for the app's probe state. The state is rechecked every 50 ms: a file read. */
const probeUntil = (udid: string, label: string, pred: (s: DebugState) => boolean, ms = 10000) => probeWaitFor(label, () => probe(udid), pred, { ms });
/**
 * Replaces a fixed sleep after an action: waits for the app to say it is at rest (settled, with
 * an unchanged state for as long as the sleep was, at most 300 ms, and a few fresh writes since the call). `fallbackMs` is what an
 * app without the probe (--app= of a release build) sleeps instead. Only state the probe holds
 * (router, dock, the editor) can settle this way: an animation that changes none of it (a spring
 * back, a list drawing, an image loading) still needs its sleep, or an assertion on what it shows.
 */
const noProbe = new Set<string>();
async function atRest(udid: string, fallbackMs: number): Promise<void> {
  if (noProbe.has(udid)) return void (await sleep(fallbackMs));
  // Quiet for no longer than the sleep it replaces (capped at 300 ms), counted from the state's last change.
  const s = await probeSettled(() => probe(udid), { quietMs: Math.min(fallbackMs, 300) });
  if (!s) noProbe.add(udid); // never answered: not a SIM_CHECK build, don't wait for it again
  // A stale or frozen file only sleeps this once: the app may be writing again by the next action.
  if (!s || s === "frozen") await sleep(fallbackMs);
}

// ---------------------------------------------------------------- simulators
const BUNDLE = "com.markhuot.harness";
/** The running app's process id on the simulator, from launchctl's `PID Status Label` lines. */
async function appPid(udid: string): Promise<number> {
  const out = await sh(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { allowFail: true });
  const line = out.split("\n").find((l) => l.includes(BUNDLE));
  const pid = Number(line?.trim().split(/\s+/)[0]);
  if (!pid) throw new Error("the app isn't running");
  return pid;
}
/** Whether the app process is alive; a screenshot of a crashed app is just the home screen. */
async function running(udid: string): Promise<boolean> {
  return (await sh(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { allowFail: true })).includes(BUNDLE);
}

/**
 * The simulators to drive, each held under its lock (Tools/sim.ts) until this run exits, so two
 * runs or agents never install over each other: --udid=a,b, or any free simulator of the shared
 * iPhone pool ("harness-shared", "harness-shared-2"; "harness-shared-ipad" with --ipad), plus "sim-check 2" … "sim-check N" with --shards=N. Devices
 * that don't exist yet are created on the iOS 27.0 runtime, and all of them are booted. First it
 * cleans up after runs that died (Tools/sim.ts reap): their booted devices and orphaned daemons.
 */
async function pickDevices(n: number): Promise<string[]> {
  const given = opt("udid")?.split(",").filter(Boolean);
  type Device = { udid: string; name: string; state: string; isAvailable: boolean };
  const list = async () => Object.values((JSON.parse(await simctl("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices).flat();
  // The iPhone pool's slot is chosen below, once the others are held; "" stands for it here.
  const wanted = given ?? Array.from({ length: n }, (_, i) => (ipad ? (i === 0 ? SHARED_IPAD_DEVICE : `sim-check iPad ${i + 1}`) : i === 0 ? "" : `sim-check ${i + 1}`));
  const names = (devices: Device[]) => wanted.filter(Boolean).map((id) => devices.find((x) => x.udid === id)?.name ?? id);
  await reap({ except: names(await list()), log: console.log }).catch((e: Error) => console.log(`reap: ${e.message}`));
  const all = await list();
  return Promise.all(
    wanted.map(async (id) => {
      if (id === "") {
        // Any free slot of the shared pool, the one the kept --reuse state's app is on first.
        const prefer = (attached?.udids ?? []).map((u) => all.find((x) => x.udid === u)?.name).filter((x): x is string => !!x);
        const { udid } = await acquireReady({ prefer, onWait: (h) => console.log(`waiting for a shared simulator${h ? ` (held by pid ${h.pid}: ${h.command})` : ""}…`) }, { kind: "iphone", log: console.log });
        return udid;
      }
      const d = all.find((x) => x.isAvailable && (x.udid === id || x.name === id));
      if (!d && given) throw new Error(`--udid: no simulator ${id}`);
      const name = d?.name ?? id;
      await acquire(name, { onWait: (h) => console.log(`waiting for simulator "${name}"${h ? ` (held by pid ${h.pid}: ${h.command})` : ""}…`) });
      if (!given) {
        const udid = await ensureDevice(name, { kind: ipad ? "ipad" : "iphone", log: console.log });
        if (!isSharedDevice(name)) {
          toShutDown.add(udid);
          toDelete.add(udid);
        }
        return udid;
      }
      if (d!.state !== "Booted") {
        await simctl("boot", d!.udid);
        await sh(["xcrun", "simctl", "bootstatus", d!.udid, "-b"]);
        if (!isSharedDevice(name)) toShutDown.add(d!.udid);
      }
      return d!.udid;
    }),
  );
}

/**
 * The devices this run shuts down when it ends: its own sim-check devices, and --udid devices it
 * booted. harness-shared stays up for the next agent, and --keep leaves everything running.
 */
const toShutDown = new Set<string>();
/**
 * Its own sim-check devices, deleted once they're shut down: each grows to 3–8 GB, and the next run
 * that needs one creates it again on iOS 27.0 in a few seconds. --udid devices are never deleted.
 */
const toDelete = new Set<string>();
async function shutDownDevices() {
  if (keep || !toShutDown.size) return;
  const udids = [...toShutDown];
  toShutDown.clear();
  await Promise.all(udids.map((u) => sh(["xcrun", "simctl", "shutdown", u], { allowFail: true })));
  console.log(`shut down ${udids.join(", ")}`);
  const gone = udids.filter((u) => toDelete.has(u));
  await Promise.all(gone.map((u) => sh(["xcrun", "simctl", "delete", u], { allowFail: true })));
  if (gone.length) console.log(`deleted ${gone.join(", ")}`);
}

// ------------------------------------------------------------ navigating the running app
// Screens are reached by deep-linking the app while it runs, not by relaunching it for each one.
// A ticket link pushes a fresh ticket screen; a tab link (harness://board) pops everything above
// the tabs, modals included. So a modal is only ever opened over the board and left via it.
const BOARD = "harness://board";
const isModal = (url: string | undefined) => !!url && /^harness:\/\/(new|watcher|connect|projects|pair|scan)\b/.test(url);
/** The board is up: its column chips ("Review, 3") are on screen. */
const onBoard = (l: string[]) => l.some((x) => /^(Planning|In progress|Blocked|Review|Done), \d+$/.test(x));
const lastUrl = new Map<string, string>();
const lastTree = new Map<string, string>();

/**
 * A moment for the screen to finish drawing once its labels are there. Reading the accessibility
 * tree again to see that it held still costs more: describe-ui takes 0.4 s on an idle Mac and
 * several seconds with a few simulators busy, and the first read after a link already waits for
 * the transition to end.
 */
const DRAW_MS = 400;
/**
 * Waits until the app shows a new screen (its labels differ from `before`) that `ready` accepts
 * (any, without `ready`), then DRAW_MS. Accepts iOS's "Open in “Harness”?" if it asks. False on a
 * timeout (the app crashed or never got there).
 */
async function whenShown(udid: string, before: string | undefined, ready?: (l: string[]) => boolean, ms = 12000): Promise<boolean> {
  const t0 = performance.now();
  let looks = 0;
  try {
    const shown = await whenShownLoop(udid, before, ready, ms, () => looks++);
    // A wait that ran out is a stall (a sheet or menu left over the app, say), not a slow screen: counted apart so the profile names it.
    if (!shown) profile.poll("whenShown gave up", 0, performance.now() - t0);
    return shown;
  } finally {
    profile.poll("whenShown", looks, performance.now() - t0);
  }
}
async function whenShownLoop(udid: string, before: string | undefined, ready: ((l: string[]) => boolean) | undefined, ms: number, look: () => void): Promise<boolean> {
  let prev = "";
  let sameSince: number | undefined;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    look();
    const l = await labels(udid);
    if (l.some((x) => x.startsWith("Open in “"))) {
      await tapLabel(udid, "Open");
      continue;
    }
    // Numbers are masked: live text ("started 47s ago") isn't a different screen.
    const t = l.join("\n").replace(/\d+/g, "#");
    // The splash has only the app's own label; SpringBoard (app not up) has no "Harness" root.
    const up = l[0] === "Harness" && l.length >= 3 && t !== before;
    if (up && (!ready || ready(l))) {
      lastTree.set(udid, t);
      await atRest(udid, DRAW_MS);
      return true;
    }
    // The link led to the screen already up (a ticket already open, say): its labels never differ
    // from `before`. With the probe, a screen that has held still and settled for a few seconds is
    // that case, not a transition that never started, so don't wait out the whole timeout.
    if (t === before && l[0] === "Harness" && l.length >= 3 && (!ready || ready(l))) {
      sameSince ??= Date.now();
      if (Date.now() - sameSince > 3000 && (await probe(udid))?.settled) {
        lastTree.set(udid, t);
        return true;
      }
    } else sameSince = undefined;
    if (process.env.SIM_CHECK_DEBUG && prev && t !== prev) {
      const a = new Set(prev.split("\n"));
      const b = new Set(l);
      console.log(`    [${udid.slice(0, 4)}] changed: -${[...a].filter((x) => !b.has(x)).slice(0, 3).join(" | ")} +${l.filter((x) => !a.has(x)).slice(0, 3).join(" | ")}`);
    }
    prev = t;
    await sleep(100);
  }
  lastTree.set(udid, prev);
  console.log(`    [${udid.slice(0, 4)}] no settled screen after ${ms / 1000} s${prev === before ? " (it never left the previous screen)" : ""}; on screen: ${prev.split("\n").slice(0, 14).join(" | ")}`);
  return false;
}
/** Opens `url` on the running app (launching it if it isn't) and waits for its screen. */
async function visit(udid: string, url: string, ready?: (l: string[]) => boolean): Promise<boolean> {
  const before = lastUrl.get(udid) === url ? undefined : lastTree.get(udid);
  lastUrl.set(udid, url);
  const was = hasAxe && !noProbe.has(udid) ? await probe(udid) : null;
  await simctl("openurl", udid, url);
  if (!hasAxe) return sleep(2500).then(() => true);
  // The app's router moving, and settling, is the link landing: the first look at the screen is then
  // usually the last, not the third. Where it doesn't move (the screen was already up) this gives up
  // after a moment and whenShown reads the screen as before; `ready` still decides.
  if (was) {
    const t = performance.now();
    // The router moving is the link landing; settling follows, but an app that is never quiet (a running ticket streaming) gets 500 ms, not the cap.
    const wasRoute = JSON.stringify(was.router);
    let movedAt: number | undefined;
    const landed = await probeUntil(udid, "the link to land", (s) => {
      if (JSON.stringify(s.router) !== wasRoute) movedAt ??= Date.now();
      return movedAt !== undefined && (s.settled || Date.now() - movedAt > 500);
    }, 900).then(() => true, () => false);
    profile.poll(landed ? "link landed (router moved)" : "link landed (gave up: router didn't move)", 1, performance.now() - t);
  }
  if (await whenShown(udid, before, ready)) return true;
  // Never got there: a step before left a menu, alert or sheet over the app (or it crashed). Clear
  // the board and try once more, so one stuck step costs one timeout, not every step after it.
  if (!(await running(udid))) return false;
  await resetBoard(udid);
  lastUrl.set(udid, url);
  await simctl("openurl", udid, url);
  return whenShown(udid, undefined, ready, 8000);
}
/**
 * Back to a clean board from wherever a stuck step left the app: closes a menu, alert or sheet
 * (their Cancel, "Dismiss context menu" or Done), undocks, deep-links to the board, and quits and
 * relaunches the app if that doesn't show it.
 */
const resetBoard = (udid: string) => timed("reset board", () => resetBoardNow(udid));
async function resetBoardNow(udid: string) {
  console.log(`    [${udid.slice(0, 4)}] resetting to a clean board`);
  for (let i = 0; i < 3; i++) {
    const el = await findElement(udid, (l) => l === "Dismiss context menu" || l === "Cancel" || l === "Done").catch(() => null);
    if (!el) break;
    const y = el.AXLabel === "Dismiss context menu" ? el.frame.y + el.frame.height - 60 : el.frame.y + el.frame.height / 2;
    await axe("tap", "-x", String(Math.round(el.frame.x + el.frame.width / 2)), "-y", String(Math.round(y)), "--udid", udid).catch(() => {});
    await atRest(udid, 500);
  }
  lastUrl.set(udid, BOARD);
  await simctl("openurl", udid, BOARD);
  if (await whenShown(udid, undefined, onBoard, 8000)) return;
  await simctl("terminate", udid, BUNDLE).catch(() => {});
  await simctl("launch", udid, BUNDLE);
  lastUrl.set(udid, BOARD);
  await whenShown(udid, undefined, onBoard, 20000);
}
/** Goes to `url`, by way of the board when a modal is leaving or arriving. */
async function goto(udid: string, url: string, ready?: (l: string[]) => boolean): Promise<boolean> {
  const prev = lastUrl.get(udid);
  if (url !== BOARD && prev !== BOARD && (isModal(prev) || isModal(url))) await visit(udid, BOARD, onBoard);
  return visit(udid, url, url === BOARD ? (ready ?? onBoard) : ready);
}
/** After taps moved the app somewhere a link didn't: the next goto can't assume where it is. */
const moved = (udid: string) => void lastUrl.set(udid, "?");

type Look = "light" | "dark";
const looks = new Map<string, Look>();
async function appearance(udid: string, look: Look) {
  if (looks.get(udid) === look) return;
  await simctl("ui", udid, "appearance", look);
  looks.set(udid, look);
}
/** How long the app takes to redraw after the appearance flips (the labels don't change, so it's a wait). */
const FLIP_MS = 300;
/**
 * Saves the screen as <name>.png. Validation takes none: only a run that asks for shots does, and
 * a failing check's own diagnostic ("…-failed") always does, and so does `evidence`, a shot the
 * check itself reads pixels from.
 */
const shot = async (udid: string, name: string, evidence = false) => {
  if (!shotsWanted && !evidence && !name.includes("failed")) return;
  const file = join(shots, `${name}${landscape ? "-landscape" : ""}.png`);
  await simctl("io", udid, "screenshot", file);
  if (landscape) await sh(["sips", "-r", "270", file], { quiet: true });
};

/**
 * Records the screen (to `<name>.mp4` beside the shots) while fn runs, and returns each frame's
 * top half shrunk to 16×8 gray: enough to see something flash by between two accessibility reads.
 */
async function recordFrames(
  udid: string,
  name: string,
  fn: () => Promise<unknown>,
  // What each frame is boiled down to: `vf` is ffmpeg's filter, `bytes` the size it leaves.
  { vf = "crop=iw:ih/2:0:0,scale=16:8,format=gray", bytes = 128 } = {},
): Promise<Uint8Array[]> {
  const video = join(shots, `${name}.mp4`);
  const rec = Bun.spawn(counted(["xcrun", "simctl", "io", udid, "recordVideo", "--force", video]), { env, stdout: "ignore", stderr: "pipe" });
  const reader = rec.stderr.getReader();
  let said = "";
  while (!said.includes("Recording started")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`recordVideo ended before it started: ${said.trim()}`);
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  try {
    await fn();
    await sleep(400);
  } finally {
    rec.kill("SIGINT");
    await rec.exited;
  }
  const ff = Bun.spawn(counted(["ffmpeg", "-v", "error", "-i", video, "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]), { stdout: "pipe", stderr: "pipe" });
  const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(ff.stderr).text()}`);
  const frames: Uint8Array[] = [];
  for (let i = 0; i + bytes <= raw.length; i += bytes) frames.push(raw.subarray(i, i + bytes));
  if (!frames.length) throw new Error(`no frames in ${video}`);
  return frames;
}

/**
 * How many pixels in `r` (points, on a screen `W` points wide) stand out from the region's median
 * by more than 64 levels of gray: text or an icon on a plain bar.
 */
async function inkIn(udid: string, r: { x: number; y: number; width: number; height: number }, W: number): Promise<number> {
  const file = join(shots, ".ink.png");
  await simctl("io", udid, "screenshot", file);
  const crop = `scale=${W}:-1,crop=${Math.round(r.width)}:${Math.round(r.height)}:${Math.round(r.x)}:${Math.round(r.y)},format=gray`;
  const ff = Bun.spawn(counted(["ffmpeg", "-v", "error", "-i", file, "-vf", crop, "-f", "rawvideo", "-"]), { stdout: "pipe", stderr: "pipe" });
  const px = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(ff.stderr).text()}`);
  rmSync(file, { force: true });
  const median = [...px].sort((a, b) => a - b)[px.length >> 1]!;
  return px.filter((v) => Math.abs(v - median) > 64).length;
}

/** The median gray (0–255) of `r` (points, on a screen `W` points wide). */
async function grayIn(udid: string, r: { x: number; y: number; width: number; height: number }, W: number): Promise<number> {
  const file = join(shots, ".gray.png");
  await simctl("io", udid, "screenshot", file);
  const crop = `scale=${W}:-1,crop=${Math.round(r.width)}:${Math.round(r.height)}:${Math.round(r.x)}:${Math.round(r.y)},format=gray`;
  const ff = Bun.spawn(counted(["ffmpeg", "-v", "error", "-i", file, "-vf", crop, "-f", "rawvideo", "-"]), { stdout: "pipe", stderr: "pipe" });
  const px = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(ff.stderr).text()}`);
  rmSync(file, { force: true });
  return [...px].sort((a, b) => a - b)[px.length >> 1]!;
}

/**
 * How far the content strays from a rigid move, over a slow drag's frames (full-screen gray, `w`×`h`).
 * The system moves the sheet down and scales it a few percent as it comes off the screen's edges,
 * so a frame is matched to the first by a shift and a scale: the first frame's rows from `top` for
 * `len` rows have an ink profile (how much each row differs from its own median: text lines, bars),
 * and the frame's profile, sampled where those rows would have gone, should follow it. Returns the
 * worst frame's best correlation (1 is a perfect match; a header that resizes or a transcript
 * that snaps to its bottom puts lines where the first frame had none).
 */
function rigidWorst(frames: Uint8Array[], w: number, h: number, top = 60, len = 110) {
  const profile = (f: Uint8Array) => {
    const out = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      const row = Array.from(f.subarray(y * w, (y + 1) * w)).sort((a, b) => a - b);
      const m = row[w >> 1]!;
      out[y] = row.reduce((s, v) => s + Math.abs(v - m), 0) / w;
    }
    return out;
  };
  const at = (p: Float64Array, y: number) => {
    const i = Math.floor(y);
    const f = y - i;
    return p[i]! * (1 - f) + p[Math.min(i + 1, h - 1)]! * f;
  };
  const first = profile(frames[0]!);
  const ref = Array.from({ length: len }, (_, i) => first[top + i]!);
  const mean = ref.reduce((s, v) => s + v, 0) / len;
  const refDev = ref.map((v) => v - mean);
  const refNorm = Math.sqrt(refDev.reduce((s, v) => s + v * v, 0));
  const worst = { frame: 0, corr: 1, scale: 1, shift: 0 };
  frames.forEach((f, k) => {
    const p = profile(f);
    let best = -1;
    let bs = 1;
    let bt = 0;
    for (let sc = 0.88; sc <= 1.0201; sc += 0.005) {
      for (let t = 0; top * sc + t + len * sc < h - 1; t += 0.5) {
        const got = ref.map((_, i) => at(p, t + (top + i) * sc));
        const gm = got.reduce((s, v) => s + v, 0) / len;
        let dot = 0;
        let gn = 0;
        for (let i = 0; i < len; i++) {
          const d = got[i]! - gm;
          dot += d * refDev[i]!;
          gn += d * d;
        }
        const corr = dot / (Math.sqrt(gn) * refNorm || 1);
        if (corr > best) [best, bs, bt] = [corr, sc, t];
      }
    }
    if (best < worst.corr) Object.assign(worst, { frame: k, corr: best, scale: bs, shift: bt });
  });
  return worst;
}

/** The mean difference between two recordFrames frames, 0–255. */
const frameDiff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
/**
 * Saves the screen as <name>-light.png and <name>-dark.png: the current appearance first, then the
 * other, so the next screen starts where this one ended and each screen costs one flip.
 */
async function shootBoth(udid: string, name: string, redrawn: () => Promise<unknown> = () => sleep(FLIP_MS)) {
  if (!shotsWanted) return;
  const first = looks.get(udid) ?? "light";
  const second: Look = first === "light" ? "dark" : "light";
  await shot(udid, `${name}-${first}`);
  await appearance(udid, second);
  await redrawn();
  await shot(udid, `${name}-${second}`);
}

/** Installs the app fresh: no saved servers or tokens. */
async function install(udid: string) {
  await simctl("terminate", udid, BUNDLE).catch(() => {});
  await sh(["xcrun", "simctl", "uninstall", udid, BUNDLE], { allowFail: true });
  // Builds from before 2.0 had a separate Debug id (com.markhuot.harness.dev) that registers
  // harness:// too, and iOS may hand it the pair link. The shared simulator can still have one.
  await sh(["xcrun", "simctl", "uninstall", udid, `${BUNDLE}.dev`], { allowFail: true });
  await sh(["xcrun", "simctl", "keychain", udid, "reset"], { allowFail: true });
  await simctl("install", udid, appPath);
  // The app asks for notification permission at launch, and that alert would cover the pair
  // link's screens. A launch argument can't reach a launch by openurl, so it's a default.
  await simctl("spawn", udid, "defaults", "write", BUNDLE, "HarnessSkipNotificationPrompt", "-bool", "YES");
  await appearance(udid, "light");
}
/** Cold-launches the app on the pair link and waits for the board with a ticket on it. */
async function pair(udid: string, pairUrl: string) {
  lastUrl.set(udid, pairUrl);
  await simctl("openurl", udid, pairUrl);
  if (hasAxe && !(await whenShown(udid, undefined, (l) => onBoard(l) && l.some((x) => /^[A-Z]+-\d+ /.test(x)), 30000)))
    throw new Error(`${udid}: the app never showed the board after pairing; on screen: ${(await labels(udid)).slice(0, 12).join(" | ")}`);
  lastUrl.set(udid, BOARD);
}

// ---------------------------------------------------------------- daemon
// Set by startDaemon, the first thing the run does: a fresh daemon in new temp dirs, or (--reuse) the
// kept one in its own.
let home = "";
let scratch = "";
let port = 0;
let base = "";
/** The daemon's process, when this run started it; a reused daemon belongs to the run that kept it. */
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let testDaemon: TestDaemon | null = null;
let daemonPid = 0;
/** The kept state a --reuse run attached to. */
let attached: ReuseState | null = null;
// --mentions' /command check runs a project on the claude-code driver, pointed at the fake CLI:
// it answers `initialize` with SLASH_COMMANDS and records each agent run's prompt.
const SLASH_COMMANDS = [
  { name: "code-walk", description: "Walk a user through a piece of code so they can perform a detailed code review. (user)", argumentHint: "" },
  { name: "commit-and-pr", description: "Commit and PR (user)", argumentHint: "" },
  { name: "vercel:deploy", description: "(vercel) Deploy the current project to Vercel.", argumentHint: "[prod]" },
];
let claudeRecord = "";
const HOME_PREFIX = "harness-sim-home-";
/** The port range kept daemons live in, so they stay findable. */
const SIM_PORTS = { from: 7830, span: 60 };
/** The lock held on the kept home this run attached to (--reuse); released when the run ends. */
let keptLock = "";
/** The daemon this run's checks talk to: the kept one for --reuse when one fits, otherwise a new one. */
async function startDaemon(want: Want) {
  if (reuse) {
    const kept = await listKept(tmpdir(), HOME_PREFIX, daemonAnswers);
    const chosen = chooseKept(kept, want);
    let pick = chosen.pick;
    const notes = chosen.notes;
    for (const n of notes) console.log(`--reuse: ${n}`);
    // A kept home whose daemon is gone can't be reused and nothing else will clear it (reap leaves kept homes alone).
    for (const k of kept) {
      if (k.daemonAlive || lockHolder(basename(k.home))) continue; // a live run holds it
      try {
        process.kill(k.state.daemonPid, 0);
      } catch {
        rmSync(k.home, { recursive: true, force: true });
        rmSync(k.state.scratch, { recursive: true, force: true });
        console.log(`--reuse: removed ${k.home}, whose daemon had stopped`);
      }
    }
    if (pick) {
      // Two --reuse runs on one home would share the daemon's tickets and fight over the app and pairing.
      const busy = claimKept(basename(pick.home), tryLock, lockHolder);
      if (busy) throw new Error(`--reuse: ${busy}`);
      // The run that held the home may have ended (and deleted it, or kept newer state) between listKept and the lock.
      const fresh = existsSync(join(pick.home, "keep")) ? readReuseState(pick.home) : null;
      if (!fresh || !(await daemonAnswers(fresh, pick.home))) {
        releaseLock(basename(pick.home));
        console.log(`--reuse: ${pick.home} changed while it was being claimed; starting a new daemon`);
        pick = null;
      } else {
        pick = { ...pick, state: fresh };
        keptLock = basename(pick.home);
      }
    }
    if (pick) {
      home = pick.home;
      scratch = pick.state.scratch;
      port = pick.state.port;
      base = `http://127.0.0.1:${port}`;
      daemonPid = pick.state.daemonPid;
      attached = pick.state;
      // This run owns the home now: the original --keep process is gone, and reap --kept would take it for a dead run's.
      writeRunOwner(home, scratch);
      claudeRecord = join(home, "fake-claude.ndjson");
      console.log(`--reuse: attached to the daemon at ${base} (pid ${daemonPid}, HARNESS_HOME=${home})`);
      return;
    }
    console.log("--reuse: nothing to reuse; this run does everything and keeps its state for the next one");
  }
  home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
  scratch = mkdtempSync(join(tmpdir(), "harness-sim-projects-"));
  port = freePort(SIM_PORTS);
  base = `http://127.0.0.1:${port}`;
  console.log(`daemon: ${base} (HARNESS_HOME=${home})`);
  // Lets a later run's reap tell this run's dirs (and daemon) from a dead run's.
  writeRunOwner(home, scratch);
  claudeRecord = join(home, "fake-claude.ndjson");
  const fakeClaude: Record<string, string> = mentionsOnly
    ? {
        HARNESS_CLAUDE_BIN: join(repoRoot, "service/src/drivers/__fixtures__/fake-claude.ts"),
        FAKE_CLAUDE_COMMANDS: JSON.stringify(SLASH_COMMANDS),
        FAKE_CLAUDE_RECORD: claudeRecord,
      }
    : {};
  testDaemon = await startDaemonShared({ home, port, delayMs: 1, env: fakeClaude, stopOnExit: !keep });
  daemon = testDaemon.proc;
  daemonPid = daemon.pid;
}
// --usage: the dummy driver reports no plan usage, and the real ones read the account's login, so
// the app talks to this proxy instead: it forwards everything to the daemon (HTTP and the event
// socket) except GET /usage, which it answers from `usageReport`.
type UsageReport = { drivers: unknown[] };
const WEEK_S = 7 * 86400;
const usageNow = () => Date.now();
/** A window `elapsed` of the way through `windowSeconds`. */
const usageWindow = (id: string, label: string, used: number, windowSeconds: number, elapsed: number) => ({
  id, label, usedPercent: used, windowSeconds, resetsAt: Math.round(usageNow() + (1 - elapsed) * windowSeconds * 1000),
});
/** Claude: amber 5-hour (red when projected), a weekly that's green projected, an Opus week too early to project, a Sonnet week that's full. Copilot can't be read. */
const usageFixture = (): UsageReport => ({
  drivers: [
    {
      driver: "claude-code", name: "Claude Code", fetchedAt: usageNow() - 180_000,
      windows: [
        usageWindow("five_hour", "5-hour", 82, 18000, 1 - (2 * 3600 + 14 * 60) / 18000),
        usageWindow("seven_day", "Weekly", 45, WEEK_S, 0.8),
        usageWindow("seven_day_opus", "Weekly · Opus", 2, WEEK_S, 0.05),
        usageWindow("seven_day_sonnet", "Weekly · Sonnet", 100, WEEK_S, 0.5),
      ],
    },
    { driver: "github-copilot", name: "GitHub Copilot", windows: [], error: "Sign in to GitHub to see Copilot usage", fetchedAt: usageNow() - 180_000 },
  ],
});
const usageReport: UsageReport = usageFixture();
const usageProxy = usageOnly
  ? startDaemonProxy(() => base, { intercept: (req) => (req.method === "GET" && new URL(req.url).pathname === "/usage" ? Response.json({ data: usageReport }) : undefined) })
  : null;
const usageBaseOf = () => usageProxy?.base ?? base;
// The temp dirs go however the run ends (the finally at the bottom, process.exit, an uncaught
// error, Ctrl-C), except with --keep, which leaves the daemon running in them. A run killed
// outright (SIGKILL) can't clean up; the next run's reap (Tools/sim.ts) does it instead.
const removeTemp = () => {
  if (keep || !home) return;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
};
process.on("exit", removeTemp);
// An exit that skips the finally (an uncaught error) leaves its devices booted: shutting them down
// after this process lets go of their locks could catch the next run's boot, so the next reap
// (which takes each lock first) shuts them down instead.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, async () => {
    console.error(`sim-check: ${sig}, stopping the daemon, shutting down its simulators and removing ${home}`);
    if (!keep) {
      daemon?.kill("SIGKILL");
      Bun.spawnSync(counted(["pkill", "-f", `user-data-dir=${join(home, "chrome-profile")}`]));
      await Promise.race([shutDownDevices(), sleep(15000)]);
    }
    process.exit(130); // runs removeTemp and lets go of the simulator locks
  });
}

let token = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ""}`);
  return json.data as T;
}
const ticketOf = async (key: string) => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
const settle = (key: string, pred: (t: Ticket) => boolean, ms = 60000) => until(`${key} settles`, async () => ((t) => (pred(t) ? t : null))(await ticketOf(key)), ms, 100);
const settings = () => seedDummySettings(api);

/** Resolves once the walk-through's tickets exist, before their runs settle: the app can pair then. */
let ticketsCreated!: () => void;
const ticketsUp = new Promise<void>((r) => (ticketsCreated = r));

/** The Approve button's menu trigger, and the primary label in the git project (no gh remote, so merge). */
const APPROVE_MORE = "More ways to approve";
const APPROVE_MERGE = "Approve and merge";
/** The "Approve and…" sheet's field (its label runs on into the placeholder). */
const instructionsField = (l: string) => l.startsWith("Completion instructions");
/** The Approve action sheet has finished sliding up: a tap before that is lost. */
const approveMenuUp = (udid: string) => until("approve menu", async () => (await labels(udid)).includes("Approve and take no action"), 5000).then(() => atRest(udid, 400));

/** Every heading level, one straight after another (H2 then H3) and one after a paragraph (H4). */
const HEADINGS_BRIEF = [
  "# Heading one",
  "",
  "Intro paragraph.",
  "",
  "## Heading two",
  "### Heading three",
  "",
  "Paragraph under three.",
  "",
  "#### Heading four",
  "",
  "Closing paragraph.",
].join("\n");

/** Fenced code in three languages, syntax highlighted by CodeBlock (lib/highlight). */
const CODE_BRIEF = [
  "Greet from the API",
  "",
  "```ts",
  "export function greet(name: string, excited = false): string {",
  "  // One greeting, shared by the CLI and the API",
  "  return `Hello, ${name}${excited ? \"!\" : \".\"}`;",
  "}",
  "```",
  "```php",
  "<?php",
  "Route::get('/greet/{name}', fn (string $name) => response()->json(['text' => \"Hello, {$name}\"]));",
  "```",
  "```yml",
  "greeter:",
  "  excited: true   # the CLI's default",
  "  names: [world, Mark]",
  "```",
].join("\n");

/**
 * A file long enough that the file viewer has to scroll to a linked range: committed on main, then
 * edited in the changes ticket's worktree (greetingFor rewritten, greet_da removed, greet_ja
 * changed, greet_eo added) for the viewer's Diff tab.
 */
const GREETINGS_PATH = "src/greetings.ts";
const LOCALES: [string, string][] = [
  ["en", "Hello"], ["de", "Hallo"], ["fr", "Bonjour"], ["es", "Hola"], ["it", "Ciao"], ["pt", "Olá"],
  ["nl", "Hallo"], ["sv", "Hej"], ["da", "Hej"], ["fi", "Hei"], ["pl", "Cześć"], ["cs", "Ahoj"],
  ["tr", "Merhaba"], ["ja", "Konnichiwa"], ["ko", "Annyeong"], ["hi", "Namaste"], ["sw", "Jambo"], ["haw", "Aloha"],
];
function greetingsLines(edited: boolean): string[] {
  const out = ["// Greetings by locale, for main() and the API.", "", "export const GREETINGS: Record<string, string> = {", ...LOCALES.map(([k, v]) => `  ${k}: "${v}",`), "};", ""];
  out.push('/** The greeting for a locale: "de-AT" falls back to "de", anything unknown to English. */', "export function greetingFor(locale: string): string {");
  if (edited) out.push("  const [lang] = locale.toLowerCase().split(/[-_]/);", "  return GREETINGS[lang!] ?? GREETINGS.en!;");
  else out.push('  const lang = locale.split("-")[0];', '  return GREETINGS[lang] || "Hello";');
  out.push("}", "");
  for (const [k] of LOCALES) {
    if (edited && k === "da") continue;
    out.push(`export function greet_${k}(name: string): string {`, edited && k === "ja" ? "  return `${GREETINGS.ja}, ${name}-san!`;" : `  return \`\${GREETINGS.${k}}, \${name}!\`;`, "}", "");
  }
  if (edited) out.push("export function greet_eo(name: string): string {", "  return `Saluton, ${name}!`;", "}", "");
  return out;
}
const greetings = (edited: boolean) => greetingsLines(edited).join("\n");
/** 1-based lines of the function whose first line starts with `head`, closing brace included. */
function functionLines(lines: string[], head: string): [number, number] {
  const start = lines.findIndex((l) => l.startsWith(head));
  return [start + 1, lines.indexOf("}", start) + 1];
}
const GREETING_FOR = functionLines(greetingsLines(false), "export function greetingFor");
/** Far enough down that the viewer has to scroll to it. */
const GREET_JA = functionLines(greetingsLines(true), "export function greet_ja");

/**
 * Settings → Prompts: a working override of the review message, and a broken one of the Files
 * section. The API refuses a template naming a variable the prompt doesn't have, so the broken one
 * goes straight into the settings table, the way an app update that renamed {{shell}} would leave
 * it. The service reads settings from the database on every request, so it shows up at once.
 */
async function seedPrompts() {
  await api("PATCH", "/settings", {
    prompts: { "run.review": "Review {{ticket}} carefully.\n\nRead it with get_ticket { key: \"{{key}}\" }.\n\nCheck the tests first, then the diff." },
  });
  const prompts = { ...(readSetting<Record<string, unknown>>(home, "prompts") ?? {}), "system.files": "## Files\nRead files with {{readTool}}. Never use {{shellTool}} to edit files." };
  writeSetting(home, "prompts", prompts);
}

/**
 * Seeds the project, the other project and the tickets `needs` names (the rest are never created,
 * so a filtered run seeds only its area).
 */
/** A ticket's session context (what recording a model call leaves), and with `compacting` a compact run going. */
function seedContext(t: Ticket | undefined, c: { input: number; cacheRead: number; cacheWrite: number; estimated?: boolean; misses?: number; missTokens?: number }) {
  if (!t) return;
  setSessionContext(home, t.sessionId, { output: 0, estimated: false, at: Date.now(), prefix: 50000, misses: 0, missTokens: 0, ...c });
}

/** A compact run going on the ticket's session, which is what makes `compacting` true. The service's
 *  startup sweep fails runs it didn't start, so this goes in right before the app loads the ticket. */
function startCompactRun(t: Ticket) {
  startCompactRunAt(home, t.sessionId, `sim-compact-${t.key}`);
}

async function seed(needs: Set<SeedName>) {
  const want = (n: SeedName) => needs.has(n);
  await settings();
  await seedPrompts();
  // A git repo so tickets get worktrees and the git plugin's Changes tab.
  const repo = await seedRepo(join(scratch, "greeter"), {
    "README.md": "# Greeter\n\nSays hello.\n",
    "src/app.ts": 'export function main(name = "world") {\n  console.log("Hello, " + name);\n}\n',
    "config.json": '{\n  "verbose": false\n}\n',
    [GREETINGS_PATH]: greetings(false),
  });
  // More branches for the branch picker: one free, one checked out in another worktree.
  await git(repo, "branch", "feature/greet-emoji");
  await git(repo, "worktree", "add", "-q", "-b", "release/v2", join(scratch, "greeter-release"));
  mkdirSync(join(scratch, "harness-site"), { recursive: true });
  const [project, other] = await Promise.all([
    api<Project>("POST", "/projects", { path: repo, name: "greeter", key: "GREET", useWorktrees: true, defaultDriver: "dummy" }),
    api<Project>("POST", "/projects", { path: join(scratch, "harness-site"), name: "harness-site", key: "SITE", defaultDriver: "dummy" }),
  ]);
  const create = (projectId: string, spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId, spec, driver: "dummy", start: true, ...extra });
  /** Creates the ticket when `name` is wanted; the keys follow the order the wanted ones are made in. */
  const make = async (name: SeedName, f: () => Promise<Ticket>): Promise<Ticket> => (want(name) ? f() : (undefined as unknown as Ticket));

  const hello = await make("hello", () => create(project.id, "hello world"));
  const changes = await make("changes", () => create(project.id, "Add a greet helper with an excited mode"));
  const conductor = await make("conductor", () => create(project.id, "Ship the greeter v2\n- Add a greet helper\n- Wire it into main\n- Update the README", { kind: "conductor" }));
  const browse = await make("browse", () => create(other.id, "/browse https://example.com"));
  // A real Chrome loading a real page: anywhere from a few seconds to over a minute on a busy
  // machine. Nothing waits for it but the screens that show it (see Screen.browse).
  const browsed = want("browse") ? timed("seed: browse ticket", () => settle(browse.key, (t) => !t.busy, 120000)) : Promise.resolve();
  browsed.catch(() => {});
  const approval = await make("approval", () => create(other.id, 'Install the dependencies\n/approve Bash {"command":"npm install","description":"Install dependencies"}'));
  const blocked = await make("blocked", () => create(other.id, "Sign the build\n/block Which Apple Developer team should sign the build: Happy Cog or your personal account?"));
  const plan = await make("plan", () => create(other.id, "Write a landing page for the install link", { start: false }));
  // Sub-agents: two, the second starting a nested third (the dummy driver's /agents).
  const agents = await make("agents", () => create(project.id, "Survey the greeter before the rewrite\n/agents 3"));
  // Not started, so its branch can still be picked on the Details tab.
  const branchPlan = await make("branchPlan", () => create(project.id, "Greet in the user's language", { start: false, branch: "feature/greet-emoji", baseBranch: "release/v2" }));
  // A quick ask that skips the agent review: in review with the muted "skipped" mark.
  const quick = await make("quick", () => create(other.id, "What does the install link point at?", { skipAgentReview: true }));
  // A New session saved as a draft: a dashed card in Planning that reopens in the editor, never run.
  const draft = await make("draft", () => api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Greet in French when the locale says so", draft: true, skipAgentReview: true }));
  // Specs with fenced code (colored by its grammar) and a heading of every level.
  const code = await make("code", () => create(other.id, CODE_BRIEF, { skipAgentReview: true }));
  const headings = await make("headings", () => create(other.id, HEADINGS_BRIEF, { skipAgentReview: true }));
  // A spec with a relative file link, which opens in the ticket's own worktree.
  // The link is a paragraph of its own, so a tap near the paragraph's start lands on it.
  const fileLink = await make("fileLink", () => create(project.id, `Tidy the greetings\n\n[greetingFor fallback](${GREETINGS_PATH}#L${GREETING_FOR[0]}-L${GREETING_FOR[1]})`, { skipAgentReview: true }));
  // Two stages of one Jira issue: both linked to the remote ID JIRA-62, so each card and header shows
  // "JIRA-62 · GREET-n", and Details lists the other.
  const jira62 = { source: "jira", key: "JIRA-62", url: "https://example.com/browse/JIRA-62", raw: null };
  const linked = await make("linked", () => create(project.id, "Review the empty-name crash fix", { start: false, externalRef: jira62 }));
  const linkedStage = want("linked") ? await create(project.id, "Ship the empty-name crash fix", { start: false, externalRef: jira62 }) : (undefined as unknown as Ticket);
  // A background Bash task (the dummy driver's /bgtask): Agents & tasks lists it, and its view shows the output.
  const tasks = await make("tasks", () => create(project.id, "Count the greetings in the background\n/bgtask 30", { skipAgentReview: true }));
  // Context gauge tickets: planning tickets (nothing runs on them past the dummy's plan) that are
  // then switched to the drivers that report context, so no real CLI ever runs. Their gauge numbers
  // go straight into the sessions table, the way the service's per-call recording would leave them.
  const gaugeOf = (name: SeedName, driver: string) =>
    make(name, async () => {
      const t = await create(other.id, `Gauge ${name}`, { start: false, skipAgentReview: true });
      await settle(t.key, (x) => x.status === "planning" && !x.busy);
      return api<Ticket>("PATCH", `/tickets/${t.key}`, { driver });
    });
  const [gauge, gaugeMiss, gaugeCompact] = await Promise.all([
    gaugeOf("gauge", "claude-code"),
    gaugeOf("gaugeMiss", "claude-code"),
    gaugeOf("gaugeCompact", "claude-code"),
  ]);
  seedContext(gauge, { input: 6000, cacheRead: 61000, cacheWrite: 15000 });
  seedContext(gaugeMiss, { input: 4000, cacheRead: 60000, cacheWrite: 36000, misses: 3, missTokens: 377000 });
  seedContext(gaugeCompact, { input: 3000, cacheRead: 150000, cacheWrite: 20000 });
  // A ticket with agent notes for the Details tab: its agent sets them with update_notes (the dummy
  // driver's /tools directive), and the notes start collapsed there.
  const noted = await make("noted", () =>
    create(project.id, `Greet by name\n/tools ${JSON.stringify([{ name: "update_notes", input: { notes: "## Where things live\n- `src/app.ts`: `main(name)` builds the greeting\n\n## Verify\n- `bun src/app.ts Ada` prints `Hello, Ada`" } }])}`, { skipAgentReview: true }),
  );
  ticketsCreated();

  // The watchers and the Inbox item don't depend on the tickets: set them up while those run.
  // The prompt names the project; the dummy triager reads the [dummy:project KEY] marker.
  const prompt = "If this issue is assigned to me and has actionable next steps, dispatch it to an agent in GREET.";
  const watchers = want("watchers")
    ? Promise.all([
        // A watcher-less triage item for the Inbox.
        api("POST", "/watchers/inject", { source: "jira", text: JSON.stringify({ key: "FOO-123", summary: "Greeter crashes on an empty name", url: "https://example.com/FOO-123", updated: "1" }), prompt: `${prompt} [dummy:project ${project.key}]` }),
        // A paused shell watcher, so Settings and the watcher form have one to show (and it never runs).
        api<Watcher>("POST", "/watchers", { name: "jira", command: "while true; do curl -s https://example.com/api/events | jq -c '.[]'; sleep 60; done", args: [], prompt, mode: "loop", enabled: false, driver: "dummy" }),
        // Live watchers for the Inbox's watcher strip: one whose process stays up (and prints nothing),
        // one that fails at once and sits in its backoff with the error.
        api<Watcher>("POST", "/watchers", { name: "heartbeat", command: "while true; do sleep 3600; done", mode: "loop", driver: "dummy" }),
        api<Watcher>("POST", "/watchers", { name: "jira-sprint", command: "echo 'watch-jira: 401 Unauthorized (check JIRA_TOKEN)' >&2; exit 1", mode: "loop", driver: "dummy" }),
      ])
    : Promise.resolve([]);

  /** Waits for a wanted ticket to settle; a ticket nobody asked for has nothing to wait for. */
  const when = (name: SeedName, key: string | undefined, pred: (t: Ticket) => boolean) => (want(name) ? settle(key!, pred) : Promise.resolve(undefined));
  const [, ch] = await Promise.all([
    want("hello")
      ? settle(hello.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview))
          // A commit on its branch, so it has something to land and the Approve menu offers "Approve
          // and merge" (with nothing to land it leads with "Approve and clean up" and drops merge).
          // Opening a ticket in review re-checks its worktree.
          .then(async (t) => {
            writeFileSync(join(t.workdir!, "HELLO.md"), "Hello, world.\n");
            await git(t.workdir!, "add", "-A");
            await git(t.workdir!, "commit", "-qm", "Say hello");
            await until(`${hello.key} has changes to land`, async () => (await api<TicketDetail>("GET", `/tickets/${hello.key}`)).ticket.hasChanges === true, 10000, 200);
          })
      : null,
    when("changes", changes?.key, (t) => t.status === "review" && !t.busy && !!t.workdir),
    when("approval", approval?.key, (t) => !!t.pendingApproval),
    when("blocked", blocked?.key, (t) => t.status === "blocked" && !t.busy),
    when("plan", plan?.key, (t) => t.status === "planning" && !t.busy),
    when("branchPlan", branchPlan?.key, (t) => t.status === "planning" && !t.busy),
    when("quick", quick?.key, (t) => t.status === "review" && !t.busy && t.agentReview === "skipped"),
    when("agents", agents?.key, (t) => t.status === "review" && !t.busy),
    when("code", code?.key, (t) => t.status === "review" && !t.busy),
    when("headings", headings?.key, (t) => t.status === "review" && !t.busy),
    when("fileLink", fileLink?.key, (t) => t.status === "review" && !t.busy && !!t.workdir),
    when("linked", linked?.key, (t) => t.status === "planning" && !t.busy),
    when("linked", linkedStage?.key, (t) => t.status === "planning" && !t.busy),
    when("noted", noted?.key, (t) => !t.busy && !!t.agentNotes),
    // Then a `/agents 2` turn: its Agents & tasks list mixes both kinds, for the filter.
    want("tasks")
      ? settle(tasks.key, (t) => t.status === "review" && !t.busy)
          .then(() => api("POST", `/tickets/${tasks.key}/messages`, { text: "/agents 2", move: true }))
          .then(() => until(`${tasks.key} has its sub-agents`, async () => ((await api<TicketDetail>("GET", `/tickets/${tasks.key}`)).subagents?.length ?? 0) >= 3, 30000, 200))
          .then(() => settle(tasks.key, (t) => t.status === "review" && !t.busy))
      : null,
    want("conductor") ? until("conductor children", async () => (await api<TicketDetail>("GET", `/tickets/${conductor.key}`)).children.length >= 3, 60000, 100) : null,
  ]);
  // Edit the worktree the way an agent would: a commit on the branch plus uncommitted changes.
  if (want("changes")) {
    const wd = (ch as Ticket).workdir!;
    mkdirSync(join(wd, "src/lib"), { recursive: true });
    writeFileSync(join(wd, "src/lib/greet.ts"), 'export function greet(name: string, excited = false) {\n  const base = "Hello, " + name;\n  return excited ? base + "!" : base;\n}\n');
    await git(wd, "add", "-A");
    await git(wd, "commit", "-qm", "Add greet helper");
    writeFileSync(join(wd, "src/app.ts"), 'import { greet } from "./lib/greet";\n\nexport function main(name = "world") {\n  console.log(greet(name, true));\n}\n');
    writeFileSync(join(wd, "config.json"), '{\n  "verbose": true\n}\n');
    writeFileSync(join(wd, "CHANGELOG.md"), "# Changelog\n\n- Greet with an exclamation mark\n");
    writeFileSync(join(wd, GREETINGS_PATH), greetings(true));
  }
  const nestedAgent = want("agents") ? (await api<TicketDetail>("GET", `/tickets/${agents.key}`)).subagents!.find((s) => s.parentId)! : (undefined as unknown as NonNullable<TicketDetail["subagents"]>[number]);
  const [, watcher] = (await watchers) as unknown as [unknown, Watcher];
  const seeded = { gauge, gaugeMiss, gaugeCompact, project, other, hello, changes, conductor, browse, browsed, approval, blocked, plan, branchPlan, quick, draft, watcher, agents, nestedAgent, tasks, code, headings, fileLink, linked, linkedStage, noted };
  // Every entry builds its link from the seed, selected or not: a ticket nobody asked for reads as a
  // stand-in ("UNSEEDED"), which only an entry that forgot to declare it in `needs` would ever open.
  const names = new Set<string>([...SEED_NAMES, "nestedAgent", "watcher"]);
  const unseeded = { key: "UNSEEDED", id: "UNSEEDED", name: "UNSEEDED" };
  return new Proxy(seeded, { get: (o, k: string) => ((o as Record<string, unknown>)[k] === undefined && names.has(k) ? unseeded : (o as Record<string, unknown>)[k]) });
}

/** --paging: a long Done history on its own project and a conductor with done children. */
async function seedPaging() {
  mkdirSync(join(scratch, "archive"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "archive"), name: "archive", key: "ARCH", defaultDriver: "dummy" });
  const create = (spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: false, ...extra });
  const finish = (t: Ticket) => api<Ticket>("PATCH", `/tickets/${t.key}`, { status: "done" });
  // Oldest first: the haystack ticket finishes before everything else, so it sits pages deep.
  const needle = await create("Needle in the haystack: rotate the signing certificate");
  await finish(needle);
  const history: Ticket[] = [];
  for (let i = 1; i <= 125; i += 25) {
    const batch = await Promise.all(Array.from({ length: Math.min(25, 126 - i) }, (_, j) => create(`Archived chore ${String(i + j).padStart(3, "0")}`)));
    await Promise.all(batch.map(finish));
    history.push(...batch);
  }
  const conductor = await create("Release train: ship 2.0", { kind: "conductor" });
  const kids: Ticket[] = [];
  for (const title of ["Cut the release branch", "Write the changelog", "Tag the build", "Announce the release"]) kids.push(await create(title, { parentId: conductor.id }));
  // The newest completions are children: if they weren't hidden they'd top the Done column.
  for (const k of kids.slice(0, 3)) await finish(k);
  // The newest non-child completion, as the server orders them.
  const top = (await api<TicketPage>("GET", `/tickets/page?status=done&limit=8&projectId=${encodeURIComponent(project.id)}`)).tickets.find((t) => !t.parentId)!;
  return { project, needle, history, conductor, kids, top };
}

/** --paging: real taps against the seeded Done history. */
async function pagingChecks(udid: string, p: Awaited<ReturnType<typeof seedPaging>>) {
  selector.sequence();
  const has = async (prefix: string) => (await labels(udid)).some((l) => l.startsWith(prefix));
  // A quick flick, so the list carries on with momentum.
  const swipeUp = () => axe("swipe", "--start-x", "200", "--start-y", "720", "--end-x", "200", "--end-y", "220", "--duration", "0.1", "--udid", udid);
  // The strip scrolls to follow the page, so a tap can land on a neighbour: tap until a Done card is on
  // screen. Frames are in screen points and a card sits 14pt into its page, so from the Review page the
  // Done column's first card is at x≈416, just off the right edge: only a card near the left edge counts.
  const openDone = async () => {
    for (let i = 0; i < 4; i++) {
      await tapWhere(udid, (l) => l.startsWith("Done,"));
      const card = await until("a Done card", () => findElement(udid, (l) => l.startsWith(`${p.top.key} `)), 1500).catch(() => null);
      if (card && card.frame.x >= 0 && card.frame.x < 100) return;
    }
    throw new Error("couldn't open the Done column");
  };
  const deep = p.history.at(-60)!; // ~60th newest: on the second page (50 a page)

  await goto(udid, BOARD, (l) => l.some((x) => /^ARCH-\d+ /.test(x)));
  await shootBoth(udid, "paging-board");
  await check("the Done column scrolls into older pages", async () => {
    await openDone();
    // Reading the tree (every loaded card) costs more than a swipe, so look after every few. A lazy
    // list only has the cards on screen in the tree, and a few flicks can carry it
    // past `deep`, so any card at least as old (past the first page) counts.
    const older = [...p.history.slice(0, -59), p.needle].map((t) => `${t.key} `);
    for (let i = 0; i < 45; i += 3) {
      const seen = (await labels(udid)).find((l) => older.some((k) => l.startsWith(k)));
      if (seen) return `${seen.split(" ")[0]} (≥ 60th newest) after ${i} swipes`;
      for (let j = 0; j < 3; j++) await swipeUp();
      await atRest(udid, 300);
    }
    throw new Error(`${deep.key} never appeared`);
  });
  await shootBoth(udid, "paging-done-scrolled");
  await check("search finds a done ticket that isn't loaded", async () => {
    // The command palette's field is always in the board's bottom bar, between Projects and New
    // session. Tapping it opens the palette, whose ticket rows come from the service's search.
    await goto(udid, BOARD);
    await atRest(udid, 500);
    await tapHeader(udid, "Command palette", { x: 192, y: 811 });
    await atRest(udid, 500);
    await axe("type", "haystack", "--udid", udid);
    await until(`${p.needle.key} in the results`, () => has(`${p.needle.key} `), 10000);
    return p.needle.key;
  });
  moved(udid);
  await atRest(udid, 400); // the result list's cards finish drawing
  await shootBoth(udid, "paging-search");
}

/** --sheets: a conductor with two children, not started, on a project of its own. */
/** A file in the sheets project, for the docked file card. */
const DOCK_FILE = "notes.ts";

async function seedSheets() {
  mkdirSync(join(scratch, "sheets"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "sheets"), name: "sheets", key: "SHEET", defaultDriver: "dummy" });
  const create = (spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: false, ...extra });
  const conductor = await create("Sheet train: dock the ticket sheet", { kind: "conductor" });
  // The first child's spec runs long, so its screen scrolls (the content-fling check).
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: enough words here to wrap onto a second line of the spec on a phone's width.`).join("\n\n");
  await create(`Dock the sheet under the board\n\n${long}`, { parentId: conductor.id });
  await create("Swipe the sheet away", { parentId: conductor.id });
  writeFileSync(join(scratch, "sheets", DOCK_FILE), 'export const notes = [\n  "dock me",\n  "line three",\n  "line four",\n];\n');
  return { project, conductor };
}

/**
 * A docked ticket's card (the iPhone's dock, the iPad's corner, the expanded list), labelled "<key>, <title>, docked" (or
 * "New session, docked").
 */
const isDock = (l: string) => l.endsWith(", docked");
/** How many tickets are docked: the cards on screen plus what their "N more…" card counts. */
const dockCount = (l: string[]) => l.filter(isDock).length + Number(l.find((x) => /^\d+ more docked tickets$/.test(x))?.split(" ")[0] ?? 0);
/** The iPhone's top docked ticket: the card at the bottom of the dock (the last one listed). */
const topDock = (l: string[]) => l.filter(isDock).at(-1);

/**
 * Docks the presented ticket sheet the way a person does: drags it by its top down to just above the
 * bottom, slowly enough that the finger spends more than the hold's 0.5 s in the bottom 40% of the
 * screen (DockArming) with the sheet well away from rest, and lets go there. AXe can't pause mid-drag,
 * so the slow swipe is the hold: the ghost "Dock" card shows during its last second (`ghost` reads
 * it then, and `shotName` takes a screenshot of it), and the release docks. Returns the dock's label.
 */
async function dockSheet(udid: string, opts: { ghost?: boolean; shotName?: string } = {}): Promise<string> {
  // The screen's size from the tallest top-level element: with New session coming up, the first
  // one can be a zero-height stand-in, which put the drag's end above the screen.
  const { width, height } = (await tree(udid)).reduce((a, b) => (b.frame.height > a.frame.height ? b : a)).frame;
  const x = String(Math.round(width / 2));
  const drag = axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(height - 110)), "--duration", "3", "--udid", udid);
  if (opts.ghost || opts.shotName) {
    await sleep(2600);
    if (opts.ghost) {
      const seen = await until("the ghost dock card", async () => (await labels(udid)).some((l) => l.startsWith("Dock card")), 1500).catch(() => null);
      if (!seen) throw new Error("holding the sheet low didn't show the ghost dock card");
    }
    if (opts.shotName) await shot(udid, opts.shotName);
  }
  await drag;
  return until("the dock", async () => topDock(await labels(udid)), 6000);
}

/** The board's bottom bar sits DockMetrics.barGap (11pt) above the topmost docked card (or "N more…"), whatever the card count. */
async function barClearsDock(udid: string, dockTop?: number) {
  if (dockTop === undefined) {
    dockTop = await until("a docked card", async () => {
      const tops = (await nodes(udid)).filter((x) => (x.AXLabel && isDock(x.AXLabel)) || x.AXUniqueId === "ticket-dock-more").map((x) => x.frame.y);
      return tops.length ? Math.min(...tops) : null;
    }, 5000);
  }
  // The bar glides to its place as the stack grows or shrinks: it has to settle at the gap, not just pass through it.
  let gap = NaN;
  const deadline = Date.now() + 3000;
  do {
    // The board's elements can lag a beat behind the dock after a sheet or the palette closes.
    const bar = await findElement(udid, (x) => x === "New session");
    gap = bar ? dockTop - (bar.frame.y + bar.frame.height) : NaN;
    if (Math.abs(gap - 11) <= 3) return;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(Number.isNaN(gap) ? "no New session button on the board" : `the bar sits ${Math.round(gap)}pt above the dock (top ${Math.round(dockTop)}), not 11`);
}

/**
 * Swipes docked ticket sheets away until none is left (each swipe closes the one on top), so a
 * shot of a tab doesn't carry them.
 */
/** Closes every docked ticket at once: opening Projects does (one tap, however many are docked). */
async function clearDock(udid: string) {
  if (!(await labels(udid)).some(isDock)) return;
  await goto(udid, BOARD);
  await tapWhere(udid, "Projects");
  await until("the Projects sheet", async () => (await labels(udid)).includes("Inbox"), 5000);
  await goto(udid, BOARD);
}
/** Closes the docked cards one at a time with their ✕ until none is left. */
async function undock(udid: string) {
  for (let i = 0; i < 20; i++) {
    const close = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-dock-close");
    if (!close) return;
    const before = dockCount(await labels(udid));
    await axe("tap", "-x", String(Math.round(close.frame.x + close.frame.width / 2)), "-y", String(Math.round(close.frame.y + close.frame.height / 2)), "--udid", udid);
    await until("one fewer docked", async () => dockCount(await labels(udid)) < before, 6000);
  }
  throw new Error("the dock never emptied");
}

/**
 * The iPhone's ticket sheet (TicketSheetHost): a board card (`column`, the card's column chip) or
 * else a link opens it, a conductor's child pushes in it and the back swipe returns, it docks
 * under the board when dragged to the bottom, its card restores it as it was, the card's ✕ sends it
 * away, and New session docks as "New session".
 */
async function sheetChecks(udid: string, p: { project: Project; conductor: Ticket }, column?: string) {
  selector.sequence("declared");
  const key = p.conductor.key;
  const [kid, sibling] = (await api<TicketDetail>("GET", `/tickets/${key}`)).children;
  if (!kid || !sibling) throw new Error(`${key} has no children`);
  const { width: W, height: H } = (await tree(udid))[0]!.frame;
  const has = (l: string[], k: string) => l.some((x) => x.includes(k));
  const card = (l: string) => l.startsWith(`${key} `);
  /** The sheet's ticket screen, with the conductor's children listed. */
  const onConductor = (l: string[]) => has(l, kid.key) && has(l, sibling.key);
  /** The child's screen: its parent crumb, and none of the conductor's list. */
  const onChild = (l: string[]) => l.includes(`Part of ${key}`) && !has(l, sibling.key);
  const dock = () => dockSheet(udid);
  const say = async (what: string) => console.log(`    ${what}: ${(await labels(udid)).slice(0, 40).join(" | ")}`);
  // A full pass starts on a board with nothing docked, and each check leaves it so; a picked check, or a
  // reused app, starts from whatever the last run left (a card still in the dock throws off a flick).
  if (selector.hasMatcher || attached) {
    await goto(udid, BOARD);
    await undock(udid);
  }

  // The checks below that start from the previous one's screen name it in `needs` (see check()).
  const OPEN = `${column ? "a board card" : "a ticket link"} opens its ticket in a sheet over the board`;
  const DOCKED = "dragging the sheet to the bottom docks it under the board, titled by the ticket on top";
  const RESTORED = "the dock survives a tab change, and a tap restores the sheet where it was";
  await check(OPEN, async () => {
    await goto(udid, BOARD);
    await undock(udid);
    if (column) {
      await until("card on screen", async () => {
        await tapWhere(udid, (l) => l.startsWith(`${column},`));
        return ((await until("card", () => findElement(udid, card), 1500).catch(() => null))?.frame.x ?? 999) < 100;
      }, 15000);
      await tapWhere(udid, card);
      moved(udid);
      await until("the ticket sheet", async () => (await labels(udid)).some((l) => l.startsWith("Tickets")), 8000).catch(async (e) => {
        await say("after the card tap");
        throw e;
      });
      await tapWhere(udid, (l) => l.startsWith("Tickets"));
    } else {
      await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=children`);
    }
    await until("the children", async () => onConductor(await labels(udid)), 8000);
    if ((await labels(udid)).some(isDock)) throw new Error("a dock is showing over a presented sheet with no other ticket docked");
    // The Tickets tab collapses the hero, and a collapsed hero hides its actions, the […] too; with no
    // navigation bar, the hero's title is the top of the sheet.
    const rootLabels = await labels(udid);
    if (rootLabels.includes("More")) throw new Error("the collapsed hero still shows its More menu");
    await shot(udid, "sheet-presented-light");
    // The composer's bar is as far from the screen's bottom as from its side, as on a pushed ticket:
    // a sheet doesn't keep the home indicator's inset, so the window's figure would sit it too low.
    const attach = await findElement(udid, (l) => l === "Attach");
    if (!attach) throw new Error("no composer in the sheet");
    const gap = H - (attach.frame.y + attach.frame.height);
    if (Math.abs(gap - attach.frame.x) > 3)
      throw new Error(`the composer sits ${Math.round(gap)}pt above the bottom but ${Math.round(attach.frame.x)}pt from the side`);
    return `${key} in the sheet`;
  });
  await check("a conductor's child pushes inside the sheet and the back swipe returns", async () => {
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child", async () => onChild(await labels(udid)), 8000).catch(async (e) => {
      await say("after the child tap");
      throw e;
    });
    // The expanded hero: the […] after its actions, and nothing in a navigation bar but Back (no
    // title, no menu, no Copy key).
    const childLabels = await labels(udid);
    if (!childLabels.includes("More")) throw new Error(`no More menu in the child's hero: ${childLabels.slice(0, 30).join(" | ")}`);
    if (childLabels.includes("Copy key") || childLabels.includes("Open in New Window")) throw new Error("the old header menu's items are showing");
    await shot(udid, "sheet-child-light");
    await tapWhere(udid, "More");
    const menu = await until("the More menu", async () => ((l) => (l.includes("Delete ticket") ? l : null))(await labels(udid)), 5000);
    if (!menu.includes("Move to done") && !menu.includes("Cancel run") && !menu.includes("Delete ticket")) throw new Error(menu.join(" | "));
    await shot(udid, "sheet-child-more-light");
    await axe("tap", "-x", String(Math.round(W * 0.5)), "-y", String(Math.round(H * 0.9)), "--udid", udid); // dismiss the menu
    await until("the menu gone", async () => !(await labels(udid)).includes("Delete ticket"), 5000);
    // The first page's rightward swipe goes to the back swipe (PagerYieldsToBackSwipe).
    await atRest(udid, 800); // back only goes once the pager rests on the first page
    const y = String(Math.round(H * 0.7));
    await axe("swipe", "--start-x", String(Math.round(W * 0.1)), "--start-y", y, "--end-x", String(Math.round(W * 0.9)), "--end-y", y, "--duration", "0.3", "--udid", udid);
    await until("back on the conductor", async () => onConductor(await labels(udid)), 8000).catch(async (e) => {
      await say("after the back swipe");
      throw e;
    });
    return `${kid.key} → back to ${key}`;
  }, CHECK_CAP_MS, [OPEN]);
  // Where the child's composer sat before docking: restored, it sits there again, not lifted by
  // the inset the system gave the docked sheet.
  let composerBefore: AXNode["frame"] | null = null;
  await check(DOCKED, async () => {
    // Pushed again, so restoring has a path to bring back.
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child", async () => onChild(await labels(udid)), 8000);
    composerBefore = (await findElement(udid, (x) => x === "Send"))?.frame ?? null;
    const label = await dockSheet(udid, { ghost: true, shotName: shotsWanted ? "sheet-dock-ghost" : undefined }).catch(async (e) => {
      await say("after the drag");
      throw e;
    });
    if (label !== `${kid.key}, ${kid.title}, docked`) throw new Error(`the dock reads "${label}", not ${kid.key} and its title`);
    await until("the board over the dock", async () => onBoard(await labels(udid)), 5000).catch(() => {
      throw new Error("the board isn't showing over the dock");
    });
    // The dock sits below the board's bottom bar, not over it.
    // The docked sheet's own frame, from its card: a glass capsule as wide and tall as the docked
    // sheet, whose open button starts at its leading edge and whose ✕ ends 10pt in.
    const all = await nodes(udid);
    const cardOpen = all.find((n) => n.AXLabel && isDock(n.AXLabel));
    const cardClose = all.find((n) => n.AXUniqueId === "ticket-dock-close");
    const bar = cardOpen && cardClose
      ? { ...cardOpen, frame: { x: cardOpen.frame.x, y: cardOpen.frame.y, width: cardClose.frame.x + cardClose.frame.width + 10 - cardOpen.frame.x, height: cardOpen.frame.height } }
      : null;
    const newSession = await findElement(udid, (x) => x === "New session");
    if (bar && newSession && newSession.frame.y + newSession.frame.height > bar.frame.y)
      throw new Error(`New session (bottom ${Math.round(newSession.frame.y + newSession.frame.height)}) runs under the dock (top ${Math.round(bar.frame.y)})`);
    // And as far from the screen's sides as that bar, which keeps its resting inset while docked: Projects at its left end, New session at its right.
    const projects = await findElement(udid, (x) => x === "Projects");
    if (bar && projects && newSession) {
      const left = bar.frame.x - projects.frame.x;
      const right = bar.frame.x + bar.frame.width - (newSession.frame.x + newSession.frame.width);
      if (Math.abs(left) > 2 || Math.abs(right) > 2)
        throw new Error(`the dock (${Math.round(bar.frame.x)}–${Math.round(bar.frame.x + bar.frame.width)}) isn't inset like the bar (${Math.round(projects.frame.x)}–${Math.round(newSession.frame.x + newSession.frame.width)})`);
      // The bar's gap above the dock (DockMetrics.barGap) is DockMetricsTests'; the check above
      // already fails on a bar that runs under it.
    }
    await shootBoth(udid, "sheet-docked");
    return label;
  }, CHECK_CAP_MS, [OPEN]);
  await check(RESTORED, async () => {
    await goto(udid, "harness://settings");
    if (!(await labels(udid)).some(isDock)) throw new Error("no dock on Settings");
    await goto(udid, BOARD);
    await tapWhere(udid, isDock);
    moved(udid);
    await until("the child again", async () => {
      const l = await labels(udid);
      return onChild(l) && !l.some(isDock);
    }, 8000);
    if (composerBefore) {
      const before = composerBefore;
      let y: number | undefined;
      await until("the composer where it was", async () => {
        y = (await findElement(udid, (x) => x === "Send"))?.frame.y;
        return y !== undefined && Math.abs(y - before.y) <= 1;
      }, 4000).catch(() => {
        throw new Error(`the composer's Send sits at y ${y === undefined ? "(gone)" : Math.round(y)}, not ${Math.round(before.y)} as before docking`);
      });
    }
    return `${kid.key} restored`;
  }, CHECK_CAP_MS, [DOCKED]);
  await check("the dock's close button sends it away without opening it", async () => {
    await dock();
    // Recorded, since a sheet that grows to full size on its way out is gone before the
    // accessibility tree can be read: the screen's top half, above the dock, mustn't change. It
    // holds within 0.1 as the dock slides away; a sheet that grows first moves it by about 6.
    const frames = await recordFrames(udid, "sheet-dock-close", async () => {
      await tapWhere(udid, `Close ${kid.key}`);
      await until("the dock gone", async () => !(await labels(udid)).some(isDock), 4000);
    });
    const moved = Math.max(...frames.map((f) => frameDiff(f, frames[0]!)));
    if (moved > 2) throw new Error(`the sheet grew over the board on its way out (top half changed by ${moved.toFixed(1)})`);
    await until("the board", async () => onBoard(await labels(udid)), 4000).catch(async (e) => {
      await say("after the close button");
      throw e;
    });
    if (onChild(await labels(udid))) throw new Error(`${kid.key} opened instead`);
    await shootBoth(udid, "sheet-dock-closed");
    // Back up for the next check.
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    return `closed, the board held still (${frames.length} frames, top half changed by at most ${moved.toFixed(1)})`;
  }, CHECK_CAP_MS, [RESTORED]);
  // The ticket sheet is one rigid piece while a finger drags it: the system shrinks the sheet from
  // the top, and the ticket inside must only slide with it, never lay out again (a header that
  // resizes, a transcript that snaps back to its bottom). Each frame of a slow drag, held down
  // part of the way, must match the first frame's content moved down and scaled a little.
  const RIGID_MATCH = 0.9;
  const rigid = async (name: string, link: string, ready: () => Promise<unknown>) => {
    await goto(udid, link);
    await ready();
    await atRest(udid, 600);
    const w = 196;
    const h = Math.round((w * H) / W);
    const frames = await recordFrames(
      udid,
      name,
      async () => {
        const x = String(Math.round(W / 2));
        await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(90 + 0.35 * (H - 70))), "--duration", "2", "--udid", udid);
        await atRest(udid, 1200); // the spring back
      },
      { vf: `scale=${w}:${h},format=gray`, bytes: w * h },
    );
    const worst = rigidWorst(frames, w, h);
    const said = `worst frame ${worst.frame} of ${frames.length} matches the first at ${worst.corr.toFixed(3)} (scale ${worst.scale.toFixed(3)}, down ${Math.round(worst.shift * 2)}pt)`;
    if (worst.corr < RIGID_MATCH) throw new Error(`the ticket changed shape mid-drag: ${said}`);
    return `the content only moved and scaled: ${said}`;
  };
  await check("a slow drag on the transcript moves the ticket as one piece", async () => {
    // A ticket with a transcript taller than the screen, which opens stuck to the bottom. Made
    // here rather than with the seed: its card would change the board the checks above tap.
    const talker = await api<Ticket>("POST", "/tickets", { projectId: p.project.id, spec: stickText(0, 14), driver: "dummy", start: true });
    await settle(talker.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview));
    for (let n = 1; n <= 4; n++) await sayStick(talker.key, n);
    const said = await rigid("sheet-drag-transcript", `harness://ticket/${encodeURIComponent(talker.key)}?tab=transcript`, () => until("the transcript", async () => (await labels(udid)).some((l) => l.startsWith("Run finished (")), 10000));
    // Closed again, or a swipe away later on would bring it back docked.
    await dock();
    await tapWhere(udid, `Close ${talker.key}`);
    await until("its dock gone", async () => !(await labels(udid)).some((l) => isDock(l) && l.startsWith(talker.key)), 4000);
    return said;
  });
  await check("a slow drag on the Spec tab moves the ticket as one piece", () =>
    rigid("sheet-drag-spec", `harness://ticket/${encodeURIComponent(kid.key)}?tab=spec`, () => until("the spec", async () => onChild(await labels(udid)), 8000)));
  await check("a half drag released back shows nothing: the sheet springs back to full size", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    // Slow, to a quarter of the way down, held there (the drag lets go at its end): the system's
    // own rule springs it back, and the finger never reached the dock zone, so nothing docks.
    const x = String(Math.round(W / 2));
    await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(90 + 0.25 * (H - 70))), "--duration", "0.8", "--udid", udid);
    await atRest(udid, 1200); // the spring back, and a dock if it wrongly came
    const l = await labels(udid);
    if ((await probe(udid))?.router.ticketSheet === "docked") throw new Error("a short drag docked the sheet (the probe says docked)");
    if (l.some(isDock)) {
      await say("after the short drag");
      throw new Error("a short drag docked the sheet");
    }
    if (!onChild(l)) throw new Error("the sheet isn't back at full size on the child");
    if (shotsWanted) await shot(udid, "sheet-spring-back");
    return "back at full size, not docked";
  });
  await check("scrolling the ticket's content down and flinging it back up fast leaves the sheet open", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    const x = String(Math.round(W / 2));
    // Slow drags up scroll the content down; then a fast finger-down fling (long strides, as in the
    // flick below) scrolls it back. The pan on the sheet sees all of it, but the sheet never moved.
    for (let i = 0; i < 2; i++)
      await axe("swipe", "--start-x", x, "--start-y", String(Math.round(H * 0.7)), "--end-x", x, "--end-y", String(Math.round(H * 0.35)), "--duration", "0.6", "--udid", udid);
    await axe("swipe", "--start-x", x, "--start-y", String(Math.round(H * 0.3)), "--end-x", x, "--end-y", String(Math.round(H * 0.8)), "--duration", "0.1", "--delta", "100", "--udid", udid);
    await atRest(udid, 1200); // a fling that docked or closed the sheet moves the router
    const l = await labels(udid);
    if ((await probe(udid))?.router.ticketSheet !== "presented") throw new Error(`a fast scroll of the ticket's content left the sheet ${(await probe(udid))?.router.ticketSheet}`);
    // The "Part of" link has scrolled away: the grabber and the ticket's own tabs say it's open.
    if (l.some(isDock) || !has(l, "Sheet Grabber") || !has(l, "Spec")) {
      await say("after the content fling");
      throw new Error("a fast scroll of the ticket's content closed or docked the sheet");
    }
    // Back to the board (the link docks the sheet) and close the dock, so the next check opens the
    // ticket scrolled to its top.
    await goto(udid, BOARD);
    await tapWhere(udid, `Close ${kid.key}`);
    await until("the board", async () => onBoard(await labels(udid)) && !(await labels(udid)).some(isDock), 6000);
    return "still open at full size";
  });
  await check("a flick down still dismisses while the app's main thread is stalled", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    // The app is stopped (SIGSTOP) for a second part-way through the flick, so every touch event
    // reaches it late; the system's momentum comes from the touches' own timestamps, so it must still dismiss.
    const x = String(Math.round(W / 2));
    const pid = await appPid(udid);
    const swipe = axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(H - 110)), "--duration", "0.1", "--delta", "100", "--udid", udid);
    await sleep(150);
    Bun.spawnSync(counted(["kill", "-STOP", String(pid)]));
    await sleep(1000);
    Bun.spawnSync(counted(["kill", "-CONT", String(pid)]));
    await swipe;
    await until("the sheet gone", async () => {
      const l = await labels(udid);
      return !has(l, kid.key) && onBoard(l);
    }, 6000).catch(async (e) => {
      await say("after the stalled flick");
      throw e;
    });
    await atRest(udid, 300);
    if ((await labels(udid)).some(isDock)) throw new Error("the stalled flick docked the sheet");
    lastUrl.set(udid, BOARD);
    return "gone, no dock";
  });
  await check("a swipe down from full size closes the ticket rather than docking it", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    // The simulator takes each of AXe's touch points slowly whatever --duration says, so a flick
    // is long strides (--delta, in pixels) rather than a short duration. However fast or far, a swipe
    // away closes the ticket: only the slow hold in dockSheet docks.
    const x = String(Math.round(W / 2));
    await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(H - 110)), "--duration", "0.1", "--delta", "100", "--udid", udid);
    await until("the sheet gone", async () => {
      const l = await labels(udid);
      return !has(l, kid.key) && onBoard(l);
    }, 6000).catch(async (e) => {
      await say("after the flick");
      throw e;
    });
    await atRest(udid, 300); // a dock would be animating in right after the sheet goes
    if ((await labels(udid)).some(isDock)) throw new Error("the flick docked the sheet");
    lastUrl.set(udid, BOARD);
    return "gone, no dock";
  });
  await check("a ticket docked with the keyboard up reopens from its card at its scroll position with its draft", async () => {
    // The ticket whose long spec scrolls (the first child). The sheet is torn down on dismissal, so
    // what comes back is TicketViewMemory's scroll offset and the board store's composer draft. (A
    // ticket that is closed, not docked, comes back fresh; its draft is the store's.)
    const link = `harness://ticket/${encodeURIComponent(kid.key)}?tab=spec`;
    // The spec is one text block starting "Paragraph 1:": its top edge says how far it's scrolled.
    const specTop = async () => (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Paragraph 1:"))?.frame.y;
    await goto(udid, link);
    await until("the long spec", async () => (await specTop()) !== undefined, 8000);
    await atRest(udid, 600);
    const start = (await specTop())!;
    const x = String(Math.round(W / 2));
    for (let i = 0; i < 3; i++)
      await axe("swipe", "--start-x", x, "--start-y", String(Math.round(H * 0.7)), "--end-x", x, "--end-y", String(Math.round(H * 0.3)), "--duration", "0.6", "--udid", udid);
    await atRest(udid, 600);
    const before = (await specTop())!;
    if (!(start - before > 100)) throw new Error(`the spec didn't scroll: its top went from ${start} to ${before}`);
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    await axe("type", "kept", "--udid", udid);
    // With the keyboard up, the hold docks it: the sheet is dismissed and its view torn down.
    await dockSheet(udid);
    await until("the sheet gone", async () => (await specTop()) === undefined && onBoard(await labels(udid)), 8000);
    await tapWhere(udid, isDock);
    moved(udid);
    await until("the spec again", async () => (await specTop()) !== undefined, 8000);
    await sleep(1500); // the restore keeps trying while the content settles
    const after = (await specTop())!;
    // Not to the point: the hero, which is expanded again on the way back, moves the text under it
    // by about its collapse. Scrolled most of the way it was, rather than back at the top.
    if (!(start - after > (start - before) * 0.7)) throw new Error(`the spec reopened with its top at ${Math.round(after)}, not near ${Math.round(before)} where it was left (${Math.round(start)} unscrolled)`);
    const field = (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Message the agent")) as (AXNode & { AXValue?: string | null }) | undefined;
    if (!field?.AXValue?.toLowerCase().includes("kept")) throw new Error(`the composer reads "${field?.AXValue ?? ""}", not the draft`);
    if (shotsWanted) await shot(udid, "sheet-reopened-restored");
    await goto(udid, BOARD);
    return `scrolled ${Math.round(start - before)}pt, back at ${Math.round(start - after)}pt; draft kept`;
  });
}

/** Tickets of their own to dock, each with a title long enough to truncate in the dock. */
async function seedDockable(projectId: string, n: number): Promise<Ticket[]> {
  const out: Ticket[] = [];
  for (let i = 1; i <= n; i++)
    out.push(await api<Ticket>("POST", "/tickets", { projectId, spec: `Docked ticket ${i}: a title long enough that it has to truncate before the dock's buttons`, driver: "dummy", start: false }));
  return out;
}

/**
 * The iPhone's dock with several tickets (DockedCardsContainer in DockWindow): a second ticket joins
 * the dock as a second card rather than replacing it, the newest at the bottom with its ref and
 * title; tapping a card opens it (keeping its path and composer) and the other cards stay over the
 * sheet, with the composer above them; switching cards or docking never remounts the dock; three
 * show two cards and "1 more…", which expands into the list of all three, whose oldest (parked)
 * opens at its saved path; a card's ✕ closes only that ticket; the dock comes back after a
 * relaunch; Projects closes them all.
 */
async function dockStackChecks(udid: string, p: { project: Project; conductor: Ticket }) {
  selector.sequence("declared");
  const key = p.conductor.key;
  const kid = (await api<TicketDetail>("GET", `/tickets/${key}`)).children[0];
  if (!kid) throw new Error(`${key} has no children`);
  const extra = await seedDockable(p.project.id, 2);
  const b = extra[0]!;
  const { width: W, height: H } = (await tree(udid))[0]!.frame;
  const onChild = (l: string[]) => l.includes(`Part of ${key}`);
  const top = async () => topDock(await labels(udid));
  const count = async () => dockCount(await labels(udid));
  const say = async (what: string) => console.log(`    ${what}: ${(await labels(udid)).slice(0, 40).join(" | ")}`);
  /** `k`'s card. */
  const card = (k: string) => (l: string) => l.startsWith(`${k}, `) && isDock(l);
  /** A row in the title's menu for `k`, "<key> · <title>". */
  const row = (k: string) => (l: string) => l.startsWith(`${k} · `);
  const keyOf = (label: string) => label.split(",")[0]!;
  let composerBefore: AXNode["frame"] | null = null;
  // Each check but the first picks up the dock the one before left, so it needs that one (see check()).
  const JOINS = "a second ticket joins the dock as a second card, the newest at the bottom with its ref and title";
  const OVER = "with a ticket open and another docked, the card shows over the sheet and the composer sits above it";
  const MORE = "with 3 docked, two cards and \"1 more…\" expand into the list, whose oldest opens at its saved path";
  const CLOSE = "a card's ✕ closes only that ticket";
  const STABLE = "switching cards while a ticket is open keeps the dock mounted: only the swapped card changes";
  const PICKER = "a picker the ticket screen opens itself (not the Router) hides the dock over the sheet and gives it back on Done";
  const AWAY = "a swipe away from the presented sheet closes it and leaves the next as the docked card, no sheet";
  const RELAUNCH = "the dock comes back after the app is quit and relaunched";

  await check(JOINS, async () => {
    await goto(udid, BOARD);
    await undock(udid);
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=children`, (l) => l.some((x) => x.includes(kid.key)));
    await tapWhere(udid, (l) => l.includes(kid.key));
    moved(udid);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    composerBefore = (await findElement(udid, (x) => x === "Send"))?.frame ?? null;
    await dockSheet(udid);
    await barClearsDock(udid); // one card
    await goto(udid, `harness://ticket/${encodeURIComponent(b.key)}`, (l) => ticketShown(l, b.key));
    const label = await dockSheet(udid);
    if (label !== `${b.key}, ${b.title}, docked`) throw new Error(`the bottom card reads "${label}"`);
    const cards = (await nodes(udid)).filter((n) => n.AXLabel && isDock(n.AXLabel));
    if (cards.length !== 2 || !card(kid.key)(cards[0]!.AXLabel!)) throw new Error(`the cards read ${cards.map((n) => `"${n.AXLabel}"`).join(", ")}`);
    if (cards[1]!.frame.y <= cards[0]!.frame.y) throw new Error("the newest card isn't at the bottom");
    // Every card is in the dock window: all the same size, so their text is too.
    const [hTop, hBottom] = [cards[0]!.frame.height, cards[1]!.frame.height];
    if (Math.abs(hTop - hBottom) > 1) throw new Error(`the cards differ in height: ${hTop} over ${hBottom}`);
    // Docked it opens with a tap, not a drag: no grabber.
    const all = await nodes(udid);
    if (all.some((n) => n.AXLabel === "Sheet Grabber")) throw new Error("the docked sheet still shows its grabber");
    // The board's bottom bar rides above the whole stack: the topmost card, or "N more…" over it.
    const more = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-dock-more");
    const dockTop = Math.min(cards[0]!.frame.y, more?.frame.y ?? Infinity);
    const newSession = await findElement(udid, (x) => x === "New session");
    if (!newSession) throw new Error("no New session button on the board");
    await barClearsDock(udid, dockTop);
    // Every card shares the bar's left and right edges: Projects at its left end, New session at its right.
    const projects = await findElement(udid, (x) => x === "Projects");
    if (!projects) throw new Error("no Projects button on the board");
    const barLeft = projects.frame.x, barRight = newSession.frame.x + newSession.frame.width;
    // A card's accessibility frame stops short of its ✕ (the open button), whose capsule ends 10pt past it.
    const closes = (await nodes(udid)).filter((n) => n.AXUniqueId === "ticket-dock-close");
    for (const n of [...cards, ...(more ? [more] : [])]) {
      const x = closes.find((c) => c.frame.y >= n.frame.y && c.frame.y < n.frame.y + n.frame.height);
      const right = x ? x.frame.x + x.frame.width + 10 : n.frame.x + n.frame.width;
      if (Math.abs(n.frame.x - barLeft) > 2 || Math.abs(right - barRight) > 2)
        throw new Error(`"${n.AXLabel}" (${Math.round(n.frame.x)}–${Math.round(right)}) isn't as wide as the bar (${Math.round(barLeft)}–${Math.round(barRight)})`);
    }
    await shootBoth(udid, "dock-stack");
    await appearance(udid, "light");
    return `${keyOf(cards[0]!.AXLabel!)} over ${keyOf(label)}`;
  });
  await check(OVER, async () => {
    // Tapping the first card opens its ticket (the sheet check covers keeping its path and composer).
    await tapWhere(udid, card(kid.key));
    moved(udid);
    await until("the child again over the dock", async () => {
      const l = await labels(udid);
      return onChild(l) && l.includes("Sheet Grabber");
    }, 8000);
    // The ticket on screen is the sheet, not a card; the other one waits over it.
    const waiting = await until(`${b.key}'s card over the sheet`, async () => (await nodes(udid)).find((n) => n.AXLabel && card(b.key)(n.AXLabel)) ?? null, 5000).catch(async (e) => {
      await say("after opening the card");
      throw e;
    });
    if ((await labels(udid)).some((l) => card(kid.key)(l))) throw new Error(`${kid.key} is a card while it is the open sheet`);
    // The composer sits above the card with the board's gap (DockMetrics.barGap, 11pt) plus the
    // little the attach button sits in from its row's edge.
    const attach = await findElement(udid, (x) => x === "Attach");
    if (!attach) throw new Error("no composer in the sheet");
    const gap = waiting.frame.y - (attach.frame.y + attach.frame.height);
    if (gap < 8 || gap > 24) throw new Error(`the composer's attach button sits ${Math.round(gap)}pt above the dock card (expected about 11 plus its inset in the row)`);
    await shootBoth(udid, "dock-over-sheet");
    await appearance(udid, "light");
    return `${b.key}'s card over ${kid.key}'s sheet, composer ${Math.round(gap)}pt above it`;
  }, CHECK_CAP_MS, [JOINS]);
  await check(MORE, async () => {
    // b on top, so the conductor's sheet (with the child pushed) is the oldest.
    if (!(await top())?.startsWith(`${b.key}, `)) {
      await tapWhere(udid, card(b.key));
      moved(udid);
      await dockSheet(udid);
    }
    for (const t of extra.slice(1)) await goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => ticketShown(l, t.key));
    await dockSheet(udid);
    await until("two cards and 1 more", async () => {
      const l = await labels(udid);
      return l.filter(isDock).length === 2 && l.includes("1 more docked tickets");
    }, 5000).catch(async (e) => {
      await say("the dock");
      throw e;
    });
    await barClearsDock(udid); // three cards: two and "1 more…"
    await shot(udid, "dock-more-light");
    await tapWhere(udid, "1 more docked tickets");
    const listed = await until("the list of all three", async () => {
      const l = await labels(udid);
      const all = l.filter(isDock);
      return all.length === 3 ? all : null;
    }, 6000).catch(async (e) => {
      await say("after \"1 more\"");
      throw e;
    });
    await shot(udid, "dock-list-light");
    // The most recent at the bottom, as in the dock; the ticket opened first (b) is the oldest, the
    // conductor's sheet (with the child pushed) in between.
    if (!card(b.key)(listed[0]!) || !card(kid.key)(listed[1]!)) throw new Error(`the list reads ${listed.map((x) => `"${keyOf(x)}"`).join(", ")}, not ${b.key} then ${kid.key} first`);
    // It opens scrolled to the bottom: scroll up until the conductor's card is in view.
    const { height: Hs } = (await tree(udid))[0]!.frame;
    for (let i = 0; i < 3; i++) {
      const n = await findElement(udid, card(kid.key));
      if (n && n.frame.y > 60 && n.frame.y + n.frame.height < Hs - 20) break;
      await axe("swipe", "--start-x", String(Math.round(W / 2)), "--start-y", String(Math.round(Hs * 0.35)), "--end-x", String(Math.round(W / 2)), "--end-y", String(Math.round(Hs * 0.8)), "--duration", "0.5", "--udid", udid);
    }
    await tapWhere(udid, card(kid.key));
    moved(udid);
    await until("the child, mounted again at its path", async () => {
      const x = await labels(udid);
      return onChild(x) && x.includes("Sheet Grabber") && !x.some(card(kid.key));
    }, 10000).catch(async (e) => {
      await say(`after ${kid.key} from the list`);
      throw e;
    });
    return `2 cards and 1 more; the list of 3; ${kid.key} came back on its pushed screen`;
  }, CHECK_CAP_MS, [OVER]);
  await check(STABLE, async () => {
    // Kid's sheet is open and two tickets wait over it: tapping the lower card swaps it with the
    // sheet, so the upper card is the one that must not move, and the dock must not have mounted again.
    await atRest(udid, 1200); // the list that just closed has to be gone for the cards to be where they stay
    const cards = await until("two cards over the sheet", async () => {
      const found = (await nodes(udid)).filter((n) => n.AXLabel && isDock(n.AXLabel)).sort((x, y) => x.frame.y - y.frame.y);
      return found.length === 2 ? found : null;
    }, 6000);
    const [upper, lower] = [cards[0]!, cards[1]!];
    const sheetKey = keyOf(lower.AXLabel!);
    const was = (await labels(udid)).find((l) => l.startsWith("Part of ")) ? "the child" : "a ticket";
    await tapWhere(udid, (l) => l === lower.AXLabel);
    moved(udid);
    await until(`${sheetKey} open and the old sheet a card`, async () => {
      const l = await labels(udid);
      return l.includes("Sheet Grabber") && !l.some((x) => x === lower.AXLabel) && l.some((x) => x === upper.AXLabel) && l.filter(isDock).length === 2;
    }, 8000).catch(async (e) => {
      await say(`after tapping ${sheetKey}'s card`);
      throw e;
    });
    await atRest(udid, 800);
    const after = (await nodes(udid)).find((n) => n.AXLabel === upper.AXLabel);
    if (!after || Math.abs(after.frame.y - upper.frame.y) > 1) throw new Error(`the card that didn't change moved from ${Math.round(upper.frame.y)} to ${after ? Math.round(after.frame.y) : "(gone)"}`);
    const mounts = (await probe(udid))?.dockMounts;
    if (mounts !== 1) throw new Error(`the dock mounted ${mounts} times since launch, not once`);
    return `${sheetKey} swapped in over ${was}; the other card stayed at ${Math.round(upper.frame.y)}; one mount`;
  }, CHECK_CAP_MS, [MORE]);
  await check(PICKER, async () => {
    const isModels = (l: string) => l.startsWith("Models, ");
    await goto(udid, `harness://ticket/${encodeURIComponent(b.key)}?tab=details`, (l) => l.some(isModels));
    const n = await count();
    if (n < 1) throw new Error("no cards over the open ticket to hide");
    await tapWhere(udid, isModels);
    await until("the model sheet", async () => (await labels(udid)).includes("Search models"), 6000);
    await until("the dock hidden under the picker", async () => (await count()) === 0, 4000).catch(async (e) => {
      await say("with the model sheet open");
      throw e;
    });
    await tapWhere(udid, "Done");
    await until("the model sheet closed", async () => !(await labels(udid)).includes("Search models"), 5000);
    await until("the dock back", async () => (await count()) === n, 4000).catch(async (e) => {
      await say("after the model sheet closed");
      throw e;
    });
    return `${n} cards hid under the Models sheet and came back`;
  }, CHECK_CAP_MS, [STABLE]);
  await check(CLOSE, async () => {
    const before = await dockSheet(udid);
    const n = await count();
    await tapWhere(udid, `Close ${keyOf(before)}`);
    await until("the next one on top", async () => {
      const t = await top();
      return t && t !== before ? t : null;
    }, 6000);
    if ((await count()) !== n - 1) throw new Error(`${await count()} docked after ✕, not ${n - 1}`);
    return `${n} → ${n - 1}`;
  }, CHECK_CAP_MS, [PICKER]);
  await check(AWAY, async () => {
    // Open the top card's ticket, then swipe it away fast: the system dismissal closes it.
    const before = (await top())!;
    const n = await count();
    await tapWhere(udid, card(keyOf(before)));
    moved(udid);
    await until("the sheet up, its card gone", async () => {
      const l = await labels(udid);
      return l.includes("Sheet Grabber") && !l.some(card(keyOf(before)));
    }, 8000);
    const x = String(Math.round(W / 2));
    await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(H - 110)), "--duration", "0.1", "--delta", "100", "--udid", udid);
    const after = await until("the next card", async () => {
      const t = await top();
      return t && t !== before ? t : null;
    }, 8000).catch(async (e) => {
      await say("after the swipe away");
      throw e;
    });
    if ((await count()) !== n - 1) throw new Error(`${await count()} docked after the swipe away, not ${n - 1}`);
    if ((await labels(udid)).includes("Sheet Grabber")) throw new Error("a sheet is showing after the swipe away");
    // Put the closed ticket back on the dock for the checks that follow.
    const closed = keyOf(before);
    await goto(udid, `harness://ticket/${encodeURIComponent(closed)}`, (l) => ticketShown(l, closed));
    await dockSheet(udid);
    if ((await count()) !== n) throw new Error(`${await count()} docked after docking ${closed} again, not ${n}`);
    return `${keyOf(before)} closed, ${keyOf(after)} docked`;
  }, CHECK_CAP_MS, [CLOSE]);
  await check(RELAUNCH, async () => {
    const before = (await top())!;
    const n = await count();
    await simctl("terminate", udid, BUNDLE);
    await simctl("launch", udid, BUNDLE);
    const back = await whenShown(udid, undefined, (l) => onBoard(l) && l.some(isDock), 30000);
    if (!back) throw new Error("no board with a dock after the relaunch");
    const after = await until("the same top", async () => {
      const t = await top();
      return t === before ? t : null;
    }, 8000).catch(async (e) => {
      await say("after the relaunch");
      throw e;
    });
    if ((await count()) !== n) throw new Error(`${await count()} docked after the relaunch, not ${n}`);
    await barClearsDock(udid);
    lastUrl.set(udid, BOARD);
    await shot(udid, "dock-relaunched-light");
    return `${keyOf(after)} on top of ${n}`;
  }, CHECK_CAP_MS, [AWAY]);
  const PALETTE_BAR = "the bar keeps its place above the dock after the palette's keyboard comes and goes";
  await check(PALETTE_BAR, async () => {
    await tapWhere(udid, "Command palette");
    await until("the palette's field", async () => (await labels(udid)).some((x) => x.startsWith("New Session…")), 8000);
    await tapHeaderCancel(udid);
    await until("the palette closed", async () => (await probe(udid))?.router.sheet == null, 8000);
    await barClearsDock(udid);
    return "11pt above the card";
  }, CHECK_CAP_MS, [RELAUNCH]);
  await check("Projects closes every docked ticket", async () => {
    await tapWhere(udid, "Projects");
    await until("the Projects sheet", async () => (await labels(udid)).includes("Inbox"), 5000);
    await goto(udid, BOARD);
    if ((await labels(udid)).some(isDock)) throw new Error("a dock is still there after Projects");
    return "all closed";
  }, CHECK_CAP_MS, [PALETTE_BAR]);
}

/**
 * A file docks like a ticket (`TicketSheet.Root.file`): opened from a link it is its own card next
 * to the ticket's, a tap on a card (the iPhone's dock over the sheet, the iPad's corner stack)
 * switches between them, opening it again focuses the card it has, and its ✕ closes only it.
 */
async function fileDockChecks(udid: string, p: { project: Project; conductor: Ticket }, ipad: boolean) {
  selector.sequence("declared");
  const key = p.conductor.key;
  const link = `harness://file/${DOCK_FILE}?project=${encodeURIComponent(p.project.id)}`;
  const editorUp = async () => !!(await probe(udid))?.editor;
  const fileCard = (l: string) => l.startsWith(`${DOCK_FILE}, `) && isDock(l);
  const ticketCard = (l: string) => l.startsWith(`${key}, `) && isDock(l);
  const count = async () => dockCount(await labels(udid));
  const say = async (what: string) => console.log(`    ${what}: ${(await labels(udid)).slice(0, 40).join(" | ")}`);

  /** Types into the open file's editor until the unsaved dot shows (the page starts after the screen does). */
  const typeUnsaved = async (text: string) => {
    const dot = async () => (await labels(udid)).includes("Unsaved changes");
    let attempt = 0;
    await until("a keystroke in the editor marks the file unsaved", async () => {
      if (await dot()) return true;
      // The file is a few short lines, so only the editor's first rows take a tap: walk down from just under the info bar.
      // Under the info bar's Save button, in the editor's own column (the iPad's is the panel).
      const save = await findElement(udid, (l) => l === "Save");
      const x = save ? Math.round(save.frame.x + 20) : 200;
      const y = (save ? Math.round(save.frame.y + save.frame.height) : 160) + 30 + 30 * (attempt++ % 5);
      await axe("tap", "-x", String(x), "-y", String(y), "--udid", udid);
      await axe("type", text, "--udid", udid);
      // The editor's own dirty flag flips first, then the app's unsaved dot follows.
      await probeUntil(udid, "the editor dirty", (x) => x.editor?.dirty === true, 1500).catch(() => {});
      return until("the unsaved dot", dot, 1500, 100).catch(() => false);
    }, 20000, 250);
  };
  // Checks that pick up the cards the first ones left name them in `needs` (see check()); the rest start with their own goto.
  const OPENED = "a file opened from a link is its own card next to the ticket's";
  const SWITCH = "tapping the ticket's card and the file's card switches between them";
  const RELINK = "linking other lines of the docked file scrolls its editor there";
  await check(OPENED, async () => {
    await goto(udid, BOARD);
    if (ipad) {
      // The corner cards and the panel each have a ✕: close them until none is left.
      for (let i = 0; i < 20 && (await labels(udid)).some((l) => l.startsWith("Close ") && l !== "Close"); i++) {
        await tapWhere(udid, (l) => l.startsWith("Close ") && l !== "Close");
        moved(udid);
        await atRest(udid, 400);
      }
    } else {
      await undock(udid);
    }
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=children`, (l) => l.includes("Tickets") && l.includes("Message the agent"));
    await goto(udid, link);
    await until("the editor", editorUp, 12000);
    if (ipad) {
      await until("the ticket as a card and the file in the panel", async () => {
        const l = await labels(udid);
        return l.some(ticketCard) && l.includes(`Close ${DOCK_FILE}`);
      }, 8000).catch(async (e) => {
        await say("after the file link");
        throw e;
      });
      await shot(udid, "file-dock-ipad-light", true);
    } else {
      const label = await dockSheet(udid);
      if (!label.startsWith(`${DOCK_FILE}, `)) throw new Error(`the bottom card reads "${label}"`);
      if ((await count()) !== 2) throw new Error(`${await count()} docked, expected the file and the ticket`);
      await shot(udid, "file-dock-light", true);
    }
    return `${DOCK_FILE} and ${key} docked`;
  });
  await check(SWITCH, async () => {
    if (ipad) {
      await tapWhere(udid, ticketCard);
      await until("the ticket in the panel", async () => (await labels(udid)).includes(`Close ${key}`), 8000);
      await tapWhere(udid, fileCard);
      await until("the file in the panel", async () => (await labels(udid)).includes(`Close ${DOCK_FILE}`) && (await editorUp()), 8000);
      return "ticket ↔ file";
    }
    // The sheet stays up and the other ticket waits as a card over it.
    const sheetUp = (l: string[]) => l.includes("Sheet Grabber");
    await tapWhere(udid, ticketCard);
    await until("the ticket in the sheet, the file a card", async () => {
      const l = await labels(udid);
      return sheetUp(l) && !l.some(ticketCard) && l.some(fileCard);
    }, 8000).catch(async (e) => {
      await say("after the ticket's card");
      throw e;
    });
    await tapWhere(udid, fileCard);
    await until("the file in the sheet, the ticket a card", async () => {
      const l = await labels(udid);
      return sheetUp(l) && !l.some(fileCard) && l.some(ticketCard) && (await editorUp());
    }, 8000);
    return "file ↔ ticket over the sheet";
  }, CHECK_CAP_MS, [OPENED]);
  await check("opening the docked file again focuses it instead of adding a card", async () => {
    await goto(udid, link);
    await until("the editor", editorUp, 12000);
    if (!ipad) await dockSheet(udid);
    // The iPad's panel shows the file, so only the ticket is a card there.
    const expected = ipad ? 1 : 2;
    if ((await count()) !== expected) throw new Error(`${await count()} docked after a second open, expected ${expected}`);
    return "no second card";
  }, CHECK_CAP_MS, [OPENED]);
  await check(RELINK, async () => {
    const marked = async () => (await probe(udid))?.editor?.markedLines ?? [];
    await goto(udid, `${link}#L3`);
    await until("the editor", editorUp, 12000);
    await probeUntil(udid, "the new lines marked in the open editor", (s) => s.editor?.markedLines.length === 1 && s.editor.markedLines[0]!.includes("line three")).catch(async (e) => {
      await say(`marked ${JSON.stringify(await marked())}`);
      await shot(udid, "file-reveal-failed", true);
      throw e;
    });
    await atRest(udid, 600);
    await shot(udid, "file-reveal-line-three", true);
    await goto(udid, `${link}#L4-L4`);
    await probeUntil(udid, "the next link's lines marked", (s) => s.editor?.markedLines.length === 1 && s.editor.markedLines[0]!.includes("line four"));
    if (!ipad) await dockSheet(udid);
    const expected = ipad ? 1 : 2;
    if ((await count()) !== expected) throw new Error(`${await count()} docked after relinking lines, expected ${expected}`);
    return "line three, then line four, same card";
  }, CHECK_CAP_MS, [OPENED]);
  await check("a dirty file card's Close asks, and Discard closes the card", async () => {
    const dot = async () => (await labels(udid)).includes("Unsaved changes");
    // The iPhone left the file docked at the bottom card: bring it up.
    if (!ipad) {
      await tapWhere(udid, fileCard);
      await until("the editor", editorUp, 8000);
      await atRest(udid, 1500);
    }
    await typeUnsaved("qzd");
    await atRest(udid, 1500);
    await shot(udid, "file-card-dirty-close", true);
    if (ipad) {
      // The panel's ✕ asks through the same dialog the card's Close does.
      await tapWhere(udid, `Close ${DOCK_FILE}`);
    } else {
      // The toolbar's glass buttons aren't in the accessibility list: tap the leading one by position.
      await axe("tap", "-x", "38", "-y", "100", "--udid", udid);
    }
    await until("the save dialog", async () => (await labels(udid)).includes("Discard changes"), 5000).catch(async (e) => {
      await say("after Close");
      await shot(udid, "file-card-close-failed", true);
      throw e;
    });
    await tapWhere(udid, "Discard changes");
    await until("the file card gone", async () => {
      const l = await labels(udid);
      return !l.some(fileCard) && !l.includes(`Close ${DOCK_FILE}`);
    }, 8000);
    await sleep(1500);
    if (readFileSync(join(scratch, "sheets", DOCK_FILE), "utf8").includes("qzd")) throw new Error("Discard saved the edit to the file");
    return "Close → Discard closed the card, and the file is as it was";
  }, CHECK_CAP_MS, [RELINK]);
  await check("a failed save as a file card closes keeps the edits: the card comes back with them and Save retries", async () => {
    const dir = join(scratch, "sheets");
    const onDisk = () => readFileSync(join(dir, DOCK_FILE), "utf8");
    await api("PATCH", "/settings", { saveOnBlur: true });
    moved(udid);
    await goto(udid, BOARD);
    await goto(udid, link);
    await until("the editor", editorUp, 12000);
    await atRest(udid, 1500);
    // A folder the service can't create the temporary file in: every write fails.
    chmodSync(dir, 0o555);
    try {
      await typeUnsaved("qzk");
      if (!ipad) await dockSheet(udid);
      await tapWhere(udid, `Close ${DOCK_FILE}`);
      // The card closed with a write that failed: it comes back, holding the edits and the failure.
      await until("the card back with its edits and the failure", async () => {
        const l = await labels(udid);
        return l.some((x) => x.startsWith("Save failed")) && l.includes("Save") ? true : null;
      }, 15000).catch(async (e) => {
        await say("after Close with a failing write");
        await shot(udid, "file-card-failed-save", true);
        throw e;
      });
      await shot(udid, "file-card-failed-save", true);
      if (onDisk().includes("qzk")) throw new Error("the failing write reached the disk");
    } finally {
      chmodSync(dir, 0o755);
    }
    await tapWhere(udid, "Save");
    await until("the edits written", async () => (onDisk().includes("qzk") ? true : null), 10000);
    await api("PATCH", "/settings", { saveOnBlur: false });
    return "Close with a failing write → card back with the edits → Save wrote them";
  });
  await check("a file card's ✕ closes only it", async () => {
    // The dirty check closed the file with taps: the same link again needs the board in between to land.
    moved(udid);
    await goto(udid, BOARD);
    await goto(udid, link);
    await until("the editor", editorUp, 12000).catch(async (e) => {
      await say("after reopening the closed file");
      await shot(udid, "file-card-reopen-failed", true);
      throw e;
    });
    if (!ipad) await dockSheet(udid);
    await tapWhere(udid, `Close ${DOCK_FILE}`);
    await until("only the ticket left", async () => {
      const l = await labels(udid);
      return !l.some(fileCard) && !l.includes(`Close ${DOCK_FILE}`);
    }, 8000);
    return "the file closed, the ticket stays";
  });
}

/**
 * --memory: 20 docked tickets keep at most 5 mounted (RouterSheetTests' liveSheets case has the
 * rule), so the app's footprint with 20 docked barely grows past 5. Slow (it reads the process's
 * footprint three times), so only `--memory` runs it.
 */
async function memoryChecks(udid: string, p: { project: Project }) {
  selector.sequence();
  const count = async () => dockCount(await labels(udid));
  await check("past the five live ones, more docked tickets cost about nothing", async () => {
    // A parked ticket is the Router's root and path plus the board's card: 15 more of them must not
    // grow the app the way 15 more mounted ticket screens would.
    const many = await seedDockable(p.project.id, 20);
    const pid = (await sh(["pgrep", "-f", `${udid}/.*/Harness\\.app/Harness`], { allowFail: true, quiet: true })).trim().split("\n")[0];
    if (!pid) throw new Error("no Harness process for this simulator");
    const footprint = async () => {
      await sleep(2500); // the last screen settles and parks
      const out = await sh(["footprint", "-p", pid], { allowFail: true, quiet: true });
      const m = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
      if (!m) throw new Error(`footprint said: ${out.slice(0, 200)}`);
      return Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>)[m[2]!]!;
    };
    const open = async (ts: Ticket[]) => {
      for (const t of ts) await goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => ticketShown(l, t.key));
    };
    const closeAll = async () => {
      await goto(udid, BOARD);
      await tapWhere(udid, "Projects");
      await until("the Projects sheet", async () => (await labels(udid)).includes("Inbox"), 5000);
      await goto(udid, BOARD);
    };
    await goto(udid, BOARD);
    const none = await footprint();
    await open(many.slice(0, 5));
    await dockSheet(udid);
    const five = await footprint();
    await tapWhere(udid, isDock);
    await open(many.slice(5));
    await dockSheet(udid);
    const twenty = await footprint();
    if ((await count()) !== 20) throw new Error(`${await count()} docked, not 20`);
    await closeAll();
    const live = five - none;
    const parked = twenty - five;
    const sizes = `${none.toFixed(1)} MB with none docked, ${five.toFixed(1)} with 5 (+${live.toFixed(1)}), ${twenty.toFixed(1)} with 20 (+${parked.toFixed(1)} more)`;
    // Fifteen parked tickets must cost well under what five mounted ones do.
    if (parked > Math.max(10, live)) throw new Error(`15 parked tickets cost ${parked.toFixed(1)} MB, as much as 5 mounted ones (${sizes})`);
    return sizes;
  });
}

/**
 * `k`'s iPad card is on screen in the bottom-right corner of the area left of `edge`: near its right
 * edge and its bottom, and wider than a sliver. The exact margins and widths are DockMetricsTests'.
 */
async function cardInCorner(udid: string, k: string, edge: number, H: number, left = 0) {
  const all = await nodes(udid);
  const open = all.find((n) => n.AXLabel?.startsWith(`${k}, `) && isDock(n.AXLabel));
  const close = all.find((n) => n.AXLabel === `Close ${k}`);
  if (!open || !close) throw new Error(`no card for ${k}`);
  const right = close.frame.x + close.frame.width;
  if (right > edge || edge - right > 60) throw new Error(`${k}'s card ends at x=${Math.round(right)}, not near the corner at ${Math.round(edge)}`);
  const below = H - (open.frame.y + open.frame.height);
  if (below < 0 || below > 90) throw new Error(`${k}'s card's bottom is ${Math.round(below)}pt above the window's bottom`);
  if (right - open.frame.x < Math.min(200, edge - left - 40)) throw new Error(`${k}'s card is only ${Math.round(right - open.frame.x)}pt wide`);
}

/**
 * The iPad's docked tickets as cards (DockedCardStack): opened one after another, the ones behind
 * the panel wait as cards just left of it, never over the sidebar (one "N docked…" card where the
 * board's column is narrow, none where there's no column); docked, every one is a card in the
 * bottom-right corner, newest at the bottom, showing its ref and title; a tap opens that one; its ✕
 * closes just it. How many cards fit and when they collapse are DockMetricsTests'.
 */
async function cardStackChecks(udid: string, s: { project: Project; conductor: Ticket }) {
  selector.sequence();
  const ts = await seedDockable(s.project.id, 3);
  const panelOn = (l: string[], k: string) => l.includes(RESIZE) && l.includes(`Close ${k}`);
  const cards = async () => (await nodes(udid)).filter((n) => n.AXLabel && isDock(n.AXLabel));
  const cardOf = (k: string) => (l: string) => l.startsWith(`${k}, `) && isDock(l);
  const say = async (what: string) => console.log(`    ${what}: ${(await labels(udid)).slice(0, 60).join(" | ")}`);
  const open = (t: Ticket) => goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => panelOn(l, t.key));
  const [a, b, c] = [ts[0]!, ts[1]!, ts[2]!];

  /** The sidebar's Settings button: the cards must never cover it. */
  const settings = async () => {
    const n = (await nodes(udid)).find((x) => x.AXLabel === "Settings" && x.frame.x < 300);
    if (!n) throw new Error("no Settings button in the sidebar");
    return n;
  };
  /** Every card (and "N more…") sits right of the sidebar, clear of its Settings button. */
  const offSidebar = async () => {
    const s = await settings();
    const right = s.frame.x + s.frame.width;
    const all = (await nodes(udid)).filter((n) => n.AXLabel && (isDock(n.AXLabel) || /^\d+ (more )?docked tickets$/.test(n.AXLabel)));
    const over = all.filter((n) => n.frame.x < right);
    if (over.length) throw new Error(`over the sidebar: ${over.map((n) => `"${n.AXLabel}" at x=${Math.round(n.frame.x)}`).join(", ")}`);
    return all;
  };

  await check("the tickets behind the panel wait as cards just left of it, never over the sidebar", async () => {
    await goto(udid, BOARD);
    for (const t of [a, b, c]) await open(t);
    // The default panel (80%) leaves no board column beside it: nothing over the sidebar.
    const wide = await offSidebar();
    // A narrow panel leaves room for full cards in the board's column. How many fit, and the
    // collapsed and no-column cases, are DockMetricsTests'.
    const { W } = await panelFraction(udid);
    await dragPanelEdge(udid, W - 20);
    const { leading, H } = await panelFraction(udid);
    await until("the cards beside the panel", async () => (await cards()).length === 2, 4000).catch(async (e) => {
      await say("with the panel at 25%");
      throw e;
    });
    const cs = await cards();
    if (cs.map((n) => n.AXLabel).sort().join("|") !== [a, b].map((t) => `${t.key}, ${t.title}, docked`).sort().join("|"))
      throw new Error(`the cards read ${cs.map((n) => `"${n.AXLabel}"`).join(", ")}`);
    // Newest at the bottom: b under a.
    const [ca, cb] = [cs.find((n) => cardOf(a.key)(n.AXLabel!))!, cs.find((n) => cardOf(b.key)(n.AXLabel!))!];
    if (cb.frame.y <= ca.frame.y) throw new Error(`${b.key}'s card (y=${Math.round(cb.frame.y)}) isn't under ${a.key}'s (y=${Math.round(ca.frame.y)})`);
    // The sidebar's edge: its Settings button keeps 14pt of padding on its right.
    const s0 = await settings();
    await cardInCorner(udid, b.key, leading, H, s0.frame.x + s0.frame.width + 14);
    await offSidebar();
    await shootBoth(udid, "panel-cards-open");
    await appearance(udid, "light");
    // And Settings still takes a tap through the cards' column.
    await tapWhere(udid, "Settings");
    moved(udid);
    await until("Settings", async () => (await labels(udid)).some((l) => l.startsWith("Rotate token")), 6000).catch(async (e) => {
      await say("after a tap on Settings");
      throw e;
    });
    // Back to the board (the section link docked the panel), the panel on c, still narrow.
    await goto(udid, BOARD);
    await tapWhere(udid, cardOf(c.key));
    moved(udid);
    await until(`the panel on ${c.key}`, async () => panelOn(await labels(udid), c.key), 8000);
    return `none over the sidebar at 80% (${wide.length} shown); ${a.key} over ${b.key} left of the panel at 25%; Settings tapped`;
  });
  await check("docked, every ticket is a card in the bottom-right corner; a tap opens that one", async () => {
    await tapWhere(udid, `Dock ${c.key}`);
    await until("three cards", async () => (await cards()).length === 3 && !(await labels(udid)).includes(RESIZE), 6000);
    const { width: W, height: H } = (await tree(udid))[0]!.frame;
    const cs = await cards();
    const bottom = cs.reduce((x, y) => (y.frame.y > x.frame.y ? y : x));
    if (!cardOf(c.key)(bottom.AXLabel!)) throw new Error(`the bottom card is "${bottom.AXLabel}", not the newest (${c.key})`);
    await cardInCorner(udid, c.key, W, H);
    await shootBoth(udid, "panel-cards-docked");
    await appearance(udid, "light");
    await tapWhere(udid, cardOf(a.key));
    moved(udid);
    await until(`the panel on ${a.key}`, async () => panelOn(await labels(udid), a.key), 8000);
    // The panel keeps the narrow width the last check gave it, so the other two wait beside it.
    const left = await until("the other two beside the panel", async () => {
      const x = (await cards()).map((n) => n.AXLabel!.split(",")[0]).sort();
      return x.length === 2 ? x : null;
    }, 4000);
    if (left.join() !== [b.key, c.key].sort().join()) throw new Error(`the cards beside the panel are ${left.join(", ")}`);
    return `${c.key} at the bottom; ${a.key} opened, ${left.join(" and ")} beside it`;
  });
}

/** The iPad's side panel: its resize handle, the leading edge's centre, is up. */
const RESIZE = "Resize panel";
/** The panel's width as a fraction of the window: from its handle, which straddles its leading edge. */
async function panelFraction(udid: string): Promise<{ fraction: number; leading: number; W: number; H: number }> {
  const all = await nodes(udid);
  const { width: W, height: H } = all[0]!.frame;
  const handle = all.find((n) => n.AXLabel === RESIZE);
  if (!handle) throw new Error("no panel (its resize handle isn't on screen)");
  const leading = handle.frame.x + handle.frame.width / 2;
  return { fraction: (W - leading) / W, leading, W, H };
}
const pct = (f: number) => `${Math.round(f * 100)}%`;
/**
 * Drags the panel's resize handle to `toX`, slowly, and waits for the width to settle. Returns the
 * fraction it settled at.
 */
async function dragPanelEdge(udid: string, toX: number): Promise<number> {
  const handle = await until("the resize handle", () => findElement(udid, (l) => l === RESIZE), 6000);
  const x = Math.round(handle.frame.x + handle.frame.width / 2);
  // Off the handle's vertical centre (its capsule), but well inside its full-height hit area.
  const y = String(Math.round(handle.frame.y + handle.frame.height * 0.4));
  await axe("swipe", "--start-x", String(x), "--start-y", y, "--end-x", String(Math.round(toX)), "--end-y", y, "--duration", "1.0", "--udid", udid);
  // The width has settled when two reads agree.
  let last = -1;
  return until("the panel width to settle", async () => {
    const f = (await panelFraction(udid)).fraction;
    const settled = Math.abs(f - last) < 0.002;
    last = f;
    return settled ? f : null;
  }, 6000, 0);
}

/**
 * The iPad's ticket side panel (TicketSidePanel, regular width): a board card opens it against the
 * trailing edge at TicketPanelWidth's default; its leading handle resizes it within 25–80% of the
 * window; the dock button stashes it
 * as a card in the bottom-right corner, which restores it with its path, and a card's ✕ closes it;
 * New session opens in it with one header and asks Discard or Save over a draft; and the pop-out
 * button moves its ticket into a window of its own.
 */
async function panelChecks(udid: string, s: { project: Project; conductor: Ticket }) {
  selector.sequence();
  const key = s.conductor.key;
  const kid = (await api<TicketDetail>("GET", `/tickets/${key}`)).children[0];
  if (!kid) throw new Error(`${key} has no children`);
  // A top-level ticket of its own whose card replaces the panel's ticket, in Planning by the conductor.
  const other = await api<Ticket>("POST", "/tickets", { projectId: s.project.id, spec: "Replace the panel's ticket", driver: "dummy", start: false });
  const card = (k: string) => (l: string) => l.startsWith(`${k} `);
  const say = async (what: string) => console.log(`    ${what}: ${(await labels(udid)).slice(0, 60).join(" | ")}`);
  /** The panel is up on `k`: its close button names the ticket on top. */
  const panelOn = (l: string[], k: string) => l.includes(RESIZE) && l.includes(`Close ${k}`);
  /** Where the panel's navigation bar keeps Back (or a screen's own ✕), in points. */
  const backPoint = async () => {
    const { leading } = await panelFraction(udid);
    const close = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-panel-close");
    if (!close) throw new Error("no close button in the panel");
    return { x: leading + 29, y: close.frame.y + close.frame.height / 2 };
  };
  /**
   * Taps where a pushed ticket's hero draws Back, 29pt in from the panel's leading edge and level
   * with the panel's floating buttons (it's also the `ticket-back` button, but a tap by position
   * shows at the root that nothing is there).
   */
  const tapBack = async () => {
    const { x, y } = await backPoint();
    await axe("tap", "-x", String(Math.round(x)), "-y", String(Math.round(y)), "--udid", udid);
    moved(udid);
  };
  /** The panel's ticket screen went back to `k`: Back was there. */
  const backTo = async (k: string) => {
    // A tap during the restore animation can miss, so tap again until the pushed ticket's Back is gone.
    await until(`Back to ${k}`, async () => {
      const back = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-back");
      if (panelOn(await labels(udid), k) && !back) return true;
      if (back) {
        await axe("tap", "-x", String(Math.round(back.frame.x + back.frame.width / 2)), "-y", String(Math.round(back.frame.y + back.frame.height / 2)), "--udid", udid);
        moved(udid);
      } else await tapBack();
      await atRest(udid, 800);
      return false;
    }, 12000, 0).catch(async (e) => {
      await say("after a tap on Back");
      throw e;
    });
  };
  const closePanel = async () => {
    const l = await labels(udid);
    const close = l.find((x) => x.startsWith("Close ") && l.includes(RESIZE));
    if (close) await tapWhere(udid, close);
    const dock = l.find(isDock);
    if (dock && !close) await tapWhere(udid, `Close ${dock.split(",")[0]}`);
    await until("no panel", async () => {
      const x = await labels(udid);
      return !x.includes(RESIZE) && !x.some(isDock);
    }, 6000);
    moved(udid);
  };
  /** Taps `k`'s board card where it's on screen left of the panel (or anywhere, with no panel). */
  const tapCard = async (k: string) => {
    const panel = await panelFraction(udid).catch(() => null);
    const edge = panel ? panel.leading - 16 : Infinity;
    const el = await until(`${k}'s card left of the panel`, async () => {
      const n = await findElement(udid, card(k));
      return n && n.frame.x >= 0 && n.frame.x + 20 < edge ? n : null;
    }, 6000);
    const x = Math.min(el.frame.x + el.frame.width / 2, (el.frame.x + edge) / 2);
    await axe("tap", "-x", String(Math.round(x)), "-y", String(Math.round(el.frame.y + Math.min(30, el.frame.height / 2))), "--udid", udid);
    moved(udid);
  };
  /** Pages the board's columns until `k`'s card is fully on screen (left of `edge`). */
  const cardOnScreen = async (k: string, edge = Infinity) => {
    const status = (await ticketOf(k)).status;
    const column = { planning: "Planning", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" }[status as string] ?? "Planning";
    await until(`${k}'s card on screen`, async () => {
      const n = await findElement(udid, card(k));
      if (n && n.frame.x >= 0 && n.frame.x + 20 < edge) return true;
      await tapWhere(udid, (l) => l.startsWith(`${column},`)).catch(() => {});
      await atRest(udid, 600);
      return false;
    }, 12000, 0);
  };

  await check("a board card opens its ticket in the side panel against the trailing edge", async () => {
    await goto(udid, BOARD);
    await cardOnScreen(key);
    await tapCard(key);
    await until("the panel", async () => panelOn(await labels(udid), key), 8000).catch(async (e) => {
      await say("after the card tap");
      throw e;
    });
    // Wait out the slide in: the handle stops moving.
    let slid = -1;
    await until("the panel to stop sliding", async () => {
      const f = (await panelFraction(udid)).leading;
      const done = Math.abs(f - slid) < 1;
      slid = f;
      return done;
    }, 4000, 0);
    const { fraction, leading, W } = await panelFraction(udid);
    if (fraction < 0.25 - 0.01 || fraction > 0.8 + 0.01) throw new Error(`the panel is ${pct(fraction)} of the window`);
    // The default width itself is TicketPanelWidthTests'; here the panel just has to sit in range.
    // Trailing-aligned: its close button sits at the window's right edge.
    const close = await findElement(udid, (l) => l === `Close ${key}`);
    if (!close || W - (close.frame.x + close.frame.width) > 16) throw new Error(`the close button ends at ${close ? Math.round(close.frame.x + close.frame.width) : "?"}, not the window's edge (${W})`);
    // The board stays live to its left.
    if (!onBoard(await labels(udid))) throw new Error("the board isn't showing beside the panel");
    // Below the status bar: no higher than the split view's own top bar, which keeps the safe area.
    const toggle = await findElement(udid, (l) => l === "Hide Sidebar" || l === "Show Sidebar");
    if (toggle && close.frame.y < toggle.frame.y - 4) throw new Error(`the title bar's buttons start at y=${Math.round(close.frame.y)}, above the sidebar button (y=${Math.round(toggle.frame.y)})`);
    // The hero names the ticket: its key label when expanded, its title row when collapsed (a conductor
    // opens on Tickets). The root ticket has no navigation bar, and no title bar above the hero.
    const inPanel = (await nodes(udid)).filter((n) => n.frame.x >= leading && n.AXLabel);
    const title = s.conductor.title;
    const named = inPanel.filter((n) => n.AXLabel === key || n.AXLabel === title || n.AXLabel!.startsWith(`${key},`) || n.AXLabel!.startsWith(`${key} ·`));
    // An expanded hero shows both its title and, in the badge row, the key: still the hero alone.
    const bar = named.filter((n) => n.frame.y < 60 && n.AXLabel !== title && n.AXLabel !== key);
    if (named.length < 1 || named.length > 2 || bar.length) throw new Error(`${named.length} labels in the panel name ${key}: ${named.map((n) => `"${n.AXLabel}" at y=${Math.round(n.frame.y)}`).join(", ")}`);
    // The panel's background runs up behind the status bar: its left part (the clock and battery
    // sit at the corners' far ends) is the panel's own colour, with the buttons still where they were.
    const strip = await grayIn(udid, { x: leading + 40, y: 2, width: 120, height: 10 }, W);
    const body = await grayIn(udid, { x: leading + 40, y: close.frame.y + close.frame.height + 4, width: 120, height: 6 }, W);
    if (Math.abs(strip - body) > 6) throw new Error(`the status bar above the panel is gray ${strip}, the panel's body ${body}`);
    await shootBoth(udid, "panel-default");
    await appearance(udid, "light");
    return `${key} at ${pct(fraction)} (${Math.round(W - leading)} of ${W} pt), header "${named[0]!.AXLabel}"`;
  });
  await check("a collapsed hero sits tight above the tab strip, below the panel's buttons", async () => {
    const { leading, W } = await panelFraction(udid);
    const close = await findElement(udid, (l) => l === `Close ${key}`);
    if (!close) throw new Error("no close button");
    const buttonsEnd = close.frame.y + close.frame.height;
    const inPanel = async () => (await nodes(udid)).filter((n) => n.frame.x >= leading && n.frame.x < W && n.AXLabel);
    const titleOf = async () => (await inPanel()).find((n) => n.frame.x < W && n.AXLabel!.startsWith(`${s.conductor.title}, `) && n.frame.y < 160);
    const strip = async () => (await inPanel()).filter((n) => ["Spec", "Activity", "Tickets", "Transcript"].includes(n.AXLabel!.split(",")[0]!)).sort((p, q) => p.frame.y - q.frame.y)[0];
    let t = await titleOf();
    if (!t) throw new Error(`no title in the panel: ${(await inPanel()).slice(0, 12).map((n) => n.AXLabel).join(" | ")}`);
    // Toggle by tapping the title until the hero is collapsed (it starts collapsed or expanded by the ticket's state).
    const start = (await strip())?.frame.y ?? 0;
    await axe("tap", "-x", String(Math.round(t.frame.x + 20)), "-y", String(Math.round(t.frame.y + t.frame.height / 2)), "--udid", udid);
    await atRest(udid, 900);
    const other = (await strip())?.frame.y ?? 0;
    const collapsedAt = Math.min(start, other);
    if (other === start) throw new Error(`tapping the title (${t.AXLabel}) didn't move the tab strip (y=${start})`);
    if (other > start) {
      // It had been collapsed; it's expanded now. Tap back.
      t = (await titleOf())!;
      await axe("tap", "-x", String(Math.round(t.frame.x + 20)), "-y", String(Math.round(t.frame.y + t.frame.height / 2)), "--udid", udid);
      await atRest(udid, 900);
    }
    t = (await titleOf())!;
    const tabs = (await strip())!;
    const gap = tabs.frame.y - (t.frame.y + t.frame.height);
    if (Math.abs(tabs.frame.y - collapsedAt) > 2) throw new Error("the collapsed strip moved");
    if (gap > 14 || tabs.frame.y < buttonsEnd) throw new Error(`collapsed, the tab strip starts ${Math.round(gap)}pt below the title row (title y=${Math.round(t.frame.y)}+${Math.round(t.frame.height)}, buttons end ${Math.round(buttonsEnd)}, strip y=${Math.round(tabs.frame.y)})`);
    await shootBoth(udid, "panel-collapsed");
    await appearance(udid, "light");
    return `strip ${Math.round(gap)}pt below the title row, ${Math.round(tabs.frame.y - buttonsEnd)}pt below the buttons (W ${W})`;
  });
  await check("New session opens in the side panel with one header; with a draft typed, ✕ and Escape ask Discard or Save", async () => {
    const words = "Throw this panel draft away";
    const ours = (l: string) => l.includes(words);
    await goto(udid, `harness://new?projectId=${encodeURIComponent(s.project.id)}`, (l) => l.some(isOptions) && panelOn(l, "New session"));
    const l0 = await labels(udid);
    if (l0.includes("Open New session in a new window")) throw new Error("New session offers a pop-out");
    // One header: the panel's title bar names it and closes it, so New session's own bar has
    // neither its title nor its ✕ (Cancel). AXe may leave glass header items out, so also look.
    const { leading, W } = await panelFraction(udid);
    const inPanel = (await nodes(udid)).filter((n) => n.frame.x >= leading && n.AXLabel);
    const titles = inPanel.filter((n) => n.AXLabel === "New session").length;
    const closes = inPanel.filter((n) => n.AXLabel === "Cancel" || n.AXLabel!.startsWith("Close ")).length;
    if (titles > 1) throw new Error(`${titles} "New session" titles in the panel`);
    if (closes > 1) throw new Error(`${closes} close buttons in the panel`);
    const bar = await backPoint();
    if (!landscape) {
      // The middle of New session's bar, where the system draws its title: blank.
      const centre = leading + (W - leading) / 2;
      const ink = await inkIn(udid, { x: centre - 70, y: bar.y - 12, width: 140, height: 24 }, W);
      if (ink > 20) throw new Error(`a title in New session's bar under the panel's (${ink} pixels of ink)`);
    }
    // Where its ✕ would sit: a tap there leaves the panel up (an empty New session's Cancel closes at once).
    await tapBack();
    await sleep(1500); // nothing should happen, so there's no state to wait for: a dock or close lands within this
    if (!panelOn(await labels(udid), "New session")) throw new Error("a second ✕ in New session's bar closed the panel");
    // The prompt has focus as New session opens; typing saves a draft, whose card the board lists.
    await axe("type", words, "--udid", udid);
    await until("the draft's card", async () => (await labels(udid)).some((l) => ours(l) && l.endsWith(", draft")), 10000).catch(async (e) => {
      await say("after typing");
      throw e;
    });
    const asking = (l: string[]) => l.includes("Discard draft") && l.includes("Save draft");
    // Escape asks too, and Keep editing leaves it as it was.
    await axe("key", "41", "--udid", udid);
    await until("Escape's Discard or Save", async () => asking(await labels(udid)), 5000);
    await tapWhere(udid, "Keep editing");
    await until("still on New session", async () => {
      const l = await labels(udid);
      return !asking(l) && panelOn(l, "New session");
    }, 5000);
    // The landscape-only build's keyboard covers the title bar: Escape again there.
    if (landscape) await axe("key", "41", "--udid", udid);
    else await tapWhere(udid, "Close New session");
    await until("the ✕'s Discard or Save", async () => asking(await labels(udid)), 5000).catch(async (e) => {
      await say("after the panel's ✕");
      throw e;
    });
    await shot(udid, "panel-new-session-ask-light");
    await tapWhere(udid, "Discard draft");
    await until("the panel gone, and the draft", async () => {
      const l = await labels(udid);
      return !l.includes(RESIZE) && !l.some(ours);
    }, 8000).catch(async (e) => {
      await say("after Discard draft");
      throw e;
    });
    moved(udid);
    // Discard leaves nothing behind: no docked "New session", no draft card. (The ticket whose
    // panel New session pushed aside stays docked, as it should.)
    await atRest(udid, 800);
    const after = await labels(udid);
    const left = after.filter((x) => ours(x) || (isDock(x) && x.startsWith("New session")));
    if (left.length) {
      await say("after Discard draft, settled");
      throw new Error(`Discard left ${left.join(" | ")}`);
    }
    return `one title and one ✕, no pop-out; asked on Escape and on the panel's ✕${landscape ? " (Escape, in landscape)" : ""}; Discard closed it and its card went`;
  });
  await check("dragging the panel's edge resizes it, stopping at 25% and 80% of the window", async () => {
    // One drag past the left edge: TicketPanelWidthTests has both clamps, this confirms the handle follows a finger.
    // New session's check closed the panel: open the conductor's again.
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}`, (l) => panelOn(l, key));
    // The panel opens at its default; dragging toward the right edge shrinks it and the left edge
    // grows it back, so one drag each way would double the cost. Drag to the narrow end: it must
    // follow the finger and stop at its 25% floor.
    const { W } = await panelFraction(udid);
    const narrow = await dragPanelEdge(udid, W - 20);
    await shot(udid, "panel-min-light");
    if (Math.abs(narrow - 0.25) > 0.015) throw new Error(`dragged to the right edge, the panel stopped at ${pct(narrow)}`);
    return `${pct(narrow)} at the right edge`;
  });
  await check("docking stashes the panel as a card in the bottom-right corner, and the card restores its path", async () => {
    // The child pushed in the panel (RouterSheetTests has the push), so the card has a path to restore.
    await until("the conductor's children", async () => {
      if ((await labels(udid)).some((l) => l.includes(kid.key))) return true;
      await tapWhere(udid, (l) => l.startsWith("Tickets")).catch(() => {});
      await atRest(udid, 1200);
      return false;
    }, 15000, 0);
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child in the panel", async () => panelOn(await labels(udid), kid.key), 8000);
    await tapWhere(udid, `Dock ${kid.key}`);
    const pill = await until("the card", async () => {
      const n = await findElement(udid, isDock);
      return n && !(await labels(udid)).includes(RESIZE) ? n : null;
    }, 6000).catch(async (e) => {
      await say("after the dock button");
      throw e;
    });
    const { width: W, height: H } = (await tree(udid))[0]!.frame;
    const p = (await findElement(udid, isDock)) ?? pill;
    if (p.AXLabel !== `${kid.key}, ${kid.title}, docked`) throw new Error(`the card reads "${p.AXLabel}", not ${kid.key} and its title`);
    const mid = p.frame.y + p.frame.height / 2;
    await cardInCorner(udid, kid.key, W, H);
    if (!onBoard(await labels(udid))) throw new Error("the board isn't showing with the panel docked");
    await shootBoth(udid, "panel-docked");
    await appearance(udid, "light");
    await axe("tap", "-x", String(Math.round(p.frame.x + p.frame.width / 2)), "-y", String(Math.round(mid)), "--udid", udid);
    moved(udid);
    await until("the panel back on the child", async () => {
      const l = await labels(udid);
      return panelOn(l, kid.key) && !l.some(isDock);
    }, 8000);
    await backTo(key);
    return `${p.frame.x}+${p.frame.width} of ${W}, y ${Math.round(mid)} of ${H}; restored on ${kid.key}, Back to ${key}`;
  });
  await check("a slow drag along the panel's top edge short of halfway, or a 10pt flick, springs back; a fast fling closes the ticket", async () => {
    const { leading, W } = await panelFraction(udid);
    const close = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-panel-close");
    if (!close) throw new Error("no close button in the panel");
    const y = String(Math.round(close.frame.y - 4 + 6));
    const panelW = W - leading;
    const from = Math.round(leading + panelW * 0.3);
    // Slow (AXe's touch points are, whatever --duration says), 30% of the panel's width along.
    await axe("swipe", "--start-x", String(from), "--start-y", y, "--end-x", String(Math.round(from + panelW * 0.3)), "--end-y", y, "--duration", "0.8", "--udid", udid);
    await atRest(udid, 1000);
    const l = await labels(udid);
    if (l.some(isDock) || !panelOn(l, key)) {
      await say("after the short drag");
      throw new Error("a drag that stopped short of halfway didn't spring back");
    }
    if (shotsWanted) await shot(udid, "panel-spring-back");
    // A tiny fast flick: under the 40pt minimum, so it springs back whatever its speed.
    await axe("swipe", "--start-x", String(leading + 30), "--start-y", y, "--end-x", String(leading + 40), "--end-y", y, "--duration", "0.05", "--udid", udid);
    await atRest(udid, 1000);
    const t = await labels(udid);
    if (t.some(isDock) || !panelOn(t, key)) {
      await say("after the 10pt flick");
      throw new Error("a 10pt flick closed or docked the panel");
    }
    // Long strides, well past halfway: closes rather than docks.
    await axe("swipe", "--start-x", String(leading + 30), "--start-y", y, "--end-x", String(leading + 30 + 160), "--end-y", y, "--duration", "0.1", "--delta", "160", "--udid", udid);
    moved(udid);
    await until("the panel closed, not docked", async () => !panelOn(await labels(udid), key), 6000).catch(async (e) => {
      await say("after the fast fling");
      throw e;
    });
    await atRest(udid, 500);
    if ((await labels(udid)).some(isDock)) throw new Error("the fast fling docked the panel");
    // Back up for the next check.
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}`);
    await until("the panel back", async () => panelOn(await labels(udid), key), 8000);
    return "sprang back, then a fast fling closed it";
  });
  await check("a panel dragged partly off the window keeps its width: its title doesn't reflow to the visible sliver", async () => {
    // The resize check left the panel at its 25% floor, where the title wraps whatever happens: widen it first.
    await dragPanelEdge(udid, 300);
    const { leading, W } = await panelFraction(udid);
    const close = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-panel-close");
    if (!close) throw new Error("no close button in the panel");
    const y = String(Math.round(close.frame.y - 4 + 6));
    /** The panel's leading edge and its title's size, where the title is the widest tall label in the header. */
    const read = (ns: AXNode[]) => {
      const handle = ns.find((n) => n.AXLabel === RESIZE);
      const title = ns
        .filter((n) => handle && n.AXLabel && n.frame.x > handle.frame.x && n.frame.width > 100 && n.frame.y < 200 && n.frame.height > 40 && !/^(Dock|Open|Close|Resize)/.test(n.AXLabel))
        .sort((a, b) => b.frame.width - a.frame.width)[0];
      return handle && title ? { x: handle.frame.x, w: title.frame.width, h: title.frame.height } : null;
    };
    const rest = read(await nodes(udid));
    if (!rest) throw new Error("couldn't read the panel's title at rest");
    // Slow, and ending short of the dock zone (the trailing 40%) so it can't arm: the panel ends up
    // about 190 pt off its place, a third of it past the window's edge, then springs back.
    const drag = axe("swipe", "--start-x", String(Math.round(leading + 20)), "--start-y", y, "--end-x", String(Math.round(W * 0.58)), "--end-y", y, "--duration", "5", "--udid", udid);
    const seen: NonNullable<ReturnType<typeof read>>[] = [];
    let shotTaken = false;
    const started = Date.now();
    while (Date.now() - started < 4500) {
      const r = read(await nodes(udid));
      if (r && r.x >= rest.x + 100) {
        seen.push(r);
        if (shotsWanted && !shotTaken) {
          shotTaken = true;
          await shot(udid, "panel-drag-width");
        }
      }
    }
    await drag;
    await atRest(udid, 1000);
    if (!seen.length) throw new Error(`the panel's title wasn't readable while it was dragged clear of rest (x ${rest.x})`);
    const bad = seen.find((r) => Math.abs(r.w - rest.w) > 2 || Math.abs(r.h - rest.h) > 4);
    if (bad) throw new Error(`the panel's content reflowed mid-drag: title ${rest.w}×${rest.h} at rest, ${bad.w}×${bad.h} with the panel at x ${bad.x} (rest ${rest.x}), ${seen.length} readings`);
    if (!panelOn(await labels(udid), key)) throw new Error("the slow drag short of halfway didn't spring back");
    // Narrow again for the hold check after this one, which is timed for the narrow panel.
    await dragPanelEdge(udid, W - 20);
    return `title ${rest.w}×${rest.h} held through ${seen.length} readings, up to ${Math.round(Math.max(...seen.map((r) => r.x)) - rest.x)} pt off its place`;
  });
  await check("holding the dragged panel in the trailing 40% shows the ghost card and docks it on release; the card restores it at its root", async () => {
    // The fling lives on a thin strip along the panel's top and the buttons' corner (no title bar).
    const { leading, W } = await panelFraction(udid);
    const close = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-panel-close");
    if (!close) throw new Error("no close button in the panel");
    const y = String(Math.round(close.frame.y - 4 + 6));
    const from = Math.round(leading + (W - leading) * 0.3);
    // AXe can't pause mid-drag, so the slow swipe is the hold: the finger is in the trailing 40%,
    // with the panel well clear of rest, for the last couple of seconds of it.
    const drag = axe("swipe", "--start-x", String(from), "--start-y", y, "--end-x", String(Math.round(W - 10)), "--end-y", y, "--duration", "3", "--udid", udid);
    await sleep(2600);
    const ghost = await until("the ghost dock card", async () => (await labels(udid)).some((l) => l.startsWith("Dock card")), 1500).catch(() => null);
    if (!ghost) throw new Error("holding the panel in the trailing 40% didn't show the ghost dock card");
    if (shotsWanted) await shot(udid, "panel-dock-ghost");
    await drag;
    moved(udid);
    const pill = await until("the card", async () => {
      const n = await findElement(udid, isDock);
      return n && !(await labels(udid)).includes(RESIZE) ? n : null;
    }, 6000).catch(async (e) => {
      await say("after the hold");
      throw e;
    });
    await atRest(udid, 700);
    const p = (await findElement(udid, isDock)) ?? pill;
    await axe("tap", "-x", String(Math.round(p.frame.x + p.frame.width / 2)), "-y", String(Math.round(p.frame.y + p.frame.height / 2)), "--udid", udid);
    moved(udid);
    await until("the panel back", async () => {
      const l = await labels(udid);
      return panelOn(l, key) && !l.some(isDock);
    }, 8000);
    // At the root there's no Back: no `ticket-back` button (once the docking check's pop has settled).
    await until(`${key} at its root, with no Back`, async () => !(await nodes(udid)).some((n) => n.AXUniqueId === "ticket-back"), 5000).catch(async () => {
      throw new Error(`the root ticket ${key} draws a Back button: ${JSON.stringify((await nodes(udid)).filter((n) => n.AXUniqueId === "ticket-back" || /^Close/.test(n.AXLabel ?? "")).map((n) => [n.AXUniqueId, n.AXLabel, n.frame]))}`);
    });
    return `docked as "${p.AXLabel}" and restored`;
  });
  await check("a card's ✕ closes just its ticket without opening it", async () => {
    // The conductor's panel docks as a card, then another ticket's panel docks over it: two cards.
    const top = other.key;
    await tapWhere(udid, `Dock ${key}`);
    await until("the first card", () => findElement(udid, isDock), 6000);
    await goto(udid, `harness://ticket/${encodeURIComponent(top)}`, (l) => panelOn(l, top));
    await tapWhere(udid, `Dock ${top}`);
    await until("the cards", async () => (await labels(udid)).filter(isDock).length === 2 || null, 6000);
    await shot(udid, "panel-cards-two-light");
    // The card's ticket and the conductor's, which it joined in the dock: each closes on its own.
    const closed: string[] = [];
    for (const k of [top, key]) {
      const mine = (x: string) => x.startsWith(`${k}, `) && isDock(x);
      await until(`${k}'s card`, () => findElement(udid, mine), 6000).catch(async (e) => {
        await say("looking for the card");
        throw e;
      });
      const others = (await labels(udid)).filter((x) => isDock(x) && !mine(x));
      await tapWhere(udid, `Close ${k}`);
      // Gone, and — checked in the same read — nothing else went with it and no panel opened.
      const now = await until(`${k}'s card gone`, async () => {
        const x = await labels(udid);
        return x.some(mine) ? null : x;
      }, 5000);
      if (now.includes(RESIZE)) throw new Error("the panel opened instead");
      const left = others.filter((o) => !now.includes(o));
      if (left.length) throw new Error(`closing ${k} took ${left.join(", ")} with it`);
      closed.push(k);
    }
    if ((await labels(udid)).some(isDock)) throw new Error("a card is still there");
    lastUrl.set(udid, BOARD);
    return `${closed.join(", then ")} closed, one at a time`;
  });
  await check("the pop-out button moves the panel's ticket into a window of its own", async () => {
    // A throwaway ticket: closing its window deletes it (More → Delete ticket destroys the scene).
    const t = await api<Ticket>("POST", "/tickets", { projectId: s.project.id, spec: "Pop me out", driver: "dummy", start: false });
    await goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => panelOn(l, t.key));
    await tapWhere(udid, `Open ${t.key} in a new window`);
    moved(udid);
    const up = await until(`${t.key}'s window`, async () => {
      const l = await labels(udid);
      return ticketShown(l, t.key) && !l.includes(RESIZE);
    }, 10000).catch((e) => e as Error);
    await shot(udid, "panel-popped-out-light");
    if (up instanceof Error) {
      await say("after the pop-out button");
      throw up;
    }
    // Tidying up, not the check: the simulator's renderer sometimes aborts with a window open
    // (ios/ARCHITECTURE.md § Windows).
    const tidy = await (async () => {
      await tapWhere(udid, "More");
      await tapWhere(udid, "Delete ticket");
      await tapWhere(udid, "Delete");
      await until(`${t.key}'s window closed`, async () => !(await labels(udid)).includes(t.key), 10000);
      await goto(udid, BOARD);
      return (await labels(udid)).includes(RESIZE) ? "; the panel came back with the board" : "";
    })().catch((e) => `; closing its window: ${(e as Error).message.split(";")[0]}`);
    if (tidy.includes("came back")) throw new Error(tidy.slice(2));
    return `${t.key} in its own window, the panel closed${tidy}`;
  });
}

/** --stick: one ticket whose spec, transcript and Activity are all taller than the screen. */
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ";
const stickText = (n: number, repeat = 3) => `Stick ${n}: ${LOREM.repeat(repeat)}`;
/** The line over the composer ("Stays in review unless…"), which isn't one of the list's rows. */
/** The last Activity row after a `sayStick(…, { activity: true })`: the dummy reviewer's approval. */
const STICK_REVIEWED = "The dummy reviewer approves.";
/**
 * Message `n` to the --stick ticket. A message only goes into the transcript (its chat run), so
 * with `activity` it also has the dummy take the work out of review and submit it again, which adds
 * a resume, a submit and a review decision to Activity (and their runs to the transcript).
 */
async function sayStick(key: string, n: number, { activity = false } = {}) {
  const activityOf = () => api<ActivityEntry[]>("GET", `/tickets/${encodeURIComponent(key)}/activity`);
  const reviews = activity ? (await activityOf()).filter((e) => e.kind === "review_approved").length : 0;
  await api("POST", `/tickets/${key}/messages`, { text: activity ? `${stickText(n)} [dummy:resume] [dummy:submit]` : stickText(n) });
  if (activity) {
    // Settled once the resubmitted work's review approved it again.
    await until(`${key} re-reviewed after message ${n}`, async () => (await activityOf()).filter((e) => e.kind === "review_approved").length > reviews || null, 60000, 100);
    return settle(key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview));
  }
  // The ticket stays in review, so it looks settled before the run starts: wait for the answer.
  const reply = `You said: "Stick ${n}:`;
  const sessionId = (await ticketOf(key)).sessionId;
  await until(`${key} replies to message ${n}`, async () => (await api<TranscriptEntry[]>("GET", `/sessions/${sessionId}/transcript`)).some((e) => "text" in e.content && e.content.text.includes(reply)) || null, 60000, 100);
  return settle(key, (t) => !t.busy);
}
/** A project with a few files and one ticket in review (its spec `spec`), for --stick, --keyboard and --mentions. */
async function seedTicket(key: string, spec: string, files: Record<string, string> = {}) {
  await settings();
  const dir = join(scratch, key.toLowerCase());
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const project = await api<Project>("POST", "/projects", { path: dir, name: key.toLowerCase(), key, defaultDriver: "dummy" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview));
  return { project, ticket };
}
async function seedStick() {
  const s = await seedTicket("STICK", stickText(0, 14));
  for (let n = 1; n <= 3; n++) await sayStick(s.ticket.key, n, { activity: true });
  return s;
}

/** --stick: real swipes on the Transcript and Activity tabs. */
async function stickChecks(udid: string, p: Awaited<ReturnType<typeof seedStick>>) {
  selector.sequence();
  const key = p.ticket.key;
  const H = (await tree(udid))[0]!.frame.height;
  // The list's viewport: below the tab strip, above the composer.
  async function listView() {
    const all = await nodes(udid);
    const tab = all.find((n) => n.AXLabel === "Transcript" || n.AXLabel?.startsWith("Activity"));
    const composer = all.filter((n) => n.AXLabel?.startsWith("Message the agent") || n.AXLabel === "Send" || n.AXLabel === "Attach");
    const top = tab ? tab.frame.y + tab.frame.height : 100;
    const bottom = composer.length ? Math.min(...composer.map((n) => n.frame.y)) : H - 60;
    // Every row rendered below the tab strip, on screen or not (FlatList keeps rows around the
    // viewport). Starting below it leaves out the app window and the header.
    const rows = all.filter((n) => n.AXLabel && !composer.includes(n) && n.frame.y >= top);
    return { rows, top, bottom };
  }
  /** At the bottom: the lowest rendered row is the list's last row and ends just above the composer. */
  const atBottom = async (last: (l: string) => boolean) => {
    const { rows, bottom } = await listView();
    const lowest = rows.reduce<AXNode | null>((a, n) => (!a || n.frame.y + n.frame.height > a.frame.y + a.frame.height ? n : a), null);
    const end = lowest ? lowest.frame.y + lowest.frame.height : 0;
    const ok = !!lowest && last(lowest.AXLabel!) && end <= bottom + 2 && end >= bottom - 70;
    if (!ok && process.env.SIM_CHECK_DEBUG) console.error(`not at the bottom: lowest "${lowest?.AXLabel?.slice(0, 60)}" ends at ${Math.round(end)}, composer at ${Math.round(bottom)}`);
    return ok ? `last row "${lowest!.AXLabel!.slice(0, 32)}" ends at ${Math.round(end)}, composer at ${Math.round(bottom)}` : null;
  };
  /** A uniquely labelled row inside the viewport, to check that the view doesn't move. */
  const anchor = async () => {
    const { rows, top, bottom } = await listView();
    const count = new Map<string, number>();
    for (const n of rows) count.set(n.AXLabel!, (count.get(n.AXLabel!) ?? 0) + 1);
    const n = rows.find((r) => count.get(r.AXLabel!) === 1 && r.frame.y > top + 20 && r.frame.y + r.frame.height < bottom - 20);
    return n ? { label: n.AXLabel!, y: Math.round(n.frame.y) } : null;
  };
  const yOf = async (label: string) => {
    const n = (await listView()).rows.find((r) => r.AXLabel === label);
    return n ? Math.round(n.frame.y) : null;
  };
  /** Drags (or with `flick`, flings with momentum) the list; finger moving down scrolls toward the top. */
  const swipe = async (dir: "up" | "down", times = 4, flick = false) => {
    const [from, to] = dir === "down" ? [H * 0.45, H * 0.8] : [H * 0.8, H * 0.45];
    for (let i = 0; i < times; i++) {
      await axe("swipe", "--start-x", "200", "--start-y", String(Math.round(from)), "--end-x", "200", "--end-y", String(Math.round(to)), "--duration", flick ? "0.08" : "0.25", "--udid", udid);
      await atRest(udid, 500);
    }
    await atRest(udid, flick ? 900 : 600); // a fling's momentum runs on after the finger lifts
  };
  /**
   * New content lands (another message and its runs) and the list has laid it out. With
   * `activity`, the message has the work resubmitted, so Activity grows too (a message alone
   * shows only in the transcript).
   */
  const say = async (n: number, last: (l: string) => boolean, activity = false) => {
    const before = activity ? (await labels(udid)).filter(last).length : 0;
    await sayStick(key, n, { activity });
    const landed = activity
      ? async () => (await labels(udid)).filter(last).length > before
      : async () => (await labels(udid)).some((l) => l.includes(`Stick ${n}:`)) && (await labels(udid)).some(last);
    await until(`message ${n}'s content on screen`, async () => (await landed()) || null, 8000).catch(() => {});
    await atRest(udid, 500);
  };

  let n = 3;
  // A plain message ends with its chat run (it leaves the ticket in review, so no reviewer run
  // follows): its last transcript row. Activity only grows when the work is resubmitted, so its
  // messages do that and its last entry is the re-review's approval. The seed's messages all
  // resubmitted, so the transcript opens on a review run.
  // Transcript (a FlatList with estimated rows, where UIKit moves the offset by itself) gets every
  // check; Activity uses the same hook, whose gating is unit-tested, so it gets the first two.
  const tabs: [string, (l: string) => boolean, (l: string) => boolean, boolean][] = [
    ["transcript", (l) => l.startsWith("Run finished ("), (l) => l.startsWith("Run finished (chat)"), true],
    ["activity", (l) => l.includes(STICK_REVIEWED), (l) => l.includes(STICK_REVIEWED), false],
  ];
  for (const [tab, opening, last, all] of tabs) {
    const activity = tab === "activity";
    await check(`${tab} opens at the bottom`, async () => {
      await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=${tab}`);
      return until("at the bottom", () => atBottom(opening), 10000);
    });
    await check(`${tab} follows new content while at the bottom`, async () => {
      await say(++n, last, activity);
      return until("at the bottom", () => atBottom(last), 10000);
    });
    if (!all) continue;
    await check(`${tab} stays put after the user scrolls up`, async () => {
      await swipe("down", 2);
      const ref = await until("a row to watch", anchor, 5000);
      await say(++n, () => true);
      const y = await yOf(ref.label);
      if (y === null || Math.abs(y - ref.y) > 2) throw new Error(`"${ref.label.slice(0, 32)}" ${ref.y}→${y}`);
      if (await atBottom(last)) throw new Error("jumped to the bottom");
      return `"${ref.label.slice(0, 32)}" stayed at y=${y}`;
    });
    await check(`${tab} follows again after scrolling back to the bottom`, async () => {
      // Swipe back down until the user has reached the end (the list grew a lot meanwhile).
      let flicks = 0;
      for (; flicks < 24 && !(await atBottom(last)); flicks += 2) await swipe("up", 2, true);
      if (!(await atBottom(last))) throw new Error("couldn't swipe back to the bottom");
      await say(++n, last);
      return `${await until("at the bottom", () => atBottom(last), 10000)} (back down in ${flicks} flicks)`;
    });
  }
  await shot(udid, "stick-activity");
  // Each run opens with a header that stays pinned at the top while its rows scroll under it, and
  // the next run's header takes over. Scrolling up from the bottom passes through several runs.
  await check("the transcript pins the current run's header, and the next run's header takes it over", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=transcript`);
    await until("at the bottom", () => atBottom((l) => l.startsWith("Run finished (")), 10000);
    const pinned = async () => (await nodes(udid)).find((x) => x.AXUniqueId === "run-header-pinned")?.AXLabel ?? null;
    const seen: string[] = [];
    for (let i = 0; i < 24 && seen.length < 4; i++) {
      const label = await pinned();
      if (label && seen[seen.length - 1] !== label) seen.push(label);
      await swipe("down", 1);
    }
    const stamps = seen.map((l) => l.replace(/ · .*$/, ""));
    if (seen.length < 2 || new Set(stamps).size < 2) {
      await shot(udid, "run-headers-failed");
      throw new Error(`the pinned header never changed run: ${JSON.stringify(seen)}`);
    }
    await shot(udid, "run-header-pinned");
    return seen.join(" → ");
  });
  // Each tab's content runs on under the composer's glass rather than stopping above it: the pager
  // reaches the bottom of the screen, and only the scroll content's inset keeps the last row clear.
  for (const tab of ["spec", "activity", "transcript"]) {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=${tab}`);
    await sleep(1200);
    if (tab !== "spec") await swipe("down", 1);
    await shot(udid, `stick-under-composer-${tab}`);
  }

  // One header on every tab: the Spec opens it in full (title, badges, the review buttons), and
  // scrolling the Spec forward collapses it to the title line, the tab strip moving up into its
  // place. Nothing but the title's chevron expands it again: not scrolling back, not another tab.
  // Every other tab opens with it collapsed (lib/heroCollapse and HeroDisclosure have the rules).
  const heroShown = async () => (await labels(udid)).includes("Request changes");
  const stripY = async () => (await nodes(udid)).find((n) => n.AXLabel === "Transcript")?.frame.y ?? null;
  const title = (await ticketOf(key)).title || "Untitled";
  // A tap anywhere on the collapsed header expands it: tap its leading padding, beside the title
  // text, rather than the title itself. (The title comes before the Spec's first line in the tree.)
  const expandHero = async () => {
    const el = await until("the hero's title", () => findElement(udid, (l) => l.startsWith(title.slice(0, 20))), 3000);
    await axe("tap", "-x", "5", "-y", String(Math.round(el.frame.y + el.frame.height / 2)), "--udid", udid);
  };
  await check("the hero collapses on scrolling the Spec and stays collapsed scrolling back", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=spec`);
    await until("the hero", async () => (await heroShown()) || null, 8000);
    const before = await stripY();
    await swipe("up", 1);
    if (await heroShown()) throw new Error("still expanded after scrolling forward");
    const after = await stripY();
    if (before === null || after === null || after >= before - 40) throw new Error(`tab strip ${before}→${after}`);
    await shot(udid, "hero-collapsed");
    // The title's text lines up with the Spec tab's label: the status dot hangs in the margin to its
    // left. Both elements' frames include their padding, so add it back: the title button's 4pt
    // leading, 10pt dot and 4pt gap; the tab's 10pt inset.
    const titleEl = await until("the collapsed title", () => findElement(udid, (l) => l.startsWith(title.slice(0, 20))), 3000);
    const specTab = (await nodes(udid)).find((n) => n.AXLabel === "Spec" && n.frame.y > titleEl.frame.y);
    if (!specTab) throw new Error("no Spec tab under the collapsed title");
    const textX = titleEl.frame.x + 4 + 10 + 4;
    const labelX = specTab.frame.x + 10;
    if (Math.abs(textX - labelX) > 1) throw new Error(`the collapsed title's text sits at ${textX}, the Spec label at ${labelX}`);
    await swipe("down", 3);
    if (await heroShown()) throw new Error("expanded on scrolling back");
    return `tab strip ${Math.round(before)}→${Math.round(after)}; stayed collapsed scrolling back to the top`;
  });

  // The tab bodies sit side by side in a pager: a sideways swipe moves to the neighbouring tab, and
  // a right swipe on the first tab (the Spec) still goes back, as it did before they paged. A page
  // counts as shown when its rows sit inside the screen (the neighbours are laid out beside it).
  const W = (await tree(udid))[0]!.frame.width;
  // Only rows below the tab strip: the title in the hero is the spec's first line too.
  const shows = async (match: (l: string) => boolean) => {
    const all = await nodes(udid);
    const strip = all.find((n) => n.AXLabel === "Transcript");
    const top = strip ? strip.frame.y + strip.frame.height : 0;
    return all.some((n) => n.AXLabel && match(n.AXLabel) && n.frame.y >= top && n.frame.x >= 0 && n.frame.x < W - 20);
  };
  const spec = (l: string) => l.startsWith("Stick 0:");
  const activityRow = (l: string) => l.includes(STICK_REVIEWED);
  const sideways = (from: number, to: number) =>
    axe("swipe", "--start-x", String(Math.round(W * from)), "--start-y", String(Math.round(H * 0.7)), "--end-x", String(Math.round(W * to)), "--end-y", String(Math.round(H * 0.7)), "--duration", "0.3", "--udid", udid);
  await check("a sideways swipe changes tab and back", async () => {
    // A ticket link presents it as a sheet over the board, which has no back to swipe to: the
    // first page yielding to the back swipe is the sheet checks' pushed-child check.
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=spec`, (l) => l.some(spec));
    await until("the Spec", async () => (await shows(spec)) || null, 5000);
    await sideways(0.85, 0.1);
    await until("Activity after swiping left", async () => ((await shows(activityRow)) && !(await shows(spec))) || null, 5000);
    await sideways(0.15, 0.9);
    await until("the Spec after swiping right", async () => ((await shows(spec)) && !(await shows(activityRow))) || null, 5000);
    return "Spec → Activity → Spec";
  });
}

/**
 * A preference in the simulated device's own data (so no other simulator changes): reads it, and
 * writes a bool or deletes it when `value` is given. Returns the value it found ("1", "0" or null
 * when unset) so the run can put it back.
 */
async function devicePref(udid: string, domain: string, key: string, value?: "0" | "1" | null): Promise<string | null> {
  const was = (await sh(["xcrun", "simctl", "spawn", udid, "defaults", "read", domain, key], { allowFail: true })) || null;
  if (value === null) await sh(["xcrun", "simctl", "spawn", udid, "defaults", "delete", domain, key], { allowFail: true });
  else if (value !== undefined) await sh(["xcrun", "simctl", "spawn", udid, "defaults", "write", domain, key, "-bool", value === "1" ? "YES" : "NO"]);
  return was === "1" || was === "0" ? was : null;
}
const KEYBOARD_PREFS = "com.apple.keyboard.preferences";

/**
 * --keyboard: the composer and a sheet's last control stay above the on-screen keyboard.
 *
 * A headless simulator always has a hardware keyboard, and iOS then minimizes the software one to a
 * bar: the run turns the device's AutomaticMinimizationEnabled off, and puts it back afterwards.
 * Text goes in by tapping the on-screen keys, since AXe's typing is hardware key events.
 */
async function keyboardChecks(udid: string, p: Awaited<ReturnType<typeof seedTicket>>) {
  const minimize = await devicePref(udid, KEYBOARD_PREFS, "AutomaticMinimizationEnabled", "0");
  try {
    await keyboardChecksWithSoftwareKeyboard(udid, p);
  } finally {
    await devicePref(udid, KEYBOARD_PREFS, "AutomaticMinimizationEnabled", minimize as "0" | "1" | null);
  }
}

async function keyboardChecksWithSoftwareKeyboard(udid: string, p: Awaited<ReturnType<typeof seedTicket>>) {
  selector.sequence();
  // Types by tapping the on-screen keys (letters, space, return). AXe's `type` and `key` send
  // hardware key events, which put iOS in hardware-keyboard mode for the rest of the run.
  const typeOnKeys = async (text: string) => {
    const keys = (await nodes(udid)).filter((n) => n.AXLabel && (/^[a-zA-Z]$/.test(n.AXLabel) || /^(space|return|new line)$/i.test(n.AXLabel)));
    const at = (label: string) => keys.find((k) => k.AXLabel!.toLowerCase() === label);
    for (const ch of text) {
      const k = ch === " " ? at("space") : ch === "\n" ? (at("return") ?? at("new line")) : at(ch.toLowerCase());
      if (!k) throw new Error(`no key for ${JSON.stringify(ch)} on the keyboard`);
      await axe("tap", "-x", String(Math.round(k.frame.x + k.frame.width / 2)), "-y", String(Math.round(k.frame.y + k.frame.height / 2)), "--udid", udid);
    }
  };
  // The keyboard's top edge: the top letter row ("q"), or the predictive bar sitting right on it
  // (suggested words, Passwords) when there is one. A suggested "I" is a single-letter label too, so
  // the letter row is found by its "q" key, not as the highest single letter.
  const keyboardTop = async () => {
    const all = await nodes(udid);
    if (all.filter((n) => /^[a-zA-Z]$/.test(n.AXLabel ?? "")).length < 10) return null;
    const q = all.find((n) => n.AXLabel === "q" || n.AXLabel === "Q");
    if (!q) return null;
    const bar = all.filter((n) => n.frame.y < q.frame.y - 4 && n.frame.y > q.frame.y - 70 && Math.abs(n.frame.y + n.frame.height - q.frame.y) <= 12);
    return Math.min(q.frame.y, ...bar.map((n) => n.frame.y)) - 8;
  };
  const bottomOf = (n: AXNode) => n.frame.y + n.frame.height;

  await check("ticket composer sits on top of the keyboard", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`, (l) => l.some((x) => x.startsWith("Message the agent")));
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    const top = await until("keyboard up", keyboardTop, 8000);
    await atRest(udid, 600);
    const field = (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Message the agent"));
    await shot(udid, "keyboard-composer");
    if (!field) throw new Error("the composer is gone from the screen (behind the keyboard)");
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the composer's field ends ${-gap}pt behind the keyboard (field ends at ${Math.round(bottomOf(field))}, keyboard at ${Math.round(top)})`);
    if (gap > 40) throw new Error(`${gap}pt gap between the composer and the keyboard`);
    return `field ends ${gap}pt above the keyboard`;
  });

  // The dock hides under the keyboard and the composer gives its room back, so the field still sits on the keys.
  await check("the composer sits on the keyboard with another ticket docked, and the dock steps aside", async () => {
    const other = await api<Ticket>("POST", "/tickets", { projectId: p.project.id, spec: "Docked while another ticket is typed in", driver: "dummy", start: false });
    await goto(udid, `harness://ticket/${encodeURIComponent(other.key)}`, (l) => ticketShown(l, other.key));
    await dockSheet(udid);
    await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`, (l) => l.some((x) => x.startsWith("Message the agent")));
    if (!(await labels(udid)).some(isDock)) throw new Error("no docked card over the open ticket before the keyboard came up");
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    const top = await until("keyboard up", keyboardTop, 8000);
    await atRest(udid, 600);
    const field = (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Message the agent"));
    await shot(udid, "keyboard-composer-docked");
    if (!field) throw new Error("the composer is gone from the screen (behind the keyboard)");
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the composer's field ends ${-gap}pt behind the keyboard`);
    if (gap > 40) throw new Error(`${gap}pt gap between the composer and the keyboard: it kept room for the hidden dock`);
    if ((await labels(udid)).some(isDock)) throw new Error("the dock is still showing over the keyboard");
    await goto(udid, BOARD);
    await clearDock(udid);
    return `field ends ${gap}pt above the keyboard; the dock stepped aside`;
  });

  // The editor is a growing multiline field inside a scroll view; typing at its end has to keep
  // scrolling the view so the cursor (the field's last line) stays above the keyboard.
  await check("prompt editor follows the cursor above the keyboard as the text grows", async () => {
    const isField = (l: string) => l === "Agent review prompt";
    await goto(udid, "harness://prompt/run.review", (l) => l.includes("Reset to built-in"));
    const start = await until("editor field", () => findElement(udid, isField), 5000);
    // Near its last line puts the cursor at the end of the text.
    await axe("tap", "-x", String(Math.round(start.frame.x + start.frame.width - 30)), "-y", String(Math.round(bottomOf(start) - 20)), "--udid", udid);
    const top = await until("keyboard up", keyboardTop, 8000);
    await typeOnKeys("\n".repeat(16) + "end of the prompt");
    await atRest(udid, 900);
    await shot(udid, "keyboard-prompt");
    const field = await findElement(udid, isField);
    if (!field) throw new Error("the editor field is gone from the screen");
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the field's last line ends ${-gap}pt behind the keyboard (field ends at ${Math.round(bottomOf(field))}, keyboard at ${Math.round(top)})`);
    if (gap > 120) throw new Error(`the field ends ${gap}pt above the keyboard: the view didn't follow the cursor down`);
    // Drop the edit: Cancel sits where Back does.
    await axe("tap", "-x", "32", "-y", "89", "--udid", udid);
    moved(udid);
    return `grew to ${Math.round(field.frame.height)}pt; its end is ${gap}pt above the keyboard`;
  });

  // New session's prompt grows a line at a time with no cap (the form scrolls instead of the
  // field), and the form keeps the line being typed above the keyboard.
  await check("New session's prompt grows with every line typed", async () => {
    const isField = (l: string) => l === "Spec";
    const lines = 18;
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.includes("Spec"));
    const start = await until("prompt field", () => findElement(udid, isField), 5000);
    await axe("tap", "-x", String(Math.round(start.frame.x + 40)), "-y", String(Math.round(start.frame.y + 20)), "--udid", udid);
    const top = await until("keyboard up", keyboardTop, 8000);
    await typeOnKeys(Array.from({ length: lines }, () => "a").join("\n"));
    await atRest(udid, 900);
    await shot(udid, "keyboard-new-session");
    const field = await findElement(udid, isField);
    if (!field) throw new Error("the prompt field is gone from the screen");
    // 16pt text runs about 19pt a line (a little slack for the header covering its top). AXe reports only the field's part in sight (above the
    // keyboard, below the header), so it falls short of this when the field stops growing (it
    // scrolls inside itself) or when the form doesn't scroll up to follow the cursor.
    const tall = Math.round(field.frame.height);
    if (tall < lines * 16) throw new Error(`${tall}pt of the field is in sight with ${lines} lines in it: it stopped growing, or the form didn't scroll to follow the cursor`);
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the field's last line ends ${-gap}pt behind the keyboard (field ends at ${Math.round(bottomOf(field))}, keyboard at ${Math.round(top)})`);
    if (gap > 120) throw new Error(`the field ends ${gap}pt above the keyboard: the form didn't follow the cursor down`);
    // Typing saved a draft: discard it.
    await tapHeaderCancel(udid);
    await until("cancel alert", async () => (await labels(udid)).includes("Discard draft"), 5000);
    await tapWhere(udid, "Discard draft");
    moved(udid);
    return `grew to ${tall}pt over ${lines} lines; its end is ${gap}pt above the keyboard`;
  });

  // New session's prompt is several lines tall before anything is typed, and the text view itself
  // takes that height (its min lines), so a tap near its bottom, well below the one line of text,
  // lands in the text view and focuses it natively. A reopened draft doesn't autofocus, so the
  // keyboard is down until then.
  await check("a tap at the bottom of New session's prompt row focuses it", async () => {
    const isField = (l: string) => l === "Spec";
    const draft = await api<Ticket>("POST", "/tickets", { projectId: p.project.id, spec: "One line", draft: true, skipAgentReview: true });
    await goto(udid, `harness://new?key=${encodeURIComponent(draft.key)}`, (l) => l.includes("Spec"));
    const start = await until("prompt field", () => findElement(udid, isField), 5000);
    await atRest(udid, 600);
    if (await keyboardTop()) throw new Error("the keyboard came up before the tap");
    // AXe reports the text view's own frame: one line of text in it, so a short frame means the
    // height is a frame or padding around the text view, which a tap or drag doesn't reach.
    const tall = Math.round(start.frame.height);
    if (tall < 120) throw new Error(`the text view is ${tall}pt tall with one line in it: it doesn't fill its row`);
    await shot(udid, "keyboard-new-session-row-idle");
    const y = Math.round(start.frame.y + start.frame.height - 10);
    await axe("tap", "-x", String(Math.round(start.frame.x + start.frame.width / 2)), "-y", String(y), "--udid", udid);
    await until("keyboard up", keyboardTop, 5000).catch(async () => {
      throw new Error(`a tap at y=${y} (the field's top is ${Math.round(start.frame.y)}) left the keyboard down`);
    });
    await shot(udid, "keyboard-new-session-row");
    await tapHeaderCancel(udid);
    moved(udid);
    return `tapped ${y - Math.round(start.frame.y)}pt below the field's top`;
  });

  // The keyboard's top corners are rounded, so what's behind them shows: the sheet's own background,
  // not the dimmed board under the sheet (the sheet's fill used to stop at the keyboard's top).
  await check("the sheet's background runs behind the keyboard's rounded corners", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.includes("Spec"));
    const field = await until("prompt field", () => findElement(udid, (l) => l === "Spec"), 5000);
    await axe("tap", "-x", String(Math.round(field.frame.x + 40)), "-y", String(Math.round(field.frame.y + 20)), "--udid", udid);
    await until("keyboard up", keyboardTop, 8000);
    await atRest(udid, 600);
    const top = (await keyboardTop())!;
    await shot(udid, "keyboard-new-session-corner", true); // the check reads its pixels
    const file = join(shots, "keyboard-new-session-corner.png");
    const screen = (await tree(udid))[0]!.frame;
    const scale = Number(await sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file])) / screen.width;
    // From well above the keyboard (the sheet's background, left of the form's rows) to the screen's bottom.
    const from = Math.round((top - 120) * scale);
    const height = Math.round(screen.height * scale) - from;
    // Left of the rows (they start 16pt in) the keyboard's flat top begins where this column first
    // changes; the screen's edge column is still behind the corner's curve there.
    const inner = await grayColumn(file, Math.round(12 * scale), from, height);
    const edge = await grayColumn(file, 1, from, height);
    const bg = edge[0]!;
    const keyboardEdge = inner.findIndex((v) => Math.abs(v - bg) > 3);
    if (keyboardEdge < 0) throw new Error(`no keyboard edge below ${Math.round(top - 120)}pt (keyboard letters at ${Math.round(top)}pt, column ${Math.round(12 * scale)}px)`);
    const below = Math.round(3 * scale);
    const behind = edge.subarray(0, keyboardEdge + below).findIndex((v) => Math.abs(v - bg) > 3);
    if (behind >= 0) throw new Error(`behind the keyboard's corner the screen's edge turns gray ${edge[behind]}, not the sheet's ${bg}, ${Math.round((behind - keyboardEdge) / scale)}pt from the keyboard's top`);
    await tapHeaderCancel(udid);
    moved(udid);
    return `the screen's edge is the sheet's gray ${bg} down to 3pt below the keyboard's top`;
  });
}

/** One column of a screenshot as gray levels, `height` pixels from row `y` down. */
async function grayColumn(file: string, x: number, y: number, height: number) {
  const p = Bun.spawn(counted(["ffmpeg", "-loglevel", "error", "-i", file, "-vf", `crop=1:${height}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]), { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`ffmpeg column ${x} of ${file} → ${code}\n${err.slice(-500)}`);
  return new Uint8Array(out);
}

/** --mentions: a project with a few files, and a ticket in review to message; and a claude-code project for /commands. */
async function seedMentions() {
  const seeded = await seedTicket("MENT", "Warm up", {
    "README.md": "# Mentions\n\nThe readme the agent gets without reading it.\n",
    "src/app.ts": "export const app = 1;\n",
    "src/lib/format.ts": "export const format = 2;\n",
  });
  const dir = join(scratch, "slash");
  mkdirSync(dir, { recursive: true });
  const slash = await api<Project>("POST", "/projects", { path: dir, name: "slash", key: "SLSH", defaultDriver: "claude-code" });
  return { ...seeded, slash };
}

/** --mentions: real typing and taps in New session and the composer. */
async function mentionChecks(udid: string, p: Awaited<ReturnType<typeof seedMentions>>) {
  selector.sequence();
  const has = async (label: string) => (await labels(udid)).includes(label);
  const texts = async (key: string) => {
    const d = await api<TicketDetail>("GET", `/tickets/${key}`);
    return (await api<TranscriptEntry[]>("GET", `/sessions/${d.ticket.sessionId}/transcript`)).map((e) => ("text" in e.content ? e.content.text : ""));
  };
  // AXe doesn't list the sheet's navigation bar items, so New session's Start session (the last
  // one) and Plan first (left of it) are tapped where they sit.
  const tapToolbar = async (fromRight: 0 | 1) => {
    const width = (await tree(udid))[0]!.frame.width;
    await axe("tap", "-x", String(Math.round(width - 38 - fromRight * 56)), "-y", "100", "--udid", udid);
  };

  // (Picking a folder keeps the list open inside it: insertMention and mentionCaret's unit tests.)
  await check("New session: @READ lists README.md, a tap completes it, and the toolbar launches", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "Summarize @READ", "--udid", udid);
    await until("README.md suggested", () => has("README.md"), 8000);
    await atRest(udid, 300);
    await shootBoth(udid, "mentions-new-session");
    await tapWhere(udid, "README.md");
    await until("list closed", async () => !(await has("README.md")), 4000);
    await tapToolbar(0);
    moved(udid);
    // The draft is saved while it's typed; wait for it to launch.
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => x.key !== p.ticket.key && !x.draft), 10000);
    // What the run got (the file, the spec as typed) is drafts.test.ts's "a draft's @-mentioned file reaches the run".
    return t.key;
  });

  await check("New session: the toolbar's Plan first opens the launched ticket on its Spec tab", async () => {
    const before = new Set((await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).map((x) => x.key));
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await shootBoth(udid, "new-session-toolbar-empty");
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "Plan the readme", "--udid", udid);
    await atRest(udid, 300);
    await shootBoth(udid, "new-session-toolbar");
    await tapToolbar(1);
    moved(udid);
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => !before.has(x.key) && !x.draft), 10000);
    // That Plan first lands in planning is drafts.test.ts ("start false") and launchBodies.json's {"start":false}.
    // The Spec tab's revision bar ("Show changes") is on no other tab.
    await until(`${t.key}'s Spec tab`, async () => (await labels(udid)).includes("Show changes"), 8000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).join(" | ")}`);
    });
    return `${t.key}, on its Spec tab`;
  });

  await check("composer: @src/a lists src/app.ts, a tap completes it and Send posts the message", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`, (l) => l.some((x) => x.startsWith("Message the agent")));
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    // iOS may capitalize the first word, so the message is compared without case.
    await axe("type", "see @src/a", "--udid", udid);
    await until("src/app.ts suggested", () => has("src/app.ts"), 8000);
    await atRest(udid, 300); // let the list settle before aiming at a row
    await shootBoth(udid, "mentions-composer");
    await tapWhere(udid, "src/app.ts");
    // Picking closes the list and the composer shrinks, which moves Send.
    await until("list closed", async () => !(await has("src/app.ts")), 4000);
    await atRest(udid, 300);
    await tapWhere(udid, "Send");
    await until("message with the mention", async () => (await texts(p.ticket.key)).some((t) => t.toLowerCase() === "see @src/app.ts"), 10000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; transcript ends ${JSON.stringify((await texts(p.ticket.key)).slice(-4))}`);
    });
    return "see @src/app.ts";
  });

  await check("New session: /co lists the agent's commands, a tap completes one, and the toolbar launches", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.slash.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "/co", "--udid", udid);
    // The first lookup starts the (fake) CLI.
    await until("/code-walk suggested", () => has("/code-walk"), 15000);
    if (!(await has("/commit-and-pr")) || (await has("/vercel:deploy"))) throw new Error(`the list isn't /co's: ${JSON.stringify((await labels(udid)).filter((l) => l.startsWith("/")))}`);
    await atRest(udid, 300);
    await shootBoth(udid, "mentions-commands");
    await tapWhere(udid, "/code-walk");
    await until("list closed", async () => !(await has("/code-walk")), 4000);
    await axe("type", "this branch", "--udid", udid);
    await atRest(udid, 300);
    await tapToolbar(0);
    moved(udid);
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.slash.id}`)).find((x) => !x.draft), 10000);
    // The run's prompt is the spec as typed (drafts.test.ts "starts with a slash command"), which the CLI reads from
    // stdin after the run context (claude-code.test.ts "the run context goes in front of the first message").
    return t.key;
  });
}

/** --drafts: real typing in the composer against message drafts saved and changed on the service. */
async function draftChecks(udid: string, p: Awaited<ReturnType<typeof seedTicket>>) {
  selector.sequence();
  const key = p.ticket.key;
  const saved = async () => (await api<TicketDetail>("GET", `/tickets/${encodeURIComponent(key)}`)).ticket.messageDraft ?? null;
  /** The composer's text, as VoiceOver reads its value. */
  const field = async () => {
    const n = (await nodes(udid)).find((x) => x.AXLabel?.startsWith("Message the agent")) as (AXNode & { AXValue?: string | null }) | undefined;
    return n?.AXValue ?? "";
  };
  const fromMac = (text: string) => api<Ticket>("PUT", `/tickets/${encodeURIComponent(key)}/message-draft`, { text, origin: "sim-check-mac" });
  const open = () => goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=transcript`, (l) => l.some((x) => x.startsWith("Message the agent")));
  const away = () => goto(udid, `harness://board`, (l) => !l.some((x) => x.startsWith("Message the agent")));
  let origin: string | null = null;

  // Setup, not a check (MessageDraftsTests has the rule): the phone types a draft and the service stores it.
  await open();
  await tapWhere(udid, (l) => l.startsWith("Message the agent"));
  await axe("type", "started on the phone", "--udid", udid);
  await until("the draft saved", async () => ((await saved())?.text.toLowerCase() === "started on the phone" ? true : null), 8000);

  await check("composer: moving the caret keeps what's typed", async () => {
    const el = await until("the composer", () => findElement(udid, (l) => l.startsWith("Message the agent")), 4000);
    const y = String(Math.round(el.frame.y + el.frame.height / 2));
    // Near the start of the text, then back near its end: each tap only moves the caret.
    for (const x of [el.frame.x + 22, el.frame.x + el.frame.width / 2]) {
      await axe("tap", "-x", String(Math.round(x)), "-y", y, "--udid", udid);
      await atRest(udid, 700);
      const shown = await field();
      if (shown.toLowerCase() !== "started on the phone") throw new Error(`after moving the caret the field shows ${JSON.stringify(shown)}`);
    }
    await atRest(udid, 1200);
    const d = await saved();
    if (d?.text.toLowerCase() !== "started on the phone") throw new Error(`the draft is ${JSON.stringify(d)}`);
    return "kept";
  });

}

/**
 * --usage: the sidebar's plan-usage gauges, against the proxy's fixture (see usageFixture): the info
 * popover, the Projected at reset menu item, the driver filter and Hide. What the rows say is a
 * snapshot test. Screenshots go with --shots.
 */
async function usageChecks(udid: string) {
  selector.sequence();
  const showSidebar = async () => {
    if (ipad) await toggleSidebar(udid, true);
    else await goto(udid, "harness://projects", (l) => l.includes("Inbox"));
    await until("the plan usage section", async () => ((await labels(udid)).includes("PLAN USAGE") ? true : null), 8000).catch(async (e) => {
      await shot(udid, "usage-failed");
      throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).join(" | ")}`);
    });
  };
  const rowLabels = async () => (await labels(udid)).filter((l) => /^(Claude Code|GitHub Copilot)\b/.test(l));
  const has = async (prefix: string) => (await rowLabels()).find((l) => l.startsWith(prefix));
  const waitFor = (what: string, fn: () => Promise<unknown>) => until(what, async () => ((await fn()) ? true : null), 8000);
  const choose = async (item: string) => {
    await tapWhere(udid, "Plan usage options");
    await tapWhere(udid, item);
    await atRest(udid, 400);
  };
  await showSidebar();
  await waitFor("the usage rows", () => has("Claude Code 5-hour"));

  // The rows' text, resets and bars, and the unreadable driver's reason, are the plan-usage-used snapshot
  // (ScreenSnapshotTests.testPlanUsageUsedSoFar); the projected text is plan-usage-projected.

  await check("usage: the info popover explains the limits", async () => {
    await tapWhere(udid, "About plan usage");
    await waitFor("the explanation", async () => (await labels(udid)).some((l) => l.startsWith("How much of your plan's usage limits")));
    await shot(udid, "usage-info");
    // On iOS 27 the first taps outside the popover are swallowed (they land on the dimmed page and on the sheet): tap until it goes.
    const open = async () => (await labels(udid)).some((l) => l.startsWith("How much of your plan's usage limits"));
    for (const y of [60, 400, 800]) {
      if (!(await open())) break;
      await axe("tap", "-x", "200", "-y", String(y), "--udid", udid);
      await atRest(udid, 600);
    }
    await until("the popover closes", async () => ((await labels(udid)).some((l) => l.startsWith("How much of your plan's usage limits")) ? null : true), 5000);
    return "shown and dismissed";
  });

  await check("usage: Projected at reset shows pace, the tick and too-early", async () => {
    await tapWhere(udid, "Plan usage options");
    await shot(udid, "usage-menu");
    await tapWhere(udid, "Projected at reset");
    await atRest(udid, 400);
    // Which rows say what (pace, too early, a full window) is the plan-usage-projected snapshot; this is the tap that switches the mode.
    await waitFor("pace text", () => has("Claude Code Weekly: on pace for 56% · 45% used, resets"));
    await shot(udid, "usage-projected");
    return "projected";
  });

  await check("usage: the filter shows one driver, and the choice survives a relaunch", async () => {
    await choose("GitHub Copilot");
    await waitFor("only copilot", async () => !(await has("Claude Code")) && !!(await has("GitHub Copilot")));
    await shot(udid, "usage-filtered");
    await simctl("terminate", udid, BUNDLE).catch(() => {});
    await simctl("launch", udid, BUNDLE);
    await showSidebar();
    await waitFor("still only copilot", async () => !(await has("Claude Code")) && !!(await has("GitHub Copilot")));
    return "filtered, saved per device";
  });

  await check("usage: Hide collapses the section to its header", async () => {
    await choose("Hide");
    await waitFor("no rows", async () => (await rowLabels()).length === 0);
    if (!(await labels(udid)).includes("PLAN USAGE")) throw new Error("the header went too");
    await shot(udid, "usage-hidden");
    await choose("All drivers");
    await waitFor("the rows are back", () => has("Claude Code 5-hour"));
    return "hidden and restored";
  });

  // A usage.updated event replacing the report is BoardStoreTests (the store); the rows after it are the plan-usage-updated snapshot.
}

/**
 * --attachments: a ticket whose spec shows real images and a video inline, and one attachment that
 * won't load. The dummy's /tools directive calls update_spec on the fresh ticket's revision 1 with
 * markdown images of local files (relative to the project folder, its workdir), which the service
 * stores and rewrites to attachment:<id>. update_spec refuses a file whose bytes don't match its
 * extension, so the one that fails to load is an attachment: reference to an id that doesn't exist:
 * attachment: srcs are kept as written, and the viewer shows its failure page for it.
 */
/** --attachments' small.png, in pixels: narrower and shorter than the viewer's page on an iPhone, so it shows at its own size (1 px = 1 pt). */
const SMALL = { width: 300, height: 652 };

/**
 * Where a screenshot isn't black, in pixels, between `top` and `bottom` pixels from its edges:
 * ffmpeg's cropdetect over that band. The viewer's page is black, so on an image page that's the image.
 */
async function litBox(file: string, top: number, bottom: number) {
  // skip=0: cropdetect skips the first two frames by default, and a screenshot has one. Its x1…y2
  // are the exact bounds (its crop= rounds them).
  const p = Bun.spawn(counted(["ffmpeg", "-hide_banner", "-i", file, "-vf", `crop=iw:ih-${top + bottom}:0:${top},cropdetect=limit=24:round=1:reset=0:skip=0`, "-frames:v", "1", "-f", "null", "-"]), { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  const m = [...err.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].at(-1);
  if (code !== 0 || !m) throw new Error(`cropdetect on ${file} → ${code}\n${err.slice(-500)}`);
  const [x1, x2, y1, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1, y: y1 + top, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

async function seedAttachments() {
  await settings();
  const dir = join(scratch, "media");
  mkdirSync(join(dir, "shots"), { recursive: true });
  const ff = (...a: string[]) => sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a], { cwd: dir });
  // A tall phone screenshot, a wide one, one smaller than the screen both ways (a solid colour, so
  // the viewer check can find its edges on the black page) and a short H.264 clip.
  await Promise.all([
    ff("-f", "lavfi", "-i", "testsrc2=size=1179x2556:rate=1", "-frames:v", "1", "shots/phone.png"),
    ff("-f", "lavfi", "-i", "smptehdbars=size=1600x900:rate=1", "-frames:v", "1", "shots/wide.png"),
    ff("-f", "lavfi", "-i", `color=c=0x3478f6:size=${SMALL.width}x${SMALL.height}`, "-frames:v", "1", "shots/small.png"),
    ff("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", "shots/flow.mp4"),
  ]);
  const project = await api<Project>("POST", "/projects", { path: dir, name: "media", key: "MEDIA", defaultDriver: "dummy" });
  // In viewer order (1 of 5 … 5 of 5); the alt text is the file name, which the app's labels use.
  const stored = ["phone.png", "wide.png", "small.png", "flow.mp4"];
  // The three screenshots as a row of thumbnails, the recording as a captioned figure.
  const spec = [
    "Show the greeting screen",
    "",
    "Here's the new greeting screen, before and after, plus a recording of the flow.",
    "",
    `![phone.png](shots/phone.png "thumb") ![wide.png](shots/wide.png "thumb") ![small.png](shots/small.png "thumb")`,
    "",
    "![flow.mp4](shots/flow.mp4)",
    "",
    "![broken.png](attachment:att_missing)",
  ].join("\n");
  const call = { name: "update_spec", input: { spec, note: "Screenshots and a recording of the greeting screen", base_revision: 1 } };
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `Show the greeting screen\n/tools ${JSON.stringify([call])}`, driver: "dummy", start: true });
  // After the call, the dummy adds a Status section (edit_spec) and submits; the review approves.
  await settle(ticket.key, (t) => t.status === "review" && !t.busy);
  const d = await api<TicketDetail>("GET", `/tickets/${encodeURIComponent(ticket.key)}`);
  const srcs = [...d.ticket.spec.matchAll(/!\[([^\]]*)\]\(attachment:([^)\s]+)(?: "[^"]*")?\)/g)].map((m) => ({ alt: m[1]!, id: m[2]! }));
  const rewritten = srcs.filter((s) => stored.includes(s.alt) && s.id !== "att_missing");
  if (rewritten.length !== stored.length || !srcs.some((s) => s.alt === "broken.png" && s.id === "att_missing")) {
    throw new Error(`the spec doesn't show ${stored.length} stored attachments and the missing one: ${JSON.stringify(d.ticket.spec)}`);
  }
  if (d.ticket.spec.includes("](shots/")) throw new Error(`a local src wasn't rewritten: ${JSON.stringify(d.ticket.spec)}`);
  return { project, ticket };
}

/** --attachments: inline images in the Spec tab, then the viewer (open, page, close, swipe down), in one visit. */
async function attachmentChecks(udid: string, p: Awaited<ReturnType<typeof seedAttachments>>) {
  selector.sequence();
  const has = async (pred: (l: string) => boolean) => (await labels(udid)).some(pred);
  const counter = (n: number) => (l: string) => l.startsWith(`${n} of 5`);
  const viewerOpen = () => has((l) => / of 5/.test(l));
  const closed = () => until("viewer closed", async () => !(await viewerOpen()), 5000);
  const swipeLeft = () => axe("swipe", "--start-x", "340", "--start-y", "450", "--end-x", "40", "--end-y", "450", "--duration", "0.3", "--udid", udid);
  const swipeDown = () => axe("swipe", "--start-x", "200", "--start-y", "330", "--end-x", "205", "--end-y", "760", "--duration", "0.25", "--udid", udid);
  /**
   * Opens the viewer from an inline image; its fade-in swallows gestures for a moment. The spec
   * stacks the images (the phone shot is up to 480 pt tall), so the one asked for is scrolled into
   * view first and tapped near its top, clear of the composer.
   */
  const open = async (label: string, n: number) => {
    if (await viewerOpen()) await tapWhere(udid, "Close").then(closed);
    await scrollTo(udid, (l) => l === label);
    // A tap while the scroll's momentum is still running is swallowed as the touch that stops it,
    // so the first one may only settle the list, and the spec re-renders while the seeded run's last updates land: tap again where the image has come to rest.
    for (let attempt = 1; ; attempt++) {
      let el = await until(`element ${label}`, () => findElement(udid, (l) => l === label), 5000);
      // Scrolled to the very top, an image sits under the pinned tab strip, which takes the tap:
      // drag the spec down until it's clear of it.
      for (let i = 0; i < 2 && el.frame.y < 300; i++) {
        await axe("swipe", "--start-x", "200", "--start-y", "420", "--end-x", "200", "--end-y", "560", "--duration", "0.3", "--udid", udid);
        el = await until(`element ${label}`, () => findElement(udid, (l) => l === label), 5000);
      }
      const y = el.frame.y + Math.min(el.frame.height / 2, 60);
      await axe("tap", "-x", String(Math.round(el.frame.x + el.frame.width / 2)), "-y", String(Math.round(y)), "--udid", udid);
      const up = await until(`viewer on ${n} of 5`, () => has(counter(n)), attempt < 3 ? 2500 : 5000).then(() => true, async (e) => {
        if (attempt < 3) return false;
        console.log(`    tapped ${label} at y=${Math.round(y)}; on screen: ${(await labels(udid)).slice(0, 40).join(" | ")}`);
        throw e;
      });
      if (up) break;
    }
    await sleep(800);
  };

  await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=spec`, (l) => l.includes("Image phone.png"));
  await sleep(1200); // let the images and the video's first frame load
  // Every attachment inline, the thumbnails' 100 pt squares and the full-width figure are the spec-attachments snapshot.
  await shootBoth(udid, "attachments-inline");
  await check("tapping an inline image opens the viewer on it; swiping pages; Close closes", async () => {
    await open("Image wide.png", 2);
    // The viewer is black in both themes. The video and the broken file sit further down the spec,
    // so page to them here.
    await shootBoth(udid, "attachments-viewer-image");
    await appearance(udid, "light");
    await swipeLeft();
    await until("paged to 3 of 5", () => has(counter(3)), 5000);
    await swipeLeft();
    await until("paged to 4 of 5", () => has(counter(4)), 5000);
    await sleep(1500); // the video's first frames
    await shot(udid, "attachments-viewer-video-light");
    await swipeLeft();
    await until("paged to 5 of 5", () => has(counter(5)), 5000);
    await atRest(udid, 800);
    await shot(udid, "attachments-viewer-failed-light");
    await tapWhere(udid, "Close");
    await closed();
    return "2 of 5 → 3 of 5 → 4 of 5 → 5 of 5 → closed";
  });
  await check("an image smaller than the screen opens centred at its own size", async () => {
    // A 300 × 652 image used to open with its top-left corner in the middle of the page: it already
    // had its fitted size, so its scroll view's content size was never set.
    await open("Image small.png", 3);
    await shot(udid, "attachments-viewer-small", true); // the check reads its pixels
    const file = join(shots, "attachments-viewer-small.png");
    const screen = (await tree(udid))[0]!.frame;
    const px = Number(await sh(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file]));
    const scale = px / screen.width;
    // Below the header (✕ and the file name) and above the home indicator, the page is black but for the image.
    const box = await litBox(file, Math.round(130 * scale), Math.round(40 * scale));
    const pt = { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
    const shown = `${Math.round(pt.width)}×${Math.round(pt.height)} at ${Math.round(pt.x)},${Math.round(pt.y)} on a ${screen.width}×${screen.height} screen`;
    if (Math.abs(pt.width - SMALL.width) > 3 || Math.abs(pt.height - SMALL.height) > 3) throw new Error(`not at its own size (${SMALL.width}×${SMALL.height}): ${shown}`);
    if (Math.abs(pt.x + pt.width / 2 - screen.width / 2) > 3) throw new Error(`not centred across: ${shown}`);
    await tapWhere(udid, "Close");
    await closed();
    return shown;
  });
  await check("swiping down closes the viewer", async () => {
    await open("Image phone.png", 1);
    await swipeDown();
    await closed();
    return "closed";
  });
  await check("the video page plays and swiping down closes it too", async () => {
    await open("Image small.png", 3);
    await swipeLeft();
    await until("on the video", () => has(counter(4)), 5000);
    await sleep(1000);
    await swipeDown();
    await closed();
    return "closed";
  });
}

// ---------------------------------------------------------------- walk-through
type Seeded = Awaited<ReturnType<typeof seed>>;
interface Screen extends Entry {
  kind: "screen";
  url: string;
  /** Validation also runs its prepare and after (real taps with their own asserts), not just the visit. */
  interactive?: boolean;
  /** Extra wait after the labels settle, for pixels that land later (a streamed frame, a diff). */
  wait?: number;
  /** About how long the visit takes on an idle Mac (default 4 s), to split the screens evenly. */
  seconds?: number;
  ready?: (l: string[]) => boolean;
  /** It shows the /browse ticket, so it waits for that run to finish (the list puts these last). */
  browse?: boolean;
  /** Taps to make before the shot. */
  prepare?: (udid: string) => Promise<unknown>;
  /** Taps after the shot, to close what prepare opened (a sheet or an action sheet a deep link doesn't dismiss). */
  after?: (udid: string) => Promise<unknown>;
  /** Waits out the redraw after the appearance flips, for a screen slower than FLIP_MS (a plugin's WebView reloads). */
  redrawn?: (udid: string) => Promise<unknown>;
}
/** New session's Options disclosure ("Options", or "Options, <what differs>"). */
const isOptions = (l: string) => l === "Options" || l.startsWith("Options, ");
/** Opens New session's Options (collapsed on open) and waits for its first row. */
async function openOptions(udid: string) {
  await tapWhere(udid, isOptions);
  await until("options open", async () => (await labels(udid)).some((l) => l.startsWith("Models, ")), 5000);
  await atRest(udid, 400);
}
/** The sheet's Cancel (xmark) header item; the glass header items may be missing from AXe's tree. */
async function tapHeaderCancel(udid: string) {
  const el = await findElement(udid, (l) => l === "Cancel");
  if (el) await axe("tap", "-x", String(Math.round(el.frame.x + el.frame.width / 2)), "-y", String(Math.round(el.frame.y + el.frame.height / 2)), "--udid", udid);
  else await axe("tap", "-x", "36", "-y", "89", "--udid", udid);
}
/** The iPad's sidebar column is up: its Inbox and All projects rows are on screen. */
const sidebarShown = (l: string[]) => l.includes("Inbox") && l.some((x) => x.startsWith("All projects"));
/**
 * Hides or shows the iPad's sidebar with the split view's own toggle. AXe may leave the glass header
 * items out of its tree, so without a "…Sidebar" label it taps where the toggle sits: the sidebar
 * column's trailing edge on the Projects title's line when shown, the bar's leading edge when hidden.
 */
async function toggleSidebar(udid: string, show: boolean) {
  const all = await nodes(udid);
  if (sidebarShown(all.map((n) => n.AXLabel ?? "")) === show) return;
  const toggle = all.find((n) => n.AXLabel && /sidebar/i.test(n.AXLabel));
  // A navigation title (the bar's line), not a sidebar row.
  const title = all.find((n) => n.frame.y < 90 && n.frame.y > 20 && (n.AXLabel === "Projects" || n.AXLabel === "All projects"));
  const inbox = all.find((n) => n.AXLabel === "Inbox" && n.frame.y > 100);
  const y = title ? title.frame.y + title.frame.height / 2 : 54;
  const [x, ty] = toggle
    ? [toggle.frame.x + toggle.frame.width / 2, toggle.frame.y + toggle.frame.height / 2]
    : show ? [32, y] : [inbox ? inbox.frame.x + inbox.frame.width - 16 : 268, y];
  await axe("tap", "-x", String(Math.round(x)), "-y", String(Math.round(ty)), "--udid", udid);
  await until(`sidebar ${show ? "shown" : "hidden"}`, async () => sidebarShown(await labels(udid)) === show, 8000);
  await atRest(udid, 500);
}
/** A ticket screen for `key` is up: its key and its tab strip. */
const ticketShown = (l: string[], key: string) => l.includes(key) && l.includes("Spec") && l.includes("Details");
function screens(s: Seeded): Screen[] {
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const hasLabel = (x: string) => (l: string[]) => l.includes(x);
  const pluginLoaded = (l: string[]) => l.includes("Changes") && !l.includes("In progress");
  /** A catalog entry. `visit` screens validation opens, to check the app survives them (no shot, no taps). */
  const screen = (name: string, needs: SeedName[], rest: Omit<Screen, "name" | "kind" | "needs">): Screen => ({ name, kind: "screen", needs, ...rest });
  return [
    // The iPad keeps the sidebar in a split view column (harness://projects only shows it), so it
    // shoots the board with the sidebar hidden instead, and the link brings the sidebar back.
    ipad
      ? screen("board-no-sidebar", [], {
          url: BOARD,
          seconds: 8,
          visit: true,
          prepare: (udid) => toggleSidebar(udid, false),
          after: (udid) => simctl("openurl", udid, "harness://projects").then(() => until("sidebar shown again", async () => sidebarShown(await labels(udid)), 8000)),
        })
      : screen("projects", [], { url: "harness://projects", visit: true }),
    screen("ticket-spec", ["hello"], { url: `harness://ticket/${k(s.hello)}?tab=spec` }),
    // The notes, submits and review decisions; the seed's reply went to the transcript only.
    screen("ticket-activity", ["hello"], { url: `harness://ticket/${k(s.hello)}?tab=activity`, ready: (l) => l.some((x) => x.includes("The dummy reviewer approves")) }),
    screen("ticket-transcript", ["hello"], { url: `harness://ticket/${k(s.hello)}?tab=transcript` }),
    screen("ticket-details", ["hello"], { url: `harness://ticket/${k(s.hello)}?tab=details` }),
    // The spec's fenced code: plain at first, colored once its grammar has loaded.
    screen("ticket-code", ["code"], { url: `harness://ticket/${k(s.code)}?tab=spec`, wait: 1500, visit: true }),
    // Heading sizes and spacing (HarnessKit's SpecHeadings tests have the numbers).
    screen("ticket-headings", ["headings"], { url: `harness://ticket/${k(s.headings)}?tab=spec`, ready: (l) => l.includes("Heading four"), wait: 500 }),
    // The file viewer, from an OS-level harness://file link : opened at a range
    // below the first screenful, then its Diff tab.
    screen("file", ["changes"], { url: `harness://file/${GREETINGS_PATH}?ticket=${k(s.changes)}#L${GREET_JA[0]}-L${GREET_JA[1]}`, ready: hasLabel("Modified"), wait: 1500 }),
    screen("file-diff", ["changes"], {
      url: `harness://file/${GREETINGS_PATH}?ticket=${k(s.changes)}`,
      ready: hasLabel("Modified"),
      seconds: 6,
      prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Diff")).then(() => sleep(1500)),
    }),
    screen("conductor-tickets", ["conductor"], { url: `harness://ticket/${k(s.conductor)}?tab=children`, visit: true }),
    screen("ticket-agents", ["agents"], { url: `harness://ticket/${k(s.agents)}?tab=agents` }),
    screen("ticket-subagent", ["agents"], { url: `harness://ticket/${k(s.agents)}?tab=${encodeURIComponent(`agent:${s.nestedAgent.id}`)}`, visit: true }),
    screen("approval", ["approval"], { url: `harness://ticket/${k(s.approval)}`, ready: hasLabel("Allow once"), visit: true }),
    screen("blocked", ["blocked"], { url: `harness://ticket/${k(s.blocked)}` }),
    screen("planning", ["plan"], { url: `harness://ticket/${k(s.plan)}`, ready: hasLabel("Start work") }),
    // The plugin's WebView shows a spinner ("In progress") until its page has loaded, and reloads
    // when the appearance flips.
    screen("changes", ["changes"], { url: `harness://ticket/${k(s.changes)}?tab=plugin:git:changes`, ready: pluginLoaded, wait: 500, seconds: 9, visit: true, redrawn: (udid) => sleep(FLIP_MS).then(() => until("plugin reloaded", async () => pluginLoaded(await labels(udid)), 8000).catch(() => {})) }),
    // The git project's New session with Options open: the TicketSettings rows Details shows.
    screen("new-session-options", [], { url: `harness://new?projectId=${s.project.id}`, ready: (l) => l.some(isOptions), seconds: 6, visit: true, prepare: (udid) => openOptions(udid) }),
    // The same, with the branch sheet open, searching "re": Create re, then release/v2 (checked
    // out in another worktree).
    screen("new-session-branch", [], {
      url: `harness://new?projectId=${s.project.id}`,
      ready: (l) => l.some(isOptions),
      seconds: 7,
      prepare: (udid) =>
        openOptions(udid)
          .then(() => tapWhere(udid, (l) => l.startsWith("Branch, ")))
          .then(() => until("branch sheet", async () => (await labels(udid)).includes("Search branches"), 5000))
          // The field takes focus as the sheet finishes sliding up; typing before that drops keys.
          .then(() => atRest(udid, 800))
          .then(() => axe("type", "re", "--udid", udid))
          .then(() => until("branch rows", async () => (await labels(udid)).some((x) => x.startsWith("release/v2")), 5000)),
      // The sheet is a Modal, which the next screen's deep link would leave on top.
      after: (udid) => tapWhere(udid, "Cancel").then(() => until("branch sheet closed", async () => !(await labels(udid)).includes("Search branches"), 5000)),
    }),
    // The seeded draft reopened, then Cancel: the Save draft / Discard draft / Keep editing sheet.
    screen("new-session-cancel", ["draft"], {
      url: `harness://new?key=${k(s.draft)}`,
      ready: (l) => l.some(isOptions),
      seconds: 6,
      prepare: (udid) => tapHeaderCancel(udid).then(() => until("cancel sheet", async () => (await labels(udid)).includes("Discard draft"), 5000)).then(() => atRest(udid, 500)),
      after: (udid) => tapWhere(udid, "Keep editing").then(() => atRest(udid, 400)),
    }),
    // A ticket linked to a remote ID: the header shows "JIRA-62 · GREET-n" (RelatedTests has the rules).
    screen("ticket-linked", ["linked"], {
      url: `harness://ticket/${k(s.linked)}?tab=details`,
    }),
    // Details' per-phase Models picker with its sheet open.
    screen("ticket-details-model", ["quick"], {
      url: `harness://ticket/${k(s.quick)}?tab=details`,
      seconds: 7,
      prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Models, ")).then(() => until("model sheet", async () => (await labels(udid)).includes("Search models"), 5000)),
      // The sheet is a Modal, which the next screen's deep link would leave on top.
      after: (udid) => tapWhere(udid, "Done").then(() => until("model sheet closed", async () => !(await labels(udid)).includes("Search models"), 5000)),
    }),
    screen("inbox", ["watchers"], { url: "harness://inbox", visit: true }),
    // Settings: Drivers, with the per-phase Models picker under them. A scrolled part of it is one
    // --shot=harness://settings --prepare='scroll:Models, ' away.
    screen("settings", ["watchers"], { url: "harness://settings", visit: true }),
    // A driver's own settings: status and sign-in, and the long-lived token.
    screen("driver-claude-code", [], { url: "harness://driver/claude-code", ready: hasLabel("Claude token") }),
    screen("watcher-edit", ["watchers"], { url: `harness://watcher?id=${encodeURIComponent(s.watcher.id)}` }),
    screen("project-settings", [], { url: `harness://project/${s.project.id}` }),
    // A git ticket in review: the Approve button's menu (merge, clean up, Approve and…, take no action).
    // It closes again before the next screen.
    screen("approve-menu", ["agents"], {
      url: `harness://ticket/${k(s.agents)}`,
      ready: hasLabel(APPROVE_MORE),
      seconds: 6,
      prepare: (udid) => tapWhere(udid, APPROVE_MORE).then(() => approveMenuUp(udid)).then(() => atRest(udid, 500)),
      // The menu closes with a tap outside it. SIM_CHECK_LEAVE_OPEN=1 leaves it up, to watch the next
      // step's reset clear it (`--only=approve-menu,connect`).
      after: (udid) => (process.env.SIM_CHECK_LEAVE_OPEN ? Promise.resolve() : dismissMenu(udid).then(() => atRest(udid, 400))),
    }),
    // Settings → Prompts (seedPrompts): the list, and the customized review message.
    screen("prompts", [], { url: "harness://prompts", ready: hasLabel("Agent review") }),
    screen("prompt-customized", [], { url: "harness://prompt/run.review", ready: hasLabel("Reset to built-in") }),
    screen("connect", [], { url: "harness://connect", visit: true }),
    // The board lands on whichever column had work when it first loaded, mid-seed; show Blocked.
    screen("board", ["blocked"], { url: BOARD, browse: true, prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Blocked,")).then(() => atRest(udid, 700)) }),
    // Planning with the seeded draft's dashed card (Draft badge, no run).
    screen("board-draft", ["draft"], {
      url: BOARD,
      seconds: 8,
      // Planning is the first column; its chip may sit off the strip's left edge, so page back to it.
      prepare: async (udid) => {
        const card = (l: string) => l.startsWith(`${s.draft.key} `) && l.endsWith(", draft");
        await until("draft card on screen", async () => {
          const el = await findElement(udid, card);
          if (el && el.frame.x >= 0 && el.frame.x < 100) return el;
          await axe("swipe", "--start-x", "40", "--start-y", "600", "--end-x", "380", "--end-y", "600", "--duration", "0.25", "--udid", udid);
          await atRest(udid, 500);
          return null;
        }, 12000, 0);
        await atRest(udid, 500);
      },
    }),
    screen("browser", ["browse"], { url: `harness://ticket/${k(s.browse)}?tab=browser`, wait: 2000, browse: true, seconds: 6 }),
    ...(ipad
      ? [
          // A tab torn off into a window of its own (its chip's menu → Open in New Window): the
          // ticket's window shows Return to this window in its place, and pressing it closes the
          // pinned window and shows the tab here again.
          {
            kind: "screen",
            needs: ["hello"],
            visit: true,
            interactive: true,
            name: "ticket-tear-off",
            url: `harness://ticket/${k(s.hello)}?tab=transcript`,
            seconds: 14,
            ready: (l: string[]) => ticketShown(l, s.hello.key),
            prepare: async (udid: string) => {
              const key = s.hello.key;
              await tapWhere(udid, "Transcript", { longPress: 1.2 });
              await tapWhere(udid, "Open in New Window");
              await until("the pinned window up", async () => (await labels(udid)).includes(`${key} · Transcript`), 10000);
              moved(udid);
              await sleep(800);
              await shot(udid, "ticket-tear-off-window");
              // Back to the ticket's own window (open: the link brings it forward on its Transcript).
              await simctl("openurl", udid, `harness://ticket/${k(s.hello)}?tab=transcript`);
              await until("the placeholder in the ticket's window", async () => (await labels(udid)).includes("Transcript is in another window"), 10000);
              await sleep(800);
            },
            after: async (udid: string) => {
              const key = s.hello.key;
              await tapWhere(udid, "Return to this window");
              const closed = await until("the pinned window closed and the tab back", async () => {
                const l = await labels(udid);
                return !l.includes(`${key} · Transcript`) && !l.includes("Transcript is in another window") && ticketShown(l, key);
              }, 10000).catch((e) => e as Error);
              await sleep(800);
              await shot(udid, "ticket-tear-off-returned");
              if (closed instanceof Error) throw closed;
              await simctl("openurl", udid, BOARD);
              await until("main window back", async () => onBoard(await labels(udid)), 10000);
              // The ticket is in the side panel over the board; close it for the screens after.
              if ((await labels(udid)).includes(`Close ${key}`)) await tapWhere(udid, `Close ${key}`);
              moved(udid);
            },
          } satisfies Screen,
        ]
      : []),
  ];
}
/** Deals `items` out to `n` lanes so each gets about the same total `weight`, keeping their order within a lane. */
function lanes<T>(items: T[], n: number, weight: (t: T) => number): T[][] {
  const out = Array.from({ length: n }, () => [] as T[]);
  const load = Array<number>(n).fill(0);
  for (const it of items) {
    const i = load.indexOf(Math.min(...load));
    out[i]!.push(it);
    load[i]! += weight(it);
  }
  return out;
}

/** --themes: per theme, the settings deep link applies it; then Settings and the board in it. */
async function themeScreens(udid: string) {
  for (const id of themeShots) {
    const theme = findTheme(id)!;
    await appearance(udid, theme.appearance);
    await goto(udid, `harness://settings?${theme.appearance}Theme=${id}`);
    await sleep(800);
    // Scroll down to the Appearance pickers.
    await axe("swipe", "--start-x", "200", "--start-y", "780", "--end-x", "200", "--end-y", "260", "--duration", "1", "--udid", udid);
    await sleep(900);
    await shot(udid, `settings-${id}`);
    await goto(udid, BOARD, (l) => onBoard(l) && l.some((x) => /^[A-Z]+-\d+ /.test(x)));
    await sleep(600);
    await shot(udid, `board-${id}`);
  }
  // Back to the defaults for the light/dark pass.
  await goto(udid, "harness://settings?lightTheme=harness-light&darkTheme=harness-dark");
  await sleep(600);
}

/** The screens on one simulator, each in light and dark. Returns the names the app crashed on. */
async function shootScreens(udid: string, list: Screen[], browsed: Promise<unknown>): Promise<string[]> {
  const crashed: string[] = [];
  for (const s of list) {
    if (s.browse) await timed("waiting for the browse ticket", () => browsed.catch(() => {}));
    await timed(`screen: ${s.name}`, async () => {
      const shown = await timed(`  goto: ${s.name}`, () => goto(udid, s.url, s.ready));
      if (s.wait) await sleep(s.wait);
      // A ticket opened by an earlier screen is docked under the tabs: away with it, for a clean shot.
      if (!/^harness:\/\/(ticket|new)\b/.test(s.url) && lastTree.get(udid)?.includes(", docked")) await undock(udid).catch(() => {});
      if (s.prepare) await s.prepare(udid).catch((e) => console.log(`  ${s.name}: ${(e as Error).message.split("\n")[0]}`));
      const [, alive] = await Promise.all([timed(`  shoot: ${s.name}`, () => shootBoth(udid, s.name, s.redrawn && (() => s.redrawn!(udid)))), shown ? true : running(udid)]);
      if (s.after) await s.after(udid).catch((e) => console.log(`  ${s.name}: ${(e as Error).message.split("\n")[0]}`));
      if (alive) console.log(`  ${join(shots, s.name)}-{light,dark}.png`);
      else {
        console.log(`✗ ${s.name}: the app crashed opening ${s.url}`);
        crashed.push(s.name);
      }
    });
  }
  return crashed;
}

/** The routes the iPad run visits: the ones whose layout differs on an iPad. */
const IPAD_ROUTES = new Set(["board-no-sidebar", "ticket-spec", "ticket-tear-off", "conductor-tickets", "new-session-options", "settings", "changes"]);
/**
 * Validation's pass over the catalog: each `visit` screen is opened and the app checked for a crash.
 * No shot and no theme flip, and no taps unless the screen is `interactive`. One result for all.
 */
async function visitScreens(udid: string, list: Screen[]) {
  selector.sequence();
  const crashed: string[] = [];
  await check(`${list.length} routes open without crashing the app`, async () => {
    for (const sc of list) {
      // The tickets opened by earlier routes are docked under this one: away with them, for a clean board.
      if (!/^harness:\/\/(ticket|new)\b/.test(sc.url) && lastTree.get(udid)?.includes(", docked")) await clearDock(udid).catch(() => {});
      await timed(`visit: ${sc.name}`, async () => {
        const shown = await goto(udid, sc.url, sc.ready);
        if (!shown) console.log(`    ${sc.name}: no settled screen`);
        if (sc.interactive) {
          if (sc.prepare) await sc.prepare(udid).catch((e) => console.log(`  ${sc.name}: ${(e as Error).message.split("\n")[0]}`));
          if (sc.after) await sc.after(udid).catch((e) => console.log(`  ${sc.name}: ${(e as Error).message.split("\n")[0]}`));
        }
        if (!shown && !(await running(udid))) crashed.push(sc.name);
      });
      if (crashed.length) break;
    }
    if (crashed.length) throw new Error(`the app crashed opening ${crashed.join(", ")}`);
    return list.map((x) => x.name).join(", ");
  }, 180_000);
  return crashed;
}

/**
 * --shot=<link>: one light and dark pair of any route, against the seeded daemon. `{name}` in the
 * link is a seeded ticket's key; --prepare=tap:<label>;scroll:<label> reaches a state a link can't.
 * Never fails on what it shows, only if the app crashes.
 */
async function oneShot(udid: string, url: string) {
  const steps = parsePrepare(opt("prepare"));
  const name = (opt("name") ?? url.replace(/^harness:\/\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)) || "shot";
  const shown = await goto(udid, url);
  for (const st of steps) {
    if (st.op === "tap") await tapWhere(udid, (l) => l === st.label || l.startsWith(st.label)).catch((e) => console.log(`  --prepare tap ${st.label}: ${(e as Error).message.split("\n")[0]}`));
    else await scrollTo(udid, (l) => l === st.label || l.startsWith(st.label)).catch((e) => console.log(`  --prepare scroll ${st.label}: ${(e as Error).message.split("\n")[0]}`));
    await atRest(udid, 500);
  }
  await shootBoth(udid, name);
  if (!shown && !(await running(udid))) throw new Error(`the app crashed opening ${url}`);
  console.log(`  ${join(shots, name)}-{light,dark}.png`);
}

/**
 * The real-tap checks, as chains that each run on one simulator; `seconds` (about what the chain
 * takes on an idle Mac) balances them. Every check reaches its screen with goto.
 */
type Chain = Entry & { kind: "chain"; seconds: number; run: (udid: string) => Promise<void> };
function interactionChains(s: Seeded): Chain[] {
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const chain = (name: string, needs: SeedName[], seconds: number, run: (udid: string) => Promise<void>, optIn = false): Chain => ({ name, kind: "chain", needs, seconds, run: async (udid) => {
      selector.sequence();
      await run(udid);
      // A ticket link opened over another docks it. Cards left docked cover the next chain's taps (the probe says whether any are, with no tree read).
      if ((await probe(udid))?.router.dock.length) await clearDock(udid).catch(() => {});
    }, optIn });
  return [
    // --sheets owns these (the iPhone's ticket sheet and the dock), and they run here only when named.
    chain("sheet-checks", ["conductor"], 40, (udid) => sheetChecks(udid, s), true),
    chain("dock-stack", ["conductor"], 70, (udid) => dockStackChecks(udid, s), true),
    chain("agent-notes", ["noted"], 10, async (udid) => {
      await check("ticket details: agent notes start collapsed, and a tap on the header opens and closes them", async () => {
        await goto(udid, `harness://ticket/${k(s.noted)}?tab=details`, (l) => l.includes("Agent notes"));
        const body = async () => (await labels(udid)).some((l) => l.includes("Where things live"));
        const open = async () => (await nodes(udid)).some((n) => n.AXUniqueId === "agent-notes");
        if ((await body()) || (await open())) throw new Error("the agent notes are open before any tap");
        await tapWhere(udid, "Agent notes");
        await until("agent notes open", async () => (await body()) && (await open()), 5000).catch(async () => {
          await shot(udid, "agent-notes-failed");
          throw new Error(`the tap did not open the agent notes; on screen: ${(await labels(udid)).slice(0, 40).join(" | ")}`);
        });
        await tapWhere(udid, "Agent notes");
        await until("agent notes closed", async () => !(await body()) && !(await open()), 5000);
        return "collapsed; opens and closes on a tap";
      });
    }),
    // A spec with wide tables leaving the replies on screen is the transcript-wide-tables snapshot.
    chain("blocked-composer", ["blocked"], 5, async (udid) => {
      await check("composer answers a blocked ticket", async () => {
        await goto(udid, `harness://ticket/${k(s.blocked)}`, (l) => l.some((x) => x.startsWith("Message the agent")));
        await tapWhere(udid, (l) => l.startsWith("Message the agent"));
        // A message to a blocked ticket is a chat; the dummy picks the work back up only when told to.
        await axe("type", "[dummy:unblock]", "--udid", udid); // typing costs about 0.2 s a key (0.5 s with Shift): the shortest text that does the job
        await tapWhere(udid, "Send");
        // The ticket leaving blocked is the service's (steering.test.ts, the unblock tool's tests), over the body
        // launchBodies.json shares with HarnessClientTests; here it's the tap, and the tab switch (TabsTests).
        // A sent message opens the Transcript, where it and the reply show (never in Activity): the
        // ticket opened on its Spec, so the transcript's run rows on screen mean the tab switched.
        await until("the Transcript", async () => (await labels(udid)).some((l) => RUN_HEADER.test(l)) || null, 10000).catch(async (e: Error) => {
          await shot(udid, "composer-sent-transcript-failed");
          throw new Error(`${e.message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await shot(udid, "composer-sent-transcript");
        return "Transcript shown";
      });
    }),
    // A reply's list items showing their text is the transcript-reply-list snapshot.
    chain("approve-and", ["agents"], 8, async (udid) => {
      await check("Approve menu → Approve and… takes typed instructions and approves", async () => {
        const text = "v2"; // typing costs about 0.2 s a key: the sheet needs some instructions, not these
        await goto(udid, `harness://ticket/${k(s.agents)}`, (l) => l.includes(APPROVE_MORE));
        await tapWhere(udid, APPROVE_MORE);
        await approveMenuUp(udid);
        await tapWhere(udid, "Approve and…");
        await tapWhere(udid, instructionsField);
        await atRest(udid, 500); // the keyboard comes up: typing before it does drops keys
        await axe("type", text, "--udid", udid);
        await tapWhere(udid, "Approve");
        // What the service stores for the body this sends is ApproveTests.approveRequest (builds it) plus completion.test.ts
        // "every review body HarnessKit's Approve builds…" (reads the same fixture); this proves the sheet sent one.
        const t = await settle(s.agents.key, (x) => x.humanReview === "approved", 15000);
        return `${t.key} approved → ${t.status}`;
      });
    }),
    chain("prompt-editor", ["hello"], 14, async (udid) => {
      const override = async (id: string) => (await api<PromptEntry[]>("GET", "/prompts")).find((p) => p.id === id)!.override;
      const field = (l: string) => l === "Work run instructions prompt";
      // The header's glass buttons aren't in AXe's tree: Cancel sits where Back does, Save at the trailing edge.
      const tapCancel = () => axe("tap", "-x", "32", "-y", "89", "--udid", udid);
      const tapSave = async () => axe("tap", "-x", String(Math.round((await tree(udid))[0]!.frame.width - 32)), "-y", "89", "--udid", udid);
      await check("prompt editor: a bad variable shows inline and can't save; Save stores the fixed override, Reset to built-in (confirmed) clears it", async () => {
        await goto(udid, "harness://prompt/system.work", (l) => l.includes("Customize"));
        await tapWhere(udid, "Customize");
        await until("editor", async () => (await labels(udid)).includes("Compare with built-in"), 5000);
        await tapWhere(udid, field);
        await axe("type", " {{brnch}}", "--udid", udid);
        await until("inline error", async () => (await labels(udid)).some((l) => l.startsWith("Unknown variable {{brnch}}")), 5000);
        await shot(udid, "prompt-invalid-light");
        await tapSave(); // disabled while invalid
        await atRest(udid, 300);
        if ((await override("system.work")) !== null) throw new Error("an invalid prompt was saved");
        // Take the bad variable back out (its ten characters) and write a good line instead.
        await axe("key-sequence", "--keycodes", Array(10).fill("42").join(","), "--delay", "0.02", "--udid", udid);
        await axe("type", " x{{branch}}", "--udid", udid);
        await until("the error gone", async () => !(await labels(udid)).some((l) => l.startsWith("Unknown variable")), 5000);
        await tapSave();
        const saved = await until("override saved", async () => ((v) => (v?.includes("x{{branch}}") ? v : null))(await override("system.work")), 8000);
        await until("Reset button", async () => (await labels(udid)).includes("Reset to built-in"), 5000);
        await shot(udid, "prompt-saved-light");
        // Typing left the editor scrolled to the end of the long work prompt, above the button.
        await scrollTo(udid, (l) => l === "Reset to built-in");
        await tapWhere(udid, "Reset to built-in");
        // The confirm alert: its buttons are in the AX tree before it takes taps (the
        // alert drops a tap that lands during its presentation), so let it settle first.
        await until("confirm alert", () => findElement(udid, (l) => l === "Reset"), 5000);
        await atRest(udid, 600);
        await tapWhere(udid, "Reset");
        await until("override cleared", async () => (await override("system.work")) === null, 8000);
        await until("read-only again", async () => (await labels(udid)).includes("Customize"), 5000);
        moved(udid);
        return `saved ${saved.length} chars, then reset`;
      });
      // The seeded review message is short, so its end and its variables share the screen.
      await check("prompt editor: a tapped variable goes in at the cursor, and the next key follows it", async () => {
        const seeded = await override("run.review");
        await goto(udid, "harness://prompt/run.review", (l) => l.includes("Reset to built-in"));
        const el = await until("editor field", () => findElement(udid, (l) => l === "Agent review prompt"), 5000);
        // Its last line, past the end of the text: the cursor goes to the end.
        await axe("tap", "-x", String(Math.round(el.frame.x + el.frame.width - 20)), "-y", String(Math.round(el.frame.y + el.frame.height - 16)), "--udid", udid);
        await atRest(udid, 400);
        await tapWhere(udid, (l) => l.startsWith("{{key}}"));
        await atRest(udid, 500);
        await axe("type", "Z", "--udid", udid);
        await atRest(udid, 300);
        await tapSave();
        const saved = await until("override saved", async () => ((v) => (v !== seeded ? v : null))(await override("run.review")), 8000).catch(async (e) => {
          await shot(udid, "prompt-variable-failed");
          const f = (await nodes(udid)).find((n) => n.AXLabel === "Agent review prompt");
          throw new Error(`${(e as Error).message}; the field reads ${JSON.stringify(f?.AXValue?.slice(-60))}; on screen: ${(await labels(udid)).slice(0, 12).join(" | ")}`);
        });
        await api("PATCH", "/settings", { prompts: { "run.review": seeded } });
        moved(udid);
        if (!saved?.endsWith("then the diff.{{key}}Z")) throw new Error(`expected the text to end "then the diff.{{key}}Z", got ${JSON.stringify(saved)}`);
        return `ends ${JSON.stringify(saved.slice(-24))}`;
      });
    }),
    chain("models-picker", ["branchPlan"], 5, async (udid) => {
      const openModels = async () => {
        await goto(udid, `harness://ticket/${k(s.branchPlan)}?tab=details`, (l) => l.some((x) => x.startsWith("Models, ")));
        await tapWhere(udid, (l) => l.startsWith("Models, "));
        await until("model sheet", async () => (await labels(udid)).includes("Search models"), 5000);
      };
      // The sheet stays open after a pick: Done closes it before the next deep link.
      const closeModels = () => tapWhere(udid, "Done").then(() => until("model sheet closed", async () => !(await labels(udid)).includes("Search models"), 5000));
      await check("ticket details: tapping a model in the Models picker saves it to the phase", async () => {
        await openModels();
        // Narrow the list first: the sheet is lazy, and a long driver list ahead of Dummy (Claude
        // Code's models) can leave its rows unrealized and out of AXe's tree.
        await tapWhere(udid, "Search models");
        await axe("type", "slow", "--udid", udid);
        await tapWhere(udid, (l) => l.startsWith("Work, ") && l.endsWith("Dummy Slow"));
        const picked = await settle(s.branchPlan.key, (x) => x.phaseModels?.work?.driver === "dummy" && x.phaseModels.work.model === "dummy-slow", 8000).catch(async (e) => {
          await shot(udid, "model-pick-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        // Each phase saving under its own key, and Defaults clearing one, are ModelsTests (phasePickPatchCases,
        // patchEncodesNullToClearAndOmitsTheRest, adviserResolvesLikeEveryPhaseAndPatchesPerPhase) and model-selection.test.ts.
        await closeModels();
        moved(udid);
        return `${picked.phaseModels?.work?.driver}/${picked.phaseModels?.work?.model}`;
      });
    }),
    chain("context-gauge", ["gauge", "gaugeMiss", "gaugeCompact"], 30, async (udid) => {
      const open = (t: { key: string }, ready: (l: string) => boolean) => goto(udid, `harness://ticket/${encodeURIComponent(t.key)}?tab=spec`, (ls) => ls.some(ready));
      const gaugeLabel = async (ready: (l: string) => boolean) =>
        until("the gauge", async () => (await labels(udid)).find(ready) ?? null, 8000).catch(async (e) => {
          throw new Error(`${e.message}; on screen: ${(await labels(udid)).join(" | ")}`);
        });
      const closeMenu = async () => {
        const root = (await tree(udid))[0]!.frame;
        // The About popover sits over the menu: one tap outside can close only the top one, and a menu left up covers the next deep link.
        for (let tap = 0; tap < 3; tap++) {
          await axe("tap", "-x", String(Math.round(root.width * 0.5)), "-y", String(Math.round(root.height * 0.9)), "--udid", udid);
          await atRest(udid, 400);
          const l = await labels(udid);
          if (!l.includes("Limit…") && !l.some((x) => x.startsWith("How much conversation the next run") || x.startsWith("A cache miss is a model call"))) break;
        }
      };
      // The label in each state (New, over the limit, the miss badge, Copilot's estimate) is the context-gauge-states snapshot.
      // The meta row's contents (the key, then the gauge, no status, project or Conductor pill) are the ticket-hero-gauge
      // and conductor-hero snapshots; a snapshot can't see the tap target, so that stays here.
      await check("the gauge's 44 pt tap target sits on the ticket key's row, after it", async () => {
        const hero = async (t: { key: string }, ready: (l: string) => boolean) => {
          await open(t, ready);
          await gaugeLabel(ready);
          const all = await nodes(udid);
          return { all, labels: all.map((n) => n.AXLabel ?? "") };
        };
        const { all, labels: ls } = await hero(s.gauge, (l) => l.startsWith("Context 82k"));
        const gaugeNode = all.find((n) => n.AXLabel?.startsWith("Context 82k"));
        const keyNode = all.find((n) => n.AXLabel === s.gauge.key);
        const titleNode = all.find((n) => n.AXLabel?.startsWith("Gauge gauge"));
        if (!gaugeNode || !keyNode || !titleNode) throw new Error(`missing: gauge ${!!gaugeNode} key ${!!keyNode} title ${!!titleNode}: ${ls.join(" | ")}`);
        // Its 44pt tap target may overlap the title's bottom padding; its middle is the row's.
        if (gaugeNode.frame.y + gaugeNode.frame.height / 2 < titleNode.frame.y + titleNode.frame.height) throw new Error(`the gauge sits in the title's row: ${JSON.stringify([gaugeNode.frame, titleNode.frame, keyNode.frame])}`);
        if (Math.abs(gaugeNode.frame.y + gaugeNode.frame.height / 2 - (keyNode.frame.y + keyNode.frame.height / 2)) > 12) throw new Error("the gauge is off the key's row");
        if (gaugeNode.frame.x < keyNode.frame.x) throw new Error("the gauge comes before the ticket key");
        if (gaugeNode.frame.height < 43) throw new Error(`the gauge's tap target is ${gaugeNode.frame.height}pt tall`);
        // The title sits 25pt under the hero's top, clear of the sheet's corner.
        await shot(udid, "hero-meta-row-light");
        return `gauge ${Math.round(gaugeNode.frame.y)} under the title ${Math.round(titleNode.frame.y)}`;
      });
      await check("a gauge opens its menu and its About popover", async () => {
        await open(s.gauge, (l) => l.startsWith("Context 82k"));
        // The label's text (cached/fresh split, no miss badge) is ContextGaugeTests.splitsCachedFromFresh and
        // anEstimateShowsAsteriskSingleToneAndNoMisses; the menu's items are the menu(...) tests there.
        await gaugeLabel((x) => x.startsWith("Context 82k"));
        await shot(udid, "gauge-normal-light");
        await tapWhere(udid, (x) => x.startsWith("Context 82k"));
        await until("the gauge menu", async () => ((x) => (x.includes("Limit…") ? x : null))(await labels(udid)), 5000);
        await shot(udid, "gauge-menu-light");
        await tapWhere(udid, "About this gauge");
        await until("the gauge info", async () => (await labels(udid)).some((x) => x.startsWith("How much conversation the next run")), 5000);
        await shot(udid, "gauge-info-light");
        await closeMenu();
        return "82k of 250k, menu and info";
      });
      await check("New session asks first, and Limit… opens the limit sheet", async () => {
        await open(s.gauge, (l) => l.startsWith("Context 82k"));
        await tapWhere(udid, (x) => x.startsWith("Context 82k"));
        await until("the menu", async () => (await labels(udid)).includes("New session"), 5000);
        await tapWhere(udid, "New session");
        await until("the confirmation", async () => (await labels(udid)).includes("Start a new session?"), 5000);
        await tapWhere(udid, "Cancel");
        await until("the alert gone", async () => !(await labels(udid)).includes("Start a new session?"), 5000);
        await tapWhere(udid, (x) => x.startsWith("Context 82k"));
        await until("the menu", async () => (await labels(udid)).includes("Limit…"), 5000);
        await tapWhere(udid, "Limit…");
        await until("the limit sheet", async () => (await labels(udid)).some((x) => x.startsWith("How many tokens the gauge counts up to")), 5000).catch(async (e) => {
          throw new Error(`${e.message}; on screen: ${(await labels(udid)).join(" | ")}`);
        });
        await shot(udid, "gauge-limit-light");
        // Left open it covers the next deep link, which then waits out whenShown's 12 s and a board reset.
        // The sheet's Cancel isn't in AXe's tree (a tap outside docks the ticket sheet beneath it, over every later chain):
        // it sits at the leading edge, 86 pt above the field's centre.
        const field = await until("the limit field", async () => (await nodes(udid)).find((n) => n.AXUniqueId === "context-limit-field"), 5000);
        await axe("tap", "-x", "61", "-y", String(Math.round(field.frame.y + field.frame.height / 2 - 86)), "--udid", udid);
        await until("the limit sheet closed", async () => !(await labels(udid)).some((x) => x.startsWith("How many tokens the gauge counts up to")), 5000);
        return "confirmed and cancelled; limit sheet open";
      });
      await check("the misses row in the gauge menu opens its explanation", async () => {
        await open(s.gaugeMiss, (l) => l.startsWith("Context 100k"));
        // "3 misses" and "3 cache misses (377k tokens re-written)" are ContextGaugeTests.missBadgeAndRowByCount.
        const l = await gaugeLabel((x) => x.startsWith("Context 100k"));
        await tapWhere(udid, (x) => x.startsWith("Context 100k"));
        await until("the menu", async () => ((x) => (x.includes("Limit…") ? x : null))(await labels(udid)), 5000);
        await shot(udid, "gauge-misses-light");
        await tapWhere(udid, (x) => x.startsWith("3 cache misses"));
        await until("the miss info", async () => (await labels(udid)).some((x) => x.startsWith("A cache miss is a model call")), 5000);
        await shot(udid, "gauge-misses-info-light");
        await closeMenu();
        return l;
      });
      await check("a compacting session shows the spinner gauge and a Compacting… composer", async () => {
        startCompactRun(s.gaugeCompact);
        await open(s.gaugeCompact, (l) => l === "Context, compacting");
        await gaugeLabel((x) => x === "Context, compacting");
        await until("the Compacting… composer", async () => (await labels(udid)).includes("Compacting…"), 5000);
        if ((await labels(udid)).includes("Message the agent")) throw new Error("the composer's field is still there");
        await shot(udid, "gauge-compacting-light");
        return "spinner, Compacting…";
      });
    }),
    chain("card-preview", ["hello"], 4, async (udid) => {
      await check("touch and hold on a card previews its ticket on the Spec tab, with no moves in the menu, and offers the ticket's actions", async () => {
        await goto(udid, BOARD);
        await tapWhere(udid, (l) => l.startsWith("Review,"));
        await until("card on screen", async () => ((await findElement(udid, (l) => l.startsWith(`${s.hello.key} `)))?.frame.x ?? 999) < 100, 3000).catch(() => {});
        await tapWhere(udid, (l) => l.startsWith(`${s.hello.key} `), { longPress: 1.2 });
        const l = await until("the menu", async () => ((x) => (x.includes("Copy key") ? x : null))(await labels(udid)), 5000).catch(async (e) => {
          await shot(udid, "board-card-preview-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await atRest(udid, 800);
        await shot(udid, "board-card-preview-light");
        const moves = l.filter((x) => x.startsWith("Move to"));
        if (moves.length) throw new Error(`the menu still moves cards: ${moves.join(", ")}`);
        // AXe sees the lifted preview as one "Preview" element, not the ticket screen inside it (the
        // screenshot shows that); a plain menu has none. A crash in the preview drops to SpringBoard,
        // whose Preview app has the label too, but no Copy key.
        if (!l.includes("Preview")) throw new Error(`no preview over the menu; on screen: ${l.slice(0, 30).join(" | ")}`);
        // A review card offers what its ticket screen does: Approve (a submenu of the ways to
        // approve), Request changes and the More menu's items.
        for (const want of ["Approve", "Request changes", "Delete ticket"]) {
          if (!l.some((x) => x === want || x.startsWith(`${want} `))) throw new Error(`the review card's menu has no ${want}; on screen: ${l.slice(0, 30).join(" | ")}`);
        }
        // Request changes needs notes: it opens the same sheet the ticket screen's button does.
        // A tap right after the menu's lift can be swallowed (it happens while a compacting run is still busy): tap again if the menu is still up.
        for (let attempt = 1; ; attempt++) {
          await tapWhere(udid, "Request changes");
          const up = await until("the notes sheet", async () => (await labels(udid)).includes("What should the agent change?"), attempt < 3 ? 3000 : 6000).then(() => true, () => false);
          if (up || attempt >= 3) break;
        }
        await until("the notes sheet", async () => (await labels(udid)).includes("What should the agent change?"), 6000).catch(async (e) => {
          await shot(udid, "board-card-request-changes-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await shot(udid, "board-card-request-changes-light");
        await tapWhere(udid, "Cancel");
        await until("the sheet gone", async () => !(await labels(udid)).includes("What should the agent change?"), 4000);
        return `${s.hello.key}: Spec preview, Approve / Request changes / Delete in the menu, Request changes opens the notes sheet`;
      });
      // A planning card's menu offering Start work, with no review actions, is BoardScreenRulesTests.aPlanningCardOffersStartWorkAndNoReviewActions.
    }),
    chain("agents-filter", ["tasks"], 5, (udid) => agentsFilterChecks(udid, s)),
    chain("file-link", ["fileLink"], 6, async (udid) => {
      await check("a relative file link in a spec opens the file viewer in the ticket's folder, at its lines", async () => {
        const label = "greetingFor fallback";
        await goto(udid, `harness://ticket/${k(s.fileLink)}?tab=spec`, (l) => l.includes(label));
        // The paragraph is as wide as the card and the link only its first words: tap near its start.
        const el = await until("the link", () => findElement(udid, (l) => l === label), 8000);
        await axe("tap", "-x", String(Math.round(el.frame.x + 30)), "-y", String(Math.round(el.frame.y + el.frame.height / 2)), "--udid", udid);
        moved(udid);
        const range = `lines ${GREETING_FOR[0]}–${GREETING_FOR[1]}`;
        const l = await until("the file viewer", async () => ((x) => (x.includes(GREETINGS_PATH) && x.some((y) => y.includes(range)) ? x : null))(await labels(udid)), 10000).catch(async (e) => {
          await shot(udid, "file-link-tap-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).join(" | ")}`);
        });
        // Its folder is the ticket's worktree (main's commit): the file is there, clean, and it has no Diff tab.
        if (l.includes("Modified") || l.some((x) => x.startsWith("Diff"))) throw new Error("a clean file shows as modified");
        // The code is a web view, which AXe can't see into: the probe reads the lines
        // the page marked (it scrolls and marks after the screen is up, so wait for them).
        const marked = await probeUntil(udid, "the linked lines marked in the editor", (x) => (x.editor?.markedLines.length ?? 0) > 0).then((x) => x.editor!.markedLines).catch(() => [] as string[]);
        await atRest(udid, 600);
        const colors = (await probe(udid))?.editor?.colors ?? 0;
        if (colors < 3) throw new Error(`the file's code isn't syntax colored in the editor: ${colors} colors`);
        await shot(udid, "file-link-tap-light");
        if (!marked[0]?.startsWith("export function greetingFor")) throw new Error(`the linked lines aren't marked in the editor: ${JSON.stringify(marked)}`);
        const want = GREETING_FOR[1] - GREETING_FOR[0] + 1;
        if (marked.length !== want) throw new Error(`${range} marks ${marked.length} lines in the editor, expected ${want}: ${JSON.stringify(marked)}`);
        return `${GREETINGS_PATH}, ${range}`;
      });
    }),
    chain("palette", ["fileLink"], 8, async (udid) => {
      const PALETTE = (l: string[]) => l.includes("New Session…, General") || l.some((x) => x.startsWith("New Session…"));
      const row = (prefix: string) => (l: string) => l.startsWith(prefix);
      await check("the bottom bar's field opens the palette; Show child tickets runs and its label flips", async () => {
        await goto(udid, BOARD);
        await atRest(udid, 500);
        await tapHeader(udid, "Command palette", { x: 192, y: 811 });
        await until("the palette's commands", async () => PALETTE(await labels(udid)), 8000);
        await tapWhere(udid, row("Show child tickets"));
        await until("the palette closed", async () => (await probe(udid))?.router.sheet == null, 8000);
        await tapHeader(udid, "Command palette", { x: 192, y: 811 });
        await until("the flipped label", async () => (await labels(udid)).some(row("Hide child tickets")), 8000);
        await tapWhere(udid, row("Hide child tickets")); // back to the default
        await until("the palette closed", async () => (await probe(udid))?.router.sheet == null, 8000);
        return "Show child tickets → Hide child tickets";
      });
      await check("a leading > shows only commands, not the ticket that matches", async () => {
        await goto(udid, BOARD);
        await atRest(udid, 500);
        await tapHeader(udid, "Command palette", { x: 192, y: 811 });
        await until("the palette", async () => PALETTE(await labels(udid)), 8000);
        await axe("type", ">greeting", "--udid", udid);
        await atRest(udid, 1500); // past the search's pause
        const l = await labels(udid);
        if (l.some((x) => x.startsWith(`${k(s.fileLink)} `))) throw new Error(`a > query lists a ticket: ${l.join(" | ")}`);
        await tapHeaderCancel(udid);
        return "no ticket rows";
      });
      await check("⌘K over a ticket sheet lists its actions; Copy ticket key copies it", async () => {
        await goto(udid, `harness://ticket/${k(s.fileLink)}?tab=spec`, (l) => l.includes("greetingFor fallback"));
        await axe("key-combo", "--modifiers", "227", "--key", "14", "--udid", udid);
        await until("the ticket's commands", async () => (await labels(udid)).some(row("Copy ticket key")), 8000);
        await tapWhere(udid, row("Copy ticket key"));
        await until("the palette closed", async () => (await probe(udid))?.router.sheet == null, 8000);
        const copied = (await simctl("pbpaste", udid)).trim();
        if (copied !== k(s.fileLink)) throw new Error(`copied "${copied}", expected ${k(s.fileLink)}`);
        return copied;
      });
      await check("Open file… (⌘P) finds a file in the ticket's folder and opens it at the typed lines", async () => {
        await goto(udid, `harness://ticket/${k(s.fileLink)}?tab=spec`, (l) => l.includes("greetingFor fallback"));
        await axe("key-combo", "--modifiers", "227", "--key", "19", "--udid", udid);
        await until("the palette in file mode", async () => (await probe(udid))?.router.sheet === "palette:files", 8000);
        await axe("type", `greetings:${GREETING_FOR[0]}-${GREETING_FOR[1]}`, "--udid", udid);
        await until("the file row", async () => (await labels(udid)).some((x) => x.includes(GREETINGS_PATH)), 10000);
        await tapWhere(udid, (x) => x.includes(GREETINGS_PATH));
        const marked = await probeUntil(udid, "the lines marked in the editor", (x) => (x.editor?.markedLines.length ?? 0) > 0).then((x) => x.editor!.markedLines);
        const want = GREETING_FOR[1] - GREETING_FOR[0] + 1;
        if (marked.length !== want) throw new Error(`marked ${marked.length} lines, expected ${want}`);
        return `${GREETINGS_PATH}:${GREETING_FOR[0]}-${GREETING_FOR[1]}`;
      });
    }),
    chain("save-on-blur", ["watchers"], 25, async (udid) => {
      await check("Settings → General has a Save on blur switch that flips when pressed", async () => {
        await goto(udid, "harness://settings", (l) => l.includes("Settings"));
        // The theme pickers are horizontal strips that swallow a swipe starting on them: swipe from the page's headings.
        const row = (l: string) => l === "Save on blur" || l.startsWith("Save on blur,");
        for (let i = 0; i < 40; i++) {
          const el = await findElement(udid, row);
          if (el && el.frame.y > 140 && el.frame.y < 560) break;
          await axe("swipe", "--start-x", "200", "--start-y", "520", "--end-x", "200", "--end-y", "170", "--duration", "0.6", "--udid", udid);
          await atRest(udid, 350);
        }
        if (!(await findElement(udid, row))) throw new Error(`no Save on blur row; on screen: ${(await labels(udid)).join(" | ")}`);
        await shot(udid, "save-on-blur-off-light");
        const valueOf = async () => (await nodes(udid)).filter((n) => n.AXLabel === "Save on blur").sort((x, y) => y.frame.x - x.frame.x)[0] as (AXNode & { AXValue?: string | null }) | undefined;
        const before = (await valueOf())?.AXValue ?? null;
        // The scroll's momentum has to be over before a tap lands where the switch was.
        await atRest(udid, 1200);
        // The row's text and its switch share the label: the switch is the one on the right.
        const sw = (await nodes(udid)).filter((n) => n.AXLabel === "Save on blur").sort((a, b) => b.frame.x - a.frame.x)[0];
        if (!sw) throw new Error("no Save on blur switch");
        // The Toggle's accessibility frame can be the row's width (its label is hidden): tap the
        // right end, where the switch is, not the middle.
        // A press held for a moment: the switch ignores the instantaneous tap AXe sends.
        await axe("touch", "-x", String(Math.round(sw.frame.x + sw.frame.width - 28)), "-y", String(Math.round(sw.frame.y + sw.frame.height / 2)), "--down", "--up", "--delay", "0.15", "--udid", udid);
        await atRest(udid, 1000);
        await shot(udid, "save-on-blur-on-light");
        // That the PATCH stores it is http.test.ts (launchBodies.json, shared with HarnessClientTests); here the switch
        // takes the press and shows the new value.
        const after = await until("the switch flipped", async () => {
          const v = (await valueOf())?.AXValue ?? null;
          return v !== before ? v : null;
        }, 6000).catch(async (e) => {
          await shot(udid, "save-on-blur-failed", true);
          throw e;
        });
        await shot(udid, "save-on-blur-on-light");
        return `${before} → ${after}`;
      });
    }),
    chain("file-edit", ["fileLink"], 25, async (udid) => {
      await check("a Terraform file opens highlighted, like the Changes tab shows it", async () => {
        // The old editor had no HCL grammar and showed .tf files as plain text.
        const wd = (await ticketOf(s.fileLink.key)).workdir!;
        mkdirSync(join(wd, "infra"), { recursive: true });
        writeFileSync(join(wd, "infra/main.tf"), 'resource "aws_s3_bucket" "logs" {\n  bucket = "harness-logs"\n  tags   = { Name = "logs" }\n}\n');
        try {
          await goto(udid, `harness://file/infra/main.tf?ticket=${k(s.fileLink)}`, (l) => l.includes("infra/main.tf"));
          const state = await probeUntil(udid, "the Terraform file colored", (x) => (x.editor?.colors ?? 0) >= 3, 15000).catch(() => probe(udid));
          await atRest(udid, 400);
          await shot(udid, "file-terraform-light");
          if ((state?.editor?.colors ?? 0) < 3) throw new Error(`main.tf shows ${state?.editor?.colors ?? 0} colors in the editor, expected its HCL tokens colored`);
          return `${state!.editor!.colors} colors`;
        } finally {
          rmSync(join(wd, "infra"), { recursive: true, force: true });
        }
      });
      await check("the file editor edits, shows the unsaved dot and writes the file with Save", async () => {
        const dot = async () => (await labels(udid)).includes("Unsaved changes");
        await goto(udid, `harness://file/${GREETINGS_PATH}?ticket=${k(s.fileLink)}`, (l) => l.includes(GREETINGS_PATH));
        await probeUntil(udid, "the editor", (x) => !!x.editor);
        // The page starts after the screen does: tap into it until a keystroke takes.
        const typed = "qzx"; // short, and not in the file
        await until("a keystroke in the editor marks the file unsaved", async () => {
          if (await dot()) return true;
          await axe("tap", "-x", "200", "-y", "500", "--udid", udid);
          await axe("type", typed, "--udid", udid);
          await probeUntil(udid, "the editor dirty", (x) => x.editor?.dirty === true, 1500).catch(() => {});
          return until("the unsaved dot", dot, 1500, 100).catch(() => false);
        }, 20000, 250);
        await shot(udid, "file-edit-dirty-light");
        const wd = (await ticketOf(s.fileLink.key)).workdir!;
        const onDisk = () => readFileSync(join(wd, GREETINGS_PATH), "utf8");
        const original = onDisk();
        if (onDisk().includes(typed)) throw new Error("the edit reached the disk before Save");
        await tapWhere(udid, "Save");
        await until("the unsaved dot gone", async () => !(await dot()), 8000);
        const editor = (await probe(udid))?.editor;
        if (editor?.dirty) throw new Error("the unsaved dot is gone but the editor still says dirty");
        const saved = onDisk().includes(typed);
        // The file is the ticket's, and the file-link chain reads it as clean: put it back.
        writeFileSync(join(wd, GREETINGS_PATH), original);
        if (!saved) throw new Error("Save didn't write the edit to the file");
        return "typed, unsaved dot, Save wrote the file";
      });
      // The file screen stays pushed, and the chains after it start on top of it: the file-link tap then lands behind a prompt editor.
      await goto(udid, BOARD);
    }),
  ];
}

/**
 * The Agents & tasks filter on the background-task ticket (one Bash task, two sub-agents): Agents
 * and Tasks toggles with their counts, one pressed shows only that kind, both or neither everything,
 * and the filter survives opening a row and coming back (Subagents.filter has the rules).
 */
async function agentsFilterChecks(udid: string, s: Seeded) {
  selector.sequence();
  const url = `harness://ticket/${encodeURIComponent(s.tasks.key)}?tab=agents`;
  const isTaskRow = (l: string) => l.startsWith("Count to 30");
  const isAgentRow = (l: string) => /^Sub-task \d+, /.test(l);
  const rows = async () => {
    const l = await labels(udid);
    return { tasks: l.filter(isTaskRow).length, agents: l.filter(isAgentRow).length };
  };
  const shows = (agents: number, tasks: number) => async () => ((r) => (r.agents === agents && r.tasks === tasks ? r : null))(await rows());
  const chip = (name: string) => (l: string) => l.startsWith(`${name}, `);
  await check("Agents & tasks: the filter survives opening a row and coming back", async () => {
    await goto(udid, url, (l) => l.some(isTaskRow));
    await until("every row", shows(2, 1), 8000);
    // Tasks alone, then Agents too (both), then Tasks off: only the sub-agents.
    await tapWhere(udid, chip("Tasks"));
    await tapWhere(udid, chip("Agents"));
    await tapWhere(udid, chip("Tasks"));
    await until("only the sub-agents", shows(2, 0), 5000);
    await tapWhere(udid, isAgentRow);
    await tapWhere(udid, (l) => l.includes("Back to Agents & tasks"), { timeout: 8000 });
    await until("still only the sub-agents", shows(2, 0), 8000);
    await tapWhere(udid, chip("Agents"));
    await until("neither pressed: every row", shows(2, 1), 5000);
    return "Agents alone kept; unpressed shows all 3";
  });
}

async function walk(udids: string[], s: Seeded, selection: Plan): Promise<boolean> {
  let ok = true;
  if (themeShots.length) await timed("themes", () => themeScreens(udids[0]!));
  const steps = selection.steps;
  const shoot = steps.filter((x) => x.action === "shoot" && x.entry.kind === "screen").map((x) => x.entry as Screen);
  const visit = steps.filter((x) => x.action === "visit").map((x) => x.entry as Screen);
  const chains = steps.filter((x) => x.action === "run").map((x) => x.entry as Chain);
  if (shoot.length) {
    // Longest first deals the most evenly; the screens that wait on the browse ticket then go last.
    const cost = (x: Screen) => x.seconds ?? 4;
    const dealt = lanes([...shoot].sort((a, b) => cost(b) - cost(a)), udids.length, cost).map((lane) => [...lane.filter((x) => !x.browse), ...lane.filter((x) => x.browse)]);
    const crashed = (await timed("screens", () => Promise.all(udids.map((u, i) => shootScreens(u, dealt[i]!, s.browsed))))).flat();
    if (crashed.length) ok = false;
  }
  // The checks change tickets the screens show, so they start once every shot is saved.
  if (hasAxe && (visit.length || chains.length)) {
    await Promise.all(udids.map((u) => appearance(u, "light")));
    // The iPad lays out differently only where it has a split view, a side panel or a window of its own:
    // the iPhone run visits every other route, and a route's crash lives in code both share.
    const routes = ipad ? visit.filter((x) => IPAD_ROUTES.has(x.name)) : visit;
    if (routes.length) await timed("routes", () => visitScreens(udids[0]!, routes));
    if (chains.length) {
      await Promise.all(udids.map((u) => clearDock(u).catch(() => {})));
      const byDevice = lanes([...chains].sort((a, b) => b.seconds - a.seconds), udids.length, (c) => c.seconds); // longest first deals best
      await timed("interactions", () => Promise.all(udids.map(async (u, i) => { for (const c of byDevice[i]!) await timed(`chain: ${c.name}`, () => c.run(u)); })));
    }
  }
  return ok;
}

// ---------------------------------------------------------------- build
async function buildApp() {
  // --reuse takes the app already built (the point is not waiting for xcodebuild); --rebuild builds first.
  if ((flag("no-build") || (reuse && !flag("rebuild"))) && existsSync(appPath)) {
    const note = reuse && !flag("rebuild") ? staleAppNote(appPath, [join(here, "Harness"), join(here, "HarnessKit", "Sources")]) : null;
    if (note) console.log(`--reuse: ${note}`);
    return;
  }
  // XcodeGen, then the Release simulator build into ios/build/dd (its log in ios/build/sim.log).
  // Unoptimized unless --memory: that mode measures the app's footprint, which optimization changes.
  console.log(`building the app, ${memoryOnly ? "optimized" : "unoptimized"} (simulator)…`);
  await sh(["bun", join(here, "Tools", "build.ts"), "sim", ...(memoryOnly ? ["--optimized"] : [])], { cwd: repoRoot });
}

// ---------------------------------------------------------------- main
let failed = false;
const serviceHash = reuse || keep ? hashService(repoRoot) : "";
let reusable: Pick<ReuseState, "modeKey" | "seeds" | "seeded" | "udids" | "appHash" | "installed"> | null = null;
try {
  mkdirSync(shots, { recursive: true });
  // What the run does and which tickets it needs, decided before anything is seeded: the entries
  // are built against stand-ins, since their links name keys that don't exist yet.
  const stub = { key: "X", id: "X", name: "X" };
  const dry = Object.fromEntries([...SEED_NAMES, "project", "other", "nestedAgent", "watcher", "browsed"].map((n) => [n, stub])) as unknown as Seeded;
  const entriesFor = (sd: Seeded): Entry[] => [...screens(sd), ...(hasAxe && !ipad ? interactionChains(sd) : [])];
  const selection: Plan | null = !walkThrough
    ? null
    : shotLink
      ? { steps: [], seeds: new Set(resolveShot(shotLink, () => "X").needs) }
      : planRun(entriesFor(dry), { only, screens: flag("screens") });
  const seedNeeds = selection?.seeds ?? new Set<SeedName>();
  // Which seed a kept daemon must hold for --reuse to attach to it.
  const modeKey = `${walkThrough ? "walk" : pagingOnly ? "paging" : stickOnly ? "stick" : keyboardOnly ? "keyboard" : mentionsOnly ? "mentions" : attachmentsOnly ? "attachments" : draftsOnly ? "drafts" : memoryOnly ? "memory" : "sheets"}${ipad ? "-ipad" : ""}`;
  await startDaemon({ modeKey, seeds: [...seedNeeds], repoRoot, serviceHash });
  // A new daemon is already answering (startDaemon waited for it); a reused one is checked here.
  await timed("daemon healthy", () => until("daemon healthy", async () => (await fetch(`${base}/health`)).ok && existsSync(join(home, "token")), 20000, 50));
  token = readFileSync(join(home, "token"), "utf8").trim();
  // The simulators boot, the app builds and the daemon seeds all at once.
  // The app installs as soon as it's built and its simulator is up.
  const pairUrl = buildPairUrl(usageBaseOf(), token);
  /** Whether the app is paired from before (--reuse found it as the kept run left it); false: install and pair as a new run does. */
  let appKept = false;
  const pairAll = (udids: string[]) =>
    timed("pair", async () => {
      await Promise.all(udids.map((u) => pair(u, pairUrl)));
      await Promise.all(udids.map((u) => simctl("spawn", u, "defaults", "write", BUNDLE, MARKER_KEY, home)));
    });
  const installAll = (udids: string[]) => timed("install", () => Promise.all(udids.map(install)));
  /** hashApp of the bundle installed on a simulator, or null when there is none. */
  const bundleHash = async (u: string): Promise<string | null> => {
    const dir = await sh(["xcrun", "simctl", "get_app_container", u, BUNDLE, "app"], { allowFail: true });
    return dir ? hashApp(dir.trim()) : null;
  };
  /** --reuse with the kept app: still this build, on these devices, and still paired for this daemon. */
  const reuseApp = async (udids: string[]): Promise<boolean> => {
    if (!attached) return false;
    const markers = await Promise.all(udids.map((u) => sh(["xcrun", "simctl", "spawn", u, "defaults", "read", BUNDLE, MARKER_KEY], { allowFail: true }).then((m) => m || null)));
    const installed = await Promise.all(udids.map(bundleHash));
    const plan = planApp(attached, { udids, appHash: builtHash, home, markers, installed });
    if (plan.install) {
      console.log(`--reuse: installing the app again (${plan.reason}); the daemon and its seeds stay`);
      return false;
    }
    // Brought up on the board it was left on; one that doesn't show a board with tickets isn't paired.
    await Promise.all(udids.map((u) => simctl("launch", u, BUNDLE)));
    if (hasAxe) {
      await Promise.all(udids.map((u) => (lastUrl.delete(u), simctl("openurl", u, BOARD))));
      const shown = await Promise.all(udids.map((u) => whenShown(u, undefined, (l) => onBoard(l) && l.some((x) => /^[A-Z]+-\d+ /.test(x)), 30000)));
      if (shown.some((x) => !x)) {
        console.log("--reuse: the kept app doesn't show its board; installing and pairing again");
        return false;
      }
    }
    for (const u of udids) lastUrl.set(u, BOARD);
    return true;
  };
  let builtHash = "";
  const built = timed("build", buildApp).then(() => (builtHash = hashApp(appPath)));
  const devices = Promise.all([timed("simulators", () => pickDevices(shardCount)), built]).then(async ([udids]) => {
    if (await reuseApp(udids)) appKept = true;
    else await installAll(udids);
    return udids;
  });
  // The walk-through pairs as soon as its tickets exist, while their runs settle; the modes once seeded.
  const paired = walkThrough
    ? devices.then((udids) => ticketsUp.then(() => (appKept ? undefined : pairAll(udids))).then(() => udids))
    : devices;
  /**
   * The seed: a --reuse run takes what the kept run seeded (the daemon still holds the tickets), anything else makes it.
   * What a seed returns is stored as JSON, so it must be plain data (no Set, Map or Date).
   */
  const seeding = <T,>(label: string, fn: () => Promise<T>): Promise<T> => (attached ? (ticketsCreated(), Promise.resolve(attached.seeded as T)) : timed(label, fn));
  const [udids, seeded, paged, sticky, typing, mentioned, media, drafting, sheeted, usageSeed] = await Promise.all([
    paired,
    selection ? seeding("seed", () => seed(seedNeeds)) : null,
    pagingOnly ? seeding("seed paging", seedPaging) : null,
    stickOnly ? seeding("seed stick", seedStick) : null,
    keyboardOnly ? seeding("seed keyboard", () => seedTicket("KEYS", "Warm up").then(async (s) => (await seedPrompts(), s))) : null,
    mentionsOnly ? seeding("seed mentions", seedMentions) : null,
    attachmentsOnly ? seeding("seed attachments", seedAttachments) : null,
    draftsOnly ? seeding("seed drafts", () => seedTicket("DRFT", "Warm up")) : null,
    sheetsOnly || memoryOnly ? seeding("seed sheets", seedSheets) : null,
    usageOnly ? timed("seed usage", () => seedTicket("USE", "Warm up")) : null,
  ]);
  if (seeded) console.log(`simulators ${udids.join(", ")}; seeded ${[...seedNeeds].join(", ") || "no tickets"}`);
  if (paged) console.log(`simulator ${udids[0]}; seeded ${paged.history.length + 4} done tickets in ${paged.project.key}, needle ${paged.needle.key}, conductor ${paged.conductor.key}`);

  if (!walkThrough && !appKept) await pairAll(udids);
  // What --reuse needs, left in the kept home when the run ends (see the finally).
  reusable = { modeKey, seeds: [...seedNeeds], seeded: [seeded, paged, sticky, typing, mentioned, media, drafting, sheeted].find((x) => x) ?? null, udids, appHash: builtHash, installed: keep ? ((await Promise.all(udids.map(bundleHash))) as string[]) : [] };

  const udid = udids[0]!;
  if (paged) await timed("mode: paging", () => pagingChecks(udid, paged));
  if (sticky) await timed("mode: stick", () => stickChecks(udid, sticky));
  if (typing) await timed("mode: keyboard", () => keyboardChecks(udid, typing));
  if (mentioned) await timed("mode: mentions", () => mentionChecks(udid, mentioned));
  if (media) await timed("mode: attachments", () => attachmentChecks(udid, media));
  if (drafting) await timed("mode: drafts", () => draftChecks(udid, drafting));
  if (usageSeed) await timed("mode: usage", () => usageChecks(udid));
  if (sheeted && sheetsOnly)
    await timed("mode: sheets", async () => {
      if (ipad) {
        await panelChecks(udid, sheeted);
        await cardStackChecks(udid, sheeted);
        await fileDockChecks(udid, sheeted, true);
      } else {
        await sheetChecks(udid, sheeted, "Planning");
        await dockStackChecks(udid, sheeted);
        await fileDockChecks(udid, sheeted, false);
      }
    });
  if (sheeted && memoryOnly) await timed("mode: memory", () => memoryChecks(udid, sheeted));
  if (seeded && shotLink) {
    const link = resolveShot(shotLink, (n) => (seeded as unknown as Record<string, Ticket>)[n]!.key);
    await timed("shot", () => oneShot(udid, link.url));
  } else if (seeded && selection) {
    const byName = new Map(entriesFor(seeded).map((e) => [e.name, e]));
    const real: Plan = { seeds: selection.seeds, steps: selection.steps.map((st) => ({ action: st.action, entry: byName.get(st.entry.name)! })) };
    if (!(await walk(udids, seeded, real))) failed = true;
  }
  if (selector.hasMatcher && selector.matched === 0) {
    console.error(noMatchMessage(opt("grep")!, selector.names));
    failed = true;
  }
  if (results.some((r) => !r[1])) failed = true;
  // Back to light, and quit the app: once the daemon is gone it would spin reconnecting.
  await Promise.all(udids.map((u) => Promise.all([appearance(u, "light"), keep ? null : simctl("terminate", u, BUNDLE).catch(() => {})])));
} catch (e) {
  failed = true;
  console.error("sim-check failed:", (e as Error).message);
  // Before the daemon starts there's no home (or log) yet.
  if (home) console.error(readFileSync(join(home, "daemon.err"), "utf8").slice(-2000));
} finally {
  if (keep && home) {
    markKept(home);
    if (reusable?.seeded) {
      writeReuseState(home, { version: REUSE_VERSION, savedAt: Date.now(), port, scratch, daemonPid, repoRoot, serviceHash, ...reusable });
      console.log("kept for --reuse: rerun with --reuse (and --grep=<check>) to attach to it; `bun run sim reap --kept` clears it");
    }
    console.log(`--keep: daemon still running at ${base} (pid ${daemonPid}); token in ${home}/token`);
  } else if (home) {
    await timed("daemon shutdown", async () => {
      // The daemon closes its Chrome on SIGTERM, which can take a while; a Chrome killed mid-close
      // leaks its code-sign clone, and one left running outlives this run (and its deleted home).
      await testDaemon?.stop({ termMs: 20000 });
    });
    removeTemp();
    await timed("simulator shutdown", shutDownDevices);
  }
  if (keptLock) releaseLock(keptLock);
  reportTimings();
  console.log(failed ? "sim-check finished with failures" : "sim-check done");
}
process.exit(failed ? 1 : 0);
