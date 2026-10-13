// Tests that need something this machine may lack (Chrome, a LAN address, Electron) skip when it's
// missing. Pick describe/test through these helpers so the skip says why: the reason is printed on
// a `HARNESS-SKIP:` line when the file loads, which the parallel runner (parallel.ts) and the root
// `bun run test` collect into a summary at the end, so a skip is never silent.

import { describe, test } from "bun:test";

export const SKIP_MARKER = "HARNESS-SKIP:";

const noted = new Set<string>();

/** Print the skip reason once per process. */
export function noteSkip(reason: string): void {
  if (noted.has(reason)) return;
  noted.add(reason);
  console.warn(`${SKIP_MARKER} ${reason}`);
}

/** `describe` when `available` is truthy; otherwise `describe.skip`, noting `reason`. */
export function describeIf(available: unknown, reason: string): typeof describe {
  if (available) return describe;
  noteSkip(reason);
  return describe.skip as typeof describe;
}

/** `test` when `available` is truthy; otherwise `test.skip`, noting `reason`. */
export function testIf(available: unknown, reason: string): typeof test {
  if (available) return test;
  noteSkip(reason);
  return test.skip as typeof test;
}

/** The distinct skip reasons in some test output, in order of appearance. */
export function skipReasons(output: string): string[] {
  const reasons: string[] = [];
  for (const line of output.split("\n")) {
    const at = line.indexOf(SKIP_MARKER);
    if (at < 0) continue;
    const reason = line.slice(at + SKIP_MARKER.length).trim();
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** Skip counts per package from the "N skip" summary lines, and the skip reasons, in `output`. */
export function summarizeSkips(output: string): { total: number; byPackage: Record<string, number>; reasons: string[] } {
  const byPackage: Record<string, number> = {};
  for (const m of output.matchAll(/^(\S+) test:\s+(\d+) skip$/gm)) byPackage[m[1]!] = (byPackage[m[1]!] ?? 0) + Number(m[2]);
  return { total: Object.values(byPackage).reduce((a, b) => a + b, 0), byPackage, reasons: skipReasons(output) };
}

export function formatSkips(s: ReturnType<typeof summarizeSkips>): string {
  if (s.total === 0 && s.reasons.length === 0) return "Skipped: 0 tests.";
  const packages = Object.entries(s.byPackage).filter(([, n]) => n > 0).map(([p, n]) => `${p.replace(/^@harness\//, "")} ${n}`).join(", ");
  const lines = [`Skipped: ${s.total} test${s.total === 1 ? "" : "s"}${packages ? ` (${packages})` : ""}.`];
  for (const r of s.reasons) lines.push(`  - ${r}`);
  if (s.total > 0 && s.reasons.length === 0) lines.push("  - no reason declared");
  return lines.join("\n");
}

