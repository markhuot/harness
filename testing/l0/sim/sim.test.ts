import { describe, expect, test } from "bun:test";
import { DUO_RUNTIME, IOS_RUNTIME, deviceTypeFor, extraRuntimes, runtimeVersionFor, type Runtime } from "../../../ios/Tools/sim";

const type = (name: string) => ({ identifier: `id.${name}`, name });
const runtime = (version: string, names: string[]): Runtime => ({ identifier: `rt.${version}`, version, isAvailable: true, supportedDeviceTypes: names.map(type) });

describe("simulator pool", () => {
  test("the Duo runs on 27.1, everything else on 27.0", () => {
    expect(runtimeVersionFor("duo")).toBe(DUO_RUNTIME);
    expect(runtimeVersionFor("iphone")).toBe(IOS_RUNTIME);
    expect(runtimeVersionFor("ipad")).toBe(IOS_RUNTIME);
  });

  test("the duo kind picks the iPhone Duo device type and never falls back to another phone", () => {
    expect(deviceTypeFor(runtime("27.1", ["iPhone Duo"]), "duo").name).toBe("iPhone Duo");
    expect(() => deviceTypeFor(runtime("27.0", ["iPhone 18 Pro"]), "duo")).toThrow("no iPhone Duo device type");
  });

  test("only runtimes other than 27.0 and 27.1 are extras", () => {
    const image = (version: string) => ({ identifier: version, version, platformIdentifier: "com.apple.platform.iphonesimulator" });
    expect(extraRuntimes([image("27.0"), image("27.1"), image("26.4")]).map((r) => r.version)).toEqual(["26.4"]);
  });
});
