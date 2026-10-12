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
