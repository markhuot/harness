// Regenerate resources/icon.icns from resources/icon.svg (macOS: Quick Look + sips + iconutil).
import { join, resolve } from "node:path";
import { $ } from "bun";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";

const res = resolve(import.meta.dir, "..", "resources");
const work = tempDir("harness-icon-");
const iconset = join(work, "icon.iconset");
await $`mkdir -p ${iconset}`;
await $`qlmanage -t -s 1024 -o ${work} ${join(res, "icon.svg")}`.quiet();
const master = join(work, "icon.svg.png");
for (const size of [16, 32, 128, 256, 512]) {
  await $`sips -z ${size} ${size} ${master} --out ${join(iconset, `icon_${size}x${size}.png`)}`.quiet();
  await $`sips -z ${size * 2} ${size * 2} ${master} --out ${join(iconset, `icon_${size}x${size}@2x.png`)}`.quiet();
}
await $`iconutil -c icns ${iconset} -o ${join(res, "icon.icns")}`;
await cleanupTempDirs();
console.log(`wrote ${join(res, "icon.icns")}`);
