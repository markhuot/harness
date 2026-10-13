import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "./verify";

describe("parseArgs", () => {
  test("reads each flag", () => {
    expect(parseArgs(["--dry-run", "--all", "--base=harness/x", "--files=a.ts,b.ts"])).toEqual({ dryRun: true, all: true, base: "harness/x", files: ["a.ts", "b.ts"] });
  });

  test("an unknown flag is an error that shows the usage, so a typo never runs a partial plan", () => {
    expect(() => parseArgs(["--dryrun"])).toThrow(/usage: verify/);
  });
});

describe("verify --dry-run (the real CLI)", () => {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "verify.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  };

  test("prints the plan for a synthetic diff and runs nothing", async () => {
    const { out, code } = await run("--dry-run", "--files=service/src/x.ts,docs/unknown.bin");
    expect(code).toBe(0);
    expect(out).toContain("bun tests (every package)");
    expect(out).toContain("docs/unknown.bin: no rule for the file");
  });

  test("a docs-only diff has nothing to run", async () => {
    const { out, code } = await run("--files=README.md");
    expect(code).toBe(0);
    expect(out).toContain("nothing to run");
  });

  test("a bad flag exits 2", async () => {
    expect((await run("--nope")).code).toBe(2);
  });
});
