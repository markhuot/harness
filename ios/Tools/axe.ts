// Reading and tapping the simulator's screen through AXe (brew install cameroncooke/axe/axe, 1.8 or newer: older ones can't tap in Xcode 27.1's simulators), for
// dev-sim.ts: the same accessibility-tree approach as the walkthrough, so a dev loop
// knows what's on screen instead of sleeping and hoping.
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
 * The middle of the part of the element labelled `label` that shows on screen (its AXFrame reads
 * "{{x, y}, {w, h}}"), or null when it isn't: absent, or laid out wholly beyond the screen's frame.
 * A chip half scrolled off the edge is tapped on its visible half, which AXe's own label lookup (the
 * middle of the whole chip) misses. Taps use `--tap-style physical`: under Xcode 27.1 AXe's default
 * tap never lands.
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

export const hasAxe = () => Bun.spawnSync(["which", "axe"]).exitCode === 0;

/** An AXe driver for one simulator. */
export function axeFor(udid: string, developerDir: string) {
  const run = async (...a: string[]) => {
    const p = Bun.spawn(["axe", ...a, "--udid", udid], { env: { ...process.env, DEVELOPER_DIR: developerDir }, stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return code === 0 ? out : "";
  };
  return {
    labels: async () => parseLabels(await run("describe-ui")),
    tap: async (label: string) => {
      const at = labelCenter(await run("describe-ui"), label);
      return at ? run("tap", "-x", String(at.x), "-y", String(at.y), "--tap-style", "physical") : run("tap", "--label", label, "--tap-style", "physical");
    },
  };
}
