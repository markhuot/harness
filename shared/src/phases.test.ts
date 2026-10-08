import { describe, expect, test } from "bun:test";
import {
  applyLegacyProject,
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
    expect(r).toEqual({ plan: cc(null), work: api("x"), review: cc("sonnet"), complete: cc("haiku") });
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
});
