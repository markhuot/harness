// Copy the packaged Harness.app into ~/Applications, moving an existing copy to the Trash first.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const appDir = resolve(import.meta.dir, "..");
const src = join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app");
if (!existsSync(src)) throw new Error(`Missing ${src}; run \`bun run package\` first.`);
const destDir = join(homedir(), "Applications");
const dest = join(destDir, "Harness.app");
mkdirSync(destDir, { recursive: true });

if (existsSync(dest)) {
  // Quit a running copy so the bundle isn't replaced underneath it. Agents live in the service
  // and keep running.
  await $`osascript -e 'tell application id "com.markhuot.harness.app" to quit'`.quiet().nothrow();
  const trashed = await $`trash ${dest}`.quiet().nothrow();
  if (trashed.exitCode !== 0) throw new Error(`Couldn't move the old ${dest} to the Trash: ${trashed.stderr}`);
}
await $`ditto ${src} ${dest}`;
console.log(`installed → ${dest}`);
