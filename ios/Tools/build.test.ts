import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApp, checkServed, clockBuildNumber, findToken, machOCpuTypes, parseArgs, UsageError, withBetaBuild } from "./build";
import type { ReleaseInfo } from "../../mobile/Tools/install-page";

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

/** A thin 64-bit Mach-O header (little-endian) for one CPU type, followed by `tail`. */
function thin(cpu: number, tail = ""): Uint8Array {
  const head = new DataView(new ArrayBuffer(32));
  head.setUint32(0, 0xfeedfacf, true);
  head.setInt32(4, cpu, true);
  return new Uint8Array([...new Uint8Array(head.buffer), ...new TextEncoder().encode(tail)]);
}

/** A universal (fat) header (big-endian) listing `cpus`. */
function fat(cpus: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(8 + cpus.length * 20));
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, cpus.length, false);
  cpus.forEach((cpu, i) => view.setInt32(8 + i * 20, cpu, false));
  return new Uint8Array(view.buffer);
}

const SWIFTUI = "\0/System/Library/Frameworks/SwiftUI.framework/SwiftUI\0";
const expected = { kind: "native" as const, bundleId: "com.markhuot.harness", buildNumber: "202609301200" };

let dir: string;
let app: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ios-build-test-"));
  app = join(dir, "Harness.app");
  mkdirSync(app);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes Info.plist as a binary plist, the format an exported IPA carries. */
function writeApp(info: Record<string, string>, binary: Uint8Array | null = thin(ARM64, SWIFTUI)) {
  const plist = join(app, "Info.plist");
  writeFileSync(plist, JSON.stringify(info));
  expect(Bun.spawnSync(["plutil", "-convert", "binary1", plist]).exitCode).toBe(0);
  if (binary) writeFileSync(join(app, "Harness"), binary);
}
const info = (over: Record<string, string> = {}) => ({
  CFBundleIdentifier: "com.markhuot.harness",
  CFBundleVersion: "202609301200",
  CFBundleShortVersionString: "1.0.0",
  CFBundleExecutable: "Harness",
  ...over,
});

test("machOCpuTypes reads thin and universal headers and rejects other files", () => {
  expect(machOCpuTypes(thin(ARM64))).toEqual([ARM64]);
  expect(machOCpuTypes(fat([X86_64, ARM64]))).toEqual([X86_64, ARM64]);
  expect(machOCpuTypes(new TextEncoder().encode("#!/bin/sh\necho hi\n"))).toBeNull();
  expect(machOCpuTypes(new Uint8Array([0xcf, 0xfa]))).toBeNull();
});

test("a native SwiftUI app with the right id and build passes", () => {
  writeApp(info());
  expect(checkApp(app, expected)).toEqual({ errors: [], version: "1.0.0", build: "202609301200" });
});

test("a universal binary passes when one slice is arm64", () => {
  const binary = new Uint8Array([...fat([X86_64, ARM64]), ...new TextEncoder().encode(SWIFTUI)]);
  writeApp(info(), binary);
  expect(checkApp(app, expected).errors).toEqual([]);
});

test("wrong bundle id (the Debug build) and wrong build number are both reported", () => {
  writeApp(info({ CFBundleIdentifier: "com.markhuot.harness.dev", CFBundleVersion: "1" }));
  expect(checkApp(app, expected).errors).toEqual([
    "CFBundleIdentifier is 'com.markhuot.harness.dev', expected 'com.markhuot.harness'",
    "CFBundleVersion is '1', expected '202609301200'",
  ]);
});

test("a missing or non-arm64 executable fails", () => {
  writeApp(info(), null);
  expect(checkApp(app, expected).errors).toEqual(["the executable Harness is missing"]);
  writeFileSync(join(app, "Harness"), thin(X86_64, SWIFTUI));
  expect(checkApp(app, expected).errors).toEqual(["Harness isn't an arm64 Mach-O executable"]);
});

test("an RN build can't pass as native: JS bundle, React frameworks, no SwiftUI", () => {
  writeApp(info(), thin(ARM64, "\0/usr/lib/libobjc.A.dylib\0"));
  writeFileSync(join(app, "main.jsbundle"), "__d(function(){})");
  mkdirSync(join(app, "Frameworks/React.framework"), { recursive: true });
  mkdirSync(join(app, "Frameworks/hermesvm.framework"), { recursive: true });
  expect(checkApp(app, expected).errors).toEqual([
    "main.jsbundle is embedded; this is the React Native app, not the native one",
    "Frameworks/React.framework is embedded; this is the React Native app, not the native one",
    "Frameworks/hermesvm.framework is embedded; this is the React Native app, not the native one",
    "Harness doesn't link SwiftUI; this isn't the native app",
  ]);
});

test("an RN build needs a non-empty main.jsbundle", () => {
  writeApp(info());
  const rn = { ...expected, kind: "rn" as const };
  expect(checkApp(app, rn).errors).toEqual(["main.jsbundle is not embedded; this build would try to load from Metro"]);
  writeFileSync(join(app, "main.jsbundle"), "");
  expect(checkApp(app, rn).errors).toHaveLength(1);
  writeFileSync(join(app, "main.jsbundle"), "__d(function(){})");
  expect(checkApp(app, rn).errors).toEqual([]);
});

test("an app without Info.plist fails instead of throwing", () => {
  expect(checkApp(app, expected).errors).toEqual([`${app} has no Info.plist`]);
});

test("parseArgs: build numbers are digits only and required for archive", () => {
  expect(parseArgs(["archive", "--build-number", "202609301200"])).toMatchObject({ command: "archive", buildNumber: "202609301200" });
  expect(parseArgs(["archive", "--build-number=7"])).toMatchObject({ buildNumber: "7" });
  expect(() => parseArgs(["archive"])).toThrow(UsageError);
  expect(() => parseArgs(["archive", "--build-number", "1.0"])).toThrow("digits");
  expect(() => parseArgs(["archive", "--build-number"])).toThrow("needs a value");
});

test("parseArgs: export method, unknown commands and flags", () => {
  expect(parseArgs(["export", "--method", "testflight"])).toMatchObject({ method: "testflight", exportPath: expect.stringMatching(/ipa-testflight$/) });
  expect(parseArgs(["export", "--method", "dev"])).toMatchObject({ exportPath: expect.stringMatching(/ipa-dev$/) });
  expect(() => parseArgs(["export", "--method", "adhoc"])).toThrow("dev or testflight");
  expect(() => parseArgs(["export"])).toThrow("--method");
  expect(() => parseArgs(["sim", "--build-number", "1"])).toThrow("sim doesn't take --build-number");
  expect(() => parseArgs(["ipa"])).toThrow("unknown command");
  expect(() => parseArgs([])).toThrow("unknown command");
});

test("parseArgs: device needs --device; verify needs a kind and one app", () => {
  expect(parseArgs(["device", "--device", "Mark's iPhone", "--launch"])).toEqual({ command: "device", device: "Mark's iPhone", launch: true });
  expect(parseArgs(["device", "--device", "X"])).toMatchObject({ launch: false });
  expect(() => parseArgs(["device"])).toThrow("--device");
  const verify = ["verify", "--kind", "native", "--bundle-id", "com.markhuot.harness", "--build-number", "1"];
  expect(parseArgs([...verify, "a.app"])).toMatchObject({ kind: "native", app: expect.stringMatching(/a\.app$/) });
  expect(() => parseArgs(verify)).toThrow("exactly one");
  expect(() => parseArgs([...verify, "a.app", "b.app"])).toThrow("exactly one");
  expect(() => parseArgs(["verify", "--kind", "expo", "--bundle-id", "x", "--build-number", "1", "a.app"])).toThrow("native or rn");
});

test("ios/ export options stay in step with the RN app's until mobile/ is deleted", () => {
  for (const name of ["ExportOptions.plist", "ExportOptions-testflight.plist"]) {
    const read = (p: string) => readFileSync(join(import.meta.dir, p, name), "utf8");
    expect(read("..")).toBe(read("../../mobile"));
  }
});

test("checkApp checks the display name only when one is expected", () => {
  writeApp(info({ CFBundleIdentifier: "com.markhuot.harness.dev", CFBundleDisplayName: "Harness Dev" }));
  const beta = { ...expected, bundleId: "com.markhuot.harness.dev" };
  expect(checkApp(app, beta).errors).toEqual([]);
  expect(checkApp(app, { ...beta, displayName: "Harness Beta" }).errors).toEqual(["CFBundleDisplayName is 'Harness Dev', expected 'Harness Beta'"]);
  writeApp(info({ CFBundleIdentifier: "com.markhuot.harness.dev", CFBundleDisplayName: "Harness Beta" }));
  expect(checkApp(app, { ...beta, displayName: "Harness Beta" }).errors).toEqual([]);
});

test("parseArgs --beta: its own archive and export paths, dev export only", () => {
  expect(parseArgs(["archive", "--build-number", "1", "--beta"])).toMatchObject({ beta: true, archivePath: expect.stringMatching(/HarnessBeta\.xcarchive$/) });
  expect(parseArgs(["archive", "--build-number", "1"])).toMatchObject({ beta: false, archivePath: expect.stringMatching(/\/Harness\.xcarchive$/) });
  expect(parseArgs(["export", "--method", "dev", "--beta"])).toMatchObject({
    beta: true,
    archivePath: expect.stringMatching(/HarnessBeta\.xcarchive$/),
    exportPath: expect.stringMatching(/ipa-beta$/),
  });
  expect(() => parseArgs(["export", "--method", "testflight", "--beta"])).toThrow("never goes to TestFlight");
  expect(() => parseArgs(["sim", "--beta"])).toThrow("sim doesn't take --beta");
  expect(() => parseArgs(["device", "--device", "x", "--beta"])).toThrow("device doesn't take --beta");
});

test("parseArgs verify --beta: expects the beta id and name, native only, and no other --bundle-id", () => {
  const v = ["verify", "--kind", "native", "--build-number", "1", "--beta", "a.app"];
  expect(parseArgs(v)).toMatchObject({ bundleId: "com.markhuot.harness.dev", displayName: "Harness Beta" });
  expect(parseArgs([...v, "--bundle-id", "com.markhuot.harness.dev"])).toMatchObject({ bundleId: "com.markhuot.harness.dev" });
  expect(() => parseArgs([...v, "--bundle-id", "com.markhuot.harness"])).toThrow("not --bundle-id com.markhuot.harness");
  expect(() => parseArgs(["verify", "--kind", "rn", "--build-number", "1", "--beta", "a.app"])).toThrow("--kind native");
  // Without --beta, --bundle-id is still required and no display name is checked.
  expect(() => parseArgs(["verify", "--kind", "native", "--build-number", "1", "a.app"])).toThrow("--bundle-id");
  expect(parseArgs(["verify", "--kind", "native", "--bundle-id", "x", "--build-number", "1", "a.app"])).not.toHaveProperty("displayName");
});

test("parseArgs publish-beta deploys unless --no-deploy, and takes nothing else", () => {
  expect(parseArgs(["publish-beta"])).toEqual({ command: "publish-beta", deploy: true });
  expect(parseArgs(["publish-beta", "--no-deploy"])).toEqual({ command: "publish-beta", deploy: false });
  expect(() => parseArgs(["publish-beta", "--build-number", "1"])).toThrow("publish-beta doesn't take --build-number");
  expect(() => parseArgs(["publish-beta", "x"])).toThrow("unexpected argument");
});

test("clockBuildNumber is the UTC minute as digits, zero-padded", () => {
  expect(clockBuildNumber(new Date("2026-01-02T03:04:59.999Z"))).toBe("202601020304");
  expect(clockBuildNumber(new Date("2026-10-02T23:59:00-05:00"))).toBe("202610030459"); // UTC, not local
});

test("findToken finds a token in any file, nested or binary, and nothing when there are no tokens", () => {
  mkdirSync(join(app, "Frameworks/X.framework"), { recursive: true });
  writeFileSync(join(app, "Info.plist"), "plain");
  expect(findToken(dir, ["secret-token-1234"])).toBeNull();
  const nested = join(app, "Frameworks/X.framework/X");
  writeFileSync(nested, new Uint8Array([0, 1, ...Buffer.from("xxsecret-token-1234yy"), 255]));
  expect(findToken(dir, ["other-token-0000", "secret-token-1234"])).toBe(nested);
  expect(findToken(dir, [])).toBeNull();
});

test("withBetaBuild puts the IPA on the site and keeps the release data", () => {
  const saved = { site: "https://s.example", tag: "app-1", releaseUrl: "r", date: "d", ios: { url: "i", version: "1", build: "2", bytes: 3 }, mac: null, iosBeta: null } as ReleaseInfo;
  const next = withBetaBuild(saved, { version: "1.0.0", build: "202610021200" }, 42, new Date("2026-10-02T23:00:00Z"));
  expect(next.iosBeta).toEqual({ url: "https://s.example/HarnessBeta.ipa", version: "1.0.0", build: "202610021200", bytes: 42, builtAt: "2026-10-02" });
  expect({ ...next, iosBeta: null } as ReleaseInfo).toEqual(saved);
});

test("checkServed reports the status, content type and length it got", async () => {
  const served = (status: number, headers: Record<string, string>) => (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
  const ok = served(200, { "content-type": "application/octet-stream", "content-length": "42" });
  expect(await checkServed("u", /^application\/octet-stream/, 42, ok)).toEqual([]);
  expect(await checkServed("u", /^application\/octet-stream/, 43, ok)).toEqual(["u is 42 bytes, expected 43"]);
  expect(await checkServed("u", /^(text|application)\/xml/, undefined, served(404, { "content-type": "text/html" }))).toEqual(["u returned 404", "u is served as 'text/html'"]);
});
