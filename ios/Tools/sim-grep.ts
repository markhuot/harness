// Picking single checks out of sim-check's sequences (--grep), with no simulator in sight so it can
// be unit-tested. sim-check's checks are inline `await check(name, fn)` calls, and many lean on what
// the one before left on screen (the sheet open, the dock holding a card). A check that does
// declares `needs`: the exact names of the checks that set its state up. Under --grep, a selected
// check first runs the checks it needs (and theirs) as setup, so it never passes or fails against
// state nobody built.
//
// A sequence of checks nobody has annotated is "chained": each check is taken to need every check
// before it in the sequence, which is always safe and saves nothing. A sequence whose checks have
// been read through is "declared": a check with no `needs` starts from nothing of the earlier ones.

export interface Matcher {
  /** The pattern as the user wrote it. */
  source: string;
  test(name: string): boolean;
}

/**
 * `/body/flags` is a regular expression; anything else is a case-insensitive substring. (A pattern
 * that merely contains slashes, like "a/b", is a substring.)
 */
export function parseGrep(pattern: string): Matcher {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (re) {
    let rx: RegExp;
    try {
      rx = new RegExp(re[1]!, re[2]);
    } catch (e) {
      throw new Error(`--grep: ${pattern} isn't a regular expression (${(e as Error).message})`);
    }
    return { source: pattern, test: (name) => ((rx.lastIndex = 0), rx.test(name)) };
  }
  const needle = pattern.toLowerCase();
  if (!needle) throw new Error("--grep needs a pattern");
  return { source: pattern, test: (name) => name.toLowerCase().includes(needle) };
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** The check names closest to `pattern` (by words shared, then by order seen), for a pattern that matched nothing. */
export function nearbyNames(pattern: string, names: readonly string[], limit = 6): string[] {
  const want = words(pattern.replace(/^\/|\/[a-z]*$/g, ""));
  return names
    .map((name, i) => ({ name, i, score: [...words(name)].filter((w) => want.has(w) || [...want].some((x) => x.length > 2 && (w.includes(x) || x.includes(w)))).length }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.name);
}

/** The error for a --grep that selected nothing: what it was, and the names it might have meant. */
export function noMatchMessage(pattern: string, names: readonly string[]): string {
  if (!names.length) return `--grep ${pattern}: no checks ran at all (is the mode or --only right?)`;
  return `--grep ${pattern} matched none of the ${names.length} checks that came up; nearest:\n${nearbyNames(pattern, names).map((n) => `  - ${n}`).join("\n")}`;
}

interface Registered<F> { needs: readonly string[]; body: F }

/**
 * Decides, as each check is reached, whether it runs and which earlier checks run first as setup.
 * Without a matcher every check runs and nothing is setup. Checks are reached in source order, so a
 * prerequisite has always been seen (and its body kept) by the time something needs it.
 */
export class CheckSelector<F> {
  private seen = new Map<string, Registered<F>>();
  private sequenceNames: string[] = [];
  private chained = true;
  private done = new Set<string>();
  matched = 0;
  get hasMatcher(): boolean {
    return this.matcher !== null;
  }

  constructor(private matcher: Matcher | null) {}

  get names(): string[] {
    return [...this.seen.keys()];
  }

  /** A new run of checks starts (a mode's function, a chain): earlier checks aren't its prerequisites. */
  sequence(kind: "chained" | "declared" = "chained"): void {
    this.sequenceNames = [];
    this.done.clear();
    this.chained = kind === "chained";
  }

  visit(name: string, declared: readonly string[] | undefined, body: F): { run: boolean; setup: { name: string; body: F }[] } {
    const needs = [...(declared ?? (this.chained ? this.sequenceNames : []))];
    this.seen.set(name, { needs, body });
    this.sequenceNames.push(name);
    if (this.matcher && !this.matcher.test(name)) return { run: false, setup: [] };
    this.matched++;
    const setup: { name: string; body: F }[] = [];
    const add = (n: string, via: string, chain: readonly string[]) => {
      if (this.done.has(n)) return;
      if (chain.includes(n)) throw new Error(`check "${via}" needs itself through ${[...chain, n].join(" → ")}`);
      const r = this.seen.get(n);
      if (!r) throw new Error(`check "${via}" needs "${n}", which hasn't run before it`);
      for (const dep of r.needs) add(dep, n, [...chain, n]);
      this.done.add(n);
      setup.push({ name: n, body: r.body });
    };
    for (const dep of needs) add(dep, name, [name]);
    this.done.add(name);
    return { run: true, setup };
  }
}
