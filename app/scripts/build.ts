// Build the desktop app: resources/harness.json, main + preload bundles, renderer (Vite).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const appDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(appDir, "..");

// 1. Where the service lives and which bun runs it. Read by the main process at launch.
mkdirSync(join(appDir, "resources"), { recursive: true });
writeFileSync(
  join(appDir, "resources", "harness.json"),
  JSON.stringify({ repoRoot, bunPath: process.execPath, builtAt: new Date().toISOString() }, null, 2) + "\n",
);

// 2. Main + preload (CommonJS for Electron's Node side).
for (const entry of ["main", "preload"]) {
  const result = await Bun.build({
    entrypoints: [join(appDir, "src/main", `${entry}.ts`)],
    outdir: join(appDir, "dist/main"),
    target: "node",
    format: "cjs",
    // node-pty is a native addon: loaded from node_modules at runtime, shipped by package.ts.
    external: ["electron", "node-pty"],
    naming: `${entry}.cjs`,
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

// 3. Built-in plugin UIs (the service also builds a missing/stale one on start; doing it here
//    means a fresh checkout's first open of a plugin tab doesn't wait for the bundle).
await $`${process.execPath} run plugins:build`.cwd(repoRoot).quiet();

// 4. Renderer.
await $`${join(repoRoot, "node_modules/.bin/vite")} build --config ${join(appDir, "vite.config.ts")} --logLevel warn`.cwd(appDir);
console.log(`built → ${join(appDir, "dist")}  (repoRoot ${repoRoot}, bun ${process.execPath})`);
