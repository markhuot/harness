import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./builders/tmp";
import { stress } from "./stress";

async function runner(...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "run.ts"), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

describe("runner", () => {
  test("ios refuses an option it doesn't know before it touches a simulator", async () => {
    const r = await runner("ios", "--bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown option --bogus");
  });

  test("an unknown command fails and lists the real ones", async () => {
    const r = await runner("nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("stress, ios, walk, lint, queue, fast");
  });

  test("lint passes on the real tree", async () => {
    expect((await runner("lint")).code).toBe(0);
  });
});

describe("stress", () => {
  const project = (test: string) => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "x.test.ts"), `import { test, expect } from "bun:test";\ntest("x", () => { ${test} });\n`);
    return cwd;
  };

  test("runs every round on its own consecutive seed, in parallel", async () => {
    const seen: number[] = [];
    const results = await stress({ rounds: 4, parallel: 2, seed: 100, cwd: project("expect(1).toBe(1)") }, (r) => seen.push(r.seed));
    expect(results.map((r) => [r.seed, r.code])).toEqual([[100, 0], [101, 0], [102, 0], [103, 0]]);
    expect(seen.sort()).toEqual([100, 101, 102, 103]);
  });

  test("a failing test fails every round that ran it, with its output kept for the replay", async () => {
    const results = await stress({ rounds: 2, parallel: 2, seed: 7, cwd: project("expect(1).toBe(2)") });
    expect(results.every((r) => r.code !== 0)).toBe(true);
    expect(results[0]!.output).toContain("Expected: 2");
  });

  test("shuffling exposes tests that depend on order", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "order.test.ts"),
      [
        `import { test, expect } from "bun:test";`,
        `let ready = false;`,
        `test("a", () => { ready = true; });`,
        `test("b", () => { expect(ready).toBe(true); });`,
        `test("c", () => { expect(ready).toBe(true); });`,
        `test("d", () => { expect(ready).toBe(true); });`,
      ].join("\n"),
    );
    const results = await stress({ rounds: 12, parallel: 4, seed: 1, cwd });
    // Declaration order passes; some shuffles put "a" after a reader.
    expect(results.some((r) => r.code !== 0)).toBe(true);
  });
});
