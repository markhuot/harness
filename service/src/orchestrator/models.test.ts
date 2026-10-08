import { describe, expect, test } from "bun:test";
import type { PhaseModels } from "@harness/shared";
import { resolveRunChoice, resolveRunModel } from "./models";

const cc = (model: string | null) => ({ driver: "claude-code", model });
const api = (model: string | null) => ({ driver: "anthropic-api", model });

describe("resolveRunChoice", () => {
  const settings: PhaseModels = { work: cc("opus"), complete: cc("haiku") };

  test("each phase resolves on its own: ticket → project → settings", () => {
    const ticket = { phaseModels: { work: cc("sonnet") } };
    const project = { phaseModels: { plan: cc("fable") } };
    expect(resolveRunChoice({ kind: "work", ticket, project, settings: { phaseModels: settings } })).toEqual(cc("sonnet"));
    expect(resolveRunChoice({ kind: "plan", ticket, project, settings: { phaseModels: settings } })).toEqual(cc("fable"));
    // a ticket that picks Opus for Work still completes on the app's Complete choice
    expect(resolveRunChoice({ kind: "complete", ticket, project, settings: { phaseModels: settings } })).toEqual(cc("haiku"));
    // review has no choice anywhere: the app's Work driver with its default model
    expect(resolveRunChoice({ kind: "review", ticket, project, settings: { phaseModels: settings } })).toEqual(cc(null));
  });

  test("conductor and chat runs use the Work choice", () => {
    const ticket = { phaseModels: { work: api("claude-x"), plan: cc("haiku") } };
    for (const kind of ["conductor", "chat", "work"] as const) {
      expect(resolveRunChoice({ kind, ticket, project: null, settings: { phaseModels: settings } })).toEqual(api("claude-x"));
    }
  });

  test("phases can run on different drivers", () => {
    const ticket = { phaseModels: { plan: api("claude-x"), work: cc("opus") } };
    expect(resolveRunChoice({ kind: "plan", ticket, project: null, settings: { phaseModels: {} } }).driver).toBe("anthropic-api");
    expect(resolveRunChoice({ kind: "work", ticket, project: null, settings: { phaseModels: {} } }).driver).toBe("claude-code");
  });

  test("empty settings resolve to claude-code with its default model", () => {
    expect(resolveRunChoice({ kind: "complete", ticket: null, project: null, settings: { phaseModels: {} } })).toEqual(cc(null));
  });
});

describe("resolveRunModel", () => {
  test("a ticket run takes its phase's model only on the driver it was queued on", () => {
    const ticket = { phaseModels: { work: api("claude-x") } };
    const settings = { phaseModels: {} };
    expect(resolveRunModel({ kind: "work", driver: "anthropic-api", ticket, project: null, settings })).toBe("claude-x");
    // the choice moved to another driver after the run was queued: the driver's default
    expect(resolveRunModel({ kind: "work", driver: "claude-code", ticket, project: null, settings })).toBeNull();
  });

  test("standalone sessions take the project's, then settings', Work model on their own driver", () => {
    const settings = { phaseModels: { work: cc("opus") } };
    expect(resolveRunModel({ kind: "work", driver: "claude-code", ticket: null, project: { phaseModels: { work: cc("sonnet") } }, settings })).toBe("sonnet");
    expect(resolveRunModel({ kind: "work", driver: "claude-code", ticket: null, project: null, settings })).toBe("opus");
    expect(resolveRunModel({ kind: "work", driver: "dummy", ticket: null, project: null, settings })).toBeNull();
    expect(resolveRunModel({ kind: "work", driver: "claude-code", ticket: null, project: { phaseModels: { work: api("x") } }, settings })).toBeNull();
  });
});
