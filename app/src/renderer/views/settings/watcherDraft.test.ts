import { describe, expect, test } from "bun:test";
import type { Watcher } from "@harness/shared";
import { draftDriver, emptyWatcher, fromDraft, toDraft, type TriageSettings } from "./watcherDraft";

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
  models: { "claude-code": "opus", "anthropic-api": "claude-sonnet-5" },
  lastRunAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("watcher draft", () => {
  test("the Default driver resolves to the watcher default before the app default", () => {
    expect(draftDriver({ driver: "" }, settings)).toBe("claude-code");
    expect(draftDriver({ driver: "" }, { ...settings, watcherDriver: "anthropic-api" })).toBe("anthropic-api");
    expect(draftDriver({ driver: "dummy" }, { ...settings, watcherDriver: "anthropic-api" })).toBe("dummy");
  });

  test("saves only the effective driver's model, leaving other drivers' picks alone", () => {
    const d = { ...toDraft(watcher), driver: "anthropic-api", models: { "claude-code": "haiku", "anthropic-api": "claude-opus-5" } };
    expect(fromDraft(d, settings).models).toEqual({ "anthropic-api": "claude-opus-5" });
  });

  test("a model set back to Default is sent as null so the service clears it", () => {
    const d = { ...toDraft(watcher), models: { ...toDraft(watcher).models, "claude-code": null } };
    expect(fromDraft(d, settings).models).toEqual({ "claude-code": null });
  });

  test("a new watcher on the Default driver saves driver null and clears the resolved driver's model", () => {
    const body = fromDraft({ ...emptyWatcher, name: "x", command: "y" }, { ...settings, watcherDriver: "dummy" });
    expect(body.driver).toBeNull();
    expect(body.models).toEqual({ dummy: null });
  });

  test("editing a draft doesn't mutate the stored watcher's models", () => {
    const d = toDraft(watcher);
    d.models["claude-code"] = "haiku";
    expect(watcher.models?.["claude-code"]).toBe("opus");
  });

  test("with no driver known yet (settings not loaded), no models are sent", () => {
    expect(fromDraft({ ...emptyWatcher, name: "x", command: "y" }, { defaultDriver: "", defaultModels: {} }).models).toBeUndefined();
  });
});
