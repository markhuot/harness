// Which app-* release (CLAUDE.md → Releases) the service's code belongs to, reported on /health as
// `release` so a client built for another release (the iPhone app) can tell the person they
// don't match. It's the newest annotated release tag at or before the code: a checkout ahead of
// its last tag still counts as that release, since the next one doesn't exist yet.

import { REPO_ROOT } from "./code-watch";

/** Set by service/scripts/compile.ts (`--define`) in the compiled executable. */
declare const HARNESS_RELEASE: string | undefined;

/** The release the compiled executable was built from, or null (untagged history, or a checkout). */
export const BUNDLED_RELEASE: string | null = typeof HARNESS_RELEASE === "string" && HARNESS_RELEASE ? HARNESS_RELEASE : null;

/**
 * The newest annotated app-* tag reachable from `root`'s HEAD, or null when there is none (or no
 * git). `git describe` without --tags skips lightweight tags, like publish-install.sh.
 */
export function describeRelease(root: string = REPO_ROOT): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", root, "describe", "--abbrev=0", "--match", "app-*", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const tag = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return tag || null;
  } catch {
    return null;
  }
}

/** How long a checkout's release is reused before asking git again. */
export const RELEASE_TTL_MS = 60_000;

/**
 * A checkout's release, asked again after RELEASE_TTL_MS: tagging a release commit that only
 * changes CHANGELOG.md doesn't make the service stale, so it never restarts to notice the tag.
 */
export function checkoutRelease(describe: () => string | null = () => describeRelease(), now: () => number = Date.now): () => string | null {
  let cached: { value: string | null; at: number } | null = null;
  return () => {
    if (!cached || now() - cached.at >= RELEASE_TTL_MS) cached = { value: describe(), at: now() };
    return cached.value;
  };
}
