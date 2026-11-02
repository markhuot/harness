import { describe, expect, test } from "bun:test";
import { deviceTypeFor, extraRuntimes, pinnedRuntime, type Runtime } from "../../../ios/Tools/sim";

const type = (name: string) => ({ identifier: `id.${name}`, name });
const runtime = (version: string, names: string[], identifier = `iOS.${version}`): Runtime => ({ identifier, version, isAvailable: true, supportedDeviceTypes: names.map(type) });

describe("simulator pool", () => {
  // simctl lists the Duo-only 27.2 runtime ahead of the main one, as it does on this Mac.
  const duo = runtime("27.2", ["iPhone Duo"], "iOS-27-2-iPhone19-4");
  const main = runtime("27.2", ["iPhone 18 Pro", "iPad Pro 11-inch (M5)"], "iOS-27-2");

  test("each kind runs on the 27.2 runtime that has its device, never the Duo-only one for an iPhone", () => {
    const installed = [runtime("27.1", ["iPhone Duo"]), duo, main];
    expect(pinnedRuntime(installed, "duo").identifier).toBe("iOS-27-2-iPhone19-4");
    expect(pinnedRuntime(installed, "iphone").identifier).toBe("iOS-27-2");
    expect(pinnedRuntime(installed, "ipad").identifier).toBe("iOS-27-2");
  });

  test("a device kind no 27.2 runtime supports is an error, not a fallback to another version", () => {
    expect(() => pinnedRuntime([runtime("27.1", ["iPhone Duo"]), main], "duo")).toThrow("no iOS 27.2 simulator runtime with an iPhone Duo");
    expect(() => pinnedRuntime([runtime("27.0", ["iPhone 18 Pro"]), duo], "iphone")).toThrow("no iOS 27.2 simulator runtime with an iPhone");
  });

  test("the duo kind picks the iPhone Duo device type and never falls back to another phone", () => {
    expect(deviceTypeFor(duo, "duo").name).toBe("iPhone Duo");
    expect(() => deviceTypeFor(main, "duo")).toThrow("no iPhone Duo device type");
  });

  test("only runtimes other than 27.2 are extras", () => {
    const image = (version: string) => ({ identifier: version, version, platformIdentifier: "com.apple.platform.iphonesimulator" });
    expect(extraRuntimes([image("27.0"), image("27.1"), image("27.2"), image("27.2.1")]).map((r) => r.version)).toEqual(["27.0", "27.1"]);
  });
});
