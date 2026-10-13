// Test runs spawn git thousands of times, from the service and from the tests' own helpers. On macOS
// `/usr/bin/git` is an xcrun shim that costs ~14 ms a call on top of git itself, so the test runners
// resolve the real binary once and put its directory on PATH, just ahead of /usr/bin, for
// everything they start. Not a link to it: git finds its helpers (submodule, templates) from the
// path it was run by, so a linked git looks in the wrong place. Not first on PATH either, which
// would put Apple's python3 and clang ahead of Homebrew's; just ahead of /usr/bin, every tool that
// directory shares with /usr/bin is the one /usr/bin's xcrun shim would have run anyway.

import { existsSync } from "node:fs";
import { dirname } from "node:path";

const MAC_SHIM = "/usr/bin/git";

export interface GitPathDeps {
  platform?: NodeJS.Platform;
  which?: (cmd: string, path: string | undefined) => string | null;
  /** `xcrun -f git`, or null when xcrun can't say. */
  xcrunFind?: () => string | null;
  exists?: (path: string) => boolean;
}

function xcrunFindGit(): string | null {
  try {
    const r = Bun.spawnSync(["xcrun", "-f", "git"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

/** The real git behind macOS's shim, when PATH's git is the shim and xcrun names another binary. */
export function realGitBehindShim(path: string | undefined, deps: GitPathDeps = {}): string | null {
  if ((deps.platform ?? process.platform) !== "darwin") return null;
  const which = deps.which ?? ((cmd, p) => Bun.which(cmd, p ? { PATH: p } : undefined));
  if (which("git", path) !== MAC_SHIM) return null;
  const real = (deps.xcrunFind ?? xcrunFindGit)();
  return real && real !== MAC_SHIM && (deps.exists ?? existsSync)(real) ? real : null;
}

/** PATH with `dir` inserted just before /usr/bin (or last, without one), once. */
export function pathBeforeUsrBin(path: string, dir: string): string {
  const parts = path.split(":").filter((p) => p !== dir);
  const at = parts.indexOf("/usr/bin");
  parts.splice(at === -1 ? parts.length : at, 0, dir);
  return parts.join(":");
}

/**
 * Make PATH's git the real binary for this process and its children. Does nothing off macOS, when
 * git isn't the shim, or when the real one can't be found.
 */
export function useRealGit(env: Record<string, string | undefined> = process.env, deps: GitPathDeps = {}): void {
  const real = realGitBehindShim(env.PATH, deps);
  if (real) env.PATH = pathBeforeUsrBin(env.PATH ?? "", dirname(real));
}
