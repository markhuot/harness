// `bun run typecheck`: the seven tsc projects, all at once instead of one after another. Prints
// each project's errors under its name and exits 1 if any failed (or tsc couldn't run).

import { existsSync } from "node:fs";
import { join } from "node:path";

export const PROJECTS = ["service", "editor", "app", "plugins", "plugins/tsconfig.server.json", "ios", "release"];

const root = join(import.meta.dir, "..");
const tsc = [join(root, "node_modules/.bin/tsc")];
if (!existsSync(tsc[0]!)) tsc.splice(0, 1, "bunx", "tsc");

/** Run `tsc -p project --noEmit`; its exit code and combined output. */
export async function check(project: string): Promise<{ project: string; code: number; output: string; ms: number }> {
  const started = performance.now();
  const proc = Bun.spawn([...tsc, "-p", project, "--noEmit", "--pretty", "false"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { project, code, output: (out + err).trim(), ms: performance.now() - started };
}

async function main(): Promise<number> {
  const started = performance.now();
  const results = await Promise.all(PROJECTS.map(check));
  for (const r of results) {
    console.log(`${r.code === 0 ? "✓" : "✗"} tsc -p ${r.project} [${(r.ms / 1000).toFixed(1)}s]`);
    if (r.code !== 0) console.log(r.output ? `${r.output}\n` : `(tsc exited ${r.code} with no output)\n`);
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(`${failed.length ? `${failed.length} of ${results.length} projects failed` : `${results.length} projects pass`}. [${((performance.now() - started) / 1000).toFixed(1)}s]`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
