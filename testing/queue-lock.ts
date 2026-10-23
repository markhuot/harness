// The testing lock: one heavy test run at a time on this Mac, across every worktree. Agents running
// `bun run testing` at once overloaded the machine and slowed every run to over an hour, so a run
// that finds the lock taken queues behind earlier ones (first come, first served), waits inside the
// command, and prints a line when its turn starts. Nothing here times out: a holder or waiter that
// dies (killed, crashed) is reaped by its PID and process start time, so it never blocks the line.
//
// Layout under ~/.harness/tmp/testing-lock (HARNESS_HOME is shared by every worktree):
//   testing.lock        the holder; created by hard link, so only one process ever gets it (sim.ts's lock)
//   queue/<ms>-<pid>    one file per waiter, ordered by name; only the head may try the lock
//   last.json           when the previous holder let go and how long it held, for the cooldown
//   held.json           written while a run holds the lock, removed when it lets go; one found by the next
//                       holder means the previous run died without cleaning up, the only time orphans are reaped

import { cpus, homedir, loadavg } from "node:os";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAlive, lockHolder, processStart, releaseLock, tryLock } from "../ios/Tools/sim";

const NAME = "testing";
const COOLDOWN_MS = 60_000;

export function queueDir(): string {
  return process.env.HARNESS_TESTING_LOCK_DIR ?? join(homedir(), ".harness", "tmp", "testing-lock");
}

interface Entry { pid: number; start: string; command: string; at: string }
export interface Waiter extends Entry { name: string }
interface Last { releasedAt: number; heldMs: number }

const alive = (e: Entry) => isAlive(e.pid, e.start);

function readEntry(path: string): Entry | null {
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as Entry;
    return typeof e.pid === "number" && typeof e.start === "string" ? e : null;
  } catch {
    return null;
  }
}

/** The live waiters, first in line first. Entries whose process is gone are removed on the way. */
function waiters(dir: string): Waiter[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "queue")).filter((n) => !n.includes(".tmp")).sort();
  } catch {}
  const out: Waiter[] = [];
  for (const name of names) {
    const path = join(dir, "queue", name);
    const e = readEntry(path);
    if (e && alive(e)) out.push({ ...e, name });
    else rmSync(path, { force: true });
  }
  return out;
}

function readLast(dir: string): Last | null {
  try {
    return JSON.parse(readFileSync(join(dir, "last.json"), "utf8")) as Last;
  } catch {
    return null;
  }
}

/** Who holds the testing lock and who waits behind it, in order. */
export function queueStatus(dir = queueDir()) {
  return { holder: lockHolder(NAME, dir), waiters: waiters(dir) };
}

// ---------------------------------------------------------------- cooldown

/**
 * Why a run that just got the lock should wait before it starts, or null to go. Within a minute of
 * the previous holder letting go, its side effects (xcodebuild, simulators booting or shutting down,
 * Electron) may still be running, and a loaded machine reads the first tests as failures. The load
 * average lags and includes other agents' builds, so it only counts inside that minute.
 */
export function cooldownReason(s: { now: number; releasedAt: number | null; leftover: string[]; load1: number; cores: number }): string | null {
  if (s.releasedAt === null || s.now - s.releasedAt >= COOLDOWN_MS) return null;
  if (s.leftover.length) return `${s.leftover[0]} is still running from the previous run`;
  if (s.load1 > s.cores * 0.75) return `load average ${s.load1.toFixed(1)} is high for ${s.cores} cores`;
  return null;
}

export interface Proc { pid: number; command: string }

/**
 * The processes in a `ps` listing that a killed test run can leave behind: xcodebuild and the
 * Electron the walkthrough launches (the checkout's own, under node_modules/electron, never an
 * installed app such as Slack's). Deliberately narrow: swift-build/swift-test (the ungated `l0`
 * layer in another worktree) and simulator boots (other agents' own simulators) are legitimate
 * work this lock doesn't govern, so they are never touched.
 */
export function leftoverProcesses(procs: Proc[], ignore: number[] = []): Proc[] {
  return procs.filter(({ pid, command: c }) => {
    if (ignore.includes(pid)) return false;
    const first = basename(c.trim().split(/\s+/)[0] ?? "");
    return first === "xcodebuild" || c.includes("node_modules/electron/dist/Electron.app");
  });
}

function psProcs(): Proc[] {
  const r = Bun.spawnSync(["ps", "-axww", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), command: m[2]! }] : [];
  });
}

/** This process and its parents (`bun run` and the shell around it), which are never orphans. */
function ancestry(): number[] {
  const out = [process.pid];
  for (let pid = process.ppid; pid > 1 && out.length < 10; ) {
    out.push(pid);
    const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    pid = Number(r.stdout.toString().trim()) || 0;
  }
  return out;
}

/** Kills the orphans of a run that died without cleaning up (TERM, then KILL after 3 seconds) and shuts down simulators nobody holds. */
export async function reapOrphans(log: (line: string) => void): Promise<void> {
  const orphans = leftoverProcesses(psProcs(), ancestry());
  if (orphans.length) {
    log(`testing: stopping ${orphans.length} leftover process${orphans.length === 1 ? "" : "es"} from earlier runs (${[...new Set(orphans.map((o) => basename(o.command.split(" ")[0]!)))].join(", ")})`);
    for (const o of orphans) try { process.kill(o.pid, "SIGTERM"); } catch {}
    await Bun.sleep(3000);
    for (const o of leftoverProcesses(psProcs(), ancestry())) try { process.kill(o.pid, "SIGKILL"); } catch {}
  }
  Bun.spawnSync(["bun", join(import.meta.dir, "..", "ios", "Tools", "sim.ts"), "shutdown"], { stdout: "ignore", stderr: "ignore" });
}

/** After reaping, waits (at most a minute in all) while a leftover refuses to die or the machine is still loaded from the previous run. */
async function settle(dir: string, log: (line: string) => void, dirty: boolean): Promise<void> {
  const last = readLast(dir);
  const deadline = Date.now() + COOLDOWN_MS;
  let said = "";
  for (;;) {
    const reason = cooldownReason({ now: Date.now(), releasedAt: last?.releasedAt ?? null, leftover: dirty ? leftoverProcesses(psProcs(), ancestry()).map((p) => p.command) : [], load1: loadavg()[0] ?? 0, cores: cpus().length });
    if (!reason || Date.now() >= deadline) return;
    if (reason !== said) log(`testing: waiting up to a minute for the previous run to settle: ${reason}`);
    said = reason;
    await Bun.sleep(2000);
  }
}

// ---------------------------------------------------------------- acquiring

export interface TestingLockOptions {
  dir?: string;
  pollMs?: number;
  /** Skip the cooldown (tests of the queue itself). */
  cooldown?: boolean;
  log?: (line: string) => void;
}

/** Set to the holder's pid for processes started under a held lock, so a nested `bun run testing` doesn't queue behind its own parent. */
const ENV = "HARNESS_TESTING_LOCKED";

/**
 * Waits its turn for the testing lock (no timeout) and returns the function that lets go. Under a
 * parent that holds it already (HARNESS_TESTING_LOCKED names the live holder, or the holder is an ancestor process) it returns at once.
 */
export async function acquireTesting(opts: TestingLockOptions = {}): Promise<() => void> {
  const dir = opts.dir ?? queueDir();
  const holder = lockHolder(NAME, dir);
  // The env var names the holder's pid; it only counts while that process still holds the lock.
  if (holder && (holder.pid === Number(process.env[ENV]) || ancestry().includes(holder.pid))) return () => {};
  const log = opts.log ?? ((l: string) => console.log(l));
  const start = processStart(process.pid) ?? "";
  const held = join(dir, "held.json");
  mkdirSync(join(dir, "queue"), { recursive: true });

  const entryName = `${String(Date.now()).padStart(15, "0")}-${process.pid}`;
  const entryPath = join(dir, "queue", entryName);
  const entry: Entry = { pid: process.pid, start, command: process.argv.slice(1).join(" "), at: new Date().toISOString() };
  const tmp = join(dir, "queue", `${entryName}.tmp`);
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, entryPath);

  let heldSince = 0;
  const release = () => {
    rmSync(entryPath, { force: true });
    if (!heldSince) return;
    rmSync(held, { force: true });
    const heldMs = Date.now() - heldSince;
    heldSince = 0;
    try {
      writeFileSync(join(dir, "last.json"), JSON.stringify({ releasedAt: Date.now(), heldMs } satisfies Last));
    } catch {}
    releaseLock(NAME, dir);
    delete process.env[ENV];
  };
  process.on("exit", release);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      // Pass the signal to the children and give them (walk/run.ts cleans up its processes on it) up
      // to 20 seconds to exit before letting go of the lock, so the next holder doesn't meet their leftovers.
      const children = () => Bun.spawnSync(["pgrep", "-P", String(process.pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
      Bun.spawnSync(["pkill", `-${sig.slice(3)}`, "-P", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 80 && children(); i++) await Bun.sleep(250);
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]);
    });
  }

  let said = -1;
  const last = readLast(dir);
  const arrived = Date.now();
  for (;;) {
    const line = waiters(dir);
    const place = line.findIndex((w) => w.name === entryName);
    if (place === -1) {
      // Our entry vanished (another run misjudged us dead): put it back under the same name, keeping our place.
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, entryPath);
      continue;
    }
    if (place === 0 && tryLock(NAME, dir)) break;
    const position = place + (lockHolder(NAME, dir) ? 1 : 0);
    if (position !== said) {
      const holder = lockHolder(NAME, dir);
      const behind = holder ? `behind ${holder.command}` : "behind the previous run";
      const estimate = last?.heldMs ? ` (about ${Math.max(1, Math.round((last.heldMs * position) / 60_000))} min at the last run's length)` : "";
      log(`testing: queued ${position === 1 ? "next" : `at position ${position}`} ${behind}${estimate}; this command starts by itself when it is your turn, so leave it running.`);
      said = position;
    }
    await Bun.sleep(opts.pollMs ?? 500);
  }
  rmSync(entryPath, { force: true });
  const dirty = existsSync(held);
  writeFileSync(held, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  heldSince = Date.now();
  process.env[ENV] = String(process.pid);
  const waited = Math.round((Date.now() - arrived) / 1000);
  log(`testing: your turn started${waited >= 1 ? ` (waited ${waited}s)` : ""}`);
  if (opts.cooldown !== false) {
    if (dirty) await reapOrphans(log);
    await settle(dir, log, dirty);
  }
  return release;
}
