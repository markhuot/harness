// Builds the native iPhone/iPad app (ios/). Every build regenerates Harness.xcodeproj with
// XcodeGen first, builds into ios/build/dd (ARCHITECTURE.md § Disk budget) and logs xcodebuild's
// output to ios/build/<command>.log, printing only its tail when it fails. Progress goes to stderr,
// and the path of what was built is the one line on stdout.
//
//   bun ios/Tools/build.ts sim                         Release, iphonesimulator, ad-hoc signed, arm64
//   bun ios/Tools/build.ts archive --build-number N    Release archive for devices (CFBundleVersion N),
//                                                      signed automatically with team 47P4ZSALX4
//   bun ios/Tools/build.ts export --method dev|testflight
//                                                      dev: development-signed IPA (ExportOptions.plist);
//                                                      testflight: upload to App Store Connect
//                                                      (ExportOptions-testflight.plist), signed in with the
//                                                      ASC API key when ASC_KEY_ID and ASC_ISSUER_ID are set
//   bun ios/Tools/build.ts device --device <name|udid> [--launch]
//                                                      Debug build ("Harness Dev") installed with devicectl
//   bun ios/Tools/build.ts verify --kind native|rn --bundle-id ID --build-number N <Harness.app>
//                                                      checks an unpacked app before it's published
//
// archive and export take --archive-path; export takes --export-path. mobile/Tools/publish-install.sh
// --ios-app=native runs archive, export and verify.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const IOS = resolve(import.meta.dir, "..");
export const BUILD = join(IOS, "build");
export const DERIVED_DATA = join(BUILD, "dd");
export const TEAM_ID = "47P4ZSALX4";
export const DEV_BUNDLE_ID = "com.markhuot.harness.dev";

export type Method = "dev" | "testflight";
export type Kind = "native" | "rn";
export type Options =
  | { command: "sim" }
  | { command: "archive"; buildNumber: string; archivePath: string }
  | { command: "export"; method: Method; archivePath: string; exportPath: string }
  | { command: "device"; device: string; launch: boolean }
  | { command: "verify"; kind: Kind; bundleId: string; buildNumber: string; app: string };

export class UsageError extends Error {}

const defaultArchive = join(BUILD, "Harness.xcarchive");

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
    else if (a === "--launch") flags.set("launch", true);
    else {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${a} needs a value`);
      flags.set(a.slice(2), value);
    }
  }
  const allowed: Record<string, string[]> = {
    sim: [],
    archive: ["build-number", "archive-path"],
    export: ["method", "archive-path", "export-path"],
    device: ["device", "launch"],
    verify: ["kind", "bundle-id", "build-number"],
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
      return { command };
    case "archive":
      return { command, buildNumber: buildNumber(), archivePath: resolve(str("archive-path") ?? defaultArchive) };
    case "export": {
      const method = need("method");
      if (method !== "dev" && method !== "testflight") throw new UsageError(`--method must be dev or testflight, got ${method}`);
      return {
        command,
        method,
        archivePath: resolve(str("archive-path") ?? defaultArchive),
        exportPath: resolve(str("export-path") ?? join(BUILD, method === "dev" ? "ipa-dev" : "ipa-testflight")),
      };
    }
    case "device":
      return { command, device: need("device"), launch: flags.get("launch") === true };
    default: {
      const kind = need("kind");
      if (kind !== "native" && kind !== "rn") throw new UsageError(`--kind must be native or rn, got ${kind}`);
      if (positional.length !== 1) throw new UsageError("verify needs exactly one Harness.app path");
      return { command: "verify", kind, bundleId: need("bundle-id"), buildNumber: buildNumber(), app: resolve(positional[0]!) };
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
 * executable, and that it's the app it claims to be. A native build is SwiftUI with no JS bundle
 * or React frameworks (so an RN archive can't ship under --ios-app=native); an RN build must embed
 * main.jsbundle, or it would try to load from Metro. The pairing-token check stays in
 * publish-install.sh, which runs it on every artifact.
 */
export function checkApp(app: string, expected: { kind: Kind; bundleId: string; buildNumber: string }): AppCheck {
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
  const jsBundle = join(app, "main.jsbundle");
  const hasJsBundle = existsSync(jsBundle) && statSync(jsBundle).size > 0;
  if (expected.kind === "rn") {
    if (!hasJsBundle) errors.push("main.jsbundle is not embedded; this build would try to load from Metro");
  } else {
    if (existsSync(jsBundle)) errors.push("main.jsbundle is embedded; this is the React Native app, not the native one");
    for (const fw of ["React.framework", "hermes.framework", "hermesvm.framework"]) {
      if (existsSync(join(app, "Frameworks", fw))) errors.push(`Frameworks/${fw} is embedded; this is the React Native app, not the native one`);
    }
    if (binary && !Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).includes("/SwiftUI.framework/SwiftUI")) {
      errors.push(`${plist.CFBundleExecutable} doesn't link SwiftUI; this isn't the native app`);
    }
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

function xcodegen(): void {
  log("==> Generating Harness.xcodeproj (xcodegen)");
  run("xcodegen", ["xcodegen", "--spec", join(IOS, "project.yml"), "--project", IOS, "--quiet"]);
}

const project = () => ["-project", join(IOS, "Harness.xcodeproj"), "-scheme", "Harness", "-derivedDataPath", DERIVED_DATA];

function sim(): string {
  xcodegen();
  log("==> Building for the simulator (Release, arm64, ad-hoc signed)");
  run("sim", [
    "xcodebuild", ...project(), "-configuration", "Release", "-sdk", "iphonesimulator",
    "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES",
    // Ad-hoc signed, not unsigned: the simulator only grants the Keychain to a signed app (its
    // simulated entitlements), and pairing stores the token there.
    "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "build",
  ]);
  return join(DERIVED_DATA, "Build/Products/Release-iphonesimulator/Harness.app");
}

function archive(o: Extract<Options, { command: "archive" }>): string {
  xcodegen();
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

function device(o: Extract<Options, { command: "device" }>): string {
  xcodegen();
  log(`==> Building Harness Dev (Debug) for ${o.device}`);
  run("device", [
    "xcodebuild", ...project(), "-configuration", "Debug", "-destination", "generic/platform=iOS",
    "-allowProvisioningUpdates", `DEVELOPMENT_TEAM=${TEAM_ID}`, "CODE_SIGN_STYLE=Automatic", "build",
  ]);
  const app = join(DERIVED_DATA, "Build/Products/Debug-iphoneos/Harness.app");
  log(`==> Installing on ${o.device}`);
  run("device-install", ["xcrun", "devicectl", "device", "install", "app", "--device", o.device, app]);
  if (o.launch) run("device-launch", ["xcrun", "devicectl", "device", "process", "launch", "--device", o.device, DEV_BUNDLE_ID]);
  return app;
}

if (import.meta.main) {
  // xcode-select points at the Command Line Tools on this Mac; use the full Xcode for this process only.
  const xcode = "/Applications/Xcode-27.0.0.app/Contents/Developer";
  if (!process.env.DEVELOPER_DIR && existsSync(xcode)) process.env.DEVELOPER_DIR = xcode;
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.command === "verify") {
      const r = checkApp(o.app, o);
      for (const e of r.errors) console.error(`error: ${e}`);
      if (r.errors.length) process.exit(1);
      console.log(`${o.bundleId} ${r.version} (${r.build}), ${o.kind === "native" ? "SwiftUI app, no JS bundle" : "main.jsbundle embedded"}`);
    } else {
      const out = o.command === "sim" ? sim() : o.command === "archive" ? archive(o) : o.command === "export" ? exportArchive(o) : device(o);
      console.log(out);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
