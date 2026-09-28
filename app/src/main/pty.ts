// node-pty as the terminal manager's SpawnPty. node-pty 1.x is an N-API addon, so its prebuilt
// pty.node loads in Electron's Node without a rebuild. It stays out of the main bundle (build.ts
// marks it external) and ships unpacked beside app.asar (package.ts).

import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpawnPty } from "./terminals";

type NodePty = typeof import("node-pty");

/**
 * node-pty forks through a `spawn-helper` binary next to pty.node. The npm tarball ships it
 * without the executable bit and bun skips node-pty's install scripts, so every spawn fails with
 * "posix_spawnp failed" until it's fixed. Packaged builds get the bit in package.ts (the bundle
 * is signed and read-only); this covers dev checkouts.
 */
export function ensureSpawnHelperExecutable(ptyModuleDir: string, platform = process.platform, arch = process.arch) {
  if (platform === "win32") return;
  for (const dir of ["build/Release", `prebuilds/${platform}-${arch}`]) {
    const helper = join(ptyModuleDir, dir, "spawn-helper").replace("app.asar", "app.asar.unpacked");
    try {
      accessSync(helper, constants.X_OK);
      return;
    } catch {}
    try {
      chmodSync(helper, statSync(helper).mode | 0o111);
      return;
    } catch {}
  }
}

let loaded: NodePty | null = null;

/** Load node-pty (throws when it's missing or doesn't load, e.g. under bun) and return its spawn. */
export function nodePtySpawn(): SpawnPty {
  if (!loaded) {
    const pkg = require.resolve("node-pty/package.json");
    ensureSpawnHelperExecutable(dirname(pkg));
    loaded = require("node-pty") as NodePty;
  }
  const pty = loaded;
  return (file, args, { cwd, cols, rows, env }) => pty.spawn(file, args, { name: "xterm-256color", cwd, cols, rows, env });
}
