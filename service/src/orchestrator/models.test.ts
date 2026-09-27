import { describe, expect, test } from "bun:test";
import { resolveRunModel } from "./models";

const none = { defaultModels: {}, reviewModels: {} };

describe("resolveRunModel precedence", () => {
  const ticket = { driver: "claude-code", model: "haiku" };
  const project = { defaultModels: { "claude-code": "sonnet" } };
  const settings = { defaultModels: { "claude-code": "opus", "anthropic-api": "claude-x" }, reviewModels: {} };

  test("ticket beats project beats settings beats driver default", () => {
    const base = { driver: "claude-code", kind: "work" as const };
    expect(resolveRunModel({ ...base, ticket, project, settings })).toBe("haiku");
    expect(resolveRunModel({ ...base, ticket: { ...ticket, model: null }, project, settings })).toBe("sonnet");
    expect(resolveRunModel({ ...base, ticket: { ...ticket, model: null }, project: { defaultModels: {} }, settings })).toBe("opus");
    expect(resolveRunModel({ ...base, ticket: null, project: null, settings: none })).toBeNull();
  });

  test("defaults are looked up for the run's driver only", () => {
    const run = { driver: "anthropic-api", kind: "work" as const, project, settings };
    // the ticket's model belongs to another driver: ignored
    expect(resolveRunModel({ ...run, ticket })).toBe("claude-x");
    // project has no anthropic-api default → settings'
    expect(resolveRunModel({ ...run, ticket: null })).toBe("claude-x");
    expect(resolveRunModel({ ...run, driver: "dummy", ticket: null })).toBeNull();
  });

  test("review runs use reviewModels when set, else the same chain as work", () => {
    const withReview = { ...settings, reviewModels: { "claude-code": "fable" } };
    expect(resolveRunModel({ driver: "claude-code", kind: "review", ticket, project, settings: withReview })).toBe("fable");
    expect(resolveRunModel({ driver: "claude-code", kind: "work", ticket, project, settings: withReview })).toBe("haiku");
    expect(resolveRunModel({ driver: "claude-code", kind: "review", ticket, project, settings })).toBe("haiku");
  });
});
