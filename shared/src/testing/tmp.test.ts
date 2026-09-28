import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, onTempCleanup, tempDir, trackedTempDirs } from "./tmp";

describe("tempDir", () => {
  test("cleanup closes registered resources while their dirs still exist, then removes the dirs", async () => {
    const a = tempDir("harness-tmp-test-");
    const b = tempDir("harness-tmp-test-");
    mkdirSync(join(a, "nested", "deep"), { recursive: true });
    writeFileSync(join(a, "nested", "deep", "harness.db-wal"), "x");
    const order: string[] = [];
    onTempCleanup(() => order.push(`first:${existsSync(a)}`));
    onTempCleanup(async () => {
      await Bun.sleep(1);
      order.push(`second:${existsSync(b)}`);
    });

    await cleanupTempDirs();

    expect(order).toEqual(["second:true", "first:true"]);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(trackedTempDirs()).not.toContain(a);
  });

  test("a failing closer doesn't stop the others or the removal, and closers run only once", async () => {
    const dir = tempDir("harness-tmp-test-");
    let calls = 0;
    onTempCleanup(() => calls++);
    onTempCleanup(() => {
      throw new Error("boom");
    });
    const origError = console.error;
    console.error = () => {};
    try {
      await cleanupTempDirs();
    } finally {
      console.error = origError;
    }
    expect(calls).toBe(1);
    expect(existsSync(dir)).toBe(false);

    await cleanupTempDirs();
    expect(calls).toBe(1);
  });

  test("dirs left behind are removed when the process exits", async () => {
    const script = `
      import { tempDir } from ${JSON.stringify(join(import.meta.dir, "tmp.ts"))};
      console.log(tempDir("harness-tmp-exit-"));
      process.exit(0);
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
    const dir = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(dir).toContain("harness-tmp-exit-");
    expect(existsSync(dir)).toBe(false);
  });
});
