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
//   bun ios/Tools/build.ts publish-beta [--no-deploy]  the install page's native beta: archive --beta
//                                                      (build number from the clock), export, verify,
//                                                      copy to mobile/Install/HarnessBeta.ipa, regenerate
//                                                      the page and deploy it to Vercel
//
// archive and export take --archive-path; export takes --export-path. mobile/Tools/publish-install.sh
// --ios-app=native runs archive, export and verify. --beta (archive, export --method dev, verify
// --kind native) is the Beta configuration: a Release build as "Harness Beta" (com.markhuot.harness.dev),
// which installs beside the main app.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BETA_BUNDLE_ID, BETA_IPA, BETA_MANIFEST, BETA_TITLE, type ReleaseInfo } from "../../mobile/Tools/install-page";
import { checkDisk } from "../../mobile/Tools/sim";

export const IOS = resolve(import.meta.dir, "..");
export const BUILD = join(IOS, "build");
export const DERIVED_DATA = join(BUILD, "dd");
export const TEAM_ID = "47P4ZSALX4";
export const DEV_BUNDLE_ID = "com.markhuot.harness.dev";

export type Method = "dev" | "testflight";
export type Kind = "native" | "rn";
export type Options =
  | { command: "sim" }
  | { command: "archive"; buildNumber: string; archivePath: string; beta: boolean }
  | { command: "export"; method: Method; archivePath: string; exportPath: string; beta: boolean }
  | { command: "device"; device: string; launch: boolean }
  | { command: "verify"; kind: Kind; bundleId: string; buildNumber: string; app: string; displayName?: string }
  | { command: "publish-beta"; deploy: boolean };

export class UsageError extends Error {}

export const INSTALL = resolve(IOS, "../mobile/Install");
export const SITE = "https://harness-install.vercel.app";
const VERCEL_PROJECT = "harness-install";
const defaultArchive = (beta: boolean) => join(BUILD, beta ? "HarnessBeta.xcarchive" : "Harness.xcarchive");
const BOOLEAN_FLAGS = ["launch", "beta", "no-deploy"];

/** An untagged build's number, as publish-install.sh makes it: the UTC minute, `date -u +%Y%m%d%H%M`. */
export function clockBuildNumber(now = new Date()): string {
  return now.toISOString().slice(0, 16).replace(/\D/g, "");
}

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
    sim: [],
    archive: ["build-number", "archive-path", "beta"],
    export: ["method", "archive-path", "export-path", "beta"],
    device: ["device", "launch"],
    verify: ["kind", "bundle-id", "build-number", "beta"],
    "publish-beta": ["no-deploy"],
  };
  if (!command || !(command in allowed)) throw new UsageError(`unknown command ${command ?? "(none)"}; expected ${Object.keys(allowed).join(", ")}`);
  for (const k of flags.keys()) if (!allowed[command]!.includes(k)) throw new UsageError(`${command} doesn't take --${k}`);
  if (command !== "verify" && positional.length) throw new UsageError(`unexpected argument ${positional[0]}`);
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const need = (k: string): string => str(k) ?? fail(`${command} needs --${k}`);
  const beta = flags.get("beta") === true;
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
      return { command, buildNumber: buildNumber(), archivePath: resolve(str("archive-path") ?? defaultArchive(beta)), beta };
    case "export": {
      const method = need("method");
      if (method !== "dev" && method !== "testflight") throw new UsageError(`--method must be dev or testflight, got ${method}`);
      // The beta shares the dev bundle id, which has no App Store Connect record.
      if (beta && method !== "dev") throw new UsageError("--beta exports with --method dev only; the beta never goes to TestFlight");
      return {
        command,
        method,
        archivePath: resolve(str("archive-path") ?? defaultArchive(beta)),
        exportPath: resolve(str("export-path") ?? join(BUILD, beta ? "ipa-beta" : method === "dev" ? "ipa-dev" : "ipa-testflight")),
        beta,
      };
    }
    case "device":
      return { command, device: need("device"), launch: flags.get("launch") === true };
    case "publish-beta":
      return { command, deploy: flags.get("no-deploy") !== true };
    default: {
      const kind = need("kind");
      if (kind !== "native" && kind !== "rn") throw new UsageError(`--kind must be native or rn, got ${kind}`);
      if (positional.length !== 1) throw new UsageError("verify needs exactly one Harness.app path");
      const common = { command: "verify" as const, kind: kind as Kind, buildNumber: buildNumber(), app: resolve(positional[0]!) };
      if (!beta) return { ...common, bundleId: need("bundle-id") };
      if (kind !== "native") throw new UsageError("--beta is the native app; verify it with --kind native");
      const id = str("bundle-id");
      if (id !== undefined && id !== BETA_BUNDLE_ID) throw new UsageError(`--beta checks for ${BETA_BUNDLE_ID}, not --bundle-id ${id}`);
      return { ...common, bundleId: BETA_BUNDLE_ID, displayName: BETA_TITLE };
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
export function checkApp(app: string, expected: { kind: Kind; bundleId: string; buildNumber: string; displayName?: string }): AppCheck {
  const errors: string[] = [];
  const plistPath = join(app, "Info.plist");
  if (!existsSync(plistPath)) return { errors: [`${app} has no Info.plist`] };
  const plist = readPlist(plistPath);
  const id = plist.CFBundleIdentifier;
  if (id !== expected.bundleId) errors.push(`CFBundleIdentifier is '${id}', expected '${expected.bundleId}'`);
  const build = plist.CFBundleVersion;
  if (build !== expected.buildNumber) errors.push(`CFBundleVersion is '${build}', expected '${expected.buildNumber}'`);
  if (expected.displayName !== undefined && plist.CFBundleDisplayName !== expected.displayName) {
    errors.push(`CFBundleDisplayName is '${plist.CFBundleDisplayName}', expected '${expected.displayName}'`);
  }
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
  const config = o.beta ? "Beta" : "Release";
  log(`==> Archiving (${config}, build ${o.buildNumber})`);
  rmSync(o.archivePath, { recursive: true, force: true });
  run(o.beta ? "archive-beta" : "archive", [
    "xcodebuild", ...project(), "-configuration", config, "-destination", "generic/platform=iOS",
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
  run(o.beta ? "export-beta" : `export-${o.method}`, [
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

// ------------------------------------------------------------------ the install page's beta

/** The pairing tokens this Mac can read (as publish-install.sh's check_no_token finds them). */
export function readTokens(env = process.env): string[] {
  const files = [env.HARNESS_HOME && join(env.HARNESS_HOME, "token"), join(homedir(), ".harness", "token")];
  const tokens = files.flatMap((f) => (f && existsSync(f) ? [readFileSync(f, "utf8").replace(/\s/g, "")] : []));
  return [...new Set(tokens.filter((t) => t.length >= 8))];
}

/** The first file under `dir` that contains one of `tokens`, or null. */
export function findToken(dir: string, tokens: string[]): string | null {
  if (!tokens.length) return null;
  const needles = tokens.map((t) => Buffer.from(t));
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const bytes = readFileSync(file);
    if (needles.some((n) => bytes.includes(n))) return file;
  }
  return null;
}

/** The saved page data with this beta on it: the IPA is served from the site, next to the page. */
export function withBetaBuild(saved: ReleaseInfo, app: { version: string; build: string }, bytes: number, now = new Date()): ReleaseInfo {
  return { ...saved, iosBeta: { url: `${saved.site}/${BETA_IPA}`, version: app.version, build: app.build, bytes, builtAt: now.toISOString().slice(0, 10) } };
}

/** Checks a deployed file: 200, the expected content type, and (for the IPA) the local file's length. */
export async function checkServed(url: string, contentType: RegExp, bytes?: number, fetcher: typeof fetch = fetch): Promise<string[]> {
  const r = await fetcher(url, { method: "HEAD" });
  const errors: string[] = [];
  if (r.status !== 200) errors.push(`${url} returned ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  if (!contentType.test(type)) errors.push(`${url} is served as '${type}'`);
  const length = r.headers.get("content-length");
  if (bytes !== undefined && length !== String(bytes)) errors.push(`${url} is ${length ?? "?"} bytes, expected ${bytes}`);
  return errors;
}

async function publishBeta(o: Extract<Options, { command: "publish-beta" }>): Promise<string> {
  try {
    checkDisk();
  } catch (e) {
    fail((e as Error).message);
  }
  const saved = join(INSTALL, "release.json");
  if (!existsSync(saved)) fail(`${saved} is missing; it's written by mobile/Tools/install-page.ts`);
  const buildNumber = clockBuildNumber();
  const archivePath = archive({ command: "archive", buildNumber, archivePath: defaultArchive(true), beta: true });
  const ipa = exportArchive({ command: "export", method: "dev", archivePath, exportPath: join(BUILD, "ipa-beta"), beta: true });

  log("==> Verifying the IPA");
  const check = join(BUILD, "ipa-beta-check");
  rmSync(check, { recursive: true, force: true });
  run("unzip-beta", ["unzip", "-q", ipa, "-d", check]);
  const r = checkApp(join(check, "Payload", "Harness.app"), { kind: "native", bundleId: BETA_BUNDLE_ID, buildNumber, displayName: BETA_TITLE });
  if (r.errors.length) fail(r.errors.join("; "));
  const tokens = readTokens();
  const leak = findToken(check, tokens);
  if (leak) fail(`${leak} contains a pairing token; refusing to publish`);
  rmSync(check, { recursive: true, force: true });

  log(`==> Writing ${BETA_IPA} and the install page`);
  const dest = join(INSTALL, BETA_IPA);
  copyFileSync(ipa, dest);
  const bytes = statSync(dest).size;
  const info = withBetaBuild(JSON.parse(readFileSync(saved, "utf8")) as ReleaseInfo, { version: r.version ?? "1.0.0", build: buildNumber }, bytes);
  writeFileSync(saved, `${JSON.stringify(info, null, 2)}\n`);
  run("install-page", ["bun", resolve(IOS, "../mobile/Tools/install-page.ts"), "--from-json", saved]);
  const pageLeak = findToken(INSTALL, tokens);
  if (pageLeak) fail(`${pageLeak} contains a pairing token; refusing to publish`);
  rmSync(archivePath, { recursive: true, force: true });
  rmSync(join(BUILD, "ipa-beta"), { recursive: true, force: true });
  if (!o.deploy) return dest;

  // Install/.vercel is gitignored, so a fresh worktree isn't linked to the project yet.
  if (!existsSync(join(INSTALL, ".vercel", "project.json"))) {
    log(`==> Linking mobile/Install to the Vercel project ${VERCEL_PROJECT}`);
    run("vercel-link", ["vercel", "link", "--yes", "--project", VERCEL_PROJECT], INSTALL);
    rmSync(join(INSTALL, ".env.local"), { force: true }); // the page needs no env vars
  }
  log("==> Deploying the install page (vercel deploy --prod)");
  run("vercel-deploy", ["vercel", "deploy", "--prod", "--yes"], INSTALL);
  log("==> Checking the published site");
  const site = info.site;
  const errors = [
    ...(await checkServed(`${site}/${BETA_MANIFEST}`, /^(text|application)\/xml/)),
    ...(await checkServed(`${site}/${BETA_IPA}`, /^application\/octet-stream/, bytes)),
  ];
  if (errors.length) fail(errors.join("; "));
  return `${site} (${BETA_TITLE} ${info.iosBeta!.version} (${buildNumber}), ${bytes} bytes)`;
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
      console.log(`${o.displayName ? `${o.displayName}, ` : ""}${o.bundleId} ${r.version} (${r.build}), ${o.kind === "native" ? "SwiftUI app, no JS bundle" : "main.jsbundle embedded"}`);
    } else {
      const out =
        o.command === "sim" ? sim()
        : o.command === "archive" ? archive(o)
        : o.command === "export" ? exportArchive(o)
        : o.command === "publish-beta" ? await publishBeta(o)
        : device(o);
      console.log(out);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
