// An iPhone or iPad simulator from the shared pool, driven for the walkthrough: install the app
// from the one build-for-testing, pair it by link, read the screen through AXe, take screenshots.
// Nothing here takes a lock: the caller already holds it (`bun run sim with-lock`), and the
// simulator is left booted for the next run.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { until } from "./wait";

export const BUNDLE_ID = "com.markhuot.harness";
export const PINNED_XCODE = "/Applications/Xcode-27.0.0.app/Contents/Developer";

/** AXe's describe-ui JSON → every AXLabel, as it reads on screen (AXe escapes "/" as "\/"). */
export function parseLabels(describeUi: string): string[] {
  return [...describeUi.matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!.replace(/\\\//g, "/"));
}

const COLUMN_CHIP = /^(Planning|In progress|Blocked|Review|Done), \d+$/;

/** What the screen shows: SpringBoard's open-link prompt, the board (its column chips), or something else. */
export function screenState(labels: string[]): "prompt" | "board" | "other" {
  if (labels.some((l) => l.startsWith("Open in “"))) return "prompt";
  if (labels.some((l) => COLUMN_CHIP.test(l))) return "board";
  return "other";
}

/** The count a column chip reports ("Review, 2" → 2), or undefined when the chip isn't on screen. */
export function columnCount(labels: string[], status: string): number | undefined {
  const hit = labels.find((l) => l.startsWith(`${status}, `) && COLUMN_CHIP.test(l));
  return hit ? Number(hit.slice(status.length + 2)) : undefined;
}

/** AXe looks for SimulatorKit under Developer/Library/PrivateFrameworks, which Xcode 27 moved; it gets a symlinked Xcode that has it (the same shim and place sim-check uses). */
function xcodeShim(developerDir: string): string {
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

async function run(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || PINNED_XCODE, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

export interface Phone {
  name: string;
  udid: string;
  /** Install the app fresh: no saved servers, no keychain, no notification prompt. */
  install(app: string): Promise<void>;
  /** Open the pair link and tap through SpringBoard's open-link prompt if it appears; resolves on the board. */
  pair(link: string): Promise<string[]>;
  /** Every accessibility label on screen. */
  labels(): Promise<string[]>;
  /** Wait until `match` is true of the screen's labels; fails naming `what` and the labels last seen. */
  see(what: string, match: (labels: string[]) => boolean, ms?: number): Promise<string[]>;
  tap(label: string): Promise<void>;
  launch(): Promise<void>;
  uninstall(): Promise<void>;
  terminate(): Promise<void>;
  screenshot(path: string): Promise<void>;
}

export function phone(name: string, udid: string): Phone {
  const developerDir = process.env.DEVELOPER_DIR || PINNED_XCODE;
  const simctl = async (...a: string[]) => {
    const r = await run(["xcrun", "simctl", ...a]);
    if (r.code !== 0) throw new Error(`simctl ${a.join(" ")} failed: ${r.err.trim() || r.out.trim()}`);
    return r.out;
  };
  const axe = async (...a: string[]) => {
    const r = await run(["axe", ...a, "--udid", udid], { DEVELOPER_DIR: xcodeShim(developerDir) });
    return r.code === 0 ? r.out : "";
  };
  const labels = async () => parseLabels(await axe("describe-ui"));
  const see = async (what: string, match: (l: string[]) => boolean, ms = 30_000) => {
    let last: string[] = [];
    try {
      return await until(`${name}: ${what}`, ms, async () => {
        last = await labels();
        return match(last) ? last : undefined;
      });
    } catch (e) {
      throw new Error(`${(e as Error).message.replace(/last seen: .*$/, "")}on screen: ${last.slice(0, 25).join(" | ") || "(nothing)"}`);
    }
  };
  return {
    name,
    udid,
    labels,
    see,
    async install(app) {
      await run(["xcrun", "simctl", "terminate", udid, BUNDLE_ID]);
      await run(["xcrun", "simctl", "uninstall", udid, BUNDLE_ID]);
      await run(["xcrun", "simctl", "keychain", udid, "reset"]);
      await simctl("install", udid, app);
      // The app asks for notification permission at launch and that alert would cover the screens under test.
      await simctl("spawn", udid, "defaults", "write", BUNDLE_ID, "HarnessSkipNotificationPrompt", "-bool", "YES");
    },
    async pair(link) {
      await simctl("openurl", udid, link);
      let tapped = false;
      return see("the board after pairing", (l) => {
        if (!tapped && screenState(l) === "prompt") {
          tapped = true;
          void axe("tap", "--label", "Open");
        }
        return screenState(l) === "board";
      });
    },
    async tap(label) {
      await axe("tap", "--label", label);
    },
    async launch() {
      await simctl("launch", udid, BUNDLE_ID);
    },
    async uninstall() {
      await run(["xcrun", "simctl", "uninstall", udid, BUNDLE_ID]);
    },
    async terminate() {
      await run(["xcrun", "simctl", "terminate", udid, BUNDLE_ID]);
    },
    async screenshot(path) {
      mkdirSync(dirname(path), { recursive: true });
      await simctl("io", udid, "screenshot", path);
    },
  };
}

/** The app the single build-for-testing produced (the screens bundle's host). */
export function builtApp(buildDir: string): string {
  return join(buildDir, "dd", "Build", "Products", "Debug-iphonesimulator", "Harness.app");
}
