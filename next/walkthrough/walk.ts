// The shape both walkthroughs share: one linear pass, a screen at a time, and a report per screen.
// A failed screen is recorded and the pass carries on, so one run shows every broken screen.
// There are no chains or modes on purpose: a state is reached once and checked there. `--only=a,b`
// runs just the screens named, for iterating on one; every screen reaches its state by link, so
// each stands alone, and the default is always the whole pass.

import { takeAxeStats } from "../../ios/Tools/axe";

export type ScreenResult = { name: string; ok: boolean; ms: number; error?: string; checks: number };

/** `onFail(screen name)` runs when a screen fails, to capture what it saw (the iPhone walkthrough takes a screenshot). */
export function walk(title: string, onFail?: (name: string) => void) {
  const results: ScreenResult[] = [];
  const totals = new Map<string, { n: number; ms: number }>();
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
  /** `fn` gets `expect(label, ok, detail?)`; any failed expect or a throw fails the screen, after the rest of the screen ran. */
  async function screen(name: string, fn: (expect: (label: string, ok: boolean, detail?: string) => void) => Promise<void>) {
    if (only && !only.includes(name)) return;
    takeAxeStats();
    const started = performance.now();
    const failures: string[] = [];
    let checks = 0;
    const expect = (label: string, ok: boolean, detail = "") => {
      checks++;
      if (!ok) failures.push(detail ? `${label} (${detail})` : label);
    };
    try {
      await fn(expect);
    } catch (e) {
      failures.push(`threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (failures.length) onFail?.(name);
    const r: ScreenResult = { name, ok: failures.length === 0, ms: Math.round(performance.now() - started), checks, ...(failures.length ? { error: failures.join("; ") } : {}) };
    results.push(r);
    console.log(`${r.ok ? "✓" : "✗"} ${name} — ${checks} checks, ${r.ms} ms${r.error ? `\n    ${r.error}` : ""}`);
    if (process.env.WALK_TIMING) {
      // AXe time by subcommand; "other" is everything else (probe and API polling, simctl, the daemon's own latency)
      const stats = takeAxeStats();
      for (const s of stats) totals.set(s.cmd, { n: (totals.get(s.cmd)?.n ?? 0) + s.n, ms: (totals.get(s.cmd)?.ms ?? 0) + s.ms });
      const axeMs = stats.reduce((n, s) => n + s.ms, 0);
      totals.set("(other)", { n: 0, ms: (totals.get("(other)")?.ms ?? 0) + r.ms - axeMs });
      const parts = stats.sort((a, b) => b.ms - a.ms).map((s) => `${s.cmd} ${s.n}× ${Math.round(s.ms)} ms`);
      console.log(`    timing: ${parts.join(", ")}, other ${Math.round(r.ms - axeMs)} ms`);
    }
    return r;
  }
  function summary() {
    const failed = results.filter((r) => !r.ok);
    const total = results.reduce((n, r) => n + r.ms, 0);
    const line = `${title}: ${results.length - failed.length}/${results.length} screens passed, ${results.reduce((n, r) => n + r.checks, 0)} checks, ${total} ms in screens`;
    console.log(line);
    if (process.env.WALK_TIMING) {
      for (const [cmd, t] of [...totals].sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${cmd.padEnd(14)} ${String(t.n).padStart(5)}×  ${String(Math.round(t.ms)).padStart(7)} ms  ${t.n ? `${Math.round(t.ms / t.n)} ms each` : ""}`);
    }
    return { results, failed, line };
  }
  return { screen, summary, results };
}
