// Simulator walk-through against a REAL daemon on a throwaway HARNESS_HOME:
//   1. boots service/src/daemon.ts (temp home, random port, dummy driver, HARNESS_DUMMY_DELAY_MS=1)
//   2. seeds a project with a hello-world ticket, a conductor with children, a /browse ticket,
//      an approval, a blocked question, a plan-first ticket, a git-worktree ticket with changes and
//      a draft (a New session saved before launch),
//      while it builds the Release app for the simulator (skip with --no-build)
//   3. on --shards simulators at once (default 3, named "sim-check 1", "sim-check 2", … and created
//      on first use), installs the app and pairs it via `simctl openurl harness://pair?…`
//   4. splits the screens between the simulators: each deep-links the running app to its screens
//      and saves each one in light and in dark (flipping `simctl ui appearance` in place) to
//      mobile/build/screens/, then the real-tap checks, also split between them
//
//   Only what needs a simulator lives here (native scrolling, the keyboard, gestures, media, crashes,
//   the screenshots); the logic behind each check is in bun test (lib/boardColumns, lib/mentionCaret,
//   lib/stickToBottom, shared/state paging and details, the service's http tests).
//
//   --themes=catppuccin-mocha,rose-pine-dawn: per theme, applies it with the settings deep link
//      (harness://settings?darkTheme=…) and saves board-<id>.png + settings-<id>.png
//
//   The modes below replace the default walk-through and use one simulator:
//
//   --paging: seeds 125+ done tickets (one old "haystack" ticket deep in the history) and a conductor
//      with done children; checks child tickets are hidden by default (and the header menu shows
//      them), the Done column scrolls into older pages, and the Search tab finds the unloaded done
//      ticket; paging-*.png
//
//   --stick: a ticket with a long brief and a long transcript; swipes the Transcript tab and checks it
//      follows new content at the bottom, stays put once scrolled up, and follows again after
//      scrolling back down; the Summaries tab opens at the bottom and follows
//
//   --keyboard: with the on-screen keyboard up, the ticket composer sits right on top of it, the
//      prompt editor keeps its cursor above it as the text grows, and the
//      New session sheet scrolls to its last button above it. Needs the simulator's software
//      keyboard (I/O → Keyboard → uncheck Connect Hardware Keyboard); keyboard-*.png
//
//   --mentions: in New session and the ticket composer, typing `@…` lists the project's files,
//      tapping one completes it, and the run the prompt starts gets the file attached ("Attached @…"
//      in the transcript); mentions-*.png
//
//   --attachments (needs ffmpeg): a summary with a tall and a wide PNG, an H.264 clip and a PNG that
//      won't decode; checks every thumbnail shows, a tap opens the viewer on that attachment, swiping
//      pages, Close and swipe-down close it; attachments-*.png
//
//   Every run prints its slowest steps and writes them all to mobile/build/screens/timings.json.
//
//   DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer bun scripts/sim-check.ts [--no-build] [--app=path] [--shards=N] [--udid=…,…] [--keep] [--only=name,name] [--interactions-only] [--themes=id,id] [--paging] [--stick] [--keyboard] [--mentions] [--attachments]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPairUrl, reviewPassed, type Project, type PromptEntry, type Ticket, type TicketDetail, type TicketPage, type TranscriptEntry, type Watcher } from "@harness/shared";
import { findTheme } from "@harness/shared/themes";
import { Database } from "bun:sqlite";

const here = resolve(import.meta.dir, "..");
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer";
const env = { ...process.env, DEVELOPER_DIR };
const shots = join(here, "build", "screens");
const appPath = process.argv.find((a) => a.startsWith("--app="))?.slice(6) ?? join(here, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const only = opt("only")?.split(",");
const themeShots = opt("themes")?.split(",").filter(Boolean) ?? [];
const pagingOnly = flag("paging");
const stickOnly = flag("stick");
const keyboardOnly = flag("keyboard");
const mentionsOnly = flag("mentions");
const attachmentsOnly = flag("attachments");
const walkThrough = !(pagingOnly || stickOnly || keyboardOnly || mentionsOnly || attachmentsOnly);
const shardCount = walkThrough ? Math.max(1, Number(opt("shards") ?? 3) || 1) : 1;
for (const id of themeShots) if (!findTheme(id)) throw new Error(`--themes: unknown theme ${id}`);

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
// inside mobile/, bun test walks its thousands of links and runs out of file descriptors.
function xcodeShim(): string {
  rmSync(join(here, "build", "xcode-shim"), { recursive: true, force: true }); // where it used to live
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
async function axe(...a: string[]) {
  if (!hasAxe) return "";
  shim ||= xcodeShim();
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
 * Scrolls the screen's scroll view with slow swipes (no fling) until an element `match` accepts
 * sits in the upper middle of the screen. Elements scrolled far out of view may be missing from
 * the tree, so it swipes a fixed distance until one shows up, then just far enough.
 */
async function scrollTo(udid: string, match: (label: string) => boolean, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const el = await findElement(udid, match);
    if (el && el.frame.y >= 140 && el.frame.y <= 520) return;
    const by = el && el.frame.y > 520 ? Math.min(420, Math.round(el.frame.y - 300)) : 380;
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
 * The simulators to drive: --udid=a,b, or "sim-check 1" … "sim-check N", created (iPhone 18 Pro on
 * the newest iOS runtime) and booted as needed. They're sim-check's own, so a run never takes over
 * a simulator someone (or another agent) is using.
 */
async function pickDevices(n: number): Promise<string[]> {
  const given = opt("udid")?.split(",").filter(Boolean);
  type Device = { udid: string; name: string; state: string; isAvailable: boolean };
  const list = JSON.parse(await simctl("list", "devices", "--json")) as { devices: Record<string, Device[]> };
  const all = Object.values(list.devices).flat();
  const wanted = given ?? Array.from({ length: n }, (_, i) => `sim-check ${i + 1}`);
  return Promise.all(
    wanted.map(async (id) => {
      let d = all.find((x) => x.isAvailable && (x.udid === id || x.name === id));
      if (!d && given) throw new Error(`--udid: no simulator ${id}`);
      if (!d) d = { udid: await createDevice(id), name: id, state: "Shutdown", isAvailable: true };
      if (d.state !== "Booted") {
        await simctl("boot", d.udid);
        await sh(["xcrun", "simctl", "bootstatus", d.udid, "-b"]);
      }
      return d.udid;
    }),
  );
}
async function createDevice(name: string): Promise<string> {
  type Runtime = { identifier: string; version: string; platform?: string; isAvailable: boolean; supportedDeviceTypes?: { identifier: string; name: string }[] };
  const runtimes = (JSON.parse(await simctl("list", "runtimes", "--json")) as { runtimes: Runtime[] }).runtimes
    .filter((r) => r.isAvailable && (r.platform ?? r.identifier).includes("iOS"))
    .sort((a, b) => Bun.semver.order(b.version, a.version));
  // The newest runtime that runs an iPhone 18 Pro (the taps' coordinates are its), else any iPhone.
  const pick = (want: (n: string) => boolean) => runtimes.map((r) => ({ r, type: r.supportedDeviceTypes?.find((t) => want(t.name)) })).find((x) => x.type);
  const found = pick((n) => n === "iPhone 18 Pro") ?? pick((n) => /^iPhone/.test(n));
  if (!found) throw new Error("no iOS runtime with an iPhone simulator available");
  console.log(`creating simulator "${name}" (${found.type!.name}, iOS ${found.r.version})`);
  return simctl("create", name, found.type!.identifier, found.r.identifier);
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
const shot = (udid: string, name: string) => simctl("io", udid, "screenshot", join(shots, `${name}.png`));
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
  await sh(["xcrun", "simctl", "keychain", udid, "reset"], { allowFail: true });
  await simctl("install", udid, appPath);
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
const daemon = Bun.spawn(["bun", join(repoRoot, "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DELAY_MS: "1" },
  stdout: Bun.file(join(home, "daemon.out")),
  stderr: Bun.file(join(home, "daemon.err")),
});

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
 * A brief like HARNESS-66's: two wide tables whose cells run to a few hundred characters, and a
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
  "| `--stick` | several minutes | 5 seed messages and 6 `sayStick` calls, each waiting for a full dummy run and a reviewer run at 40 ms per word. Fixed sleeps of 1.5–3 s. Transcript and Summaries test the same hook twice. |",
  "",
  "Measure with:",
  "```",
  "time bun scripts/sim-check.ts --no-build --shards=2",
  "```",
].join("\n");

/**
 * Settings → Prompts: a working override of the review message, and a broken one of the Files
 * section. The API refuses a template naming a variable the prompt doesn't have, so the broken one
 * goes straight into the settings table, the way an app update that renamed {{shell}} would leave
 * it. The service reads settings from the database on every request, so it shows up at once.
 */
async function seedPrompts() {
  await api("PATCH", "/settings", {
    prompts: { "run.review": "Review {{ticket}} carefully.\n\n## Brief\n{{brief}}\n\n{{#if summaries}}## Summaries\n{{summaries}}{{/if}}\n\nCheck the tests first, then the diff." },
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
  const create = (projectId: string, prompt: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId, prompt, driver: "dummy", start: true, ...extra });

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
  // Another one, approved by the human while the project doesn't complete on its own: waiting on Complete.
  const waiting = await create(other.id, "Which browsers does the install page support?", { skipAgentReview: true });
  // A New session saved as a draft: a dashed card in Planning that reopens in the editor, never run.
  const draft = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: "Greet in French when the locale says so", draft: true, skipAgentReview: true });
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
    settle(hello.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview))
      .then(() => api("POST", `/tickets/${hello.key}/messages`, { text: REPLY_ITEMS.map((i) => `- ${i}`).join("\n") }))
      .then(() => settle(hello.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview))),
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
  const nestedAgent = (await api<TicketDetail>("GET", `/tickets/${agents.key}`)).subagents!.find((s) => s.parentId)!;
  const [, watcher] = await watchers;
  return { project, other, hello, changes, conductor, browse, browsed, approval, configApproval, blocked, plan, branchPlan, quick, waiting, draft, watcher, agents, nestedAgent, tables };
}

/** --paging: a long Done history on its own project and a conductor with done children. */
async function seedPaging() {
  mkdirSync(join(scratch, "archive"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "archive"), name: "archive", key: "ARCH", defaultDriver: "dummy" });
  const create = (prompt: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, prompt, driver: "dummy", start: false, ...extra });
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
    await axe("tap", "-x", "308", "-y", "84", "--udid", udid); // Board options (…), in the header
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
  await check("Show child tickets (header menu) shows them; toggling back hides them", async () => {
    await boardMenu();
    await until("children visible", () => has(`${p.kids[2]!.key} `), 6000);
    await boardMenu();
    await until("children hidden", async () => !(await has(`${p.kids[2]!.key} `)), 6000);
    return true;
  });
  await check("the Done column scrolls into older pages", async () => {
    // Reading the tree (every loaded card) costs more than a swipe, so look after every few.
    for (let i = 0; i < 45; i += 3) {
      if (await has(`${deep.key} `)) return `${deep.key} after ${i} swipes`;
      for (let j = 0; j < 3; j++) await swipeUp();
      await Bun.sleep(300);
    }
    throw new Error(`${deep.key} never appeared`);
  });
  await shootBoth(udid, "paging-done-scrolled");
  await check("search finds a done ticket that isn't loaded", async () => {
    // Search is its own tab, linked like the others. AXe doesn't descend into the header holding
    // the native field, so tap where it sits.
    await goto(udid, "harness://search");
    await Bun.sleep(500);
    await axe("tap", "-x", "200", "-y", "139", "--udid", udid);
    await Bun.sleep(500);
    await axe("type", "haystack", "--udid", udid);
    await until(`${p.needle.key} in the results`, () => has(`${p.needle.key} `), 10000);
    return p.needle.key;
  });
  moved(udid);
  await Bun.sleep(400); // the result list's cards finish drawing
  await shootBoth(udid, "paging-search");
}

/** --stick: one ticket whose brief and transcript are both taller than the screen. */
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ";
const stickText = (n: number, repeat = 3) => `Stick ${n}: ${LOREM.repeat(repeat)}`;
async function sayStick(key: string, n: number) {
  await api("POST", `/tickets/${key}/messages`, { text: stickText(n) });
  return settle(key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview));
}
/** A project with a few files and one ticket in review (brief `prompt`), for --stick, --keyboard and --mentions. */
async function seedTicket(key: string, prompt: string, files: Record<string, string> = {}) {
  await settings();
  const dir = join(scratch, key.toLowerCase());
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const project = await api<Project>("POST", "/projects", { path: dir, name: key.toLowerCase(), key, defaultDriver: "dummy" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt, driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy && reviewPassed(t.agentReview));
  return { project, ticket };
}
async function seedStick() {
  const s = await seedTicket("STICK", stickText(0, 14));
  for (let n = 1; n <= 3; n++) await sayStick(s.ticket.key, n);
  return s;
}

/** --stick: real swipes on the Transcript and Summaries tabs. */
async function stickChecks(udid: string, p: Awaited<ReturnType<typeof seedStick>>) {
  const key = p.ticket.key;
  const H = (await tree(udid))[0]!.frame.height;
  // The list's viewport: below the tab strip, above the composer and the switch over it ("Move to
  // in progress", moveSwitchLabel in shared/state/chatMode).
  async function listView() {
    const all = await nodes(udid);
    const tab = all.find((n) => n.AXLabel === "Transcript" || n.AXLabel?.startsWith("Summaries"));
    const composer = all.filter((n) => n.AXLabel?.startsWith("Message the agent") || n.AXLabel === "Send" || n.AXLabel === "Move to in progress" || n.AXLabel === "Revise the plan");
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
  /** New content lands (another message and its runs) and the list has laid it out. */
  const say = async (n: number, last: (l: string) => boolean) => {
    await sayStick(key, n);
    await until(`message ${n} on screen`, async () => (await labels(udid)).some((l) => l.includes(`Stick ${n}:`)) && (await labels(udid)).some(last), 8000).catch(() => {});
    await Bun.sleep(500);
  };

  let n = 3;
  // Every message ends with the reviewer's run: its last transcript row and its last summary.
  // Transcript (a FlatList with estimated rows, where UIKit moves the offset by itself) gets every
  // check; Summaries uses the same hook, whose gating is unit-tested, so it gets the first two.
  const tabs: [string, (l: string) => boolean, boolean][] = [
    ["transcript", (l) => l.startsWith("Run finished (review)"), true],
    ["summaries", (l) => l.startsWith("Review approved"), false],
  ];
  for (const [tab, last, all] of tabs) {
    await check(`${tab} opens at the bottom`, async () => {
      await goto(udid, `harness://ticket/${encodeURIComponent(key)}?tab=${tab}`);
      return until("at the bottom", () => atBottom(last), 10000);
    });
    await check(`${tab} follows new content while at the bottom`, async () => {
      await say(++n, last);
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
  await shot(udid, "stick-summaries");
}

/** --keyboard: the composer and a sheet's last control stay above the on-screen keyboard. */
async function keyboardChecks(udid: string, p: Awaited<ReturnType<typeof seedTicket>>) {
  // The keyboard's top edge: the highest key row. Keys are the only single-letter labels on screen.
  const keyboardTop = async () => {
    const keys = (await nodes(udid)).filter((n) => /^[a-zA-Z]$/.test(n.AXLabel ?? "") || n.AXLabel === "space");
    return keys.length >= 10 ? Math.min(...keys.map((k) => k.frame.y)) - 8 : null;
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

  await check("New session scrolls to its last button above the keyboard", async () => {
    await goto(udid, "harness://new");
    const top = await until("keyboard up", keyboardTop, 8000);
    await Bun.sleep(600);
    for (let i = 0; i < 3; i++) {
      await axe("swipe", "--start-x", "200", "--start-y", String(Math.round(top - 30)), "--end-x", "200", "--end-y", "160", "--duration", "0.3", "--udid", udid);
      await Bun.sleep(500);
    }
    await Bun.sleep(600);
    await shot(udid, "keyboard-new-session");
    // Plan first sits under Start session: the last thing on the sheet.
    const all = await nodes(udid);
    const button = all.find((n) => n.AXLabel === "Plan first") ?? all.find((n) => n.AXLabel === "Start session");
    if (!button) throw new Error("no Start session / Plan first button");
    const gap = Math.round(top - bottomOf(button));
    if (gap < 0) throw new Error(`the last button ends ${-gap}pt behind the keyboard (button ends at ${Math.round(bottomOf(button))}, keyboard at ${Math.round(top)})`);
    return `"${button.AXLabel}" ends ${gap}pt above the keyboard`;
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
    for (let i = 0; i < 16; i++) await axe("key", "40", "--udid", udid); // return
    await axe("type", "End of the prompt.", "--udid", udid);
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
}

/** --mentions: a project with a few files, and a ticket in review to message. */
const seedMentions = () =>
  seedTicket("MENT", "Warm up", {
    "README.md": "# Mentions\n\nThe readme the agent gets without reading it.\n",
    "src/app.ts": "export const app = 1;\n",
    "src/lib/format.ts": "export const format = 2;\n",
  });

/** --mentions: real typing and taps in New session and the composer. */
async function mentionChecks(udid: string, p: Awaited<ReturnType<typeof seedMentions>>) {
  const has = async (label: string) => (await labels(udid)).includes(label);
  const texts = async (key: string) => {
    const d = await api<TicketDetail>("GET", `/tickets/${key}`);
    return (await api<TranscriptEntry[]>("GET", `/sessions/${d.ticket.sessionId}/transcript`)).map((e) => ("text" in e.content ? e.content.text : ""));
  };

  // (Picking a folder keeps the list open inside it: insertMention and mentionCaret's unit tests.)
  await check("New session: @READ lists README.md, a tap completes it, the run gets the file", async () => {
    await goto(udid, `harness://new?projectId=${encodeURIComponent(p.project.id)}`, (l) => l.some((x) => x.startsWith("Prompt")));
    await tapWhere(udid, (l) => l.startsWith("Prompt"));
    await axe("type", "Summarize @READ", "--udid", udid);
    await until("README.md suggested", () => has("README.md"), 8000);
    await Bun.sleep(300);
    await shootBoth(udid, "mentions-new-session");
    await tapWhere(udid, "README.md");
    await until("list closed", async () => !(await has("README.md")), 4000);
    await tapWhere(udid, "Start session");
    moved(udid);
    // The draft is saved while it's typed; wait for it to launch.
    const t = await until("ticket launched", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => x.key !== p.ticket.key && !x.draft), 10000);
    if (t.description !== "Summarize @README.md") throw new Error(`brief is ${JSON.stringify(t.description)}`);
    await until("Attached status", async () => (await texts(t.key)).includes("Attached @README.md"), 15000);
    return `${t.key}: ${t.description}`;
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
}

/** --attachments: a ticket whose summary carries real images, a video and one file that won't decode. */
async function seedAttachments() {
  await settings();
  const dir = join(scratch, "media");
  mkdirSync(join(dir, "shots"), { recursive: true });
  const ff = (...a: string[]) => sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a], { cwd: dir });
  // A tall phone screenshot, a wide one, a short H.264 clip, and a PNG that's only its header.
  await Promise.all([
    ff("-f", "lavfi", "-i", "testsrc2=size=1179x2556:rate=1", "-frames:v", "1", "shots/phone.png"),
    ff("-f", "lavfi", "-i", "smptehdbars=size=1600x900:rate=1", "-frames:v", "1", "shots/wide.png"),
    ff("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", "shots/flow.mp4"),
  ]);
  writeFileSync(join(dir, "shots/broken.png"), Buffer.concat([readFileSync(join(dir, "shots/wide.png")).subarray(0, 64)]));
  const project = await api<Project>("POST", "/projects", { path: dir, name: "media", key: "MEDIA", defaultDriver: "dummy" });
  const files = ["phone.png", "wide.png", "flow.mp4", "broken.png"].map((f) => join(dir, "shots", f));
  const call = { name: "post_summary", input: { summary: "Here's the new greeting screen, before and after, plus a recording of the flow.", attachments: files } };
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: `Show the greeting screen\n/tools ${JSON.stringify([call])}`, driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy);
  const summaries = await api<{ attachments: unknown[] }[]>("GET", `/tickets/${encodeURIComponent(ticket.key)}/summaries`);
  if (!summaries.some((s) => s.attachments.length === files.length)) throw new Error(`no summary with ${files.length} attachments`);
  return { project, ticket };
}

/** --attachments: thumbnails in the Summaries tab, then the viewer (open, page, close, swipe down), in one visit. */
async function attachmentChecks(udid: string, p: Awaited<ReturnType<typeof seedAttachments>>) {
  const has = async (pred: (l: string) => boolean) => (await labels(udid)).some(pred);
  const counter = (n: number) => (l: string) => l.startsWith(`${n} of 4`);
  const viewerOpen = () => has((l) => / of 4/.test(l));
  const closed = () => until("viewer closed", async () => !(await viewerOpen()), 5000);
  const swipeLeft = () => axe("swipe", "--start-x", "340", "--start-y", "450", "--end-x", "40", "--end-y", "450", "--duration", "0.3", "--udid", udid);
  const swipeDown = () => axe("swipe", "--start-x", "200", "--start-y", "330", "--end-x", "205", "--end-y", "760", "--duration", "0.25", "--udid", udid);
  /** Opens the viewer from a thumbnail; its fade-in swallows gestures for a moment. */
  const open = async (label: string, n: number) => {
    if (await viewerOpen()) await tapWhere(udid, "Close").then(closed);
    await tapWhere(udid, label);
    await until(`viewer on ${n} of 4`, () => has(counter(n)), 5000);
    await Bun.sleep(800);
  };

  await goto(udid, `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=summaries`, (l) => l.includes("Image phone.png"));
  await Bun.sleep(1200); // let the images and the video's first frame load
  await check("every attachment has a thumbnail", async () => {
    const want = ["Image phone.png", "Image wide.png", "Video flow.mp4", "Image broken.png"];
    const l = await labels(udid);
    const missing = want.filter((w) => !l.includes(w));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    return want.join(", ");
  });
  await shootBoth(udid, "attachments-thumbnails");
  await check("tapping a thumbnail opens the viewer on it; swiping pages; Close closes", async () => {
    await open("Image wide.png", 2);
    // The viewer is black in both themes. The video and the broken file sit past the screen edge in
    // the row, so page to them here.
    await shootBoth(udid, "attachments-viewer-image");
    await appearance(udid, "light");
    await swipeLeft();
    await until("paged to 3 of 4", () => has(counter(3)), 5000);
    await Bun.sleep(1500); // the video's first frames
    await shot(udid, "attachments-viewer-video-light");
    await swipeLeft();
    await until("paged to 4 of 4", () => has(counter(4)), 5000);
    await Bun.sleep(800);
    await shot(udid, "attachments-viewer-failed-light");
    await tapWhere(udid, "Close");
    await closed();
    return "2 of 4 → 3 of 4 → 4 of 4 → closed";
  });
  await check("swiping down closes the viewer", async () => {
    await open("Image phone.png", 1);
    await swipeDown();
    await closed();
    return "closed";
  });
  await check("the video page plays and swiping down closes it too", async () => {
    await open("Image wide.png", 2);
    await swipeLeft();
    await until("on the video", () => has(counter(3)), 5000);
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
function screens(s: Seeded): Screen[] {
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const hasLabel = (x: string) => (l: string[]) => l.includes(x);
  const pluginLoaded = (l: string[]) => l.includes("Changes") && !l.includes("In progress");
  return [
    { name: "projects", url: "harness://projects" },
    { name: "ticket-summaries", url: `harness://ticket/${k(s.hello)}?tab=summaries` },
    { name: "ticket-transcript", url: `harness://ticket/${k(s.hello)}?tab=transcript` },
    { name: "ticket-details", url: `harness://ticket/${k(s.hello)}?tab=details` },
    { name: "ticket-transcript-tables", url: `harness://ticket/${k(s.tables)}?tab=transcript`, ready: (l) => l.some((x) => x.startsWith("Run finished (review)")) },
    { name: "conductor-tickets", url: `harness://ticket/${k(s.conductor)}?tab=children` },
    { name: "ticket-agents", url: `harness://ticket/${k(s.agents)}?tab=agents` },
    { name: "ticket-subagent", url: `harness://ticket/${k(s.agents)}?tab=${encodeURIComponent(`agent:${s.nestedAgent.id}`)}` },
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
    // Settings → Models: the Default model picker above a review model per driver.
    { name: "settings-models", url: "harness://settings", seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l.startsWith("Default model, ")).then(() => Bun.sleep(500)) },
    { name: "watcher-new", url: "harness://watcher" },
    { name: "watcher-edit", url: `harness://watcher?id=${encodeURIComponent(s.watcher.id)}` },
    { name: "project-settings", url: `harness://project/${s.project.id}` },
    // The git project's "When approved" default (Merge; no gh remote, so no Open PR).
    // The row sits near the end, so the scroll bottoms out before it reaches scrollTo's band.
    { name: "project-settings-when-approved", url: `harness://project/${s.project.id}`, seconds: 8, prepare: (udid) => scrollTo(udid, (l) => l === "When approved", 3).catch(() => {}).then(() => Bun.sleep(500)) },
    // A git ticket in review: the Approve button's menu (merge, Approve and…, take no action), then
    // the "Approve and…" sheet for instructions. Both are closed again before the next screen.
    {
      name: "approve-menu",
      url: `harness://ticket/${k(s.agents)}`,
      ready: hasLabel(APPROVE_MORE),
      seconds: 6,
      prepare: (udid) => tapWhere(udid, APPROVE_MORE).then(() => approveMenuUp(udid)).then(() => Bun.sleep(500)),
      after: (udid) => tapWhere(udid, "Cancel").then(() => Bun.sleep(400)),
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
    chain(4, async (udid) => {
      await check("a brief with wide tables leaves the replies after it on screen", async () => {
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
        await axe("type", "Use Happy Cog", "--udid", udid);
        await tapWhere(udid, "Send");
        const t = await settle(s.blocked.key, (x) => x.status !== "blocked", 15000);
        return `${t.key} → ${t.status}`;
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
      await check("tapping a board card pushes its ticket and Back returns to the board", async () => {
        await goto(udid, BOARD);
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
        // The glass back button isn't in AXe's tree; it sits at the header's leading edge.
        await axe("tap", "-x", "32", "-y", "89", "--udid", udid);
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
        await tapWhere(udid, "Reset to built-in");
        await tapWhere(udid, "Reset"); // the confirm alert
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
        await tapWhere(udid, (l) => l.startsWith("{{brief}}"));
        await Bun.sleep(500);
        await axe("type", "Z", "--udid", udid);
        await Bun.sleep(300);
        await tapSave();
        const saved = await until("override saved", async () => ((v) => (v !== seeded ? v : null))(await override("run.review")), 8000);
        await api("PATCH", "/settings", { prompts: { "run.review": seeded } });
        moved(udid);
        if (!saved?.endsWith("then the diff.{{brief}}Z")) throw new Error(`expected the text to end "then the diff.{{brief}}Z", got ${JSON.stringify(saved)}`);
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
        await tapWhere(udid, (l) => l === "Dummy Slow" || l.endsWith(", Dummy Slow"));
        const picked = await settle(s.branchPlan.key, (x) => x.driver === "dummy" && x.model === "dummy-slow", 8000);
        await openModels();
        await tapWhere(udid, (l) => l.startsWith("Default"));
        const cleared = await settle(s.branchPlan.key, (x) => x.driver === "dummy" && x.model === null, 8000);
        moved(udid);
        return `${picked.driver}/${picked.model} → ${cleared.driver}/${cleared.model ?? "default"}`;
      });
    }),
    chain(18, async (udid) => {
      await check("board context menu moves a card to Done", async () => {
        await goto(udid, BOARD);
        await tapWhere(udid, (l) => l.startsWith("Review,"));
        await until("card on screen", async () => ((await findElement(udid, (l) => l.startsWith(`${s.browse.key} `)))?.frame.x ?? 999) < 100, 3000).catch(() => {});
        await tapWhere(udid, (l) => l.startsWith(`${s.browse.key} `), { longPress: 1.2 });
        await tapWhere(udid, "Move to Done");
        const t = await settle(s.browse.key, (x) => x.status === "done", 15000);
        return `${t.key} → ${t.status}`;
      });
      await check("Approve menu → Approve and take no action marks a review ticket done without a run", async () => {
        await goto(udid, `harness://ticket/${k(s.quick)}`, (l) => l.includes(APPROVE_MORE));
        await tapWhere(udid, APPROVE_MORE);
        await tapWhere(udid, "Approve and take no action");
        const t = await settle(s.quick.key, (x) => x.status === "done", 15000);
        if (t.humanReview !== "approved") throw new Error(`human review ${t.humanReview}`);
        return `${t.key} human=${t.humanReview} → ${t.status}`;
      });
      await check("Complete menu → Complete and take no action finishes a human-approved ticket without a run", async () => {
        // With auto-complete off, the approval leaves it in review, ready, waiting on Complete.
        await api("PATCH", `/projects/${s.other.id}`, { autoComplete: false });
        try {
          await api("POST", `/tickets/${s.waiting.key}/review`, { decision: "approve" });
          await goto(udid, `harness://ticket/${k(s.waiting)}`, (l) => l.includes("More ways to complete"));
          await tapWhere(udid, "More ways to complete");
          await until("complete menu", async () => (await labels(udid)).includes("Complete and take no action"), 5000).then(() => Bun.sleep(400));
          await tapWhere(udid, "Complete and take no action");
          const t = await settle(s.waiting.key, (x) => x.status === "done", 15000);
          const { runs } = await api<TicketDetail>("GET", `/tickets/${s.waiting.key}`);
          if (runs.some((r) => r.kind === "complete")) throw new Error("a completion run started");
          return `${t.key} → ${t.status}, no completion run`;
        } finally {
          await api("PATCH", `/projects/${s.other.id}`, { autoComplete: true });
        }
      });
      await check("approval card: Allow once resumes the agent", async () => {
        await goto(udid, `harness://ticket/${k(s.approval)}`, (l) => l.includes("Allow once"));
        await tapWhere(udid, "Allow once");
        const t = await settle(s.approval.key, (x) => !x.pendingApproval, 15000);
        return `${t.key} → ${t.status}`;
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
  if (hasAxe && !only) {
    await s.browsed.catch(() => {}); // Move to Done moves it out of Review
    const chains = interactionChains(s).sort((a, b) => b.seconds - a.seconds); // longest first deals best
    const byDevice = lanes(chains, udids.length, (c) => c.seconds);
    await Promise.all(udids.map((u) => appearance(u, "light"))); // their shots are named -light
    await timed("interactions", () => Promise.all(udids.map(async (u, i) => { for (const c of byDevice[i]!) await c.run(u); })));
    await goto(udids[0]!, BOARD);
    await appearance(udids[0]!, "light");
    await shot(udids[0]!, "after-interactions-light");
  }
  return ok;
}

// ---------------------------------------------------------------- build
async function buildApp() {
  if (flag("no-build") && existsSync(appPath)) return;
  // A stale or missing ios/ builds an app that aborts on its first use of an unlinked native
  // module, so regenerate it whenever it doesn't link every native dependency.
  if (Bun.spawnSync(["bun", "Tools/nativeDeps.ts", "check"], { cwd: here, env, stderr: "ignore" }).exitCode !== 0) {
    console.log("syncing ios/ (expo prebuild, pod install)…");
    await sh(["bunx", "expo", "prebuild", "--platform", "ios", "--no-install"], { env: { EXPO_NO_GIT_STATUS: "1" } });
    await sh([join(here, "Tools", "pod.sh"), "install"], { cwd: join(here, "ios") });
    await sh(["bun", "Tools/nativeDeps.ts", "check"]);
  }
  console.log("building Release (simulator)…");
  await sh(["xcodebuild", "-workspace", "ios/Harness.xcworkspace", "-scheme", "Harness", "-configuration", "Release", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "-derivedDataPath", "build/dd", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "build"]);
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
  const [udids, seeded, paged, sticky, typing, mentioned, media] = await Promise.all([
    paired,
    walkThrough ? timed("seed", seed) : null,
    pagingOnly ? timed("seed paging", seedPaging) : null,
    stickOnly ? timed("seed stick", seedStick) : null,
    keyboardOnly ? timed("seed keyboard", () => seedTicket("KEYS", "Warm up").then(async (s) => (await seedPrompts(), s))) : null,
    mentionsOnly ? timed("seed mentions", seedMentions) : null,
    attachmentsOnly ? timed("seed attachments", seedAttachments) : null,
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
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
  reportTimings();
  console.log(failed ? "sim-check finished with failures" : "sim-check done");
}
process.exit(failed ? 1 : 0);
