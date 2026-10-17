import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Exclusion } from "./exclusions";

const scanner = new Bun.Transpiler({ loader: "ts" });

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** What a module can be imported as: its path without `.ts`, and a folder's `index` as the folder. */
const bare = (path: string) => path.replace(/\.ts$/, "");

/** The repo-relative modules each file under `dir` imports by a relative path. */
function importsOf(root: string, file: string): Set<string> {
  const out = new Set<string>();
  for (const { path } of scanner.scanImports(readFileSync(file, "utf8"))) {
    if (!path.startsWith(".")) continue;
    const target = bare(relative(root, resolve(dirname(file), path)));
    out.add(target);
    out.add(`${target}/index`);
  }
  return out;
}

/** Product modules that count: not tests, not fixtures, snapshots or test dirs. */
export function productModules(root: string): string[] {
  return [...tsFiles(join(root, "service/src"))]
    .map((f) => relative(root, f))
    .filter((f) => !f.endsWith(".test.ts") && !f.includes("/testing/") && !f.includes("__fixtures__") && !f.includes("__snapshots__"))
    .sort();
}

/**
 * Every way the service's modules and this list can disagree. A module needs a direct import from
 * a file under `testsDir` or a listing in `exclusions`; a listing needs a reason, a layer, an
 * existing module that no test imports (or, with `via`, one a tested module imports).
 */
export function coverageProblems(root: string, testsDir: string, exclusions: Exclusion[]): string[] {
  const modules = productModules(root);
  const imported = new Set<string>();
  for (const file of tsFiles(testsDir)) for (const target of importsOf(root, file)) imported.add(target);
  const isImported = (file: string) => imported.has(bare(file));
  const listed = new Map(exclusions.map((e) => [e.file, e]));
  const problems: string[] = [];

  for (const file of modules) {
    if (!isImported(file) && !listed.has(file)) problems.push(`${file}: no test imports it and it isn't in exclusions.ts`);
  }
  const seen = new Set<string>();
  for (const e of exclusions) {
    if (seen.has(e.file)) problems.push(`${e.file}: listed twice in exclusions.ts`);
    seen.add(e.file);
    if (!e.reason.trim() || !e.layer.trim()) problems.push(`${e.file}: an exclusion needs a reason and the layer that owns it`);
    if (!modules.includes(e.file)) {
      problems.push(`${e.file}: listed in exclusions.ts but it isn't a service module (deleted or renamed?)`);
      continue;
    }
    if (e.via) {
      if (!isImported(e.via)) problems.push(`${e.file}: via ${e.via}, which no test imports`);
      else if (!importsOf(root, join(root, e.via)).has(bare(e.file))) problems.push(`${e.file}: via ${e.via}, which doesn't import it`);
    } else if (isImported(e.file)) {
      problems.push(`${e.file}: listed in exclusions.ts but a test imports it now; remove the listing`);
    }
  }
  return problems;
}
