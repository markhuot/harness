// Model sheet sections (mobile/src/lib/modelSheet.ts) for HarnessKit's State/ModelSheet.swift.
import { choiceSections } from "../../../mobile/src/lib/modelSheet";
import { encodeChoice, type ChoiceGroup, type ModelOption } from "../../src/state/models";
import { cases } from "../case";

const opt = (driver: string, model: string, label: string) => ({ value: encodeChoice({ driver, model }), label });
const groups: ChoiceGroup[] = [
  { driver: "claude-code", label: "Claude Code", options: [opt("claude-code", "opus", "Opus"), opt("claude-code", "sonnet", "Sonnet")] },
  { driver: "openrouter", label: "OpenRouter", options: [opt("openrouter", "meta/llama-4", "Llama 4"), opt("openrouter", "anthropic/sonnet-5", "Sonnet 5")] },
];
const def: ModelOption = { value: "", label: "Default (Claude Code · Opus)" };
const names = { "claude-code": "Claude Code", openrouter: "OpenRouter" };
const flat = [{ ...groups[0]!, label: null }];

type In = { choices: { default: ModelOption | null; groups: ChoiceGroup[] }; query: string; driverNames?: Record<string, string> };

export const choiceSectionsCases = cases(({ choices, query, driverNames }: In) => choiceSections(choices, query, driverNames), {
  "no query: Default first, then a section per driver": { choices: { default: def, groups }, query: "  ", driverNames: names },
  "a query hides Default and unmatched drivers": { choices: { default: def, groups }, query: "sonnet", driverNames: names },
  "Default stays when its label matches every word": { choices: { default: def, groups }, query: "default opus", driverNames: names },
  "Default label match is case-insensitive": { choices: { default: def, groups }, query: "DEFAULT", driverNames: names },
  "Default needs every word": { choices: { default: def, groups }, query: "default llama", driverNames: names },
  "a driver-name word narrows to that driver": { choices: { default: def, groups }, query: "openrouter sonnet", driverNames: names },
  "a flat group keeps a null heading": { choices: { default: def, groups: flat }, query: "", driverNames: names },
  "flat group matched by driverNames": { choices: { default: def, groups: flat }, query: "claude sonnet", driverNames: names },
  "flat group without driverNames": { choices: { default: def, groups: flat }, query: "claude sonnet" },
  "no match: nothing": { choices: { default: def, groups }, query: "gpt", driverNames: names },
  "no Default: only driver sections": { choices: { default: null, groups }, query: "", driverNames: names },
  "no Default, a query": { choices: { default: null, groups }, query: "llama", driverNames: names },
  "Default only": { choices: { default: def, groups: [] }, query: "" },
  "Default with an empty label and a query": { choices: { default: { value: "", label: "" }, groups }, query: "opus" },
  "NBSP and tab split words": { choices: { default: def, groups }, query: "default claude\topus", driverNames: names },
  "NEL joins words": { choices: { default: def, groups }, query: "default\u0085opus", driverNames: names },
  "Default with a final sigma": { choices: { default: { value: "", label: "Default (ΟΔΟΣ)" }, groups: [] }, query: "οδος" },
});
