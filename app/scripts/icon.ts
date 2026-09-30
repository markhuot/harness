// Regenerate resources/icon.icns from the iPhone/iPad icon (mobile/assets/icon.png), so both apps
// share one artwork. icon-mask.swift clips the full-bleed art into the macOS squircle on a
// transparent canvas; sips + iconutil build the .icns (macOS only).
import { join, resolve } from "node:path";
import { $ } from "bun";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";

const res = resolve(import.meta.dir, "..", "resources");
const source = resolve(import.meta.dir, "..", "..", "mobile", "assets", "icon.png");
const work = tempDir("harness-icon-");
const iconset = join(work, "icon.iconset");
await $`mkdir -p ${iconset}`;
const master = join(work, "master.png");
await $`swift ${join(import.meta.dir, "icon-mask.swift")} ${source} ${master}`;
for (const size of [16, 32, 128, 256, 512]) {
  await $`sips -z ${size} ${size} ${master} --out ${join(iconset, `icon_${size}x${size}.png`)}`.quiet();
  await $`sips -z ${size * 2} ${size * 2} ${master} --out ${join(iconset, `icon_${size}x${size}@2x.png`)}`.quiet();
}
await $`iconutil -c icns ${iconset} -o ${join(res, "icon.icns")}`;
await cleanupTempDirs();
console.log(`wrote ${join(res, "icon.icns")}`);
