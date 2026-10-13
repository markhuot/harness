// The git binary every service spawn runs. On macOS `/usr/bin/git` is an xcrun shim that looks up
// the developer directory on every call (~22 ms against ~8 ms for the real binary), and the
// orchestrator runs git dozens of times per ticket transition, so the real binary is resolved once
// per process and reused. The lookup is async: Bun.spawnSync inside a request handler crashes Bun.

import { existsSync } from "node:fs";

export interface GitBinDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  which?: (cmd: string, path: string | undefined) => string | null;
  /** `xcrun -f git`: the real binary behind the shim, or null when xcrun can't say. */
  xcrunFind?: () => Promise<string | null>;
  exists?: (path: string) => boolean;
}

const MAC_SHIM = "/usr/bin/git";

async function xcrunFindGit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["xcrun", "-f", "git"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * HARNESS_GIT_BIN when set; otherwise the git on PATH, except that macOS's /usr/bin/git shim is
 * swapped for the binary xcrun says it runs. Anything that can't be resolved falls back to what
 * the shim or PATH would have run, so this never makes git unavailable.
 */
export async function resolveGitBin(deps: GitBinDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (env.HARNESS_GIT_BIN) return env.HARNESS_GIT_BIN;
  const which = deps.which ?? ((cmd, path) => Bun.which(cmd, path ? { PATH: path } : undefined));
  const onPath = which("git", env.PATH);
  if ((deps.platform ?? process.platform) !== "darwin" || onPath !== MAC_SHIM) return onPath ?? "git";
  const real = await (deps.xcrunFind ?? xcrunFindGit)();
  return real && real !== MAC_SHIM && (deps.exists ?? existsSync)(real) ? real : MAC_SHIM;
}

let resolving: Promise<string> | undefined;
let resolved: string | undefined;

/** The git to spawn, resolved on first use and kept for the life of the process. */
export function gitBin(): Promise<string> {
  resolving ??= resolveGitBin().then((bin) => (resolved = bin));
  return resolving;
}

/** For synchronous callers: the resolved git once gitBin() has finished, plain `git` until then. */
export function gitBinSync(): string {
  if (!resolving) void gitBin();
  return resolved ?? "git";
}
