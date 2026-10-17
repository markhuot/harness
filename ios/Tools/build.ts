// Builds the native iPhone/iPad app (ios/). Each build regenerates Harness.xcodeproj with XcodeGen
// when project.yml or the source file list changed, builds into ios/build/dd (ARCHITECTURE.md
// § Disk budget) and logs xcodebuild's output to ios/build/<command>.log, printing only its tail
// when it fails.
// Progress goes to stderr, and the path of what was built is the one line on stdout.
//
//   bun ios/Tools/build.ts sim [--optimized]           Release settings, iphonesimulator, ad-hoc signed, arm64. Compiled without optimization
//                                                      (-Onone, per-file) unless --optimized: about a third of the clean build time,
//                                                      and sim-check drives it the same; --optimized for what measures speed or memory
//   bun ios/Tools/build.ts snapshots                   Debug build-for-testing of the snapshot tests (HarnessSnapshotTests),
//                                                      into ios/build/dd-snapshots; prints the .xctestrun path
//                                                      (Tools/snapshots.ts, `bun run sim snapshots`, runs it)
//   bun ios/Tools/build.ts screens --derived-data DIR  Debug build-for-testing of the L4 screen tests (HarnessScreenTests, testing/ios) into DIR;
//                                                      prints the .xctestrun path (`bun run testing ios` runs it)
//   bun ios/Tools/build.ts archive --build-number N    Release archive for devices (CFBundleVersion N),
//                                                      signed automatically with team 47P4ZSALX4
//   bun ios/Tools/build.ts export --method dev|testflight
//                                                      dev: development-signed IPA (ExportOptions.plist);
//                                                      testflight: upload to App Store Connect
//                                                      (ExportOptions-testflight.plist), signed in with the
//                                                      ASC API key when ASC_KEY_ID and ASC_ISSUER_ID are set
//   bun ios/Tools/build.ts device --device <name|udid> [--launch]
//                                                      Debug build installed with devicectl
//   bun ios/Tools/build.ts verify --bundle-id ID --build-number N <Harness.app>
//                                                      checks an unpacked app before it's published
//
// archive and export take --archive-path; export takes --export-path. release/publish-install.sh
// runs archive, export and verify.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bundleInputs, planXcodegen, xcfilelist, xcodegenHash } from "./build-cache";
import { exportDeveloperDir } from "./sim";
import { deviceAppUrl, hashApp, planDeviceInstall } from "./sim-reuse";

export const IOS = resolve(import.meta.dir, "..");
export const BUILD = join(IOS, "build");
export const DERIVED_DATA = join(BUILD, "dd");
/** Its own derived data: the snapshot tests build Debug, the app builds Release. */
export const SNAPSHOT_DERIVED_DATA = join(BUILD, "dd-snapshots");
export const TEAM_ID = "47P4ZSALX4";
export const BUNDLE_ID = "com.markhuot.harness";

export type Method = "dev" | "testflight";
export type Options =
  | { command: "sim"; optimized: boolean }
  | { command: "snapshots" }
  | { command: "screens"; derivedData: string }
  | { command: "archive"; buildNumber: string; archivePath: string }
  | { command: "export"; method: Method; archivePath: string; exportPath: string }
  | { command: "device"; device: string; launch: boolean }
  | { command: "verify"; bundleId: string; buildNumber: string; app: string };

export class UsageError extends Error {}

const DEFAULT_ARCHIVE = join(BUILD, "Harness.xcarchive");
const BOOLEAN_FLAGS = ["launch", "optimized"];

export function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (BOOLEAN_FLAGS.includes(a.slice(2))) flags.set(a.slice(2), true);
    else {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${a} needs a value`);
      flags.set(a.slice(2), value);
    }
  }
  const allowed: Record<string, string[]> = {
    sim: ["optimized"],
    snapshots: [],
    screens: ["derived-data"],
    archive: ["build-number", "archive-path"],
    export: ["method", "archive-path", "export-path"],
    device: ["device", "launch"],
    verify: ["bundle-id", "build-number"],
  };
  if (!command || !(command in allowed)) throw new UsageError(`unknown command ${command ?? "(none)"}; expected ${Object.keys(allowed).join(", ")}`);
  for (const k of flags.keys()) if (!allowed[command]!.includes(k)) throw new UsageError(`${command} doesn't take --${k}`);
  if (command !== "verify" && positional.length) throw new UsageError(`unexpected argument ${positional[0]}`);
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const need = (k: string): string => str(k) ?? fail(`${command} needs --${k}`);
  const buildNumber = (): string => {
    const n = need("build-number");
    // CFBundleVersion: digits only, so it orders like the tag (CLAUDE.md → Releases).
    if (!/^\d+$/.test(n)) throw new UsageError(`--build-number must be digits, got ${n}`);
    return n;
  };
  switch (command) {
    case "sim":
      return { command, optimized: flags.has("optimized") };
    case "snapshots":
      return { command };
    case "screens":
      return { command, derivedData: resolve(need("derived-data")) };
    case "archive":
      return { command, buildNumber: buildNumber(), archivePath: resolve(str("archive-path") ?? DEFAULT_ARCHIVE) };
    case "export": {
      const method = need("method");
      if (method !== "dev" && method !== "testflight") throw new UsageError(`--method must be dev or testflight, got ${method}`);
      return {
        command,
        method,
        archivePath: resolve(str("archive-path") ?? DEFAULT_ARCHIVE),
        exportPath: resolve(str("export-path") ?? join(BUILD, method === "dev" ? "ipa-dev" : "ipa-testflight")),
      };
    }
    case "device":
      return { command, device: need("device"), launch: flags.get("launch") === true };
    default: {
      if (positional.length !== 1) throw new UsageError("verify needs exactly one Harness.app path");
      return { command: "verify", bundleId: need("bundle-id"), buildNumber: buildNumber(), app: resolve(positional[0]!) };
    }
  }
}

function fail(message: string): never {
  throw new UsageError(message);
}

const CPU_TYPE_ARM64 = 0x0100000c;

/** The CPU types in a Mach-O file's header (thin or universal), or null when it isn't Mach-O. */
export function machOCpuTypes(bytes: Uint8Array): number[] | null {
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) return [view.getInt32(4, true)]; // MH_MAGIC(_64), little-endian
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const stride = magic === 0xcafebabf ? 32 : 20;
    const count = view.getUint32(4, false);
    const types: number[] = [];
    for (let i = 0; i < count && 8 + i * stride + 4 <= bytes.length; i++) types.push(view.getInt32(8 + i * stride, false));
    return types;
  }
  return null;
}

export type AppCheck = { errors: string[]; version?: string; build?: string };

/**
 * Checks an unpacked Harness.app before it's published: the bundle id and build number, an arm64
 * executable that links SwiftUI. The pairing-token check stays in publish-install.sh, which runs it
 * on every artifact.
 */
export function checkApp(app: string, expected: { bundleId: string; buildNumber: string }): AppCheck {
  const errors: string[] = [];
  const plistPath = join(app, "Info.plist");
  if (!existsSync(plistPath)) return { errors: [`${app} has no Info.plist`] };
  const plist = readPlist(plistPath);
  const id = plist.CFBundleIdentifier;
  if (id !== expected.bundleId) errors.push(`CFBundleIdentifier is '${id}', expected '${expected.bundleId}'`);
  const build = plist.CFBundleVersion;
  if (build !== expected.buildNumber) errors.push(`CFBundleVersion is '${build}', expected '${expected.buildNumber}'`);
  const exe = typeof plist.CFBundleExecutable === "string" ? join(app, plist.CFBundleExecutable) : null;
  const binary = exe && existsSync(exe) ? new Uint8Array(readFileSync(exe)) : null;
  if (!binary) errors.push(`the executable ${plist.CFBundleExecutable ?? "(no CFBundleExecutable)"} is missing`);
  else if (!machOCpuTypes(binary)?.includes(CPU_TYPE_ARM64)) errors.push(`${plist.CFBundleExecutable} isn't an arm64 Mach-O executable`);
  if (binary && !Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).includes("/SwiftUI.framework/SwiftUI")) {
    errors.push(`${plist.CFBundleExecutable} doesn't link SwiftUI`);
  }
  return { errors, version: plist.CFBundleShortVersionString, build };
}

function readPlist(path: string): Record<string, any> {
  const r = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]);
  if (r.exitCode !== 0) throw new Error(`can't read ${path}: ${r.stderr.toString().trim()}`);
  return JSON.parse(r.stdout.toString());
}

// ------------------------------------------------------------------ running the builds

const log = (line: string) => console.error(line);

/** Runs a command with its output in ios/build/<name>.log; on failure prints the tail and exits. */
function run(name: string, cmd: string[], cwd = IOS): void {
  mkdirSync(BUILD, { recursive: true });
  const logPath = join(BUILD, `${name}.log`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const output = r.stdout.toString() + r.stderr.toString();
  writeFileSync(logPath, `$ ${cmd.join(" ")}\n${output}`);
  if (r.exitCode !== 0) {
    console.error(output.split("\n").slice(-40).join("\n"));
    console.error(`error: ${cmd[0]} ${cmd[1] ?? ""} failed (exit ${r.exitCode}); full log in ${logPath}`);
    process.exit(1);
  }
}

/** Writes a file only when its text changed, so an unchanged list keeps its mtime (Xcode compares it with the phase's output). */
function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The files the three bundle build phases read, for Xcode's skip check (project.yml, "Bundle highlighter"). */
function writeBundleLists(): void {
  const inputs = bundleInputs(IOS);
  writeIfChanged(join(BUILD, "bundle-highlighter.xcfilelist"), xcfilelist(inputs.highlighter));
  writeIfChanged(join(BUILD, "bundle-editor.xcfilelist"), xcfilelist(inputs.editor));
  writeIfChanged(join(BUILD, "bundle-terminal.xcfilelist"), xcfilelist(inputs.terminal));
}

const XCODEGEN_HASH = join(BUILD, "xcodegen.hash");

/** Runs XcodeGen only when project.yml or the globbed source file list changed since it last ran. */
function xcodegen(): void {
  const hash = xcodegenHash(IOS);
  const plan = planXcodegen({
    projectExists: existsSync(join(IOS, "Harness.xcodeproj/project.pbxproj")),
    lastHash: existsSync(XCODEGEN_HASH) ? readFileSync(XCODEGEN_HASH, "utf8").trim() : null,
    hash,
  });
  if (!plan.run) return log("==> Harness.xcodeproj is current (skipping xcodegen)");
  log(`==> Generating Harness.xcodeproj (xcodegen: ${plan.reason})`);
  run("xcodegen", ["xcodegen", "--spec", join(IOS, "project.yml"), "--project", IOS, "--quiet"]);
  // Hashed again, not `hash`: XcodeGen writes Info.plist and entitlements files into the globbed folders.
  writeIfChanged(XCODEGEN_HASH, xcodegenHash(IOS) + "\n");
}

/** Everything before xcodebuild that a build reuses from earlier ones. */
function prepare(): void {
  writeBundleLists();
  xcodegen();
}

const project = () => ["-project", join(IOS, "Harness.xcodeproj"), "-scheme", "Harness", "-derivedDataPath", DERIVED_DATA];

/** The xcodebuild arguments of the simulator build. */
export function simArgs(optimized = false): string[] {
  return [
    "xcodebuild", ...project(), "-configuration", "Release", "-sdk", "iphonesimulator",
    "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES",
    // Ad-hoc signed, not unsigned: the simulator only grants the Keychain to a signed app (its
    // simulated entitlements), and pairing stores the token there.
    "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO",
    // The debug state probe (Harness/App/DebugProbe.swift) is compiled in for this simulator build
    // only; the device and archive builds never get it.
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) SIM_CHECK",
    // Whole-module optimization of four targets, one after another, is most of a clean build (about 120 s against 40 s).
    ...(optimized ? [] : ["SWIFT_OPTIMIZATION_LEVEL=-Onone", "SWIFT_COMPILATION_MODE=singlefile"]),
    "build",
  ];
}

function sim(optimized: boolean): string {
  prepare();
  log(`==> Building for the simulator (Release settings, ${optimized ? "optimized" : "unoptimized"}, arm64, ad-hoc signed)`);
  run("sim", simArgs(optimized));
  return join(DERIVED_DATA, "Build/Products/Release-iphonesimulator/Harness.app");
}

/** Builds the snapshot tests and the app that hosts them; returns the .xctestrun file xcodebuild test-without-building takes. */
function snapshots(): string {
  prepare();
  log("==> Building the snapshot tests (Debug, arm64, ad-hoc signed)");
  run("snapshots", [
    "xcodebuild", "-project", join(IOS, "Harness.xcodeproj"), "-scheme", "HarnessSnapshots", "-derivedDataPath", SNAPSHOT_DERIVED_DATA,
    "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
    "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "build-for-testing",
  ]);
  const products = join(SNAPSHOT_DERIVED_DATA, "Build/Products");
  const found = new Bun.Glob("*.xctestrun").scanSync({ cwd: products });
  const file = [...found][0];
  if (!file) fail(`no .xctestrun in ${products}`);
  return join(products, file);
}

/** Builds the L4 screen tests and the app that hosts them for any simulator (iPhone and iPad share the products); returns the .xctestrun file. */
function screens(derivedData: string): string {
  prepare();
  log("==> Building the screen tests (Debug, arm64, ad-hoc signed)");
  run("screens", [
    "xcodebuild", "-project", join(IOS, "Harness.xcodeproj"), "-scheme", "HarnessScreens", "-derivedDataPath", derivedData,
    "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
    "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "build-for-testing",
  ]);
  const products = join(derivedData, "Build/Products");
  const file = [...new Bun.Glob("*.xctestrun").scanSync({ cwd: products })][0];
  if (!file) fail(`no .xctestrun in ${products}`);
  return join(products, file);
}

function archive(o: Extract<Options, { command: "archive" }>): string {
  prepare();
  log(`==> Archiving (Release, build ${o.buildNumber})`);
  rmSync(o.archivePath, { recursive: true, force: true });
  run("archive", [
    "xcodebuild", ...project(), "-configuration", "Release", "-destination", "generic/platform=iOS",
    "-archivePath", o.archivePath, "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${TEAM_ID}`, "CODE_SIGN_STYLE=Automatic", `CURRENT_PROJECT_VERSION=${o.buildNumber}`, "archive",
  ]);
  return o.archivePath;
}

function exportArchive(o: Extract<Options, { command: "export" }>): string {
  if (!existsSync(o.archivePath)) fail(`${o.archivePath} doesn't exist; run archive first`);
  const plist = join(IOS, o.method === "dev" ? "ExportOptions.plist" : "ExportOptions-testflight.plist");
  // Signed in with the App Store Connect API key, not the Apple account in Xcode's settings, whose
  // keychain token expires ("Failed to Use Accounts ... missing Xcode-Token").
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, HOME } = process.env;
  const auth = ASC_KEY_ID && ASC_ISSUER_ID
    ? ["-authenticationKeyPath", ASC_KEY_PATH ?? `${HOME}/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8`, "-authenticationKeyID", ASC_KEY_ID, "-authenticationKeyIssuerID", ASC_ISSUER_ID]
    : [];
  if (o.method === "testflight" && !auth.length) fail("export --method testflight needs ASC_KEY_ID and ASC_ISSUER_ID");
  log(o.method === "dev" ? "==> Exporting a development-signed IPA" : "==> Uploading to App Store Connect (TestFlight)");
  rmSync(o.exportPath, { recursive: true, force: true });
  run(`export-${o.method}`, [
    "xcodebuild", "-exportArchive", "-archivePath", o.archivePath, "-exportOptionsPlist", plist,
    "-exportPath", o.exportPath, ...auth, "-allowProvisioningUpdates",
  ]);
  if (o.method === "testflight") return o.exportPath;
  const ipa = join(o.exportPath, "Harness.ipa");
  if (!existsSync(ipa)) fail(`${ipa} was not produced`);
  return ipa;
}

/** The xcodebuild arguments of the device build: Debug, but without SIM_CHECK, so no debug probe. */
export function deviceArgs(): string[] {
  return [
    "xcodebuild", ...project(), "-configuration", "Debug", "-destination", "generic/platform=iOS",
    "-allowProvisioningUpdates", `DEVELOPMENT_TEAM=${TEAM_ID}`, "CODE_SIGN_STYLE=Automatic", "build",
  ];
}

function device(o: Extract<Options, { command: "device" }>): string {
  prepare();
  log(`==> Building Harness (Debug) for ${o.device}`);
  run("device", deviceArgs());
  const app = join(DERIVED_DATA, "Build/Products/Debug-iphoneos/Harness.app");
  const records = join(BUILD, "device-installs.json");
  let recorded: Record<string, { hash: string; url: string }> = {};
  try {
    if (existsSync(records)) recorded = JSON.parse(readFileSync(records, "utf8")) ?? {};
  } catch {} // a damaged record is no record: install again
  const listing = join(BUILD, "device-apps.json");
  rmSync(listing, { force: true });
  const listed = Bun.spawnSync(["xcrun", "devicectl", "device", "info", "apps", "--device", o.device, "--bundle-id", BUNDLE_ID, "--json-output", listing], { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const deviceUrl = listed.exitCode === 0 && existsSync(listing) ? deviceAppUrl(readFileSync(listing, "utf8"), BUNDLE_ID) : null;
  const builtHash = hashApp(app);
  const plan = planDeviceInstall({ installed: recorded[o.device] ?? null, builtHash, deviceUrl });
  if (plan.install) {
    log(`==> Installing on ${o.device} (${plan.reason})`);
    run("device-install", ["xcrun", "devicectl", "device", "install", "app", "--device", o.device, app]);
    rmSync(listing, { force: true });
    Bun.spawnSync(["xcrun", "devicectl", "device", "info", "apps", "--device", o.device, "--bundle-id", BUNDLE_ID, "--json-output", listing], { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const url = existsSync(listing) ? deviceAppUrl(readFileSync(listing, "utf8"), BUNDLE_ID) : null;
    // Without the device's location there's nothing to compare next time, so leave no record.
    const { [o.device]: _old, ...rest } = recorded;
    writeIfChanged(records, JSON.stringify(url ? { ...rest, [o.device]: { hash: builtHash, url } } : rest));
  } else log(`==> ${o.device} already has this build; skipping the install`);
  // --terminate-existing: an unchanged build wasn't reinstalled, which used to restart the app.
  if (o.launch) run("device-launch", ["xcrun", "devicectl", "device", "process", "launch", "--device", o.device, "--terminate-existing", BUNDLE_ID]);
  return app;
}

if (import.meta.main) {
  // xcode-select points at the Command Line Tools on this Mac; use the full Xcode for this process only.
  exportDeveloperDir();
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.command === "verify") {
      const r = checkApp(o.app, o);
      for (const e of r.errors) console.error(`error: ${e}`);
      if (r.errors.length) process.exit(1);
      console.log(`${o.bundleId} ${r.version} (${r.build}), SwiftUI app`);
    } else {
      const out =
        o.command === "sim" ? sim(o.optimized)
        : o.command === "snapshots" ? snapshots()
        : o.command === "screens" ? screens(o.derivedData)
        : o.command === "archive" ? archive(o)
        : o.command === "export" ? exportArchive(o)
        : device(o);
      console.log(out);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
