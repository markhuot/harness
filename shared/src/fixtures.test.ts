import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { buildFixtures, orphanedFixtures, staleFixtures } from "../scripts/export-fixtures";

// The native iOS app (ios/HarnessKit) decodes these fixtures and must agree with them. When TS
// behavior or a case file changes, the committed JSON has to be regenerated so `swift test` sees it.
const ROOT = resolve(import.meta.dir, "../..");
const HINT = "run `bun shared/scripts/export-fixtures.ts` and commit the result";

test("committed iOS fixtures match the TypeScript they were generated from", async () => {
  const built = await buildFixtures();
  expect(built.size).toBeGreaterThan(0);
  const stale = staleFixtures(built).map((p) => relative(ROOT, p));
  expect(stale, `Stale fixtures (${HINT})`).toEqual([]);
});

test("no generated fixture is left over from a deleted case file", async () => {
  const orphans = orphanedFixtures(await buildFixtures()).map((p) => relative(ROOT, p));
  expect(orphans, `Orphaned fixtures (${HINT})`).toEqual([]);
});
