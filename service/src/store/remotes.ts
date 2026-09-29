// Where a project's pull requests would open (DESIGN.md "Completion"): the repo's remote, and
// whether gh is installed and logged into that remote's host. Read from files only (the repo's git
// config, gh's hosts file) so projects can work it out on every read, like insideGitCheckout.
// Only drives what the project offers; the complete run itself checks `gh auth status`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface PullRequestTarget {
  /** The host gh opens the pull request on, e.g. "github.com" or an Enterprise host */
  host: string;
  /** The git remote to push to, e.g. "origin" */
  remote: string;
  /** host/owner/repo, for `gh --repo` */
  repo: string;
}

type Env = Record<string, string | undefined>;

/** The repository's common git dir for a checkout at or under `path` (following worktree .git files). */
export function commonGitDir(path: string): string | null {
  for (let dir = path; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
          if (!m) return null;
          gitDir = resolve(dir, m[1]!.trim());
        }
        const common = join(gitDir, "commondir");
        if (existsSync(common)) {
          const rel = readFileSync(common, "utf8").trim();
          return isAbsolute(rel) ? rel : resolve(gitDir, rel);
        }
      } catch {
        return null;
      }
      return gitDir;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** remote name → url, from a git config file's [remote "x"] sections. */
export function parseRemotes(config: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) {
      current = section[1]!.toLowerCase() === "remote" && section[2] !== undefined ? section[2] : null;
      continue;
    }
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (current && kv && !out.has(current)) out.set(current, kv[1]!.trim().replace(/^"(.*)"$/, "$1"));
  }
  return out;
}

/**
 * host and owner/repo from a remote URL: https://host/owner/repo(.git), ssh://git@host(:port)/owner/repo,
 * or scp-style git@host:owner/repo. null for local paths and anything else.
 */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const u = url.trim();
  const clean = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  const scheme = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (scheme) return { host: scheme[1]!.toLowerCase(), path: clean(scheme[2]!) };
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(u);
  if (scp) return { host: scp[1]!.toLowerCase(), path: clean(scp[2]!) };
  return null;
}

/** The remote a pull request pushes to: origin, or the only remote there is. */
export function pickRemote(remotes: Map<string, string>): { name: string; url: string } | null {
  const origin = remotes.get("origin");
  if (origin) return { name: "origin", url: origin };
  if (remotes.size === 1) {
    const [name, url] = [...remotes][0]!;
    return { name, url };
  }
  return null;
}

/** Hosts gh is logged into: the top-level keys of its hosts.yml. */
export function ghHosts(env: Env = process.env): Set<string> {
  const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "gh") : join(env.HOME || homedir(), ".config", "gh"));
  const hosts = new Set<string>();
  try {
    for (const line of readFileSync(join(dir, "hosts.yml"), "utf8").split(/\r?\n/)) {
      const m = /^([^\s#][^:]*):\s*(?:#.*)?$/.exec(line);
      if (m) hosts.add(m[1]!.trim().replace(/^["'](.*)["']$/, "$1").toLowerCase());
    }
  } catch {}
  // A token in the environment logs gh in without a hosts file.
  if (env.GH_TOKEN || env.GITHUB_TOKEN) hosts.add("github.com");
  if (env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN) {
    if (env.GH_HOST) hosts.add(env.GH_HOST.toLowerCase());
  }
  return hosts;
}

const whichCache = new Map<string, boolean>();

/** Whether `gh` is on PATH (cached per PATH value). */
export function ghInstalled(env: Env = process.env): boolean {
  const path = env.PATH ?? "";
  const hit = whichCache.get(path);
  if (hit !== undefined) return hit;
  const found = path.split(delimiter).some((dir) => dir && existsSync(join(dir, "gh")));
  whichCache.set(path, found);
  return found;
}

/**
 * Where a pull request for the checkout at `path` would open, or null when it can't: no git repo,
 * no usable remote, a remote on a host gh isn't logged into (Bitbucket, GitLab, an Enterprise host
 * without a login), or gh not installed.
 */
export function pullRequestTarget(path: string, env: Env = process.env): PullRequestTarget | null {
  const gitDir = commonGitDir(path);
  if (!gitDir) return null;
  let config: string;
  try {
    config = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    return null;
  }
  const remote = pickRemote(parseRemotes(config));
  if (!remote) return null;
  const parsed = parseRemoteUrl(remote.url);
  if (!parsed || !parsed.path.includes("/")) return null;
  if (!ghInstalled(env) || !ghHosts(env).has(parsed.host)) return null;
  return { host: parsed.host, remote: remote.name, repo: `${parsed.host}/${parsed.path}` };
}
