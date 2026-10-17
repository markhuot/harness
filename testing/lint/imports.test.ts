import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../builders/tmp";
import { lintTestImports } from "./imports";

/** A repo-shaped temp dir holding `files` (paths relative to the repo); returns its testing/ dir. */
function repo(files: Record<string, string>): string {
  const root = tempDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return join(root, "testing");
}

describe("lintTestImports", () => {
  test("fails a test file that imports another test file's data", () => {
    const dir = repo({
      "testing/a.test.ts": `export const shared = { name: "x" };\n`,
      "testing/b.test.ts": `import { shared } from "./a.test";\n`,
    });
    const found = lintTestImports(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "testing/b.test.ts", line: 1, specifier: "./a.test", reason: "imports another test file" });
  });

  test("catches the .ts extension, a dynamic import and a re-export", () => {
    const dir = repo({
      "testing/a.test.ts": ``,
      "testing/b.test.ts": `import { x } from "./a.test.ts";\n`,
      "testing/c.test.ts": `const m = await import("./a.test");\n`,
      "testing/d.test.ts": `export * from "./a.test";\n`,
    });
    expect(lintTestImports(dir).map((v) => v.file).sort()).toEqual(["testing/b.test.ts", "testing/c.test.ts", "testing/d.test.ts"]);
  });

  test("passes tests that import builders, helpers and product code", () => {
    const dir = repo({
      "testing/builders/ticket.ts": ``,
      "testing/helper.ts": ``,
      "service/src/thing.ts": ``,
      "testing/a.test.ts": `import { makeTicket } from "./builders/ticket";\nimport { h } from "./helper";\nimport { t } from "../service/src/thing";\nimport { test } from "bun:test";\n`,
      "testing/sub/b.test.ts": `import { makeTicket } from "../builders/ticket";\n`,
    });
    expect(lintTestImports(dir)).toEqual([]);
  });

  test("fails an import from a data folder", () => {
    const dir = repo({
      "testing/fixtures/world.ts": ``,
      "testing/a.test.ts": `import { world } from "./fixtures/world";\n`,
    });
    expect(lintTestImports(dir).map((v) => v.reason)).toEqual(["imports test data; build it in the test"]);
  });

  test("scans helpers too, since a helper's import reaches every test", () => {
    const dir = repo({
      "testing/a.test.ts": ``,
      "testing/helper.ts": `import { x } from "./a.test";\n`,
    });
    expect(lintTestImports(dir)).toMatchObject([{ file: "testing/helper.ts", reason: "imports another test file" }]);
  });

  test("the real testing/ tree is clean", () => {
    expect(lintTestImports(join(import.meta.dir, ".."))).toEqual([]);
  });
});
