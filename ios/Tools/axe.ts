// Reading and tapping the simulator's screen through AXe (brew install cameroncooke/axe/axe), for
// dev-sim.ts: the same accessibility-tree approach as mobile/scripts/sim-check.ts, so a dev loop
// knows what's on screen instead of sleeping and hoping.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** AXe's describe-ui JSON → every AXLabel, as it reads on screen (AXe escapes "/" as "\/"). */
export function parseLabels(describeUi: string): string[] {
  return [...describeUi.matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!.replace(/\\\//g, "/"));
}

/**
 * What the screen shows, as far as pairing and links care:
 * - `prompt`: SpringBoard's "Open in “Harness”?" (the first openurl on a fresh simulator asks)
 * - `board`: the app with the board's column chips ("Planning, 3"), so pairing worked
 * - `pairFailed`: the Pair screen's "Couldn't pair" callout
 * - `app`: the app is up (its root element is "Harness"), showing something else
 * - `other`: SpringBoard, the splash, or nothing yet
 */
export type ScreenState = "prompt" | "board" | "pairFailed" | "app" | "other";

const COLUMN_CHIP = /^(Planning|In progress|Blocked|Review|Done), \d+$/;

export function screenState(labels: string[]): ScreenState {
  if (labels.some((l) => l.startsWith("Open in “"))) return "prompt";
  const up = labels[0] === "Harness" && labels.length >= 3;
  if (!up) return "other";
  if (labels.some((l) => l.startsWith("Couldn't pair"))) return "pairFailed";
  if (labels.some((l) => COLUMN_CHIP.test(l))) return "board";
  return "app";
}

/** Labels as one comparable screen, numbers masked so live text ("47s ago") isn't a new screen. */
export function screenKey(labels: string[]): string {
  return labels.join("\n").replace(/\d+/g, "#");
}

/**
 * AXe looks for SimulatorKit under Developer/Library/PrivateFrameworks, which Xcode 27 moved to
 * Contents/SharedFrameworks, so it gets a symlinked Xcode with the framework where it expects it.
 * The same shim sim-check.ts makes (and in the same place, so either one can create it).
 */
export function xcodeShim(developerDir: string): string {
  const real = resolve(developerDir, "..");
  const root = join(homedir(), "Library", "Caches", "harness-sim-check", "xcode-shim");
  const contents = join(root, "Xcode.app", "Contents");
  const dev = join(contents, "Developer");
  if (existsSync(join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"))) return dev;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(dev, "Library", "PrivateFrameworks"), { recursive: true });
  const link = (from: string, to: string) => Bun.spawnSync(["ln", "-s", from, to]);
  for (const e of readdirSync(real)) if (e !== "Developer") link(join(real, e), join(contents, e));
  for (const e of readdirSync(developerDir)) if (e !== "Library") link(join(developerDir, e), join(dev, e));
  for (const e of readdirSync(join(developerDir, "Library"))) if (e !== "PrivateFrameworks") link(join(developerDir, "Library", e), join(dev, "Library", e));
  const priv = join(developerDir, "Library", "PrivateFrameworks");
  if (existsSync(priv)) for (const e of readdirSync(priv)) link(join(priv, e), join(dev, "Library", "PrivateFrameworks", e));
  link(join(real, "SharedFrameworks", "SimulatorKit.framework"), join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"));
  return dev;
}

export const hasAxe = () => Bun.spawnSync(["which", "axe"]).exitCode === 0;

/** An AXe driver for one simulator. */
export function axeFor(udid: string, developerDir: string) {
  let shim = "";
  const run = async (...a: string[]) => {
    shim ||= xcodeShim(developerDir);
    const p = Bun.spawn(["axe", ...a, "--udid", udid], { env: { ...process.env, DEVELOPER_DIR: shim }, stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return code === 0 ? out : "";
  };
  return {
    labels: async () => parseLabels(await run("describe-ui")),
    tap: (label: string) => run("tap", "--label", label),
  };
}
