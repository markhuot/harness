// `bun run testing ios`: L4 on the iPhone and iPad. The screens (testing/ios/ScreenTests) are
// rendered from the shared world and compared with testing/ios/references/<device>/.
//
//   bun run testing ios [--iphone] [--ipad] [--duo] [--only=Class/testName] [--record] [--out=dir]
//
//   --record    write the reference images instead of comparing (the only way they are ever written)
//   --out=dir   also write every rendered screen to <dir>/<device>/<name>.png (a spec's screenshots)
//   --only=T    one class or test, e.g. ScreenTests/testBoard
//
// What it does, in order: `sim disk` (stops when the Mac is short on space), regenerates
// testing/world/world.json, builds the app and the test bundle once for both devices with one
// `xcodebuild build-for-testing` into testing/.build (stamped with a hash of its sources, so an
// unchanged tree reuses the build, and the walkthrough reuses it too), then runs
// `test-without-building` once per device under the simulator lock (`bun run sim with-lock`).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { render as renderWorld, WORLD_JSON } from "./world/generate";

const testing = import.meta.dir;
const root = resolve(testing, "..");
export const BUILD_DIR = join(testing, ".build");
const DERIVED_DATA = join(BUILD_DIR, "dd");
const STAMP = join(BUILD_DIR, "stamp.json");
const PINNED_XCODE = "/Applications/Xcode-27.1.0.app/Contents/Developer";

export interface IosOptions {
  devices: ("iphone" | "ipad" | "duo")[];
  record: boolean;
  out?: string;
  only?: string;
}

export function parseArgs(argv: string[]): IosOptions {
  const devices: IosOptions["devices"] = [];
  let record = false;
  let out: string | undefined;
  let only: string | undefined;
  for (const a of argv) {
    if (a === "--iphone") devices.push("iphone");
    else if (a === "--ipad") devices.push("ipad");
    else if (a === "--duo") devices.push("duo");
    else if (a === "--record") record = true;
    else if (a.startsWith("--out=")) out = resolve(a.slice(6));
    else if (a.startsWith("--only=")) only = a.slice(7);
    else throw new Error(`unknown option ${a}; usage: testing ios [--iphone] [--ipad] [--duo] [--only=Class/testName] [--record] [--out=dir]`);
  }
  if (out === "") throw new Error("--out needs a directory");
  if (only !== undefined && !/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?$/.test(only)) throw new Error(`--only takes Class or Class/testName, got ${only}`);
  return { devices: devices.length ? [...new Set(devices)] : ["iphone", "ipad", "duo"], record, out, only };
}

/** What a build is made of: everything the app and the screen-test bundle compile or bundle. */
const SOURCES = ["ios/Harness", "ios/HarnessKit/Sources", "ios/HarnessKit/Package.swift", "ios/Widgets", "ios/project.yml", "ios/Tools/build.ts", "ios/Tools/build-cache.ts", "ios/Tools/highlighter", "testing/ios/ScreenTests", "shared/src", "editor/src", "terminal/src", "bun.lock"];
const SKIP = /(^|\/)(node_modules|build|\.build|\.swiftpm|References|references)(\/|$)|\.xcodeproj|\.test\.tsx?$|Info\.plist$/;

function* files(path: string): Generator<string> {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path).sort()) {
    const p = join(path, name);
    if (!SKIP.test(relative(root, p))) yield* files(p);
  }
}

/** A hash of the sources of the build: when it matches the stamp, the build products are current. */
export function sourceHash(): string {
  const h = createHash("sha256");
  for (const dir of SOURCES) for (const f of files(join(root, dir))) h.update(`\0${relative(root, f)}\0`).update(readFileSync(f));
  return h.digest("hex");
}

interface Stamp {
  hash: string;
  xctestrun: string;
}

/** The current build's .xctestrun, if its stamp matches the sources and the products are still there. */
export function currentBuild(hash: string, stampPath = STAMP): string | null {
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as Stamp;
    return stamp.hash === hash && existsSync(stamp.xctestrun) ? stamp.xctestrun : null;
  } catch {
    return null;
  }
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), DEVELOPER_DIR: process.env.DEVELOPER_DIR || PINNED_XCODE, ...extra };
}

async function run(cmd: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd: root, env: env(extra), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** The failures worth reading from xcodebuild's output. */
export function failureLines(output: string): string[] {
  return output.split("\n").filter((l) => /error:|\.(actual|diff)\.png|reference: |If the change is intended|XCTAssert|failed \(/.test(l));
}

/**
 * The one build-for-testing both L4 iOS and the walkthrough run from: regenerates world.json, then
 * builds the app and the test bundle for both devices unless the sources still match the stamp.
 * Returns the .xctestrun and whether it was built or reused, or the message of what stopped it.
 */
export async function ensureBuild(): Promise<{ xctestrun: string; how: "built" | "reused" } | string> {
  // The world the screens render is the one in TypeScript, as of now.
  writeFileSync(WORLD_JSON, renderWorld());

  mkdirSync(BUILD_DIR, { recursive: true });
  const hash = sourceHash();
  let xctestrun = currentBuild(hash);
  let how: "built" | "reused" = "reused";
  if (!xctestrun) {
    const build = await run(["bun", "ios/Tools/build.ts", "screens", "--derived-data", DERIVED_DATA]);
    if (build.code !== 0) {
      return `✗ ios: the build failed\n${build.err.split("\n").slice(-40).join("\n")}`;
    }
    xctestrun = build.out.trim().split("\n").pop()!;
    writeFileSync(STAMP, JSON.stringify({ hash, xctestrun } satisfies Stamp));
    how = "built";
  }
  return { xctestrun, how };
}

export async function ios(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const started = performance.now();
  const lap = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

  const disk = await run(["bun", "ios/Tools/sim.ts", "disk"]);
  if (disk.code !== 0) {
    console.error(`✗ ios: not enough disk for a simulator build. ${disk.out.trim()}\n${disk.err.trim()}`);
    return 1;
  }
  if (!existsSync(join(env().DEVELOPER_DIR!, "Platforms/iPhoneSimulator.platform"))) {
    console.error(`✗ ios: Xcode 27.1 isn't at ${env().DEVELOPER_DIR}; this suite runs on the iOS 27.0 runtime only (CLAUDE.md → Simulators). Don't install another.`);
    return 1;
  }

  const built = await ensureBuild();
  if (typeof built === "string") {
    console.error(built);
    return 1;
  }
  const { xctestrun } = built;
  console.log(`✓ ios build ${built.how} [${lap()}]`);

  const failures = mkdtempSync(join(tmpdir(), "harness-screens-"));
  let failed = false;
  for (const device of o.devices) {
    const t0 = performance.now();
    const testEnv: Record<string, string> = { TEST_RUNNER_HARNESS_FAILURES: failures };
    if (o.record) testEnv.TEST_RUNNER_HARNESS_RECORD = "1";
    if (o.out) testEnv.TEST_RUNNER_HARNESS_OUT = o.out;
    const only = o.only ? ` -only-testing:HarnessScreenTests/${o.only}` : "";
    const script = `exec xcodebuild test-without-building -xctestrun '${xctestrun}' -destination "id=$SIM_UDID"${only}`;
    const r = await run(["bun", "ios/Tools/sim.ts", "with-lock", ...(device === "ipad" ? ["--ipad"] : device === "duo" ? ["--duo"] : []), "--", "sh", "-c", script], testEnv);
    const output = r.out + r.err;
    writeFileSync(join(BUILD_DIR, `test-${device}.log`), output);
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    const tests = output.match(/Executed (\d+) tests?, with (\d+) failures?/)?.slice(1).map(Number);
    if (r.code !== 0) {
      failed = true;
      console.log(`✗ ios ${device} [${seconds}s]\n${failureLines(output).join("\n") || output.split("\n").slice(-40).join("\n")}\n  full log: testing/.build/test-${device}.log`);
    } else console.log(`✓ ios ${device}: ${tests?.[0] ?? "?"} tests ${o.record ? "recorded" : "match their references"} [${seconds}s]`);
  }
  console.log(`ios ${failed ? "failed" : "passes"} [${lap()}]`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await ios(process.argv.slice(2)));
