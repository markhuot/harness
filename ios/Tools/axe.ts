// Reading and tapping the simulator's screen through AXe (brew install cameroncooke/axe/axe), for
// dev-sim.ts: the same accessibility-tree approach as sim-check.ts, so a dev loop
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
    /** Every element on screen, flattened: its label, value and accessibilityIdentifier. */
    nodes: async (): Promise<AXElement[]> => flattenTree(await run("describe-ui")),
    tap: (label: string) => run("tap", "--label", label),
    /** A tap on the element with this accessibilityIdentifier: stable where a label carries live numbers. */
    tapId: (id: string) => run("tap", "--id", id),
    /** Types into the focused field. */
    type: (text: string) => run("type", text),
    /** A key chord: modifiers and key are HID codes (⌘ is 227, K is 14, P is 19). */
    keyCombo: (modifier: number, key: number) => run("key-combo", "--modifiers", String(modifier), "--key", String(key)),
    swipe: (x1: number, y1: number, x2: number, y2: number, seconds = 0.6) =>
      run("swipe", "--start-x", String(x1), "--start-y", String(y1), "--end-x", String(x2), "--end-y", String(y2), "--duration", String(seconds)),
    /** A tap at a point, for what has no label of its own (a link inside a paragraph, a sheet's Cancel). */
    tapAt: (x: number, y: number) => run("tap", "-x", String(Math.round(x)), "-y", String(Math.round(y))),
    /** A press held for a moment: a Toggle ignores the instantaneous tap `tap` sends. */
    press: (x: number, y: number) => run("touch", "-x", String(Math.round(x)), "-y", String(Math.round(y)), "--down", "--up", "--delay", "0.15"),
  };
}

export interface AXElement { label: string | null; value: string | null; id: string | null; frame: { x: number; y: number; width: number; height: number } | null }

/** AXe's describe-ui JSON → every element, flattened depth first (empty when AXe printed nothing). */
export function flattenTree(describeUi: string): AXElement[] {
  const start = describeUi.indexOf("[");
  if (start < 0) return [];
  const out: AXElement[] = [];
  const visit = (n: { AXLabel?: string | null; AXValue?: string | null; AXUniqueId?: string | null; frame?: { x: number; y: number; width: number; height: number } | null; children?: unknown[] }) => {
    out.push({ label: n.AXLabel?.replace(/\\\//g, "/") ?? null, value: n.AXValue ?? null, id: n.AXUniqueId ?? null, frame: n.frame ?? null });
    for (const c of n.children ?? []) visit(c as typeof n);
  };
  for (const n of JSON.parse(describeUi.slice(start)) as Parameters<typeof visit>[0][]) visit(n);
  return out;
}
