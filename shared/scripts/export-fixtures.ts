// Writes the JSON the native iOS app is checked against:
//   shared/fixtures/cases/<module>.ts     → ios/HarnessKit/Tests/HarnessKitTests/Fixtures/<module>.json
//   shared/fixtures/resources/<name>.ts   → ios/HarnessKit/Sources/HarnessKit/Resources/<name>.json
// Each output is `{ "<export>": value }` for every named export of the source file (promises are
// awaited). Files are discovered by directory, so adding a module means adding a file, no registry.
//
//   bun shared/scripts/export-fixtures.ts
//
// shared/src/fixtures.test.ts rebuilds everything in memory and fails when the committed JSON is stale.
//
// Frozen fixtures. Some behavior has no TypeScript implementation any more (it lived only in the
// retired React Native app; the Swift port is now the one implementation), so its committed JSON is
// the spec Swift is held to and is never regenerated:
//   - A case file that mixes computed and frozen exports reads each frozen one back from its own
//     committed JSON with `frozen(module, key)` (shared/fixtures/case.ts), so it's rewritten as is.
//   - A module with nothing left to compute has no case file at all. Its name is in FROZEN below:
//     the exporter leaves the JSON alone and the orphan check skips it. fixtures.test.ts checks that
//     each listed file exists, parses, and isn't also produced by a case file.
// Anything computed from shared/ code stays computed, so drift between TS and Swift is still caught.

import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CASE_FIXTURES_DIR } from "../fixtures/case";

const ROOT = resolve(import.meta.dir, "../..");

export const FIXTURE_SOURCES = [
  { from: join(ROOT, "shared/fixtures/cases"), to: CASE_FIXTURES_DIR },
  { from: join(ROOT, "shared/fixtures/resources"), to: join(ROOT, "ios/HarnessKit/Sources/HarnessKit/Resources") },
] as const;

/** Case fixtures (in CASE_FIXTURES_DIR) with no case file: committed JSON only, never regenerated. */
export const FROZEN = [
  "approve",
  "browserInput",
  "fileViewer",
  "heroCollapse",
  "mentionCaret",
  "mobileBoardColumns",
  "mobileConnection",
  "mobileModelSheet",
  "mobileNewSession",
  "mobilePair",
  "mobileSelectOptions",
  "mobileServers",
  "pluginHost",
  "related",
  "themePicker",
] as const;

export const frozenPaths = (): string[] => FROZEN.map((m) => join(CASE_FIXTURES_DIR, `${m}.json`));

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

/** Generated JSON files on disk that no source file produces any more (FROZEN files aside). */
export function orphanedFixtures(built: Map<string, string>): string[] {
  const keep = new Set(frozenPaths());
  const orphans: string[] = [];
  for (const { to } of FIXTURE_SOURCES) {
    if (!existsSync(to)) continue;
    for (const f of readdirSync(to)) {
      const path = join(to, f);
      if (f.endsWith(".json") && !built.has(path) && !keep.has(path)) orphans.push(path);
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
