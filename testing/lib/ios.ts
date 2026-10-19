// An iPhone or iPad simulator from the shared pool, driven for the walkthrough: install the app
// from the one build-for-testing, pair it by link, read the screen through AXe, take screenshots.
// Nothing here takes a lock: the caller already holds it (`bun run sim with-lock`), and the
// simulator is left booted for the next run.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { until } from "./wait";

export const BUNDLE_ID = "com.markhuot.harness";
export const PINNED_XCODE = "/Applications/Xcode-27.1.0.app/Contents/Developer";

/** AXe's describe-ui JSON → every AXLabel, as it reads on screen (AXe escapes "/" as "\/"). */
export function parseLabels(describeUi: string): string[] {
  return [...describeUi.matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!.replace(/\\\//g, "/"));
}

/** Whether the app's preferences file (as JSON, from `plutil -convert json`) holds a restorable state saved at or after `sinceSeconds` (Unix time): its JSON carries `savedAt` in seconds. */
export function savedAfter(defaultsRead: string, sinceSeconds: number): boolean {
  return [...defaultsRead.matchAll(/savedAt\\*"\s*:\s*([0-9]+(?:\.[0-9]+)?)/g)].some((m) => Number(m[1]) >= sinceSeconds);
}

/**
 * The middle of the part of the element labelled `label` that shows on screen (its AXFrame reads
 * "{{x, y}, {w, h}}"), or null when it isn't: absent, or laid out wholly beyond the screen's frame,
 * like a side-by-side column's header scrolled out of view. A chip half scrolled off the edge is
 * tapped on its visible half, which AXe's own label lookup (the middle of the whole chip) misses.
 * Taps use `--tap-style physical`: under Xcode 27.1 AXe's default tap never lands.
 */
export function labelCenter(describeUi: string, label: string): { x: number; y: number } | null {
  let tree: unknown;
  try {
    tree = JSON.parse(describeUi);
  } catch {
    return null;
  }
  const rect = (frame: unknown) => {
    const n = typeof frame === "string" ? frame.match(/-?\d+(?:\.\d+)?/g)?.map(Number) : undefined;
    return n?.length === 4 ? { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! } : null;
  };
  const screen = rect((Array.isArray(tree) ? (tree[0] as { AXFrame?: unknown } | undefined) : undefined)?.AXFrame);
  const visit = (node: unknown): { x: number; y: number } | null => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = visit(n);
        if (hit) return hit;
      }
      return null;
    }
    if (node === null || typeof node !== "object") return null;
    const o = node as { AXLabel?: unknown; AXFrame?: unknown; children?: unknown };
    const r = o.AXLabel === label ? rect(o.AXFrame) : null;
    if (r) {
      // The visible part of it, so a chip half scrolled off the edge is tapped on its visible half.
      const left = Math.max(r.x, screen?.x ?? r.x);
      const top = Math.max(r.y, screen?.y ?? r.y);
      const right = Math.min(r.x + r.w, screen ? screen.x + screen.w : r.x + r.w);
      const bottom = Math.min(r.y + r.h, screen ? screen.y + screen.h : r.y + r.h);
      if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 };
    }
    return visit(o.children);
  };
  return visit(tree);
}

/** The screen's size in points: the root element's frame in describe-ui's JSON. */
export function screenSize(describeUi: string): { w: number; h: number } | null {
  const n = describeUi.match(/"AXFrame" : "\{\{-?[\d.]+, -?[\d.]+\}, \{([\d.]+), ([\d.]+)\}\}"/);
  return n ? { w: Number(n[1]), h: Number(n[2]) } : null;
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
  see(what: string, match: (labels: string[]) => boolean, ms?: number, minLooks?: number): Promise<string[]>;
  /** Tap the element labelled `label`; with `then`, tap it again (up to three times) until the screen matches, since a tap the simulator drops looks the same as one that worked. */
  tap(label: string, then?: { what: string; match: (labels: string[]) => boolean }): Promise<void>;
  launch(): Promise<void>;
  uninstall(): Promise<void>;
  terminate(): Promise<void>;
  /** Press Home: the app goes to the background, where it saves what it restores on its next launch (what leaving it for the app switcher does first). */
  background(): Promise<void>;
  screenshot(path: string): Promise<void>;
}

export function phone(name: string, udid: string): Phone {
  const developerDir = process.env.DEVELOPER_DIR || PINNED_XCODE;
  const simctl = async (...a: string[]) => {
    const r = await run(["xcrun", "simctl", ...a]);
    if (r.code !== 0) throw new Error(`simctl ${a.join(" ")} failed: ${r.err.trim() || r.out.trim()}`);
    return r.out;
  };
  /** AXe's output, or null when it failed (distinct from a screen with nothing on it). */
  const axe = async (...a: string[]) => {
    const r = await run(["axe", ...a, "--udid", udid], { DEVELOPER_DIR: developerDir });
    return r.code === 0 ? r.out : null;
  };
  /** Taps the element by its point (see labelCenter); one that isn't on screen (a column scrolled out of view) goes to `axe tap`, which brings it in. */
  const tapLabel = async (label: string) => {
    // A screen that just changed (a pager sliding, the iPad's panel opening) reports frames mid-move,
    // so the point is read until two looks 200 ms apart agree. An element in the tree but off the
    // screen (the iPad's side-by-side columns overflow it) is swiped into view first.
    let at: { x: number; y: number } | null = null;
    let swipes = 0;
    for (let look = 0; look < 20; look++) {
      const ui = (await axe("describe-ui")) ?? "";
      const next = labelCenter(ui, label);
      const settled = next !== null && at !== null && next.x === at.x && next.y === at.y;
      at = next;
      if (settled) break;
      if (next === null && swipes < 8 && parseLabels(ui).includes(label)) {
        const size = screenSize(ui);
        if (size) {
          swipes++;
          await axe("swipe", "--start-x", String(size.w * 0.9), "--start-y", String(size.h / 2), "--end-x", String(size.w * 0.1), "--end-y", String(size.h / 2), "--duration", "0.3");
        }
      }
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    if (!at) return axe("tap", "--label", label, "--tap-style", "physical");
    return axe("tap", "-x", String(at.x), "-y", String(at.y), "--tap-style", "physical");
  };
  const labels = async () => parseLabels((await axe("describe-ui")) ?? "");
  const see = async (what: string, match: (l: string[]) => boolean, ms = 30_000, minLooks = 1) => {
    let last: string[] = [];
    try {
      return await until(`${name}: ${what}`, ms, async () => {
        const out = await axe("describe-ui");
        if (out === null) {
          // AXe failed (the simulator is busy): back off rather than respawn it back to back.
          await new Promise<void>((r) => setTimeout(r, 250));
          return undefined;
        }
        last = parseLabels(out);
        return match(last) ? last : undefined;
      }, minLooks);
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
      let tapping = false;
      let lastTap = 0;
      return see("the board after pairing", (l) => {
        // The prompt can be in the tree before it takes touches, so a tap that lands too early is
        // tried again while the prompt is still up two seconds later.
        if (!tapping && screenState(l) === "prompt" && Date.now() - lastTap > 2000) {
          tapping = true;
          void tapLabel("Open").then((out) => {
            if (out !== null) lastTap = Date.now();
            tapping = false;
          });
        }
        return screenState(l) === "board";
      });
    },
    async tap(label, then) {
      for (let attempt = 1; ; attempt++) {
        await tapLabel(label);
        if (!then) return;
        let shown: string[] = [];
        try {
          // Two looks at least: on a loaded Mac one describe outlasts the whole 6 s, and a tap that
          // landed shows only in the next look. Tapping again on one stale look is a double tap.
          await see(then.what, (l) => ((shown = l), then.match(l)), attempt < 3 ? 6_000 : 30_000, 2);
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
          // The target is gone but the screen isn't what was expected yet: the tap landed and the screen is still moving, so wait for it rather than tap what may no longer be there.
          if (shown.length > 0 && !shown.includes(label)) {
            await see(then.what, then.match, 30_000, 2);
            return;
          }
        }
      }
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
    async background() {
      // A Home press the simulator drops leaves the app in front, and it then never saves its state:
      // press it until the app's root element (labelled "Harness") has left the screen. The look
      // after a press is slow on a loaded Mac, so a press is judged by two looks, not a fixed pause.
      const since = Date.now() / 1000;
      const before = (await labels()).slice(0, 12).join(" | ");
      let home = false;
      for (let press = 0; press < 5 && !home; press++) {
        await axe("button", "home");
        try {
          await see("the app out of the foreground", (l) => l[0] !== "Harness", 6_000, 2);
          home = true;
        } catch {}
      }
      if (!home) throw new Error(`${name}: the Home button never took the app out of the foreground`);
      // The app saves what it restores when its scene leaves the foreground, which can trail the Home
      // screen on a busy simulator. A save is the one with a time from after the press: waiting on
      // "a saved state exists" would pass on an older one.
      let found = "no preferences file";
      try {
        await until(`${name}: the app's saved state`, 30_000, async () => {
          // The app's own preferences file: `defaults read` through simctl spawn reads the simulator's user domain, which the app's UserDefaults don't write to.
          const where = await run(["xcrun", "simctl", "get_app_container", udid, BUNDLE_ID, "data"]);
          const plist = where.code === 0 ? join(where.out.trim(), "Library", "Preferences", `${BUNDLE_ID}.plist`) : null;
          const r = plist && existsSync(plist) ? await run(["plutil", "-convert", "json", "-o", "-", plist]) : null;
          if (!r || r.code !== 0) {
            await new Promise<void>((res) => setTimeout(res, 250));
            return undefined;
          }
          found = `preferences ${r.out.slice(0, 300)}`;
          return savedAfter(r.out, since) ? true : undefined;
        });
      } catch (e) {
        throw new Error(`${(e as Error).message}: the app never wrote its restorable state after Home (pressed at ${since}; ${found}; on screen before Home: ${before})`);
      }
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
