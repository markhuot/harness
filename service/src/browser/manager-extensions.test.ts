import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { codeSignCloneRoot } from "./chrome.ts";
import { BrowserManager } from "./manager.ts";
import { createBrowserService } from "./index.ts";
import { testIf } from "@harness/shared/testing/skip";
import { tempDir } from "@harness/shared/testing";
import { chromePath, fixtures, html, isAlive, memoryTabStore, profileDir, until, withChrome } from "./test-support.ts";

withChrome("BrowserManager extensions (real Chrome)", () => {
  let server: Server<unknown>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => void server?.stop(true));

  /** An unpacked extension: a content script that marks every page, and a toolbar popup. */
  function unpackedExtension(): string {
    const dir = tempDir("harness-ext-src-");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Harness test extension",
        version: "1.2.3",
        action: { default_popup: "popup.html" },
        content_scripts: [{ matches: ["<all_urls>"], js: ["mark.js"], run_at: "document_start" }],
      }),
    );
    writeFileSync(join(dir, "mark.js"), `document.documentElement.dataset.harnessExt = "ran";`);
    writeFileSync(join(dir, "popup.html"), `<!doctype html><title>Ext popup</title><h1 id="pop">Popup body</h1>`);
    return dir;
  }

  const marked = async (service: BrowserManager, session: string, tab?: number) =>
    JSON.parse(await service.evaluate(session, "document.documentElement.dataset.harnessExt ?? 'none'", { tab }));
  const mine = async (service: BrowserManager) => (await service.extensions()).extensions.filter((e) => e.source !== "chrome");

  // A Chrome enrolled in cloud management fetches its policy a few seconds after a new profile's
  // first launch, and loads unpacked extensions until then. Let it fetch (and cache) the policy
  // first, so the test sees what an established profile does.
  async function settlePolicy() {
    if (!existsSync("/Library/Managed Preferences/com.google.Chrome.plist")) return;
    const warm = new BrowserManager({ profileDir, chromePath: chromePath!, tabStore: memoryTabStore() });
    try {
      await warm.open("warm", "about:blank");
      const cached = join(profileDir, "Policy", "Machine Level User Cloud Policy");
      const deadline = Date.now() + 20_000;
      while (!existsSync(cached) && Date.now() < deadline) await Bun.sleep(250);
    } finally {
      await warm.shutdown();
    }
  }

  // On a computer whose Chrome policy doesn't allow unpacked extensions (a managed Mac), the test
  // checks the refusal; elsewhere it checks everything else.
  test("an unpacked extension loads, runs, opens its popup as a tab, comes back after a restart, turns off and is removed — or is refused by policy, leaving nothing behind", async () => {
    await settlePolicy();
    const extensionsDir = tempDir("harness-ext-");
    const src = unpackedExtension();
    const opts = { profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: memoryTabStore(), extensionsDir };
    const first = new BrowserManager(opts);
    let id: string;
    try {
      let added;
      try {
        added = await first.addExtension({ path: src });
      } catch (e) {
        expect((e as { status?: number }).status).toBe(403);
        expect((e as Error).message).toContain("policy");
        expect(await mine(first)).toEqual([]);
        expect(existsSync(join(src, "manifest.json"))).toBe(true); // the user's folder stays
        await first.open("ex", `${base}/?refused`);
        expect(await marked(first, "ex")).toBe("none");
        console.warn("[browser tests] Chrome's policy refused the unpacked test extension; checked the refusal only.");
        return;
      }
      id = added.id;
      expect(added).toMatchObject({ name: "Harness test extension", version: "1.2.3", source: "unpacked", path: src, enabled: true, status: "loaded", hasAction: true });
      await first.open("ex", `${base}/?ext`);
      expect(await marked(first, "ex")).toBe("ran");

      const { tab } = await first.runExtensionAction("ex", id);
      expect(tab).toBe(2);
      expect(await first.content("ex", { selector: "#pop", tab: 2 })).toBe("Popup body");
      expect((await first.tabs("ex")).map((t) => t.url)).toEqual([`${base}/?ext`, `chrome-extension://${id}/popup.html`]);
    } finally {
      await first.shutdown();
    }

    // A new Chrome knows nothing of it: the registry loads it again.
    const second = new BrowserManager(opts);
    try {
      expect((await mine(second)).map((e) => [e.id, e.status])).toEqual([[id, "pending"]]); // until Chrome starts
      await second.open("ex2", `${base}/?again`);
      expect(await marked(second, "ex2")).toBe("ran");
      expect((await mine(second))[0]?.status).toBe("loaded");

      expect((await second.setExtensionEnabled(id, false)).status).toBe("off");
      await second.open("ex2", `${base}/?off`);
      expect(await marked(second, "ex2")).toBe("none");
      await expect(second.runExtensionAction("ex2", id)).rejects.toThrow(/turned off/);

      expect((await second.setExtensionEnabled(id, true)).status).toBe("loaded");
      await second.open("ex2", `${base}/?on`);
      expect(await marked(second, "ex2")).toBe("ran");

      await second.removeExtension(id);
      expect(await mine(second)).toEqual([]);
      expect(existsSync(join(src, "manifest.json"))).toBe(true); // an unpacked folder is the user's
      await second.open("ex2", `${base}/?removed`);
      expect(await marked(second, "ex2")).toBe("none");
    } finally {
      await second.shutdown();
    }
  }, 90_000);

  // Talks to the Chrome Web Store, so it runs only when asked: HARNESS_NETWORK_TESTS=1.
  testIf(process.env.HARNESS_NETWORK_TESTS, "Chrome Web Store extension test is opt-in (set HARNESS_NETWORK_TESTS=1)")(
    "a Web Store extension installs through Chrome, turns off and on, opens its popup on a page, and is uninstalled when Chrome restarts",
    async () => {
      await settlePolicy();
      const REACT = "fmkadmapgofadopljbjfkapdkoienihi";
      const service = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 20_000, tabStore: memoryTabStore(), extensionsDir: tempDir("harness-ext-") });
      try {
        // No tab has a page, so Chrome restarts at once to install it.
        const added = await service.addExtension({ webstore: `https://chromewebstore.google.com/detail/react-developer-tools/${REACT}` });
        expect(added).toMatchObject({ id: REACT, name: "React Developer Tools", source: "webstore", status: "loaded", hasAction: true });
        expect(existsSync(join(profileDir, "External Extensions", `${REACT}.json`))).toBe(true);
        await expect(service.addExtension({ webstore: REACT })).rejects.toThrow(/already installed/);

        expect((await service.setExtensionEnabled(REACT, false)).status).toBe("off");
        expect((await service.setExtensionEnabled(REACT, true)).status).toBe("loaded");

        await service.open("ws", "https://react.dev/");
        await Bun.sleep(2000); // its content script reports React to its service worker
        const { tab } = await service.runExtensionAction("ws", REACT);
        expect(tab).toBe(2);
        const popup = (await service.tabs("ws")).find((t) => t.id === 2)!;
        expect(popup.url).toStartWith(`chrome-extension://${REACT}/popups/`);
        expect(popup.size!.width).toBeLessThan(1280); // the popup's own size, not an emulated viewport

        // A blocked extension (an organization's allowlist) is refused before anything is installed.
        if (existsSync("/Library/Managed Preferences/com.google.Chrome.plist")) {
          await expect(service.addExtension({ webstore: "eimadpbcbfnmbkopoojfekhnkhdbieeh" })).rejects.toThrow(/policy/);
        }

        await service.removeExtension(REACT);
        expect((await service.extensions()).extensions.map((e) => e.id)).not.toContain(REACT);
        expect(existsSync(join(profileDir, "External Extensions", `${REACT}.json`))).toBe(false);
        await service.restartBrowser();
        await until(() => !existsSync(join(profileDir, "Default", "Extensions", REACT)), "Chrome uninstalling it", 15_000);
      } finally {
        await service.shutdown();
      }
    },
    120_000,
  );

  test("bad input is refused before Chrome starts", async () => {
    const service = new BrowserManager({ profileDir, chromePath: chromePath!, tabStore: memoryTabStore(), extensionsDir: tempDir("harness-ext-") });
    try {
      await expect(service.addExtension({ webstore: "https://example.com/not-the-store" })).rejects.toThrow(/isn't a Chrome Web Store link/);
      await expect(service.addExtension({ path: join(tempDir("harness-ext-empty-"), "nope") })).rejects.toThrow(/isn't a folder/);
      await expect(service.addExtension({ path: tempDir("harness-ext-empty-") })).rejects.toThrow(/no manifest.json/);
      await expect(service.setExtensionEnabled("a".repeat(32), true)).rejects.toThrow(/No extension/);
      await expect(service.removeExtension("a".repeat(32))).rejects.toThrow(/No extension/);
      expect(await service.extensions()).toEqual({ extensions: [], running: false });
      expect(service.chromePid).toBeUndefined();
      const without = new BrowserManager({ profileDir, chromePath: chromePath! });
      await expect(without.extensions()).rejects.toThrow(/doesn't support extensions/);
    } finally {
      await service.shutdown();
    }
  });
});

withChrome("createBrowserService shutdown", () => {
  test("shutdown closes Chrome gracefully: process gone, no code-sign clone left, later call relaunches", async () => {
    const cloneRoot = codeSignCloneRoot();
    if (!cloneRoot) console.warn("[browser tests] code_sign_clone dir not found; skipping clone-leak assertions.");
    const service = createBrowserService({ profileDir, chromePath: chromePath! }) as BrowserManager;
    try {
      expect(service.chromePid).toBeUndefined(); // lazy: nothing launched yet
      for (let round = 0; round < 2; round++) {
        await service.open("s", "about:blank");
        const pid = service.chromePid!;
        expect(isAlive(pid)).toBe(true);
        // Only this Chrome's own clone is checked: the clone root is shared with every other
        // Chrome on the machine (other test runs, the daemon), so its listing isn't ours to assert on.
        // Chrome 154+ deletes the clone itself shortly after startup; older versions keep it until exit.
        const clone = service.chromeCloneDir;
        if (clone) expect(dirname(clone)).toBe(cloneRoot!);
        await service.shutdown();
        expect(isAlive(pid)).toBe(false);
        expect(service.chromePid).toBeUndefined();
        expect(await service.state("s")).toBeNull();
        if (clone) expect(existsSync(clone)).toBe(false);
      }
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});
