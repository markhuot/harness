// The built Mac app (electron on app/), against a running daemon, with its own profile: launched
// with a DevTools port of 0 (the real one is in Electron's "DevTools listening" line) and the
// HARNESS_URL/HARNESS_TOKEN pair so it never starts or finds another service.

import { join } from "node:path";
import { Cdp, Page } from "./cdp";
import { RunFile, spawnTracked, type Spawned } from "./procs";
import { withDeadline } from "./wait";

const root = join(import.meta.dir, "..", "..");

export interface MacApp {
  cdp: Cdp;
  spawned: Spawned;
  /** The main window. */
  main: Page;
  /** Attach a window opened after launch (a popout) whose URL matches, not one already attached. */
  windowOf(what: string, match: (url: string) => boolean, ms?: number): Promise<Page>;
  /** Quit through the app's own menu path (SIGTERM) and wait for the process to go. */
  quit(): Promise<void>;
}

/** The env the app is launched with: the host's `HARNESS_*` must not leak in; ours says where the service is and where the profile lives. */
export function macEnv(base: Record<string, string | undefined>, o: { url: string; token: string; userData: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("HARNESS_") && k !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  return { ...env, HARNESS_URL: o.url, HARNESS_TOKEN: o.token, HARNESS_USER_DATA: o.userData };
}

/**
 * Chromium switches that keep a covered or unfocused window running at full speed. Without them a
 * simulator window over the app makes Chromium treat it as occluded and stop its animation frames,
 * which the page's waits and the editor's drawing both run on.
 */
export const MAC_UNTHROTTLED = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling"];

export async function launchMac(runs: RunFile, o: { url: string; token: string; userData: string }): Promise<MacApp> {
  const spawned = spawnTracked(runs, "mac-app", [join(root, "node_modules/.bin/electron"), join(root, "app"), "--remote-debugging-port=0", ...MAC_UNTHROTTLED], { env: macEnv(process.env, o), cwd: join(root, "app") });
  const [, port, path] = await spawned.line(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)(\/\S+)/, "the Mac app to open DevTools", 60_000);
  const cdp = new Cdp(`ws://127.0.0.1:${port}${path}`);
  await cdp.connect();
  const claimed = new Set<string>();
  const windowOf = async (what: string, match: (url: string) => boolean, ms = 30_000) => {
    const target = await cdp.waitTarget(what, () => cdp.tracker.find(match, claimed), ms);
    claimed.add(target.targetId);
    const page = await cdp.attach(target);
    // The page behaves as focused and in front whatever covers it: the walk drives the app while the
    // simulators' windows come and go over it.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Page.bringToFront");
    return page;
  };
  // The main window loads the built renderer from disk (file://…/index.html) and is not a popout.
  const main = await windowOf("the Mac app's main window", (url) => url.startsWith("file://") && !url.includes("#/popout/"), 60_000);
  return {
    cdp,
    spawned,
    main,
    windowOf,
    async quit() {
      // The browser's own close: windows close and the app quits the way it does for a person, so what it persists on quit is written.
      await cdp.send("Browser.close").catch(() => {});
      await withDeadline("the Mac app to exit", 30_000, spawned.proc.exited);
      cdp.close();
    },
  };
}
