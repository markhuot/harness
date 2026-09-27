// Package the built app into out/Harness-darwin-<arch>/Harness.app (run `bun run build` first;
// `bun run package` does both). Only package.json, dist/ and resources/ ship: main, preload and
// renderer are fully bundled, so no node_modules are needed at runtime.
import { packager } from "@electron/packager";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(appDir, "..");
for (const f of ["dist/main/main.cjs", "dist/main/preload.cjs", "dist/renderer/index.html", "resources/harness.json"]) {
  if (!existsSync(join(appDir, f))) throw new Error(`Missing ${f}; run \`bun run build\` first.`);
}
const electronPkg = [join(appDir, "node_modules/electron/package.json"), join(repoRoot, "node_modules/electron/package.json")].find(existsSync);
if (!electronPkg) throw new Error("electron is not installed; run `bun install` at the repo root.");
const electronVersion = JSON.parse(readFileSync(electronPkg, "utf8")).version as string;
const icon = join(appDir, "resources", "icon.icns");

const keep = /^\/(package\.json|dist|resources)(\/|$)/;
const paths = await packager({
  dir: appDir,
  name: "Harness",
  executableName: "Harness",
  appBundleId: "com.markhuot.harness.app",
  appCategoryType: "public.app-category.developer-tools",
  platform: "darwin",
  arch: process.arch as "arm64" | "x64",
  electronVersion,
  out: join(appDir, "out"),
  overwrite: true,
  asar: true,
  prune: false,
  icon: existsSync(icon) ? icon : undefined,
  ignore: (path: string) => path !== "" && !keep.test(path),
  darwinDarkModeSupport: true,
});
for (const p of paths) console.log(`packaged → ${join(p, "Harness.app")}`);
