import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ChromeProcess,
  chromeStartTimes,
  codeSignCloneRoot,
  findChrome,
  parseChromeStartTimes,
  sweepCodeSignClones,
} from "./chrome.ts";

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MIN = 60_000;

describe("parseChromeStartTimes", () => {
  test("turns every etime form into a start time, only for Chrome-ish processes", () => {
    const now = 1_000_000_000_000;
    const out = [
      "      00:05 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "   01:02:03 /Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper",
      "2-03:00:00 /Applications/Chromium.app/Contents/MacOS/Chromium",
      "      12:00 /usr/bin/ssh",
      "      00:01 /Applications/Slack.app/Contents/Frameworks/chrome_crashpad_handler",
      "",
    ].join("\n");
    expect(parseChromeStartTimes(out, now)).toEqual([
      now - 5_000,
      now - (3600 + 2 * 60 + 3) * 1000,
      now - (2 * 86_400 + 3 * 3600) * 1000,
    ]);
  });

  test("finds this machine's running processes", () => {
    // ps works here, so this must not be the "can't tell" null that disables the sweep.
    expect(chromeStartTimes()).toBeArray();
  });
});

describe("sweepCodeSignClones", () => {
  function clone(root: string, name: string, madeAt: number): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "Google Chrome.app.bundle", "Contents"), { recursive: true });
    utimesSync(dir, new Date(madeAt), new Date(madeAt));
    return dir;
  }

  test("removes clones no running Chrome started just before; keeps owned, young and foreign entries", async () => {
    const root = tempDir("clones-");
    const now = Date.now();
    const chromeStart = now - 60 * MIN;
    const orphan = clone(root, "code_sign_clone.orphan", now - 30 * MIN);
    const beforeStart = clone(root, "code_sign_clone.before", chromeStart - MIN);
    const owned = clone(root, "code_sign_clone.owned", chromeStart + 3_000);
    const ownedSameSecond = clone(root, "code_sign_clone.rounded", chromeStart - 1_000);
    const young = clone(root, "code_sign_clone.young", now - 5_000);
    const foreign = clone(root, "something_else", now - 30 * MIN);

    const removed = await sweepCodeSignClones({ root, chromeStarts: [chromeStart] });

    expect(removed.sort()).toEqual(["code_sign_clone.before", "code_sign_clone.orphan"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(beforeStart)).toBe(false);
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(ownedSameSecond)).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  test("removes nothing when it can't list running processes", async () => {
    const root = tempDir("clones-");
    const orphan = clone(root, "code_sign_clone.orphan", Date.now() - 30 * MIN);
    expect(await sweepCodeSignClones({ root, chromeStarts: null })).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });
});

const chromePath = findChrome();
const realChrome = chromePath && codeSignCloneRoot() ? describe : describe.skip;

realChrome("code-sign clones with real Chrome", () => {
  test("a sweep removes a killed Chrome's unclaimed clone and keeps a running Chrome's", async () => {
    const a = await ChromeProcess.launch({ chromePath: chromePath!, profileDir: tempDir("chrome-a-") });
    const b = await ChromeProcess.launch({ chromePath: chromePath!, profileDir: tempDir("chrome-b-") });
    const bClone = b.cloneDir;
    try {
      expect(a.cloneDir).toBeDefined();
      expect(bClone).toBeDefined();

      // Orphan a's clone the way a dead daemon does: Chrome killed, nobody left to remove it.
      const orphan = a.cloneDir!;
      a.cloneDir = undefined;
      process.kill(a.pid, "SIGKILL");
      await a.exitedPromise;
      await Bun.sleep(1000);
      expect(existsSync(orphan)).toBe(true);
      // Make it look like it leaked an hour ago, so the age guard doesn't hide the result.
      const old = new Date(Date.now() - 60 * MIN);
      utimesSync(orphan, old, old);

      const removed = await sweepCodeSignClones();
      expect(removed).toContain(basename(orphan));
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(bClone!)).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    // Chrome removes its own clone after a clean exit.
    expect(existsSync(bClone!)).toBe(false);
  }, 60_000);
});
