import { expect, test } from "bun:test";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@harness/shared";
import { HarnessError } from "../../../service/src/orchestrator/errors";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  legacyPermissionMode,
  mergeModelMap,
  resolveSettings,
  toPublicSettings,
  validateBranchName,
  validateListen,
  validateModelId,
  validateModelMap,
  validateNotifications,
  validatePhaseModels,
  validateSettingsPatch,
} from "../../../service/src/orchestrator/settings";

const bad = (fn: () => unknown, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(400);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a 400");
};

test("maxConcurrentRuns accepts 1..64 whole numbers only", () => {
  expect(validateSettingsPatch({ maxConcurrentRuns: 64 })).toEqual({ maxConcurrentRuns: 64 });
  for (const v of [0, 65, 1.5, "4"]) bad(() => validateSettingsPatch({ maxConcurrentRuns: v }), /between 1 and 64/);
});

test("unknown keys are refused, echoed *Set flags are ignored, arrays and null bodies are refused", () => {
  bad(() => validateSettingsPatch({ nope: 1 }), /Unknown setting/);
  expect(validateSettingsPatch({ anthropicApiKeySet: true })).toEqual({});
  bad(() => validateSettingsPatch([]), /must be an object/);
  bad(() => validateSettingsPatch(null), /must be an object/);
});

test("secrets are trimmed, blank becomes null", () => {
  expect(validateSettingsPatch({ anthropicApiKey: "  sk  " })).toEqual({ anthropicApiKey: "sk" });
  expect(validateSettingsPatch({ claudeOauthToken: "   " })).toEqual({ claudeOauthToken: null });
  bad(() => validateSettingsPatch({ copilotGithubToken: 5 }), /string or null/);
});

test("drivers must be known when the list is given; clearing is always allowed", () => {
  bad(() => validateSettingsPatch({ defaultDriver: "x" }, ["claude-code"]), /Unknown driver/);
  expect(validateSettingsPatch({ defaultDriver: "x" })).toEqual({ defaultDriver: "x" });
  expect(validateSettingsPatch({ watcherDriver: "" }, ["a"])).toEqual({ watcherDriver: null });
  expect(validateModelMap("m", { gone: null, "": "" }, ["a"])).toEqual({ gone: null, "": null });
  bad(() => validateModelMap("m", { gone: "x" }, ["a"]), /Unknown driver in m: gone/);
});

test("legacy permission mode maps like migration 4 and loses to an explicit permissionMode", () => {
  expect(legacyPermissionMode("auto")).toBe("auto");
  expect(legacyPermissionMode("dontAsk")).toBe("read_only");
  expect(legacyPermissionMode("bypassPermissions")).toBe("ask");
  expect(validateSettingsPatch({ claudePermissionMode: "dontAsk" })).toEqual({ permissionMode: "read_only" });
  expect(validateSettingsPatch({ claudePermissionMode: "dontAsk", permissionMode: "ask" })).toEqual({ permissionMode: "ask" });
});

test("listen: custom needs a host, brackets are stripped, other modes drop the host", () => {
  expect(validateListen({ mode: "custom", host: " [::1] " })).toEqual({ mode: "custom", host: "::1" });
  expect(validateListen({ mode: "localhost", host: "x" })).toEqual({ mode: "localhost" });
  bad(() => validateListen({ mode: "custom" }), /required/);
  bad(() => validateListen({ mode: "custom", host: "http://x" }), /no scheme/);
  bad(() => validateListen({ mode: "bogus" }), /listen.mode/);
});

test("model ids are trimmed; blank is null; whitespace inside is refused", () => {
  expect(validateModelId("f", "  m1 ")).toBe("m1");
  expect(validateModelId("f", "  ")).toBeNull();
  expect(validateModelId("f", undefined)).toBeNull();
  bad(() => validateModelId("f", "a b"), /without spaces/);
  bad(() => validateModelId("f", 3), /string or null/);
});

test("mergeModelMap removes drivers patched to null", () => {
  expect(mergeModelMap({ a: "1", b: "2" }, { a: null, c: "3" })).toEqual({ b: "2", c: "3" });
});

test("phase models: unknown phase, bad shape and null clear", () => {
  expect(validatePhaseModels("p", { plan: { driver: " d ", model: "m" }, work: null })).toEqual({ plan: { driver: "d", model: "m" }, work: null });
  bad(() => validatePhaseModels("p", { nope: null }), /Unknown phase/);
  bad(() => validatePhaseModels("p", { plan: { driver: "" } }), /driver id/);
  bad(() => validatePhaseModels("p", { plan: "x" }), /\{ driver, model \}/);
});

test("branch names: null/blank inherit only when nullable; git-invalid names are refused", () => {
  expect(validateBranchName("b", "  main ")).toBe("main");
  expect(validateBranchName("b", "")).toBeNull();
  bad(() => validateBranchName("b", null, false), /must be a branch name/);
  bad(() => validateBranchName("b", "a..b"), /isn't a valid branch name/);
  bad(() => validateBranchName("b", 3), /branch name or null/);
});

test("notifications merge over current, one category at a time", () => {
  const cur = { ...DEFAULT_NOTIFICATION_SETTINGS };
  const out = validateNotifications({ categories: { review: false } }, cur);
  expect(out.categories.review).toBe(false);
  expect(out.enabled).toBe(cur.enabled);
  expect(cur.categories.review).toBe(DEFAULT_NOTIFICATION_SETTINGS.categories.review);
  bad(() => validateNotifications({ categories: { nope: true } }), /Unknown notification category/);
  bad(() => validateNotifications({ apnsTeamId: "short" }), /10-character/);
  bad(() => validateNotifications({ other: 1 }), /Unknown notifications setting/);
  expect(validateNotifications({ apnsTeamId: " ABCDE12345 " }).apnsTeamId).toBe("ABCDE12345");
});

test("resolveSettings drops one bad stored value without losing the good ones", () => {
  const s = resolveSettings({ maxConcurrentRuns: 999, saveOnBlur: true, unknownKey: 1 });
  expect(s.maxConcurrentRuns).toBe(DEFAULT_SETTINGS.maxConcurrentRuns);
  expect(s.saveOnBlur).toBe(true);
  expect("unknownKey" in s).toBe(false);
});

test("resolveSettings applies legacy model keys over phaseModels and derives the legacy fields back", () => {
  const s = resolveSettings({ defaultDriver: "copilot", defaultModels: { copilot: "m9" } });
  expect(s.defaultDriver).toBe("copilot");
  expect(s.defaultModels.copilot).toBe("m9");
});

test("stored prompt overrides: unknown ids are dropped, blank ones ignored", () => {
  const s = resolveSettings({ prompts: { "not-a-prompt": "x", plan: "   " } });
  expect(Object.values(s.prompts ?? {}).every((v) => v === null)).toBe(true);
  expect("not-a-prompt" in (s.prompts ?? {})).toBe(false);
});

test("toPublicSettings hides secrets and reports whether each is set", () => {
  const pub = toPublicSettings({ ...DEFAULT_SETTINGS, anthropicApiKey: "k", claudeOauthToken: null });
  expect("anthropicApiKey" in pub).toBe(false);
  expect(pub.anthropicApiKeySet).toBe(true);
  expect(pub.claudeOauthTokenSet).toBe(false);
});

test("applySettingsPatch merges watcher models per driver and keeps prompts compact", () => {
  const current = { ...DEFAULT_SETTINGS, watcherModels: { a: "1", b: "2" } };
  expect(applySettingsPatch(current, { watcherModels: { a: null, c: "3" } }).watcherModels).toEqual({ b: "2", c: "3" });
});

test("applySettingsPatch folds legacy fields into phaseModels", () => {
  const out = applySettingsPatch(DEFAULT_SETTINGS, { defaultDriver: "copilot" });
  expect(out.defaultDriver).toBeUndefined();
  expect(out.phaseModels).toBeDefined();
});

test("the triage model and permission mode: a model name or null, read-only or auto or null", () => {
  expect(validateSettingsPatch({ cosTriageModel: "  sonnet " })).toEqual({ cosTriageModel: "sonnet" });
  expect(validateSettingsPatch({ cosTriageModel: "" })).toEqual({ cosTriageModel: null });
  for (const mode of ["auto", "read_only", null] as const) expect(validateSettingsPatch({ cosTriagePermissionMode: mode })).toEqual({ cosTriagePermissionMode: mode });
  // There is no human to ask during triage.
  for (const v of ["ask", "yolo", true]) bad(() => validateSettingsPatch({ cosTriagePermissionMode: v }), /cosTriagePermissionMode must be one of read_only, auto/);
});

test("the spec guard switch is a boolean and its model a name or null", () => {
  expect(validateSettingsPatch({ specGuardEnabled: false })).toEqual({ specGuardEnabled: false });
  for (const v of ["false", 0, null]) bad(() => validateSettingsPatch({ specGuardEnabled: v }), /specGuardEnabled must be true or false/);
  expect(validateSettingsPatch({ specGuardModel: "  opus " })).toEqual({ specGuardModel: "opus" });
  expect(validateSettingsPatch({ specGuardModel: " " })).toEqual({ specGuardModel: null });
  bad(() => validateSettingsPatch({ specGuardModel: 5 }), /specGuardModel must be a model name or null/);
  expect(DEFAULT_SETTINGS).toMatchObject({ specGuardEnabled: true, specGuardModel: null });
});

test("eventRetentionDays accepts whole days from 1 to 365 and defaults to a week", () => {
  expect(validateSettingsPatch({ eventRetentionDays: 1 })).toEqual({ eventRetentionDays: 1 });
  expect(validateSettingsPatch({ eventRetentionDays: 365 })).toEqual({ eventRetentionDays: 365 });
  for (const v of [0, -1, 366, 1.5, "7", null]) bad(() => validateSettingsPatch({ eventRetentionDays: v }), /eventRetentionDays must be an integer between 1 and 365/);
  expect(resolveSettings({}).eventRetentionDays).toBe(7);
  expect(resolveSettings({ eventRetentionDays: 30 }).eventRetentionDays).toBe(30);
});
