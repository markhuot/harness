// Writes the JSON the native iOS app is checked against:
//   shared/fixtures/cases/<module>.ts     → ios/HarnessKit/Tests/HarnessKitTests/Fixtures/<module>.json
//   shared/fixtures/resources/<name>.ts   → ios/HarnessKit/Sources/HarnessKit/Resources/<name>.json
// Each output is `{ "<export>": value }` for every named export of the source file (promises are
// awaited). Files are discovered by directory, so adding a module means adding a file, no registry.
//
//   bun shared/scripts/export-fixtures.ts
//
// shared/src/fixtures.test.ts rebuilds everything in memory and fails when the committed JSON is stale.

import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

export const FIXTURE_SOURCES = [
  { from: join(ROOT, "shared/fixtures/cases"), to: join(ROOT, "ios/HarnessKit/Tests/HarnessKitTests/Fixtures") },
  { from: join(ROOT, "shared/fixtures/resources"), to: join(ROOT, "ios/HarnessKit/Sources/HarnessKit/Resources") },
] as const;

/** Stable JSON: two-space indent, trailing newline. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

/** Absolute output path → file contents, for every source file. */
export async function buildFixtures(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { from, to } of FIXTURE_SOURCES) {
    for (const file of sourceFiles(from)) {
      const mod = (await import(join(from, file))) as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      for (const name of Object.keys(mod).sort()) {
        if (name === "default") continue;
        data[name] = await mod[name];
      }
      out.set(join(to, basename(file, ".ts") + ".json"), serialize(data));
    }
  }
  return out;
}

/** Generated JSON files on disk that no source file produces any more. */
export function orphanedFixtures(built: Map<string, string>): string[] {
  const orphans: string[] = [];
  for (const { to } of FIXTURE_SOURCES) {
    if (!existsSync(to)) continue;
    for (const f of readdirSync(to)) {
      const path = join(to, f);
      if (f.endsWith(".json") && !built.has(path)) orphans.push(path);
    }
  }
  return orphans;
}

/** Paths whose committed contents differ from a fresh build (missing files count). */
export function staleFixtures(built: Map<string, string>): string[] {
  return [...built].filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text).map(([path]) => path);
}

if (import.meta.main) {
  const built = await buildFixtures();
  for (const [path, text] of built) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  for (const orphan of orphanedFixtures(built)) rmSync(orphan);
  console.log(`Wrote ${built.size} fixture files.`);
}
