#!/usr/bin/env bun
// Service entrypoint (run by launchd): boots the harness and writes service.json.

import { rmSync } from "node:fs";
import { createHarness } from "./app";
import { readServiceJson, resolveHome, resolveHostOverride, resolvePort, writeServiceJson } from "./config";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const home = resolveHome();
  const port = resolvePort();
  const harness = await createHarness({ home, port, hostname: resolveHostOverride(), log: (m) => log(`[orchestrator] ${m}`) });
  writeServiceJson(harness.paths, { port: harness.port, pid: process.pid, startedAt: Date.now() });
  log(`harness listening on ${harness.network.bound().map((b) => b.url).join(", ")} (home ${home}, pid ${process.pid})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
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
