// `bun run testing walk [--out=dir]`: the walkthrough. Builds the Mac app and the iOS app once
// each, takes the iPhone and iPad locks in a fixed order, and runs walk/main.ts inside them.
// Screenshots at fixed points go to --out (default testing/.walk/shots).

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { builtApp } from "../lib/ios";
import { ensureBuild, BUILD_DIR } from "../ios";
import { reapRuns } from "../lib/procs";

const testing = join(import.meta.dir, "..");
const root = resolve(testing, "..");
const WALK_DIR = join(testing, ".walk");
export const RUNS_DIR = join(WALK_DIR, "runs");

async function sh(cmd: string[], opts: { env?: Record<string, string>; inherit?: boolean } = {}) {
  const p = Bun.spawn(cmd, { cwd: root, env: { ...process.env, ...opts.env } as Record<string, string>, stdout: opts.inherit ? "inherit" : "pipe", stderr: opts.inherit ? "inherit" : "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([p.stdout ? new Response(p.stdout).text() : "", p.stderr ? new Response(p.stderr).text() : "", p.exited]);
  return { code, out, err };
}

/** The sh script that holds the iPhone lock, then the iPad lock, then runs the journey with both UDIDs. */
export function lockChain(journey: string[]): string[] {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const inner = `export WALK_IPAD_UDID=$SIM_UDID; exec ${journey.map(quote).join(" ")}`;
  const outer = `export WALK_IPHONE_UDID=$SIM_UDID; exec bun ios/Tools/sim.ts with-lock --ipad -- sh -c ${quote(inner)}`;
  return ["bun", "ios/Tools/sim.ts", "with-lock", "--", "sh", "-c", outer];
}

export async function walk(argv: string[]): Promise<number> {
  const started = performance.now();
  const lap = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
  const out = resolve(argv.find((a) => a.startsWith("--out="))?.slice(6) ?? join(WALK_DIR, "shots"));
  mkdirSync(RUNS_DIR, { recursive: true });

  const left = await reapRuns(RUNS_DIR);
  if (left.length) console.log(`reaped ${left.length} process(es) a killed run left behind: ${left.map((r) => `${r.name} ${r.pid}`).join(", ")}`);

  const disk = await sh(["bun", "ios/Tools/sim.ts", "disk"]);
  if (disk.code !== 0) {
    console.error(`✗ walk: not enough disk for a simulator build. ${disk.out.trim()}`);
    return 1;
  }

  // Each app is built once, here, and reused for the iPhone and the iPad.
  const mac = await sh(["bun", "run", "--cwd", "app", "build"]);
  if (mac.code !== 0) {
    console.error(`✗ walk: the Mac app build failed\n${(mac.out + mac.err).split("\n").slice(-30).join("\n")}`);
    return 1;
  }
  console.log(`✓ Mac app built [${lap()}]`);
  const built = await ensureBuild();
  if (typeof built === "string") {
    console.error(built);
    return 1;
  }
  console.log(`✓ iOS app ${built.how} [${lap()}]`);

  const chain = lockChain(["bun", join(testing, "walk/main.ts"), `--run-dir=${RUNS_DIR}`, `--out=${out}`, `--app=${builtApp(BUILD_DIR)}`]);
  const child = Bun.spawn(chain, { cwd: root, env: process.env as Record<string, string>, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const code = await child.exited;
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  // A journey that died without its own cleanup leaves its run file: kill what's in it.
  const left2 = await reapRuns(RUNS_DIR);
  if (left2.length) console.log(`killed ${left2.length} process(es) the journey left running`);
  console.log(`walk ${code === 0 ? "passes" : "failed"} [${lap()}]${code === 0 ? ` (screenshots in ${out})` : ""}`);
  return code === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await walk(process.argv.slice(2)));
