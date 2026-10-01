// A dev loop for one ticket's work on the native app: its own simulator, its own throwaway daemon
// with a little data on it, the app built, installed fresh and paired, then deep links and
// screenshots on request. Every ticket names its own simulator (harness-<KEY>), so parallel agents
// never drive each other's (ARCHITECTURE.md § Disk budget).
//
//   bun ios/Tools/dev-sim.ts --sim harness-HARNESS-140 [--no-build] [--link harness://…]… [--shot NAME] [--keep]
//   bun ios/Tools/dev-sim.ts --seed-only [--keep]
//
// Run with --help for what each flag does.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPairUrl, type Project, type Ticket, type TicketDetail } from "@harness/shared";
import { axeFor, hasAxe, screenKey, screenState } from "./axe";

const IOS = resolve(import.meta.dir, "..");
const REPO = resolve(IOS, "..");
export const SCREENS = join(IOS, "build", "screens");
const DEFAULT_APP = join(IOS, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const BUNDLE = "com.markhuot.harness";
/** ARCHITECTURE.md § Disk budget: no xcodebuild with less than this free. */
const MIN_FREE_GIB = 5;

export const USAGE = `Usage: bun ios/Tools/dev-sim.ts --sim <name> [options]
       bun ios/Tools/dev-sim.ts --seed-only [--keep]

Creates (if missing) and boots the simulator <name> (an iPhone 18 Pro on the newest installed iOS
runtime), starts a throwaway daemon with a seeded project, builds the native app with
\`bun ios/Tools/build.ts sim\`, installs it fresh (no saved servers, keychain reset) and pairs it.
Pairing and each link are checked on screen with AXe (iOS's "Open in “Harness”?" is tapped); a
run that doesn't reach the board, or a link that doesn't change the screen, fails with the labels
it saw instead of saving screenshots of the wrong screen.

  --sim <name>     the simulator to use; name it after your ticket: harness-<KEY>
  --no-build       install the app that's already built (${DEFAULT_APP.replace(REPO + "/", "")})
  --app <path>     install this Harness.app instead (implies --no-build)
  --link <url>     after pairing, open this link in the app (harness://ticket/GREET-1?tab=details);
                   repeat it to open several in order
  --shot <name>    then save ios/build/screens/<name>-light.png and <name>-dark.png
  --keep           leave the daemon running until Ctrl-C (prints its URL, token and pid)
  --seed-only      start and seed the daemon, print what it seeded, and stop there (no simulator)
  --help           this text

Delete the simulator when the ticket is done: xcrun simctl delete <name>`;

export type Options = {
  sim?: string;
  build: boolean;
  app?: string;
  links: string[];
  shot?: string;
  keep: boolean;
  seedOnly: boolean;
  help: boolean;
};

export class UsageError extends Error {}

/** Parses the command line; `--flag value` and `--flag=value` both work. */
export function parseArgs(argv: string[]): Options {
  const o: Options = { build: true, links: [], keep: false, seedOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? a.slice(2, eq > 0 ? eq : undefined) : null;
    const value = (): string => {
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      return v;
    };
    const bare = () => {
      if (eq > 0) throw new UsageError(`--${name} doesn't take a value`);
    };
    switch (name) {
      case "sim":
        o.sim = value();
        break;
      case "app":
        o.app = resolve(value());
        o.build = false;
        break;
      case "link": {
        const link = value();
        if (!link.startsWith("harness://")) throw new UsageError(`--link must be a harness:// link, got ${link}`);
        o.links.push(link);
        break;
      }
      case "shot": {
        const shot = value();
        // It becomes a file name under ios/build/screens.
        if (!/^[\w.-]+$/.test(shot) || shot.startsWith(".")) throw new UsageError(`--shot must be a plain file name (letters, digits, . _ -), got ${shot}`);
        o.shot = shot;
        break;
      }
      case "no-build":
        bare();
        o.build = false;
        break;
      case "keep":
        bare();
        o.keep = true;
        break;
      case "seed-only":
        bare();
        o.seedOnly = true;
        break;
      case "help":
        bare();
        o.help = true;
        break;
      default:
        throw new UsageError(name === null ? `unexpected argument ${a}` : `unknown option --${name}`);
    }
  }
  if (o.help) return o;
  if (o.seedOnly) {
    if (o.sim || o.links.length || o.shot || o.app || !o.build) throw new UsageError("--seed-only takes only --keep");
    return o;
  }
  if (!o.sim) throw new UsageError("--sim <name> is required (name it harness-<KEY>)");
  if (/^sim-check /.test(o.sim)) throw new UsageError(`${o.sim} belongs to sim-check; use a simulator of your own (harness-<KEY>)`);
  return o;
}

/** Free space in GiB from `df -k <path>` output (its second line's Available column). */
export function dfAvailableGiB(dfOutput: string): number | null {
  const line = dfOutput.trim().split("\n")[1];
  const kb = Number(line?.trim().split(/\s+/)[3]);
  return Number.isFinite(kb) ? kb / 1024 / 1024 : null;
}

// ------------------------------------------------------------------ helpers

const log = (line: string) => console.log(line);

async function sh(cmd: string[], opts: { cwd?: string; allowFail?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? REPO, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} → exit ${code}\n${(err || out).trim()}`);
  return out.trim();
}
const simctl = (...a: string[]) => sh(["xcrun", "simctl", ...a]);

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 20000, every = 100): Promise<T> {
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
  await sh(["git", "-c", "user.name=Harness Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false", ...a], { cwd });
}

/** A port nothing is listening on, so parallel runs never collide. */
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  if (!port) throw new Error("couldn't find a free port");
  return port;
}

// ------------------------------------------------------------------ simulator

type Device = { udid: string; name: string; state: string; isAvailable: boolean };

/** The simulator named `name`, created (iPhone 18 Pro, newest installed iOS) and booted if need be. */
async function bootSimulator(name: string): Promise<string> {
  const list = JSON.parse(await simctl("list", "devices", "--json")) as { devices: Record<string, Device[]> };
  let d = Object.values(list.devices).flat().find((x) => x.isAvailable && (x.name === name || x.udid === name));
  if (!d) d = { udid: await createDevice(name), name, state: "Shutdown", isAvailable: true };
  if (d.state !== "Booted") {
    log(`booting ${name}…`);
    await simctl("boot", d.udid);
    await sh(["xcrun", "simctl", "bootstatus", d.udid, "-b"]);
  }
  return d.udid;
}

/** Never downloads a runtime: only those already installed are considered. */
async function createDevice(name: string): Promise<string> {
  type Runtime = { identifier: string; version: string; platform?: string; isAvailable: boolean; supportedDeviceTypes?: { identifier: string; name: string }[] };
  const runtimes = (JSON.parse(await simctl("list", "runtimes", "--json")) as { runtimes: Runtime[] }).runtimes
    .filter((r) => r.isAvailable && (r.platform ?? r.identifier).includes("iOS"))
    .sort((a, b) => Bun.semver.order(b.version, a.version));
  const pick = (want: (n: string) => boolean) => runtimes.map((r) => ({ r, type: r.supportedDeviceTypes?.find((t) => want(t.name)) })).find((x) => x.type);
  const found = pick((n) => n === "iPhone 18 Pro") ?? pick((n) => /^iPhone/.test(n));
  if (!found) throw new Error("no installed iOS runtime has an iPhone simulator (dev-sim never downloads one)");
  log(`creating simulator "${name}" (${found.type!.name}, iOS ${found.r.version})`);
  return simctl("create", name, found.type!.identifier, found.r.identifier);
}

/** Builds with ios/Tools/build.ts sim (its progress on stderr) and returns the .app it printed. */
async function buildApp(): Promise<string> {
  const free = dfAvailableGiB(await sh(["df", "-k", homedir()]));
  if (free !== null && free < MIN_FREE_GIB) {
    throw new Error(`only ${free.toFixed(1)} GiB free on ${homedir()}; ARCHITECTURE.md § Disk budget says not to build under ${MIN_FREE_GIB} GiB`);
  }
  log(`building the native app (${free?.toFixed(1) ?? "?"} GiB free)…`);
  const p = Bun.spawn(["bun", join(IOS, "Tools", "build.ts"), "sim"], { cwd: REPO, env: process.env, stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`bun ios/Tools/build.ts sim → exit ${code}`);
  const app = out.trim().split("\n").at(-1);
  if (!app || !existsSync(app)) throw new Error(`build.ts didn't print a Harness.app path (got ${JSON.stringify(out.trim())})`);
  return app;
}

type Axe = ReturnType<typeof axeFor>;

/** Fails with what's on screen, after cancelling a leftover "Open in “Harness”?" prompt (it would
 * otherwise accept this run's link later, for a daemon that's gone by then). */
async function failOnScreen(axe: Axe, what: string, labels: string[]): Promise<never> {
  if (screenState(labels) === "prompt") await axe.tap("Cancel");
  throw new Error(`${what}; on screen: ${labels.slice(0, 14).join(" | ") || "(nothing)"}`);
}

/**
 * Opens `url` and waits until the screen `accept`s, tapping Open on iOS's "Open in “Harness”?"
 * prompt whenever it shows. `fail` ends the wait early (the Pair screen's error).
 */
async function openAndWait(udid: string, axe: Axe, url: string, what: string, accept: (labels: string[]) => boolean, opts: { ms?: number; fail?: (labels: string[]) => boolean } = {}) {
  await simctl("openurl", udid, url);
  const end = Date.now() + (opts.ms ?? 15000);
  let labels: string[] = [];
  while (Date.now() < end) {
    labels = await axe.labels();
    if (screenState(labels) === "prompt") {
      await axe.tap("Open");
      continue;
    }
    if (opts.fail?.(labels)) return failOnScreen(axe, what, labels);
    if (accept(labels)) return labels;
    await Bun.sleep(150);
  }
  return failOnScreen(axe, `timed out: ${what}`, labels);
}

/** Installs the app fresh (no saved servers or tokens), cold-launches it on the pair link and waits for the board. */
async function installAndPair(udid: string, axe: Axe, app: string, pairUrl: string) {
  await sh(["xcrun", "simctl", "terminate", udid, BUNDLE], { allowFail: true });
  await sh(["xcrun", "simctl", "uninstall", udid, BUNDLE], { allowFail: true });
  await sh(["xcrun", "simctl", "keychain", udid, "reset"], { allowFail: true });
  await simctl("install", udid, app);
  await simctl("ui", udid, "appearance", "light");
  log("pairing…");
  await openAndWait(udid, axe, pairUrl, "pairing (the board never showed)", (l) => screenState(l) === "board", {
    ms: 40000,
    fail: (l) => screenState(l) === "pairFailed",
  });
  log("paired: the board is up");
}

/** Opens a link in the running app and waits for a new screen (any screen of the app's, when the
 * same link was just opened and nothing should change). */
async function openLink(udid: string, axe: Axe, link: string, previous: { url: string; key: string }) {
  const before = previous.url === link ? null : previous.key;
  const labels = await openAndWait(udid, axe, link, `opening ${link} (the app never left the previous screen)`, (l) => {
    const state = screenState(l);
    return (state === "app" || state === "board") && (before === null || screenKey(l) !== before);
  });
  await Bun.sleep(400); // the push or sheet animation finishes drawing
  return { url: link, key: screenKey(labels) };
}

async function shoot(udid: string, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  const saved: string[] = [];
  try {
    for (const look of ["light", "dark"] as const) {
      await simctl("ui", udid, "appearance", look);
      await Bun.sleep(600);
      const path = join(SCREENS, `${name}-${look}.png`);
      await simctl("io", udid, "screenshot", path);
      saved.push(path);
    }
  } finally {
    await simctl("ui", udid, "appearance", "light");
  }
  for (const p of saved) log(`saved ${p}`);
}

// ------------------------------------------------------------------ daemon

type Daemon = { base: string; token: string; home: string; scratch: string; proc: ReturnType<typeof Bun.spawn> };

async function startDaemon(): Promise<Daemon> {
  const home = mkdtempSync(join(tmpdir(), "harness-dev-home-"));
  const scratch = mkdtempSync(join(tmpdir(), "harness-dev-projects-"));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", join(REPO, "service", "src", "daemon.ts")], {
    env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "1" },
    stdout: Bun.file(join(home, "daemon.out")),
    stderr: Bun.file(join(home, "daemon.err")),
  });
  const d: Daemon = { base, token: "", home, scratch, proc };
  try {
    await until("daemon /health", async () => (await fetch(`${base}/health`)).ok, 20000, 50);
    d.token = readFileSync(join(home, "token"), "utf8").trim();
  } catch (e) {
    await stopDaemon(d, true);
    throw e;
  }
  return d;
}

/** SIGTERM, then SIGKILL after 20 s; deletes its home and scratch unless told to keep them. */
async function stopDaemon(d: Daemon, printErrors = false) {
  if (printErrors) {
    const err = join(d.home, "daemon.err");
    if (existsSync(err)) console.error(readFileSync(err, "utf8").slice(-2000));
  }
  d.proc.kill("SIGTERM");
  if (!(await Promise.race([d.proc.exited.then(() => true), Bun.sleep(20000).then(() => false)]))) d.proc.kill("SIGKILL");
  rmSync(d.home, { recursive: true, force: true });
  rmSync(d.scratch, { recursive: true, force: true });
}

function client(d: Daemon) {
  return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(d.base + path, {
      method,
      headers: { authorization: `Bearer ${d.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ""}`);
    return json.data as T;
  };
}

export type Seeded = { project: Project; review: Ticket; planning: Ticket; blocked: Ticket; done: Ticket };

/**
 * One git project (GREET, with worktrees) and a ticket in each of review, planning, blocked and
 * done. Created one at a time so the keys are always GREET-1 … GREET-4.
 */
async function seed(d: Daemon): Promise<Seeded> {
  const api = client(d);
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
  const repo = join(d.scratch, "greeter");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Greeter\n\nSays hello.\n");
  writeFileSync(join(repo, "src", "app.ts"), 'export function main(name = "world") {\n  console.log("Hello, " + name);\n}\n');
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "Initial commit");
  const project = await api<Project>("POST", "/projects", { path: repo, name: "greeter", key: "GREET", useWorktrees: true, defaultDriver: "dummy" });
  const create = (prompt: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, prompt, driver: "dummy", start: true, ...extra });
  const ticket = async (key: string) => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
  const settle = (t: Ticket, pred: (t: Ticket) => boolean) => until(`${t.key} settles`, async () => ((x) => (pred(x) ? x : null))(await ticket(t.key)), 60000);

  const review = await create("hello world");
  const planning = await create("Write a landing page for the install link", { start: false });
  const blocked = await create("Sign the build\n/block Which Apple Developer team should sign the build: Happy Cog or your personal account?");
  const done = await create("Tidy the README", { start: false });
  await api("PATCH", `/tickets/${done.key}`, { status: "done" });
  const [r, b, p, dn] = await Promise.all([
    settle(review, (t) => t.status === "review" && !t.busy),
    settle(blocked, (t) => t.status === "blocked" && !t.busy),
    settle(planning, (t) => t.status === "planning" && !t.busy),
    settle(done, (t) => t.status === "done"),
  ]);
  return { project, review: r, planning: p, blocked: b, done: dn };
}

function printSeeded(d: Daemon, s: Seeded) {
  log(`daemon:  ${d.base}`);
  log(`token:   ${join(d.home, "token")}`);
  log(`project: ${s.project.key} (id ${s.project.id})`);
  for (const t of [s.review, s.planning, s.blocked, s.done]) log(`  ${t.key}  ${t.status.padEnd(9)} ${t.title}`);
}

// ------------------------------------------------------------------ main

async function main(o: Options): Promise<void> {
  // xcode-select points at the Command Line Tools on this Mac; use the full Xcode for this process only.
  const xcode = "/Applications/Xcode-27.0.0.app/Contents/Developer";
  if (!process.env.DEVELOPER_DIR && existsSync(xcode)) process.env.DEVELOPER_DIR = xcode;

  // Pairing and links are confirmed on screen, which needs AXe.
  if (!o.seedOnly && !hasAxe()) throw new UsageError("dev-sim reads the screen with AXe: brew install cameroncooke/axe/axe");

  if (!o.seedOnly && !o.build) {
    const app = o.app ?? DEFAULT_APP;
    if (!existsSync(app)) throw new UsageError(`${app} doesn't exist; drop --no-build to build it`);
  }

  // The simulator boots and the app builds while the daemon starts and seeds.
  const device = o.seedOnly ? null : Promise.all([bootSimulator(o.sim!), o.build ? buildApp() : Promise.resolve(o.app ?? DEFAULT_APP)]);
  device?.catch(() => {}); // awaited below; don't let an early failure go unhandled meanwhile
  const d = await startDaemon();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopDaemon(d);
  };
  try {
    const seeded = await seed(d);
    printSeeded(d, seeded);
    if (device) {
      const [udid, app] = await device;
      const axe = axeFor(udid, process.env.DEVELOPER_DIR!);
      await installAndPair(udid, axe, app, buildPairUrl(d.base, d.token));
      let previous = { url: "", key: screenKey(await axe.labels()) };
      for (const link of o.links) {
        log(`opening ${link}`);
        previous = await openLink(udid, axe, link, previous);
      }
      if (o.shot) await shoot(udid, o.shot);
      log(`simulator: ${o.sim} (${udid}); delete it when the ticket is done: xcrun simctl delete ${o.sim}`);
    }
  } catch (e) {
    await stopDaemon(d, true);
    stopped = true;
    throw e;
  }

  if (!o.keep) {
    if (device) {
      // Once the daemon is gone the app would spin reconnecting.
      const [udid] = await device;
      await sh(["xcrun", "simctl", "terminate", udid, BUNDLE], { allowFail: true });
    }
    await stop();
    return;
  }
  log(`--keep: daemon running at ${d.base} (pid ${d.proc.pid}); token in ${join(d.home, "token")}. Ctrl-C stops it.`);
  await new Promise<void>((done) => {
    const quit = () => void stop().then(done);
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    d.proc.exited.then(() => {
      if (!stopped) console.error("the daemon exited on its own");
      void stop().then(done);
    });
  });
}

if (import.meta.main) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) {
      console.log(USAGE);
      process.exit(0);
    }
    await main(o);
    process.exit(0);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`dev-sim failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
