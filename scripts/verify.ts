// `bun run verify`: runs the test layers your diff needs, and only those.
//
//   bun run verify [--dry-run] [--all] [--base=<ref>] [--files=a,b]
//
//   (no flag)    diff the working tree against `git merge-base <base> HEAD` (default base: main, then
//                origin/main), map the changed files to layers (scripts/verify-plan.ts) and run them
//   --dry-run    print the plan and why each layer is in it; run nothing
//   --all        every layer, whatever changed
//   --base=ref   diff against another branch (a ticket stacked on a parent branch, say)
//   --files=a,b  plan for these paths instead of the git diff (a synthetic diff, for trying the mapping)
//
// Light layers (bun tests, typecheck, swift test) run at once; the Mac app checks follow one at a time,
// then the simulator layers, after `bun run sim disk` says there is room. the walkthrough and the snapshot
// tests take the simulator lock themselves, so a layer holds it only while it runs. Each layer ends
// in one summary line; a failing layer's output is printed, and the exit code is 1 if any failed.
// To iterate on one simulator screen, run `bun run walk:ios --only=<screen> --no-build`.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./run-layer";
import { allLayers, newTestsInOldDirs, planLayers, type PlannedLayer } from "./verify-plan";

const root = join(import.meta.dir, "..");

export interface VerifyOptions {
  dryRun: boolean;
  all: boolean;
  base?: string;
  files?: string[];
}

export function parseArgs(argv: string[]): VerifyOptions {
  const o: VerifyOptions = { dryRun: false, all: false };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--all") o.all = true;
    else if (a.startsWith("--base=")) o.base = a.slice(7);
    else if (a.startsWith("--files=")) o.files = a.slice(8).split(",").filter(Boolean);
    else throw new Error(`unknown option ${a}; usage: verify [--dry-run] [--all] [--base=<ref>] [--files=a,b]`);
  }
  return o;
}

async function git(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out: out.trim() };
}

/** Files changed since `base` branched off, committed or not, plus untracked ones. */
async function changedFiles(base?: string): Promise<{ files: string[]; added: string[]; base: string }> {
  let ref = base;
  if (!ref) for (const c of ["main", "origin/main"]) if ((await git(["rev-parse", "--verify", "--quiet", c])).code === 0) { ref = c; break; }
  if (!ref) throw new Error("no main or origin/main to diff against; pass --base=<ref>");
  const mb = await git(["merge-base", ref, "HEAD"]);
  if (mb.code !== 0) throw new Error(`no merge base between ${ref} and HEAD`);
  const [diff, added, untracked] = await Promise.all([git(["diff", "--name-only", mb.out]), git(["diff", "--name-only", "--diff-filter=A", mb.out]), git(["ls-files", "--others", "--exclude-standard"])]);
  const files = [...new Set([...diff.out.split("\n"), ...untracked.out.split("\n")].filter(Boolean))].sort();
  return { files, added: [...new Set([...added.out.split("\n"), ...untracked.out.split("\n")].filter(Boolean))].sort(), base: `${ref} (${mb.out.slice(0, 8)})` };
}

export function formatPlan(layers: PlannedLayer[], notes: string[]): string {
  const lines = layers.map((l) => `  ${l.kind === "sim" ? "🔬" : l.kind === "app" ? "🖥 " : "⚡"} ${l.title}\n      $ ${l.cmd.join(" ")}\n      why: ${l.reasons.slice(0, 4).join("; ")}${l.reasons.length > 4 ? `; +${l.reasons.length - 4} more` : ""}`);
  return [...lines, ...notes.map((n) => `  ${n}`)].join("\n");
}

interface Result {
  layer: PlannedLayer;
  code: number;
  output: string;
  ms: number;
}

async function runLayer(layer: PlannedLayer, stream: boolean): Promise<Result> {
  const started = performance.now();
  const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer" };
  const r = await runCommand(layer.cmd, { cwd: root, env, onOutput: stream ? (t) => process.stdout.write(t) : undefined });
  return { layer, code: r.code, output: r.output, ms: performance.now() - started };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function report(r: Result): void {
  console.log(`${r.code === 0 ? "✅" : "❌"} ${r.layer.title} [${seconds(r.ms)}]`);
  if (r.code !== 0) console.log(`${r.output.trim().split("\n").slice(-60).join("\n")}\n   (exit ${r.code}; rerun: ${r.layer.cmd.join(" ")})\n`);
}

async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  let layers: PlannedLayer[];
  let notes: string[] = [];
  if (opts.all) {
    const checks = readdirSync(join(root, "app/scripts")).filter((f) => /-check\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ""));
    layers = allLayers(["smoke", ...checks]);
    console.log("verify --all");
  } else {
    const { files, added, base } = opts.files ? { files: opts.files, added: [] as string[], base: "--files" } : await changedFiles(opts.base);
    const stray = newTestsInOldDirs(added);
    if (stray.length) {
      console.log(`❌ new test files in the old suite's directories (write them under next/ instead):\n${stray.map((f) => `  ${f}`).join("\n")}`);
      return 1;
    }
    const plan = planLayers(files);
    layers = plan.layers;
    notes = plan.notes;
    console.log(`verify: ${files.length} changed file${files.length === 1 ? "" : "s"} against ${base}`);
  }
  console.log(`${layers.length ? "plan:" : "plan: nothing to run"}\n${formatPlan(layers, notes)}\n`);
  if (opts.dryRun || !layers.length) return 0;

  const results: Result[] = [];
  const light = layers.filter((l) => l.kind === "light");
  const batch = await Promise.all(light.map((l) => runLayer(l, false)));
  for (const r of batch) {
    report(r);
    results.push(r);
  }
  for (const layer of layers.filter((l) => l.kind === "app")) {
    const r = await runLayer(layer, false);
    report(r);
    results.push(r);
    if (r.code !== 0 && layer.id === "app-build") break;
  }
  const sims = layers.filter((l) => l.kind === "sim");
  if (sims.length) {
    const disk = await runLayer({ id: "sim-disk", title: "simulator disk check", cmd: ["bun", "run", "sim", "disk"], kind: "light", reasons: [] }, false);
    report(disk);
    results.push(disk);
    if (disk.code === 0) {
      for (const layer of sims) {
        const r = await runLayer(layer, true);
        report(r);
        results.push(r);
      }
    } else console.log("   simulator layers skipped: free disk space first, or ask the human\n");
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(failed.length ? `❌ ${failed.length} of ${results.length} layers failed: ${failed.map((r) => r.layer.id).join(", ")}` : `✅ ${results.length} layers pass`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
