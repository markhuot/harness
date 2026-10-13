// `bun run nightly`: the full regression pass the Harness "nightly" watcher runs once a day.
// Unlike `bun run verify` (which maps a diff to layers), it runs everything: bun tests, typecheck,
// `swift test`, every app/scripts check against a fresh renderer build, and the full sim-check
// walk-through (`--shards=2`). sim-check takes the shared simulator lock itself, and the simulator
// layer is skipped (and reported) when `bun run sim disk` says there isn't room.
//
// Output is for the watcher's triage agent: all green prints nothing on stdout and exits 4 ("nothing
// to report" for a watcher), with one line on stderr for people running it by hand. Any failure
// prints a report on stdout (layer, check names, log tail) and exits 0, since a failing layer is the
// report, not a watcher error. A bad flag or a crash of this script exits 2/1 so the watcher shows it.
//
//   bun run nightly [--only=<layer id>,…] [--list]

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appCheck, simCheck, type Layer } from "./verify-plan";

const root = resolve(import.meta.dir, "..");
const BUN = "bun";
const LOG_TAIL_LINES = 40;
const MAX_CHECK_NAMES = 12;

export interface LayerResult {
  layer: Layer;
  /** Exit code, or null when the layer was skipped. */
  code: number | null;
  output: string;
  ms: number;
  /** Why the layer didn't run (low disk, the build it needs failed). */
  skipped?: string;
}

/** The layers of a nightly, in run order. `appChecks` are the file names under app/scripts (no extension). */
export function nightlyLayers(appChecks: string[]): Layer[] {
  return [
    { id: "bun:all", title: "bun tests (every package)", cmd: [BUN, "run", "test"], kind: "light" },
    { id: "typecheck", title: "typecheck (tsc, all projects)", cmd: [BUN, "run", "typecheck"], kind: "light" },
    { id: "swift-test", title: "swift test (HarnessKit)", cmd: ["swift", "test", "--package-path", "ios/HarnessKit"], kind: "light" },
    { id: "app-build", title: "build the Mac app renderer", cmd: [BUN, "run", "--cwd", "app", "build"], kind: "app" },
    ...appChecks.map(appCheck),
    simCheck(["--shards=2"], "(full walk-through, 2 shards)"),
  ];
}

/** `smoke` plus every app/scripts/*-check.ts, the same set `verify --all` runs. */
export function listAppChecks(dir = join(root, "app", "scripts")): string[] {
  const checks = readdirSync(dir)
    .filter((f) => f.endsWith("-check.ts"))
    .map((f) => f.slice(0, -3))
    .sort();
  return ["smoke", ...checks];
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/**
 * The names of what failed inside one layer's log: `✗ name` lines (sim-check and the app checks),
 * `(fail) name` lines (bun test) and `error TSnnnn` lines (tsc). Deduplicated, in log order; empty
 * when the log names none (the report then falls back to the log tail alone).
 */
export function failedChecks(output: string): string[] {
  const names: string[] = [];
  const add = (n: string) => {
    const name = n.trim();
    if (name && !names.includes(name)) names.push(name);
  };
  for (const raw of strip(output).split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^✗\s+(.+)$/))) add(m[1]);
    else if ((m = line.match(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+ms\])?$/))) add(m[1]);
    else if ((m = line.match(/^(\S+\.tsx?)\(\d+,\d+\): error (TS\d+)/))) add(`${m[1]} ${m[2]}`);
  }
  return names;
}

export const failed = (r: LayerResult) => r.skipped !== undefined || (r.code !== null && r.code !== 0);

const tail = (output: string, n = LOG_TAIL_LINES) => strip(output).trim().split("\n").slice(-n).join("\n");

/** The report the watcher prints, or "" when every layer ran and passed. */
export function formatReport(results: LayerResult[], date = new Date()): string {
  const bad = results.filter(failed);
  if (!bad.length) return "";
  const lines = [
    `Harness nightly ${date.toISOString().slice(0, 10)}: ${bad.length} of ${results.length} layers failed: ${bad.map((r) => r.layer.id).join(", ")}`,
  ];
  for (const r of bad) {
    lines.push("", `## ${r.layer.id}: ${r.layer.title}`);
    if (r.skipped !== undefined) {
      lines.push(`Skipped: ${r.skipped}`);
      continue;
    }
    lines.push(`Exit ${r.code}. Rerun: ${r.layer.cmd.join(" ")}`);
    const names = failedChecks(r.output);
    if (names.length) {
      const shown = names.slice(0, MAX_CHECK_NAMES);
      lines.push(`Failing checks: ${shown.join("; ")}${names.length > shown.length ? `; +${names.length - shown.length} more` : ""}`);
    }
    lines.push("Log tail:", "```", tail(r.output) || "(no output)", "```");
  }
  return lines.join("\n");
}

async function run(cmd: string[]): Promise<{ code: number; output: string }> {
  const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer" };
  let output = "";
  try {
    const proc = Bun.spawn(cmd, { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) output += Buffer.from(chunk).toString();
    };
    const [, , code] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
    return { code, output };
  } catch (e) {
    return { code: 127, output: `${cmd[0]} could not run: ${(e as Error).message}` };
  }
}

export function parseArgs(argv: string[]): { only: string[] | null; list: boolean } {
  let only: string[] | null = null;
  let list = false;
  for (const a of argv) {
    if (a === "--list") list = true;
    else if (a.startsWith("--only=")) only = a.slice(7).split(",").filter(Boolean);
    else throw new Error(`unknown option ${a}; usage: nightly [--only=<layer id>,…] [--list]`);
  }
  return { only, list };
}

async function main(argv: string[]): Promise<number> {
  const { only, list } = parseArgs(argv);
  let layers = nightlyLayers(listAppChecks());
  if (only) layers = layers.filter((l) => only.includes(l.id));
  if (list) {
    for (const l of layers) console.log(`${l.id}\t${l.cmd.join(" ")}`);
    return 0;
  }

  const results: LayerResult[] = [];
  let buildFailed = false;
  for (const layer of layers) {
    const started = performance.now();
    const done = (r: Omit<LayerResult, "layer" | "ms">) => results.push({ layer, ms: performance.now() - started, ...r });
    if (layer.kind === "app" && layer.id !== "app-build" && buildFailed) {
      done({ code: null, output: "", skipped: "the app renderer build failed" });
      continue;
    }
    if (layer.kind === "sim") {
      const disk = await run([BUN, "run", "sim", "disk"]);
      if (disk.code !== 0) {
        done({ code: null, output: disk.output, skipped: `not enough free disk for the simulator (${tail(disk.output, 3).replace(/\n/g, " | ")})` });
        continue;
      }
    }
    const r = await run(layer.cmd);
    if (layer.id === "app-build" && r.code !== 0) buildFailed = true;
    done(r);
  }

  const report = formatReport(results);
  if (!report) {
    console.error(`nightly: all green (${results.length} layers)`);
    return 4;
  }
  console.log(report);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
