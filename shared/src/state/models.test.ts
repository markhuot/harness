import { describe, expect, test } from "bun:test";
import type { DriverModels, ModelInfo } from "../index";
import { decodeChoice, driverModelChoices, encodeChoice, inheritedModel, ModelListCache, modelOptions, ticketModelBadge } from "./models";

const MODELS: ModelInfo[] = [
  { id: "opus", name: "Opus 5.5", default: true },
  { id: "sonnet", name: "Sonnet 5" },
];

describe("modelOptions", () => {
  test("default option names the inherited model, else the driver default; the driver default is marked", () => {
    expect(modelOptions(MODELS, null, { inherited: "sonnet" })).toEqual([
      { value: "", label: "Default (Sonnet 5)" },
      { value: "opus", label: "Opus 5.5 · default" },
      { value: "sonnet", label: "Sonnet 5" },
    ]);
    expect(modelOptions(MODELS, null)[0]).toEqual({ value: "", label: "Default (Opus 5.5)" });
    // inherited id not in the list: shown by id
    expect(modelOptions(MODELS, null, { inherited: "claude-x-1" })[0]!.label).toBe("Default (claude-x-1)");
  });

  test("a current value missing from the list stays selectable as custom (also while loading)", () => {
    expect(modelOptions(MODELS, "claude-opus-4-1").at(-1)).toEqual({ value: "claude-opus-4-1", label: "claude-opus-4-1 (custom)" });
    expect(modelOptions(undefined, "haiku")).toEqual([
      { value: "", label: "Default" },
      { value: "haiku", label: "haiku (custom)" },
    ]);
    expect(modelOptions(MODELS, "sonnet").filter((o) => o.value === "sonnet")).toHaveLength(1);
  });

  test("plainDefault keeps the label as given", () => {
    expect(modelOptions(MODELS, null, { defaultLabel: "Same as work", plainDefault: true })[0]).toEqual({ value: "", label: "Same as work" });
  });
});

describe("inheritedModel", () => {
  const project = { defaultModels: { "claude-code": "sonnet" } };
  const settings = { defaultModels: { "claude-code": "opus", dummy: "dummy-slow" } };
  test("each level inherits from the levels above it only", () => {
    expect(inheritedModel("claude-code", "ticket", project, settings)).toBe("sonnet");
    expect(inheritedModel("claude-code", "project", project, settings)).toBe("opus");
    expect(inheritedModel("claude-code", "settings", project, settings)).toBeNull();
    expect(inheritedModel("dummy", "ticket", project, settings)).toBe("dummy-slow");
    expect(inheritedModel("anthropic-api", "ticket", project, settings)).toBeNull();
    expect(inheritedModel("claude-code", "ticket", null, null)).toBeNull();
  });
});

describe("ticketModelBadge", () => {
  test("only for tickets with their own model; uses the display name when known", () => {
    expect(ticketModelBadge(null, MODELS)).toBeNull();
    expect(ticketModelBadge("sonnet", MODELS)).toBe("Sonnet 5");
    expect(ticketModelBadge("haiku", undefined)).toBe("haiku");
  });
});

describe("ModelListCache", () => {
  const reply = (driverId: string, ids: string[]): DriverModels => ({ driverId, models: ids.map((id) => ({ id, name: id })), error: null, fetchedAt: 1 });

  test("one fetch per driver, shared; refresh forces a re-query; errors are kept with the last data", async () => {
    const calls: string[] = [];
    let fail = false;
    const cache = new ModelListCache(async (id, refresh) => {
      calls.push(`${id}${refresh ? "!" : ""}`);
      if (fail) throw new Error("offline");
      return reply(id, [`${id}-m`]);
    });
    let notified = 0;
    cache.subscribe(() => notified++);
    await Promise.all([cache.load("a"), cache.load("a"), cache.load("b")]);
    await cache.load("a");
    expect(calls).toEqual(["a", "b"]);
    expect(cache.get("a").data!.models[0]!.id).toBe("a-m");
    expect(notified).toBeGreaterThan(0);

    fail = true;
    await cache.load("a", true);
    expect(calls.at(-1)).toBe("a!");
    expect(cache.get("a")).toMatchObject({ loading: false, error: "offline" });
    expect(cache.get("a").data!.models[0]!.id).toBe("a-m");
    // a failed driver isn't hammered by every mounted select
    await cache.load("a");
    expect(calls.filter((c) => c.startsWith("a"))).toHaveLength(2);
  });

  test("a new connection epoch drops cached lists", async () => {
    let n = 0;
    const cache = new ModelListCache(async (id) => reply(id, [`v${++n}`]));
    await cache.load("a");
    cache.syncEpoch(0);
    await cache.load("a");
    expect(cache.get("a").data!.models[0]!.id).toBe("v1");
    cache.syncEpoch(1);
    expect(cache.get("a").data).toBeNull();
    await cache.load("a");
    expect(cache.get("a").data!.models[0]!.id).toBe("v2");
  });

  test("empty driver id is a no-op", async () => {
    const cache = new ModelListCache(async () => {
      throw new Error("should not be called");
    });
    await cache.load("");
    expect(cache.get("")).toEqual({ data: null, loading: false, error: null });
  });
});

describe("driverModelChoices (combined driver + model select)", () => {
  const drivers = [
    { id: "claude-code", name: "Claude Code", available: true, authenticated: true },
    { id: "anthropic-api", name: "Anthropic API", available: true, authenticated: true },
    { id: "codex", name: "Codex", available: true, authenticated: false },
  ];
  const models: Record<string, ModelInfo[]> = {
    "claude-code": [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet", default: true },
    ],
    "anthropic-api": [{ id: "claude-sonnet-5", name: "Sonnet 5", default: true }],
    codex: [{ id: "luna", name: "Luna" }],
  };
  const none = { driver: null, model: null };
  const resolved = { driver: "claude-code", model: null };

  test("signed-in drivers become groups of their models; others are left out", () => {
    const c = driverModelChoices(drivers, models, none, resolved);
    expect(c.groups.map((g) => [g.label, g.options.map((o) => o.label)])).toEqual([
      ["Claude Code", ["Opus", "Sonnet"]],
      ["Anthropic API", ["Sonnet 5"]],
    ]);
    expect(decodeChoice(c.groups[0]!.options[0]!.value)).toEqual({ driver: "claude-code", model: "opus" });
    expect(c.default).toEqual({ value: "", label: "Default (Claude Code · Sonnet)" });
    expect(c.selectedLabel).toBe("Default (Claude Code · Sonnet)");
  });

  test("one signed-in driver collapses to a flat list without the driver name", () => {
    const one = drivers.map((d) => (d.id === "anthropic-api" ? { ...d, authenticated: false } : d));
    const c = driverModelChoices(one, models, { driver: "claude-code", model: "opus" }, { driver: "claude-code", model: "opus" });
    expect(c.groups).toHaveLength(1);
    expect(c.groups[0]!.label).toBeNull();
    expect(c.default.label).toBe("Default (Opus)");
    expect(c.selectedLabel).toBe("Opus");
  });

  test("a picked driver that isn't signed in stays listed, so the value never disappears", () => {
    const c = driverModelChoices(drivers, models, { driver: "codex", model: "luna" }, resolved);
    expect(c.groups.map((g) => g.driver)).toEqual(["claude-code", "anthropic-api", "codex"]);
    expect(c.selectedLabel).toBe("Codex · Luna");
  });

  test("a driver picked without a model gets its default entry; unknown models are kept as custom", () => {
    const a = driverModelChoices(drivers, models, { driver: "claude-code", model: null }, resolved);
    expect(a.groups[0]!.options[0]).toEqual({ value: encodeChoice({ driver: "claude-code", model: null }), label: "Claude Code default (Sonnet)" });
    expect(a.selectedLabel).toBe("Claude Code default (Sonnet)");
    const b = driverModelChoices(drivers, models, { driver: "claude-code", model: "claude-x-1" }, resolved);
    expect(b.groups[0]!.options.at(-1)!.label).toBe("claude-x-1 (custom)");
    expect(b.groups[1]!.options.some((o) => o.label.includes("custom"))).toBe(false);
  });

  test("encode/decode round-trip; Default is the empty value", () => {
    expect(encodeChoice(none)).toBe("");
    expect(decodeChoice("")).toEqual(none);
    expect(decodeChoice(encodeChoice({ driver: "a", model: "m:1" }))).toEqual({ driver: "a", model: "m:1" });
    expect(decodeChoice(encodeChoice({ driver: "a", model: null }))).toEqual({ driver: "a", model: null });
  });
});
