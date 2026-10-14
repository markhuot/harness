// Preload for the new suite (bun test --preload). A test here runs in this one process against the
// in-process service, so the things that make the old suite slow can't be done at all: spawning a
// process, opening a socket, launching Chrome, running real git, sleeping. Each fails with the seam
// to use instead. A per-test CPU cap fails a test that burns CPU anyway; wall time never fails
// (several agents share this Mac), the runner only prints it.
//
// NEXT_TIER=contract (the runner sets it for next/contract) turns the process/socket/sleep guards off,
// since that tier exists to run the real thing; the CPU cap goes with them.

import { appendFileSync } from "node:fs";
import { afterEach, beforeEach } from "bun:test";
import { runTeardowns } from "./teardown";

export const CPU_CAP_MS = 1500;
const MAX_SLEEP_MS = 25;

export class GuardError extends Error {
  constructor(what: string, use: string) {
    super(`${what} isn't allowed in the new suite: ${use}. A real one belongs in next/contract.`);
    this.name = "GuardError";
  }
}

type Fn = (...args: any[]) => any;
/** The slice of the Bun global the guard replaces; a test can pass a stand-in. */
export type GuardTarget = Record<"spawn" | "spawnSync" | "serve" | "listen" | "connect" | "udpSocket" | "sleep" | "sleepSync", Fn>;

const PROCESS_USE = "run the code through a seam (GitPort for git, the fake browser for Chrome, the scripted FakeDriver for agents)";
const SOCKET_USE = "call the HTTP, MCP or websocket handler directly through createService()";

function spawnError(cmd: unknown): GuardError {
  const argv = Array.isArray(cmd) ? cmd : cmd && typeof cmd === "object" && "cmd" in cmd ? (cmd as { cmd: unknown[] }).cmd : [];
  const bin = String(argv[0] ?? "a process").split("/").pop();
  if (bin === "git") return new GuardError("Real git (`git " + argv.slice(1, 3).join(" ") + "`)", "use the injected GitPort, createService({ git: createMemoryGit() })");
  if (/chrom/i.test(String(bin))) return new GuardError("Launching Chrome", "use the fake browser replaying a recorded CDP transcript");
  return new GuardError(`Spawning ${bin}`, PROCESS_USE);
}

/** Replace the process, socket and sleep entry points on `target`; returns the function that puts them back. */
export function installGuard(target: GuardTarget): () => void {
  const saved = { ...target };
  const t = target as Record<string, Fn>;
  t.spawn = (cmd: unknown) => {
    throw spawnError(cmd);
  };
  t.spawnSync = t.spawn;
  t.serve = () => {
    throw new GuardError("Bun.serve", SOCKET_USE);
  };
  for (const name of ["listen", "connect", "udpSocket"]) {
    t[name] = () => {
      throw new GuardError(`Bun.${name}`, SOCKET_USE);
    };
  }
  t.sleep = (ms: unknown) => {
    if (typeof ms === "number" && ms > MAX_SLEEP_MS) throw new GuardError(`Sleeping ${ms} ms`, "advance the injected clock with tick(ms), or wait on the event you need with orch.idle()");
    return saved.sleep(ms);
  };
  t.sleepSync = (ms: unknown) => {
    if (typeof ms === "number" && ms > MAX_SLEEP_MS) throw new GuardError(`Sleeping ${ms} ms`, "advance the injected clock with tick(ms)");
    return saved.sleepSync(ms);
  };
  return () => Object.assign(target, saved);
}

/** The cap check, apart from the hook so it can be tested. Null when the test stayed under it. */
export function cpuOverCap(usedMs: number, capMs = CPU_CAP_MS): string | null {
  return usedMs > capMs ? `used ${Math.round(usedMs)} ms of CPU, over the ${capMs} ms cap. A test that needs that much is doing real work: move it to next/contract, or fake what it computes.` : null;
}

function register() {
  const contract = process.env.NEXT_TIER === "contract";
  if (!contract) installGuard(Bun as unknown as GuardTarget);
  const metrics = process.env.NEXT_METRICS;
  let wall = 0;
  let cpu = process.cpuUsage();
  beforeEach(() => {
    wall = performance.now();
    cpu = process.cpuUsage();
  });
  afterEach(async () => {
    await runTeardowns();
    const used = process.cpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1000;
    const wallMs = performance.now() - wall;
    // bun:test doesn't tell a hook which test it ran after (1.2), so the runner pairs these lines with
    // the (pass)/(fail) lines bun prints, in the same order.
    if (metrics) appendFileSync(metrics, `${JSON.stringify({ wallMs, cpuMs })}\n`);
    const over = contract ? null : cpuOverCap(cpuMs);
    if (over) throw new Error(`This test ${over}`);
  });
}

if (typeof beforeEach === "function") register();
