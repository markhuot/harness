import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { frozen } from "../fixtures/case";
import { buildFixtures, frozenPaths, orphanedFixtures, staleFixtures } from "../scripts/export-fixtures";

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

// Frozen fixtures (see export-fixtures.ts) have no TS behind them, so these checks are all that
// guards them on this side: Swift reads them, and a missing or garbled one would only show up there.
test("every FROZEN fixture is committed, parses as an object, and has no case file", async () => {
  const built = await buildFixtures();
  for (const path of frozenPaths()) {
    const name = relative(ROOT, path);
    expect(existsSync(path), `${name} is listed in FROZEN but missing`).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof data === "object" && data !== null && !Array.isArray(data) && Object.keys(data).length > 0, `${name} is not a non-empty object`).toBe(true);
    expect(built.has(path), `${name} is in FROZEN but a case file also generates it`).toBe(false);
  }
});

test("frozen() refuses a key the committed fixture doesn't have", () => {
  expect(frozen("stickToBottom", "constants")).toMatchObject({ STICK_THRESHOLD: expect.any(Number) });
  expect(() => frozen("stickToBottom", "noSuchExport")).toThrow(/has no "noSuchExport"/);
});
