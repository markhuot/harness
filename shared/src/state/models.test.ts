import { describe, expect, test } from "bun:test";
import type { DriverModels, ModelInfo } from "../index";
import {
  decodeChoice,
  driverModelChoices,
  encodeChoice,
  filterChoiceGroups,
  inheritedModel,
  ModelListCache,
  modelOptions,
  projectChoice,
  projectChoicePatch,
  projectDriver,
  settingsChoice,
  settingsChoicePatch,
  ticketChoice,
  ticketChoicePatch,
  ticketResolvedChoice,
  filterPhaseGroups,
  phaseMatrix,
  phasePickPatch,
  phaseSummary,
} from "./models";
import { inheritedPhaseModels } from "../phases";

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
    expect(c.default!.label).toBe("Default (Opus)");
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

  test("onlyDriver lists that driver alone; Default stays only when it resolves there", () => {
    const same = driverModelChoices(drivers, models, { driver: "claude-code", model: "opus" }, resolved, { onlyDriver: "claude-code" });
    expect(same.groups.map((g) => g.driver)).toEqual(["claude-code"]);
    expect(same.groups[0]!.label).toBeNull();
    expect(same.default?.label).toBe("Default (Sonnet)");
    const other = driverModelChoices(drivers, models, { driver: "anthropic-api", model: null }, resolved, { onlyDriver: "anthropic-api" });
    expect(other.default).toBeNull();
    expect(other.groups.flatMap((g) => g.options.map((o) => o.label))).toEqual(["Anthropic API default (Sonnet 5)", "Sonnet 5"]);
    expect(other.selectedLabel).toBe("Anthropic API default (Sonnet 5)");
    // A locked driver that isn't signed in still shows (the ticket already runs on it)
    expect(driverModelChoices(drivers, models, { driver: "codex", model: "luna" }, resolved, { onlyDriver: "codex" }).groups.map((g) => g.driver)).toEqual(["codex"]);
  });

  test("a driver's default entry names what it inherits when told, not the list's default", () => {
    const c = driverModelChoices(drivers, models, { driver: "claude-code", model: null }, { driver: "anthropic-api", model: null }, { inheritedModel: (d) => (d === "claude-code" ? "opus" : null) });
    expect(c.groups[0]!.options[0]!.label).toBe("Claude Code default (Opus)");
    expect(c.default!.label).toBe("Default (Anthropic API · Sonnet 5)");
  });

  test("encode/decode round-trip; Default is the empty value", () => {
    expect(encodeChoice(none)).toBe("");
    expect(decodeChoice("")).toEqual(none);
    expect(decodeChoice(encodeChoice({ driver: "a", model: "m:1" }))).toEqual({ driver: "a", model: "m:1" });
    expect(decodeChoice(encodeChoice({ driver: "a", model: null }))).toEqual({ driver: "a", model: null });
  });
});

describe("filterChoiceGroups (type-ahead)", () => {
  const groups = [
    { driver: "claude-code", label: "Claude Code", options: [{ value: encodeChoice({ driver: "claude-code", model: "opus" }), label: "Opus 5.5" }, { value: encodeChoice({ driver: "claude-code", model: "sonnet" }), label: "Sonnet 5" }] },
    { driver: "openrouter", label: "OpenRouter", options: [{ value: encodeChoice({ driver: "openrouter", model: "openai/gpt-4o" }), label: "GPT-4o" }] },
  ];

  test("an empty query keeps everything", () => {
    expect(filterChoiceGroups(groups, "  ")).toBe(groups);
  });

  test("words match label, model id or driver name; groups without matches drop out", () => {
    expect(filterChoiceGroups(groups, "claude op").map((g) => g.options.map((o) => o.label))).toEqual([["Opus 5.5"]]);
    expect(filterChoiceGroups(groups, "openai").map((g) => g.driver)).toEqual(["openrouter"]); // by model id
    expect(filterChoiceGroups(groups, "SONNET")[0]!.options.map((o) => o.label)).toEqual(["Sonnet 5"]);
    expect(filterChoiceGroups(groups, "opus router")).toEqual([]);
  });

  test("a flat group (no label) still matches its driver through driverNames", () => {
    const flat = [{ ...groups[0]!, label: null }];
    expect(filterChoiceGroups(flat, "claude", { "claude-code": "Claude Code" })[0]!.options).toHaveLength(2);
  });
});

describe("ticket / project / settings picks", () => {
  const settings = { defaultDriver: "claude-code", defaultModels: { "claude-code": "sonnet" } as Record<string, string | null> };
  const project = { defaultDriver: "codex", defaultModels: { codex: "luna", "claude-code": "opus" } };
  const plain = { defaultDriver: null, defaultModels: {} };

  test("projectDriver: the project's own, else the settings'", () => {
    expect(projectDriver(project, settings)).toBe("codex");
    expect(projectDriver(plain, settings)).toBe("claude-code");
    expect(projectDriver(null, null)).toBe("");
  });

  test("a ticket on its project's driver without a model shows as Default; anything else as its pick", () => {
    expect(ticketChoice({ driver: "codex", model: null }, project, settings)).toEqual({ driver: null, model: null });
    expect(ticketChoice({ driver: "codex", model: "luna" }, project, settings)).toEqual({ driver: "codex", model: "luna" });
    // Another driver without a model is a real pick, not Default
    expect(ticketChoice({ driver: "claude-code", model: null }, project, settings)).toEqual({ driver: "claude-code", model: null });
  });

  test("a ticket's Default resolves to the project's driver and the model it inherits there", () => {
    expect(ticketResolvedChoice(project, settings)).toEqual({ driver: "codex", model: "luna" });
    expect(ticketResolvedChoice(plain, settings)).toEqual({ driver: "claude-code", model: "sonnet" });
    expect(ticketResolvedChoice(null, null)).toEqual({ driver: null, model: null });
  });

  test("picking Default moves a ticket back to its project's driver and clears its model", () => {
    expect(ticketChoicePatch({ driver: null, model: null }, project, settings)).toEqual({ driver: "codex", model: null });
    expect(ticketChoicePatch({ driver: "claude-code", model: "opus" }, project, settings)).toEqual({ driver: "claude-code", model: "opus" });
    expect(ticketChoicePatch({ driver: null, model: null }, null, null)).toEqual({ model: null });
  });

  test("a project shows its pinned driver's model, a model for the settings' driver, or Default", () => {
    expect(projectChoice(project, settings)).toEqual({ driver: "codex", model: "luna" });
    expect(projectChoice({ defaultDriver: "codex", defaultModels: {} }, settings)).toEqual({ driver: "codex", model: null });
    expect(projectChoice({ defaultDriver: null, defaultModels: { "claude-code": "opus" } }, settings)).toEqual({ driver: "claude-code", model: "opus" });
    expect(projectChoice({ defaultDriver: null, defaultModels: { codex: "luna" } }, settings)).toEqual({ driver: null, model: null });
  });

  test("a project pick keeps only that driver's model; Default clears the driver and every model", () => {
    expect(projectChoicePatch({ driver: "claude-code", model: "haiku" }, project)).toEqual({ defaultDriver: "claude-code", defaultModels: { codex: null, "claude-code": "haiku" } });
    expect(projectChoicePatch({ driver: null, model: null }, project)).toEqual({ defaultDriver: null, defaultModels: { codex: null, "claude-code": null } });
  });

  test("settings show Default until the default driver has a model", () => {
    expect(settingsChoice(settings)).toEqual({ driver: "claude-code", model: "sonnet" });
    expect(settingsChoice({ defaultDriver: "codex", defaultModels: { "claude-code": "sonnet" } })).toEqual({ driver: null, model: null });
  });

  test("a settings pick sets the driver with only its model; Default keeps the driver and clears models", () => {
    const s = { defaultDriver: "claude-code", defaultModels: { "claude-code": "sonnet", codex: "luna" } };
    expect(settingsChoicePatch({ driver: "codex", model: null }, s)).toEqual({ defaultDriver: "codex", defaultModels: { "claude-code": null, codex: null } });
    expect(settingsChoicePatch({ driver: "codex", model: "luna-2" }, s)).toEqual({ defaultDriver: "codex", defaultModels: { "claude-code": null, codex: "luna-2" } });
    expect(settingsChoicePatch({ driver: null, model: null }, s)).toEqual({ defaultDriver: "claude-code", defaultModels: { "claude-code": null, codex: null } });
  });
});

describe("the phase matrix", () => {
  const drivers = [
    { id: "claude-code", name: "Claude Code", available: true, authenticated: true },
    { id: "codex", name: "Codex", available: true, authenticated: true },
    { id: "gone", name: "Gone", available: false, authenticated: false },
  ];
  const models: Record<string, ModelInfo[]> = {
    "claude-code": [
      { id: "opus", name: "Opus 5.5", default: true },
      { id: "haiku", name: "Haiku 5.5" },
    ],
    codex: [{ id: "luna", name: "Luna" }],
  };
  const settings = { work: { driver: "claude-code", model: "opus" }, complete: { driver: "claude-code", model: "haiku" } };

  test("app level: no Inherit row, every column resolves, unset phases select the Work driver's default", () => {
    const m = phaseMatrix(drivers, models, settings, null);
    expect(m.inherit).toBeNull();
    expect(m.inheritNames).toBeNull();
    expect(m.groups.map((g) => g.driver)).toEqual(["claude-code", "codex"]);
    expect(m.groups[0]!.rows.map((r) => r.label)).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Haiku 5.5"]);
    expect(m.selected).toEqual({ plan: encodeChoice({ driver: "claude-code", model: null }), work: encodeChoice({ driver: "claude-code", model: "opus" }), review: encodeChoice({ driver: "claude-code", model: null }), complete: encodeChoice({ driver: "claude-code", model: "haiku" }) });
    expect(m.summary).toBe("Opus 5.5 · Complete: Haiku 5.5");
  });

  test("ticket level: unset phases select Inherit, which names what they inherit", () => {
    const inherited = inheritedPhaseModels("ticket", null, settings)!;
    const m = phaseMatrix(drivers, models, { work: { driver: "codex", model: "luna" } }, inherited);
    expect(m.inherit?.label).toBe("Defaults");
    expect(m.inheritNames).toEqual({ plan: "Opus 5.5", work: "Opus 5.5", review: "Opus 5.5", complete: "Haiku 5.5" });
    expect(m.selected.plan).toBe("");
    expect(m.selected.work).toBe(encodeChoice({ driver: "codex", model: "luna" }));
    expect(m.summary).toBe("Codex · Luna · Planning: Claude Code · Opus 5.5 · Review: Claude Code · Opus 5.5 · Complete: Claude Code · Haiku 5.5");
  });

  test("defaults spanning several drivers name each phase's driver; an unknown model id shows as is", () => {
    const mixed = { plan: { driver: "codex", model: "luna" }, work: { driver: "claude-code", model: "opus" }, review: { driver: "claude-code", model: "gpt-9" }, complete: { driver: "claude-code", model: null } };
    const m = phaseMatrix(drivers, models, {}, mixed);
    expect(m.inheritNames).toEqual({ plan: "Codex · Luna", work: "Claude Code · Opus 5.5", review: "Claude Code · gpt-9", complete: "Claude Code · Opus 5.5" });
    expect(m.summary).toBe("Claude Code · Opus 5.5 · Planning: Codex · Luna · Review: Claude Code · gpt-9");
  });

  test("a picked driver or model that isn't listed is kept", () => {
    const m = phaseMatrix(drivers, models, { review: { driver: "gone", model: "x-1" }, plan: { driver: "claude-code", model: "custom-1" } }, inheritedPhaseModels("project", null, settings));
    expect(m.groups.map((g) => g.driver)).toEqual(["claude-code", "codex", "gone"]);
    expect(m.groups[0]!.rows.at(-1)!.label).toBe("custom-1 (custom)");
    expect(m.groups[2]!.rows.map((r) => r.label)).toEqual(["Default", "x-1 (custom)"]);
  });

  test("type-ahead filters rows; a pick patches one phase, Inherit clears it", () => {
    const m = phaseMatrix(drivers, models, {}, null);
    expect(filterPhaseGroups(m.groups, "hai").flatMap((g) => g.rows.map((r) => r.label))).toEqual(["Haiku 5.5"]);
    expect(filterPhaseGroups(m.groups, "codex").map((g) => g.driver)).toEqual(["codex"]);
    expect(phasePickPatch("complete", { choice: { driver: "codex", model: "luna" } })).toEqual({ complete: { driver: "codex", model: "luna" } });
    expect(phasePickPatch("plan", { choice: null })).toEqual({ plan: null });
  });

  test("one driver everywhere: the summary leaves driver names out; identical phases fold into Work", () => {
    const one = { driver: "claude-code", model: "opus" };
    expect(phaseSummary({ plan: one, work: one, review: one, complete: { driver: "claude-code", model: "haiku" } }, models)).toBe("Opus 5.5 · Complete: Haiku 5.5");
  });
});
