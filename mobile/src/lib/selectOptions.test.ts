import { describe, expect, test } from "bun:test";
import { driverOptions, selectedLabel } from "./selectOptions";

const drivers = [
  { id: "claude-code", name: "Claude Code", available: true, authenticated: true },
  { id: "anthropic", name: "Anthropic API", available: true, authenticated: false },
  { id: "codex", name: "Codex", available: false, authenticated: false },
];

describe("driverOptions", () => {
  test("a fallback option leads with the empty value; without one there's none", () => {
    expect(driverOptions(drivers, { none: "Global default (Claude Code)" })[0]).toEqual({ value: "", label: "Global default (Claude Code)" });
    expect(driverOptions(drivers).map((o) => o.value)).toEqual(["claude-code", "anthropic", "codex"]);
  });
  test("an empty fallback label still adds the option", () => {
    expect(driverOptions(drivers, { none: "" })[0]!.value).toBe("");
  });
  test("disable greys out a missing driver without a note", () => {
    const codex = driverOptions(drivers, { unavailable: "disable" }).find((o) => o.value === "codex")!;
    expect(codex).toEqual({ value: "codex", label: "Codex", disabled: true });
  });
  test("mark keeps a missing driver pickable and says so", () => {
    const codex = driverOptions(drivers, { unavailable: "mark" }).find((o) => o.value === "codex")!;
    expect(codex).toEqual({ value: "codex", label: "Codex · unavailable" });
  });
  test("an installed driver that isn't signed in says so; a missing one doesn't claim both", () => {
    const opts = driverOptions(drivers, { unavailable: "mark" });
    expect(opts.find((o) => o.value === "anthropic")!.label).toBe("Anthropic API · not signed in");
    expect(opts.find((o) => o.value === "claude-code")!.label).toBe("Claude Code");
    expect(opts.find((o) => o.value === "codex")!.label).not.toContain("signed in");
  });
});

describe("selectedLabel", () => {
  const opts = [{ value: "", label: "Default" }, { value: "a", label: "Alpha" }];
  test("the empty value is a real option, not a miss", () => {
    expect(selectedLabel(opts, "", "Choose…")).toBe("Default");
  });
  test("a value that isn't listed falls back", () => {
    expect(selectedLabel(opts, "gone", "gone-driver")).toBe("gone-driver");
  });
});
