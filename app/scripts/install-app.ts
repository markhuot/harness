// Copy the packaged (and signed: sign-mac.ts --local) Harness.app into ~/Applications, moving an
// existing copy to the Trash first.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { APP_BUNDLE_ID, LEGACY_APP_BUNDLE_ID } from "./bundle-id";

const appDir = resolve(import.meta.dir, "..");
const src = join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app");
if (!existsSync(src)) throw new Error(`Missing ${src}; run \`bun run package\` first.`);
const destDir = join(homedir(), "Applications");
const dest = join(destDir, "Harness.app");
mkdirSync(destDir, { recursive: true });

if (existsSync(dest)) {
  // Quit a running copy so the bundle isn't replaced underneath it, under the old id too so an
  // upgrade from a build that had it quits that. Agents live in the service and keep running.
  for (const id of [APP_BUNDLE_ID, LEGACY_APP_BUNDLE_ID]) {
    await $`osascript -e ${`tell application id "${id}" to quit`}`.quiet().nothrow();
  }
  const trashed = await $`trash ${dest}`.quiet().nothrow();
  if (trashed.exitCode !== 0) throw new Error(`Couldn't move the old ${dest} to the Trash: ${trashed.stderr}`);
}
await $`ditto ${src} ${dest}`;
console.log(`installed → ${dest}`);
