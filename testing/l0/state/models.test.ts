import { describe, expect, test } from "bun:test";
import type { ModelInfo, Phase, PhaseChoice } from "../../../shared/src/protocol";
import {
  ModelListCache,
  decodeChoice,
  driverModelChoices,
  encodeChoice,
  filterChoiceGroups,
  filterPhaseGroups,
  inheritedModel,
  modelCacheFor,
  modelName,
  modelOptions,
  phaseChoiceModelName,
  phaseChoiceNames,
  phaseMatrix,
  phasePickPatch,
  phaseSummary,
  projectChoice,
  projectChoicePatch,
  projectDriver,
  settingsChoice,
  settingsChoicePatch,
  ticketChoice,
  ticketChoicePatch,
  ticketResolvedChoice,
  type ChoiceGroup,
} from "../../../shared/src/state/models";

const SEP = "\u0001";
const opus: ModelInfo = { id: "opus", name: "Opus 5.5" };
const sonnet: ModelInfo = { id: "sonnet", name: "Sonnet 5.5", default: true };
const drv = (id: string, name = id, ok = true) => ({ id, name, available: ok, authenticated: ok });

describe("modelName / inheritedModel", () => {
  test("a listed id shows its name; an unlisted or missing list shows the id", () => {
    expect(modelName([opus], "opus")).toBe("Opus 5.5");
    expect(modelName([opus], "x")).toBe("x");
    expect(modelName(undefined, "x")).toBe("x");
  });
  test("a ticket inherits the project's model, then the settings'; a project inherits settings'; settings inherit nothing", () => {
    const project = { defaultModels: { d: "p" } };
    const settings = { defaultModels: { d: "s" } };
    expect(inheritedModel("d", "ticket", project, settings)).toBe("p");
    expect(inheritedModel("d", "ticket", { defaultModels: {} }, settings)).toBe("s");
    expect(inheritedModel("d", "project", project, settings)).toBe("s");
    expect(inheritedModel("d", "settings", project, settings)).toBeNull();
    expect(inheritedModel("d", "ticket", null, null)).toBeNull();
  });
});

describe("modelOptions", () => {
  test("Default names the list's default model; a missing list leaves it plain", () => {
    expect(modelOptions([opus, sonnet], null)[0]).toEqual({ value: "", label: "Default (Sonnet 5.5)" });
    expect(modelOptions(undefined, null)).toEqual([{ value: "", label: "Default" }]);
  });
  test("inherited names that model instead, and plainDefault names nothing", () => {
    expect(modelOptions([opus, sonnet], null, { inherited: "opus" })[0]!.label).toBe("Default (Opus 5.5)");
    expect(modelOptions([opus, sonnet], null, { inherited: "opus", plainDefault: true })[0]!.label).toBe("Default");
    expect(modelOptions([opus], null, { defaultLabel: "Inherit" })[0]!.label).toBe("Inherit");
  });
  test("the default model is marked, and a value not in the list is appended as custom", () => {
    const out = modelOptions([opus, sonnet], "mystery");
    expect(out.map((o) => o.label)).toEqual(["Default (Sonnet 5.5)", "Opus 5.5", "Sonnet 5.5 · default", "mystery (custom)"]);
    expect(modelOptions([opus], "opus")).toHaveLength(2);
    expect(modelOptions([opus], null)).toHaveLength(2);
  });
});

describe("encodeChoice / decodeChoice", () => {
  test("round trips driver and model; no driver is the empty string", () => {
    expect(encodeChoice({ driver: null, model: "x" })).toBe("");
    expect(encodeChoice({ driver: "d", model: null })).toBe(`d${SEP}`);
    expect(decodeChoice(encodeChoice({ driver: "d", model: "m" }))).toEqual({ driver: "d", model: "m" });
    expect(decodeChoice(encodeChoice({ driver: "d", model: null }))).toEqual({ driver: "d", model: null });
  });
  test("decode: empty, a bare driver without separator, and a model that itself holds the separator", () => {
    expect(decodeChoice("")).toEqual({ driver: null, model: null });
    expect(decodeChoice("d")).toEqual({ driver: "d", model: null });
    expect(decodeChoice(`d${SEP}a${SEP}b`)).toEqual({ driver: "d", model: `a${SEP}b` });
  });
});

describe("driverModelChoices", () => {
  const models = { cc: [opus, sonnet], api: [{ id: "gpt", name: "GPT" }] };
  test("only available, signed-in drivers get groups; the picked driver is kept even if not signed in", () => {
    const r = driverModelChoices([drv("cc", "Claude Code"), drv("api", "API", false)], models, { driver: null, model: null }, { driver: null, model: null });
    expect(r.groups.map((g) => g.driver)).toEqual(["cc"]);
    const kept = driverModelChoices([drv("cc", "Claude Code"), drv("api", "API", false)], models, { driver: "api", model: "gpt" }, { driver: null, model: null });
    expect(kept.groups.map((g) => g.driver)).toEqual(["cc", "api"]);
  });
  test("a picked driver the list doesn't know at all is appended under its id", () => {
    const r = driverModelChoices([drv("cc")], {}, { driver: "ghost", model: null }, { driver: null, model: null });
    expect(r.groups.map((g) => g.driver)).toEqual(["cc", "ghost"]);
  });
  test("one group is flat (no heading); two keep headings", () => {
    expect(driverModelChoices([drv("cc", "Claude Code")], models, { driver: null, model: null }, { driver: null, model: null }).groups[0]!.label).toBeNull();
    const two = driverModelChoices([drv("cc", "Claude Code"), drv("api", "API")], models, { driver: null, model: null }, { driver: null, model: null });
    expect(two.groups.map((g) => g.label)).toEqual(["Claude Code", "API"]);
  });
  test("Default names what it resolves to: driver only when several drivers show, then the model", () => {
    const two = [drv("cc", "Claude Code"), drv("api", "API")];
    expect(driverModelChoices(two, models, { driver: null, model: null }, { driver: "cc", model: "opus" }).default?.label).toBe("Default (Claude Code · Opus 5.5)");
    expect(driverModelChoices([drv("cc")], models, { driver: null, model: null }, { driver: "cc", model: "opus" }).default?.label).toBe("Default (Opus 5.5)");
    expect(driverModelChoices(two, models, { driver: null, model: null }, { driver: "cc", model: null }).default?.label).toBe("Default (Claude Code · Sonnet 5.5)");
    expect(driverModelChoices(two, models, { driver: null, model: null }, { driver: null, model: null }).default?.label).toBe("Default");
    expect(driverModelChoices(two, models, { driver: null, model: null }, { driver: null, model: null }, { defaultLabel: "Inherit" }).default?.label).toBe("Inherit");
  });
  test("a driver picked without a model gets a '<driver> default' entry, naming the inherited model when given", () => {
    const base = driverModelChoices([drv("cc", "Claude Code")], models, { driver: "cc", model: null }, { driver: null, model: null });
    expect(base.groups[0]!.options[0]).toEqual({ value: `cc${SEP}`, label: "Claude Code default (Sonnet 5.5)" });
    const inh = driverModelChoices([drv("cc", "Claude Code")], models, { driver: "cc", model: null }, { driver: null, model: null }, { inheritedModel: () => "opus" });
    expect(inh.groups[0]!.options[0]!.label).toBe("Claude Code default (Opus 5.5)");
    const none = driverModelChoices([drv("cc", "Claude Code")], {}, { driver: "cc", model: null }, { driver: null, model: null });
    expect(none.groups[0]!.options[0]!.label).toBe("Claude Code default");
  });
  test("a model the list lacks stays selectable as custom", () => {
    const r = driverModelChoices([drv("cc", "Claude Code")], models, { driver: "cc", model: "weird" }, { driver: null, model: null });
    expect(r.groups[0]!.options.at(-1)).toEqual({ value: `cc${SEP}weird`, label: "weird (custom)" });
    expect(r.selectedLabel).toBe("weird (custom)");
  });
  test("selectedLabel: Default when nothing is picked; flat lists show the bare label; grouped lists prefix the driver", () => {
    const flat = driverModelChoices([drv("cc", "Claude Code")], models, { driver: "cc", model: "opus" }, { driver: null, model: null });
    expect(flat.selectedLabel).toBe("Opus 5.5");
    const grouped = driverModelChoices([drv("cc", "Claude Code"), drv("api", "API")], models, { driver: "cc", model: "opus" }, { driver: null, model: null });
    expect(grouped.selectedLabel).toBe("Claude Code · Opus 5.5");
    const unpicked = driverModelChoices([drv("cc", "Claude Code")], models, { driver: null, model: null }, { driver: "cc", model: "opus" });
    expect(unpicked.selectedLabel).toBe("Default (Opus 5.5)");
    const driverDefault = driverModelChoices([drv("cc", "Claude Code"), drv("api", "API")], models, { driver: "cc", model: null }, { driver: null, model: null });
    expect(driverDefault.selectedLabel).toBe("Claude Code default (Sonnet 5.5)");
  });
  test("onlyDriver lists that driver alone, and offers Default only if it resolves to it", () => {
    const two = [drv("cc", "Claude Code"), drv("api", "API")];
    const ok = driverModelChoices(two, models, { driver: "cc", model: "opus" }, { driver: "cc", model: null }, { onlyDriver: "cc" });
    expect(ok.groups.map((g) => g.driver)).toEqual(["cc"]);
    expect(ok.default).not.toBeNull();
    const other = driverModelChoices(two, models, { driver: "cc", model: "opus" }, { driver: "api", model: null }, { onlyDriver: "cc" });
    expect(other.default).toBeNull();
    const absent = driverModelChoices([], models, { driver: "cc", model: null }, { driver: "cc", model: null }, { onlyDriver: "cc" });
    expect(absent.groups.map((g) => g.driver)).toEqual(["cc"]);
  });
  test("with Default not offered and nothing matching, selectedLabel falls to the plain label", () => {
    const r = driverModelChoices([drv("cc")], models, { driver: "api", model: "gone" }, { driver: "api", model: null }, { onlyDriver: "cc" });
    expect(r.default).toBeNull();
    expect(r.selectedLabel).toBe("Default");
  });
});

describe("ticket / project / settings choices", () => {
  const settings = { defaultDriver: "cc", defaultModels: { cc: "sonnet" } };
  test("projectDriver: the project's, else settings', else empty", () => {
    expect(projectDriver({ defaultDriver: "api" }, settings)).toBe("api");
    expect(projectDriver({ defaultDriver: null }, settings)).toBe("cc");
    expect(projectDriver(null, null)).toBe("");
  });
  test("ticketResolvedChoice: the project's driver with the model it would inherit, or Default with no driver", () => {
    expect(ticketResolvedChoice({ defaultDriver: "cc", defaultModels: { cc: "opus" } }, settings)).toEqual({ driver: "cc", model: "opus" });
    expect(ticketResolvedChoice({ defaultDriver: null, defaultModels: {} }, settings)).toEqual({ driver: "cc", model: "sonnet" });
    expect(ticketResolvedChoice(null, null)).toEqual({ driver: null, model: null });
  });
  test("ticketChoice shows Default only on the project's driver with no model", () => {
    const project = { defaultDriver: "cc", defaultModels: {} };
    expect(ticketChoice({ driver: "cc", model: null }, project, settings)).toEqual({ driver: null, model: null });
    expect(ticketChoice({ driver: "cc", model: "opus" }, project, settings)).toEqual({ driver: "cc", model: "opus" });
    expect(ticketChoice({ driver: "api", model: null }, project, settings)).toEqual({ driver: "api", model: null });
  });
  test("ticketChoicePatch: Default goes back to the project's driver; with no driver at all only clears the model", () => {
    const project = { defaultDriver: "cc", defaultModels: {} };
    expect(ticketChoicePatch({ driver: null, model: null }, project, settings)).toEqual({ driver: "cc", model: null });
    expect(ticketChoicePatch({ driver: "api", model: "m" }, project, settings)).toEqual({ driver: "api", model: "m" });
    expect(ticketChoicePatch({ driver: null, model: null }, null, null)).toEqual({ model: null });
  });
  test("projectChoice: pinned driver with its model; else a stored model for the settings driver; else Default", () => {
    expect(projectChoice({ defaultDriver: "api", defaultModels: { api: "m" } }, settings)).toEqual({ driver: "api", model: "m" });
    expect(projectChoice({ defaultDriver: "api", defaultModels: {} }, settings)).toEqual({ driver: "api", model: null });
    expect(projectChoice({ defaultDriver: null, defaultModels: { cc: "opus" } }, settings)).toEqual({ driver: "cc", model: "opus" });
    expect(projectChoice({ defaultDriver: null, defaultModels: {} }, settings)).toEqual({ driver: null, model: null });
    expect(projectChoice({ defaultDriver: null, defaultModels: { cc: "opus" } }, null)).toEqual({ driver: null, model: null });
  });
  test("projectChoicePatch clears other drivers' stored models", () => {
    expect(projectChoicePatch({ driver: "api", model: "m" }, { defaultDriver: "cc", defaultModels: { cc: "opus" } })).toEqual({ defaultDriver: "api", defaultModels: { cc: null, api: "m" } });
    expect(projectChoicePatch({ driver: null, model: null }, { defaultDriver: "cc", defaultModels: { cc: "opus" } })).toEqual({ defaultDriver: null, defaultModels: { cc: null } });
  });
  test("settingsChoice is Default when the driver has no model; settingsChoicePatch keeps the driver on Default", () => {
    expect(settingsChoice({ defaultDriver: "cc", defaultModels: { cc: "opus" } })).toEqual({ driver: "cc", model: "opus" });
    expect(settingsChoice({ defaultDriver: "cc", defaultModels: { cc: "" } })).toEqual({ driver: null, model: null });
    expect(settingsChoicePatch({ driver: null, model: null }, { defaultDriver: "cc", defaultModels: { cc: "opus" } })).toEqual({ defaultDriver: "cc", defaultModels: { cc: null } });
    expect(settingsChoicePatch({ driver: "api", model: "m" }, { defaultDriver: "cc", defaultModels: { cc: "opus" } })).toEqual({ defaultDriver: "api", defaultModels: { cc: null, api: "m" } });
  });
});

describe("phase names and summary", () => {
  const lists = { cc: [opus, sonnet], api: [{ id: "g", name: "GPT", default: true }] };
  const all = (c: PhaseChoice, over: Partial<Record<Phase, PhaseChoice>> = {}): Record<Phase, PhaseChoice> => ({ plan: c, work: c, review: c, adviser: c, complete: c, ...over });
  test("phaseChoiceModelName: the model's name, the driver's default name, else 'Default'", () => {
    expect(phaseChoiceModelName({ driver: "cc", model: "opus" }, lists)).toBe("Opus 5.5");
    expect(phaseChoiceModelName({ driver: "cc", model: null }, lists)).toBe("Sonnet 5.5");
    expect(phaseChoiceModelName({ driver: "zz", model: null }, lists)).toBe("Default");
    expect(phaseChoiceModelName({ driver: "zz", model: "raw" }, lists)).toBe("raw");
  });
  test("driver names are shown only when the phases span more than one driver", () => {
    const one = phaseChoiceNames(all({ driver: "cc", model: "opus" }), lists, () => "CC");
    expect(one.work).toBe("Opus 5.5");
    const multi = phaseChoiceNames(all({ driver: "cc", model: "opus" }, { complete: { driver: "api", model: null } }), lists, (id) => id.toUpperCase());
    expect(multi.work).toBe("CC · Opus 5.5");
    expect(multi.complete).toBe("API · GPT");
  });
  test("the summary leads with Work and lists only the phases that differ", () => {
    const c = { driver: "cc", model: "opus" };
    expect(phaseSummary(all(c), lists)).toBe("Opus 5.5");
    expect(phaseSummary(all(c, { complete: { driver: "cc", model: "sonnet" } }), lists)).toBe("Opus 5.5 · Complete: Sonnet 5.5");
    expect(phaseSummary(all(c, { plan: { driver: "cc", model: "sonnet" }, adviser: { driver: "cc", model: "sonnet" } }), lists)).toBe("Opus 5.5 · Planning: Sonnet 5.5 · Adviser: Sonnet 5.5");
  });
});

describe("phaseMatrix", () => {
  const lists = { cc: [opus, sonnet] };
  const drivers = [drv("cc", "Claude Code"), drv("api", "API", false)];
  test("app level: no Inherit row, every phase has a selected row; unset phases follow Work's driver default", () => {
    const m = phaseMatrix(drivers, lists, { work: { driver: "cc", model: "opus" } }, null);
    expect(m.inherit).toBeNull();
    expect(m.inheritNames).toBeNull();
    expect(m.selected.work).toBe(encodeChoice({ driver: "cc", model: "opus" }));
    expect(m.selected.plan).toBe(encodeChoice({ driver: "cc", model: null }));
    expect(m.effective.plan).toEqual({ driver: "cc", model: null });
  });
  test("a lower level: an unset phase selects Inherit and shows the inherited choice as effective", () => {
    const inherited = { plan: { driver: "cc", model: "sonnet" }, work: { driver: "cc", model: "sonnet" }, review: { driver: "cc", model: "sonnet" }, adviser: { driver: "cc", model: "opus" }, complete: { driver: "cc", model: "sonnet" } };
    const m = phaseMatrix(drivers, lists, { review: { driver: "cc", model: "opus" } }, inherited);
    expect(m.inherit).toEqual({ key: "", choice: null, label: "Defaults", model: null });
    expect(m.selected.review).toBe(encodeChoice({ driver: "cc", model: "opus" }));
    expect(m.selected.plan).toBe("");
    expect(m.effective.plan).toEqual(inherited.plan);
    expect(m.inheritNames?.adviser).toBe("Opus 5.5");
  });
  test("groups: signed-in drivers always, others only when a phase picks them; rows are Default then models", () => {
    const base = phaseMatrix(drivers, lists, { work: { driver: "cc", model: null } }, null);
    expect(base.groups.map((g) => g.driver)).toEqual(["cc"]);
    expect(base.groups[0]!.rows.map((r) => r.label)).toEqual(["Default (Sonnet 5.5)", "Opus 5.5", "Sonnet 5.5"]);
    const picked = phaseMatrix(drivers, lists, { work: { driver: "api", model: null } }, null);
    expect(picked.groups.map((g) => g.driver)).toEqual(["cc", "api"]);
    expect(picked.groups[1]!.rows.map((r) => r.label)).toEqual(["Default"]);
  });
  test("at a lower level only the phases' own picks pull an unlisted driver in, not inherited ones", () => {
    const inherited = { plan: { driver: "api", model: null }, work: { driver: "api", model: null }, review: { driver: "api", model: null }, adviser: { driver: "api", model: null }, complete: { driver: "api", model: null } };
    expect(phaseMatrix(drivers, lists, null, inherited).groups.map((g) => g.driver)).toEqual(["cc"]);
    expect(phaseMatrix(drivers, lists, { plan: { driver: "api", model: null } }, inherited).groups.map((g) => g.driver)).toEqual(["cc", "api"]);
  });
  test("an unlisted driver the phase picks is added under its own id, and an unlisted model is kept as custom once", () => {
    const m = phaseMatrix([drv("cc", "Claude Code")], lists, { work: { driver: "ghost", model: "x" }, plan: { driver: "cc", model: "weird" }, review: { driver: "cc", model: "weird" } }, null);
    expect(m.groups.map((g) => g.driver)).toEqual(["cc", "ghost"]);
    expect(m.groups[0]!.rows.filter((r) => r.label === "weird (custom)")).toHaveLength(1);
    expect(m.groups[1]!.rows.map((r) => r.label)).toEqual(["Default", "x (custom)"]);
  });
  test("a listed model is not duplicated as custom", () => {
    const m = phaseMatrix(drivers, lists, { work: { driver: "cc", model: "opus" } }, null);
    expect(m.groups[0]!.rows.filter((r) => r.model === "opus")).toHaveLength(1);
  });
  test("summary uses the effective choices", () => {
    expect(phaseMatrix(drivers, lists, { work: { driver: "cc", model: "opus" } }, null).summary).toBe("Opus 5.5 · Planning: Sonnet 5.5 · Review: Sonnet 5.5 · Adviser: Sonnet 5.5 · Complete: Sonnet 5.5");
  });
});

describe("filters and patches", () => {
  const groups = [
    { driver: "cc", label: "Claude Code", rows: [{ key: "1", choice: null, label: "Opus 5.5", model: "opus" }, { key: "2", choice: null, label: "Sonnet 5.5", model: "sonnet" }] },
    { driver: "api", label: "API", rows: [{ key: "3", choice: null, label: "GPT", model: "gpt-4o" }] },
  ];
  test("filterPhaseGroups: every word must match somewhere in the row or driver; empty query keeps all; empty groups drop", () => {
    expect(filterPhaseGroups(groups, "  ")).toBe(groups);
    expect(filterPhaseGroups(groups, "claude op").map((g) => g.rows.map((r) => r.key))).toEqual([["1"]]);
    expect(filterPhaseGroups(groups, "gpt-4o").map((g) => g.driver)).toEqual(["api"]);
    expect(filterPhaseGroups(groups, "nope")).toEqual([]);
  });
  test("filterChoiceGroups matches the option's label, its model id and the driver names", () => {
    const g: ChoiceGroup[] = [
      { driver: "cc", label: null, options: [{ value: `cc${SEP}opus`, label: "Opus 5.5" }, { value: `cc${SEP}`, label: "default" }] },
      { driver: "api", label: "API", options: [{ value: `api${SEP}gpt-4o`, label: "GPT" }] },
    ];
    expect(filterChoiceGroups(g, "")).toBe(g);
    expect(filterChoiceGroups(g, "opus").map((x) => x.options.length)).toEqual([1]);
    expect(filterChoiceGroups(g, "gpt-4o").map((x) => x.driver)).toEqual(["api"]);
    expect(filterChoiceGroups(g, "claude op", { cc: "Claude Code" }).map((x) => x.driver)).toEqual(["cc"]);
    expect(filterChoiceGroups(g, "claude op")).toEqual([]);
  });
  test("phasePickPatch sets the choice, or clears the phase for Inherit", () => {
    expect(phasePickPatch("plan", { choice: { driver: "cc", model: "opus" } })).toEqual({ plan: { driver: "cc", model: "opus" } });
    expect(phasePickPatch("plan", { choice: null })).toEqual({ plan: null });
  });
});

describe("ModelListCache", () => {
  const data = (id: string) => ({ driverId: id, models: [opus], error: null, fetchedAt: 1 });
  test("an unknown driver reads as empty, and an empty id never fetches", async () => {
    let calls = 0;
    const cache = new ModelListCache(async (id) => (calls++, data(id)));
    expect(cache.get("cc")).toEqual({ data: null, loading: false, error: null });
    await cache.load("");
    expect(calls).toBe(0);
  });
  test("loads once, then serves from cache; refresh forces another fetch with the flag", async () => {
    const seen: [string, boolean][] = [];
    const cache = new ModelListCache(async (id, refresh) => (seen.push([id, refresh]), data(id)));
    await cache.load("cc");
    await cache.load("cc");
    expect(seen).toEqual([["cc", false]]);
    expect(cache.get("cc").data?.driverId).toBe("cc");
    await cache.load("cc", true);
    expect(seen).toEqual([["cc", false], ["cc", true]]);
  });
  test("concurrent loads share one request and one loading state", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = new ModelListCache(async (id) => (calls++, await gate, data(id)));
    const a = cache.load("cc");
    const b = cache.load("cc");
    expect(cache.get("cc").loading).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(cache.get("cc").loading).toBe(false);
  });
  test("a failed fetch records the error message (or string form) and keeps older data; a later load retries only on refresh", async () => {
    let mode: "ok" | "err" | "str" = "ok";
    let calls = 0;
    const cache = new ModelListCache(async (id) => {
      calls++;
      if (mode === "err") throw new Error("boom");
      if (mode === "str") throw "plain";
      return data(id);
    });
    await cache.load("cc");
    mode = "err";
    await cache.load("cc", true);
    expect(cache.get("cc")).toMatchObject({ error: "boom", loading: false });
    expect(cache.get("cc").data).not.toBeNull();
    await cache.load("cc");
    expect(calls).toBe(2); // an errored entry counts as loaded
    mode = "str";
    await cache.load("cc", true);
    expect(cache.get("cc").error).toBe("plain");
  });
  test("subscribers are told on every change and can unsubscribe; version bumps each time", async () => {
    const cache = new ModelListCache(async (id) => data(id));
    let n = 0;
    const off = cache.subscribe(() => n++);
    await cache.load("cc");
    expect(n).toBe(2); // loading, then loaded
    expect(cache.version).toBe(2);
    off();
    await cache.load("cc", true);
    expect(n).toBe(2);
  });
  test("a newer epoch clears the cache; the same or an older one does not", async () => {
    const cache = new ModelListCache(async (id) => data(id));
    cache.syncEpoch(1);
    await cache.load("cc");
    cache.syncEpoch(1);
    cache.syncEpoch(0);
    expect(cache.get("cc").data).not.toBeNull();
    cache.syncEpoch(2);
    expect(cache.get("cc").data).toBeNull();
  });
  test("modelCacheFor hands each client one cache and asks the client for the models", async () => {
    const asked: unknown[] = [];
    const client = { listModels: async (id: string, o: unknown) => (asked.push([id, o]), data(id)) };
    const a = modelCacheFor(client as never);
    expect(modelCacheFor(client as never)).toBe(a);
    expect(modelCacheFor({ listModels: client.listModels } as never)).not.toBe(a);
    await a.load("cc", true);
    expect(asked).toEqual([["cc", { refresh: true }]]);
  });
});
