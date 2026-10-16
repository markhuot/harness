import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startHarness } from "../builders/harness";
import { tempDir } from "../builders/tmp";

test("createHarness boots on an in-memory database and keeps its files in the given home", async () => {
  const home = tempDir();
  const cwdBefore = readdirSync(process.cwd()).sort();
  const h = await startHarness({ home });
  try {
    const res = await fetch(`${h.url}/health`);
    expect(res.status).toBe(200);
    expect(h.port).not.toBe(0);
    h.store.projects.create({ name: "Mem", path: home, key: "MEM" });
    expect(h.store.projects.list()).toHaveLength(1);
    // The default database file in the home is never created.
    expect(existsSync(h.paths.dbPath)).toBe(false);
  } finally {
    await h.stop();
  }
  expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
});

test("two in-memory harnesses in one process hold separate data", async () => {
  const [a, b] = await Promise.all([startHarness(), startHarness()]);
  try {
    a.store.projects.create({ name: "A", path: tempDir(), key: "AAA" });
    expect(b.store.projects.list()).toEqual([]);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("dbPath still opens a file when given one", async () => {
  const home = tempDir();
  const dbPath = join(home, "elsewhere.db");
  const h = await startHarness({ home, dbPath });
  try {
    expect(existsSync(dbPath)).toBe(true);
  } finally {
    await h.stop();
  }
});
