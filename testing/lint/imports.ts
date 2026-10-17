import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

/** Folders under testing/ that hold data rather than builders; nothing may import from them. */
export const DATA_DIRS = ["fixtures", "data"];

const scanner = new Bun.Transpiler({ loader: "ts" });

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

const bare = (path: string) => path.replace(/\.ts$/, "").replace(/\/index$/, "");

/**
 * Every `.ts` file under `testingDir` (tests and builders alike, since a builder's imports reach
 * every test) must stand alone: it may import product code, builders, and non-test helpers, but
 * never a test file or a data folder.
 */
export function lintTestImports(testingDir: string): Violation[] {
  const root = dirname(testingDir);
  const violations: Violation[] = [];
  for (const file of sourceFiles(testingDir)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    // The transpiler's scan reads real imports only, not import-looking text inside a string.
    for (const { path: specifier } of scanner.scanImports(source)) {
      const line = lines.findIndex((text) => text.includes(`"${specifier}"`) || text.includes(`'${specifier}'`)) + 1;
      const report = (reason: string) => violations.push({ file: relative(root, file), line, specifier, reason });
      if (!specifier.startsWith(".")) continue;
      const target = bare(relative(root, resolve(dirname(file), specifier)));
      if (/\.test$/.test(target)) report("imports another test file");
      else if (DATA_DIRS.some((dir) => target === `testing/${dir}` || target.startsWith(`testing/${dir}/`))) report("imports test data; build it in the test");
    }
  }
  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.file}:${v.line}: ${v.reason} ("${v.specifier}")`).join("\n");
}
