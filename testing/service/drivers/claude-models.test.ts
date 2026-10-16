import { expect, test } from "bun:test";
import { createDrivers, dummyDriverEnabled, DUMMY_DRIVER_ENV } from "../../../service/src/drivers/index";
import { CLAUDE_MODEL_ALIASES, initializeRequest, INITIALIZE_REQUEST_ID, parseClaudeCommands, parseClaudeModels } from "../../../service/src/drivers/claude-code-models";
import { fromJson, toJson, bool, int } from "../../../service/src/store/util";
import { DEFAULT_SETTINGS } from "../../../service/src/orchestrator/settings";

test("the CLI's synthetic default entry is dropped and the model it resolves to is marked default", () => {
  const out = parseClaudeModels([
    { value: "default", displayName: "Default", description: "Opus 5.5 · Best for everyday tasks", resolvedModel: "claude-opus-5-5" },
    { value: "sonnet", displayName: "Sonnet", description: "Fast", resolvedModel: "claude-sonnet-5-5" },
    { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5" },
  ]);
  expect(out).toEqual([{ id: "sonnet", name: "Sonnet", description: "Fast" }, { id: "opus", name: "Opus", default: true }]);
});

test("when no listed model is what default resolves to, the default entry is kept, named from its description", () => {
  const out = parseClaudeModels([{ value: "default", description: "Mystery 9 · Whatever", resolvedModel: "x" }, { value: "sonnet" }]);
  expect(out).toEqual([{ id: "default", name: "Mystery 9", description: "Mystery 9 · Whatever", default: true }, { id: "sonnet", name: "sonnet" }]);
  expect(parseClaudeModels([{ value: "default" }])).toEqual([{ id: "default", name: "Default", default: true }]);
});

test("only the first match is marked default, and entries without a string value are skipped", () => {
  const out = parseClaudeModels([{ value: "default", resolvedModel: "m" }, { value: "a", resolvedModel: "m" }, { value: "b", resolvedModel: "m" }, { value: 5 }, null, { value: "" }]);
  expect(out.map((m) => [m.id, !!m.default])).toEqual([["a", true], ["b", false]]);
});

test("a response with no models list is an error", () => {
  expect(() => parseClaudeModels(undefined)).toThrow(/no models list/);
  expect(() => parseClaudeModels({})).toThrow(/no models list/);
});

test("commands keep the CLI's order, drop internal and unnamed ones and duplicates, and trim argument hints", () => {
  expect(
    parseClaudeCommands([
      { name: "review", description: "Review code", argumentHint: "  [pr]  " },
      { name: "__remote-workflow" },
      { description: "no name" },
      { name: "review", description: "dup" },
      { name: "init", argumentHint: "  " },
      null,
    ]),
  ).toEqual([{ name: "review", description: "Review code", argumentHint: "[pr]" }, { name: "init", description: "" }]);
  expect(() => parseClaudeCommands("x")).toThrow(/no commands list/);
});

test("the initialize request is a control request the response can be matched to, and the fallback list names the aliases every CLI knows", () => {
  expect(JSON.parse(initializeRequest())).toEqual({ type: "control_request", request_id: INITIALIZE_REQUEST_ID, request: { subtype: "initialize" } });
  expect(CLAUDE_MODEL_ALIASES.map((m) => m.id)).toEqual(["sonnet", "opus", "fable", "haiku"]);
});

test("the dummy driver is added only when the environment switch is exactly 1", () => {
  const ids = (env: Record<string, string>) => createDrivers({ settings: () => DEFAULT_SETTINGS, env }).map((d) => d.id);
  expect(ids({})).toEqual(["claude-code", "anthropic-api", "github-copilot"]);
  expect(ids({ [DUMMY_DRIVER_ENV]: "1" })).toEqual(["claude-code", "anthropic-api", "github-copilot", "dummy"]);
  expect(ids({ [DUMMY_DRIVER_ENV]: "true" })).not.toContain("dummy");
  expect(dummyDriverEnabled({ [DUMMY_DRIVER_ENV]: "1" })).toBe(true);
});

test("JSON helpers store nothing as NULL and read bad or empty text as the fallback; booleans are stored as 0 and 1", () => {
  expect(toJson(undefined)).toBeNull();
  expect(toJson(null)).toBeNull();
  expect(toJson({ a: 1 })).toBe('{"a":1}');
  expect(toJson(0)).toBe("0");
  expect(fromJson<number[]>("[1]", [])).toEqual([1]);
  for (const bad of [null, undefined, "", "{oops"]) expect(fromJson(bad, "fallback")).toBe("fallback");
  expect([bool(1), bool(true), bool(0), bool(null), bool("1")]).toEqual([true, true, false, false, false]);
  expect([int(true), int(false)]).toEqual([1, 0]);
});
