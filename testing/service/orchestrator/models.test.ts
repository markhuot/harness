import { expect, test } from "bun:test";
import { resolveRunChoice, resolveRunModel } from "../../../service/src/orchestrator/models";

const settings = { phaseModels: { work: { driver: "claude-code", model: "sonnet" }, review: { driver: "claude-code", model: "opus" } } };
const choice = (driver: string, model: string | null) => ({ driver, model });

test("a run's phase picks the most specific level that chose it: ticket, then project, then settings", () => {
  const input = { kind: "work" as const, settings, project: { phaseModels: { work: choice("copilot", "gpt") } }, ticket: { phaseModels: { work: choice("dummy", "d1") } } };
  expect(resolveRunChoice(input)).toEqual(choice("dummy", "d1"));
  expect(resolveRunChoice({ ...input, ticket: { phaseModels: {} } })).toEqual(choice("copilot", "gpt"));
  expect(resolveRunChoice({ ...input, ticket: { phaseModels: {} }, project: { phaseModels: {} } })).toEqual(choice("claude-code", "sonnet"));
});

test("conductor and chat runs use the Work choice; review has its own", () => {
  const base = { settings, project: null, ticket: { phaseModels: {} } };
  expect(resolveRunChoice({ ...base, kind: "conductor" }).model).toBe("sonnet");
  expect(resolveRunChoice({ ...base, kind: "chat" }).model).toBe("sonnet");
  expect(resolveRunChoice({ ...base, kind: "review" }).model).toBe("opus");
});

test("a phase nobody chose resolves to the Work driver with its default model", () => {
  const out = resolveRunChoice({ kind: "complete", settings, project: null, ticket: { phaseModels: {} } });
  expect(out.driver).toBe("claude-code");
});

test("a run with no ticket follows the settings' choice", () => {
  expect(resolveRunChoice({ kind: "work", settings, project: null, ticket: null })).toEqual(choice("claude-code", "sonnet"));
});

test("the model applies only when the phase still resolves to the driver the run was queued on", () => {
  const input = { kind: "work" as const, settings, project: null, ticket: { phaseModels: {} } };
  expect(resolveRunModel({ ...input, driver: "claude-code" })).toBe("sonnet");
  expect(resolveRunModel({ ...input, driver: "copilot" })).toBeNull();
});

test("a standalone session takes the project's Work model, then settings', but only on its own driver", () => {
  const base = { kind: "chat" as const, ticket: null, settings };
  expect(resolveRunModel({ ...base, driver: "claude-code", project: { phaseModels: { work: choice("claude-code", "haiku") } } })).toBe("haiku");
  expect(resolveRunModel({ ...base, driver: "claude-code", project: null })).toBe("sonnet");
  expect(resolveRunModel({ ...base, driver: "copilot", project: null })).toBeNull();
  // The project's choice is on another driver: it decides, so no model rather than settings'.
  expect(resolveRunModel({ ...base, driver: "claude-code", project: { phaseModels: { work: choice("copilot", "gpt") } } })).toBeNull();
});

test("a chief's run takes the project's choice, then the app's CoS choice, then the Work choice", () => {
  const base = { kind: "cos" as const, project: null, ticket: { phaseModels: {} } };
  const withCos = { ...settings, cosModel: choice("copilot", "gpt") };
  expect(resolveRunChoice({ ...base, settings, cosProject: null })).toEqual(choice("claude-code", "sonnet"));
  expect(resolveRunChoice({ ...base, settings: withCos, cosProject: null })).toEqual(choice("copilot", "gpt"));
  expect(resolveRunChoice({ ...base, settings: withCos, cosProject: { cosModel: choice("claude-code", "haiku") } })).toEqual(choice("claude-code", "haiku"));
  // A project with no override of its own (cleared) falls back to the app's choice.
  expect(resolveRunChoice({ ...base, settings: withCos, cosProject: { cosModel: null } })).toEqual(choice("copilot", "gpt"));
});

test("a chief ignores the ticket's and the hidden project's phase choices", () => {
  const out = resolveRunChoice({ kind: "cos", settings, project: { phaseModels: { work: choice("copilot", "gpt") } }, ticket: { phaseModels: { work: choice("dummy", "d1") } } });
  expect(out).toEqual(choice("claude-code", "sonnet"));
});

test("a chief's model applies only on the driver its run was queued on", () => {
  const input = { kind: "cos" as const, project: null, ticket: { phaseModels: {} }, settings: { ...settings, cosModel: choice("copilot", "gpt") } };
  expect(resolveRunModel({ ...input, driver: "copilot" })).toBe("gpt");
  expect(resolveRunModel({ ...input, driver: "claude-code" })).toBeNull();
});
