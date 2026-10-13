// The pool of shared iOS simulators that agents and scripts test on, and the locks that take turns
// on them. Every simulator runs on the iOS 27.0 runtime: this never picks another runtime and never
// downloads one. See CLAUDE.md → Simulators.
//
//   bun ios/Tools/sim.ts ensure [--all] [--device=name] [--ipad]  find or create the device (iOS 27.0), boot it, print its UDID
//                                                                 (--all: every pool slot the disk has room for)
//   bun ios/Tools/sim.ts with-lock [--device=name] [--ipad] [--timeout=minutes] -- <command…>
//                                                                 wait for a free slot, run the command with SIM_UDID set, let go
//   bun ios/Tools/sim.ts shutdown [--device=name]             shut down the slots nobody holds
//   bun ios/Tools/sim.ts reap                                 clean up after dead sim-check runs: shut down unheld
//                                                                 "sim-check *" devices, stop orphaned daemons, remove temp dirs
//   bun ios/Tools/sim.ts status                               each slot and who holds its lock
//   bun ios/Tools/sim.ts disk [--min=GiB]                     free disk space; exits 1 below the minimum (default 5), and
//                                                                 names installed iOS runtimes other than 27.0
//   bun ios/Tools/sim.ts snapshots [--iphone] [--ipad] [--only=Class/test] [--record] [--out=dir]
//                                                                 the hosted snapshot tests (snapshots.ts), each device under its own lock
//
// The iPhone pool is "harness-shared", "harness-shared-2", … (HARNESS_SIM_POOL_SIZE slots, default 2;
// iPhone 18 Pro each); with-lock takes the first free one. --device names one simulator instead, and
// --ipad the single "harness-shared-ipad". Locks are files under ~/.harness/tmp/sim-locks
// (HARNESS_SIM_LOCK_DIR overrides it), one per simulator. Each records the holder's PID and process
// start time, so a lock whose holder died (crashed, killed) is taken over. with-lock sets
// HARNESS_SIM_LOCKED to the slot it took for its command, so a script under it that asks for a
// slot itself (sim-check, say) goes ahead with that one instead of waiting on its parent.
// A slot that doesn't exist yet is created only with 8 GiB free (a simulator grows 3–8 GB), one
// creation at a time, and `--reuse` prefers the slot of a kept state with a live daemon only on a
// best-effort basis: if that slot is held, the run takes another.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { daemonAnswers as daemonStillAnswers } from "@harness/shared/testing/daemon";
import { listKept, type ReuseState } from "./sim-reuse";

export const SHARED_DEVICE = "harness-shared";
/** The iPad sim-check runs on with --ipad: kept (booted) between runs like SHARED_DEVICE, since creating and installing on a fresh one cost 50–80 s of every run. */
export const SHARED_IPAD_DEVICE = "harness-shared-ipad";
/** A pool slot (harness-shared, harness-shared-2, …) or the shared iPad: simulators that stay up between runs and are never deleted. */
export const isSharedDevice = (name: string) => name === SHARED_IPAD_DEVICE || /^harness-shared(-\d+)?$/.test(name);
/** The iPhone pool's default size; HARNESS_SIM_POOL_SIZE overrides it. */
export const DEFAULT_POOL_SIZE = 2;
/** How many simulators the pool may grow to. */
export function poolSize(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HARNESS_SIM_POOL_SIZE);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_POOL_SIZE;
}
/**
 * The pool's slots, in the order they fill. Slot 1 is the existing "harness-shared" (kept under its
 * own name so the simulator other agents already use is reused, not renamed or recreated); the rest
 * are "harness-shared-2", "harness-shared-3", …
 */
export function poolSlots(size = poolSize()): string[] {
  return Array.from({ length: size }, (_, i) => (i === 0 ? SHARED_DEVICE : `${SHARED_DEVICE}-${i + 1}`));
}
/** The only iOS runtime simulators run on. */
export const IOS_RUNTIME = "27.0";
export const XCODE_27_DEVELOPER_DIR = "/Applications/Xcode-27.0.0.app/Contents/Developer";
/** The Xcode every tool runs against: the caller's DEVELOPER_DIR, else Xcode 27.0 (xcode-select points at the Command Line Tools here). */
export function xcodeDeveloperDir(env: Record<string, string | undefined> = process.env): string {
  return env.DEVELOPER_DIR || XCODE_27_DEVELOPER_DIR;
}
/** Resolve it and write it into `env`, so every child process spawned without its own env inherits Xcode 27.0. */
export function exportDeveloperDir(env: Record<string, string | undefined> = process.env): string {
  return (env.DEVELOPER_DIR = xcodeDeveloperDir(env));
}
export const DEVELOPER_DIR = xcodeDeveloperDir();
/** Below this much free disk space, builds and new devices stop rather than fill the disk. */
export const MIN_FREE_GIB = 5;
/** Creating a new simulator needs this much free: a fresh one grows 3–8 GB as it's used, so it must not start at the edge of MIN_FREE_GIB. */
export const NEW_SIM_GIB = 8;

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
export function reapIfStale(path: string, afterRecheck?: () => void): void {
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
    const gone = !existsSync(path);
    const again = readOwner(path);
    afterRecheck?.();
    // Gone already: whoever reaped it may have been followed by a new holder, whose lock must stay.
    if (gone || (again && alive(again))) return;
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

/** The disk is too full for what was asked; callers that can wait on an existing simulator catch it. */
export class DiskLowError extends Error {}

/** Throws when the disk has less than `min` GiB free. */
export function checkDisk(min = MIN_FREE_GIB, free = freeGiB()): void {
  if (free < min) throw new DiskLowError(`only ${free.toFixed(1)} GiB of disk is free (under ${min} GiB); stop and ask the human to free space before building or creating simulators`);
}

const CREATE_LOCK = "sim-create";

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
        // One creation at a time across the pool, each checking the disk after the last one finished,
        // so two processes can't both see room for a simulator that only fits once.
        const created = await withLock(CREATE_LOCK, async () => {
          checkDisk(NEW_SIM_GIB, (opts.freeGiB ?? freeGiB)());
          const type = deviceTypeFor(runtime, opts.kind ?? "iphone");
          log(`creating simulator "${name}" (${type.name}, iOS ${runtime.version})`);
          return run("create", name, type.identifier, runtime.identifier);
        }, { dir: opts.lockDir, timeoutMs: 5 * 60_000 });
        device = { udid: created, name, state: "Shutdown", isAvailable: true };
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

/** The pinned runtime, asked of simctl once per `simctl` function: acquirePool polls devices every half second and the runtime doesn't change. */
const runtimes = new WeakMap<Simctl, Runtime>();

/** The available devices on the iOS 27.0 runtime. */
async function listDevices(run: Simctl = simctl): Promise<Device[]> {
  let runtime = runtimes.get(run);
  if (!runtime) {
    runtime = pinnedRuntime((JSON.parse(await run("list", "runtimes", "--json")) as { runtimes: Runtime[] }).runtimes);
    runtimes.set(run, runtime);
  }
  const devices = (JSON.parse(await run("list", "devices", "--json")) as { devices: Record<string, Device[]> }).devices;
  return (devices[runtime.identifier] ?? []).filter((d) => d.isAvailable);
}

/** The device's UDID and state on the iOS 27.0 runtime, or null when it doesn't exist. */
async function findDevice(name: string, run: Simctl = simctl): Promise<Device | null> {
  return (await listDevices(run)).find((d) => d.name === name) ?? null;
}

// ---------------------------------------------------------------- the pool
// Agents take turns on a small pool of shared iPhone simulators instead of one: `acquirePool` locks
// the first free slot. Disk is what limits the pool (a simulator grows to 3–8 GB), so a slot beyond
// the first is only created or booted while `bun run sim disk` would pass; with less free, callers
// wait on the slots that are already up. The iPad keeps its one simulator: --ipad runs are rare, and a
// second iPad would cost the disk a second iPhone does for little.

export interface SlotView { name: string; exists: boolean; booted: boolean; held: boolean }

/**
 * The slots to try locking, best first. A free slot that exists goes first (`prefer`red ones ahead of
 * the rest, then pool order). Only when none is free does a slot that doesn't exist yet qualify, so
 * the pool grows lazily. Beyond the first slot, a simulator that isn't already booted is created or
 * booted only with disk to spare (`diskOk`, MIN_FREE_GIB); a slot that doesn't exist is created only
 * with `roomForNew` (NEW_SIM_GIB free, the growth margin), the first one included. Held slots are never candidates: the caller waits instead of queueing on one.
 */
export function slotCandidates(slots: readonly SlotView[], o: { prefer?: readonly string[]; diskOk: boolean; roomForNew?: boolean }): string[] {
  const prefer = o.prefer ?? [];
  const rank = (s: SlotView) => (prefer.includes(s.name) ? prefer.indexOf(s.name) : prefer.length);
  const allowed = slots.filter((s, i) => !s.held && (s.exists ? i === 0 || s.booted || o.diskOk : o.roomForNew ?? o.diskOk));
  const ready = allowed.filter((s) => s.exists).sort((a, b) => rank(a) - rank(b) || slots.indexOf(a) - slots.indexOf(b));
  const fresh = allowed.filter((s) => !s.exists);
  return [...ready, ...fresh].map((s) => s.name);
}

/** A kept daemon that still runs (see daemonAnswers in the shared daemon module). */
export const daemonAnswers = (s: ReuseState, dir: string) => daemonStillAnswers(s, dir);

/**
 * The pool slots the kept `--reuse` states (newest first, live daemons only) were made on, so a rerun
 * goes back to the simulator that holds its app. Best-effort: if that slot is held, the run takes
 * another and sim-check reinstalls there.
 */
export async function keptSlots(tmp = tmpdir(), devices: () => Promise<Device[]> = listDevices, alive: (s: ReuseState, home: string) => Promise<boolean> = daemonAnswers): Promise<string[]> {
  // A state whose daemon is gone can't be reused, so its slot is no reason to prefer one.
  const kept = (await listKept(tmp, HOME_PREFIX, alive)).filter((k) => k.daemonAlive).sort((a, b) => b.state.savedAt - a.state.savedAt);
  const all = await devices();
  const names = kept.flatMap((k) => k.state.udids).map((u) => all.find((d) => d.udid === u)?.name);
  return [...new Set(names.filter((n): n is string => !!n && isSharedDevice(n) && n !== SHARED_IPAD_DEVICE))];
}

export interface PoolOptions extends AcquireOptions {
  slots?: string[];
  /** Slots to take first when free (the one a kept `--reuse` state was made on). */
  prefer?: string[];
  /** The devices that exist on the iOS 27.0 runtime. */
  devices?: () => Promise<Device[]>;
  freeGiB?: () => number;
  minFreeGiB?: number;
  /** Free GiB needed to create a slot that doesn't exist yet (default NEW_SIM_GIB). */
  newSlotGiB?: number;
  /** Slots not to lock (ones whose creation just failed). A function is asked again on every poll, so an exclusion can lapse. */
  exclude?: string[] | (() => string[]);
}

/**
 * Waits (30 minutes by default) for any slot of the pool and returns the one it locked and the
 * function that lets go of it. Inside `with-lock` the slot is already ours (HARNESS_SIM_LOCKED), so
 * that one comes back at once.
 */
export async function acquirePool(opts: PoolOptions = {}): Promise<{ name: string; release: () => void; inherited: boolean }> {
  const dir = opts.dir ?? lockDir();
  const slots = opts.slots ?? poolSlots();
  const mineAlready = [...inherited()].find((n) => slots.includes(n) || /^harness-shared(-\d+)?$/.test(n));
  if (mineAlready) return { name: mineAlready, release: () => {}, inherited: true };
  const end = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  let told = false;
  for (;;) {
    const free = (opts.freeGiB ?? freeGiB)();
    const exclude = typeof opts.exclude === "function" ? opts.exclude() : (opts.exclude ?? []);
    const diskOk = free >= (opts.minFreeGiB ?? MIN_FREE_GIB);
    const roomForNew = free >= (opts.newSlotGiB ?? NEW_SIM_GIB);
    // Lock files first: while every slot is held, polling costs no simctl call.
    const holders = slots.map((n) => lockHolder(n, dir));
    if (holders.some((h, i) => !h && !exclude.includes(slots[i] as string))) {
      const devices = await (opts.devices ?? listDevices)();
      if (!roomForNew && !devices.some((d) => slots.includes(d.name))) checkDisk(opts.newSlotGiB ?? NEW_SIM_GIB, free); // nothing to wait on
      const views: SlotView[] = slots.map((name, i) => {
        const d = devices.find((x) => x.name === name);
        return { name, exists: !!d, booted: d?.state === "Booted", held: !!holders[i] || exclude.includes(name) };
      });
      for (const name of slotCandidates(views, { prefer: opts.prefer, diskOk, roomForNew })) {
        if (tryLock(name, dir)) return { name, release: () => releaseLock(name, dir), inherited: false };
      }
    }
    const held = holders.filter((h): h is Owner => !!h);
    if (Date.now() >= end) {
      throw new Error(`timed out waiting for a shared simulator (${slots.join(", ")})${held.length ? `; held by ${held.map((h) => `pid ${h.pid}: ${h.command}`).join("; ")}` : ""}${roomForNew ? "" : "; disk is low, so no more simulators were created"}`);
    }
    if (!told) opts.onWait?.(held[0] ?? null);
    told = true;
    await Bun.sleep(opts.pollMs ?? 500);
  }
}

/**
 * `acquirePool` and `ensureDevice` together: the locked slot's simulator is created (when it doesn't
 * exist yet) and booted. If creating it is refused for disk after the slot was locked (another run
 * used the room first), the slot is let go and the wait goes on for an existing one.
 */
export async function acquireReady(opts: PoolOptions = {}, ensure: EnsureOptions = {}): Promise<{ name: string; udid: string; release: () => void }> {
  const refused: string[] = [];
  const disk = ensure.freeGiB ?? freeGiB;
  // A slot whose creation was refused for disk is skipped only while the disk is still short: once
  // room appears, it is worth creating again rather than waiting on a held slot.
  const exclude = () => [...(typeof opts.exclude === "function" ? opts.exclude() : (opts.exclude ?? [])), ...(disk() < (opts.newSlotGiB ?? NEW_SIM_GIB) ? refused : [])];
  for (;;) {
    const got = await acquirePool({ ...opts, exclude });
    try {
      return { name: got.name, release: got.release, udid: await ensureDevice(got.name, { ...ensure, lockDir: ensure.lockDir ?? opts.dir }) };
    } catch (e) {
      got.release();
      if (!(e instanceof DiskLowError) || got.inherited) throw e;
      refused.push(got.name);
    }
  }
}

/** Every pool device by name, in slot order: the configured slots plus any harness-shared-N that exists (one made under a larger HARNESS_SIM_POOL_SIZE). */
export function poolNames(devices: readonly Device[], size = poolSize()): string[] {
  const n = (name: string) => (name === SHARED_DEVICE ? 1 : Number(name.slice(SHARED_DEVICE.length + 1)));
  const existing = devices.map((d) => d.name).filter((x) => x !== SHARED_IPAD_DEVICE && /^harness-shared(-\d+)?$/.test(x));
  return [...new Set([...poolSlots(size), ...existing])].sort((a, b) => n(a) - n(b));
}

// ---------------------------------------------------------------- reaping
// A sim-check run that ends normally shuts down (and deletes) the extra simulators it booted, stops its daemon and
// removes its temp dirs. One killed outright (SIGKILL, a crash, a tool timeout) leaves all three
// behind: booted iOS devices and orphaned daemons that keep loading the Mac. `reap` finds what such
// runs left and cleans it up; sim-check and with-lock run it before they start.

/** sim-check's own devices ("sim-check 2", …). harness-shared and harness-shared-ipad are never reaped. */
export const SIM_CHECK_DEVICE = /^sim-check /;
export const HOME_PREFIX = "harness-sim-home-";
/** startDaemon's default home (shared/src/testing/daemon.ts): its orphans are reaped like a sim-check home's. */
export const TEST_DAEMON_HOME_PREFIX = "harness-daemon-";
export const PROJECTS_PREFIX = "harness-sim-projects-";
/** Written into a sim-check home: the run that owns it and its projects dir. */
export const RUN_OWNER_FILE = "owner.json";
/** Written into a sim-check home by --keep: its daemon is meant to outlive the run. */
export const KEEP_FILE = "keep";
/** Homes from before owner.json (and their daemons) count as left behind only once this old. */
export const LEGACY_HOME_AGE_SEC = 60 * 60;
/** A startDaemon home has no owner file; its daemon reparented to launchd means its check is gone, so a few minutes of slack is plenty. */
export const TEST_DAEMON_AGE_SEC = 5 * 60;
const ownerlessAgeSec = (path: string) => (base(path).startsWith(TEST_DAEMON_HOME_PREFIX) ? TEST_DAEMON_AGE_SEC : LEGACY_HOME_AGE_SEC);
/** Projects dirs no home claims count as left behind once this old (a sim-check run takes minutes). */
export const STRAY_PROJECTS_AGE_SEC = 6 * 60 * 60;

export interface RunOwner { pid: number; start: string; scratch: string }
/** A harness daemon a sim-check run started (its HARNESS_HOME is a sim-check home). */
export interface SimDaemon { pid: number; ppid: number; ageSec: number; home: string }
export interface SimTempDir { path: string; kind: "home" | "projects"; ageSec: number; owner: RunOwner | null; ownerAlive: boolean; keep: boolean }
export interface ReapInput { devices: Device[]; held: (name: string) => boolean; daemons: SimDaemon[]; dirs: SimTempDir[]; except?: string[]; includeKept?: boolean }
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
 * hour old, since a --keep from before the keep file looks the same. `includeKept` (`reap --kept`) stops
 * kept daemons too, and removes their homes: a `--keep`'d run for `sim-check --reuse` is otherwise left alone for good. A home goes when its run is
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
    if (h?.keep && !input.includeKept) return false;
    return h?.owner ? !h.ownerAlive : p.ageSec > ownerlessAgeSec(p.home);
  });
  const killed = new Set(kill.map((p) => p.pid));
  const inUse = new Set(input.daemons.filter((p) => !killed.has(p.pid)).map((p) => base(p.home)));
  const remove: string[] = [];
  const claimed = new Set<string>();
  for (const h of homes.values()) {
    const live = (h.keep && !input.includeKept) || inUse.has(base(h.path)) || (h.owner ? h.ownerAlive : h.ageSec <= ownerlessAgeSec(h.path));
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
    const home = new RegExp(`\\bHARNESS_HOME=(\\S*/(?:${HOME_PREFIX}|${TEST_DAEMON_HOME_PREFIX})[\\w-]+)`).exec(m[4]!)?.[1];
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
    const kind = name.startsWith(HOME_PREFIX) || name.startsWith(TEST_DAEMON_HOME_PREFIX) ? "home" : name.startsWith(PROJECTS_PREFIX) ? "projects" : null;
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

export interface ReapOptions { except?: string[]; includeKept?: boolean; tmp?: string; lockDir?: string; log?: (line: string) => void; simctl?: Simctl; ps?: () => string }

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
    includeKept: opts.includeKept,
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
  // The iPhone pool unless --device names one simulator or --ipad asks for the (single) shared iPad.
  const pooled = !opt("device") && kind === "iphone";
  const name = opt("device") ?? (kind === "ipad" ? SHARED_IPAD_DEVICE : SHARED_DEVICE);
  const waiting = (holder: Owner | null) =>
    console.error(`waiting for ${pooled ? `a shared simulator (${poolSlots().join(", ")})` : `the "${name}" simulator`}${holder ? ` (held by pid ${holder.pid}: ${holder.command})` : ""}…`);
  try {
    if (cmd === "ensure") {
      if (opts.includes("--all") && pooled) {
        // Every slot, the first always and the rest only while the disk has room.
        for (const [i, slot] of poolSlots().entries()) {
          if (i > 0 && freeGiB() < NEW_SIM_GIB && !(await findDevice(slot))) {
            console.error(`${slot}: not created, only ${freeGiB().toFixed(1)} GiB of disk is free (a new simulator needs ${NEW_SIM_GIB})`);
            continue;
          }
          console.log(`${slot} ${await ensureDevice(slot, { kind })}`);
        }
      } else {
        console.log(await ensureDevice(name, { kind }));
      }
    } else if (cmd === "with-lock") {
      if (!command.length) throw new Error("with-lock needs a command after --");
      await reap({ except: [name] }).catch((e: Error) => console.error(`reap: ${e.message}`));
      const timeoutMs = Number(opt("timeout") ?? 30) * 60_000;
      let slot = name;
      let release: () => void;
      let udid: string;
      if (pooled) {
        // A --reuse run goes back to the slot its kept state was made on, if that one is free.
        const prefer = command.includes("--reuse") ? await keptSlots() : [];
        ({ name: slot, release, udid } = await acquireReady({ timeoutMs, onWait: waiting, prefer }, { kind }));
      } else {
        release = await acquire(name, { timeoutMs, onWait: waiting });
        udid = await ensureDevice(name, { kind });
      }
      const locked = [...inherited().add(slot)].join(",");
      const child = Bun.spawn(command, { env: { ...process.env, DEVELOPER_DIR, SIM_UDID: udid, HARNESS_SIM_LOCKED: locked }, stdio: ["inherit", "inherit", "inherit"] });
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
      const code = await child.exited;
      release();
      process.exit(code);
    } else if (cmd === "shutdown") {
      // The pool: every slot nobody holds (a held one is in use, so it's skipped, not waited for).
      for (const slot of pooled ? poolNames(await listDevices()) : [name]) {
        const d = await findDevice(slot);
        if (!d) {
          console.log(`no simulator named ${slot}`);
        } else if (!tryLock(slot)) {
          console.log(`${slot} (${d.udid}) is held, left alone`);
        } else {
          try {
            if (d.state === "Booted") await simctl("shutdown", d.udid);
            console.log(`${slot} (${d.udid}) is shut down`);
          } finally {
            releaseLock(slot);
          }
        }
      }
    } else if (cmd === "reap") {
      const done = await reap({ log: console.log, includeKept: opts.includes("--kept") });
      if (!done.shutdown.length && !done.kill.length && !done.remove.length) console.log("nothing left behind");
    } else if (cmd === "status") {
      for (const slot of pooled ? poolNames(await listDevices()) : [name]) {
        const d = await findDevice(slot);
        const holder = lockHolder(slot);
        console.log(d ? `${slot} ${d.udid} ${d.state}` : `${slot}: not created yet (\`ensure\` creates it)`);
        console.log(holder ? `  held by pid ${holder.pid} since ${holder.at}: ${holder.command}` : "  not held");
      }
      console.log(`${freeGiB().toFixed(1)} GiB free`);
    } else if (cmd === "disk") {
      const min = Number(opt("min") ?? MIN_FREE_GIB);
      console.log(`${freeGiB().toFixed(1)} GiB free`);
      const images = await simctl("runtime", "list", "-j").then((out) => Object.values(JSON.parse(out) as Record<string, RuntimeImage>)).catch(() => []);
      for (const r of extraRuntimes(images)) {
        console.error(`the iOS ${r.version} runtime (${((r.sizeBytes ?? 0) / 1e9).toFixed(1)} GB) is installed but nothing runs on it: ask the human to remove it with \`xcrun simctl runtime delete ${r.identifier}\``);
      }
      checkDisk(min);
    } else if (cmd === "snapshots") {
      // The hosted snapshot tests (snapshots.ts): takes each device's lock itself.
      const child = Bun.spawn(["bun", join(import.meta.dir, "snapshots.ts"), ...opts], { stdio: ["inherit", "inherit", "inherit"] });
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
      process.exit(await child.exited);
    } else {
      throw new Error("usage: sim.ts ensure [--all] | with-lock [--timeout=minutes] -- <command…> | shutdown | reap | status | disk [--min=GiB] | snapshots [--iphone] [--ipad] [--only=…] [--record] [--out=dir]  (each takes --device=name for one simulator instead of the pool, or --ipad for the iPad)");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
