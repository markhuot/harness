#!/usr/bin/env bun
// Service entrypoint (run by the app or by launchd): boots the harness and writes service.json.

import { rmSync } from "node:fs";
import { createHarness } from "./app";
import { adoptBundledLaunchd } from "./bundled-launchd";
import { readServiceJson, resolveHome, resolveHostOverride, resolvePort, writeServiceJson } from "./config";
import { LAUNCHD_LABEL } from "./cli";
import { executableFingerprint, sourceFingerprint } from "./code-watch";
import { COMPILED } from "./runtime";

/** How often the service re-hashes its source to notice a merge into its checkout. */
const CODE_WATCH_MS = 20_000;
/** How often a service the app started checks that the app is still its parent. */
const PARENT_CHECK_MS = 2_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
let shuttingDown = false;

async function main() {
  const home = resolveHome();
  const port = resolvePort();
  adoptBundledLaunchd(process.env, home);
  // launchd (KeepAlive) starts the service again when it exits, and so does the app when the
  // service is its child (HARNESS_SUPERVISOR_PID, app/src/main/child.ts). Supervised, it can
  // restart itself: onto new code once idle, or on POST /service/restart. Run by hand, it only
  // reports itself stale. Everything the service spawns (agents included) inherits the
  // environment, so the parent has to be the supervisor itself too.
  const appPid = Number(process.env.HARNESS_SUPERVISOR_PID) || null;
  const byApp = appPid !== null && process.ppid === appPid;
  const supervised = byApp || (process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL && process.ppid === 1);
  const fingerprint = COMPILED ? executableFingerprint(process.execPath) : () => sourceFingerprint();
  const harness = await createHarness({
    home,
    port,
    hostname: resolveHostOverride(),
    log: (m) => log(`[orchestrator] ${m}`),
    codeWatch: { fingerprint, intervalMs: CODE_WATCH_MS },
    restart: supervised ? () => void shutdown("restart") : undefined,
  });
  writeServiceJson(harness.paths, { port: harness.port, pid: process.pid, startedAt: Date.now() });
  log(`harness listening on ${harness.network.bound().map((b) => b.url).join(", ")} (home ${home}, pid ${process.pid})`);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${signal})`);
    // Long enough for orchestrator.stop() plus a graceful Chrome close (worst case ~15s); a forced
    // exit mid-close orphans Chrome and leaks its multi-GB code_sign_clone directory.
    const timer = setTimeout(() => process.exit(1), 25_000);
    try {
      await harness.stop();
      if (readServiceJson(harness.paths)?.pid === process.pid) rmSync(harness.paths.serviceJsonPath, { force: true });
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // The app stops its child on quit; if the app dies without doing so, the service goes with it
  // rather than living on unsupervised. (Bun caches process.ppid, so ask whether the app's pid
  // is still alive instead.)
  if (byApp) setInterval(() => !alive(appPid) && void shutdown("the app exited"), PARENT_CHECK_MS).unref();
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
