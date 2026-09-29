import { describe, expect, test } from "bun:test";
import type { Watcher } from "@harness/shared";
import { emptyWatcher, fromDraft, toDraft, watcherDefaultChoice, type TriageSettings } from "./watcherDraft";

const settings: TriageSettings = { defaultDriver: "claude-code", defaultModels: {}, watcherDriver: null, watcherModels: {} };

const watcher: Watcher = {
  id: "w1",
  name: "jira",
  command: "watch-jira",
  args: [],
  prompt: "",
  cwd: null,
  env: {},
  mode: "loop",
  intervalSec: 60,
  enabled: true,
  driver: "claude-code",
  models: { "claude-code": "sonnet", "anthropic-api": "claude-sonnet-5" },
  lastRunAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("watcher draft", () => {
  test("a stored driver + model loads as that pick", () => {
    expect(toDraft(watcher, settings).choice).toEqual({ driver: "claude-code", model: "sonnet" });
    expect(toDraft({ ...watcher, driver: null, models: {} }, settings).choice).toEqual({ driver: null, model: null });
  });

  test("picking Opus under Claude Code saves that driver and model and clears other drivers' models", () => {
    const d = { ...toDraft(watcher, settings), choice: { driver: "claude-code", model: "opus" } };
    const body = fromDraft(d);
    expect(body.driver).toBe("claude-code");
    expect(body.models).toEqual({ "claude-code": "opus", "anthropic-api": null });
  });

  test("Default clears the driver and every stored model", () => {
    const d = { ...toDraft(watcher, settings), choice: { driver: null, model: null } };
    const body = fromDraft(d);
    expect(body.driver).toBeNull();
    expect(body.models).toEqual({ "claude-code": null, "anthropic-api": null });
  });

  test("a new watcher on Default sends no model entries", () => {
    const body = fromDraft({ ...emptyWatcher, name: "x", command: "y" });
    expect(body.driver).toBeNull();
    expect(body.models).toEqual({});
  });

  test("Default resolves to the watcher default driver and its model before the app defaults", () => {
    expect(watcherDefaultChoice({ ...settings, defaultModels: { "claude-code": "opus" } })).toEqual({ driver: "claude-code", model: "opus" });
    expect(watcherDefaultChoice({ ...settings, watcherDriver: "anthropic-api", watcherModels: { "anthropic-api": "claude-opus-5" }, defaultModels: { "anthropic-api": "claude-sonnet-5" } })).toEqual({
      driver: "anthropic-api",
      model: "claude-opus-5",
    });
    expect(watcherDefaultChoice({ defaultDriver: "", defaultModels: {} })).toEqual({ driver: null, model: null });
  });
});
