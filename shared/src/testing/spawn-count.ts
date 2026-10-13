// Counts the processes a test file starts, by program name, so a slow file can be traced to its
// spawns (git, Chrome, daemons) instead of guessed at from its code. The parallel runner (parallel.ts)
// loads this into every `bun test` it starts, and through BUN_OPTIONS into every bun process that
// test starts in turn (a test daemon, a CLI), and points HARNESS_SPAWN_LOG at one file per test file.
// Each spawn appends its program's name as one line; the runner tallies them when the file ends.
//
// Without HARNESS_SPAWN_LOG this does nothing.

import { appendFileSync } from "node:fs";
import { basename } from "node:path";

/** The program a spawn runs, as a short name: "git", "bun", "Google Chrome", "xcrun". */
export function programName(cmd: unknown): string {
  const first = Array.isArray(cmd) ? cmd[0] : typeof cmd === "string" ? cmd.trim().split(/\s+/)[0] : undefined;
  if (typeof first !== "string" || !first) return "?";
  return basename(first);
}

/** Program name → count, from a spawn log's lines. */
export function tallySpawns(log: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of log.split("\n")) {
    if (line) counts[line] = (counts[line] ?? 0) + 1;
  }
  return counts;
}

function install(logPath: string): void {
  const note = (cmd: unknown) => {
    try {
      appendFileSync(logPath, `${programName(cmd)}\n`);
    } catch {}
  };
  // Bun.spawn(cmd, opts) or Bun.spawn({ cmd, ... }). node:child_process runs through these in Bun
  // (exec as "sh"), so patching it too would count each of its spawns twice.
  const argv = (a: unknown) => (Array.isArray(a) ? a : (a as { cmd?: unknown })?.cmd);
  const { spawn, spawnSync } = Bun;
  Bun.spawn = ((a: unknown, b?: unknown) => (note(argv(a)), (spawn as Function).call(Bun, a, b))) as typeof Bun.spawn;
  Bun.spawnSync = ((a: unknown, b?: unknown) => (note(argv(a)), (spawnSync as Function).call(Bun, a, b))) as typeof Bun.spawnSync;
}

if (process.env.HARNESS_SPAWN_LOG) install(process.env.HARNESS_SPAWN_LOG);
