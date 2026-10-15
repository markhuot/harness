// The shape both walkthroughs share: one linear pass, a screen at a time, and a report per screen.
// A failed screen is recorded and the pass carries on, so one run shows every broken screen.
// There are no chains or modes on purpose: a state is reached once and checked there. `--only=a,b`
// runs just the screens named, for iterating on one; every screen reaches its state by link, so
// each stands alone, and the default is always the whole pass.

export type ScreenResult = { name: string; ok: boolean; ms: number; error?: string; checks: number };

/** `onFail(screen name)` runs when a screen fails, to capture what it saw (the iPhone walkthrough takes a screenshot). */
export function walk(title: string, onFail?: (name: string) => void) {
  const results: ScreenResult[] = [];
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
  /** `fn` gets `expect(label, ok, detail?)`; any failed expect or a throw fails the screen, after the rest of the screen ran. */
  async function screen(name: string, fn: (expect: (label: string, ok: boolean, detail?: string) => void) => Promise<void>) {
    if (only && !only.includes(name)) return;
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
    return r;
  }
  function summary() {
    const failed = results.filter((r) => !r.ok);
    const total = results.reduce((n, r) => n + r.ms, 0);
    const line = `${title}: ${results.length - failed.length}/${results.length} screens passed, ${results.reduce((n, r) => n + r.checks, 0)} checks, ${total} ms in screens`;
    console.log(line);
    return { results, failed, line };
  }
  return { screen, summary, results };
}
