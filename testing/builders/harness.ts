import { createHarness, type CreateHarnessOptions, type Harness } from "../../service/src/app";
import { tempDir } from "./tmp";

/**
 * A real service on port 0, an in-memory database and a per-test home, with nothing that
 * reaches outside the process: no drivers, no browser, no watchers, no plugins, no code watch.
 * The caller stops it.
 */
export async function startHarness(overrides: Partial<CreateHarnessOptions> = {}): Promise<Harness> {
  return createHarness({
    home: tempDir(),
    port: 0,
    hostname: "127.0.0.1",
    dbPath: ":memory:",
    drivers: [],
    browser: quietBrowser,
    watchers: null,
    pluginDirs: [],
    ...overrides,
  });
}

// createHarness starts Chrome lazily; this keeps it from being constructed at all.
const quietBrowser = {} as NonNullable<CreateHarnessOptions["browser"]>;
