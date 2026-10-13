// Runs the hosted snapshot tests (ios/HarnessSnapshotTests, ARCHITECTURE.md § Snapshot tests):
// the app's screens rendered in-process from fixture models and compared with the reference PNGs.
// No daemon, install, pairing or accessibility polling: a build, then about a second per screen.
//
//   bun run sim snapshots [--iphone] [--ipad] [--only=Class/testName] [--record] [--out=dir]
//
//   (no device flag)  both: the iPhone, then the iPad (harness-shared, harness-shared-ipad)
//   --record          write the reference images (ios/HarnessSnapshotTests/References/<device>/) instead of comparing
//   --out=dir         also write every rendered screen there as <device>/<name>-light.png and -dark.png:
//                     a spec's Status screenshots, with no daemon
//   --only=Test       one test, e.g. ScreenSnapshotTests/testBoard
//
// A mismatch writes <name>.actual.png and <name>.diff.png (red where pixels differ) to
// ios/build/snapshots/failures/<device>/ and prints their paths. Each device runs under its own
// simulator lock (sim.ts with-lock), after `bun run sim disk` says there's room.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { IOS } from "./build";
import { DEVELOPER_DIR, SHARED_DEVICE, SHARED_IPAD_DEVICE, checkDisk, ensureDevice, withLock, type DeviceKind } from "./sim";

export interface SnapshotOptions {
  devices: DeviceKind[];
  record: boolean;
  out?: string;
  only?: string;
}

export function parseSnapshotArgs(argv: string[]): SnapshotOptions {
  const devices: DeviceKind[] = [];
  let record = false;
  let out: string | undefined;
  let only: string | undefined;
  for (const a of argv) {
    if (a === "--iphone") devices.push("iphone");
    else if (a === "--ipad") devices.push("ipad");
    else if (a === "--record") record = true;
    else if (a.startsWith("--out=")) out = resolve(a.slice(6));
    else if (a.startsWith("--only=")) only = a.slice(7);
    else throw new Error(`unknown option ${a}; usage: snapshots [--iphone] [--ipad] [--only=Class/testName] [--record] [--out=dir]`);
  }
  if (out === "") throw new Error("--out needs a directory");
  if (only !== undefined && !/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?$/.test(only)) throw new Error(`--only takes Class or Class/testName, got ${only}`);
  return { devices: devices.length ? [...new Set(devices)] : ["iphone", "ipad"], record, out, only };
}

/** The xcodebuild test-without-building command for one simulator. Test-process variables need the TEST_RUNNER_ prefix. */
export function testCommand(o: SnapshotOptions, xctestrun: string, udid: string, kind: DeviceKind): { cmd: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (o.record) env.TEST_RUNNER_SNAPSHOT_RECORD = "1";
  if (o.out) env.TEST_RUNNER_SNAPSHOT_OUT = join(o.out, kind);
  const cmd = ["xcodebuild", "test-without-building", "-xctestrun", xctestrun, "-destination", `id=${udid}`];
  if (o.only) cmd.push(`-only-testing:HarnessSnapshotTests/${o.only}`);
  return { cmd, env };
}

/** The failures worth reading from xcodebuild's output: our assertion messages and the build's own errors. */
export function failureLines(output: string): string[] {
  return output.split("\n").filter((l) => /error:|\.(actual|diff)\.png|reference: |If the change is intended/.test(l));
}

if (import.meta.main) {
  try {
    const o = parseSnapshotArgs(process.argv.slice(2));
    checkDisk();
    process.env.DEVELOPER_DIR ??= DEVELOPER_DIR;
    const build = Bun.spawnSync(["bun", join(IOS, "Tools/build.ts"), "snapshots"], { stdout: "pipe", stderr: "inherit", env: process.env });
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
    const xctestrun = build.stdout.toString().trim().split("\n").pop()!;
    if (!existsSync(xctestrun)) throw new Error(`no test run file at ${xctestrun}`);
    let failed = false;
    for (const kind of o.devices) {
      const name = kind === "ipad" ? SHARED_IPAD_DEVICE : SHARED_DEVICE;
      await withLock(name, async () => {
        const udid = await ensureDevice(name, { kind });
        const { cmd, env } = testCommand(o, xctestrun, udid, kind);
        if (env.TEST_RUNNER_SNAPSHOT_OUT) mkdirSync(env.TEST_RUNNER_SNAPSHOT_OUT, { recursive: true });
        console.error(`==> ${o.record ? "Recording" : "Checking"} snapshots on ${name}`);
        const r = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
        const output = r.stdout.toString() + r.stderr.toString();
        await Bun.write(join(IOS, "build", `snapshots-${kind}.log`), output);
        if (r.exitCode !== 0) {
          failed = true;
          console.error(failureLines(output).join("\n") || output.split("\n").slice(-40).join("\n"));
          console.error(`${name}: failed; full log in ios/build/snapshots-${kind}.log`);
        } else console.error(`${name}: ${o.record ? "recorded" : "all snapshots match"}${o.out ? `; images in ${join(o.out, kind)}` : ""}`);
      }, { onWait: () => console.error(`waiting for the "${name}" simulator…`) });
    }
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
