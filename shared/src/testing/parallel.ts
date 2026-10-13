// Runs a package's test files in parallel, one `bun test` process per file, for packages whose
// files spend most of their time waiting on subprocesses (git, Chrome, daemons) rather than CPU.
// bun test runs every file of one invocation in a single process, one after another.
//
//   bun ../shared/src/testing/parallel.ts [bun test flags]
//
// Flags (--timeout 30000, --update-snapshots, ...) go to every file's run. Any other argument (a
// path or name filter) runs plain `bun test` with all the arguments instead, so filtering works
// as usual. HARNESS_TEST_JOBS sets how many files run at once. The slowest files start first,
// going by the durations the last run recorded in node_modules/.cache/harness-test-times.json.
//
// Each file's line also shows the CPU it used (user + system, its child processes included) and the
// processes it started, by program (spawn-count.ts), and the run ends with the heaviest files by
// CPU. Wall time swings with whatever else the machine is doing; CPU and spawn counts don't, so they
// are what to compare when making a file faster. The full profile goes to
// node_modules/.cache/harness-test-profile.json.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKIP_MARKER, skipReasons } from "./skip";
import { tallySpawns } from "./spawn-count";

const SPAWN_COUNTER = join(import.meta.dir, "spawn-count.ts");

export interface FileResult {
  file: string;
  ok: boolean;
  ms: number;
  /** User + system CPU of the file's `bun test` and every process it started and waited for. */
  cpuMs: number;
  /** Processes the file started, by program name. */
  spawns: Record<string, number>;
  pass: number;
  fail: number;
  skip: number;
  /** Why the file's tests skipped, as the tests declared it (see skip.ts). */
  reasons: string[];
  output: string;
}

/** Files with no recorded time first (they may be slow), then slowest first, ties by name. */
export function orderFiles(files: string[], times: Record<string, number>): string[] {
  const key = (f: string) => times[f] ?? Number.POSITIVE_INFINITY;
  return [...files].sort((a, b) => key(b) - key(a) || a.localeCompare(b));
}

/** The pass/fail/skip counts from bun test's summary lines; zero for a count it didn't print. */
export function parseCounts(output: string): { pass: number; fail: number; skip: number } {
  const count = (word: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${word}$`, "m"))?.[1] ?? 0);
  return { pass: count("pass"), fail: count("fail"), skip: count("skip") };
}

/**
 * One `HARNESS-SKIP:` line per skipping file, so a skip is never silent. A file whose tests skip
 * without declaring why is listed too, as undeclared.
 */
export function skipLines(results: Pick<FileResult, "file" | "skip" | "reasons">[]): string[] {
  return results
    .filter((r) => r.skip > 0)
    .map((r) => `${SKIP_MARKER} ${r.reasons.length ? r.reasons.join("; ") : "no reason declared"} [${r.skip} skipped in ${r.file}]`);
}

/** "git 120, bun 2": a file's spawns, most first, ties by name. */
export function formatSpawns(spawns: Record<string, number>): string {
  return Object.entries(spawns)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
}

/** The `[wall, cpu, spawns]` tail of a file's line. */
export function formatCost(r: Pick<FileResult, "ms" | "cpuMs" | "spawns">): string {
  const spawns = formatSpawns(r.spawns);
  return `[${(r.ms / 1000).toFixed(1)}s, cpu ${(r.cpuMs / 1000).toFixed(1)}s${spawns ? `; ${spawns}` : ""}]`;
}

/** The `count` files that used the most CPU, one line each, and the run's totals. */
export function heaviestLines(results: Pick<FileResult, "file" | "ms" | "cpuMs" | "spawns">[], count = 10): string[] {
  const totals: Record<string, number> = {};
  for (const r of results) for (const [name, n] of Object.entries(r.spawns)) totals[name] = (totals[name] ?? 0) + n;
  const cpu = results.reduce((n, r) => n + r.cpuMs, 0);
  return [
    ...[...results].sort((a, b) => b.cpuMs - a.cpuMs || a.file.localeCompare(b.file)).slice(0, count).map((r) => `${r.file} ${formatCost(r)}`),
    `all files: cpu ${(cpu / 1000).toFixed(1)}s${Object.keys(totals).length ? `; ${formatSpawns(totals)}` : ""}`,
  ];
}

/** Options are the arguments that start with "-" and the values that follow value-taking ones. */
export function splitArgs(args: string[]): { flags: string[]; filters: string[] } {
  const takesValue = new Set(["--timeout", "--preload", "--rerun-each", "--bail", "--test-name-pattern", "-t", "--reporter", "--reporter-outfile", "--coverage-dir", "--coverage-reporter"]);
  const flags: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) filters.push(a);
    else {
      flags.push(a);
      if (takesValue.has(a) && i + 1 < args.length) flags.push(args[++i]!);
    }
  }
  return { flags, filters };
}

/** Run `run` over `items`, at most `jobs` at a time, starting them in order. */
export async function pool<T, R>(items: T[], jobs: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
  return results;
}

async function runFile(file: string, flags: string[], children: Set<Bun.Subprocess>, logDir: string, index: number): Promise<FileResult> {
  const log = join(logDir, `${index}.log`);
  writeFileSync(log, "");
  // BUN_OPTIONS carries the counter into the bun processes the test starts too (daemons, CLIs).
  const env = { ...process.env, HARNESS_SPAWN_LOG: log, BUN_OPTIONS: `--preload=${SPAWN_COUNTER} ${process.env.BUN_OPTIONS ?? ""}`.trim() };
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "test", ...flags, `./${file}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  children.add(proc);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  children.delete(proc);
  const ms = performance.now() - started;
  const cpuMs = Number(proc.resourceUsage()?.cpuTime.total ?? 0) / 1000;
  const spawns = tallySpawns(readFileSync(log, "utf8"));
  const output = stdout + stderr;
  return { file, ok: code === 0, ms, cpuMs, spawns, ...parseCounts(output), reasons: skipReasons(output), output };
}

async function main(args: string[]): Promise<number> {
  const { flags, filters } = splitArgs(args);
  if (filters.length > 0) {
    return Bun.spawn([process.execPath, "test", ...args], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  }

  const files = [...new Bun.Glob("**/*.test.{ts,tsx}").scanSync({ cwd: process.cwd() })].filter((f) => !f.includes("node_modules/")).sort();
  const timesPath = join(process.cwd(), "node_modules", ".cache", "harness-test-times.json");
  let times: Record<string, number> = {};
  try {
    times = JSON.parse(readFileSync(timesPath, "utf8"));
  } catch {}
  const jobs = Number(process.env.HARNESS_TEST_JOBS) || Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));

  const children = new Set<Bun.Subprocess>();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      for (const c of children) c.kill();
      process.exit(130);
    });
  }

  const logDir = mkdtempSync(join(tmpdir(), "harness-spawns-"));
  const started = performance.now();
  let index = 0;
  const results = await pool(orderFiles(files, times), jobs, async (file) => {
    const r = await runFile(file, flags, children, logDir, index++);
    if (r.ok) console.log(`✓ ${file} (${r.pass} pass${r.skip ? `, ${r.skip} skip` : ""}) ${formatCost(r)}`);
    else console.log(`✗ ${file} ${formatCost(r)}\n${r.output.trimEnd()}\n`);
    return r;
  });
  rmSync(logDir, { recursive: true, force: true });

  try {
    mkdirSync(dirname(timesPath), { recursive: true });
    writeFileSync(timesPath, JSON.stringify(Object.fromEntries(results.map((r) => [r.file, Math.round(r.ms)])), null, 2));
    const profile = results.map(({ file, ms, cpuMs, spawns }) => ({ file, ms: Math.round(ms), cpuMs: Math.round(cpuMs), spawns }));
    writeFileSync(join(dirname(timesPath), "harness-test-profile.json"), JSON.stringify(profile, null, 2));
  } catch {}

  const failed = results.filter((r) => !r.ok);
  const sum = (k: "pass" | "fail" | "skip") => results.reduce((n, r) => n + r[k], 0);
  console.log(
    `\n ${sum("pass")} pass\n ${sum("fail")} fail${sum("skip") ? `\n ${sum("skip")} skip` : ""}\n` +
      `Ran ${files.length} files, ${jobs} at a time. [${((performance.now() - started) / 1000).toFixed(2)}s]`,
  );
  console.log(`\nHeaviest files by CPU:\n${heaviestLines(results).map((l) => `  ${l}`).join("\n")}`);
  const skips = skipLines(results);
  if (skips.length) console.log(`\nSkipped:\n${skips.map((l) => `  ${l}`).join("\n")}`);
  if (failed.length) console.log(`\nFailed:\n${failed.map((r) => `  ${r.file}`).join("\n")}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
