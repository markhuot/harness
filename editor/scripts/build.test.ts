import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./build";

test("the web view bundle is one IIFE that exposes mount and the editors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "editor-build-"));
  try {
    const file = await build(join(dir, "editor.js"));
    const code = readFileSync(file, "utf8");
    const g = new Function(`${code}; return HarnessEditor;`)() as Record<string, unknown>;
    expect(typeof g.mount).toBe("function");
    expect(typeof g.createEditor).toBe("function");
    expect(typeof g.createDiffEditor).toBe("function");
    expect(code).not.toMatch(/^import |^export /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("--out writes the bundle to the given file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "editor-build-out-"));
  try {
    const out = join(dir, "nested.js");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "build.ts"), "--out", out], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(readFileSync(out, "utf8").length).toBeGreaterThan(1000);
    const bad = Bun.spawn(["bun", join(import.meta.dir, "build.ts"), "--out"], { stdout: "pipe", stderr: "pipe" });
    expect(await bad.exited).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
