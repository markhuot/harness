import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

/** Old-suite code this suite must not import, as repo-relative path prefixes (extension dropped). */
export const FORBIDDEN_OLD_PATHS = [
  "shared/src/testing",
  "service/src/testing/fakes",
  "shared/fixtures",
  "scripts/verify-plan",
  "app/scripts/",
  "ios/Tools/sim-check",
];

/** Folders under testing/ that hold data rather than builders; nothing may import from them. */
export const DATA_DIRS = ["fixtures", "data"];

const scanner = new Bun.Transpiler({ loader: "ts" });

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(path);
    else if (entry.name.endsWith(".test.ts")) yield path;
  }
}

const bare = (path: string) => path.replace(/\.ts$/, "").replace(/\/index$/, "");

/**
 * Every `*.test.ts` under `testingDir` must stand alone: it may import product code, builders,
 * and non-test helpers, but never another test file, a data folder, or the old suite's helpers.
 */
export function lintTestImports(testingDir: string): Violation[] {
  const root = dirname(testingDir);
  const violations: Violation[] = [];
  for (const file of testFiles(testingDir)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    // The transpiler's scan reads real imports only, not import-looking text inside a string.
    for (const { path: specifier } of scanner.scanImports(source)) {
      const line = lines.findIndex((text) => text.includes(`"${specifier}"`) || text.includes(`'${specifier}'`)) + 1;
      const report = (reason: string) => violations.push({ file: relative(root, file), line, specifier, reason });
      if (specifier === "@harness/shared/testing" || specifier.startsWith("@harness/shared/testing/")) {
        report("imports the old suite's helpers");
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = bare(relative(root, resolve(dirname(file), specifier)));
      if (FORBIDDEN_OLD_PATHS.some((old) => target === old || target.startsWith(old))) report("imports the old suite");
      else if (/\.test$/.test(target)) report("imports another test file");
      else if (DATA_DIRS.some((dir) => target === `testing/${dir}` || target.startsWith(`testing/${dir}/`))) report("imports test data; build it in the test");
    }
  }
  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.file}:${v.line}: ${v.reason} ("${v.specifier}")`).join("\n");
}
