// `bun run testing <cmd>`: the one entry point of the test suite.
//   l0      logic tests: bun (testing/l0) and Swift (testing/swift) side by side, each timed
//   mac     L4 Mac: React views under happy-dom against the shared world (testing/mac)
//   stress  L0–L2 repeatedly, shuffled, in parallel   (--rounds=N --parallel=M --seed=S)
//   ios     L4 iPhone and iPad screens from the world   (--iphone --ipad --only=Class/test --record --out=dir; see ios.ts)
//   walk    the walkthrough                             (not built yet: fails)
//   lint    the test-import lint
//   (none)  the full gate: lint, L0, L1–L2, ios, walk. Nothing lands on main until it passes.

import { cpus } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatViolations, lintTestImports } from "./lint/imports";
import { ios } from "./ios";
import { stress } from "./stress";

const dir = import.meta.dir;

const STUBS: Record<string, string> = {
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

/** Every bun test outside L0 (L0 has its own step, with the Swift package). */
async function unit(): Promise<number> {
  const proc = Bun.spawn(["bun", "test", "--path-ignore-patterns=l0/**", "--path-ignore-patterns=mac/**"], { cwd: dir, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return proc.exited;
}

/** Run `cmd` to the end, streaming nothing; its exit code, combined output and wall time. */
async function timed(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const started = performance.now();
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: (out + err).trim(), seconds: (performance.now() - started) / 1000 };
}

/** L4 Mac: the React views under happy-dom. Its own bun process and bunfig (the DOM globals would leak into the service tests). */
async function mac(): Promise<number> {
  const r = await timed(["bun", "test"], join(dir, "mac"));
  console.log(`${r.code === 0 ? "✓" : "✗"} L4 Mac [${r.seconds.toFixed(1)}s]`);
  if (r.code !== 0) console.log(r.output);
  return r.code === 0 ? 0 : 1;
}

/** The Xcode the Simulators rules in CLAUDE.md pin, when it's installed; else whatever `swift` resolves. */
function developerDir(): Record<string, string> {
  const pinned = "/Applications/Xcode-27.0.0.app/Contents/Developer";
  return process.env.DEVELOPER_DIR || !existsSync(pinned) ? {} : { DEVELOPER_DIR: pinned };
}

/** L0: the bun logic tests and the Swift package, in parallel. No simulator, no Electron. */
async function l0(): Promise<number> {
  const started = performance.now();
  const [bun, swift] = await Promise.all([
    timed(["bun", "test", "l0"], dir),
    // ContractTests (L3) need the fixtures contract/swift.test.ts writes, so that wrapper runs them.
    timed(["swift", "test", "--package-path", join(dir, "swift"), "--skip", "ContractTests"], dir, developerDir()),
  ]);
  const failed: string[] = [];
  for (const [name, r] of [["bun l0", bun], ["swift", swift]] as const) {
    console.log(`${r.code === 0 ? "✓" : "✗"} L0 ${name} [${r.seconds.toFixed(1)}s]`);
    if (r.code !== 0) {
      console.log(r.output);
      failed.push(name);
    }
  }
  console.log(`L0 ${failed.length ? `failed: ${failed.join(", ")}` : "passes"} [${((performance.now() - started) / 1000).toFixed(1)}s]`);
  return failed.length ? 1 : 0;
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
      ["L0", l0],
      ["L1–L2", unit],
      ["L4 Mac", mac],
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
  if (cmd === "l0") return l0();
  if (cmd === "mac") return mac();
  if (cmd === "ios") {
    try {
      return await ios(args);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }
  console.error(`Unknown command "${cmd}". Commands: l0, mac, stress, ios, walk, lint (none runs the full gate).`);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
