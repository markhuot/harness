import { describe, expect, test } from "bun:test";
import type { BrowserExtension } from "@harness/shared";
import { extensionNote, extensionsWaiting, runnableExtensions } from "./extensions";

const ext = (over: Partial<BrowserExtension>): BrowserExtension => ({
  id: "a".repeat(32),
  name: "Ext",
  version: "1",
  source: "webstore",
  enabled: true,
  status: "loaded",
  hasAction: true,
  ...over,
});

describe("extensionNote", () => {
  test("a policy refusal and a load error are errors that show Chrome's reason, with a fallback", () => {
    expect(extensionNote(ext({ status: "blocked", error: "Not allowed: Dark Reader" }))).toEqual({ badge: "Blocked", text: "Not allowed: Dark Reader", tone: "error" });
    expect(extensionNote(ext({ status: "blocked" })).text).toContain("policy");
    expect(extensionNote(ext({ status: "error", error: "bad manifest" }))).toMatchObject({ badge: "Error", text: "bad manifest", tone: "error" });
  });

  test("waiting says what happens next for each kind", () => {
    expect(extensionNote(ext({ status: "pending" })).text).toContain("Installs");
    expect(extensionNote(ext({ status: "pending", source: "unpacked" })).text).toContain("Loads");
  });

  test("ones the browser has from elsewhere say who installed them, whatever their status", () => {
    expect(extensionNote(ext({ source: "chrome", byPolicy: true, status: "loaded" })).badge).toBe("Installed by your organization");
    expect(extensionNote(ext({ source: "chrome", enabled: false, status: "off" })).badge).toBe("Off");
    expect(extensionNote(ext({ source: "chrome", status: "loaded" })).badge).toBeUndefined();
  });
});

describe("extensionsWaiting", () => {
  test("counts pending extensions only while the browser runs (otherwise its next start picks them up)", () => {
    const extensions = [ext({ status: "pending" }), ext({ status: "pending" }), ext({ status: "loaded" })];
    expect(extensionsWaiting({ extensions, running: true })).toBe(2);
    expect(extensionsWaiting({ extensions, running: false })).toBe(0);
  });
});

describe("runnableExtensions", () => {
  test("loaded ones with a toolbar button or an options page, by name", () => {
    const list = {
      running: true,
      extensions: [
        ext({ id: "b", name: "Zeta" }),
        ext({ id: "c", name: "alpha", hasAction: false, optionsUrl: "chrome-extension://c/o.html" }),
        ext({ id: "d", name: "Quiet", hasAction: false }),
        ext({ id: "e", name: "Off one", status: "off" }),
        ext({ id: "f", name: "Waiting", status: "pending" }),
        ext({ id: "g", name: "Org", source: "chrome", byPolicy: true }),
      ],
    };
    expect(runnableExtensions(list).map((e) => e.name)).toEqual(["alpha", "Org", "Zeta"]);
  });
});
