// What a sim-check run spent its time on, kept as counts as well as milliseconds: wall time on a
// shared Mac is noisy, while spawn counts, poll iterations and sleep milliseconds stay steady under
// load and are what rank the costs. sim-check.ts is a top-level script with no exports, so the
// bookkeeping lives here, where it can be tested. A run writes `sim-check-profile.json`; the next
// run prints how it differs from the last one (see `diffProfiles`).
import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";

export type SpanKind = "phase" | "chain" | "check";

/** How many times something ran and how long it took in all. */
export interface Tally {
  count: number;
  ms: number;
}

/** What happened inside one chain or check (and for the whole run). Spawns are keyed `program` or `program:verb`. */
export interface Scope {
  ms: number;
  spawns: Record<string, Tally>;
  /** Time spent in fixed sleeps, and how many there were. */
  sleep: Tally;
  /** Polls of `until`/`whenShown`: how many waits, and how many times each looked. */
  pollWaits: number;
  pollIterations: number;
}

export interface PhaseTotals {
  count: number;
  /** Wall time between each start and end, children included. */
  ms: number;
  /** ms minus the time of the spans directly inside, so nested phases add up to the run, not past it. */
  exclusiveMs: number;
}

export interface ProfileData {
  version: 1;
  args: string[];
  totalMs: number;
  phases: Record<string, PhaseTotals>;
  chains: Record<string, Scope>;
  checks: Record<string, Scope>;
  total: Scope;
  /** Fixed sleeps by the source line that slept. */
  sleepSites: Record<string, Tally>;
  /** Poll iterations by the label the wait gave. */
  polls: Record<string, { waits: number; iterations: number; ms: number }>;
}

interface Node {
  kind: SpanKind;
  name: string;
  parent?: Node;
  childMs: number;
}

const emptyScope = (): Scope => ({ ms: 0, spawns: {}, sleep: { count: 0, ms: 0 }, pollWaits: 0, pollIterations: 0 });

function bump(map: Record<string, Tally>, key: string, ms: number) {
  const t = (map[key] ??= { count: 0, ms: 0 });
  t.count++;
  t.ms += ms;
}

/** The program a command line runs, with the verb for the tools that are a dozen different calls (`simctl:launch`, `axe:describe-ui`). */
export function programOf(cmd: string[]): string {
  const name = basename(cmd[0] ?? "?");
  const rest = name === "xcrun" ? cmd.slice(1) : cmd;
  const prog = basename(rest[0] ?? name);
  if (prog === "simctl" || prog === "axe") return rest[1] ? `${prog}:${rest[1]}` : prog;
  return prog;
}

/** `file.ts:123` of the first stack frame outside this file's callers named in `skip`, or "?". */
export function callerSite(stack: string | undefined, skip: RegExp = /profile\.ts/): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (skip.test(line)) continue;
    const m = line.match(/([^/\\()\s]+):(\d+):\d+\)?$/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return "?";
}

export class Profile {
  private readonly store = new AsyncLocalStorage<Node>();
  private readonly started: number;
  private readonly phases: Record<string, PhaseTotals> = {};
  private readonly chains: Record<string, Scope> = {};
  private readonly checks: Record<string, Scope> = {};
  private readonly total = emptyScope();
  private readonly sleepSites: Record<string, Tally> = {};
  private readonly polls: ProfileData["polls"] = {};

  constructor(
    private readonly args: string[] = [],
    private readonly now: () => number = () => performance.now(),
  ) {
    this.started = now();
  }

  /** Runs fn as a span of the run: spawns, sleeps and polls inside it are counted against its chain and check. */
  async span<T>(kind: SpanKind, name: string, fn: () => Promise<T>): Promise<T> {
    const node: Node = { kind, name, parent: this.store.getStore(), childMs: 0 };
    const t = this.now();
    try {
      return await this.store.run(node, fn);
    } finally {
      const ms = this.now() - t;
      if (node.parent) node.parent.childMs += ms;
      if (kind === "phase") {
        const p = (this.phases[name] ??= { count: 0, ms: 0, exclusiveMs: 0 });
        p.count++;
        p.ms += ms;
        p.exclusiveMs += Math.max(0, ms - node.childMs);
      } else {
        const s = (kind === "chain" ? this.chains : this.checks)[name] ?? ((kind === "chain" ? this.chains : this.checks)[name] = emptyScope());
        s.ms += ms;
      }
    }
  }

  /** The scopes the current async context sits in: the run, and its chain and check if any. */
  private scopes(): Scope[] {
    const out = [this.total];
    const seen = new Set<SpanKind>();
    for (let n = this.store.getStore(); n; n = n.parent) {
      if (n.kind === "phase" || seen.has(n.kind)) continue;
      seen.add(n.kind);
      out.push(((n.kind === "chain" ? this.chains : this.checks)[n.name] ??= emptyScope()));
    }
    return out;
  }

  spawn(cmd: string[], ms: number) {
    const key = programOf(cmd);
    for (const s of this.scopes()) bump(s.spawns, key, ms);
  }

  sleep(ms: number, site: string) {
    bump(this.sleepSites, site, ms);
    for (const s of this.scopes()) {
      s.sleep.count++;
      s.sleep.ms += ms;
    }
  }

  poll(label: string, iterations: number, ms: number) {
    const p = (this.polls[label] ??= { waits: 0, iterations: 0, ms: 0 });
    p.waits++;
    p.iterations += iterations;
    p.ms += ms;
    for (const s of this.scopes()) {
      s.pollWaits++;
      s.pollIterations += iterations;
    }
  }

  data(): ProfileData {
    const totalMs = Math.round(this.now() - this.started);
    return JSON.parse(JSON.stringify({ version: 1, args: this.args, totalMs, phases: this.phases, chains: this.chains, checks: this.checks, total: { ...this.total, ms: totalMs }, sleepSites: this.sleepSites, polls: this.polls })) as ProfileData;
  }
}

/** Spawns by program, verbs folded in: `simctl:launch` and `simctl:openurl` both count under `simctl`. */
export function spawnsByProgram(spawns: Record<string, Tally>): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const [k, t] of Object.entries(spawns)) {
    const p = (out[k.split(":")[0]!] ??= { count: 0, ms: 0 });
    p.count += t.count;
    p.ms += t.ms;
  }
  return out;
}

const s1 = (ms: number) => (ms / 1000).toFixed(1).padStart(6);
const top = <T,>(rows: [string, T][], by: (v: T) => number, n: number) => rows.sort((a, b) => by(b[1]) - by(a[1])).slice(0, n);
const spawnCount = (s: Scope) => Object.values(s.spawns).reduce((n, t) => n + t.count, 0);

/** The heaviest phases, chains, checks, sleeps, waits and programs, for the end of a run. */
export function summarize(d: ProfileData, n = 8): string[] {
  const out: string[] = [`profile (total ${(d.totalMs / 1000).toFixed(1)} s; ${spawnCount(d.total)} spawns, ${d.total.sleep.count} sleeps = ${(d.total.sleep.ms / 1000).toFixed(1)} s, ${d.total.pollIterations} poll iterations in ${d.total.pollWaits} waits):`];
  const scoped = (title: string, m: Record<string, Scope>) => {
    const rows = top(Object.entries(m), (s) => s.ms, n);
    if (!rows.length) return;
    out.push(`  ${title}:`);
    for (const [name, s] of rows) out.push(`    ${s1(s.ms)} s  ${name}  (${spawnCount(s)} spawns, sleep ${(s.sleep.ms / 1000).toFixed(1)} s, ${s.pollIterations} polls)`);
  };
  const phases = top(Object.entries(d.phases), (p) => p.exclusiveMs, n);
  if (phases.length) {
    out.push("  phases (exclusive of what runs inside them):");
    for (const [name, p] of phases) out.push(`    ${s1(p.exclusiveMs)} s  ${name}${p.count > 1 ? ` ×${p.count}` : ""}`);
  }
  scoped("chains", d.chains);
  scoped("checks", d.checks);
  const progs = top(Object.entries(spawnsByProgram(d.total.spawns)), (t) => t.count, n);
  if (progs.length) {
    out.push("  spawns by program:");
    for (const [name, t] of progs) out.push(`    ${String(t.count).padStart(6)}  ${name}  (${(t.ms / 1000).toFixed(1)} s)`);
  }
  const sleeps = top(Object.entries(d.sleepSites), (t) => t.ms, n);
  if (sleeps.length) {
    out.push("  fixed sleeps by line:");
    for (const [site, t] of sleeps) out.push(`    ${s1(t.ms)} s  ${site}  ×${t.count}`);
  }
  const polls = top(Object.entries(d.polls), (p) => p.iterations, n);
  if (polls.length) {
    out.push("  waits by poll iterations:");
    for (const [label, p] of polls) out.push(`    ${String(p.iterations).padStart(6)}  ${label}  (${p.waits} waits, ${(p.ms / 1000).toFixed(1)} s)`);
  }
  return out;
}

/** How a run differs from an earlier one: the run totals, then the chains, checks and programs that moved most. Counts, not just wall time. */
export function diffProfiles(prev: ProfileData, cur: ProfileData, n = 8): string[] {
  const sign = (x: number, unit = "") => `${x > 0 ? "+" : ""}${unit === "s" ? (x / 1000).toFixed(1) : Math.round(x)}${unit}`;
  const out = [`vs the last run (${prev.args.join(" ") || "no flags"}):`];
  out.push(`  total ${sign(cur.totalMs - prev.totalMs, "s")}, spawns ${sign(spawnCount(cur.total) - spawnCount(prev.total))}, sleep ${sign(cur.total.sleep.ms - prev.total.sleep.ms, "s")}, poll iterations ${sign(cur.total.pollIterations - prev.total.pollIterations)}`);
  const moved = (title: string, a: Record<string, Scope>, b: Record<string, Scope>) => {
    const rows = Object.keys({ ...a, ...b }).map((k): [string, number] => [k, (b[k]?.ms ?? 0) - (a[k]?.ms ?? 0)]);
    const big = top(rows.filter(([, d]) => Math.abs(d) >= 500), (d) => Math.abs(d), n);
    if (!big.length) return;
    out.push(`  ${title}:`);
    for (const [k, d] of big) out.push(`    ${sign(d, "s").padStart(7)}  ${k}${a[k] ? "" : "  (new)"}${b[k] ? "" : "  (gone)"}`);
  };
  moved("chains", prev.chains, cur.chains);
  moved("checks", prev.checks, cur.checks);
  const pa = spawnsByProgram(prev.total.spawns);
  const pb = spawnsByProgram(cur.total.spawns);
  const progs = top(Object.keys({ ...pa, ...pb }).map((k): [string, number] => [k, (pb[k]?.count ?? 0) - (pa[k]?.count ?? 0)]).filter(([, d]) => d !== 0), (d) => Math.abs(d), n);
  if (progs.length) {
    out.push("  spawns:");
    for (const [k, d] of progs) out.push(`    ${sign(d).padStart(7)}  ${k}`);
  }
  return out;
}
