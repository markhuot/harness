// Package the built app into out/Harness-darwin-<arch>/Harness.app (run `bun run build` first;
// `bun run package` does both). Only package.json, dist/ and resources/ ship: main, preload and
// renderer are fully bundled. The exception is node-pty (terminals), a native addon: its JS, its
// package.json and this platform's prebuilt pty.node + spawn-helper are copied into
// node_modules/node-pty and unpacked beside app.asar, where native code has to live (sign-mac.ts
// signs them with the rest of the bundle).
import { packager } from "@electron/packager";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const appDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(appDir, "..");
for (const f of ["dist/main/main.cjs", "dist/main/preload.cjs", "dist/renderer/index.html", "resources/harness.json"]) {
  if (!existsSync(join(appDir, f))) throw new Error(`Missing ${f}; run \`bun run build\` first.`);
}
const electronPkg = [join(appDir, "node_modules/electron/package.json"), join(repoRoot, "node_modules/electron/package.json")].find(existsSync);
if (!electronPkg) throw new Error("electron is not installed; run `bun install` at the repo root.");
const electronVersion = JSON.parse(readFileSync(electronPkg, "utf8")).version as string;
const icon = join(appDir, "resources", "icon.icns");

const ptyDir = dirname(createRequire(join(appDir, "package.json")).resolve("node-pty/package.json"));
const ptyPrebuild = `prebuilds/darwin-${process.arch}`;
if (!existsSync(join(ptyDir, ptyPrebuild, "pty.node"))) throw new Error(`node-pty has no ${ptyPrebuild}/pty.node; run \`bun install\`.`);

function copyNodePty(buildPath: string) {
  const dest = join(buildPath, "node_modules", "node-pty");
  mkdirSync(dest, { recursive: true });
  for (const f of ["package.json", "LICENSE", "lib", ptyPrebuild]) {
    cpSync(join(ptyDir, f), join(dest, f), { recursive: true, filter: (src) => !/\.(test\.js|map)$/.test(src) });
  }
  // The tarball ships spawn-helper without its executable bit, and without it every spawn fails.
  chmodSync(join(dest, ptyPrebuild, "spawn-helper"), 0o755);
}

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
  asar: { unpackDir: "node_modules/node-pty" },
  afterCopy: [
    (buildPath, _electronVersion, _platform, _arch, done) => {
      try {
        copyNodePty(buildPath);
        done();
      } catch (e) {
        done(e as Error);
      }
    },
  ],
  prune: false,
  icon: existsSync(icon) ? icon : undefined,
  ignore: (path: string) => path !== "" && !keep.test(path),
  darwinDarkModeSupport: true,
});
for (const p of paths) console.log(`packaged → ${join(p, "Harness.app")}`);
