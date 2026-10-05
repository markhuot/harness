import type { BrowserExtension } from "../../src/protocol";
import { extensionNote, extensionsWaiting, runnableExtensions } from "../../src/state/extensions";
import { cases } from "../case";

const ext = (over: Partial<BrowserExtension>): BrowserExtension => ({
  id: "fmkadmapgofadopljbjfkapdkoienihi",
  name: "React Developer Tools",
  version: "8.0.0",
  source: "webstore",
  enabled: true,
  status: "loaded",
  hasAction: true,
  ...over,
});

export const extensionNoteCases = cases(extensionNote, {
  "loaded from the store shows its description": ext({ description: "Adds React debugging tools." }),
  "loaded unpacked shows nothing (its path shows)": ext({ source: "unpacked", path: "/x", description: "Ignored" }),
  "waiting store install": ext({ status: "pending" }),
  "waiting unpacked load": ext({ source: "unpacked", status: "pending" }),
  off: ext({ status: "off", enabled: false }),
  "blocked with Chrome's reason": ext({ status: "blocked", error: "Your organization's Chrome policy doesn't allow Dark Reader." }),
  "blocked without a reason": ext({ status: "blocked" }),
  "error with a reason": ext({ status: "error", error: "bad manifest" }),
  "error without a reason": ext({ status: "error" }),
  "installed by policy": ext({ source: "chrome", byPolicy: true, description: "Password Alert helps protect against phishing attacks." }),
  "installed elsewhere and off": ext({ source: "chrome", enabled: false, status: "off" }),
  "installed elsewhere and on": ext({ source: "chrome" }),
});

export const extensionsWaitingCases = cases(extensionsWaiting, {
  "running: pending ones count": { running: true, extensions: [ext({ status: "pending" }), ext({ status: "pending" }), ext({ status: "loaded" })] },
  "not running: its next start picks them up": { running: false, extensions: [ext({ status: "pending" })] },
  "nothing waits": { running: true, extensions: [ext({ status: "off" })] },
});

export const runnableExtensionsCases = cases(runnableExtensions, {
  "loaded with a button or options page, by name": {
    running: true,
    extensions: [
      ext({ id: "b", name: "Zeta" }),
      ext({ id: "c", name: "alpha", hasAction: false, optionsUrl: "chrome-extension://c/o.html" }),
      ext({ id: "d", name: "Quiet", hasAction: false }),
      ext({ id: "e", name: "Off one", status: "off" }),
      ext({ id: "f", name: "Waiting", status: "pending" }),
      ext({ id: "g", name: "Org", source: "chrome", byPolicy: true }),
    ],
  },
  empty: { running: false, extensions: [] },
});
