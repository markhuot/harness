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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

export interface FileResult {
  file: string;
  ok: boolean;
  ms: number;
  pass: number;
  fail: number;
  skip: number;
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

async function runFile(file: string, flags: string[], children: Set<Bun.Subprocess>): Promise<FileResult> {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "test", ...flags, `./${file}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  children.add(proc);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  children.delete(proc);
  const output = stdout + stderr;
  return { file, ok: code === 0, ms: performance.now() - started, ...parseCounts(output), output };
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

  const started = performance.now();
  const results = await pool(orderFiles(files, times), jobs, async (file) => {
    const r = await runFile(file, flags, children);
    if (r.ok) console.log(`✓ ${file} (${r.pass} pass${r.skip ? `, ${r.skip} skip` : ""}) [${(r.ms / 1000).toFixed(1)}s]`);
    else console.log(`✗ ${file} [${(r.ms / 1000).toFixed(1)}s]\n${r.output.trimEnd()}\n`);
    return r;
  });

  try {
    mkdirSync(dirname(timesPath), { recursive: true });
    writeFileSync(timesPath, JSON.stringify(Object.fromEntries(results.map((r) => [r.file, Math.round(r.ms)])), null, 2));
  } catch {}

  const failed = results.filter((r) => !r.ok);
  const sum = (k: "pass" | "fail" | "skip") => results.reduce((n, r) => n + r[k], 0);
  console.log(
    `\n ${sum("pass")} pass\n ${sum("fail")} fail${sum("skip") ? `\n ${sum("skip")} skip` : ""}\n` +
      `Ran ${files.length} files, ${jobs} at a time. [${((performance.now() - started) / 1000).toFixed(2)}s]`,
  );
  if (failed.length) console.log(`\nFailed:\n${failed.map((r) => `  ${r.file}`).join("\n")}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
