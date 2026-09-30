import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../orchestrator/settings";
import { createDrivers } from "./index";

const ids = (env: Record<string, string | undefined>) => createDrivers({ settings: () => DEFAULT_SETTINGS, env }).map((d) => d.id);

describe("createDrivers", () => {
  test("leaves the dummy driver out of a normal service", () => {
    expect(ids({})).toEqual(["claude-code", "anthropic-api"]);
  });

  test("adds it only for HARNESS_DUMMY_DRIVER=1", () => {
    expect(ids({ HARNESS_DUMMY_DRIVER: "1" })).toEqual(["claude-code", "anthropic-api", "dummy"]);
    expect(ids({ HARNESS_DUMMY_DRIVER: "0" })).not.toContain("dummy");
    expect(ids({ HARNESS_DUMMY_DRIVER: "" })).not.toContain("dummy");
  });
});
