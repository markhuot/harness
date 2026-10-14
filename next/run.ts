// `bun run test:next`: the new suite. One bun process per tier, files in random order (the seed is
// printed so a failure replays with --seed=N), the guard preloaded. Prints wall time, CPU and the
// slowest tests; none of those numbers ever fails the run. Only a failed test does.
//
//   bun next/run.ts [--seed=N] [--tier=unit|contract|all] [--slowest=N]

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export interface TestMetric {
  file: string;
  name: string;
  wallMs: number;
  cpuMs: number;
}

const ROOT = resolve(import.meta.dir, "..");

/** The unit tier is every test outside next/contract; the contract tier is allowed to run real things. */
export function splitTiers(files: string[]) {
  const contract = files.filter((f) => /^next\/contract\//.test(f));
  return { unit: files.filter((f) => !contract.includes(f)), contract };
}

/** The guard's lines, one per test run: `{wallMs, cpuMs}`. */
export function parseMetrics(jsonl: string): { wallMs: number; cpuMs: number }[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const unescape = (x: string) => x.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The testcases of bun's JUnit report, in the order they ran, with the file each belongs to. */
export function parseResults(junit: string): { file: string; name: string }[] {
  return [...junit.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]* file="([^"]*)"/g)].map((m) => ({ file: m[3]!, name: unescape(m[2] ? `${m[2]} > ${m[1]}` : m[1]!) }));
}

/** Name each of the guard's measurements. bun gives hooks no test name, so this pairs them by order with the JUnit report; when the counts differ nothing is named. */
export function nameMetrics(measured: { wallMs: number; cpuMs: number }[], results: { file: string; name: string }[]): TestMetric[] {
  if (measured.length !== results.length) return measured.map((m, i) => ({ ...m, file: "", name: `test #${i + 1} (names unavailable: ${measured.length} measured, ${results.length} reported)` }));
  return measured.map((m, i) => ({ ...m, ...results[i]! }));
}

export function summarize(metrics: TestMetric[], slowest = 5) {
  const top = [...metrics].sort((a, b) => b.cpuMs - a.cpuMs).slice(0, slowest);
  return { tests: metrics.length, cpuMs: metrics.reduce((s, m) => s + m.cpuMs, 0), slowest: top };
}

async function runTier(name: string, files: string[], seed: number, slowest: number): Promise<number> {
  if (!files.length) return 0;
  const dir = mkdtempSync(join(tmpdir(), "next-metrics-"));
  const metrics = join(dir, "metrics.jsonl");
  const junit = join(dir, "junit.xml");
  const started = performance.now();
  const proc = Bun.spawn(["bun", "test", "--preload", "./next/support/guard.ts", "--randomize", `--seed=${seed}`, "--reporter=junit", `--reporter-outfile=${junit}`, ...files.map((f) => `./${f}`)], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEXT_TIER: name, NEXT_METRICS: metrics, NO_COLOR: "1" },
  });
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    for await (const chunk of stream) sink.write(chunk);
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  const code = await proc.exited;
  const wall = (performance.now() - started) / 1000;
  let read: TestMetric[] = [];
  try {
    read = nameMetrics(parseMetrics(readFileSync(metrics, "utf8")), parseResults(readFileSync(junit, "utf8")));
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  const s = summarize(read, slowest);
  const process_ = proc.resourceUsage();
  const cpu = process_ ? (Number(process_.cpuTime.user) + Number(process_.cpuTime.system)) / 1e6 : s.cpuMs / 1000;
  console.log(`\nnext/${name}: ${s.tests} tests in ${wall.toFixed(1)} s wall, ${cpu.toFixed(1)} s CPU (seed ${seed}); wall time is a metric, it never fails a run`);
  for (const m of s.slowest) console.log(`  ${m.cpuMs.toFixed(0).padStart(6)} ms CPU  ${m.wallMs.toFixed(0).padStart(6)} ms wall  ${relative(ROOT, m.file)}: ${m.name}`);
  return code;
}

async function main(args: string[]) {
  const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const seed = Number(opt("seed") ?? Math.floor(Math.random() * 1e9));
  const tier = opt("tier") ?? "all";
  const slowest = Number(opt("slowest") ?? 5);
  const files = [...new Bun.Glob("next/**/*.test.ts").scanSync({ cwd: ROOT })].sort();
  const { unit, contract } = splitTiers(files);
  let code = 0;
  if (tier === "all" || tier === "unit") code ||= await runTier("unit", unit, seed, slowest);
  if (tier === "all" || tier === "contract") code ||= await runTier("contract", contract, seed, slowest);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
