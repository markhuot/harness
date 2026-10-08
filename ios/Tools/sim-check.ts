// Simulator walk-through against a REAL daemon on a throwaway HARNESS_HOME:
//   1. boots service/src/daemon.ts (temp home, random port, dummy driver, HARNESS_DUMMY_DELAY_MS=1)
//   2. seeds a project with a hello-world ticket, a conductor with children, a /browse ticket,
//      an approval, a blocked question, a plan-first ticket, a git-worktree ticket with changes,
//      sub-agents (/agents), a background task (/bgtask) and a draft (a New session saved before launch),
//      while it builds the Release app for the simulator with `bun ios/Tools/build.ts sim` (XcodeGen,
//      then a Release simulator build into ios/build/dd; skip with --no-build, override with --app=)
//   3. on the shared simulator ("harness-shared", see ios/Tools/sim.ts and CLAUDE.md → Simulators),
//      held under its lock for the whole run so other agents wait rather than install over it,
//      installs the app and pairs it via `simctl openurl harness://pair?…`. --shards=N adds
//      "sim-check 2" … "sim-check N" (created on iOS 27.0 on first use, each under its own lock)
//   4. splits the screens between the simulators: each deep-links the running app to its screens
//      and saves each one in light and in dark (flipping `simctl ui appearance` in place) to
//      ios/build/screens/, then the real-tap checks, also split between them
//
//   Only what needs a simulator lives here (native scrolling, the keyboard, gestures, media, crashes,
//   the screenshots); the logic behind each check is in swift test (HarnessKit's BoardColumns,
//   MentionCaret, StickToBottom) and bun test (shared/state paging and details, the service's http tests).
//
//   --themes=catppuccin-mocha,rose-pine-dawn: per theme, applies it with the settings deep link
//      (harness://settings?darkTheme=…) and saves board-<id>.png + settings-<id>.png
//
//   The modes below replace the default walk-through and use one simulator:
//
//   --paging: seeds 125+ done tickets (one old "haystack" ticket deep in the history) and a conductor
//      with done children; checks child tickets are hidden by default (and the Filter menu shows
//      them), the Done column scrolls into older pages, and the board's search field finds the
//      unloaded done ticket; paging-*.png
//
//   --stick: a ticket with a long spec, a long transcript and a long Activity feed (messages that
//      have the dummy resume and resubmit the work, so each adds a submit and a review to Activity);
//      swipes the Transcript tab
//      and checks it follows new content at the bottom, stays put once scrolled up, and follows again
//      after scrolling back down; the Activity tab opens at the bottom and follows; the ticket's hero
//      opens in full on the Spec, collapses on scrolling it and stays collapsed scrolling back or
//      moving to another tab, and opens collapsed on the other tabs; a
//      sideways swipe moves between the tabs, and a right swipe on the Spec still goes back
//
//   --keyboard: with the on-screen keyboard up, the ticket composer sits right on top of it, and the
//      prompt editor and New session's prompt (which grows with no cap) keep the cursor above it as
//      the text grows, and the sheet's background (not the dimmed board) shows behind the keyboard's
//      rounded corners; keyboard-*.png. A headless simulator
//      always has a hardware keyboard, so the run turns the device's own keyboard minimization off
//      (no other simulator changes) and puts it back after; text goes in by tapping the on-screen keys
//
//   --mentions: in New session's Spec field and the ticket composer, typing `@…` lists the project's
//      files, tapping one completes it, and the run the spec starts gets the file attached ("Attached
//      @…" in the transcript); typing `/co` in New session on a claude-code project (the fake CLI)
//      lists its commands, a tap completes one, and the CLI gets the spec as typed; the toolbar's Plan
//      first launches a draft in planning and lands on its Spec tab; mentions-*.png, new-session-toolbar*.png
//
//   --drafts: the ticket composer saves what's typed as the ticket's message draft (Ticket.messageDraft);
//      another device's draft (a PUT with another origin) doesn't touch the field while it's being
//      typed in, and shows once it isn't; Send clears the draft on the service; a draft saved
//      elsewhere shows when the ticket opens; drafts-*.png
//
//   --attachments (needs ffmpeg): a spec with a tall, a wide and a small PNG as a row of "thumb"
//      thumbnails and an H.264 clip as a captioned figure (stored by update_spec), plus an attachment:
//      reference to a file that doesn't exist; checks every inline image shows in the Spec tab (the
//      thumbnails as 100 pt squares, the figure across the width), a tap opens the viewer on that
//      attachment, an image smaller than the screen opens centred, swiping pages, Close and
//      swipe-down close it; attachments-*.png
//
//   --sheets: the iPhone's ticket sheet on its own (the walk-through runs the same checks): a board
//      card opens its ticket in a sheet, a conductor's child pushes inside it and the back swipe
//      returns, dragging it to the bottom docks it under the board as a bar titled by its key, a
//      tap on the bar restores it where it was (its composer no higher than before), a section's alert still comes up, Projects closes
//      it, the bar's ✕ and a swipe down on it send it away, a flick down from full size sends it
//      away without docking, and New session opens in the sheet too and docks as
//      "New session"; sheet-*.png. Then several docked: a second ticket joins the dock as a second
//      card (ref and title, the newest at the bottom), a tap on a card, a long press on the
//      ticket's title and a swipe along the dock switch (keeping each one's path and composer),
//      twelve show two cards and "10 more…", which expands into the list of all twelve (the
//      oldest, parked, opens at its saved path), a card's ✕ and a swipe down close only the top,
//      the dock comes back after a relaunch, Projects closes them all, and the app's footprint
//      with none, 5 and 20 docked; dock-*.png
//
//   --ipad: the walk-through's screens on an iPad simulator instead ("sim-check iPad 1", an
//      iPad Pro 11-inch, plus "sim-check iPad 2" … with --shards), saved to ios/build/screens-ipad/ in whatever orientation each
//      simulator is in (simctl can't rotate one; Device → Rotate in Simulator.app can). Then the
//      side panel's checks: a card opens it trailing-aligned at its default width, its edge resizes
//      it within 25–80%, a link inside pushes and another card opens over it, docked it's a card in
//      the bottom-right corner that restores it with its path, a card's ✕ closes just its ticket,
//      New session and Escape, pop-out moves its ticket into a window, and several docked tickets
//      wait as cards left of the panel, never over the sidebar (five, then "N more…", which
//      expands into the list); panel-*.png. The iPhone's
//      real-tap checks and the modes above tap at iPhone coordinates, so they don't run here.
//      --ipad --sheets runs only the panel's checks. SIM_CHECK_LANDSCAPE=1 runs them on a
//      landscape-only build (ios/ARCHITECTURE.md § iPad layout), mapping taps and rotating shots.
//
//   It runs on the shared harness-shared simulator under its lock, e.g. `--only=connect`; --udid
//      still names a specific existing device.
//
//   It stops before starting when the disk has less than 5 GiB free, and removes its temp dirs
//   ($TMPDIR/harness-sim-home-*, harness-sim-projects-*) however it ends, unless --keep.
//
//   Every run prints its slowest steps and writes them all to timings.json in its screens folder.
//
//   DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer bun ios/Tools/sim-check.ts [--no-build] [--app=path] [--shards=N] [--udid=…,…] [--keep] [--only=name,name] [--interactions-only] [--themes=id,id] [--paging] [--stick] [--keyboard] [--mentions] [--drafts] [--attachments] [--sheets] [--ipad]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPairUrl, reviewPassed, type ActivityEntry, type Project, type PromptEntry, type SpecRevision, type Ticket, type TicketDetail, type TicketPage, type TranscriptEntry, type Watcher } from "@harness/shared";
import { findTheme } from "@harness/shared/themes";
import { Database } from "bun:sqlite";
import { acquire, checkDisk, ensureDevice, markKept, reap, SHARED_DEVICE, writeRunOwner } from "./sim";

/** ios/: screenshots go to its build/ folder. */
const here = resolve(import.meta.dir, "..");
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer";
const env = { ...process.env, DEVELOPER_DIR };
const ipad = args.includes("--ipad");
const shots = join(here, "build", `screens${ipad ? "-ipad" : ""}`);
const appPath = process.argv.find((a) => a.startsWith("--app="))?.slice(6) ?? join(here, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const only = opt("only")?.split(",");
const themeShots = opt("themes")?.split(",").filter(Boolean) ?? [];
const pagingOnly = flag("paging");
const stickOnly = flag("stick");
const keyboardOnly = flag("keyboard");
const mentionsOnly = flag("mentions");
const attachmentsOnly = flag("attachments");
const draftsOnly = flag("drafts");
const sheetsOnly = flag("sheets");
const walkThrough = !(pagingOnly || stickOnly || keyboardOnly || mentionsOnly || attachmentsOnly || draftsOnly || sheetsOnly);
if (ipad && !walkThrough && !sheetsOnly) throw new Error("--ipad takes the walk-through's screens or --sheets, not --paging, --stick, --keyboard, --mentions, --drafts or --attachments");
const shardCount = walkThrough ? Math.max(1, Number(opt("shards") ?? 1) || 1) : 1;
for (const id of themeShots) if (!findTheme(id)) throw new Error(`--themes: unknown theme ${id}`);
checkDisk();

async function sh(cmd: string[], opts: { cwd?: string; quiet?: boolean; allowFail?: boolean; env?: Record<string, string> } = {}) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? here, env: { ...env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} → ${code}\n${err || out}`);
  return out.trim();
}
const simctl = (...a: string[]) => sh(["xcrun", "simctl", ...a], { allowFail: false });

// ---------------------------------------------------------------- timing
const started = performance.now();
const timings: { label: string; ms: number }[] = [];
/** Runs fn and records how long it took under label (printed, and written to timings.json at the end). */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
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
  writeFileSync(join(shots, "timings.json"), JSON.stringify({ args, total, timings }, null, 2) + "\n");
}

// ---------------------------------------------------------------- checks
type Result = [name: string, ok: boolean, detail: string];
const results: Result[] = [];
/** Runs one named check; a thrown error or `false` fails it. The result prints right away. */
async function check(name: string, fn: () => Promise<string | boolean>) {
  let r: Result;
  try {
    const v = await timed(`check: ${name}`, fn);
    r = [name, v !== false, typeof v === "string" ? v : ""];
  } catch (e) {
    r = [name, false, (e as Error).message.split("\n")[0]!];
  }
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
  const link = (from: string, to: string) => Bun.spawnSync(["ln", "-s", from, to]);
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
      await Bun.sleep(400);
      continue;
    }
    const by = el && el.frame.y > 520 ? Math.min(420, Math.round(el.frame.y - 420)) : 380;
    await axe("swipe", "--start-x", "200", "--start-y", "740", "--end-x", "200", "--end-y", String(740 - by), "--duration", "0.8", "--udid", udid);
    await Bun.sleep(400);
  }
  throw new Error("scrollTo: element never came into view");
}
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 20000, every = 150): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(every);
  }
  throw new Error(`timed out: ${label}${last ? ` (${(last as Error).message})` : ""}`);
}
async function git(cwd: string, ...a: string[]) {
  await sh(["git", "-c", "user.name=Harness Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...a], { cwd });
}

// ---------------------------------------------------------------- simulators
const BUNDLE = "com.markhuot.harness";
/** Whether the app process is alive; a screenshot of a crashed app is just the home screen. */
async function running(udid: string): Promise<boolean> {
  return (await sh(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { allowFail: true })).includes(BUNDLE);
}

/**
 * The simulators to drive, each held under its lock (Tools/sim.ts) until this run exits, so two
 * runs or agents never install over each other: --udid=a,b, or the shared "harness-shared" iPhone
 * ("sim-check iPad 1" with --ipad), plus "sim-check 2" … "sim-check N" with --shards=N. Devices
 * that don't exist yet are created on the iOS 27.0 runtime, and all of them are booted. First it
 * cleans up after runs that died (Tools/sim.ts reap): their booted devices and orphaned daemons.
 */
async function pickDevices(n: number): Promise<string[]> {
  const given = opt("udid")?.split(",").filter(Boolean);
  type Device = { udid: string; name: string; state: string; isAvailable: boolean };
  const list = async () => Object.values((JSON.parse(await simctl("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices).flat();
  const wanted = given ?? Array.from({ length: n }, (_, i) => (ipad ? `sim-check iPad ${i + 1}` : i === 0 ? SHARED_DEVICE : `sim-check ${i + 1}`));
  const names = (devices: Device[]) => wanted.map((id) => devices.find((x) => x.udid === id)?.name ?? id);
  await reap({ except: names(await list()), log: console.log }).catch((e: Error) => console.log(`reap: ${e.message}`));
  const all = await list();
  return Promise.all(
    wanted.map(async (id) => {
      const d = all.find((x) => x.isAvailable && (x.udid === id || x.name === id));
      if (!d && given) throw new Error(`--udid: no simulator ${id}`);
      const name = d?.name ?? id;
      await acquire(name, { onWait: (h) => console.log(`waiting for simulator "${name}"${h ? ` (held by pid ${h.pid}: ${h.command})` : ""}…`) });
      if (!given) {
        const udid = await ensureDevice(name, { kind: ipad ? "ipad" : "iphone", log: console.log });
        if (name !== SHARED_DEVICE) {
          toShutDown.add(udid);
          toDelete.add(udid);
        }
        return udid;
      }
      if (d!.state !== "Booted") {
        await simctl("boot", d!.udid);
        await sh(["xcrun", "simctl", "bootstatus", d!.udid, "-b"]);
        if (name !== SHARED_DEVICE) toShutDown.add(d!.udid);
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
  if (flag("keep") || !toShutDown.size) return;
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
  let prev = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
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
      await Bun.sleep(DRAW_MS);
      return true;
    }
    if (process.env.SIM_CHECK_DEBUG && prev && t !== prev) {
      const a = new Set(prev.split("\n"));
      const b = new Set(l);
      console.log(`    [${udid.slice(0, 4)}] changed: -${[...a].filter((x) => !b.has(x)).slice(0, 3).join(" | ")} +${l.filter((x) => !a.has(x)).slice(0, 3).join(" | ")}`);
    }
    prev = t;
    await Bun.sleep(100);
  }
  lastTree.set(udid, prev);
  console.log(`    [${udid.slice(0, 4)}] no settled screen after ${ms / 1000} s${prev === before ? " (it never left the previous screen)" : ""}`);
  return false;
}
/** Opens `url` on the running app (launching it if it isn't) and waits for its screen. */
async function visit(udid: string, url: string, ready?: (l: string[]) => boolean): Promise<boolean> {
  const before = lastUrl.get(udid) === url ? undefined : lastTree.get(udid);
  lastUrl.set(udid, url);
  await simctl("openurl", udid, url);
  if (!hasAxe) return Bun.sleep(2500).then(() => true);
  return whenShown(udid, before, ready);
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
const shot = async (udid: string, name: string) => {
  const file = join(shots, `${name}${landscape ? "-landscape" : ""}.png`);
  await simctl("io", udid, "screenshot", file);
  if (landscape) await sh(["sips", "-r", "270", file], { quiet: true });
};

/**
 * Records the screen (to `<name>.mp4` beside the shots) while fn runs, and returns each frame's
 * top half shrunk to 16×8 gray: enough to see something flash by between two accessibility reads.
 */
async function recordFrames(udid: string, name: string, fn: () => Promise<unknown>): Promise<Uint8Array[]> {
  const video = join(shots, `${name}.mp4`);
  const rec = Bun.spawn(["xcrun", "simctl", "io", udid, "recordVideo", "--force", video], { stdout: "ignore", stderr: "pipe" });
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
    await Bun.sleep(400);
  } finally {
    rec.kill("SIGINT");
    await rec.exited;
  }
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", video, "-vf", "crop=iw:ih/2:0:0,scale=16:8,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "pipe" });
  const raw = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(ff.stderr).text()}`);
  const frames: Uint8Array[] = [];
  for (let i = 0; i + 128 <= raw.length; i += 128) frames.push(raw.subarray(i, i + 128));
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
  const ff = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-vf", crop, "-f", "rawvideo", "-"], { stdout: "pipe", stderr: "pipe" });
  const px = new Uint8Array(await new Response(ff.stdout).arrayBuffer());
  if ((await ff.exited) !== 0) throw new Error(`ffmpeg: ${await new Response(ff.stderr).text()}`);
  rmSync(file, { force: true });
  const median = [...px].sort((a, b) => a - b)[px.length >> 1]!;
  return px.filter((v) => Math.abs(v - median) > 64).length;
}

/** The mean difference between two recordFrames frames, 0–255. */
const frameDiff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
/**
 * Saves the screen as <name>-light.png and <name>-dark.png: the current appearance first, then the
 * other, so the next screen starts where this one ended and each screen costs one flip.
 */
async function shootBoth(udid: string, name: string, redrawn: () => Promise<unknown> = () => Bun.sleep(FLIP_MS)) {
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
const home = mkdtempSync(join(tmpdir(), "harness-sim-home-"));
const scratch = mkdtempSync(join(tmpdir(), "harness-sim-projects-"));
const port = 7830 + Math.floor(Math.random() * 60);
const base = `http://127.0.0.1:${port}`;
console.log(`daemon: ${base} (HARNESS_HOME=${home})`);
// Lets a later run's reap tell this run's dirs (and daemon) from a dead run's.
writeRunOwner(home, scratch);
// --mentions' /command check runs a project on the claude-code driver, pointed at the fake CLI:
// it answers `initialize` with SLASH_COMMANDS and records each agent run's prompt.
const SLASH_COMMANDS = [
  { name: "code-walk", description: "Walk a user through a piece of code so they can perform a detailed code review. (user)", argumentHint: "" },
  { name: "commit-and-pr", description: "Commit and PR (user)", argumentHint: "" },
  { name: "vercel:deploy", description: "(vercel) Deploy the current project to Vercel.", argumentHint: "[prod]" },
];
const claudeRecord = join(home, "fake-claude.ndjson");
const fakeClaude = mentionsOnly
  ? {
      HARNESS_CLAUDE_BIN: join(repoRoot, "service/src/drivers/__fixtures__/fake-claude.ts"),
      FAKE_CLAUDE_COMMANDS: JSON.stringify(SLASH_COMMANDS),
      FAKE_CLAUDE_RECORD: claudeRecord,
    }
  : {};
const daemon = Bun.spawn(["bun", join(repoRoot, "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "1", ...fakeClaude },
  stdout: Bun.file(join(home, "daemon.out")),
  stderr: Bun.file(join(home, "daemon.err")),
});
// The temp dirs go however the run ends (the finally at the bottom, process.exit, an uncaught
// error, Ctrl-C), except with --keep, which leaves the daemon running in them. A run killed
// outright (SIGKILL) can't clean up; the next run's reap (Tools/sim.ts) does it instead.
const removeTemp = () => {
  if (flag("keep")) return;
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
    if (!flag("keep")) {
      daemon.kill("SIGKILL");
      Bun.spawnSync(["pkill", "-f", `user-data-dir=${join(home, "chrome-profile")}`]);
      await Promise.race([shutDownDevices(), Bun.sleep(15000)]);
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
const settings = () => api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });

/** Resolves once the walk-through's tickets exist, before their runs settle: the app can pair then. */
let ticketsCreated!: () => void;
const ticketsUp = new Promise<void>((r) => (ticketsCreated = r));

const REPLY_ITEMS = ["Keep plain main", "Ship it"];
/** The Approve button's menu trigger, and the primary label in the git project (no gh remote, so merge). */
const APPROVE_MORE = "More ways to approve";
const APPROVE_MERGE = "Approve and merge";
/** The "Approve and…" sheet's field (its label runs on into the placeholder). */
const instructionsField = (l: string) => l.startsWith("Completion instructions");
/** The Approve action sheet has finished sliding up: a tap before that is lost. */
const approveMenuUp = (udid: string) => until("approve menu", async () => (await labels(udid)).includes("Approve and take no action"), 5000).then(() => Bun.sleep(400));

/**
 * A spec like HARNESS-66's: two wide tables whose cells run to a few hundred characters, and a
 * fenced command. In a user bubble that shrank to fit, each of those laid out hundreds to thousands
 * of points tall (see scrollsSideways in src/ui/Markdown.tsx), and the message buried the replies.
 */
const TABLE_BRIEF = [
  "Speed up the simulator walk-through",
  "",
  "### Budget",
  "| Phase | Budget | How |",
  "|---|---|---|",
  "| Daemon up and seed | ≤ 8 s, overlapping install | `HARNESS_DUMMY_DELAY_MS=1`; settle all tickets with `Promise.all`; take the browse ticket off the critical path; drop the 1.5 s sleep |",
  "| Install, launch and pair | ≤ 6 s | Wait on conditions, not the `2500 + 4000` ms sleeps |",
  "| 21 screens, both themes | ≤ 30 s | 2 simulators in parallel, warm links, wait for each screen's own label, both themes in one visit |",
  "",
  "### Where the time goes today",
  "| Area | Cost | Why |",
  "|---|---|---|",
  "| 21 screens, light and dark | about 300 s | Every shot is a `coldOpen`: terminate, cold launch (about 4 s), then wait for the accessibility tree to stay unchanged for 800 ms (each `describe-ui` takes about 0.4 s). Then a fixed 1 s sleep (3.5 s for browser, 2.5 s for changes), then `running()`. That's 42 cold launches. |",
  "| Seeding | tens of seconds | The dummy driver streams at 40 ms per word, about 3× its default. `settle(browse)` allows up to 90 s. `Bun.sleep(1500)` at the end. |",
  "| `--stick` | several minutes | 5 seed messages and 6 `sayStick` calls, each waiting for the dummy's chat reply at 40 ms per word (the seed's and Activity's also for a resubmit and its review run). Fixed sleeps of 1.5–3 s. Transcript and Activity test the same hook twice. |",
  "",
  "Measure with:",
  "```",
  "time bun scripts/sim-check.ts --no-build --shards=2",
  "```",
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

/** A git diff (colored by its file's language) and an untagged hand-written one. */
const DIFF_BRIEF = [
  "Make the greeting excited",
  "",
  "```diff",
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  '+import { greet } from "./lib/greet";',
  ' export function main(name = "world") {',
  '-  console.log("Hello, " + name);',
  "+  console.log(greet(name, true));",
  " }",
  "```",
  "",
  "And in the config:",
  "```",
  "--- a/config.yml",
  "+++ b/config.yml",
  "@@ -1,2 +1,2 @@",
  " greeter:",
  "-  excited: false",
  "+  excited: true",
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
  const db = new Database(join(home, "harness.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.query("SELECT value FROM settings WHERE key = 'prompts'").get() as { value: string } | null;
    const prompts = { ...(row ? (JSON.parse(row.value) as Record<string, unknown>) : {}), "system.files": "## Files\nRead files with {{readTool}}. Never use {{shellTool}} to edit files." };
    db.query("INSERT INTO settings (key, value) VALUES ('prompts', $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ $v: JSON.stringify(prompts) });
  } finally {
    db.close();
  }
}

async function seed() {
  await settings();
  await seedPrompts();
  // A git repo so tickets get worktrees and the git plugin's Changes tab.
  const repo = join(scratch, "greeter");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Greeter\n\nSays hello.\n");
  writeFileSync(join(repo, "src/app.ts"), 'export function main(name = "world") {\n  console.log("Hello, " + name);\n}\n');
  writeFileSync(join(repo, "config.json"), '{\n  "verbose": false\n}\n');
  writeFileSync(join(repo, GREETINGS_PATH), greetings(false));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "Initial commit");
  // More branches for the branch picker: one free, one checked out in another worktree.
  await git(repo, "branch", "feature/greet-emoji");
  await git(repo, "worktree", "add", "-q", "-b", "release/v2", join(scratch, "greeter-release"));
  mkdirSync(join(scratch, "harness-site"), { recursive: true });
  const [project, other] = await Promise.all([
    api<Project>("POST", "/projects", { path: repo, name: "greeter", key: "GREET", useWorktrees: true, defaultDriver: "dummy" }),
    api<Project>("POST", "/projects", { path: join(scratch, "harness-site"), name: "harness-site", key: "SITE", defaultDriver: "dummy" }),
  ]);
  const create = (projectId: string, spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId, spec, driver: "dummy", start: true, ...extra });

  // In creation order, so the keys stay GREET-1… and SITE-1…
  const hello = await create(project.id, "hello world");
  const changes = await create(project.id, "Add a greet helper with an excited mode");
  const conductor = await create(project.id, "Ship the greeter v2\n- Add a greet helper\n- Wire it into main\n- Update the README", { kind: "conductor" });
  const browse = await create(other.id, "/browse https://example.com");
  // A real Chrome loading a real page: anywhere from a few seconds to over a minute on a busy
  // machine. Nothing waits for it but the screens that show it (see Screen.browse).
  const browsed = timed("seed: browse ticket", () => settle(browse.key, (t) => !t.busy, 120000));
  browsed.catch(() => {});
  const approval = await create(other.id, 'Install the dependencies\n/approve Bash {"command":"npm install","description":"Install dependencies"}');
  const watcherCall = { name: "create_watcher", input: { name: "events", command: "while true; do curl -s -H \"Authorization: Bearer $EVENTS_TOKEN\" 'https://api.example.com/events?since=1m'; sleep 60; done", mode: "loop", prompt: "If this event is assigned to me and has actionable next steps, dispatch it to an agent in SITE.", env: { EVENTS_TOKEN: "evt_live_2f9c" } } };
  const configApproval = await create(other.id, `Watch the events API\n/tools ${JSON.stringify([watcherCall])}`);
  const blocked = await create(other.id, "Sign the build\n/block Which Apple Developer team should sign the build: Happy Cog or your personal account?");
  const plan = await create(other.id, "Write a landing page for the install link", { start: false });
  // Sub-agents: two, the second starting a nested third (the dummy driver's /agents).
  const agents = await create(project.id, "Survey the greeter before the rewrite\n/agents 3");
  const tables = await create(other.id, TABLE_BRIEF);
  // Not started, so its branch can still be picked on the Details tab.
  const branchPlan = await create(project.id, "Greet in the user's language", { start: false, branch: "feature/greet-emoji", baseBranch: "release/v2" });
  // A quick ask that skips the agent review: in review with the muted "skipped" mark.
  const quick = await create(other.id, "What does the install link point at?", { skipAgentReview: true });
  // Another quick ask, which the review checks approve: approving alone lands it.
  const waiting = await create(other.id, "Which browsers does the install page support?", { skipAgentReview: true });
  // A New session saved as a draft: a dashed card in Planning that reopens in the editor, never run.
  const draft = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Greet in French when the locale says so", draft: true, skipAgentReview: true });
  // Specs with fenced code and diffs, for the syntax highlighting (last, so the keys above stay put).
  const code = await create(other.id, CODE_BRIEF, { skipAgentReview: true });
  const diff = await create(other.id, DIFF_BRIEF, { skipAgentReview: true });
  // A spec with a relative file link, which opens in the ticket's own worktree.
  // The link is a paragraph of its own, so a tap near the paragraph's start lands on it.
  const fileLink = await create(project.id, `Tidy the greetings\n\n[greetingFor fallback](${GREETINGS_PATH}#L${GREETING_FOR[0]}-L${GREETING_FOR[1]})`, { skipAgentReview: true });
  // Two stages of one Jira issue: both linked to the remote ID JIRA-62, so each card and header shows
  // "JIRA-62 · GREET-n", Details lists the other, and harness://ticket/JIRA-62 lists both.
  const jira62 = { source: "jira", key: "JIRA-62", url: "https://example.com/browse/JIRA-62", raw: null };
  const linked = await create(project.id, "Review the empty-name crash fix", { start: false, externalRef: jira62 });
  const linkedStage = await create(project.id, "Ship the empty-name crash fix", { start: false, externalRef: jira62 });
  // A background Bash task (the dummy driver's /bgtask): Agents & tasks lists it, and its view shows the output.
  const tasks = await create(project.id, "Count the greetings in the background\n/bgtask 30", { skipAgentReview: true });
  ticketsCreated();

  // The watchers and the Inbox item don't depend on the tickets: set them up while those run.
  // The prompt names the project; the dummy triager reads the [dummy:project KEY] marker.
  const prompt = "If this issue is assigned to me and has actionable next steps, dispatch it to an agent in GREET.";
  const watchers = Promise.all([
    // A watcher-less triage item for the Inbox.
    api("POST", "/watchers/inject", { source: "jira", text: JSON.stringify({ key: "FOO-123", summary: "Greeter crashes on an empty name", url: "https://example.com/FOO-123", updated: "1" }), prompt: `${prompt} [dummy:project ${project.key}]` }),
    // A paused shell watcher, so Settings and the watcher form have one to show (and it never runs).
    api<Watcher>("POST", "/watchers", { name: "jira", command: "while true; do curl -s https://example.com/api/events | jq -c '.[]'; sleep 60; done", args: [], prompt, mode: "loop", enabled: false, driver: "dummy" }),
    // Live watchers for the Inbox's watcher strip: one whose process stays up (and prints nothing),
    // one that fails at once and sits in its backoff with the error.
    api<Watcher>("POST", "/watchers", { name: "heartbeat", command: "while true; do sleep 3600; done", mode: "loop", driver: "dummy" }),
    api<Watcher>("POST", "/watchers", { name: "jira-sprint", command: "echo 'watch-jira: 401 Unauthorized (check JIRA_TOKEN)' >&2; exit 1", mode: "loop", driver: "dummy" }),
  ]);

  const [, ch] = await Promise.all([
    // Then a reply with a list: the user's bubble shrink-wraps, which once collapsed list text to nothing.
    // Messages go to the transcript only, never into Activity.
    settle(hello.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview))
      .then(() => api("POST", `/tickets/${hello.key}/messages`, { text: REPLY_ITEMS.map((i) => `- ${i}`).join("\n") }))
      .then(() => settle(hello.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview)))
      // A commit on its branch, so it has something to land and the Approve menu offers "Approve
      // and merge" (with nothing to land it leads with "Approve and clean up" and drops merge).
      // Opening a ticket in review re-checks its worktree.
      .then(async (t) => {
        writeFileSync(join(t.workdir!, "HELLO.md"), "Hello, world.\n");
        await git(t.workdir!, "add", "-A");
        await git(t.workdir!, "commit", "-qm", "Say hello");
        await until(`${hello.key} has changes to land`, async () => (await api<TicketDetail>("GET", `/tickets/${hello.key}`)).ticket.hasChanges === true, 10000, 200);
      }),
    settle(changes.key, (t) => t.status === "review" && !t.busy && !!t.workdir),
    settle(approval.key, (t) => !!t.pendingApproval),
    settle(configApproval.key, (t) => !!t.pendingApproval),
    settle(blocked.key, (t) => t.status === "blocked" && !t.busy),
    settle(plan.key, (t) => t.status === "planning" && !t.busy),
    settle(branchPlan.key, (t) => t.status === "planning" && !t.busy),
    settle(quick.key, (t) => t.status === "review" && !t.busy && t.agentReview === "skipped"),
    settle(waiting.key, (t) => t.status === "review" && !t.busy && t.agentReview === "skipped"),
    settle(agents.key, (t) => t.status === "review" && !t.busy),
    settle(tables.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview)),
    settle(code.key, (t) => t.status === "review" && !t.busy),
    settle(diff.key, (t) => t.status === "review" && !t.busy),
    settle(fileLink.key, (t) => t.status === "review" && !t.busy && !!t.workdir),
    settle(linked.key, (t) => t.status === "planning" && !t.busy),
    settle(linkedStage.key, (t) => t.status === "planning" && !t.busy),
    settle(tasks.key, (t) => t.status === "review" && !t.busy),
    until("conductor children", async () => (await api<TicketDetail>("GET", `/tickets/${conductor.key}`)).children.length >= 3, 60000, 100),
  ]);
  // Edit the worktree the way an agent would: a commit on the branch plus uncommitted changes.
  const wd = ch.workdir!;
  mkdirSync(join(wd, "src/lib"), { recursive: true });
  writeFileSync(join(wd, "src/lib/greet.ts"), 'export function greet(name: string, excited = false) {\n  const base = "Hello, " + name;\n  return excited ? base + "!" : base;\n}\n');
  await git(wd, "add", "-A");
  await git(wd, "commit", "-qm", "Add greet helper");
  writeFileSync(join(wd, "src/app.ts"), 'import { greet } from "./lib/greet";\n\nexport function main(name = "world") {\n  console.log(greet(name, true));\n}\n');
  writeFileSync(join(wd, "config.json"), '{\n  "verbose": true\n}\n');
  writeFileSync(join(wd, "CHANGELOG.md"), "# Changelog\n\n- Greet with an exclamation mark\n");
  writeFileSync(join(wd, GREETINGS_PATH), greetings(true));
  const nestedAgent = (await api<TicketDetail>("GET", `/tickets/${agents.key}`)).subagents!.find((s) => s.parentId)!;
  const task = (await api<TicketDetail>("GET", `/tickets/${tasks.key}`)).subagents!.find((s) => s.kind === "bash")!;
  const [, watcher] = await watchers;
  return { project, other, hello, changes, conductor, browse, browsed, approval, configApproval, blocked, plan, branchPlan, quick, waiting, draft, watcher, agents, nestedAgent, tasks, task, tables, code, diff, fileLink, linked, linkedStage };
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
  const boardMenu = async () => {
    // The filter sits at the trailing end of the bottom bar's search field.
    await tapHeader(udid, "Filter", { x: 303, y: 811 });
    await tapWhere(udid, "Show child tickets");
  };
  const deep = p.history.at(-60)!; // ~60th newest: on the second page (50 a page)

  await goto(udid, BOARD, (l) => l.some((x) => /^ARCH-\d+ /.test(x)));
  await shootBoth(udid, "paging-board");
  await check("child tickets are hidden by default (Done's newest completions are children)", async () => {
    await openDone();
    const leaked = p.kids.slice(0, 3);
    const shown = (await labels(udid)).filter((l) => leaked.some((kid) => l.startsWith(`${kid.key} `)));
    if (shown.length) throw new Error(`children visible: ${shown.join(" | ")}`);
    return `newest non-child ${p.top.key} on top`;
  });
  await shootBoth(udid, "paging-done");
  await check("Show child tickets (Filter menu) shows them; toggling back hides them", async () => {
    await boardMenu();
    await until("children visible", () => has(`${p.kids[2]!.key} `), 6000);
    await boardMenu();
    await until("children hidden", async () => !(await has(`${p.kids[2]!.key} `)), 6000);
    return true;
  });
  await check("the Done column scrolls into older pages", async () => {
    // Reading the tree (every loaded card) costs more than a swipe, so look after every few. A lazy
    // list only has the cards on screen in the tree, and a few flicks can carry it
    // past `deep`, so any card at least as old (past the first page) counts.
    const older = [...p.history.slice(0, -59), p.needle].map((t) => `${t.key} `);
    for (let i = 0; i < 45; i += 3) {
      const seen = (await labels(udid)).find((l) => older.some((k) => l.startsWith(k)));
      if (seen) return `${seen.split(" ")[0]} (≥ 60th newest) after ${i} swipes`;
      for (let j = 0; j < 3; j++) await swipeUp();
      await Bun.sleep(300);
    }
    throw new Error(`${deep.key} never appeared`);
  });
  await shootBoth(udid, "paging-done-scrolled");
  await check("search finds a done ticket that isn't loaded", async () => {
    // The search field is always in the board's bottom bar, between Projects and New session;
    // its placeholder is the board's scope ("All projects" here).
    await goto(udid, BOARD);
    await Bun.sleep(500);
    await tapHeader(udid, "All projects", { x: 192, y: 811 });
    await Bun.sleep(500);
    await axe("type", "haystack", "--udid", udid);
    await until(`${p.needle.key} in the results`, () => has(`${p.needle.key} `), 10000);
    return p.needle.key;
  });
  moved(udid);
  await Bun.sleep(400); // the result list's cards finish drawing
  await shootBoth(udid, "paging-search");
}

/** --sheets: a conductor with two children, not started, on a project of its own. */
async function seedSheets() {
  mkdirSync(join(scratch, "sheets"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "sheets"), name: "sheets", key: "SHEET", defaultDriver: "dummy" });
  const create = (spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: false, ...extra });
  const conductor = await create("Sheet train: dock the ticket sheet", { kind: "conductor" });
  for (const title of ["Dock the sheet under the board", "Swipe the sheet away"]) await create(title, { parentId: conductor.id });
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
 * Drags the presented ticket sheet by its nav bar to just above the bottom, slowly, so it settles
 * docked. Returns the dock's label.
 */
async function dockSheet(udid: string): Promise<string> {
  // The screen's size from the tallest top-level element: with New session coming up, the first
  // one can be a zero-height stand-in, which put the drag's end above the screen.
  const { width, height } = (await tree(udid)).reduce((a, b) => (b.frame.height > a.frame.height ? b : a)).frame;
  const x = String(Math.round(width / 2));
  await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(height - 110)), "--duration", "1.2", "--udid", udid);
  return until("the dock", async () => topDock(await labels(udid)), 6000);
}

/** Swipes the docked ticket sheet down once: it closes the ticket on top. */
async function swipeDockDown(udid: string, dock: AXNode) {
  // From near the card's top: AXe stops a drag at the screen's edge, and from a card's middle
  // (now that the dock grows with its cards) too little of it is left to throw the sheet away.
  const x = String(Math.round(dock.frame.x + dock.frame.width / 2));
  const y = Math.round(dock.frame.y + 4);
  await axe("swipe", "--start-x", x, "--start-y", String(y), "--end-x", x, "--end-y", String(y + 160), "--duration", "0.1", "--udid", udid);
}

/**
 * Swipes docked ticket sheets away until none is left (each swipe closes the one on top), so a
 * shot of a tab doesn't carry them.
 */
async function undock(udid: string) {
  for (let i = 0; i < 20; i++) {
    const dock = await findElement(udid, isDock);
    if (!dock) return;
    const before = dockCount(await labels(udid));
    await swipeDockDown(udid, dock);
    await until("one fewer docked", async () => dockCount(await labels(udid)) < before, 6000);
    await Bun.sleep(500);
  }
  throw new Error("the dock never emptied");
}

/**
 * The iPhone's ticket sheet (TicketSheetHost): a board card (`column`, the card's column chip) or
 * else a link opens it, a conductor's child pushes in it and the back swipe returns, it docks
 * under the board when dragged to the bottom, the bar restores it as it was, a swipe on the bar
 * sends it away, and New session docks as "New session".
 */
async function sheetChecks(udid: string, p: { project: Project; conductor: Ticket }, column?: string) {
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

  await check(`${column ? "a board card" : "a ticket link"} opens its ticket in a sheet over the board`, async () => {
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
    if ((await labels(udid)).some(isDock)) throw new Error("a dock is showing under the presented sheet");
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
    await shot(udid, "sheet-child-light");
    // The first page's rightward swipe goes to the back swipe (PagerYieldsToBackSwipe).
    await Bun.sleep(800); // back only goes once the pager rests on the first page
    const y = String(Math.round(H * 0.7));
    await axe("swipe", "--start-x", String(Math.round(W * 0.1)), "--start-y", y, "--end-x", String(Math.round(W * 0.9)), "--end-y", y, "--duration", "0.3", "--udid", udid);
    await until("back on the conductor", async () => onConductor(await labels(udid)), 8000).catch(async (e) => {
      await say("after the back swipe");
      throw e;
    });
    return `${kid.key} → back to ${key}`;
  });
  // Where the child's composer sat before docking: restored, it sits there again, not lifted by
  // the inset the system gave the docked sheet.
  let composerBefore: AXNode["frame"] | null = null;
  await check("dragging the sheet to the bottom docks it under the board, titled by the ticket on top", async () => {
    // Pushed again, so restoring has a path to bring back.
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child", async () => onChild(await labels(udid)), 8000);
    composerBefore = (await findElement(udid, (x) => x === "Send"))?.frame ?? null;
    const label = await dock().catch(async (e) => {
      await say("after the drag");
      throw e;
    });
    if (label !== `${kid.key}, ${kid.title}, docked`) throw new Error(`the dock reads "${label}", not ${kid.key} and its title`);
    const l = await labels(udid);
    if (!onBoard(l)) throw new Error("the board isn't showing over the dock");
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
    // And as far from the screen's sides as that bar: Projects at its left end, New session at its right.
    const projects = await findElement(udid, (x) => x === "Projects");
    if (bar && projects && newSession) {
      const left = bar.frame.x - projects.frame.x;
      const right = bar.frame.x + bar.frame.width - (newSession.frame.x + newSession.frame.width);
      if (Math.abs(left) > 2 || Math.abs(right) > 2)
        throw new Error(`the dock (${Math.round(bar.frame.x)}–${Math.round(bar.frame.x + bar.frame.width)}) isn't inset like the bar (${Math.round(projects.frame.x)}–${Math.round(newSession.frame.x + newSession.frame.width)})`);
      // The bar sits TicketDock.barGap (11pt) above the dock, whatever the phone's corner radius.
      const above = bar.frame.y - (newSession.frame.y + newSession.frame.height);
      if (Math.abs(above - 11) > 1.5) throw new Error(`the bar is ${Math.round(above)}pt above the dock, not 11pt`);
    }
    await shootBoth(udid, "sheet-docked");
    return label;
  });
  await check("the dock survives a tab change, and a tap restores the sheet where it was", async () => {
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
  });
  await check("a section's alert still comes up with the sheet docked", async () => {
    await dock();
    await goto(udid, "harness://settings");
    // Rotate token asks first; Cancel leaves the token alone.
    const asking = (l: string[]) => l.includes("Rotate the token?");
    await tapWhere(udid, (l) => l.startsWith("Rotate token…"));
    await until("the Rotate confirmation", async () => asking(await labels(udid)), 5000);
    await Bun.sleep(400); // the alert finishes coming up
    await tapWhere(udid, "Cancel");
    await until("the confirmation gone", async () => !asking(await labels(udid)), 5000);
    await Bun.sleep(600);
    return (await labels(udid)).some(isDock) ? "the dock stayed" : "UIKit dismissed the dock";
  });
  await check("opening Projects closes the ticket sheet", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    await dock();
    await goto(udid, BOARD);
    await tapWhere(udid, "Projects");
    await until("the Projects sheet", async () => (await labels(udid)).includes("Inbox"), 5000);
    await goto(udid, BOARD);
    await Bun.sleep(600);
    if ((await labels(udid)).some(isDock)) throw new Error("the dock is still there after Projects");
    // Back up for the next check.
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    return "closed";
  });
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
  });
  await check("swiping the docked sheet down sends it away", async () => {
    await dock();
    await undock(udid);
    const l = await labels(udid);
    if (has(l, kid.key)) throw new Error(`${kid.key} still on screen`);
    lastUrl.set(udid, BOARD);
    return "gone";
  });
  await check("a flick down from full size sends the sheet away rather than docking it", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(kid.key)}`);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    await Bun.sleep(600); // the sheet finishes coming up
    // The simulator takes each of AXe's touch points slowly whatever --duration says, so a flick
    // is long strides (--delta, in pixels) rather than a short duration: dockSheet's drag lets go
    // near 230pt/s and docks, this one past SheetFlick.speed (1000pt/s), near 1100pt/s.
    const x = String(Math.round(W / 2));
    await axe("swipe", "--start-x", x, "--start-y", "90", "--end-x", x, "--end-y", String(Math.round(H - 110)), "--duration", "0.1", "--delta", "100", "--udid", udid);
    await until("the sheet gone", async () => {
      const l = await labels(udid);
      return !has(l, kid.key) && onBoard(l);
    }, 6000).catch(async (e) => {
      await say("after the flick");
      throw e;
    });
    await Bun.sleep(800);
    if ((await labels(udid)).some(isDock)) throw new Error("the flick docked the sheet");
    lastUrl.set(udid, BOARD);
    return "gone, no dock";
  });
  await check("New session opens in the sheet and docks as New session", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some(isOptions));
    await shot(udid, "sheet-new-session-light");
    const label = await dock();
    if (label !== "New session, docked") throw new Error(`the dock reads "${label}"`);
    await shot(udid, "sheet-new-session-docked-light");
    await tapWhere(udid, isDock);
    await until("New session again", async () => (await labels(udid)).some(isOptions), 8000);
    moved(udid);
    await dock();
    await undock(udid);
    lastUrl.set(udid, BOARD);
    return label;
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
 * The iPhone's dock with several tickets (TicketDock, DockedCard): a second ticket joins the dock as
 * a second card rather than replacing it, the newest at the bottom with its ref and title; tapping a
 * card opens it (keeping its path and composer); a long press on the ticket's title lists the other
 * docked tickets; a swipe along the dock walks them; twelve show two cards and "10 more…", which
 * expands into the list of all twelve, whose oldest (parked) opens at its saved path; a card's ✕
 * and a swipe down close only the top; the dock comes back after a relaunch; Projects closes them all.
 */
async function dockStackChecks(udid: string, p: { project: Project; conductor: Ticket }) {
  const key = p.conductor.key;
  const kid = (await api<TicketDetail>("GET", `/tickets/${key}`)).children[0];
  if (!kid) throw new Error(`${key} has no children`);
  const extra = await seedDockable(p.project.id, 11);
  const b = extra[0]!;
  const { width: W } = (await tree(udid))[0]!.frame;
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

  await check("a second ticket joins the dock as a second card, the newest at the bottom with its ref and title", async () => {
    await goto(udid, BOARD);
    await undock(udid);
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=children`, (l) => l.some((x) => x.includes(kid.key)));
    await tapWhere(udid, (l) => l.includes(kid.key));
    moved(udid);
    await until("the child", async () => onChild(await labels(udid)), 8000);
    composerBefore = (await findElement(udid, (x) => x === "Send"))?.frame ?? null;
    await dockSheet(udid);
    await goto(udid, `harness://ticket/${encodeURIComponent(b.key)}`, (l) => ticketShown(l, b.key) && !l.some(isDock));
    const label = await dockSheet(udid);
    if (label !== `${b.key}, ${b.title}, docked`) throw new Error(`the bottom card reads "${label}"`);
    const cards = (await nodes(udid)).filter((n) => n.AXLabel && isDock(n.AXLabel));
    if (cards.length !== 2 || !card(kid.key)(cards[0]!.AXLabel!)) throw new Error(`the cards read ${cards.map((n) => `"${n.AXLabel}"`).join(", ")}`);
    if (cards[1]!.frame.y <= cards[0]!.frame.y) throw new Error("the newest card isn't at the bottom");
    // The board's bottom bar rides above the taller dock.
    const sheet = (await nodes(udid)).find((n) => n.AXUniqueId === "ticket-dock-sheet");
    const newSession = await findElement(udid, (x) => x === "New session");
    if (sheet && newSession && newSession.frame.y + newSession.frame.height > sheet.frame.y)
      throw new Error(`New session (bottom ${Math.round(newSession.frame.y + newSession.frame.height)}) runs under the dock (top ${Math.round(sheet.frame.y)})`);
    await shootBoth(udid, "dock-stack");
    await appearance(udid, "light");
    return `${keyOf(cards[0]!.AXLabel!)} over ${keyOf(label)}`;
  });
  await check("tapping a card opens that ticket, its path and composer kept", async () => {
    await tapWhere(udid, card(kid.key));
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
        throw new Error(`the composer's Send sits at y ${y === undefined ? "(gone)" : Math.round(y)}, not ${Math.round(before.y)} as before`);
      });
    }
    return `${kid.key} back, on its pushed screen`;
  });
  await check("a long press on the ticket's title lists the other docked tickets and switches", async () => {
    await Bun.sleep(600);
    await tapWhere(udid, (l) => l.startsWith(kid.title), { longPress: 1.2 });
    await until("the menu", async () => (await labels(udid)).some(row(b.key)), 5000).catch(async (e) => {
      await say("after a long press on the title");
      throw e;
    });
    await shot(udid, "dock-title-menu-light");
    if ((await labels(udid)).some(row(kid.key))) throw new Error(`the menu lists ${kid.key}, the ticket on screen`);
    await tapWhere(udid, row(b.key));
    moved(udid);
    await until(`${b.key} in the sheet`, async () => {
      const l = await labels(udid);
      return l.some((x) => x.startsWith(b.title.slice(0, 24))) && !l.some((x) => x.startsWith("Part of ")) && !l.some(isDock);
    }, 8000).catch(async (e) => {
      await say("after choosing it from the menu");
      throw e;
    });
    return `${kid.key} → ${b.key}, still presented`;
  });
  await check("a swipe along the dock moves to the next ticket and back", async () => {
    const first = await dockSheet(udid);
    const bar = (await findElement(udid, (l) => l === first))!;
    const y = String(Math.round(bar.frame.y + bar.frame.height / 2));
    const swipe = (from: number, to: number) =>
      axe("swipe", "--start-x", String(Math.round(from)), "--start-y", y, "--end-x", String(Math.round(to)), "--end-y", y, "--duration", "0.25", "--udid", udid);
    await swipe(W * 0.6, W * 0.1);
    const second = await until("the next ticket on top", async () => {
      const t = await top();
      return t && t !== first ? t : null;
    }, 5000).catch(async (e) => {
      await say("after a swipe left");
      throw e;
    });
    if ((await count()) !== 2) throw new Error("the swipe changed the count");
    await swipe(W * 0.15, W * 0.65);
    await until("the first back on top", async () => (await top()) === first, 5000);
    return `${keyOf(first)} → ${keyOf(second)} → back`;
  });
  await check("with 12 docked, two cards and \"10 more…\" expand into the list, whose oldest opens at its saved path", async () => {
    // b on top, so the conductor's sheet (with the child pushed) is the oldest.
    if (!(await top())?.startsWith(`${b.key}, `)) {
      await tapWhere(udid, card(b.key));
      moved(udid);
      await dockSheet(udid);
    }
    for (const t of extra.slice(1)) await goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => ticketShown(l, t.key));
    await dockSheet(udid);
    await until("two cards and 10 more", async () => {
      const l = await labels(udid);
      return l.filter(isDock).length === 2 && l.includes("10 more docked tickets");
    }, 5000).catch(async (e) => {
      await say("the dock");
      throw e;
    });
    await shot(udid, "dock-more-light");
    await tapWhere(udid, "10 more docked tickets");
    const listed = await until("the list of all twelve", async () => {
      const l = await labels(udid);
      const all = l.filter(isDock);
      return all.length === 12 ? all : null;
    }, 6000).catch(async (e) => {
      await say("after \"10 more\"");
      throw e;
    });
    await shot(udid, "dock-list-light");
    // The most recent at the bottom, as in the dock: the conductor's sheet, the oldest, first.
    if (!card(kid.key)(listed[0]!)) throw new Error(`the list starts with "${listed[0]}", not ${kid.key}`);
    // It opens scrolled to the bottom: scroll up to the oldest.
    const { height: Hs } = (await tree(udid))[0]!.frame;
    for (let i = 0; i < 3; i++) {
      const n = await findElement(udid, card(kid.key));
      if (n && n.frame.y > 60 && n.frame.y + n.frame.height < Hs - 20) break;
      await axe("swipe", "--start-x", String(Math.round(W / 2)), "--start-y", String(Math.round(Hs * 0.35)), "--end-x", String(Math.round(W / 2)), "--end-y", String(Math.round(Hs * 0.8)), "--duration", "0.5", "--udid", udid);
      await Bun.sleep(600);
    }
    await tapWhere(udid, card(kid.key));
    moved(udid);
    await until("the child, mounted again at its path", async () => {
      const x = await labels(udid);
      return onChild(x) && !x.some(isDock);
    }, 10000).catch(async (e) => {
      await say(`after ${kid.key} from the list`);
      throw e;
    });
    return `2 cards and 10 more; the list of 12; ${kid.key} came back on its pushed screen`;
  });
  await check("a card's ✕ closes only that ticket", async () => {
    const before = await dockSheet(udid);
    const n = await count();
    await tapWhere(udid, `Close ${keyOf(before)}`);
    await until("the next one on top", async () => {
      const t = await top();
      return t && t !== before ? t : null;
    }, 6000);
    if ((await count()) !== n - 1) throw new Error(`${await count()} docked after ✕, not ${n - 1}`);
    return `${n} → ${n - 1}`;
  });
  await check("a swipe down on the dock closes one and leaves the rest docked", async () => {
    const before = (await top())!;
    const n = await count();
    await Bun.sleep(600);
    await swipeDockDown(udid, (await findElement(udid, (l) => l === before))!);
    const after = await until("the next one docked", async () => {
      const t = await top();
      return t && t !== before ? t : null;
    }, 8000).catch(async (e) => {
      await say("after the swipe down");
      throw e;
    });
    await Bun.sleep(600);
    if ((await count()) !== n - 1) throw new Error(`${await count()} docked after the swipe, not ${n - 1}`);
    if (!onBoard(await labels(udid))) throw new Error("the board isn't showing over the dock");
    await shot(udid, "dock-after-swipe-light");
    return `${keyOf(before)} closed, ${keyOf(after)} on top, ${n - 1} left`;
  });
  await check("the dock comes back after the app is quit and relaunched", async () => {
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
    lastUrl.set(udid, BOARD);
    await shot(udid, "dock-relaunched-light");
    return `${keyOf(after)} on top of ${n}`;
  });
  await check("Projects closes every docked ticket", async () => {
    await tapWhere(udid, "Projects");
    await until("the Projects sheet", async () => (await labels(udid)).includes("Inbox"), 5000);
    await goto(udid, BOARD);
    await Bun.sleep(600);
    if ((await labels(udid)).some(isDock)) throw new Error("a dock is still there after Projects");
    return "all closed";
  });
  await check("past the five live ones, more docked tickets cost about nothing", async () => {
    // A parked ticket is the Router's root and path plus the board's card: 15 more of them must not
    // grow the app the way 15 more mounted ticket screens would.
    const many = await seedDockable(p.project.id, 20);
    const pid = (await sh(["pgrep", "-f", `${udid}/.*/Harness\\.app/Harness`], { allowFail: true, quiet: true })).trim().split("\n")[0];
    if (!pid) throw new Error("no Harness process for this simulator");
    const footprint = async () => {
      await Bun.sleep(2500); // the last screen settles and parks
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
    // Every ticket visited once first, so each measurement carries the same board data and caches.
    await open(many);
    await closeAll();
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
 * `k`'s iPad card sits in the bottom-right corner of the area left of `edge`: 16pt in (its ✕ ends
 * 10pt inside it), near the bottom, and about 320pt wide where the board's column (from `left`, the
 * sidebar's edge) has room.
 */
async function cardInCorner(udid: string, k: string, edge: number, H: number, left = 0) {
  const all = await nodes(udid);
  const open = all.find((n) => n.AXLabel?.startsWith(`${k}, `) && isDock(n.AXLabel));
  const close = all.find((n) => n.AXLabel === `Close ${k}`);
  if (!open || !close) throw new Error(`no card for ${k}`);
  const right = close.frame.x + close.frame.width + 10;
  if (Math.abs(edge - 16 - right) > 4) throw new Error(`${k}'s card ends at x=${Math.round(right)}, not 16pt in from ${Math.round(edge)}`);
  const below = H - (open.frame.y + open.frame.height);
  if (below < 0 || below > 70) throw new Error(`${k}'s card's bottom is ${Math.round(below)}pt above the window's bottom`);
  const width = right - open.frame.x;
  if (width < Math.min(300, edge - left - 40)) throw new Error(`${k}'s card is only ${Math.round(width)}pt wide`);
}

/**
 * The iPad's docked tickets as cards (DockedCardStack): opened one after another, the ones behind
 * the panel wait as cards just left of it, never over the sidebar (one "N docked…" card where the
 * board's column is narrow, none where there's no column); docked, every one is a card in the
 * bottom-right corner, newest at the bottom, showing its ref and title; a tap opens that one; its ✕
 * closes just it; twelve show five cards and "7 more…", which expands into the list of all twelve;
 * Projects closes them all.
 */
async function cardStackChecks(udid: string, s: { project: Project; conductor: Ticket }) {
  const ts = await seedDockable(s.project.id, 12);
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
    await Bun.sleep(800);
    // The default panel (80%) leaves no board column beside it: nothing over the sidebar.
    const wide = await offSidebar();
    // A narrow panel leaves room for full cards in the board's column.
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
    // A column about 190pt wide is too narrow for a card: one "2 docked…" card holds them, still
    // off the sidebar.
    const s1 = await settings();
    await dragPanelEdge(udid, s1.frame.x + s1.frame.width + 14 + 190);
    const collapsed = await until("one \"2 docked…\" card", async () => {
      const all = await offSidebar();
      return all.length === 1 && all[0]!.AXLabel === "2 docked tickets" ? all[0] : null;
    }, 4000).catch(async (e) => {
      await say("with a 190pt column");
      throw e;
    });
    await shot(udid, "panel-cards-collapsed-light");
    // Wider still, no column is left: nothing shows, and nothing sits over the sidebar.
    await dragPanelEdge(udid, W * 0.5);
    await until("no cards", async () => (await offSidebar()).length === 0, 4000).catch(async (e) => {
      await say("with the panel at 50%");
      throw e;
    });
    // And Settings still takes a tap.
    await tapWhere(udid, "Settings");
    moved(udid);
    await until("Settings", async () => (await labels(udid)).some((l) => l.startsWith("Rotate token")), 6000).catch(async (e) => {
      await say("after a tap on Settings");
      throw e;
    });
    // Back to the board (the section link docked the panel), the panel on c at its default width.
    await goto(udid, BOARD);
    await tapWhere(udid, cardOf(c.key));
    moved(udid);
    await until(`the panel on ${c.key}`, async () => panelOn(await labels(udid), c.key), 8000);
    await dragPanelEdge(udid, W * (1 - Math.min(0.8, 800 / W)));
    return `none over the sidebar at 80% (${wide.length} shown); ${a.key} over ${b.key} left of the panel at 25%; "2 docked…" at x=${Math.round(collapsed.frame.x)} beside a 190pt column; none at 50%; Settings tapped`;
  });
  await check("docked, every ticket is a card in the bottom-right corner; a tap opens that one", async () => {
    await tapWhere(udid, `Dock ${c.key}`);
    await until("three cards", async () => (await cards()).length === 3 && !(await labels(udid)).includes(RESIZE), 6000);
    await Bun.sleep(600);
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
    // The default panel leaves no column for cards: narrow it (back to the default after the next check).
    await dragPanelEdge(udid, W - 20);
    const left = (await cards()).map((n) => n.AXLabel!.split(",")[0]).sort();
    if (left.join() !== [b.key, c.key].sort().join()) throw new Error(`the cards beside the panel are ${left.join(", ")}`);
    return `${c.key} at the bottom; ${a.key} opened, ${left.join(" and ")} beside it`;
  });
  await check("a card's ✕ closes just that ticket", async () => {
    await tapWhere(udid, `Close ${b.key}`);
    await until(`${b.key}'s card gone`, async () => !(await labels(udid)).some(cardOf(b.key)), 5000);
    const l = await labels(udid);
    if (!panelOn(l, a.key)) throw new Error(`the panel left ${a.key}`);
    if (!l.some(cardOf(c.key))) throw new Error(`${c.key}'s card went too`);
    const { W } = await panelFraction(udid);
    await dragPanelEdge(udid, W * (1 - Math.min(0.8, 800 / W)));
    return `${b.key} closed; ${a.key} open, ${c.key} waiting`;
  });
  await check("with 12 docked there are 5 cards and \"7 more…\", which expands into the list of all twelve", async () => {
    for (const t of ts.slice(3)) await open(t);
    // a, c and the nine opened: 11; one more for 12.
    await open(b);
    await tapWhere(udid, `Dock ${b.key}`);
    await until("the cards", async () => !(await labels(udid)).includes(RESIZE) && (await cards()).length > 0, 6000);
    await Bun.sleep(800);
    const cs = await cards();
    const more = await findElement(udid, (l) => /^\d+ more docked tickets$/.test(l));
    await shootBoth(udid, "panel-cards-overflow");
    await appearance(udid, "light");
    if (cs.length !== 5) throw new Error(`${cs.length} cards, not 5`);
    if (more?.AXLabel !== "7 more docked tickets") throw new Error(`the more card reads "${more?.AXLabel ?? "(none)"}"`);
    // The more card sits on top of the five.
    if (cs.some((n) => n.frame.y < more.frame.y)) throw new Error("a card sits above the more card");
    const shown = new Set(cs.map((n) => n.AXLabel!.split(",")[0]));
    if (shown.has(a.key) || shown.has(c.key)) throw new Error(`the oldest aren't the ones behind "7 more": ${[...shown].join(", ")}`);
    await tapWhere(udid, more.AXLabel!);
    await until("the list of all twelve", async () => (await cards()).length === 12, 5000).catch(async (e) => {
      await say("after 7 more");
      throw e;
    });
    await shot(udid, "panel-cards-list-light");
    await offSidebar();
    await tapWhere(udid, cardOf(a.key));
    moved(udid);
    await until(`the panel on ${a.key}`, async () => panelOn(await labels(udid), a.key), 8000);
    return `5 cards and 7 more; the list of 12; ${a.key} opened from it`;
  });
  await check("Projects closes every docked ticket", async () => {
    await goto(udid, "harness://projects");
    await goto(udid, BOARD);
    await until("no panel or cards", async () => {
      const l = await labels(udid);
      return !l.includes(RESIZE) && !l.some(isDock);
    }, 6000);
    return "all closed";
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
  await Bun.sleep(700);
  return (await panelFraction(udid)).fraction;
}

/**
 * The iPad's ticket side panel (TicketSidePanel, regular width): a board card opens it against the
 * trailing edge at TicketPanelWidth's default; its leading handle resizes it within 25–80% of the
 * window; a link inside pushes, a card from the board opens over it; the dock button stashes it
 * as a card in the bottom-right corner, which restores it with its path, and a card's ✕ closes it; New session opens in it; Escape closes it; and the pop-out button moves its ticket into a
 * window of its own.
 */
async function panelChecks(udid: string, s: { project: Project; conductor: Ticket }) {
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
    return { x: leading + 29, y: close.frame.y + close.frame.height / 2 + 58 };
  };
  /**
   * Taps where the panel's navigation bar keeps Back: AXe's tree leaves out the glass header items,
   * so a push shows by where the tap goes. It sits 29pt in from the panel's leading edge, 58pt
   * below the title bar's buttons.
   */
  const tapBack = async () => {
    const { x, y } = await backPoint();
    await axe("tap", "-x", String(Math.round(x)), "-y", String(Math.round(y)), "--udid", udid);
    moved(udid);
  };
  /** The panel's ticket screen went back to `k`: Back was there. */
  const backTo = async (k: string) => {
    await tapBack();
    await until(`Back to ${k}`, async () => panelOn(await labels(udid), k), 6000).catch(async (e) => {
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
      await Bun.sleep(600);
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
    await Bun.sleep(800); // the slide in
    const { fraction, leading, W } = await panelFraction(udid);
    if (fraction < 0.25 - 0.01 || fraction > 0.8 + 0.01) throw new Error(`the panel is ${pct(fraction)} of the window`);
    // TicketPanelWidth's default, before anyone drags the edge: 800pt, clamped to 25–80%.
    const expected = Math.min(0.8, Math.max(0.25, 800 / W));
    if (Math.abs(fraction - expected) > 0.02) throw new Error(`the panel opened at ${pct(fraction)}, not the default ${pct(expected)}`);
    // Trailing-aligned: its close button sits at the window's right edge.
    const close = await findElement(udid, (l) => l === `Close ${key}`);
    if (!close || W - (close.frame.x + close.frame.width) > 16) throw new Error(`the close button ends at ${close ? Math.round(close.frame.x + close.frame.width) : "?"}, not the window's edge (${W})`);
    // The board stays live to its left.
    if (!onBoard(await labels(udid))) throw new Error("the board isn't showing beside the panel");
    // Below the status bar: no higher than the split view's own top bar, which keeps the safe area.
    const toggle = await findElement(udid, (l) => l === "Hide Sidebar" || l === "Show Sidebar");
    if (toggle && close.frame.y < toggle.frame.y - 4) throw new Error(`the title bar's buttons start at y=${Math.round(close.frame.y)}, above the sidebar button (y=${Math.round(toggle.frame.y)})`);
    await shootBoth(udid, "panel-default");
    await appearance(udid, "light");
    return `${key} at ${pct(fraction)} (${Math.round(W - leading)} of ${W} pt)`;
  });
  await check("the panel's header names its ticket once", async () => {
    const { leading } = await panelFraction(udid);
    const inPanel = (await nodes(udid)).filter((n) => n.frame.x >= leading && n.AXLabel);
    // The title bar's header ("KEY" or "KEY, <subtitle>"); the ticket's own navigation bar leaves its key out.
    const named = inPanel.filter((n) => n.AXLabel === key || n.AXLabel!.startsWith(`${key},`) || n.AXLabel!.startsWith(`${key} ·`));
    if (named.length !== 1) throw new Error(`${named.length} labels in the panel name ${key}: ${named.map((n) => `"${n.AXLabel}" at y=${Math.round(n.frame.y)}`).join(", ")}`);
    return `"${named[0]!.AXLabel}"`;
  });
  await check("dragging the panel's edge resizes it, stopping at 25% and 80% of the window", async () => {
    const { W } = await panelFraction(udid);
    const narrow = await dragPanelEdge(udid, W - 20);
    await shot(udid, "panel-min-light");
    const wide = await dragPanelEdge(udid, 20);
    await shot(udid, "panel-max-light");
    if (Math.abs(narrow - 0.25) > 0.015) throw new Error(`dragged to the right edge, the panel stopped at ${pct(narrow)}`);
    if (Math.abs(wide - 0.8) > 0.015) throw new Error(`dragged to the left edge, the panel stopped at ${pct(wide)}`);
    // Back to the default (the pref keeps the width across launches).
    const back = await dragPanelEdge(udid, W * (1 - Math.min(0.8, 800 / W)));
    return `${pct(narrow)}–${pct(wide)}, back to ${pct(back)}`;
  });
  await check("a link inside the panel pushes, with Back to the ticket under it", async () => {
    // The Tickets tab, until its list shows the child (a tap during the slide in can miss).
    await until("the conductor's children", async () => {
      if ((await labels(udid)).some((l) => l.includes(kid.key))) return true;
      await tapWhere(udid, (l) => l.startsWith("Tickets")).catch(() => {});
      await Bun.sleep(1200);
      return false;
    }, 15000, 0);
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child in the panel", async () => panelOn(await labels(udid), kid.key), 8000).catch(async (e) => {
      await say("after the child tap");
      throw e;
    });
    await Bun.sleep(600);
    await shot(udid, "panel-pushed-light");
    await backTo(key);
    // Pushed again, for the dock to keep.
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child in the panel", async () => panelOn(await labels(udid), kid.key), 8000);
    return `${key} → ${kid.key}, Back → ${key}`;
  });
  await check("docking stashes the panel as a card in the bottom-right corner, and the card restores its path", async () => {
    await tapWhere(udid, `Dock ${kid.key}`);
    const pill = await until("the card", async () => {
      const n = await findElement(udid, isDock);
      return n && !(await labels(udid)).includes(RESIZE) ? n : null;
    }, 6000).catch(async (e) => {
      await say("after the dock button");
      throw e;
    });
    await Bun.sleep(700);
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
    await Bun.sleep(600);
    await backTo(key);
    return `${p.frame.x}+${p.frame.width} of ${W}, y ${Math.round(mid)} of ${H}; restored on ${kid.key}, Back to ${key}`;
  });
  await check("a different board card opens its ticket over the panel's, at its root", async () => {
    // Pushed again, so a push that kept the path would show.
    await tapWhere(udid, (l) => l.includes(kid.key));
    await until("the child", async () => panelOn(await labels(udid), kid.key), 8000);
    await Bun.sleep(600);
    // The default panel can leave too little of the board for a card beside it: narrow it first.
    const { W } = await panelFraction(udid);
    await dragPanelEdge(udid, W * 0.5);
    const edge = (await panelFraction(udid)).leading - 16;
    // Any other card already beside the panel (the walk-through's columns are full), else this run's own.
    const beside = (await nodes(udid)).find((n) => /^[A-Z]+-\d+ /.test(n.AXLabel ?? "") && !card(key)(n.AXLabel!) && !card(kid.key)(n.AXLabel!) && !n.AXLabel!.endsWith(", draft") && n.frame.x >= 0 && n.frame.x + 20 < edge);
    const b = beside ? beside.AXLabel!.split(" ")[0]! : other.key;
    if (!beside) await cardOnScreen(b, edge);
    await tapCard(b);
    await until(`the panel on ${b}`, async () => panelOn(await labels(udid), b), 8000).catch(async (e) => {
      await say(`after ${b}'s card`);
      throw e;
    });
    await Bun.sleep(600);
    await shot(udid, "panel-replaced-light");
    // At the root there's no Back: a tap where it would be leaves the panel on B.
    await tapBack();
    await Bun.sleep(1500);
    const l = await labels(udid);
    if (panelOn(l, kid.key) || panelOn(l, key)) throw new Error(`${b} was pushed over ${kid.key}: Back went to ${panelOn(l, key) ? key : kid.key}`);
    if (!panelOn(l, b)) throw new Error(`the panel left ${b}`);
    await dragPanelEdge(udid, W * (1 - Math.min(0.8, 800 / W)));
    return `${kid.key} → ${b}, no Back`;
  });
  await check("a card's ✕ closes just its ticket without opening it", async () => {
    const l = await labels(udid);
    const top = l.find((x) => x.startsWith("Dock "))!.slice("Dock ".length);
    await tapWhere(udid, `Dock ${top}`);
    await until("the cards", () => findElement(udid, isDock), 6000);
    await Bun.sleep(600);
    await shot(udid, "panel-cards-two-light");
    // The card's ticket and the conductor's, which it joined in the dock: each closes on its own.
    const closed: string[] = [];
    for (const k of [top, kid.key]) {
      const mine = (x: string) => x.startsWith(`${k}, `) && isDock(x);
      await until(`${k}'s card`, () => findElement(udid, mine), 6000).catch(async (e) => {
        await say("looking for the card");
        throw e;
      });
      const others = (await labels(udid)).filter((x) => isDock(x) && !mine(x));
      await tapWhere(udid, `Close ${k}`);
      await until(`${k}'s card gone`, async () => !(await labels(udid)).some(mine), 5000);
      await Bun.sleep(600);
      const now = await labels(udid);
      if (now.includes(RESIZE)) throw new Error("the panel opened instead");
      const left = others.filter((o) => !now.includes(o));
      if (left.length) throw new Error(`closing ${k} took ${left.join(", ")} with it`);
      closed.push(k);
    }
    if ((await labels(udid)).some(isDock)) throw new Error("a card is still there");
    lastUrl.set(udid, BOARD);
    return `${closed.join(", then ")} closed, one at a time`;
  });
  await check("New session opens in the side panel", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(s.project.id)}`, (l) => l.some(isOptions));
    await Bun.sleep(600);
    const l = await labels(udid);
    if (!panelOn(l, "New session")) throw new Error("New session isn't in the panel");
    if (l.includes("Open New session in a new window")) throw new Error("New session offers a pop-out");
    await shot(udid, "panel-new-session-light");
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
    await Bun.sleep(1500);
    if (!panelOn(await labels(udid), "New session")) throw new Error("a second ✕ in New session's bar closed the panel");
    // The landscape-only build draws the keyboard in the device's portrait space, over the title
    // bar's close button: Escape closes it there.
    if (landscape) {
      await axe("key", "41", "--udid", udid);
      await until("no panel", async () => !(await labels(udid)).includes(RESIZE), 5000);
      moved(udid);
    } else await closePanel();
    return `New session in the panel, one title and one ✕${landscape ? " (the title by AXe only)" : ""}, no pop-out`;
  });
  await check("with a draft typed, the panel's ✕ and Escape ask Discard or Save, and Discard leaves no draft", async () => {
    const words = "Throw this panel draft away";
    const ours = (l: string) => l.includes(words);
    await goto(udid, `harness://new?projectId=${encodeURIComponent(s.project.id)}`, (l) => l.some(isOptions) && panelOn(l, "New session"));
    await Bun.sleep(600);
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
    return `asked on Escape and on the panel's ✕${landscape ? " (Escape, in landscape)" : ""}; Discard closed it and its card went`;
  });
  await check("Escape on a hardware keyboard closes the panel", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}`, (l) => panelOn(l, key));
    await Bun.sleep(600);
    await axe("key", "41", "--udid", udid); // HID Escape
    await until("the panel gone", async () => !(await labels(udid)).includes(RESIZE), 5000);
    moved(udid);
    return "closed";
  });
  await check("the pop-out button moves the panel's ticket into a window of its own", async () => {
    // A throwaway ticket: closing its window deletes it (More → Delete ticket destroys the scene).
    const t = await api<Ticket>("POST", "/tickets", { projectId: s.project.id, spec: "Pop me out", driver: "dummy", start: false });
    await goto(udid, `harness://ticket/${encodeURIComponent(t.key)}`, (l) => panelOn(l, t.key));
    await Bun.sleep(600);
    await tapWhere(udid, `Open ${t.key} in a new window`);
    moved(udid);
    const up = await until(`${t.key}'s window`, async () => {
      const l = await labels(udid);
      return ticketShown(l, t.key) && !l.includes(RESIZE);
    }, 10000).catch((e) => e as Error);
    await Bun.sleep(800);
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
      await Bun.sleep(500);
    }
    await Bun.sleep(flick ? 900 : 600); // a fling's momentum runs on after the finger lifts
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
    await Bun.sleep(500);
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
  // Each tab's content runs on under the composer's glass rather than stopping above it: the pager
  // reaches the bottom of the screen, and only the scroll content's inset keeps the last row clear.
  for (const tab of ["spec", "activity", "transcript"]) {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=${tab}`);
    await Bun.sleep(1200);
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
    await swipe("down", 3);
    if (await heroShown()) throw new Error("expanded on scrolling back");
    return `tab strip ${Math.round(before)}→${Math.round(after)}; stayed collapsed scrolling back to the top`;
  });
  await check("another tab collapses the hero, and back on the Spec it stays collapsed", async () => {
    await expandHero();
    await until("the hero after tapping its title", async () => (await heroShown()) || null, 3000);
    await shot(udid, "hero-expanded");
    await tapLabel(udid, "Transcript");
    await until("the hero collapsed on the Transcript", async () => !(await heroShown()) || null, 3000);
    await tapLabel(udid, "Spec");
    await Bun.sleep(800);
    if (await heroShown()) throw new Error("expanded back on the Spec");
    return "collapsed on the Transcript and still collapsed back on the Spec";
  });
  await check("other tabs open with the hero collapsed", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=transcript`);
    await until("the tab strip", stripY, 8000);
    await Bun.sleep(800);
    if (await heroShown()) throw new Error("opened expanded");
    await shot(udid, "hero-transcript");
    return "collapsed";
  });
  await check("the Browser tab shows the same collapsed header, and a tap expands it", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=browser`);
    await until("the tab strip", stripY, 8000);
    await Bun.sleep(800);
    if (await heroShown()) throw new Error("opened expanded");
    await shot(udid, "hero-browser");
    await expandHero();
    await until("the hero after tapping its title", async () => (await heroShown()) || null, 3000);
    await shot(udid, "hero-browser-expanded");
    await expandHero();
    await until("the hero collapsed again", async () => !(await heroShown()) || null, 3000);
    return "collapsed title row on open; a tap expands and collapses it";
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
  await check("a sideways swipe changes tab, and on the Spec goes back", async () => {
    // From the board, so going back lands there (ticket links push onto the screens before them).
    await goto(udid, BOARD);
    await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=spec`, (l) => l.some(spec));
    await until("the Spec", async () => (await shows(spec)) || null, 5000);
    await sideways(0.85, 0.1);
    await until("Activity after swiping left", async () => ((await shows(activityRow)) && !(await shows(spec))) || null, 5000);
    await sideways(0.15, 0.9);
    await until("the Spec after swiping right", async () => ((await shows(spec)) && !(await shows(activityRow))) || null, 5000);
    await Bun.sleep(800); // the page settles: back only goes once the pager rests on the first page
    await sideways(0.1, 0.9);
    await until("the board after swiping right on the Spec", async () => onBoard(await labels(udid)) || null, 5000);
    moved(udid);
    return "Spec → Activity → Spec → back to the board";
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
    await Bun.sleep(600);
    const field = (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Message the agent"));
    await shot(udid, "keyboard-composer");
    if (!field) throw new Error("the composer is gone from the screen (behind the keyboard)");
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the composer's field ends ${-gap}pt behind the keyboard (field ends at ${Math.round(bottomOf(field))}, keyboard at ${Math.round(top)})`);
    if (gap > 40) throw new Error(`${gap}pt gap between the composer and the keyboard`);
    return `field ends ${gap}pt above the keyboard`;
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
    await Bun.sleep(900);
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
    await Bun.sleep(900);
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
    await Bun.sleep(600);
    if (await keyboardTop()) throw new Error("the keyboard came up before the tap");
    // AXe reports the text view's own frame: one line of text in it, so a short frame means the
    // height is a frame or padding around the text view, which a tap or drag doesn't reach.
    const tall = Math.round(start.frame.height);
    if (tall < 120) throw new Error(`the text view is ${tall}pt tall with one line in it: it doesn't fill its row`);
    await shot(udid, "keyboard-new-session-row-idle");
    const y = Math.round(start.frame.y + start.frame.height - 10);
    await axe("tap", "-x", String(Math.round(start.frame.x + start.frame.width / 2)), "-y", String(y), "--udid", udid);
    await until("keyboard up", keyboardTop, 5000).catch(() => {
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
    await Bun.sleep(600);
    const top = (await keyboardTop())!;
    await shot(udid, "keyboard-new-session-corner");
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
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", file, "-vf", `crop=1:${height}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdout: "pipe", stderr: "pipe" });
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
  /** The spec as typed in New session: revision 1 (the dummy's run adds a Status section after it). */
  const typed = async (key: string) => (await api<SpecRevision>("GET", `/tickets/${encodeURIComponent(key)}/spec/revisions/1`)).body;

  // (Picking a folder keeps the list open inside it: insertMention and mentionCaret's unit tests.)
  await check("New session: @READ lists README.md, a tap completes it, the run gets the file", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "Summarize @READ", "--udid", udid);
    await until("README.md suggested", () => has("README.md"), 8000);
    await Bun.sleep(300);
    await shootBoth(udid, "mentions-new-session");
    await tapWhere(udid, "README.md");
    await until("list closed", async () => !(await has("README.md")), 4000);
    await tapToolbar(0);
    moved(udid);
    // The draft is saved while it's typed; wait for it to launch.
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => x.key !== p.ticket.key && !x.draft), 10000);
    const spec = await typed(t.key);
    if (spec !== "Summarize @README.md") throw new Error(`spec is ${JSON.stringify(spec)}`);
    await until("Attached status", async () => (await texts(t.key)).includes("Attached @README.md"), 15000);
    return `${t.key}: ${spec}`;
  });

  await check("New session: the toolbar's Plan first launches the draft in planning, on its Spec tab", async () => {
    const before = new Set((await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).map((x) => x.key));
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await shootBoth(udid, "new-session-toolbar-empty");
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "Plan the readme", "--udid", udid);
    await Bun.sleep(300);
    await shootBoth(udid, "new-session-toolbar");
    await tapToolbar(1);
    moved(udid);
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => !before.has(x.key) && !x.draft), 10000);
    if (t.status !== "planning") throw new Error(`${t.key} launched in ${t.status}, not planning`);
    // The Spec tab's revision bar ("Show changes") is on no other tab.
    await until(`${t.key}'s Spec tab`, async () => (await labels(udid)).includes("Show changes"), 8000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).join(" | ")}`);
    });
    return `${t.key} in planning, on its Spec tab`;
  });

  await check("composer: @src/a lists src/app.ts, the message's run gets the file", async () => {
    await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`, (l) => l.some((x) => x.startsWith("Message the agent")));
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    // iOS may capitalize the first word, so the message is compared without case.
    await axe("type", "see @src/a", "--udid", udid);
    await until("src/app.ts suggested", () => has("src/app.ts"), 8000);
    await Bun.sleep(300); // let the list settle before aiming at a row
    await shootBoth(udid, "mentions-composer");
    await tapWhere(udid, "src/app.ts");
    // Picking closes the list and the composer shrinks, which moves Send.
    await until("list closed", async () => !(await has("src/app.ts")), 4000);
    await Bun.sleep(300);
    await tapWhere(udid, "Send");
    await until("message with the mention", async () => (await texts(p.ticket.key)).some((t) => t.toLowerCase() === "see @src/app.ts"), 10000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; transcript ends ${JSON.stringify((await texts(p.ticket.key)).slice(-4))}`);
    });
    await until("Attached status", async () => (await texts(p.ticket.key)).includes("Attached @src/app.ts"), 15000);
    return "see @src/app.ts";
  });

  await check("New session: /co lists the agent's commands, a tap completes one, the CLI gets it as typed", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.slash.id)}`, (l) => l.some((x) => x.startsWith("Spec")));
    await tapWhere(udid, (l) => l.startsWith("Spec"));
    await axe("type", "/co", "--udid", udid);
    // The first lookup starts the (fake) CLI.
    await until("/code-walk suggested", () => has("/code-walk"), 15000);
    if (!(await has("/commit-and-pr")) || (await has("/vercel:deploy"))) throw new Error(`the list isn't /co's: ${JSON.stringify((await labels(udid)).filter((l) => l.startsWith("/")))}`);
    await Bun.sleep(300);
    await shootBoth(udid, "mentions-commands");
    await tapWhere(udid, "/code-walk");
    await until("list closed", async () => !(await has("/code-walk")), 4000);
    await axe("type", "this branch", "--udid", udid);
    await Bun.sleep(300);
    await tapToolbar(0);
    moved(udid);
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.slash.id}`)).find((x) => !x.draft), 10000);
    const spec = await typed(t.key);
    if (spec !== "/code-walk this branch") throw new Error(`spec is ${JSON.stringify(spec)}`);
    const sent = await until(
      "the agent's prompt",
      async () =>
        existsSync(claudeRecord) &&
        readFileSync(claudeRecord, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
          .find((r) => r.argv.includes("--mcp-config"))?.stdin,
      15000,
    );
    if (!sent.startsWith("/code-walk this branch")) throw new Error(`the CLI got ${JSON.stringify(sent.slice(0, 80))}`);
    return `${t.key}: ${spec}`;
  });
}

/** --drafts: real typing in the composer against message drafts saved and changed on the service. */
async function draftChecks(udid: string, p: Awaited<ReturnType<typeof seedTicket>>) {
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

  await check("composer: typing saves the message draft to the ticket, with the phone's origin", async () => {
    await open();
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    await axe("type", "started on the phone", "--udid", udid);
    const d = await until("the draft saved", async () => {
      const got = await saved();
      return got?.text.toLowerCase() === "started on the phone" ? got : null;
    }, 8000);
    origin = d.origin;
    if (!origin || origin === "sim-check-mac") throw new Error(`origin is ${JSON.stringify(origin)}`);
    return `"${d.text}" from ${origin}`;
  });

  await check("composer: moving the caret keeps what's typed", async () => {
    const el = await until("the composer", () => findElement(udid, (l) => l.startsWith("Message the agent")), 4000);
    const y = String(Math.round(el.frame.y + el.frame.height / 2));
    // Near the start of the text, then back near its end: each tap only moves the caret.
    for (const x of [el.frame.x + 22, el.frame.x + el.frame.width / 2]) {
      await axe("tap", "-x", String(Math.round(x)), "-y", y, "--udid", udid);
      await Bun.sleep(700);
      const shown = await field();
      if (shown.toLowerCase() !== "started on the phone") throw new Error(`after moving the caret the field shows ${JSON.stringify(shown)}`);
    }
    await Bun.sleep(1200);
    const d = await saved();
    if (d?.text.toLowerCase() !== "started on the phone") throw new Error(`the draft is ${JSON.stringify(d)}`);
    return "kept";
  });

  await check("composer: another device's draft waits while the field is being typed in", async () => {
    await fromMac("Finished on the Mac");
    await Bun.sleep(1200);
    const shown = await field();
    if (shown.toLowerCase() !== "started on the phone") throw new Error(`the field shows ${JSON.stringify(shown)}`);
    await shootBoth(udid, "drafts-typing");
    return shown;
  });

  await check("composer: once the field isn't being typed in, another device's draft shows", async () => {
    await away();
    await fromMac("Finished on the Mac, really");
    await open();
    const shown = await until("the Mac's draft in the field", async () => ((await field()) === "Finished on the Mac, really" ? true : null), 6000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; the field shows ${JSON.stringify(await field())}`);
    });
    // Taking it isn't an edit: nothing is saved back over the Mac's.
    await Bun.sleep(1200);
    const d = await saved();
    if (d?.origin !== "sim-check-mac") throw new Error(`the phone saved over it: ${JSON.stringify(d)}`);
    await shootBoth(udid, "drafts-adopted");
    return shown ? "Finished on the Mac, really" : "";
  });

  await check("composer: Send uses the draft up on the service and empties the field", async () => {
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    await axe("type", " now", "--udid", udid);
    await until("the edit saved", async () => ((await saved())?.text === "Finished on the Mac, really now" ? true : null), 8000);
    await tapWhere(udid, "Send");
    await until("the draft cleared", async () => ((await saved()) === null ? true : null), 8000);
    // An empty field reads its placeholder as its value.
    await until("the field emptied", async () => (/finished/i.test(await field()) ? null : true), 4000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; the field shows ${JSON.stringify(await field())}`);
    });
    const texts = (await api<TranscriptEntry[]>("GET", `/sessions/${p.ticket.sessionId}/transcript`)).map((e) => ("text" in e.content ? e.content.text : ""));
    if (!texts.includes("Finished on the Mac, really now")) throw new Error(`transcript ends ${JSON.stringify(texts.slice(-3))}`);
    return "sent and cleared";
  });
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
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-i", file, "-vf", `crop=iw:ih-${top + bottom}:0:${top},cropdetect=limit=24:round=1:reset=0:skip=0`, "-frames:v", "1", "-f", "null", "-"], { stdout: "pipe", stderr: "pipe" });
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
    const el = await until(`element ${label}`, () => findElement(udid, (l) => l === label), 5000);
    const y = el.frame.y + Math.min(el.frame.height / 2, 60);
    await axe("tap", "-x", String(Math.round(el.frame.x + el.frame.width / 2)), "-y", String(Math.round(y)), "--udid", udid);
    await until(`viewer on ${n} of 5`, () => has(counter(n)), 5000);
    await Bun.sleep(800);
  };

  await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=spec`, (l) => l.includes("Image phone.png"));
  await Bun.sleep(1200); // let the images and the video's first frame load
  await check("every attachment shows inline in the spec", async () => {
    // An image that won't load is tried as a video before it shows "Couldn't load", so the missing
    // one may be labelled either way.
    const want = ["Image phone.png", "Image wide.png", "Image small.png", "Video flow.mp4", "Image broken.png|Video broken.png"];
    const l = await labels(udid);
    const missing = want.filter((w) => !w.split("|").some((x) => l.includes(x)));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    return want.join(", ");
  });
  await check("thumbnails are 100 pt squares and the figure spans the width", async () => {
    const thumbs = await Promise.all(["Image phone.png", "Image wide.png", "Image small.png"].map((l) => findElement(udid, (x) => x === l)));
    for (const t of thumbs) if (!t || Math.round(t.frame.width) !== 100 || Math.round(t.frame.height) !== 100) throw new Error(`thumbnail frame ${JSON.stringify(t?.frame)}`);
    await scrollTo(udid, (l) => l === "Video flow.mp4");
    const fig = await findElement(udid, (x) => x === "Video flow.mp4");
    if (!fig || fig.frame.width < 300) throw new Error(`figure frame ${JSON.stringify(fig?.frame)}`);
    return `thumbnails 100×100, figure ${Math.round(fig.frame.width)} pt wide`;
  });
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
    await Bun.sleep(1500); // the video's first frames
    await shot(udid, "attachments-viewer-video-light");
    await swipeLeft();
    await until("paged to 5 of 5", () => has(counter(5)), 5000);
    await Bun.sleep(800);
    await shot(udid, "attachments-viewer-failed-light");
    await tapWhere(udid, "Close");
    await closed();
    return "2 of 5 → 3 of 5 → 4 of 5 → 5 of 5 → closed";
  });
  await check("an image smaller than the screen opens centred at its own size", async () => {
    // A 300 × 652 image used to open with its top-left corner in the middle of the page: it already
    // had its fitted size, so its scroll view's content size was never set.
    await open("Image small.png", 3);
    await shot(udid, "attachments-viewer-small");
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
    await Bun.sleep(1000);
    await swipeDown();
    await closed();
    return "closed";
  });
}

// ---------------------------------------------------------------- walk-through
type Seeded = Awaited<ReturnType<typeof seed>>;
interface Screen {
  name: string;
  url: string;
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
  await until("options open", async () => (await labels(udid)).some((l) => l.startsWith("Model, ")), 5000);
  await Bun.sleep(400);
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
  await Bun.sleep(500);
}
/** A ticket screen for `key` is up: its key and its tab strip. */
const ticketShown = (l: string[], key: string) => l.includes(key) && l.includes("Spec") && l.includes("Details");
function screens(s: Seeded): Screen[] {
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const hasLabel = (x: string) => (l: string[]) => l.includes(x);
  const pluginLoaded = (l: string[]) => l.includes("Changes") && !l.includes("In progress");
  return [
    // The iPad keeps the sidebar in a split view column (harness://projects only shows it), so it
    // shoots the board with the sidebar hidden instead, and the link brings the sidebar back.
    ipad
      ? {
          name: "board-no-sidebar",
          url: BOARD,
          seconds: 8,
          prepare: (udid) => toggleSidebar(udid, false),
          after: (udid) => simctl("openurl", udid, "harness://projects").then(() => until("sidebar shown again", async () => sidebarShown(await labels(udid)), 8000)),
        }
      : { name: "projects", url: "harness://projects" },
    { name: "ticket-spec", url: `harness://ticket/${k(s.hello)}?tab=spec` },
    // The notes, submits and review decisions; the seed's reply went to the transcript only.
    { name: "ticket-activity", url: `harness://ticket/${k(s.hello)}?tab=activity`, ready: (l) => l.some((x) => x.includes("The dummy reviewer approves")) },
    { name: "ticket-transcript", url: `harness://ticket/${k(s.hello)}?tab=transcript` },
    { name: "ticket-details", url: `harness://ticket/${k(s.hello)}?tab=details` },
    { name: "ticket-transcript-tables", url: `harness://ticket/${k(s.tables)}?tab=transcript`, ready: (l) => l.some((x) => x.startsWith("Run finished (review)")) },
    // The spec's fenced code: plain at first, colored once its grammar has loaded.
    { name: "ticket-code", url: `harness://ticket/${k(s.code)}?tab=spec`, wait: 1500 },
    { name: "ticket-diff", url: `harness://ticket/${k(s.diff)}?tab=spec`, wait: 1500 },
    // The file viewer, from an OS-level harness://file link : opened at a range
    // below the first screenful, then its Diff tab.
    { name: "file", url: `harness://file/${GREETINGS_PATH}?ticket=${k(s.changes)}#L${GREET_JA[0]}-L${GREET_JA[1]}`, ready: hasLabel("Modified"), wait: 1500 },
    {
      name: "file-diff",
      url: `harness://file/${GREETINGS_PATH}?ticket=${k(s.changes)}`,
      ready: hasLabel("Modified"),
      seconds: 6,
      prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Diff")).then(() => Bun.sleep(1500)),
    },
    { name: "conductor-tickets", url: `harness://ticket/${k(s.conductor)}?tab=children` },
    { name: "ticket-agents", url: `harness://ticket/${k(s.agents)}?tab=agents` },
    { name: "ticket-subagent", url: `harness://ticket/${k(s.agents)}?tab=${encodeURIComponent(`agent:${s.nestedAgent.id}`)}` },
    { name: "ticket-tasks", url: `harness://ticket/${k(s.tasks)}?tab=agents`, ready: (l) => l.some((x) => x.startsWith("Count to 30")) },
    { name: "ticket-task-output", url: `harness://ticket/${k(s.tasks)}?tab=${encodeURIComponent(`agent:${s.task.id}`)}`, ready: hasLabel("Back to Agents & tasks") },
    { name: "approval", url: `harness://ticket/${k(s.approval)}`, ready: hasLabel("Allow once") },
    { name: "approval-config", url: `harness://ticket/${k(s.configApproval)}`, ready: hasLabel("Allow once") },
    { name: "blocked", url: `harness://ticket/${k(s.blocked)}` },
    { name: "planning", url: `harness://ticket/${k(s.plan)}`, ready: hasLabel("Start work") },
    // The plugin's WebView shows a spinner ("In progress") until its page has loaded, and reloads
    // when the appearance flips.
    { name: "changes", url: `harness://ticket/${k(s.changes)}?tab=plugin:git:changes`, ready: pluginLoaded, wait: 500, seconds: 9, redrawn: (udid) => Bun.sleep(FLIP_MS).then(() => until("plugin reloaded", async () => pluginLoaded(await labels(udid)), 8000).catch(() => {})) },
    { name: "new-session", url: "harness://new" },
    // The git project's New session with Options open: the TicketSettings rows Details shows.
    { name: "new-session-options", url: `harness://new?projectId=${s.project.id}`, ready: (l) => l.some(isOptions), seconds: 6, prepare: (udid) => openOptions(udid) },
    // The same, with the branch sheet open, searching "re": Create re, then release/v2 (checked
    // out in another worktree).
    {
      name: "new-session-branch",
      url: `harness://new?projectId=${s.project.id}`,
      ready: (l) => l.some(isOptions),
      seconds: 7,
      prepare: (udid) =>
        openOptions(udid)
          .then(() => tapWhere(udid, (l) => l.startsWith("Branch, ")))
          .then(() => until("branch sheet", async () => (await labels(udid)).includes("Search branches"), 5000))
          // The field takes focus as the sheet finishes sliding up; typing before that drops keys.
          .then(() => Bun.sleep(800))
          .then(() => axe("type", "re", "--udid", udid))
          .then(() => until("branch rows", async () => (await labels(udid)).some((x) => x.startsWith("release/v2")), 5000)),
      // The sheet is a Modal, which the next screen's deep link would leave on top.
      after: (udid) => tapWhere(udid, "Cancel").then(() => until("branch sheet closed", async () => !(await labels(udid)).includes("Search branches"), 5000)),
    },
    // The seeded draft reopened, then Cancel: the Save draft / Discard draft / Keep editing sheet.
    {
      name: "new-session-cancel",
      url: `harness://new?key=${k(s.draft)}`,
      ready: (l) => l.some(isOptions),
      seconds: 6,
      prepare: (udid) => tapHeaderCancel(udid).then(() => until("cancel sheet", async () => (await labels(udid)).includes("Discard draft"), 5000)).then(() => Bun.sleep(500)),
      after: (udid) => tapWhere(udid, "Keep editing").then(() => Bun.sleep(400)),
    },
    // Scrolled down past the plan to the Branch and Base branch rows.
    {
      name: "ticket-details-branch",
      url: `harness://ticket/${k(s.branchPlan)}?tab=details`,
      prepare: async (udid) => {
        for (let i = 0; i < 2; i++) await axe("swipe", "--start-x", "200", "--start-y", "720", "--end-x", "200", "--end-y", "330", "--duration", "0.6", "--udid", udid);
        await Bun.sleep(700);
      },
    },
    // The git project's New session with Options open, scrolled to Skip agent review.
    { name: "new-session-skip-review", url: `harness://new?projectId=${s.project.id}`, ready: (l) => l.some(isOptions), seconds: 8, prepare: (udid) => openOptions(udid).then(() => scrollTo(udid, (l) => l === "Skip agent review")).then(() => Bun.sleep(500)) },
    // A ticket in review whose agent review was skipped: the muted mark in the header, and the
    // switch (on) on its Details tab.
    // A ticket linked to a remote ID: the header shows "JIRA-62 · GREET-n", and Details the External
    // row with the other ticket on JIRA-62 under it.
    {
      name: "ticket-linked",
      url: `harness://ticket/${k(s.linked)}?tab=details`,
      ready: (l) => l.includes("Remote ID"),
      seconds: 6,
      prepare: (udid) => scrollTo(udid, (l) => l === "Also linked to JIRA-62").then(() => Bun.sleep(400)),
    },
    // A remote ID that no local key matches opens to the tickets linked to it, not a dead end.
    { name: "ticket-remote-id", url: "harness://ticket/JIRA-62", ready: (l) => l.includes("Remote ID JIRA-62") && l.some((x) => x.startsWith(`JIRA-62 · ${s.linkedStage.key} `)) },
    { name: "ticket-details-skip-review", url: `harness://ticket/${k(s.quick)}?tab=details`, ready: hasLabel("Agent review: skipped"), seconds: 7, prepare: (udid) => scrollTo(udid, (l) => l === "Skip agent review").then(() => Bun.sleep(500)) },
    // Details' one Model picker (driver + model) with its sheet open.
    {
      name: "ticket-details-model",
      url: `harness://ticket/${k(s.quick)}?tab=details`,
      seconds: 7,
      prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Model, ")).then(() => until("model sheet", async () => (await labels(udid)).includes("Search models"), 5000)),
      // The sheet is a Modal, which the next screen's deep link would leave on top.
      after: (udid) => tapWhere(udid, "Cancel").then(() => until("model sheet closed", async () => !(await labels(udid)).includes("Search models"), 5000)),
    },
    { name: "inbox", url: "harness://inbox" },
    { name: "settings", url: "harness://settings" },
    // Settings → Drivers: a row per driver that opens its settings, with the Default model picker under them.
    { name: "settings-models", url: "harness://settings", seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l.startsWith("Default model, ")).then(() => Bun.sleep(500)) },
    // A driver's own settings: status, sign-in and review model; Claude Code adds its long-lived
    // token and Anthropic API its API key.
    { name: "driver-claude-code", url: "harness://driver/claude-code", ready: hasLabel("Claude token") },
    { name: "driver-anthropic-api", url: "harness://driver/anthropic-api", ready: hasLabel("Anthropic API key") },
    { name: "watcher-new", url: "harness://watcher" },
    { name: "watcher-edit", url: `harness://watcher?id=${encodeURIComponent(s.watcher.id)}` },
    { name: "project-settings", url: `harness://project/${s.project.id}` },
    // The git project's "When approved" default (Merge; no gh remote, so no Open PR).
    // The row sits near the end, so the scroll bottoms out before it reaches scrollTo's band.
    { name: "project-settings-when-approved", url: `harness://project/${s.project.id}`, seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l === "When approved", 3).catch(() => {}).then(() => Bun.sleep(500)) },
    // A git ticket in review: the Approve button's menu (merge, clean up, Approve and…, take no action), then
    // the "Approve and…" sheet for instructions. Both are closed again before the next screen.
    {
      name: "approve-menu",
      url: `harness://ticket/${k(s.agents)}`,
      ready: hasLabel(APPROVE_MORE),
      seconds: 6,
      prepare: (udid) => tapWhere(udid, APPROVE_MORE).then(() => approveMenuUp(udid)).then(() => Bun.sleep(500)),
      // The menu closes with a tap outside it.
      after: (udid) => dismissMenu(udid).then(() => Bun.sleep(400)),
    },
    {
      name: "approve-custom",
      url: `harness://ticket/${k(s.agents)}`,
      ready: hasLabel(APPROVE_MORE),
      seconds: 7,
      prepare: (udid) =>
        tapWhere(udid, APPROVE_MORE)
          .then(() => approveMenuUp(udid))
          .then(() => tapWhere(udid, "Approve and…"))
          .then(() => until("instructions sheet", async () => (await labels(udid)).some(instructionsField), 5000))
          .then(() => Bun.sleep(800)),
      after: (udid) => tapWhere(udid, "Cancel").then(() => Bun.sleep(600)),
    },
    // Settings → Prompts (seedPrompts): the list, a built-in prompt, the customized review message
    // and the broken Files section.
    { name: "settings-prompts", url: "harness://settings", seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l.startsWith("Prompts, ")).then(() => Bun.sleep(500)) },
    { name: "prompts", url: "harness://prompts", ready: hasLabel("Agent review") },
    { name: "prompt-builtin", url: "harness://prompt/system.work", ready: hasLabel("Customize") },
    { name: "prompt-customized", url: "harness://prompt/run.review", ready: hasLabel("Reset to built-in") },
    { name: "prompt-broken", url: "harness://prompt/system.files", ready: (l) => l.some((x) => x.includes("isn't in effect")) },
    // Scrolled to the Base branch fields (General in Settings, Agents in the git project's settings).
    { name: "settings-base-branch", url: "harness://settings", seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l === "Base branch").then(() => Bun.sleep(500)) },
    { name: "project-settings-base-branch", url: `harness://project/${s.project.id}`, seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l === "Base branch").then(() => Bun.sleep(500)) },
    { name: "connect", url: "harness://connect" },
    // The board lands on whichever column had work when it first loaded, mid-seed; show Blocked.
    { name: "board", url: BOARD, browse: true, prepare: (udid) => tapWhere(udid, (l) => l.startsWith("Blocked,")).then(() => Bun.sleep(700)) },
    // Planning with the seeded draft's dashed card (Draft badge, no run).
    {
      name: "board-draft",
      url: BOARD,
      seconds: 8,
      // Planning is the first column; its chip may sit off the strip's left edge, so page back to it.
      prepare: async (udid) => {
        const card = (l: string) => l.startsWith(`${s.draft.key} `) && l.endsWith(", draft");
        await until("draft card on screen", async () => {
          const el = await findElement(udid, card);
          if (el && el.frame.x >= 0 && el.frame.x < 100) return el;
          await axe("swipe", "--start-x", "40", "--start-y", "600", "--end-x", "380", "--end-y", "600", "--duration", "0.25", "--udid", udid);
          await Bun.sleep(500);
          return null;
        }, 12000, 0);
        await Bun.sleep(500);
      },
    },
    { name: "browser", url: `harness://ticket/${k(s.browse)}?tab=browser`, wait: 2000, browse: true, seconds: 6 },
    ...(ipad
      ? [
          // A tab torn off into a window of its own (its chip's menu → Open in New Window): the
          // ticket's window shows Return to this window in its place, and pressing it closes the
          // pinned window and shows the tab here again.
          {
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
              await Bun.sleep(800);
              await shot(udid, "ticket-tear-off-window");
              // Back to the ticket's own window (open: the link brings it forward on its Transcript).
              await simctl("openurl", udid, `harness://ticket/${k(s.hello)}?tab=transcript`);
              await until("the placeholder in the ticket's window", async () => (await labels(udid)).includes("Transcript is in another window"), 10000);
              await Bun.sleep(800);
            },
            after: async (udid: string) => {
              const key = s.hello.key;
              await tapWhere(udid, "Return to this window");
              const closed = await until("the pinned window closed and the tab back", async () => {
                const l = await labels(udid);
                return !l.includes(`${key} · Transcript`) && !l.includes("Transcript is in another window") && ticketShown(l, key);
              }, 10000).catch((e) => e as Error);
              await Bun.sleep(800);
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
    await Bun.sleep(800);
    // Scroll down to the Appearance pickers.
    await axe("swipe", "--start-x", "200", "--start-y", "780", "--end-x", "200", "--end-y", "260", "--duration", "1", "--udid", udid);
    await Bun.sleep(900);
    await shot(udid, `settings-${id}`);
    await goto(udid, BOARD, (l) => onBoard(l) && l.some((x) => /^[A-Z]+-\d+ /.test(x)));
    await Bun.sleep(600);
    await shot(udid, `board-${id}`);
  }
  // Back to the defaults for the light/dark pass.
  await goto(udid, "harness://settings?lightTheme=harness-light&darkTheme=harness-dark");
  await Bun.sleep(600);
}

/** The screens on one simulator, each in light and dark. Returns the names the app crashed on. */
async function shootScreens(udid: string, list: Screen[], browsed: Promise<unknown>): Promise<string[]> {
  const crashed: string[] = [];
  for (const s of list) {
    if (s.browse) await timed("waiting for the browse ticket", () => browsed.catch(() => {}));
    await timed(`screen: ${s.name}`, async () => {
      const shown = await timed(`  goto: ${s.name}`, () => goto(udid, s.url, s.ready));
      if (s.wait) await Bun.sleep(s.wait);
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

/**
 * The real-tap checks, as chains that each run on one simulator; `seconds` (about what the chain
 * takes on an idle Mac) balances them. Every check reaches its screen with goto.
 */
function interactionChains(s: Seeded): { seconds: number; run: (udid: string) => Promise<void> }[] {
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const chain = (seconds: number, run: (udid: string) => Promise<void>) => ({ seconds, run });
  return [
    // The iPhone's ticket sheet: pushes, the back swipe, docking, restoring and swiping it away.
    chain(40, (udid) => sheetChecks(udid, s)),
    // Several tickets docked: switching, closing one at a time, the overflow menu, a relaunch.
    chain(90, (udid) => dockStackChecks(udid, s)),
    chain(4, async (udid) => {
      await check("a spec with wide tables leaves the replies after it on screen", async () => {
        const last = (l: string) => l.startsWith("Run finished (review)");
        await goto(udid, `harness://ticket/${k(s.tables)}?tab=transcript`, (l) => l.some(last));
        const all = await nodes(udid);
        const H = all[0]!.frame.height;
        const composer = all.filter((n) => n.AXLabel?.startsWith("Message the agent") || n.AXLabel === "Send");
        const bottom = composer.length ? Math.min(...composer.map((n) => n.frame.y)) : H;
        // The transcript opens at the bottom, so the reviewer's last row sits just above the composer.
        const end = await until("the last row on screen", async () => ((n) => (n && n.frame.y >= 0 && n.frame.y + n.frame.height <= bottom + 1 ? n : null))(await findElement(udid, last)), 6000).catch(async () => {
          const n = await findElement(udid, last);
          throw new Error(n ? `"${n.AXLabel}" at y=${Math.round(n.frame.y)}, below the list's bottom (${Math.round(bottom)})` : "no Run finished row");
        });
        // A long cell keeps a readable width (up to MAX_COL) instead of a word or two per line.
        const cell = (await nodes(udid)).find((n) => n.AXLabel?.startsWith("Every shot is a"));
        if (cell && cell.frame.width < 150) throw new Error(`the long cell is ${Math.round(cell.frame.width)} pt wide`);
        return `last row at y=${Math.round(end.frame.y)} of ${Math.round(bottom)}${cell ? `; long cell ${Math.round(cell.frame.width)}×${Math.round(cell.frame.height)} pt` : ""}`;
      });
    }),
    chain(8, async (udid) => {
      await check("composer answers a blocked ticket", async () => {
        await goto(udid, `harness://ticket/${k(s.blocked)}`, (l) => l.some((x) => x.startsWith("Message the agent")));
        await tapWhere(udid, (l) => l.startsWith("Message the agent"));
        // A message to a blocked ticket is a chat; the dummy picks the work back up only when told to.
        await axe("type", "Use Happy Cog [dummy:unblock]", "--udid", udid);
        await tapWhere(udid, "Send");
        const t = await settle(s.blocked.key, (x) => x.status !== "blocked", 15000);
        // A sent message opens the Transcript, where it and the reply show (never in Activity): the
        // ticket opened on its Spec, so the transcript's run rows on screen mean the tab switched.
        await until("the Transcript", async () => (await labels(udid)).some((l) => l.startsWith("Run started (")) || null, 10000).catch(async (e: Error) => {
          await shot(udid, "composer-sent-transcript-failed");
          throw new Error(`${e.message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await shot(udid, "composer-sent-transcript");
        return `${t.key} → ${t.status}, Transcript shown`;
      });
      await check("Start work moves a planning ticket to In progress", async () => {
        await goto(udid, `harness://ticket/${k(s.plan)}`, (l) => l.includes("Start work"));
        await tapWhere(udid, "Start work");
        const t = await settle(s.plan.key, (x) => x.status !== "planning", 15000);
        return `${t.key} → ${t.status}`;
      });
    }),
    chain(20, async (udid) => {
      const card = (l: string) => l.startsWith(`${s.hello.key} `);
      // Before Approve below, which moves the ticket to Done.
      await check("a reply's list items show their text in the transcript", async () => {
        await goto(udid, `harness://ticket/${k(s.hello)}?tab=transcript`, (l) => l.includes(REPLY_ITEMS[0]!));
        // The review run's rows follow the reply: scroll back up until the reply is in view.
        const first = (l: string) => l === REPLY_ITEMS[0];
        for (let i = 0; i < 8 && ((await findElement(udid, first))?.frame.y ?? 0) < 380; i++) {
          await axe("swipe", "--start-x", "200", "--start-y", "420", "--end-x", "200", "--end-y", "620", "--duration", "0.3", "--udid", udid);
          await Bun.sleep(400);
        }
        const widths: string[] = [];
        for (const item of REPLY_ITEMS) {
          const el = await until(`list item "${item}"`, () => findElement(udid, (l) => l === item), 8000);
          // Collapsed, an item is 0pt wide with only its bullet showing.
          if (el.frame.width < 10) throw new Error(`"${item}" is ${el.frame.width}pt wide`);
          widths.push(`${Math.round(el.frame.width)}pt`);
        }
        await shot(udid, "reply-list-light");
        return widths.join(", ");
      });
      await check("tapping a board card opens its ticket in a sheet, and swiping it away returns to the board", async () => {
        await goto(udid, BOARD);
        await undock(udid);
        // The card is in the tree before its column scrolls in (x≈416, off the right edge).
        await until("card on screen", async () => {
          await tapWhere(udid, (l) => l.startsWith("Review,"));
          return ((await until("card", () => findElement(udid, card), 1500).catch(() => null))?.frame.x ?? 999) < 100;
        }, 15000);
        await tapWhere(udid, card);
        moved(udid);
        await until("ticket detail", async () => (await running(udid)) && (await labels(udid)).includes(APPROVE_MERGE), 8000).catch(async (e) => {
          throw new Error((await running(udid)) ? (e as Error).message : "the app crashed opening the ticket");
        });
        await shot(udid, "card-tap-detail-light");
        // Down to the dock, then off the screen.
        await dockSheet(udid);
        await undock(udid);
        await until("back on the board", async () => ((l) => l.some(card) && !l.includes(APPROVE_MERGE))(await labels(udid)), 8000);
        lastUrl.set(udid, BOARD);
        await shot(udid, "card-tap-back-light");
        return `${s.hello.key} → detail → board`;
      });
      await check("Approve and merge records the human review with merge and auto-completes the ticket", async () => {
        await goto(udid, `harness://ticket/${k(s.hello)}`, (l) => l.includes(APPROVE_MERGE));
        await tapWhere(udid, APPROVE_MERGE);
        const t = await settle(s.hello.key, (x) => x.humanReview === "approved" && x.status === "done", 15000);
        if (t.completionAction !== "merge") throw new Error(`completionAction ${t.completionAction}`);
        return `${t.key} human=${t.humanReview} action=${t.completionAction} → ${t.status}`;
      });
      // The same project as the ticket above, so it waits for that Approve (whose label follows the default).
      await check("Approve menu → Approve and… sends the instructions with a custom completion", async () => {
        const text = "Tag it v2 then clean up";
        await goto(udid, `harness://ticket/${k(s.agents)}`, (l) => l.includes(APPROVE_MORE));
        await tapWhere(udid, APPROVE_MORE);
        await approveMenuUp(udid);
        await tapWhere(udid, "Approve and…");
        await tapWhere(udid, instructionsField);
        await Bun.sleep(600);
        await axe("type", text, "--udid", udid);
        await Bun.sleep(300);
        await tapWhere(udid, "Approve");
        const t = await settle(s.agents.key, (x) => x.humanReview === "approved", 15000);
        if (t.completionAction !== "custom" || t.completionInstructions !== text) throw new Error(`stored ${t.completionAction} / ${JSON.stringify(t.completionInstructions)}`);
        return `${t.key} action=custom instructions=${JSON.stringify(t.completionInstructions)} → ${t.status}`;
      });
      await check("project settings: When approved saves the project's default", async () => {
        await goto(udid, `harness://project/${s.project.id}`, (l) => l.includes("When approved"));
        await scrollTo(udid, (l) => l === "When approved", 3).catch(() => {});
        await tapWhere(udid, (l) => l.startsWith("When approved, "));
        await tapWhere(udid, "Custom");
        const p = await until("default saved", async () => ((x) => (x?.completionAction === "custom" ? x : null))((await api<Project[]>("GET", "/projects")).find((x) => x.id === s.project.id)), 8000);
        await until("select shows Custom", async () => (await labels(udid)).includes("When approved, Custom"), 5000);
        await shot(udid, "when-approved-custom-light");
        await api("PATCH", `/projects/${s.project.id}`, { completionAction: "merge" });
        return `${p.key} completionAction=${p.completionAction}`;
      });
    }),
    chain(14, async (udid) => {
      const override = async (id: string) => (await api<PromptEntry[]>("GET", "/prompts")).find((p) => p.id === id)!.override;
      const field = (l: string) => l === "Work run instructions prompt";
      // The header's glass buttons aren't in AXe's tree: Cancel sits where Back does, Save at the trailing edge.
      const tapCancel = () => axe("tap", "-x", "32", "-y", "89", "--udid", udid);
      const tapSave = async () => axe("tap", "-x", String(Math.round((await tree(udid))[0]!.frame.width - 32)), "-y", "89", "--udid", udid);
      await check("prompt editor: Customize, a bad variable shows inline and can't save, Cancel keeps the built-in", async () => {
        await goto(udid, "harness://prompt/system.work", (l) => l.includes("Customize"));
        await tapWhere(udid, "Customize");
        await until("editor", async () => (await labels(udid)).includes("Compare with built-in"), 5000);
        await tapWhere(udid, field);
        await axe("type", " {{brnch}}", "--udid", udid);
        const error = await until("inline error", async () => (await labels(udid)).find((l) => l.startsWith("Unknown variable {{brnch}}")), 5000);
        await shot(udid, "prompt-invalid-light");
        await tapSave(); // disabled while invalid
        await Bun.sleep(800);
        if ((await override("system.work")) !== null) throw new Error("an invalid prompt was saved");
        await tapCancel();
        await until("read-only again", async () => (await labels(udid)).includes("Customize"), 5000);
        moved(udid);
        return error.slice(0, 60);
      });
      await check("prompt editor: Save stores the override, Reset to built-in (confirmed) clears it", async () => {
        await goto(udid, "harness://prompt/system.work", (l) => l.includes("Customize"));
        await tapWhere(udid, "Customize");
        await until("editor", async () => (await labels(udid)).includes("Compare with built-in"), 5000);
        await tapWhere(udid, field);
        await axe("type", " Mind the {{branch}}.", "--udid", udid);
        await Bun.sleep(300);
        await tapSave();
        const saved = await until("override saved", async () => ((v) => (v?.includes("Mind the {{branch}}.") ? v : null))(await override("system.work")), 8000);
        await until("Reset button", async () => (await labels(udid)).includes("Reset to built-in"), 5000);
        await shot(udid, "prompt-saved-light");
        // Typing left the editor scrolled to the end of the long work prompt, above the button.
        await scrollTo(udid, (l) => l === "Reset to built-in");
        await tapWhere(udid, "Reset to built-in");
        // The confirm alert: its buttons are in the AX tree before it takes taps (the
        // alert drops a tap that lands during its presentation), so let it settle first.
        await until("confirm alert", () => findElement(udid, (l) => l === "Reset"), 5000);
        await Bun.sleep(600);
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
        await Bun.sleep(400);
        await tapWhere(udid, (l) => l.startsWith("{{key}}"));
        await Bun.sleep(500);
        await axe("type", "Z", "--udid", udid);
        await Bun.sleep(300);
        await tapSave();
        const saved = await until("override saved", async () => ((v) => (v !== seeded ? v : null))(await override("run.review")), 8000);
        await api("PATCH", "/settings", { prompts: { "run.review": seeded } });
        moved(udid);
        if (!saved?.endsWith("then the diff.{{key}}Z")) throw new Error(`expected the text to end "then the diff.{{key}}Z", got ${JSON.stringify(saved)}`);
        return `ends ${JSON.stringify(saved.slice(-24))}`;
      });
    }),
    chain(8, async (udid) => {
      // branchPlan stays in Planning: s.quick is approved into Done by another chain meanwhile, which locks its picker.
      const openModels = async () => {
        await goto(udid, `harness://ticket/${k(s.branchPlan)}?tab=details`, (l) => l.some((x) => x.startsWith("Model, ")));
        await tapWhere(udid, (l) => l.startsWith("Model, "));
        await until("model sheet", async () => (await labels(udid)).includes("Search models"), 5000);
      };
      await check("ticket details: one Model picker sets the driver and model together, and Default clears them", async () => {
        await openModels();
        // Narrow the list first: the sheet is lazy, and a long driver list ahead of Dummy (Claude
        // Code's models) can leave its rows unrealized and out of AXe's tree.
        await tapWhere(udid, "Search models");
        await axe("type", "slow", "--udid", udid);
        await tapWhere(udid, (l) => l === "Dummy Slow" || l.endsWith(", Dummy Slow"));
        const picked = await settle(s.branchPlan.key, (x) => x.driver === "dummy" && x.model === "dummy-slow", 8000).catch(async (e) => {
          await shot(udid, "model-pick-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await openModels();
        await tapWhere(udid, (l) => l.startsWith("Default"));
        const cleared = await settle(s.branchPlan.key, (x) => x.driver === "dummy" && x.model === null, 8000);
        moved(udid);
        return `${picked.driver}/${picked.model} → ${cleared.driver}/${cleared.model ?? "default"}`;
      });
    }),
    chain(18, async (udid) => {
      await check("touch and hold on a card previews its ticket on the Spec tab, with no moves in the menu", async () => {
        await goto(udid, BOARD);
        await tapWhere(udid, (l) => l.startsWith("Review,"));
        await until("card on screen", async () => ((await findElement(udid, (l) => l.startsWith(`${s.browse.key} `)))?.frame.x ?? 999) < 100, 3000).catch(() => {});
        await tapWhere(udid, (l) => l.startsWith(`${s.browse.key} `), { longPress: 1.2 });
        const l = await until("the menu", async () => ((x) => (x.includes("Copy key") ? x : null))(await labels(udid)), 5000).catch(async (e) => {
          await shot(udid, "board-card-preview-failed");
          throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 30).join(" | ")}`);
        });
        await Bun.sleep(800);
        await shot(udid, "board-card-preview-light");
        const moves = l.filter((x) => x.startsWith("Move to"));
        if (moves.length) throw new Error(`the menu still moves cards: ${moves.join(", ")}`);
        // AXe sees the lifted preview as one "Preview" element, not the ticket screen inside it (the
        // screenshot shows that); a plain menu has none. A crash in the preview drops to SpringBoard,
        // whose Preview app has the label too, but no Copy key.
        if (!l.includes("Preview")) throw new Error(`no preview over the menu; on screen: ${l.slice(0, 30).join(" | ")}`);
        await tapWhere(udid, "Copy key");
        await until("the menu gone", async () => !(await labels(udid)).includes("Copy key"), 5000);
        return `${s.browse.key}: Spec preview, no moves`;
      });
      await check("Approve menu → Approve and take no action marks a review ticket done without a run", async () => {
        await goto(udid, `harness://ticket/${k(s.quick)}`, (l) => l.includes(APPROVE_MORE));
        await tapWhere(udid, APPROVE_MORE);
        // Wait for the sheet to settle: a row tapped while it slides in can miss.
        await approveMenuUp(udid);
        await tapWhere(udid, "Approve and take no action");
        const t = await settle(s.quick.key, (x) => x.status === "done", 15000);
        if (t.humanReview !== "approved") throw new Error(`human review ${t.humanReview}`);
        return `${t.key} human=${t.humanReview} → ${t.status}`;
      });
      await check("approving lands the ticket by itself, and the ticket screen has no Complete", async () => {
        await api("POST", `/tickets/${s.waiting.key}/review`, { decision: "approve" });
        const t = await settle(s.waiting.key, (x) => x.status === "done", 15000);
        const { runs } = await api<TicketDetail>("GET", `/tickets/${s.waiting.key}`);
        if (!runs.some((r) => r.kind === "complete" && r.status === "succeeded")) throw new Error("no completion run landed it");
        await goto(udid, `harness://ticket/${k(s.waiting)}`, (l) => l.includes("Re-open"));
        // A Complete button ("Complete", "Complete and …"), not the completion run's "Completed." note.
        const stray = (await labels(udid)).filter((l) => l === "Complete" || l.startsWith("Complete ") || l === "More ways to complete");
        if (stray.length) throw new Error(`still offers ${stray.join(", ")}`);
        return `${t.key} → ${t.status} after one approval`;
      });
      await check("approval card: Allow once resumes the agent", async () => {
        await goto(udid, `harness://ticket/${k(s.approval)}`, (l) => l.includes("Allow once"));
        await tapWhere(udid, "Allow once");
        const t = await settle(s.approval.key, (x) => !x.pendingApproval, 15000);
        return `${t.key} → ${t.status}`;
      });
    }),
    chain(6, async (udid) => {
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
        await Bun.sleep(1200);
        await shot(udid, "file-link-tap-light");
        // Its folder is the ticket's worktree (main's commit): the file is there, clean, and it has no Diff tab.
        if (l.includes("Modified") || l.some((x) => x.startsWith("Diff"))) throw new Error("a clean file shows as modified");
        if (!l.some((x) => x.startsWith(`export function greetingFor`))) throw new Error("the linked lines aren't on screen");
        return `${GREETINGS_PATH}, ${range}`;
      });
    }),
  ];
}

async function walk(udids: string[], s: Seeded): Promise<boolean> {
  let ok = true;
  if (themeShots.length) await timed("themes", () => themeScreens(udids[0]!));
  if (!flag("interactions-only")) {
    const list = screens(s).filter((x) => !only || only.includes(x.name));
    // Longest first deals the most evenly; the screens that wait on the browse ticket then go last.
    const cost = (x: Screen) => x.seconds ?? 4;
    const dealt = lanes([...list].sort((a, b) => cost(b) - cost(a)), udids.length, cost).map((lane) => [...lane.filter((x) => !x.browse), ...lane.filter((x) => x.browse)]);
    const crashed = (await timed("screens", () => Promise.all(udids.map((u, i) => shootScreens(u, dealt[i]!, s.browsed))))).flat();
    if (crashed.length) ok = false;
  }
  // The checks change tickets the screens show, so they start once every screen is saved.
  if (hasAxe && !only && !ipad) {
    await s.browsed.catch(() => {}); // the card preview check holds its card in Review
    const chains = interactionChains(s).sort((a, b) => b.seconds - a.seconds); // longest first deals best
    const byDevice = lanes(chains, udids.length, (c) => c.seconds);
    await Promise.all(udids.map((u) => appearance(u, "light"))); // their shots are named -light
    await timed("interactions", () => Promise.all(udids.map(async (u, i) => { for (const c of byDevice[i]!) await c.run(u); })));
    await goto(udids[0]!, BOARD);
    await appearance(udids[0]!, "light");
    await shot(udids[0]!, "after-interactions-light");
  }
  // The iPad's side panel, by real taps at the iPad's own coordinates.
  if (hasAxe && !only && ipad) {
    await appearance(udids[0]!, "light");
    await timed("panel", () => panelChecks(udids[0]!, s));
    await timed("cards", () => cardStackChecks(udids[0]!, s));
  }
  return ok;
}

// ---------------------------------------------------------------- build
async function buildApp() {
  if (flag("no-build") && existsSync(appPath)) return;
  // XcodeGen, then the Release simulator build into ios/build/dd (its log in ios/build/sim.log).
  console.log("building the app, Release (simulator)…");
  await sh(["bun", join(here, "Tools", "build.ts"), "sim"], { cwd: repoRoot });
}

// ---------------------------------------------------------------- main
let failed = false;
try {
  mkdirSync(shots, { recursive: true });
  await timed("daemon healthy", () => until("daemon healthy", async () => (await fetch(`${base}/health`)).ok, 20000, 50));
  token = readFileSync(join(home, "token"), "utf8").trim();
  // The simulators boot, the app builds and the daemon seeds all at once.
  // The app installs as soon as it's built and its simulator is up.
  const pairUrl = buildPairUrl(base, token);
  const pairAll = (udids: string[]) => timed("pair", () => Promise.all(udids.map((u) => pair(u, pairUrl))));
  const devices = Promise.all([timed("simulators", () => pickDevices(shardCount)), timed("build", buildApp)]).then(([udids]) =>
    timed("install", () => Promise.all(udids.map(install))).then(() => udids),
  );
  // The walk-through pairs as soon as its tickets exist, while their runs settle; the modes once seeded.
  const paired = walkThrough ? devices.then((udids) => ticketsUp.then(() => pairAll(udids)).then(() => udids)) : devices;
  const [udids, seeded, paged, sticky, typing, mentioned, media, drafting, sheeted] = await Promise.all([
    paired,
    walkThrough ? timed("seed", seed) : null,
    pagingOnly ? timed("seed paging", seedPaging) : null,
    stickOnly ? timed("seed stick", seedStick) : null,
    keyboardOnly ? timed("seed keyboard", () => seedTicket("KEYS", "Warm up").then(async (s) => (await seedPrompts(), s))) : null,
    mentionsOnly ? timed("seed mentions", seedMentions) : null,
    attachmentsOnly ? timed("seed attachments", seedAttachments) : null,
    draftsOnly ? timed("seed drafts", () => seedTicket("DRFT", "Warm up")) : null,
    sheetsOnly ? timed("seed sheets", seedSheets) : null,
  ]);
  if (seeded) console.log(`simulators ${udids.join(", ")}; seeded ${[seeded.hello, seeded.changes, seeded.conductor, seeded.browse, seeded.approval, seeded.blocked, seeded.plan].map((t) => t.key).join(", ")}`);
  if (paged) console.log(`simulator ${udids[0]}; seeded ${paged.history.length + 4} done tickets in ${paged.project.key}, needle ${paged.needle.key}, conductor ${paged.conductor.key}`);

  if (!walkThrough) await pairAll(udids);

  const udid = udids[0]!;
  if (paged) await timed("mode: paging", () => pagingChecks(udid, paged));
  if (sticky) await timed("mode: stick", () => stickChecks(udid, sticky));
  if (typing) await timed("mode: keyboard", () => keyboardChecks(udid, typing));
  if (mentioned) await timed("mode: mentions", () => mentionChecks(udid, mentioned));
  if (media) await timed("mode: attachments", () => attachmentChecks(udid, media));
  if (drafting) await timed("mode: drafts", () => draftChecks(udid, drafting));
  if (sheeted)
    await timed("mode: sheets", async () => {
      if (ipad) {
        await panelChecks(udid, sheeted);
        await cardStackChecks(udid, sheeted);
      } else {
        await sheetChecks(udid, sheeted, "Planning");
        await dockStackChecks(udid, sheeted);
      }
    });
  if (seeded && !(await walk(udids, seeded))) failed = true;
  if (results.some((r) => !r[1])) failed = true;
  // Back to light, and quit the app: once the daemon is gone it would spin reconnecting.
  await Promise.all(udids.map((u) => Promise.all([appearance(u, "light"), flag("keep") ? null : simctl("terminate", u, BUNDLE).catch(() => {})])));
} catch (e) {
  failed = true;
  console.error("sim-check failed:", (e as Error).message);
  console.error(readFileSync(join(home, "daemon.err"), "utf8").slice(-2000));
} finally {
  if (flag("keep")) {
    markKept(home);
    console.log(`--keep: daemon still running at ${base} (pid ${daemon.pid}); token in ${home}/token`);
  } else {
    await timed("daemon shutdown", async () => {
      // The daemon closes its Chrome on SIGTERM, which can take a while; a Chrome killed mid-close
      // leaks its code-sign clone, and one left running outlives this run (and its deleted home).
      daemon.kill("SIGTERM");
      if ((await Promise.race([daemon.exited.then(() => true), Bun.sleep(20000).then(() => false)])) === false) {
        console.log("the daemon didn't stop in 20 s; killing it and its Chrome");
        daemon.kill("SIGKILL");
        Bun.spawnSync(["pkill", "-f", `user-data-dir=${join(home, "chrome-profile")}`]);
      }
    });
    removeTemp();
    await timed("simulator shutdown", shutDownDevices);
  }
  reportTimings();
  console.log(failed ? "sim-check finished with failures" : "sim-check done");
}
process.exit(failed ? 1 : 0);
