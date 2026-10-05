import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import {
  ExtensionRegistry,
  describeExtension,
  externalExtensionFile,
  installedExtensionDir,
  parseExtensionId,
  readManifest,
  removeExternalExtension,
  webStoreStatusProblem,
  writeExternalExtension,
} from "./extensions.ts";

// React Developer Tools' Chrome Web Store ID.
const REACT_ID = "fmkadmapgofadopljbjfkapdkoienihi";

describe("parseExtensionId", () => {
  test("bare IDs and both Web Store link shapes", () => {
    expect(parseExtensionId(` ${REACT_ID} `)).toBe(REACT_ID);
    expect(parseExtensionId(`https://chromewebstore.google.com/detail/react-developer-tools/${REACT_ID}`)).toBe(REACT_ID);
    expect(parseExtensionId(`https://chromewebstore.google.com/detail/${REACT_ID}?hl=en&pli=1`)).toBe(REACT_ID);
    expect(parseExtensionId(`https://chrome.google.com/webstore/detail/react-developer-tools/${REACT_ID}`)).toBe(REACT_ID);
  });

  test("rejects other hosts, wrong letters and wrong lengths", () => {
    expect(parseExtensionId(`https://evil.example/detail/${REACT_ID}`)).toBeNull();
    expect(parseExtensionId(`https://chromewebstore.google.com.evil.example/detail/${REACT_ID}`)).toBeNull();
    expect(parseExtensionId("fmkadmapgofadopljbjfkapdkoienihz")).toBeNull(); // z isn't a–p
    expect(parseExtensionId(REACT_ID.slice(1))).toBeNull();
    expect(parseExtensionId("https://chromewebstore.google.com/category/extensions")).toBeNull();
    expect(parseExtensionId("")).toBeNull();
  });
});

describe("readManifest", () => {
  test("resolves __MSG_ names from the default locale and finds the action and options page", () => {
    const dir = tempDir("ext-manifest-");
    writeFileSync(
      join(dir, "manifest.json"),
      "﻿" + JSON.stringify({ manifest_version: 3, name: "__MSG_appName__", version: "2.1", default_locale: "de", action: {}, options_ui: { page: "opts.html" } }),
    );
    mkdirSync(join(dir, "_locales", "de"), { recursive: true });
    writeFileSync(join(dir, "_locales", "de", "messages.json"), JSON.stringify({ APPNAME: { message: "Erweiterung" } }));
    expect(readManifest(dir)).toEqual({ name: "Erweiterung", version: "2.1", description: undefined, hasAction: true, optionsPage: "opts.html" });
  });

  test("MV2 browser_action and options_page; no action at all", () => {
    const dir = tempDir("ext-manifest-");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Old", version: "1", browser_action: {}, options_page: "o.html" }));
    expect(readManifest(dir)).toMatchObject({ hasAction: true, optionsPage: "o.html" });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Quiet", version: "1" }));
    expect(readManifest(dir)).toMatchObject({ hasAction: false, optionsPage: undefined });
  });

  test("a folder without a manifest, or with broken JSON, says so", () => {
    const dir = tempDir("ext-manifest-");
    expect(() => readManifest(dir)).toThrow(/no manifest.json/);
    writeFileSync(join(dir, "manifest.json"), "{ nope");
    expect(() => readManifest(dir)).toThrow(/isn't valid JSON/);
  });
});

describe("Chrome's profile", () => {
  test("installedExtensionDir picks the newest version folder that has a manifest", () => {
    const profile = tempDir("ext-profile-");
    expect(installedExtensionDir(profile, REACT_ID)).toBeNull();
    const root = join(profile, "Default", "Extensions", REACT_ID);
    for (const v of ["9.0.0_0", "10.0.0_0", "11.0.0_0"]) mkdirSync(join(root, v), { recursive: true });
    writeFileSync(join(root, "9.0.0_0", "manifest.json"), "{}");
    writeFileSync(join(root, "10.0.0_0", "manifest.json"), "{}");
    // 11 is mid-install (no manifest yet); 10 sorts after 9 numerically, not as text.
    expect(installedExtensionDir(profile, REACT_ID)).toBe(join(root, "10.0.0_0"));
  });

  test("External Extensions files point Chrome at the Web Store, and go away", () => {
    const profile = tempDir("ext-profile-");
    writeExternalExtension(profile, REACT_ID);
    const file = externalExtensionFile(profile, REACT_ID);
    expect(file).toBe(join(profile, "External Extensions", `${REACT_ID}.json`));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ external_update_url: "https://clients2.google.com/service/update2/crx" });
    removeExternalExtension(profile, REACT_ID);
    expect(existsSync(file)).toBe(false);
    removeExternalExtension(profile, REACT_ID); // already gone: no throw
  });
});

describe("webStoreStatusProblem", () => {
  test("installable goes ahead and an installed one is reused", () => {
    expect(webStoreStatusProblem("installable", "X")).toBeNull();
    expect(webStoreStatusProblem("enabled", "X")).toBe("installed");
    expect(webStoreStatusProblem("disabled", "X")).toBe("installed");
  });

  test("policy refusals are 403s that name the extension; what Chrome can't run is a 422", () => {
    for (const status of ["can_request", "request_pending", "blocked_by_policy", "blocklisted", "custodian_approval_required"]) {
      const problem = webStoreStatusProblem(status, "Dark Reader");
      expect(problem).toMatchObject({ status: 403 });
      expect((problem as { message: string }).message).toContain("Dark Reader");
    }
    expect(webStoreStatusProblem("can_request", "Dark Reader")).toMatchObject({ message: expect.stringContaining("ask your administrator") });
    expect(webStoreStatusProblem("force_installed", "X")).toMatchObject({ status: 409 });
    expect(webStoreStatusProblem("deprecated_manifest_version", "X")).toMatchObject({ status: 422, message: expect.stringContaining("Manifest V2") });
    expect(webStoreStatusProblem("something_new", "X")).toMatchObject({ status: 422, message: expect.stringContaining("something_new") });
  });
});

describe("ExtensionRegistry", () => {
  test("put replaces by ID, remove returns the entry, and the file survives a new instance", () => {
    const root = tempDir("ext-reg-");
    const reg = new ExtensionRegistry(root);
    expect(reg.list()).toEqual([]);
    const a = { id: REACT_ID, name: "A", version: "1", source: "webstore" as const, enabled: true, addedAt: 1 };
    reg.put(a);
    reg.put({ ...a, enabled: false });
    expect(new ExtensionRegistry(root).list()).toEqual([{ ...a, enabled: false }]);
    expect(reg.remove(a.id)?.enabled).toBe(false);
    expect(reg.remove(a.id)).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  test("a corrupt file reads as empty, and entries it can't use (an unpacked one without a path) are dropped", () => {
    const root = tempDir("ext-reg-");
    writeFileSync(join(root, "extensions.json"), "{");
    expect(new ExtensionRegistry(root).list()).toEqual([]);
    writeFileSync(
      join(root, "extensions.json"),
      JSON.stringify({ extensions: [{ id: "a", source: "unpacked" }, { id: "b", source: "unpacked", path: "/x" }, { id: "c", source: "other" }] }),
    );
    expect(new ExtensionRegistry(root).list().map((e) => e.id)).toEqual(["b"]);
  });
});

describe("describeExtension", () => {
  test("reads the manifest for the current name, action and options page", () => {
    const dir = tempDir("ext-desc-");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Live name", version: "9", action: { default_popup: "p.html" }, options_page: "/o.html" }));
    const entry = { id: REACT_ID, name: "Stored", version: "1", source: "unpacked" as const, path: dir, enabled: true, addedAt: 5 };
    expect(describeExtension(entry, dir, { status: "loaded" })).toMatchObject({
      name: "Live name",
      version: "9",
      hasAction: true,
      optionsUrl: `chrome-extension://${REACT_ID}/o.html`,
      status: "loaded",
    });
  });

  test("an unpacked folder that's gone is an error; a Web Store one Chrome hasn't installed yet keeps its stored name", () => {
    const entry = { id: REACT_ID, name: "Stored", version: "1", source: "unpacked" as const, path: "/nowhere/ext", enabled: true, addedAt: 5 };
    const gone = describeExtension(entry, entry.path, { status: "loaded" });
    expect(gone).toMatchObject({ name: "Stored", status: "error", hasAction: false });
    expect(gone.error).toContain("/nowhere/ext");
    const store = { id: REACT_ID, name: "React Developer Tools", version: "", source: "webstore" as const, enabled: true, addedAt: 5 };
    expect(describeExtension(store, null, { status: "pending" })).toMatchObject({ name: "React Developer Tools", status: "pending", error: undefined });
  });
});
