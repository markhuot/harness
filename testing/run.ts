// `bun run testing <cmd>`: the one entry point of the test suite.
//   stress  L0–L2 repeatedly, shuffled, in parallel   (--rounds=N --parallel=M --seed=S)
//   ios     the iPhone/iPad layer                       (not built yet: fails)
//   walk    the walkthrough                             (not built yet: fails)
//   lint    the test-import lint
//   (none)  the full gate: lint, L0–L2, ios, walk. Nothing lands on main until it passes.

import { cpus } from "node:os";
import { join } from "node:path";
import { formatViolations, lintTestImports } from "./lint/imports";
import { stress } from "./stress";

const dir = import.meta.dir;

const STUBS: Record<string, string> = {
  ios: "`testing ios` isn't built yet: the iPhone/iPad layer lands in a later ticket of HARNESS-529.",
  walk: "`testing walk` isn't built yet: the walkthrough lands in a later ticket of HARNESS-529.",
};

function flag(args: string[], name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : fallback;
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number`);
  return n;
}

function lint(): number {
  const violations = lintTestImports(dir);
  if (violations.length === 0) {
    console.log("✓ lint: no test file imports another's data");
    return 0;
  }
  console.error(`✗ lint\n${formatViolations(violations)}`);
  return 1;
}

async function unit(): Promise<number> {
  const proc = Bun.spawn(["bun", "test"], { cwd: dir, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return proc.exited;
}

async function runStress(args: string[]): Promise<number> {
  const rounds = flag(args, "rounds", 10);
  const parallel = flag(args, "parallel", Math.max(2, Math.min(4, cpus().length)));
  const seed = flag(args, "seed", Math.floor(Math.random() * 1_000_000));
  console.log(`stress: ${rounds} rounds, ${parallel} at a time, seeds ${seed}..${seed + rounds - 1}`);
  const results = await stress({ rounds, parallel, seed, cwd: dir }, (r) => console.log(`${r.code === 0 ? "✓" : "✗"} seed ${r.seed}`));
  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) console.error(`\n--- seed ${r.seed} (replay: cd testing && bun test --randomize --seed ${r.seed})\n${r.output}`);
  console.log(failed.length ? `${failed.length} of ${rounds} rounds failed` : `${rounds} rounds pass`);
  return failed.length ? 1 : 0;
}

export async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (cmd === undefined) {
    const steps: [string, () => number | Promise<number>][] = [
      ["lint", lint],
      ["L0–L2", unit],
      ["ios", () => run("ios")],
      ["walk", () => run("walk")],
    ];
    const failed: string[] = [];
    for (const [name, step] of steps) if ((await step()) !== 0) failed.push(name);
    console.log(failed.length ? `gate failed: ${failed.join(", ")}` : "gate passed");
    return failed.length ? 1 : 0;
  }
  return run(cmd, rest);
}

async function run(cmd: string, args: string[] = []): Promise<number> {
  if (cmd in STUBS) {
    console.error(STUBS[cmd]);
    return 1;
  }
  if (cmd === "stress") return runStress(args);
  if (cmd === "lint") return lint();
  console.error(`Unknown command "${cmd}". Commands: stress, ios, walk, lint (none runs the full gate).`);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
