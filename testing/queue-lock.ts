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

import { cpus, homedir, loadavg } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lockHolder, processStart, releaseLock, tryLock } from "../ios/Tools/sim";

const NAME = "testing";
const COOLDOWN_MS = 60_000;

export function queueDir(): string {
  return process.env.HARNESS_TESTING_LOCK_DIR ?? join(homedir(), ".harness", "tmp", "testing-lock");
}

interface Entry { pid: number; start: string; command: string; at: string }
export interface Waiter extends Entry { name: string }
interface Last { releasedAt: number; heldMs: number }

const alive = (e: Entry) => processStart(e.pid) === e.start;

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
 * The processes in a `ps` listing that a test run starts and a finished or killed one can leave
 * behind: builds, simulator boots and shutdowns, and the Electron the walkthrough launches (the
 * checkout's own, under node_modules/electron, never an installed app such as Slack's). While this
 * process holds the lock nothing legitimate runs these, so whatever is found is an orphan.
 */
export function leftoverProcesses(procs: Proc[], ignore: number[] = []): Proc[] {
  return procs.filter(({ pid, command: c }) => {
    if (ignore.includes(pid)) return false;
    const first = basename(c.trim().split(/\s+/)[0] ?? "");
    return ["xcodebuild", "swift-build", "swift-test"].includes(first) || /\bsimctl (boot|shutdown|bootstatus)\b/.test(c) || c.includes("node_modules/electron/dist/Electron.app");
  });
}

function psProcs(): Proc[] {
  const r = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
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

/** Kills the orphans of earlier runs (TERM, then KILL after 3 seconds) and shuts down simulators nobody holds. */
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
async function settle(dir: string, log: (line: string) => void): Promise<void> {
  const last = readLast(dir);
  const deadline = Date.now() + COOLDOWN_MS;
  let said = "";
  for (;;) {
    const reason = cooldownReason({ now: Date.now(), releasedAt: last?.releasedAt ?? null, leftover: leftoverProcesses(psProcs(), ancestry()).map((p) => p.command), load1: loadavg()[0] ?? 0, cores: cpus().length });
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

/** Set for processes started under a held lock, so a nested `bun run testing` doesn't queue behind its own parent. */
const ENV = "HARNESS_TESTING_LOCKED";

/**
 * Waits its turn for the testing lock (no timeout) and returns the function that lets go. Under a
 * parent that holds it already (HARNESS_TESTING_LOCKED, or the holder is an ancestor process) it returns at once.
 */
export async function acquireTesting(opts: TestingLockOptions = {}): Promise<() => void> {
  if (process.env[ENV]) return () => {};
  const dir = opts.dir ?? queueDir();
  const holder = lockHolder(NAME, dir);
  if (holder && ancestry().includes(holder.pid)) return () => {};
  const log = opts.log ?? ((l: string) => console.log(l));
  const start = processStart(process.pid) ?? "";
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
    const heldMs = Date.now() - heldSince;
    heldSince = 0;
    try {
      writeFileSync(join(dir, "last.json"), JSON.stringify({ releasedAt: Date.now(), heldMs } satisfies Last));
    } catch {}
    releaseLock(NAME, dir);
    delete process.env[ENV];
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // Children first, so the next holder doesn't inherit this run's simulators or Electron.
      Bun.spawnSync(["pkill", "-TERM", "-P", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
      process.exit(128 + (sig === "SIGINT" ? 2 : 15));
    });
  }

  let said = -1;
  const last = readLast(dir);
  const arrived = Date.now();
  for (;;) {
    const line = waiters(dir);
    const place = line.findIndex((w) => w.name === entryName);
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
  heldSince = Date.now();
  process.env[ENV] = "1";
  const waited = Math.round((Date.now() - arrived) / 1000);
  log(`testing: your turn started${waited >= 1 ? ` (waited ${waited}s)` : ""}`);
  if (opts.cooldown !== false) {
    await reapOrphans(log);
    await settle(dir, log);
  }
  return release;
}
