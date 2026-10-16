// `bun run testing stress`: the fast layers (L0–L2) again and again, each round shuffled with its
// own printed seed, several rounds at once. A failure prints its seed so it replays with
// `bun test --randomize --seed <seed>` from testing/. Nothing is retried.

export interface StressOptions {
  rounds: number;
  parallel: number;
  /** The first seed; round n uses seed + n */
  seed: number;
  cwd: string;
  /** Extra args for `bun test` (a path filter, say) */
  testArgs?: string[];
}

export interface RoundResult {
  seed: number;
  code: number;
  output: string;
}

async function round(seed: number, opts: StressOptions): Promise<RoundResult> {
  const proc = Bun.spawn(["bun", "test", "--randomize", "--seed", String(seed), ...(opts.testArgs ?? [])], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { seed, code, output: (out + err).trim() };
}

/** Run every round, `parallel` at a time, and report each as it finishes. */
export async function stress(opts: StressOptions, report: (r: RoundResult) => void = () => {}): Promise<RoundResult[]> {
  const seeds = Array.from({ length: opts.rounds }, (_, n) => opts.seed + n);
  const results: RoundResult[] = [];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.parallel, seeds.length)) }, async () => {
    for (let seed = seeds.shift(); seed !== undefined; seed = seeds.shift()) {
      const result = await round(seed, opts);
      results.push(result);
      report(result);
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.seed - b.seed);
}
