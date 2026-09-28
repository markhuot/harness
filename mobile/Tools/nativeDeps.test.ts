import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { linkedPackages, missingPods, needsPod, readPackage, type PackageInfo } from "./nativeDeps";

// Trimmed from the ios/Podfile.lock the app-20260928.1943 IPA was built from: no ExpoVideo.
const staleLock = `DEPENDENCIES:
  - EXConstants (from \`../../node_modules/expo-constants/ios\`)
  - Expo (from \`../../node_modules/expo\`)
  - ExpoCamera (from \`../../node_modules/expo-camera/ios/ExpoCamera.podspec\`)
  - "ExpoUI (from \`../../node_modules/@expo/ui/ios\`)"
  - react-native-webview (from \`../../node_modules/react-native-webview\`)
  - RNScreens (from \`../../node_modules/react-native-screens\`)

SPEC REPOS:
  trunk:
    - SDWebImage
`;

const pkg = (name: string, podspecs: string[], expoPlatforms: string[] | null = null): PackageInfo => ({ name, podspecs, expoPlatforms });

test("linkedPackages reads plain, quoted, scoped, podspec-file and package-root sources", () => {
  expect([...linkedPackages(staleLock)].sort()).toEqual(["@expo/ui", "expo", "expo-camera", "expo-constants", "react-native-screens", "react-native-webview"]);
});

test("missingPods reports the Expo module the stale lockfile doesn't link", () => {
  const deps = [
    pkg("expo", ["Expo.podspec"], ["apple", "android"]),
    pkg("expo-camera", ["ios/ExpoCamera.podspec"], ["apple", "android", "web"]),
    pkg("expo-video", ["ios/ExpoVideo.podspec"], ["apple", "android"]),
    pkg("@expo/ui", ["ios/ExpoUI.podspec"], ["apple", "android"]),
    pkg("react-native-screens", ["RNScreens.podspec"]),
  ];
  expect(missingPods(deps, staleLock)).toEqual(["expo-video"]);
  expect(missingPods(deps, staleLock + `  - ExpoVideo (from \`../../node_modules/expo-video/ios\`)\n`)).toEqual([]);
});

test("a package whose name prefixes a linked one isn't counted as linked", () => {
  // `expo` and `expo-camera` are linked; `expo-cam` isn't, even though it's a prefix of one.
  expect(missingPods([pkg("expo-cam", ["ios/ExpoCam.podspec"], ["apple"])], staleLock)).toEqual(["expo-cam"]);
});

test("a non-Expo React Native library with a podspec needs a pod", () => {
  expect(missingPods([pkg("react-native-svg", ["RNSVG.podspec"])], staleLock)).toEqual(["react-native-svg"]);
});

test("packages without iOS native code don't need a pod", () => {
  expect(needsPod(pkg("react", []))).toBe(false);
  expect(needsPod(pkg("expo-status-bar", [], ["android"]))).toBe(false);
  // An Expo module can carry a podspec and still leave Apple platforms out of its config.
  expect(needsPod(pkg("android-only", ["ios/AndroidOnly.podspec"], ["android"]))).toBe(false);
  expect(needsPod(pkg("ios-alias", ["ios/X.podspec"], ["ios"]))).toBe(true);
});

test("readPackage finds podspecs and the Expo config of installed packages", () => {
  const mobile = resolve(import.meta.dir, "..");
  expect(readPackage(mobile, "expo-video")).toEqual({ name: "expo-video", podspecs: ["ios/ExpoVideo.podspec"], expoPlatforms: ["apple", "android"] });
  expect(needsPod(readPackage(mobile, "expo-status-bar"))).toBe(false);
  expect(needsPod(readPackage(mobile, "react-native-svg"))).toBe(true);
  expect(() => readPackage(mobile, "not-a-real-package-h62")).toThrow("isn't installed");
});
