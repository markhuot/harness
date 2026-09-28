// Tracked temp directories for tests and dev scripts. Not imported by production code.
//
// Everything made with tempDir() is removed by cleanupTempDirs(), which each package's bun test
// preload (preload.ts, wired up in bunfig.toml) runs after every test file. A process "exit"
// listener removes whatever is left, which covers the dev/check scripts and test runs that die
// before their hooks run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = new Set<string>();
let closers: (() => unknown)[] = [];
let exitHooked = false;

/** mkdtemp under the OS temp dir, removed by cleanupTempDirs() or at process exit. */
export function tempDir(prefix = "harness-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", removeTempDirsSync);
  }
  return dir;
}

/**
 * Run `fn` before the next cleanup removes the temp dirs, so a DB or service living in one is
 * closed first and nothing writes into a directory that's being deleted. Closers run newest first.
 */
export function onTempCleanup(fn: () => unknown): void {
  closers.push(fn);
}

/** Directories tempDir() made that haven't been removed yet. */
export function trackedTempDirs(): string[] {
  return [...dirs];
}

/** Run the registered closers (errors are logged, not thrown), then remove every tracked dir. */
export async function cleanupTempDirs(): Promise<void> {
  const pending = closers.reverse();
  closers = [];
  for (const close of pending) {
    try {
      await close();
    } catch (err) {
      console.error("temp cleanup: closer failed:", err);
    }
  }
  removeTempDirsSync();
}

function removeTempDirsSync(): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
      dirs.delete(dir);
    } catch (err) {
      console.error(`temp cleanup: couldn't remove ${dir}:`, err);
    }
  }
}
