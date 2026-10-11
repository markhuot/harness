import { describe, expect, test } from "bun:test";
import {
  adviserFor,
  applyLegacyProject,
  builtinPhaseModels,
  applyLegacySettings,
  inheritedPhaseModels,
  legacySettingsFields,
  mergePhaseModels,
  resolvePhaseModels,
  runPhase,
  ticketLegacyChoice,
} from "./phases";

const cc = (model: string | null) => ({ driver: "claude-code", model });
const api = (model: string | null) => ({ driver: "anthropic-api", model });

describe("phases", () => {
  test("run kinds map to phases", () => {
    expect([runPhase("plan"), runPhase("work"), runPhase("chat"), runPhase("conductor"), runPhase("review"), runPhase("complete"), runPhase("triage")]).toEqual([
      "plan",
      "work",
      "work",
      "work",
      "review",
      "complete",
      null,
    ]);
  });

  test("resolvePhaseModels fills every phase, ticket → project → settings", () => {
    const r = resolvePhaseModels({ ticket: { work: api("x") }, project: { review: cc("sonnet") }, settings: { complete: cc("haiku") } });
    expect(r).toEqual({ plan: cc(null), work: api("x"), review: cc("sonnet"), adviser: cc(null), complete: cc("haiku") });
  });

  test("inheritedPhaseModels names what a level inherits", () => {
    expect(inheritedPhaseModels("settings", null, {})).toBeNull();
    expect(inheritedPhaseModels("project", { work: api(null) }, { work: cc("opus") })!.work).toEqual(cc("opus"));
    expect(inheritedPhaseModels("ticket", { work: api(null) }, { work: cc("opus") })!.work).toEqual(api(null));
  });

  test("mergePhaseModels: null clears a phase, absent phases are kept", () => {
    expect(mergePhaseModels({ work: cc("opus"), complete: cc("haiku") }, { complete: null, plan: api("") })).toEqual({ work: cc("opus"), plan: api(null) });
  });

  test("legacy settings fields derive from Work and Review", () => {
    expect(legacySettingsFields({ work: cc("opus"), review: cc("fable") })).toEqual({ defaultDriver: "claude-code", defaultModels: { "claude-code": "opus" }, reviewModels: { "claude-code": "fable" } });
    expect(legacySettingsFields({})).toEqual({ defaultDriver: "claude-code", defaultModels: {}, reviewModels: {} });
  });

  test("a legacy defaultDriver write sets Planning/Work/Review and moves Complete's Haiku", () => {
    const out = applyLegacySettings({ complete: cc("haiku") }, { defaultDriver: "anthropic-api", defaultModels: { "anthropic-api": "claude-x" } });
    expect(out).toEqual({ plan: api("claude-x"), work: api("claude-x"), review: api("claude-x"), complete: api("claude-haiku-5-5") });
    expect(applyLegacySettings({ complete: cc("haiku") }, { defaultDriver: "dummy" }).complete).toBeUndefined();
  });

  test("legacy reviewModels set Review; null puts it back on Work", () => {
    const base = { work: cc("opus"), review: cc("opus") };
    expect(applyLegacySettings(base, { reviewModels: { "claude-code": "fable" } }).review).toEqual(cc("fable"));
    expect(applyLegacySettings({ ...base, review: cc("fable") }, { reviewModels: { "claude-code": null } }).review).toEqual(cc("opus"));
  });

  test("legacy project writes", () => {
    expect(applyLegacyProject({ complete: cc("haiku") }, { defaultDriver: "anthropic-api" }, {})).toEqual({
      plan: api(null),
      work: api(null),
      review: api(null),
      complete: cc("haiku"),
    });
    expect(applyLegacyProject({ work: cc("opus"), plan: cc("opus"), review: cc("opus") }, { defaultDriver: null }, {})).toEqual({});
    expect(applyLegacyProject({}, { defaultModels: { "claude-code": "sonnet" } }, {}).work).toEqual(cc("sonnet"));
  });

  test("a ticket's legacy write of the inherited driver with no model follows the project", () => {
    expect(ticketLegacyChoice({ work: api("x"), complete: cc("haiku") }, cc(null), cc("opus"))).toEqual({ complete: cc("haiku") });
    expect(ticketLegacyChoice({}, api(null), cc(null))).toEqual({ plan: api(null), work: api(null), review: api(null) });
  });

  test("Adviser resolves like every phase: ticket → project → settings, settings falling back to the Work driver", () => {
    expect(resolvePhaseModels({ settings: { work: cc("sonnet") } }).adviser).toEqual(cc(null));
    const levels = { ticket: { adviser: cc("haiku") }, project: { adviser: cc("opus") }, settings: { adviser: cc("sonnet") } };
    expect(resolvePhaseModels(levels).adviser).toEqual(cc("haiku"));
    expect(resolvePhaseModels({ ...levels, ticket: null }).adviser).toEqual(cc("opus"));
    expect(resolvePhaseModels({ ...levels, ticket: null, project: null }).adviser).toEqual(cc("sonnet"));
  });

  test("a new install on Claude Code: Sonnet plans, works and reviews, Opus advises, Haiku completes", () => {
    expect(builtinPhaseModels("claude-code")).toEqual({ plan: cc("sonnet"), work: cc("sonnet"), review: cc("sonnet"), adviser: cc("opus"), complete: cc("haiku") });
    expect(builtinPhaseModels("dummy")).toBeNull();
  });

  test("switching the default driver moves an Adviser choice to the new driver's Opus, or clears it", () => {
    const start = { adviser: cc("opus"), complete: cc("haiku") };
    expect(applyLegacySettings(start, { defaultDriver: "anthropic-api" }).adviser).toEqual(api("claude-opus-5-5"));
    expect(applyLegacySettings(start, { defaultDriver: "dummy" }).adviser).toBeUndefined();
    expect(applyLegacySettings(start, { defaultModels: { "claude-code": "sonnet" } }).adviser).toEqual(cc("opus"));
  });

  describe("adviserFor: when a run launches the adviser", () => {
    const run = { driver: "claude-code", model: "sonnet" };
    test("on another model of the same driver, with subagents", () => {
      expect(adviserFor(run, cc("opus"), true)).toBe("opus");
    });
    test("not on the run's own model", () => {
      expect(adviserFor({ driver: "claude-code", model: "opus" }, cc("opus"), true)).toBeNull();
    });
    test("not when the driver has no subagents", () => {
      expect(adviserFor({ driver: "anthropic-api", model: "claude-sonnet-5-5" }, api("claude-opus-5-5"), false)).toBeNull();
    });
    test("not when the Adviser phase is on another driver", () => {
      expect(adviserFor(run, api("claude-opus-5-5"), true)).toBeNull();
    });
    test("not when the adviser names no model (the driver's default is unknown)", () => {
      expect(adviserFor(run, cc(null), true)).toBeNull();
    });
  });
});
