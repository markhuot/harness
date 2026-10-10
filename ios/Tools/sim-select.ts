// What a sim-check run does, decided from its flags: pure, so bun test can pin it down.
//
// The walk-through has two kinds of entries. A catalog entry is a screen: validation visits it and
// only checks the app is still alive; `--screens` and `--only=<name>` shoot it, light and dark.
// A chain is a group of real-tap checks. Each entry names the seeded tickets it needs, and a run
// seeds only the union of what its selection needs.

/** The tickets (and extras) the walk-through's seed can create; see seed() in sim-check.ts. */
export const SEED_NAMES = [
  "hello", "changes", "conductor", "browse", "approval", "configApproval", "blocked", "plan", "agents", "tables",
  "branchPlan", "quick", "waiting", "draft", "code", "diff", "headings", "fileLink", "linked", "tasks", "watchers",
  "gauge", "gaugeOver", "gaugeMiss", "gaugeCompact", "gaugeCopilot", "gaugeNew",
] as const;
export type SeedName = (typeof SEED_NAMES)[number];

export type Entry = {
  name: string;
  kind: "screen" | "chain";
  needs: SeedName[];
  /** A screen validation only visits (no shot, no theme flip). Screens without it are catalog-only. */
  visit?: boolean;
  /** A chain that runs only when named (`--only=`) or switched on by its own flag. */
  optIn?: boolean;
};

export type Plan = {
  /** What each selected entry does: shoot a screen, only visit it, or run a chain. */
  steps: { entry: Entry; action: "shoot" | "visit" | "run" }[];
  seeds: Set<SeedName>;
};

/**
 * Picks the entries a run does.
 *  - `only` names entries (screens or chains): exactly those, screens shot.
 *  - `screens`: the whole catalog, shot, and no chains.
 *  - neither: validation, every chain not opt-in, and a visit to each screen that has `visit`.
 *  - `extra` names opt-in chains a flag switched on (--memory), added to validation.
 */
export function plan(entries: Entry[], opts: { only?: string[]; screens?: boolean; extra?: string[] }): Plan {
  const steps: Plan["steps"] = [];
  const names = new Set(entries.map((e) => e.name));
  if (opts.only) {
    const unknown = opts.only.filter((n) => !names.has(n));
    if (unknown.length) throw new Error(`--only: unknown ${unknown.join(", ")}; known: ${[...names].join(", ")}`);
    for (const e of entries) if (opts.only.includes(e.name)) steps.push({ entry: e, action: e.kind === "chain" ? "run" : "shoot" });
  } else if (opts.screens) {
    for (const e of entries) if (e.kind === "screen") steps.push({ entry: e, action: "shoot" });
  } else {
    for (const e of entries) {
      if (e.kind === "chain" && (!e.optIn || opts.extra?.includes(e.name))) steps.push({ entry: e, action: "run" });
      else if (e.kind === "screen" && e.visit) steps.push({ entry: e, action: "visit" });
    }
  }
  const seeds = new Set<SeedName>();
  for (const s of steps) for (const n of s.entry.needs) seeds.add(n);
  return { steps, seeds };
}

/** `{name}` placeholders in a --shot link, in order. */
export function placeholders(link: string): string[] {
  return [...link.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]!);
}

/**
 * A `--shot` link with its placeholders resolved to seeded tickets' keys (`{headings}` →
 * `GREET-14`), and the seeds it needs. A name that isn't a seed fails with the known ones listed.
 */
export function resolveShot(link: string, keyOf: (name: SeedName) => string): { url: string; needs: SeedName[] } {
  const needs: SeedName[] = [];
  for (const n of placeholders(link)) {
    if (!(SEED_NAMES as readonly string[]).includes(n)) throw new Error(`--shot: no seeded ticket named {${n}}; known: ${SEED_NAMES.join(", ")}`);
    needs.push(n as SeedName);
  }
  return { needs, url: link.replace(/\{([A-Za-z]+)\}/g, (_, n: string) => encodeURIComponent(keyOf(n as SeedName))) };
}

/** `--prepare=tap:Label;scroll:Label` (a label may hold commas): the steps a --shot takes before shooting. */
export type PrepareStep = { op: "tap" | "scroll"; label: string };
export function parsePrepare(spec: string | undefined): PrepareStep[] {
  if (!spec) return [];
  return spec.split(";").filter(Boolean).map((part) => {
    const i = part.indexOf(":");
    const op = part.slice(0, i);
    if (i < 0 || (op !== "tap" && op !== "scroll") || !part.slice(i + 1)) throw new Error(`--prepare: "${part}" isn't tap:<label> or scroll:<label>`);
    return { op, label: part.slice(i + 1) };
  });
}
