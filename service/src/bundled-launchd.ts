// The daemon under Harness.app's bundled plist (cli.ts buildBundledPlist), which the app registers
// through SMAppService. That plist is the same for every user, so it holds no paths; the daemon
// sets up what a hand-written plist's PATH, WorkingDirectory and StandardOutPath would have.

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { format } from "node:util";
import { BUNDLED_ENV, launchdPath } from "./cli";
import { ensureHome, harnessPaths } from "./config";

/** launchd's bare PATH, with the directories bun, git, claude and node usually live in ahead of it. */
export function bundledPath(current: string | undefined, userHome: string): string {
  return [...new Set([...launchdPath(userHome).split(":"), ...(current ?? "").split(":").filter(Boolean)])].join(":");
}

/** Under the bundled plist: fix PATH, run from the home, and send console output to the service log. */
export function adoptBundledLaunchd(env: NodeJS.ProcessEnv, home: string): boolean {
  if (env[BUNDLED_ENV] !== "bundle") return false;
  env.PATH = bundledPath(env.PATH, homedir());
  const paths = ensureHome(home);
  process.chdir(home);
  const write = (...args: unknown[]) => {
    try {
      appendFileSync(paths.logPath, format(...args) + "\n");
    } catch {}
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = write;
  // Nothing reads launchd's stdout here, so a crash has to reach the log on its own.
  process.on("uncaughtException", (err) => {
    write(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => write("unhandled rejection:", err));
  return true;
}
