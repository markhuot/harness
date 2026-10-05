// The one shared iOS simulator that agents and scripts test on, and the lock that takes turns on
// it. Every simulator runs on the iOS 27.0 runtime: this never picks another runtime and never
// downloads one. See CLAUDE.md → Simulators.
//
//   bun ios/Tools/sim.ts ensure [--device=name] [--ipad]      find or create the device (iOS 27.0), boot it, print its UDID
//   bun ios/Tools/sim.ts with-lock [--device=name] [--ipad] [--timeout=minutes] -- <command…>
//                                                                 wait for the device, run the command with SIM_UDID set, let go
//   bun ios/Tools/sim.ts shutdown [--device=name]             shut the device down once nobody holds it
//   bun ios/Tools/sim.ts reap                                 clean up after dead sim-check runs: shut down unheld
//                                                                 "sim-check *" devices, stop orphaned daemons, remove temp dirs
//   bun ios/Tools/sim.ts status                               the device and who holds its lock
//   bun ios/Tools/sim.ts disk [--min=GiB]                     free disk space; exits 1 below the minimum (default 5), and
//                                                                 names installed iOS runtimes other than 27.0
//
// The device is "harness-shared" (an iPhone 18 Pro) unless --device names another. Locks are files
// under ~/.harness/tmp/sim-locks (HARNESS_SIM_LOCK_DIR overrides it). Each records the holder's PID
// and process start time, so a lock whose holder died (crashed, killed) is taken over. with-lock
// sets HARNESS_SIM_LOCKED for its command, so a script under it that takes the same lock itself
// (sim-check, say) goes ahead instead of waiting on its parent.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const SHARED_DEVICE = "harness-shared";
/** The only iOS runtime simulators run on. */
export const IOS_RUNTIME = "27.0";
export const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer";
/** Below this much free disk space, builds and new devices stop rather than fill the disk. */
export const MIN_FREE_GIB = 5;

// ---------------------------------------------------------------- runtime pinning

export type DeviceKind = "iphone" | "ipad";
export interface DeviceType { identifier: string; name: string }
export interface Runtime { identifier: string; version: string; name?: string; platform?: string; isAvailable: boolean; supportedDeviceTypes?: DeviceType[] }
export interface Device { udid: string; name: string; state: string; isAvailable: boolean }

/** The installed, available iOS 27.0 runtime (27.0.x counts). Throws, naming what is installed, when there isn't one. */
export function pinnedRuntime(runtimes: Runtime[], version = IOS_RUNTIME): Runtime {
  const ios = runtimes.filter((r) => (r.platform ?? r.identifier).includes("iOS"));
  const found = ios.find((r) => r.isAvailable && (r.version === version || r.version.startsWith(`${version}.`)));
  if (found) return found;
  const have = ios.map((r) => `${r.version}${r.isAvailable ? "" : " (unavailable)"}`).join(", ") || "none";
  throw new Error(
    `the iOS ${version} simulator runtime isn't installed (installed iOS runtimes: ${have}). ` +
      `Simulators only run on iOS ${version}; don't download or pick another runtime. Ask the human to install it with Xcode 27.0.`,
  );
}

/** The device type to create on `runtime`: an iPhone 18 Pro (sim-check taps at its coordinates) or an iPad Pro 11-inch, else any iPhone or iPad. */
export function deviceTypeFor(runtime: Runtime, kind: DeviceKind): DeviceType {
  const types = runtime.supportedDeviceTypes ?? [];
  const found =
    kind === "ipad"
      ? types.find((t) => /^iPad Pro 11-inch \(M\d+\)$/.test(t.name)) ?? types.find((t) => t.name.startsWith("iPad"))
      : types.find((t) => t.name === "iPhone 18 Pro") ?? types.find((t) => t.name.startsWith("iPhone"));
  if (!found) throw new Error(`iOS ${runtime.version} has no ${kind === "ipad" ? "iPad" : "iPhone"} device type`);
  return found;
}

/** A simulator runtime's disk image, as `simctl runtime list -j` reports it. */
export interface RuntimeImage { identifier: string; version: string; platformIdentifier?: string; sizeBytes?: number }

/** Installed iOS runtimes other than 27.0. Nothing runs on them, and each holds about 8 GB of disk. */
export function extraRuntimes(images: RuntimeImage[], version = IOS_RUNTIME): RuntimeImage[] {
  return images.filter((r) => r.platformIdentifier === "com.apple.platform.iphonesimulator" && r.version !== version && !r.version.startsWith(`${version}.`));
}

// ---------------------------------------------------------------- locks

interface Owner { pid: number; start: string; command: string; at: string }
const ownStart = () => (myStart ??= processStart(process.pid) ?? "");
let myStart: string | undefined;

export function lockDir(): string {
  return process.env.HARNESS_SIM_LOCK_DIR ?? join(homedir(), ".harness", "tmp", "sim-locks");
}

const lockPath = (dir: string, name: string) => join(dir, `${name.replace(/[^\w.-]+/g, "_")}.lock`);

/** When the process started (as `ps` prints it), or null when it isn't running. A PID the OS reused has a different start. */
export function processStart(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return null;
  }
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
}

function readOwner(path: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Owner;
    return typeof o.pid === "number" && typeof o.start === "string" ? o : null;
  } catch {
    return null;
  }
}

const alive = (o: Owner) => processStart(o.pid) === o.start;
const mine = (o: Owner | null) => !!o && o.pid === process.pid && o.start === ownStart();

/** Who holds the lock, or null when it's free or its holder is gone. */
export function lockHolder(name: string, dir = lockDir()): Owner | null {
  const o = readOwner(lockPath(dir, name));
  return o && alive(o) ? o : null;
}

/**
 * Removes the lock when its holder is gone. A `.reap` directory (atomic mkdir) lets one process at
 * a time do this, and it reads the holder again under it: someone else may have reaped the lock and
 * taken it in the meantime, and that new lock must stay.
 */
function reapIfStale(path: string): void {
  const first = readOwner(path);
  if (first && alive(first)) return;
  const guard = `${path}.reap`;
  try {
    mkdirSync(guard);
  } catch {
    // Another process is reaping. A guard older than this is left from a reaper that died.
    try {
      if (Date.now() - statSync(guard).mtimeMs > 30_000) rmSync(guard, { recursive: true, force: true });
    } catch {}
    return;
  }
  try {
    const again = readOwner(path);
    if (again && alive(again)) return;
    rmSync(path, { force: true });
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/**
 * Takes the lock if it's free (or its holder is gone). The owner record is written to a temp file
 * and hard-linked into place, which fails when the lock exists, so a reader never sees half a record.
 */
export function tryLock(name: string, dir = lockDir()): boolean {
  mkdirSync(dir, { recursive: true });
  const path = lockPath(dir, name);
  const owner: Owner = { pid: process.pid, start: ownStart(), command: process.argv.slice(1).join(" "), at: new Date().toISOString() };
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(owner));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, path);
        held.add(path);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        reapIfStale(path);
      }
    }
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Lets go of the lock, but only if this process holds it: a lock someone else took stays theirs. */
export function releaseLock(name: string, dir = lockDir()): void {
  releasePath(lockPath(dir, name));
}

function releasePath(path: string): void {
  held.delete(path);
  if (mine(readOwner(path))) rmSync(path, { force: true });
}

// Locks this process holds are let go when it exits, even through process.exit() or an uncaught
// error. A process killed outright leaves its lock behind, and the next one to want it takes it over.
const held = new Set<string>();
process.on("exit", () => {
  for (const path of [...held]) releasePath(path);
});

export interface AcquireOptions { dir?: string; timeoutMs?: number; pollMs?: number; onWait?: (holder: Owner | null) => void }

/** The locks `with-lock` holds for this process and its children (HARNESS_SIM_LOCKED, comma-separated). */
const inherited = () => new Set((process.env.HARNESS_SIM_LOCKED ?? "").split(",").filter(Boolean));

/**
 * Waits for the lock (30 minutes by default) and returns the function that lets go of it. Inside
 * `with-lock` for the same device (sim-check run through it, say) the lock is already ours, so this
 * returns at once rather than wait on its own parent.
 */
export async function acquire(name: string, opts: AcquireOptions = {}): Promise<() => void> {
  if (inherited().has(name)) return () => {};
  const dir = opts.dir ?? lockDir();
  const end = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  let told = false;
  while (!tryLock(name, dir)) {
    const holder = lockHolder(name, dir);
    if (Date.now() >= end) throw new Error(`timed out waiting for the "${name}" simulator lock${holder ? ` (held by pid ${holder.pid}: ${holder.command})` : ""}`);
    if (!told) opts.onWait?.(holder);
    told = true;
    await Bun.sleep(opts.pollMs ?? 250);
  }
  return () => releaseLock(name, dir);
}

/** Runs fn holding the lock, and lets go of it however fn ends. */
export async function withLock<T>(name: string, fn: () => Promise<T> | T, opts: AcquireOptions = {}): Promise<T> {
  const release = await acquire(name, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- devices

export type Simctl = (...args: string[]) => Promise<string>;

export const simctl: Simctl = async (...args) => {
  const p = Bun.spawn(["xcrun", "simctl", ...args], { env: { ...process.env, DEVELOPER_DIR }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`xcrun simctl ${args.join(" ")} → ${code}\n${err || out}`);
  return out.trim();
};

export function freeGiB(path = homedir()): number {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 2 ** 30;
}

/** Throws when the disk has less than `min` GiB free. */
export function checkDisk(min = MIN_FREE_GIB, free = freeGiB()): void {
  if (free < min) throw new Error(`only ${free.toFixed(1)} GiB of disk is free (under ${min} GiB); stop and ask the human to free space before building or creating simulators`);
}

export interface EnsureOptions { kind?: DeviceKind; simctl?: Simctl; lockDir?: string; freeGiB?: () => number; log?: (line: string) => void }

/**
 * Finds the device by name on the iOS 27.0 runtime, creating it if it doesn't exist, boots it and
 * returns its UDID. Callers that run at once create one device between them: finding and creating
 * happen under the device's ".ensure" lock. A device by that name on another runtime is an error,
 * not a reason to make a second one.
 */
export async function ensureDevice(name = SHARED_DEVICE, opts: EnsureOptions = {}): Promise<string> {
  const run = opts.simctl ?? simctl;
  const log = opts.log ?? ((l: string) => console.error(l));
  return withLock(
    `${name}.ensure`,
    async () => {
      const runtime = pinnedRuntime((JSON.parse(await run("list", "runtimes", "--json")) as { runtimes: Runtime[] }).runtimes);
      const devices = (JSON.parse(await run("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices;
      let device = (devices[runtime.identifier] ?? []).find((d) => d.isAvailable && d.name === name);
      if (!device) {
        const elsewhere = Object.entries(devices).find(([rt, list]) => rt !== runtime.identifier && list.some((d) => d.name === name));
        if (elsewhere) throw new Error(`a simulator named "${name}" exists on ${elsewhere[0]}, not iOS ${runtime.version}; ask the human to delete it, then rerun`);
        checkDisk(MIN_FREE_GIB, (opts.freeGiB ?? freeGiB)());
        const type = deviceTypeFor(runtime, opts.kind ?? "iphone");
        log(`creating simulator "${name}" (${type.name}, iOS ${runtime.version})`);
        device = { udid: await run("create", name, type.identifier, runtime.identifier), name, state: "Shutdown", isAvailable: true };
      }
      if (device.state !== "Booted") {
        await run("boot", device.udid).catch((e: Error) => {
          if (!/current state: Booted/.test(e.message)) throw e;
        });
        await run("bootstatus", device.udid, "-b");
      }
      return device.udid;
    },
    { dir: opts.lockDir, timeoutMs: 5 * 60_000 },
  );
}

/** The device's UDID and state on the iOS 27.0 runtime, or null when it doesn't exist. */
async function findDevice(name: string, run: Simctl = simctl): Promise<Device | null> {
  const runtime = pinnedRuntime((JSON.parse(await run("list", "runtimes", "--json")) as { runtimes: Runtime[] }).runtimes);
  const devices = (JSON.parse(await run("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices;
  return (devices[runtime.identifier] ?? []).find((d) => d.isAvailable && d.name === name) ?? null;
}

// ---------------------------------------------------------------- reaping
// A sim-check run that ends normally shuts down (and deletes) the extra simulators it booted, stops its daemon and
// removes its temp dirs. One killed outright (SIGKILL, a crash, a tool timeout) leaves all three
// behind: booted iOS devices and orphaned daemons that keep loading the Mac. `reap` finds what such
// runs left and cleans it up; sim-check and with-lock run it before they start.

/** sim-check's own devices ("sim-check 2", "sim-check iPad 1", …). harness-shared is never reaped. */
export const SIM_CHECK_DEVICE = /^sim-check /;
export const HOME_PREFIX = "harness-sim-home-";
export const PROJECTS_PREFIX = "harness-sim-projects-";
/** Written into a sim-check home: the run that owns it and its projects dir. */
export const RUN_OWNER_FILE = "owner.json";
/** Written into a sim-check home by --keep: its daemon is meant to outlive the run. */
export const KEEP_FILE = "keep";
/** Homes from before owner.json (and their daemons) count as left behind only once this old. */
export const LEGACY_HOME_AGE_SEC = 60 * 60;
/** Projects dirs no home claims count as left behind once this old (a sim-check run takes minutes). */
export const STRAY_PROJECTS_AGE_SEC = 6 * 60 * 60;

export interface RunOwner { pid: number; start: string; scratch: string }
/** A harness daemon a sim-check run started (its HARNESS_HOME is a sim-check home). */
export interface SimDaemon { pid: number; ppid: number; ageSec: number; home: string }
export interface SimTempDir { path: string; kind: "home" | "projects"; ageSec: number; owner: RunOwner | null; ownerAlive: boolean; keep: boolean }
export interface ReapInput { devices: Device[]; held: (name: string) => boolean; daemons: SimDaemon[]; dirs: SimTempDir[]; except?: string[] }
export interface ReapPlan { shutdown: Device[]; kill: SimDaemon[]; remove: string[] }

/** Records the run that owns `home`, so a reaper can tell a live run's dirs from a dead one's. */
export function writeRunOwner(home: string, scratch: string): void {
  const owner: RunOwner = { pid: process.pid, start: ownStart(), scratch };
  writeFileSync(join(home, RUN_OWNER_FILE), JSON.stringify(owner));
}

export function markKept(home: string): void {
  writeFileSync(join(home, KEEP_FILE), "");
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * What runs that died left behind. A device is shut down when it's a booted sim-check device that
 * nobody holds and this caller doesn't want. A daemon is stopped when its parent is gone (it was
 * reparented to launchd) and its home isn't kept; a legacy home (no owner.json) also has to be an
 * hour old, since a --keep from before the keep file looks the same. A home goes when its run is
 * dead and no daemon that stays still runs in it; its projects dir goes with it. A projects dir no
 * home claims goes once it's six hours old.
 */
export function planReap(input: ReapInput): ReapPlan {
  const except = new Set(input.except ?? []);
  const shutdown = input.devices.filter((d) => d.isAvailable && d.state === "Booted" && SIM_CHECK_DEVICE.test(d.name) && !except.has(d.name) && !input.held(d.name));
  const homes = new Map(input.dirs.filter((d) => d.kind === "home").map((d) => [base(d.path), d]));
  const kill = input.daemons.filter((p) => {
    if (p.ppid !== 1) return false;
    const h = homes.get(base(p.home));
    if (h?.keep) return false;
    return h?.owner ? !h.ownerAlive : p.ageSec > LEGACY_HOME_AGE_SEC;
  });
  const killed = new Set(kill.map((p) => p.pid));
  const inUse = new Set(input.daemons.filter((p) => !killed.has(p.pid)).map((p) => base(p.home)));
  const remove: string[] = [];
  const claimed = new Set<string>();
  for (const h of homes.values()) {
    const live = h.keep || inUse.has(base(h.path)) || (h.owner ? h.ownerAlive : h.ageSec <= LEGACY_HOME_AGE_SEC);
    if (h.owner) claimed.add(base(h.owner.scratch));
    if (live) continue;
    remove.push(h.path);
    if (h.owner) remove.push(h.owner.scratch);
  }
  for (const d of input.dirs) {
    if (d.kind === "projects" && !claimed.has(base(d.path)) && d.ageSec > STRAY_PROJECTS_AGE_SEC) remove.push(d.path);
  }
  return { shutdown, kill, remove };
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/** The harness daemons sim-check runs started, from `ps -Eww -x -o pid=,ppid=,etime=,command=` (command plus environment). */
export function parseSimDaemons(ps: string): SimDaemon[] {
  const out: SimDaemon[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !/\bservice\/src\/daemon\.ts\b/.test(m[4]!)) continue;
    const home = new RegExp(`\\bHARNESS_HOME=(\\S*/${HOME_PREFIX}[\\w-]+)`).exec(m[4]!)?.[1];
    if (home) out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: etimeSeconds(m[3]!), home });
  }
  return out;
}

function readRunOwner(home: string): RunOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(home, RUN_OWNER_FILE), "utf8")) as RunOwner;
    return typeof o.pid === "number" && typeof o.start === "string" && typeof o.scratch === "string" ? o : null;
  } catch {
    return null;
  }
}

function listSimTempDirs(tmp: string): SimTempDir[] {
  const now = Date.now();
  const dirs: SimTempDir[] = [];
  for (const name of readdirSync(tmp)) {
    const kind = name.startsWith(HOME_PREFIX) ? "home" : name.startsWith(PROJECTS_PREFIX) ? "projects" : null;
    if (!kind) continue;
    const path = join(tmp, name);
    let ageSec: number;
    try {
      ageSec = (now - statSync(path).mtimeMs) / 1000;
    } catch {
      continue;
    }
    const owner = kind === "home" ? readRunOwner(path) : null;
    dirs.push({ path, kind, ageSec, owner, ownerAlive: !!owner && processStart(owner.pid) === owner.start, keep: kind === "home" && existsSync(join(path, KEEP_FILE)) });
  }
  return dirs;
}

export interface ReapOptions { except?: string[]; tmp?: string; lockDir?: string; log?: (line: string) => void; simctl?: Simctl; ps?: () => string }

const psDaemons = () => Bun.spawnSync(["ps", "-Eww", "-x", "-o", "pid=,ppid=,etime=,command="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();

/** Cleans up what dead sim-check runs left: see planReap. Returns what it did. */
export async function reap(opts: ReapOptions = {}): Promise<ReapPlan> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const dir = opts.lockDir ?? lockDir();
  const run = opts.simctl ?? simctl;
  const listed = (JSON.parse(await run("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices;
  const ps = (opts.ps ?? psDaemons)();
  const plan = planReap({
    devices: Object.values(listed).flat(),
    held: (name) => lockHolder(name, dir) !== null,
    daemons: parseSimDaemons(ps),
    dirs: listSimTempDirs(opts.tmp ?? tmpdir()),
    except: opts.except,
  });
  const shutdown: Device[] = [];
  await Promise.all(
    plan.shutdown.map(async (d) => {
      // Take the lock first: a run that grabs the device between the listing and now keeps it.
      if (!tryLock(d.name, dir)) return;
      try {
        await run("shutdown", d.udid).catch((e: Error) => {
          if (!/current state: Shutdown/.test(e.message)) throw e;
        });
        shutdown.push(d);
        log(`reap: shut down "${d.name}" (${d.udid}), booted with no run holding it`);
      } finally {
        releaseLock(d.name, dir);
      }
    }),
  );
  await Promise.all(
    plan.kill.map(async (p) => {
      log(`reap: stopping orphaned sim-check daemon pid ${p.pid} (HARNESS_HOME=${p.home})`);
      const start = processStart(p.pid);
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {}
      // The daemon closes its Chrome on SIGTERM; give it the time sim-check gives it.
      for (let i = 0; i < 200 && start && processStart(p.pid) === start; i++) await Bun.sleep(100);
      if (start && processStart(p.pid) === start) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {}
      }
      Bun.spawnSync(["pkill", "-f", `user-data-dir=${join(p.home, "chrome-profile")}`]);
    }),
  );
  for (const path of plan.remove) {
    rmSync(path, { recursive: true, force: true });
    log(`reap: removed ${path}`);
  }
  return { ...plan, shutdown };
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const [cmd, ...opts] = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  const opt = (name: string) => opts.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const kind: DeviceKind = opts.includes("--ipad") ? "ipad" : "iphone";
  const name = opt("device") ?? SHARED_DEVICE;
  const waiting = (holder: Owner | null) => console.error(`waiting for the "${name}" simulator${holder ? ` (held by pid ${holder.pid}: ${holder.command})` : ""}…`);
  try {
    if (cmd === "ensure") {
      console.log(await ensureDevice(name, { kind }));
    } else if (cmd === "with-lock") {
      if (!command.length) throw new Error("with-lock needs a command after --");
      await reap({ except: [name] }).catch((e: Error) => console.error(`reap: ${e.message}`));
      const release = await acquire(name, { timeoutMs: Number(opt("timeout") ?? 30) * 60_000, onWait: waiting });
      const udid = await ensureDevice(name, { kind });
      const locked = [...inherited().add(name)].join(",");
      const child = Bun.spawn(command, { env: { ...process.env, DEVELOPER_DIR, SIM_UDID: udid, HARNESS_SIM_LOCKED: locked }, stdio: ["inherit", "inherit", "inherit"] });
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
      const code = await child.exited;
      release();
      process.exit(code);
    } else if (cmd === "shutdown") {
      await withLock(name, async () => {
        const d = await findDevice(name);
        if (d?.state === "Booted") await simctl("shutdown", d.udid);
        console.log(d ? `${name} (${d.udid}) is shut down` : `no simulator named ${name}`);
      }, { onWait: waiting });
    } else if (cmd === "reap") {
      const done = await reap({ log: console.log });
      if (!done.shutdown.length && !done.kill.length && !done.remove.length) console.log("nothing left behind");
    } else if (cmd === "status") {
      const d = await findDevice(name);
      const holder = lockHolder(name);
      console.log(d ? `${name} ${d.udid} ${d.state}` : `${name}: not created yet (\`ensure\` creates it)`);
      console.log(holder ? `held by pid ${holder.pid} since ${holder.at}: ${holder.command}` : "not held");
      console.log(`${freeGiB().toFixed(1)} GiB free`);
    } else if (cmd === "disk") {
      const min = Number(opt("min") ?? MIN_FREE_GIB);
      console.log(`${freeGiB().toFixed(1)} GiB free`);
      const images = await simctl("runtime", "list", "-j").then((out) => Object.values(JSON.parse(out) as Record<string, RuntimeImage>)).catch(() => []);
      for (const r of extraRuntimes(images)) {
        console.error(`the iOS ${r.version} runtime (${((r.sizeBytes ?? 0) / 1e9).toFixed(1)} GB) is installed but nothing runs on it: ask the human to remove it with \`xcrun simctl runtime delete ${r.identifier}\``);
      }
      checkDisk(min);
    } else {
      throw new Error("usage: sim.ts ensure | with-lock [--timeout=minutes] -- <command…> | shutdown | reap | status | disk [--min=GiB]  (each takes --device=name; ensure and with-lock take --ipad)");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
