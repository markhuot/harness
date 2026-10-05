// Runtime paths, port and the service bearer token.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_PORT } from "@harness/shared";

export const VERSION = "0.1.0";

export interface HarnessPaths {
  home: string;
  dbPath: string;
  tokenPath: string;
  logsDir: string;
  logPath: string;
  worktreesDir: string;
  chromeProfileDir: string;
  /** The browser's installed extensions: extensions.json and Web Store downloads (<id>/) */
  chromeExtensionsDir: string;
  serviceJsonPath: string;
  /** Summary attachments, stored as <id>.<ext> */
  attachmentsDir: string;
  /** Prompt attachment uploads (pastes, files from other devices), stored as <id>/<name> */
  uploadsDir: string;
  /** Per-session scratch folders (tmp/<sessionId>/) for files tools save, e.g. screenshots */
  scratchDir: string;
}

export interface ServiceInfo {
  port: number;
  pid: number;
  startedAt: number;
}

export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const raw = env.HARNESS_HOME?.trim();
  if (!raw) return join(homedir(), ".harness");
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HARNESS_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid HARNESS_PORT: ${raw}`);
  return n;
}

export function harnessPaths(home: string): HarnessPaths {
  const logsDir = join(home, "logs");
  return {
    home,
    dbPath: join(home, "harness.db"),
    tokenPath: join(home, "token"),
    logsDir,
    logPath: join(logsDir, "service.log"),
    worktreesDir: join(home, "worktrees"),
    chromeProfileDir: join(home, "chrome-profile"),
    chromeExtensionsDir: join(home, "chrome-extensions"),
    serviceJsonPath: join(home, "service.json"),
    attachmentsDir: join(home, "attachments"),
    uploadsDir: join(home, "uploads"),
    scratchDir: join(home, "tmp"),
  };
}

/** Create HARNESS_HOME and its subdirectories. */
export function ensureHome(home: string): HarnessPaths {
  const paths = harnessPaths(home);
  for (const dir of [paths.home, paths.logsDir, paths.worktreesDir, paths.attachmentsDir, paths.uploadsDir]) mkdirSync(dir, { recursive: true });
  return paths;
}

/** Read the bearer token, creating a random one (32 bytes hex, mode 0600) when missing. */
export function ensureToken(paths: Pick<HarnessPaths, "tokenPath">): string {
  if (existsSync(paths.tokenPath)) {
    const existing = readFileSync(paths.tokenPath, "utf8").trim();
    if (existing) {
      chmodSync(paths.tokenPath, 0o600);
      return existing;
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(paths.tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(paths.tokenPath, 0o600);
  return token;
}

/** Replace the token file with a fresh random token (written 0600 to a temp file, then renamed over). */
export function rotateToken(paths: Pick<HarnessPaths, "tokenPath">): string {
  const token = randomBytes(32).toString("hex");
  const tmp = `${paths.tokenPath}.${process.pid}.tmp`;
  writeFileSync(tmp, token + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, paths.tokenPath);
  return token;
}

/** HARNESS_HOST (tests / dev): overrides the listen setting. */
export function resolveHostOverride(env: Record<string, string | undefined> = process.env): string | null {
  return env.HARNESS_HOST?.trim() || null;
}

export function readToken(paths: Pick<HarnessPaths, "tokenPath">): string | null {
  try {
    return readFileSync(paths.tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeServiceJson(paths: Pick<HarnessPaths, "serviceJsonPath">, info: ServiceInfo) {
  writeFileSync(paths.serviceJsonPath, JSON.stringify(info, null, 2) + "\n");
}

export function readServiceJson(paths: Pick<HarnessPaths, "serviceJsonPath">): ServiceInfo | null {
  try {
    const json = JSON.parse(readFileSync(paths.serviceJsonPath, "utf8"));
    if (typeof json?.port === "number" && typeof json?.pid === "number") return json as ServiceInfo;
    return null;
  } catch {
    return null;
  }
}
