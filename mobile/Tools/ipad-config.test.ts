import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import appJson from "../app.json";

// One universal build covers iPhone and iPad. Prebuild turns supportsTablet into
// TARGETED_DEVICE_FAMILY "1,2"; without it an iPad only gets the iPhone app, zoomed.
const expo = (appJson as any).expo;

test("the iOS build targets iPad as well as iPhone", () => {
  expect(expo.ios.supportsTablet).toBe(true);
});

test("orientation isn't locked: iPad multitasking (Split View, Stage Manager) needs every orientation", () => {
  expect(expo.orientation).toBe("default");
  expect(expo.ios.infoPlist.UIRequiresFullScreen).not.toBe(true);
});

// React Native's Modal is portrait-only by default, which an iPad in landscape shows turned the
// wrong way. Every Modal in the app passes supportedOrientations (ui/orientations).
test("every Modal declares its supported orientations", () => {
  const root = resolve(import.meta.dir, "..");
  const files = ["src", "app"].flatMap((d) => (readdirSync(join(root, d), { recursive: true }) as string[]).filter((f) => f.endsWith(".tsx")).map((f) => join(root, d, f)));
  const missing: string[] = [];
  for (const f of files) {
    for (const tag of readFileSync(f, "utf8").match(/<Modal\b[^>]*>/g) ?? []) {
      if (!tag.includes("supportedOrientations=")) missing.push(`${f.slice(root.length + 1)}: ${tag}`);
    }
  }
  expect(files.length).toBeGreaterThan(10);
  expect(missing).toEqual([]);
});
