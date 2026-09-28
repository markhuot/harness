#!/usr/bin/env bun
// Service entrypoint (run by launchd): boots the harness and writes service.json.

import { rmSync } from "node:fs";
import { createHarness } from "./app";
import { readServiceJson, resolveHome, resolveHostOverride, resolvePort, writeServiceJson } from "./config";
import { LAUNCHD_LABEL } from "./cli";
import { sourceFingerprint } from "./code-watch";

/** How often the service re-hashes its source to notice a merge into its checkout. */
const CODE_WATCH_MS = 20_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
let shuttingDown = false;

async function main() {
  const home = resolveHome();
  const port = resolvePort();
  // launchd (KeepAlive) starts the service again when it exits, so it can restart itself: onto
  // new code once idle, or on POST /service/restart. Run by hand, it only reports itself stale.
  // Everything the job spawns (agents included) inherits XPC_SERVICE_NAME, so the parent has to
  // be launchd itself too.
  const supervised = process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL && process.ppid === 1;
  const harness = await createHarness({
    home,
    port,
    hostname: resolveHostOverride(),
    log: (m) => log(`[orchestrator] ${m}`),
    codeWatch: { fingerprint: () => sourceFingerprint(), intervalMs: CODE_WATCH_MS },
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
