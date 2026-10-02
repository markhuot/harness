import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import appJson from "../../mobile/app.json";
import { BETA_BUNDLE_ID, BETA_TITLE } from "../../mobile/Tools/install-page";

// ios/project.yml is the source of the native app's Info.plist (XcodeGen writes it). These keys
// broke real setups before; see mobile/Tools/ats-config.test.ts for the ATS history.
const spec = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../project.yml"), "utf8")) as any;
const target = spec.targets.Harness;
const plist = target.info.properties as Record<string, any>;
const configs = target.settings.configs as Record<string, Record<string, string>>;
const rn = (appJson as any).expo;

test("ATS allows arbitrary loads so http to a Tailscale IP works", () => {
  expect(plist.NSAppTransportSecurity.NSAllowsArbitraryLoads).toBe(true);
});

test("no ATS key that makes iOS ignore NSAllowsArbitraryLoads", () => {
  for (const key of ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia"]) {
    expect(Object.keys(plist.NSAppTransportSecurity)).not.toContain(key);
  }
});

test("the harness:// URL scheme opens pairing links", () => {
  const schemes = (plist.CFBundleURLTypes as { CFBundleURLSchemes: string[] }[]).flatMap((t) => t.CFBundleURLSchemes);
  expect(schemes).toContain(rn.scheme);
});

test("privacy strings and export compliance match the React Native app", () => {
  expect(plist.NSLocalNetworkUsageDescription).toBe(rn.ios.infoPlist.NSLocalNetworkUsageDescription);
  expect(plist.NSCameraUsageDescription).toBe(rn.ios.infoPlist.NSCameraUsageDescription);
  expect(plist.ITSAppUsesNonExemptEncryption).toBe(false);
});

test("every orientation on iPhone and iPad, and no full-screen lock (Stage Manager/Split View)", () => {
  const all = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"];
  expect([...plist.UISupportedInterfaceOrientations].sort()).toEqual([...all].sort());
  expect([...plist["UISupportedInterfaceOrientations~ipad"]].sort()).toEqual([...all].sort());
  expect(Object.keys(plist)).not.toContain("UIRequiresFullScreen");
  expect(String(spec.settings.base.TARGETED_DEVICE_FAMILY)).toBe("1,2");
});

test("one window, as in the React Native app (a single Router and AppModel)", () => {
  expect(plist.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes).toBe(false);
});

test("Release replaces the React Native app on TestFlight; Debug installs beside it", () => {
  expect(configs.Release!.PRODUCT_BUNDLE_IDENTIFIER).toBe(rn.ios.bundleIdentifier);
  expect(configs.Release!.HARNESS_DISPLAY_NAME).toBe(rn.name);
  expect(configs.Debug!.PRODUCT_BUNDLE_IDENTIFIER).not.toBe(rn.ios.bundleIdentifier);
  expect(plist.CFBundleDisplayName).toBe("$(HARNESS_DISPLAY_NAME)");
  expect(plist.CFBundleVersion).toBe("$(CURRENT_PROJECT_VERSION)");
  expect(spec.settings.base.DEVELOPMENT_TEAM).toBe(rn.ios.appleTeamId);
});

test("Beta is a Release build that installs beside the main app, as the install page's beta manifest says", () => {
  expect(spec.configs).toEqual({ Debug: "debug", Release: "release", Beta: "release" });
  expect(configs.Beta!.PRODUCT_BUNDLE_IDENTIFIER).toBe(BETA_BUNDLE_ID);
  expect(configs.Beta!.PRODUCT_BUNDLE_IDENTIFIER).not.toBe(configs.Release!.PRODUCT_BUNDLE_IDENTIFIER);
  expect(configs.Beta!.HARNESS_DISPLAY_NAME).toBe(BETA_TITLE);
});
