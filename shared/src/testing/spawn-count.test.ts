import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { programName, tallySpawns } from "./spawn-count";
import { tempDir } from "./tmp";

describe("programName", () => {
  test("an argv's program, a shell line's first word, and nothing usable as ?", () => {
    expect(programName(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless"])).toBe("Google Chrome");
    expect(programName("  git status --porcelain")).toBe("git");
    expect(programName([])).toBe("?");
    expect(programName(undefined)).toBe("?");
  });
});

test("tallySpawns counts each program's lines and skips blanks", () => {
  expect(tallySpawns("git\nbun\ngit\n\n")).toEqual({ git: 2, bun: 1 });
});

// The seam that matters: a test's own spawns, node:child_process's (which run through Bun.spawn,
// so must not count twice) and a nested bun process's spawns all land in one log.
test("the preload counts Bun.spawn, child_process and a nested bun's spawns, each once", async () => {
  const dir = tempDir("harness-spawn-count-");
  const log = join(dir, "spawns.log");
  const script = join(dir, "script.ts");
  await Bun.write(
    script,
    `import { execFileSync, spawnSync } from "node:child_process";
await Bun.spawn(["true"]).exited;
Bun.spawnSync(["/usr/bin/true"]);
spawnSync("true");
execFileSync("true");
await Bun.spawn({ cmd: ["true"] }).exited;
await Bun.spawn([process.execPath, "-e", "Bun.spawnSync(['echo'])"], { stdout: "ignore" }).exited;
`,
  );
  const env = { ...process.env, HARNESS_SPAWN_LOG: log, BUN_OPTIONS: `--preload=${join(import.meta.dir, "spawn-count.ts")}` };
  const proc = Bun.spawn([process.execPath, script], { env, stdout: "ignore", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  expect(tallySpawns(readFileSync(log, "utf8"))).toEqual({ true: 5, bun: 1, echo: 1 });
});
