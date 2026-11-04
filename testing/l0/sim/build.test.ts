import { describe, expect, test } from "bun:test";
import { deviceArgs, parseArgs, UsageError } from "../../../ios/Tools/build";

const configuration = (args: string[]) => args[args.indexOf("-configuration") + 1];

describe("device build", () => {
  test("--optimized builds Release, still development-signed so Instruments can attach", () => {
    const o = parseArgs(["device", "--device", "Mark's iPhone", "--optimized", "--launch"]);
    expect(o).toEqual({ command: "device", device: "Mark's iPhone", launch: true, optimized: true });
    const args = deviceArgs(true);
    expect(configuration(args)).toBe("Release");
    expect(args).toContain("CODE_SIGN_STYLE=Automatic");
  });

  test("without it, the device build stays Debug", () => {
    const o = parseArgs(["device", "--device", "00008130"]);
    expect(o).toMatchObject({ optimized: false, launch: false });
    expect(configuration(deviceArgs())).toBe("Debug");
  });

  test("--optimized is for builds you run, not the release archive", () => {
    expect(() => parseArgs(["archive", "--build-number", "202611041200", "--optimized"])).toThrow(UsageError);
  });
});
