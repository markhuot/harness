// Seed a test Chrome's profile from a settled one. Not imported by production code.
//
// A Mac enrolled in Chrome's cloud management gets its policy a few seconds after a new profile's
// first launch, and that policy may force-install web apps (this Mac's installs Google Meet). Each
// force-installed app gets a shim in ~/Applications/Chrome Apps.localized, so every fresh test
// profile rewrote the user's Meet shim to point at a temp directory, and Finder kept numbered
// copies of it. A profile that already holds the policy and has run once leaves the shims alone,
// so tests start from a copy of one: warmed once per Chrome version and kept in node_modules/.cache.
// Elsewhere (no cloud management, Linux) nothing is seeded and Chrome starts fresh as before.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MANAGED_PLIST = "/Library/Managed Preferences/com.google.Chrome.plist";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const POLICY = join("Policy", "Machine Level User Cloud Policy");
/** What a settled profile needs: its profile, the cached policy and the browser-wide state. */
const KEEP = ["Default", "Policy", "Local State"];

export interface SeedOptions {
  /** Where settled profiles are kept (one directory per Chrome version). */
  cacheDir?: string;
  /** Whether this Mac's Chrome is under cloud management (only then is a profile seeded). */
  managed?: boolean;
  /** How long to wait for Chrome to fetch the policy when warming (ms). */
  policyTimeoutMs?: number;
  /** How long Chrome keeps running after the policy lands, to install what it forces (ms). */
  settleMs?: number;
}

export const defaultCacheDir = resolve(import.meta.dir, "..", "..", "..", "node_modules", ".cache", "harness-chrome-profile");

/** The installed Chrome's version, read from its bundle, so a Chrome update warms a new profile. */
export function chromeVersion(chromePath: string): string | null {
  try {
    const plist = readFileSync(join(dirname(chromePath), "..", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

const settled = (dir: string) => existsSync(join(dir, POLICY));

/**
 * Fill `profileDir` (an empty or missing directory) from the settled profile for this Chrome,
 * warming one first if there's none yet. Returns whether it seeded. Leaves an existing profile
 * alone, and never throws: a profile that couldn't be seeded just starts fresh.
 */
export async function seedChromeProfile(profileDir: string, chromePath: string | null = process.env.HARNESS_CHROME_PATH || DEFAULT_CHROME, opts: SeedOptions = {}): Promise<boolean> {
  if (!(opts.managed ?? (process.platform === "darwin" && existsSync(MANAGED_PLIST)))) return false;
  if (!chromePath || !existsSync(chromePath)) return false;
  if (existsSync(join(profileDir, "Local State"))) return false;
  const version = chromeVersion(chromePath);
  if (!version) return false;
  const cacheDir = opts.cacheDir ?? defaultCacheDir;
  const template = join(cacheDir, version);
  try {
    if (!settled(template) && !(await warm(chromePath, cacheDir, template, opts))) return false;
    mkdirSync(profileDir, { recursive: true });
    for (const name of KEEP) {
      if (existsSync(join(template, name))) cpSync(join(template, name), join(profileDir, name), { recursive: true });
    }
    return settled(profileDir);
  } catch {
    return false;
  }
}

/**
 * Warm a profile for this Chrome into `template`. Test files start in parallel, so one process
 * warms (holding a lock directory) while the others wait for its result; a lock left by a process
 * that died is taken over once it's older than a warm could take.
 */
async function warm(chromePath: string, cacheDir: string, template: string, opts: SeedOptions): Promise<boolean> {
  const policyTimeoutMs = opts.policyTimeoutMs ?? 30_000;
  const settleMs = opts.settleMs ?? 3000;
  const staleMs = policyTimeoutMs + settleMs + 30_000;
  mkdirSync(cacheDir, { recursive: true });
  const lock = join(cacheDir, ".lock");
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (settled(template)) return true;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) return false;
      await Bun.sleep(200);
    }
  }
  const work = mkdtempSync(join(cacheDir, ".warm-"));
  try {
    if (settled(template)) return true;
    const profile = join(work, "profile");
    const chrome = Bun.spawn(
      [chromePath, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "about:blank"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
      const end = Date.now() + policyTimeoutMs;
      while (!settled(profile) && Date.now() < end && chrome.exitCode === null) await Bun.sleep(100);
      if (settled(profile)) await Bun.sleep(settleMs);
    } finally {
      // SIGTERM is a clean shutdown: Chrome writes its preferences before it exits.
      chrome.kill("SIGTERM");
      const killed = await Promise.race([chrome.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      if (!killed) chrome.kill("SIGKILL");
      await chrome.exited;
    }
    if (!settled(profile)) return false;
    const staged = join(work, "template");
    mkdirSync(staged);
    for (const name of KEEP) {
      if (existsSync(join(profile, name))) cpSync(join(profile, name), join(staged, name), { recursive: true });
    }
    // Profiles warmed for earlier Chrome versions are no use any more.
    for (const old of readdirSync(cacheDir)) {
      if (!old.startsWith(".")) rmSync(join(cacheDir, old), { recursive: true, force: true });
    }
    renameSync(staged, template);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
