import { expect, test } from "bun:test";
import { encodeChoice, type ChoiceGroup } from "@harness/shared/state";
import { choiceSections } from "./modelSheet";

const opt = (driver: string, model: string, label: string) => ({ value: encodeChoice({ driver, model }), label });
const groups: ChoiceGroup[] = [
  { driver: "claude-code", label: "Claude Code", options: [opt("claude-code", "opus", "Opus"), opt("claude-code", "sonnet", "Sonnet")] },
  { driver: "openrouter", label: "OpenRouter", options: [opt("openrouter", "meta/llama-4", "Llama 4"), opt("openrouter", "anthropic/sonnet-5", "Sonnet 5")] },
];
const choices = { default: { value: "", label: "Default (Claude Code · Opus)" }, groups };
const names = { "claude-code": "Claude Code", openrouter: "OpenRouter" };

test("with no query: Default first with no header, then one headed section per driver", () => {
  const s = choiceSections(choices, "  ", names);
  expect(s.map((x) => [x.title, x.data.map((o) => o.label)])).toEqual([
    [null, ["Default (Claude Code · Opus)"]],
    ["Claude Code", ["Opus", "Sonnet"]],
    ["OpenRouter", ["Llama 4", "Sonnet 5"]],
  ]);
});

test("a query hides Default and drivers without a match, keeping the matching models under their heading", () => {
  const s = choiceSections(choices, "sonnet", names);
  expect(s.map((x) => [x.title, x.data.map((o) => o.label)])).toEqual([
    ["Claude Code", ["Sonnet"]],
    ["OpenRouter", ["Sonnet 5"]],
  ]);
});

test("Default stays under a query when its own label matches every word", () => {
  const s = choiceSections(choices, "default opus", names);
  expect(s[0]).toEqual({ key: "", title: null, data: [choices.default] });
});

test("a driver-name word narrows to that driver's models", () => {
  const s = choiceSections(choices, "openrouter sonnet", names);
  expect(s.map((x) => x.key)).toEqual(["openrouter"]);
  expect(s[0]!.data.map((o) => o.label)).toEqual(["Sonnet 5"]);
});

test("a single driver's flat group keeps a null heading, and no match leaves nothing (No models match)", () => {
  const flat = { ...choices, groups: [{ ...groups[0]!, label: null }] };
  expect(choiceSections(flat, "", names)[1]!.title).toBeNull();
  expect(choiceSections(choices, "gpt", names)).toEqual([]);
});

test("without a Default (a ticket mid-run) only the driver sections show", () => {
  expect(choiceSections({ default: null, groups }, "", names).map((x) => x.key)).toEqual(["claude-code", "openrouter"]);
  expect(choiceSections({ default: null, groups }, "llama", names).map((x) => x.key)).toEqual(["openrouter"]);
});
