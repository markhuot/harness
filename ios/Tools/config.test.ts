import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_BUNDLE_ID } from "../../app/scripts/bundle-id";

// ios/project.yml is the source of the app's Info.plist (XcodeGen writes it). These keys broke real
// setups before.
const spec = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../project.yml"), "utf8")) as any;
const target = spec.targets.Harness;
const plist = target.info.properties as Record<string, any>;
const settings = target.settings as { base: Record<string, string>; configs?: Record<string, Record<string, string>> };

// The app talks plain http to the harness service on a Tailscale IP (100.x) or a LAN/custom host.
// iOS ignores NSAllowsArbitraryLoads whenever NSAllowsLocalNetworking (or the ...InWebContent /
// ...ForMedia keys) is also present, and "local networking" doesn't cover a 100.x address, so
// pairing over Tailscale failed with NSURLErrorDomain -1022 while 127.0.0.1 in the simulator worked.
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
  expect(schemes).toEqual(["harness"]);
});

test("privacy strings for the local network and the pairing camera, and export compliance", () => {
  expect(plist.NSLocalNetworkUsageDescription).toContain("harness service");
  expect(plist.NSCameraUsageDescription).toContain("pairing QR code");
  expect(plist.ITSAppUsesNonExemptEncryption).toBe(false);
});

test("every orientation on iPhone and iPad, and no full-screen lock (Stage Manager/Split View)", () => {
  const all = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"];
  expect([...plist.UISupportedInterfaceOrientations].sort()).toEqual([...all].sort());
  expect([...plist["UISupportedInterfaceOrientations~ipad"]].sort()).toEqual([...all].sort());
  expect(Object.keys(plist)).not.toContain("UIRequiresFullScreen");
  expect(String(spec.settings.base.TARGETED_DEVICE_FAMILY)).toBe("1,2");
});

// iPad windows: each has its own Router. WindowDirectory.openTicket opens a ticket's prominent window
// with a scene activation request carrying an NSUserActivity (also used to restore it on relaunch),
// and iPadOS opens a new window only for a type listed here, so it must match the Swift constant.
test("several windows, and the ticket window's activation activity type is listed", () => {
  expect(plist.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes).toBe(true);
  const swift = readFileSync(join(import.meta.dir, "../HarnessKit/Sources/HarnessKit/Shell/TicketWindow.swift"), "utf8");
  const activityType = swift.match(/static let activityType = "([^"]+)"/)?.[1];
  expect(activityType).toBeTruthy();
  expect(plist.NSUserActivityTypes).toEqual([activityType]);
});

// TestFlight and the install page's manifest know the app as com.markhuot.harness on team
// 47P4ZSALX4; a Debug build is the same app, so it replaces an installed release.
test("one bundle id and name for every configuration, on the release team", () => {
  expect(spec.configs).toBeUndefined();
  expect(settings.configs).toBeUndefined();
  expect(settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe("com.markhuot.harness");
  expect(plist.CFBundleDisplayName).toBe("Harness");
  expect(plist.CFBundleVersion).toBe("$(CURRENT_PROJECT_VERSION)");
  expect(plist.CFBundleShortVersionString).toBe("$(MARKETING_VERSION)");
  expect(spec.settings.base.DEVELOPMENT_TEAM).toBe("47P4ZSALX4");
});

test("the user-facing version is a dotted MAJOR.MINOR.PATCH (App Store Connect rejects anything else)", () => {
  expect(String(spec.settings.base.MARKETING_VERSION)).toMatch(/^\d+\.\d+\.\d+$/);
});

// XcodeGen writes an entitlements file from `properties` and overwrites it with an empty dict when
// a target names only its path, which silently signed the widgets without their App Group.
test("the app and its widgets share an App Group, declared where XcodeGen keeps it", () => {
  const groups = (name: string) => spec.targets[name].entitlements.properties["com.apple.security.application-groups"];
  expect(groups("Harness")).toEqual(["group.com.markhuot.harness"]);
  expect(groups("HarnessWidgets")).toEqual(["group.com.markhuot.harness"]);
  // The Mac group is team-prefixed (no provisioning profile) and matches the Electron app's.
  expect(groups("HarnessMacWidgets")).toEqual(["47P4ZSALX4.com.markhuot.harness"]);
  const electron = readFileSync(join(import.meta.dir, "../../app/resources/entitlements.mac.plist"), "utf8");
  expect(electron).toContain("<string>47P4ZSALX4.com.markhuot.harness</string>");
  // A widget extension must be sandboxed, and the Mac one reaches the service over the network.
  const mac = spec.targets.HarnessMacWidgets.entitlements.properties;
  expect(mac["com.apple.security.app-sandbox"]).toBe(true);
  expect(mac["com.apple.security.network.client"]).toBe(true);
});

test("the widget extensions are WidgetKit extensions with ids inside their apps'", () => {
  const ext = (name: string) => spec.targets[name];
  expect(ext("HarnessWidgets").info.properties.NSExtension.NSExtensionPointIdentifier).toBe("com.apple.widgetkit-extension");
  expect(ext("HarnessMacWidgets").info.properties.NSExtension.NSExtensionPointIdentifier).toBe("com.apple.widgetkit-extension");
  expect(ext("HarnessWidgets").settings.base.PRODUCT_BUNDLE_IDENTIFIER).toStartWith(`${settings.base.PRODUCT_BUNDLE_IDENTIFIER}.`);
  // The Mac app shares the iPhone app's id (one App ID, one APNs topic), so the two widget
  // extensions share theirs too, though they stay separate targets.
  expect(settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(APP_BUNDLE_ID);
  expect(ext("HarnessMacWidgets").settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(`${APP_BUNDLE_ID}.widgets`);
  expect(ext("HarnessWidgets").settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(`${APP_BUNDLE_ID}.widgets`);
  expect(target.dependencies.map((d: { target?: string }) => d.target)).toContain("HarnessWidgets");
});
