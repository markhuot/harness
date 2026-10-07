// Package the built app into out/Harness-darwin-<arch>/Harness.app (run `bun run build` first;
// `bun run package` does both). Only package.json, dist/ and resources/ ship: main, preload and
// renderer are fully bundled. The exception is node-pty (terminals), a native addon: its JS, its
// package.json and this platform's prebuilt pty.node + spawn-helper are copied into
// node_modules/node-pty and unpacked beside app.asar, where native code has to live (sign-mac.ts
// signs them with the rest of the bundle).
//
// The service ships inside the app (service/scripts/compile.ts): the compiled executable in
// Contents/MacOS/harness-service and the prebuilt builtin plugins in Contents/Resources/plugins,
// with resources/harness.json pointing the app at the executable. So the app runs on any Mac,
// with no bun or checkout. Its login item ships as Contents/Library/LaunchAgents/<label>.plist,
// which the app registers through SMAppService (DESIGN.md "Service supervision").
//
//   --checkout   keep build.ts's harness.json instead: the app runs the service from this
//                checkout with bun, so a merge into it restarts the service onto the new code
//                (`bun run install-app` does this, then signs it with sign-mac.ts --local; see
//                README "Quick start")
//
// The desktop widgets ship too: ios/project.yml's HarnessMacWidgets extension, built with
// xcodebuild into Contents/PlugIns/HarnessMacWidgets.appex (ad-hoc signed with its sandbox
// entitlements; sign-mac.ts re-signs it with Developer ID), and the reload helper the main process
// runs when the board changes, compiled into Contents/MacOS (src/main/widgets.ts).
import { packager } from "@electron/packager";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { compileService } from "../../service/scripts/compile";
import { BUNDLED_PLIST, buildBundledPlist } from "../../service/src/cli";
import { SERVICE_EXECUTABLE } from "../../service/src/runtime";
import { WIDGET_RELOAD_HELPER } from "../src/main/widgets";
import { APP_BUNDLE_ID } from "./bundle-id";

const appDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(appDir, "..");
const fromCheckout = process.argv.includes("--checkout");
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

// Compiled before packaging, so a failed compile leaves the last app alone.
const serviceOut = join(appDir, "out", "service");
const compiled = fromCheckout ? null : await compileService(serviceOut);
const widgets = buildWidgets();

/** The widget extension and the reload helper, built into out/widgets. */
function buildWidgets(): { appex: string; helper: string } {
  const ios = join(repoRoot, "ios");
  const out = join(appDir, "out", "widgets");
  const env = { ...process.env };
  // xcode-select may point at the Command Line Tools; the build needs the full Xcode.
  const xcode = "/Applications/Xcode-27.0.0.app/Contents/Developer";
  if (!env.DEVELOPER_DIR && existsSync(xcode)) env.DEVELOPER_DIR = xcode;
  const run = (cmd: string[], what: string) => {
    const r = Bun.spawnSync(cmd, { cwd: ios, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      const output = (r.stdout.toString() + r.stderr.toString()).split("\n").slice(-30).join("\n");
      throw new Error(`${what} failed (exit ${r.exitCode}). It needs Xcode and xcodegen.\n${output}`);
    }
  };
  console.log("building the desktop widgets (HarnessMacWidgets)…");
  run(["xcodegen", "--spec", join(ios, "project.yml"), "--project", ios, "--quiet"], "xcodegen");
  const dd = join(ios, "build", "mac-dd");
  run([
    "xcodebuild", "-project", join(ios, "Harness.xcodeproj"), "-scheme", "HarnessMacWidgets", "-configuration", "Release",
    "-destination", "generic/platform=macOS", "-derivedDataPath", dd, `ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
    // Unsigned: without a provisioning profile Xcode drops the sandbox and App Group entitlements
    // from an ad-hoc signature, so the extension is signed below with them instead.
    "CODE_SIGNING_ALLOWED=NO", "build",
  ], "xcodebuild HarnessMacWidgets");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const appex = join(out, "HarnessMacWidgets.appex");
  cpSync(join(dd, "Build", "Products", "Release", "HarnessMacWidgets.appex"), appex, { recursive: true, verbatimSymlinks: true });
  // Ad-hoc, so a packaged app runs it before signing; sign-mac.ts re-signs it with Developer ID.
  const entitlements = join(ios, "Widgets", "macOS", "HarnessMacWidgets.entitlements");
  run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, appex], "codesign HarnessMacWidgets.appex");
  const helper = join(out, WIDGET_RELOAD_HELPER);
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos15.0`;
  run(["xcrun", "swiftc", "-O", "-target", target, "-o", helper, join(ios, "Widgets", "macOS", "reload-widgets.swift")], "swiftc reload-widgets");
  return { appex, helper };
}

const keep = /^\/(package\.json|dist|resources)(\/|$)/;
const paths = await packager({
  dir: appDir,
  name: "Harness",
  executableName: "Harness",
  appBundleId: APP_BUNDLE_ID,
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
        if (compiled) {
          const json = { executable: SERVICE_EXECUTABLE, builtAt: new Date().toISOString() };
          writeFileSync(join(buildPath, "resources", "harness.json"), JSON.stringify(json, null, 2) + "\n");
        }
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
  // harness://ticket/<key> from the desktop widget (src/main/widgets.ts routeForLink).
  protocols: [{ name: "Harness", schemes: ["harness"] }],
});
for (const p of paths) {
  const bundle = join(p, "Harness.app", "Contents");
  mkdirSync(join(bundle, "PlugIns"), { recursive: true });
  cpSync(widgets.appex, join(bundle, "PlugIns", "HarnessMacWidgets.appex"), { recursive: true, verbatimSymlinks: true });
  cpSync(widgets.helper, join(bundle, "MacOS", WIDGET_RELOAD_HELPER));
  if (compiled) {
    cpSync(compiled.executable, join(bundle, "MacOS", SERVICE_EXECUTABLE));
    const agents = join(bundle, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, BUNDLED_PLIST), buildBundledPlist({ appBundleId: APP_BUNDLE_ID, executable: SERVICE_EXECUTABLE }));
    const plugins = join(bundle, "Resources", "plugins");
    rmSync(plugins, { recursive: true, force: true });
    cpSync(join(serviceOut, "Resources", "plugins"), plugins, { recursive: true });
  }
  console.log(`packaged → ${join(p, "Harness.app")} (service: ${compiled ? `bundled, plugins ${compiled.plugins.join(", ")}` : `checkout ${repoRoot}`})`);
}
