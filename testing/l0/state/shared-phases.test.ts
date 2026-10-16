import { describe, expect, test } from "bun:test";
import {
  adviserFor,
  applyLegacyProject,
  applyLegacySettings,
  builtinCompleteChoice,
  builtinPhaseModels,
  inheritedPhaseModels,
  legacySettingsFields,
  legacyWork,
  mergePhaseModels,
  resolvePhaseChoice,
  resolvePhaseModels,
  runPhase,
  samePhaseChoice,
  settingsPhaseChoice,
  settingsWorkDriver,
  ticketLegacyChoice,
  withLegacyChoice,
} from "../../../shared/src/phases";
import type { Phase, RunKind } from "../../../shared/src/protocol";

const cc = (model: string | null) => ({ driver: "claude-code", model });
const api = (model: string | null) => ({ driver: "anthropic-api", model });

describe("builtin choices", () => {
  test("complete choice exists only for drivers with a Haiku", () => {
    expect(builtinCompleteChoice("claude-code")).toEqual(cc("haiku"));
    expect(builtinCompleteChoice("anthropic-api")).toEqual(api("claude-haiku-5-5"));
    expect(builtinCompleteChoice("dummy")).toBeNull();
  });
  test("a fresh install: sonnet plans/works/reviews, opus advises, haiku completes; none for tierless drivers", () => {
    expect(builtinPhaseModels("claude-code")).toEqual({ plan: cc("sonnet"), work: cc("sonnet"), review: cc("sonnet"), adviser: cc("opus"), complete: cc("haiku") });
    expect(builtinPhaseModels("anthropic-api")?.adviser).toEqual(api("claude-opus-5-5"));
    expect(builtinPhaseModels("dummy")).toBeNull();
  });
});

describe("adviserFor", () => {
  const run = { driver: "claude-code", model: "sonnet" };
  test("returns the adviser model when all conditions hold", () => {
    expect(adviserFor(run, cc("opus"), true)).toBe("opus");
  });
  test("null without subagent support, on a different driver, or with no adviser model", () => {
    expect(adviserFor(run, cc("opus"), false)).toBeNull();
    expect(adviserFor(run, api("claude-opus-5-5"), true)).toBeNull();
    expect(adviserFor(run, cc(null), true)).toBeNull();
  });
  test("null when the adviser is the run's own model", () => {
    expect(adviserFor({ driver: "claude-code", model: "opus" }, cc("opus"), true)).toBeNull();
  });
  test("a run with no model counts as the driver default (opus on claude-code)", () => {
    expect(adviserFor({ driver: "claude-code", model: null }, cc("opus"), true)).toBeNull();
    expect(adviserFor({ driver: "claude-code", model: null }, cc("sonnet"), true)).toBe("sonnet");
    // no default known for this driver, so any adviser model differs
    expect(adviserFor({ driver: "anthropic-api", model: null }, api("claude-opus-5-5"), true)).toBe("claude-opus-5-5");
  });
});

test("runPhase maps kinds to phases; triage has none; unlisted kinds are work", () => {
  const kinds: [RunKind, Phase | null][] = [["plan", "plan"], ["review", "review"], ["complete", "complete"], ["triage", null], ["work", "work"], ["conductor", "work"], ["chat", "work"], ["compact", "work"]];
  for (const [k, p] of kinds) expect(runPhase(k)).toBe(p);
});

describe("samePhaseChoice", () => {
  test("two missing choices are equal; one missing is not", () => {
    expect(samePhaseChoice(null, undefined)).toBe(true);
    expect(samePhaseChoice(cc("a"), null)).toBe(false);
    expect(samePhaseChoice(undefined, cc(null))).toBe(false);
  });
  test("empty model equals null model; different drivers or models differ", () => {
    expect(samePhaseChoice(cc(null), { driver: "claude-code", model: "" })).toBe(true);
    expect(samePhaseChoice(cc("a"), cc("b"))).toBe(false);
    expect(samePhaseChoice(cc("a"), api("a"))).toBe(false);
  });
});

describe("settings choices", () => {
  test("work driver falls back to claude-code when unset or empty", () => {
    expect(settingsWorkDriver(null)).toBe("claude-code");
    expect(settingsWorkDriver({})).toBe("claude-code");
    expect(settingsWorkDriver({ work: { driver: "", model: null } })).toBe("claude-code");
    expect(settingsWorkDriver({ work: api("x") })).toBe("anthropic-api");
  });
  test("an unchosen phase follows the Work driver with its default model", () => {
    expect(settingsPhaseChoice({ work: api("x") }, "review")).toEqual(api(null));
    expect(settingsPhaseChoice({ work: api("x"), review: cc("r") }, "review")).toEqual(cc("r"));
    expect(settingsPhaseChoice(undefined, "plan")).toEqual(cc(null));
  });
});

describe("resolution", () => {
  test("ticket beats project beats settings, per phase", () => {
    const levels = { ticket: { work: cc("t") }, project: { work: cc("p"), plan: cc("pp") }, settings: { work: cc("s"), plan: cc("ss"), review: cc("sr") } };
    expect(resolvePhaseChoice("work", levels)).toEqual(cc("t"));
    expect(resolvePhaseChoice("plan", levels)).toEqual(cc("pp"));
    expect(resolvePhaseChoice("review", levels)).toEqual(cc("sr"));
    expect(resolvePhaseChoice("complete", levels)).toEqual(cc(null));
  });
  test("resolvePhaseModels covers every phase", () => {
    expect(Object.keys(resolvePhaseModels({ settings: null })).sort()).toEqual(["adviser", "complete", "plan", "review", "work"]);
  });
  test("inherited choices: settings inherit nothing, a project inherits settings, a ticket also the project", () => {
    const project = { work: cc("p") };
    const settings = { work: cc("s"), plan: cc("sp") };
    expect(inheritedPhaseModels("settings", project, settings)).toBeNull();
    expect(inheritedPhaseModels("project", project, settings)?.work).toEqual(cc("s"));
    expect(inheritedPhaseModels("ticket", project, settings)?.work).toEqual(cc("p"));
    expect(inheritedPhaseModels("ticket", project, settings)?.plan).toEqual(cc("sp"));
  });
});

describe("mergePhaseModels", () => {
  test("a choice sets the phase (empty model becomes null); null or a driverless choice clears it", () => {
    const out = mergePhaseModels({ plan: cc("a"), work: cc("b"), review: cc("c") }, { plan: { driver: "x", model: "" }, work: null, review: { driver: "", model: "m" } });
    expect(out).toEqual({ plan: { driver: "x", model: null } });
  });
  test("phases absent from the patch are left alone, and current is not mutated", () => {
    const current = { plan: cc("a") };
    expect(mergePhaseModels(current, { work: cc("w") })).toEqual({ plan: cc("a"), work: cc("w") });
    expect(current).toEqual({ plan: cc("a") });
    expect(mergePhaseModels(null, {})).toEqual({});
  });
});

describe("legacy choice helpers", () => {
  test("withLegacyChoice sets plan/work/review only, or clears just them", () => {
    const base = { adviser: cc("opus"), complete: cc("haiku"), plan: cc("old") };
    expect(withLegacyChoice(base, api(""))).toEqual({ adviser: cc("opus"), complete: cc("haiku"), plan: api(null), work: api(null), review: api(null) });
    expect(withLegacyChoice(base, null)).toEqual({ adviser: cc("opus"), complete: cc("haiku") });
  });
  test("legacyWork reads the Work choice", () => {
    expect(legacyWork(null)).toEqual({ driver: null, models: {} });
    expect(legacyWork({ work: cc(null) })).toEqual({ driver: "claude-code", models: {} });
    expect(legacyWork({ work: cc("m") })).toEqual({ driver: "claude-code", models: { "claude-code": "m" } });
  });
  test("ticketLegacyChoice: the inherited driver with no model clears; anything else pins", () => {
    const current = { work: api("x"), adviser: cc("opus") };
    expect(ticketLegacyChoice(current, cc(null), cc("anything"))).toEqual({ adviser: cc("opus") });
    expect(ticketLegacyChoice(current, cc("m"), cc("anything"))).toMatchObject({ work: cc("m") });
    expect(ticketLegacyChoice(current, api(null), cc(null))).toMatchObject({ work: api(null) });
  });
  test("legacySettingsFields: review is reported only when it differs from work and has a model", () => {
    expect(legacySettingsFields(null)).toEqual({ defaultDriver: "claude-code", defaultModels: {}, reviewModels: {} });
    expect(legacySettingsFields({ work: cc("w"), review: cc("w") }).reviewModels).toEqual({});
    expect(legacySettingsFields({ work: cc("w"), review: cc("r") })).toEqual({ defaultDriver: "claude-code", defaultModels: { "claude-code": "w" }, reviewModels: { "claude-code": "r" } });
    expect(legacySettingsFields({ work: cc("w"), review: cc(null) }).reviewModels).toEqual({});
  });
});

describe("applyLegacySettings", () => {
  test("a new driver sets plan/work/review, keeping the model only when it is the current driver's", () => {
    const current = { work: cc("w") };
    expect(applyLegacySettings(current, { defaultDriver: "claude-code" }).work).toEqual(cc("w"));
    expect(applyLegacySettings(current, { defaultDriver: "anthropic-api" }).work).toEqual(api(null));
    expect(applyLegacySettings(current, { defaultDriver: "anthropic-api", defaultModels: { "anthropic-api": "m" } }).plan).toEqual(api("m"));
  });
  test("an explicit null/empty model for the driver clears the model instead of keeping the current one", () => {
    expect(applyLegacySettings({ work: cc("w") }, { defaultDriver: "claude-code", defaultModels: { "claude-code": null } }).work).toEqual(cc(null));
  });
  test("switching driver moves complete to the new Haiku and adviser to the new Opus", () => {
    const out = applyLegacySettings({ work: cc("w"), complete: cc("haiku"), adviser: cc("opus") }, { defaultDriver: "anthropic-api" });
    expect(out.complete).toEqual(api("claude-haiku-5-5"));
    expect(out.adviser).toEqual(api("claude-opus-5-5"));
  });
  test("a driver with no Haiku/Opus clears complete and adviser; ones already on the driver are kept", () => {
    const out = applyLegacySettings({ work: cc("w"), complete: cc("haiku"), adviser: cc("opus") }, { defaultDriver: "dummy" });
    expect(out.complete).toBeUndefined();
    expect(out.adviser).toBeUndefined();
    const kept = applyLegacySettings({ work: cc("w"), complete: cc("custom"), adviser: cc("x") }, { defaultDriver: "claude-code" });
    expect(kept.complete).toEqual(cc("custom"));
    expect(kept.adviser).toEqual(cc("x"));
  });
  test("defaultModels alone sets the model only when it names the Work driver", () => {
    expect(applyLegacySettings({ work: cc("w") }, { defaultModels: { "claude-code": "n" } }).review).toEqual(cc("n"));
    expect(applyLegacySettings({ work: cc("w") }, { defaultModels: { "anthropic-api": "n" } })).toEqual({ work: cc("w") });
    expect(applyLegacySettings({ work: cc("w") }, { defaultModels: { "claude-code": null } }).work).toEqual(cc(null));
  });
  test("reviewModels: Work driver's entry first, else the first non-empty entry's driver", () => {
    const base = { work: cc("w") };
    expect(applyLegacySettings(base, { reviewModels: { "claude-code": "r", "anthropic-api": "x" } }).review).toEqual(cc("r"));
    expect(applyLegacySettings(base, { reviewModels: { a: null, "anthropic-api": "x" } }).review).toEqual(api("x"));
  });
  test("a null review model puts Review back on Work, but only for the Work driver", () => {
    const base = { work: cc("w"), review: cc("r") };
    expect(applyLegacySettings(base, { reviewModels: { "claude-code": null } }).review).toEqual(cc("w"));
    expect(applyLegacySettings(base, { reviewModels: { "anthropic-api": null } }).review).toEqual(cc("r"));
  });
  test("empty or null reviewModels does nothing", () => {
    const base = { work: cc("w"), review: cc("r") };
    expect(applyLegacySettings(base, { reviewModels: {} })).toEqual(base);
    expect(applyLegacySettings(base, { reviewModels: null })).toEqual(base);
  });
});

describe("applyLegacyProject", () => {
  const settings = { work: cc("s") };
  test("a null driver clears plan/work/review so the project follows settings", () => {
    expect(applyLegacyProject({ plan: cc("a"), work: cc("b"), adviser: cc("o") }, { defaultDriver: null }, settings)).toEqual({ adviser: cc("o") });
  });
  test("a driver pins all three, keeping its own model only when it already works on that driver", () => {
    expect(applyLegacyProject({ work: cc("mine") }, { defaultDriver: "claude-code" }, settings).review).toEqual(cc("mine"));
    expect(applyLegacyProject({ work: cc("mine") }, { defaultDriver: "anthropic-api" }, settings).work).toEqual(api(null));
    expect(applyLegacyProject(null, { defaultDriver: "anthropic-api", defaultModels: { "anthropic-api": "m" } }, settings).plan).toEqual(api("m"));
  });
  test("a models map alone changes the model of the driver the project works on (own, else settings')", () => {
    expect(applyLegacyProject({ work: api("x") }, { defaultModels: { "anthropic-api": "y" } }, settings).work).toEqual(api("y"));
    expect(applyLegacyProject(null, { defaultModels: { "claude-code": "y" } }, settings).work).toEqual(cc("y"));
  });
  test("a models map for another driver changes nothing", () => {
    expect(applyLegacyProject({ work: cc("x") }, { defaultModels: { "anthropic-api": "y" } }, settings)).toEqual({ work: cc("x") });
  });
  test("an empty model on a project with no choice of its own does not pin one", () => {
    expect(applyLegacyProject(null, { defaultModels: { "claude-code": null } }, settings)).toEqual({});
  });
  test("an empty model on a project that has its own choice clears the model", () => {
    expect(applyLegacyProject({ work: cc("x") }, { defaultModels: { "claude-code": "" } }, settings).work).toEqual(cc(null));
  });
});
