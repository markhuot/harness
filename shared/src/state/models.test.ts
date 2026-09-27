import { describe, expect, test } from "bun:test";
import type { DriverModels, ModelInfo } from "../index";
import { inheritedModel, ModelListCache, modelOptions, ticketModelBadge } from "./models";

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
