import { createHarness, type CreateHarnessOptions, type Harness } from "../../service/src/app";
import type { BrowserService } from "../../service/src/browser/types";
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
    browser: new QuietBrowser(),
    watchers: null,
    pluginDirs: [],
    ...overrides,
  });
}

const noBrowser = () => Promise.reject(new Error("the test harness has no browser; pass `browser` to startHarness to supply one"));

/**
 * A browser that never starts Chrome. What the orchestrator calls on its own (closing and
 * suspending a ticket's tabs, shutdown) is a no-op, reads find nothing, and anything that would
 * drive a page rejects. `implements` keeps it in step with BrowserService.
 */
class QuietBrowser implements BrowserService {
  open = noBrowser;
  state = async () => null;
  tabs = async () => [];
  tabInfo = noBrowser;
  resize = noBrowser;
  content = noBrowser;
  click = noBrowser;
  type = noBrowser;
  keys = noBrowser;
  select = noBrowser;
  upload = noBrowser;
  snapshot = noBrowser;
  evaluate = noBrowser;
  waitFor = noBrowser;
  watch = () => () => {};
  screenshot = noBrowser;
  capture = noBrowser;
  elementAt = noBrowser;
  closeTab = async () => {};
  input = noBrowser;
  subscribe = noBrowser;
  unsubscribe = async () => {};
  suspendTabs = async () => {};
  extensions = noBrowser;
  addExtension = noBrowser;
  setExtensionEnabled = noBrowser;
  removeExtension = async () => {};
  runExtensionAction = noBrowser;
  restartBrowser = async () => {};
  close = async () => {};
  shutdown = async () => {};
}
