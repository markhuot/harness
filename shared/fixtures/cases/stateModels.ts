// Model selection helpers (shared/src/state/models.ts) for HarnessKit's State/Models.swift.
// ModelListCache has no fixtures: it's about request sequencing, tested directly in Swift.
import type * as P from "../../src/protocol";
import {
  decodeChoice,
  driverModelChoices,
  encodeChoice,
  filterChoiceGroups,
  inheritedModel,
  modelName,
  modelOptions,
  projectChoice,
  projectChoicePatch,
  projectDriver,
  settingsChoice,
  settingsChoicePatch,
  ticketChoice,
  ticketChoicePatch,
  ticketModelBadge,
  ticketResolvedChoice,
  type ChoiceGroup,
} from "../../src/state/models";
import type { TriageChoice } from "../../src/watchers";
import { cases } from "../case";
import { Project as projectSamples, PublicSettings as publicSettingsSamples, Settings as settingsSamples } from "./protocol";

type Models = Record<string, string | null>;
type ProjectModels = Record<string, string>;
type ProjectIn = { defaultDriver: string | null; defaultModels: ProjectModels } | null;
type SettingsIn = { defaultDriver: string; defaultModels: Models } | null;

const MODELS: P.ModelInfo[] = [
  { id: "opus", name: "Opus 5.5", default: true },
  { id: "sonnet", name: "Sonnet 5" },
];

export const sep = "\u0001";

// ---------------------------------------------------------------------------
// modelName / modelOptions / inheritedModel / ticketModelBadge
// ---------------------------------------------------------------------------

export const modelNameCases = cases(({ models, id }: { models: P.ModelInfo[] | null; id: string }) => modelName(models ?? undefined, id), {
  "listed id → name": { models: MODELS, id: "sonnet" },
  "unlisted id → the id": { models: MODELS, id: "haiku" },
  "no list → the id": { models: null, id: "opus" },
  "empty name is kept (not nullish)": { models: [{ id: "x", name: "" }], id: "x" },
  "first match wins": { models: [{ id: "x", name: "One" }, { id: "x", name: "Two" }], id: "x" },
  "empty id": { models: MODELS, id: "" },
});

type OptionsIn = { models: P.ModelInfo[] | null; value: string | null; opts?: { inherited?: string | null; defaultLabel?: string; plainDefault?: boolean } };

export const modelOptionsCases = cases(({ models, value, opts }: OptionsIn) => modelOptions(models ?? undefined, value, opts), {
  "inherited names the default": { models: MODELS, value: null, opts: { inherited: "sonnet" } },
  "no inherited: the list's default": { models: MODELS, value: null },
  "inherited id not in the list: shown by id": { models: MODELS, value: null, opts: { inherited: "claude-x-1" } },
  "custom current value": { models: MODELS, value: "claude-opus-4-1" },
  "no list, custom value": { models: null, value: "haiku" },
  "listed value isn't duplicated": { models: MODELS, value: "sonnet" },
  "plainDefault keeps the label": { models: MODELS, value: null, opts: { defaultLabel: "Same as work", plainDefault: true } },
  "plainDefault false still names it": { models: MODELS, value: null, opts: { defaultLabel: "Same as work", plainDefault: false } },
  "custom defaultLabel with inherited": { models: MODELS, value: null, opts: { defaultLabel: "Inherit", inherited: "opus" } },
  "empty inherited is falsy: list default": { models: MODELS, value: null, opts: { inherited: "" } },
  "null inherited: list default": { models: MODELS, value: null, opts: { inherited: null } },
  "empty value isn't custom": { models: MODELS, value: "" },
  "no default in list": { models: [{ id: "a", name: "A" }], value: null },
  "default with an empty name": { models: [{ id: "a", name: "", default: true }], value: null },
  "default: false isn't marked": { models: [{ id: "a", name: "A", default: false }], value: "a" },
  "empty defaultLabel": { models: MODELS, value: null, opts: { defaultLabel: "" } },
  "empty list": { models: [], value: null },
});

type InheritIn = { driver: string; level: "ticket" | "project" | "settings"; project: ProjectIn; settings: SettingsIn };
const iProject = { defaultDriver: null, defaultModels: { "claude-code": "sonnet", empty: "" } };
const iSettings = { defaultDriver: "claude-code", defaultModels: { "claude-code": "opus", dummy: "dummy-slow", empty: "fallback", nulled: null } };

export const inheritedModelCases = cases(({ driver, level, project, settings }: InheritIn) => inheritedModel(driver, level, project, settings), {
  "ticket: project's model": { driver: "claude-code", level: "ticket", project: iProject, settings: iSettings },
  "project: settings' model": { driver: "claude-code", level: "project", project: iProject, settings: iSettings },
  "settings: nothing above": { driver: "claude-code", level: "settings", project: iProject, settings: iSettings },
  "ticket: falls through to settings": { driver: "dummy", level: "ticket", project: iProject, settings: iSettings },
  "ticket: unknown driver": { driver: "anthropic-api", level: "ticket", project: iProject, settings: iSettings },
  "ticket: no project or settings": { driver: "claude-code", level: "ticket", project: null, settings: null },
  "ticket: empty project model falls through": { driver: "empty", level: "ticket", project: iProject, settings: iSettings },
  "project: null settings entry": { driver: "nulled", level: "project", project: iProject, settings: iSettings },
  "project: ignores the project's own model": { driver: "claude-code", level: "project", project: iProject, settings: null },
});

export const ticketModelBadgeCases = cases(({ model, models }: { model: string | null; models: P.ModelInfo[] | null }) => ticketModelBadge(model, models ?? undefined), {
  "no model": { model: null, models: MODELS },
  "empty model": { model: "", models: MODELS },
  "known model": { model: "sonnet", models: MODELS },
  "no list": { model: "haiku", models: null },
});

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

export const encodeChoiceCases = cases(encodeChoice, {
  Default: { driver: null, model: null },
  "driver and model": { driver: "a", model: "m:1" },
  "driver default": { driver: "a", model: null },
  "empty driver is Default": { driver: "", model: "m" },
  "model without driver is Default": { driver: null, model: "m" },
  "empty model": { driver: "a", model: "" },
});

export const decodeChoiceCases = cases(decodeChoice, {
  empty: "",
  "driver only (no separator)": "claude-code",
  "driver default": `a${sep}`,
  "driver and model": `a${sep}m:1`,
  "model with a separator inside": `a${sep}b${sep}c`,
  "empty driver": `${sep}m`,
  "only a separator": sep,
  "emoji model": `a${sep}🧪`,
});

// ---------------------------------------------------------------------------
// driverModelChoices
// ---------------------------------------------------------------------------

type ChoiceDriver = { id: string; name: string; available: boolean; authenticated: boolean };
type ChoicesIn = {
  drivers: ChoiceDriver[];
  models: Record<string, P.ModelInfo[]>;
  value: TriageChoice;
  resolved: TriageChoice;
  /** inheritedModels stands in for opts.inheritedModel: (d) => inheritedModels[d] ?? null */
  opts?: { defaultLabel?: string; onlyDriver?: string; inheritedModels?: Models };
};

const drivers: ChoiceDriver[] = [
  { id: "claude-code", name: "Claude Code", available: true, authenticated: true },
  { id: "anthropic-api", name: "Anthropic API", available: true, authenticated: true },
  { id: "codex", name: "Codex", available: true, authenticated: false },
];
const choiceModels: Record<string, P.ModelInfo[]> = {
  "claude-code": [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet", default: true },
  ],
  "anthropic-api": [{ id: "claude-sonnet-5", name: "Sonnet 5", default: true }],
  codex: [{ id: "luna", name: "Luna" }],
};
const none: TriageChoice = { driver: null, model: null };
const resolved: TriageChoice = { driver: "claude-code", model: null };
const oneSignedIn = drivers.map((d) => (d.id === "anthropic-api" ? { ...d, authenticated: false } : d));

export const driverModelChoicesCases = cases(
  ({ drivers, models, value, resolved, opts }: ChoicesIn) => {
    const { inheritedModels, ...rest } = opts ?? {};
    return driverModelChoices(drivers, models, value, resolved, inheritedModels ? { ...rest, inheritedModel: (d) => inheritedModels[d] ?? null } : rest);
  },
  {
    "signed-in drivers become groups": { drivers, models: choiceModels, value: none, resolved },
    "one signed-in driver: flat list": { drivers: oneSignedIn, models: choiceModels, value: { driver: "claude-code", model: "opus" }, resolved: { driver: "claude-code", model: "opus" } },
    "flat list resolving to another driver names it": { drivers: oneSignedIn, models: choiceModels, value: none, resolved: { driver: "anthropic-api", model: null } },
    "picked driver not signed in stays listed": { drivers, models: choiceModels, value: { driver: "codex", model: "luna" }, resolved },
    "driver without a model gets its default entry": { drivers, models: choiceModels, value: { driver: "claude-code", model: null }, resolved },
    "unknown model kept as custom": { drivers, models: choiceModels, value: { driver: "claude-code", model: "claude-x-1" }, resolved },
    "onlyDriver, resolving there": { drivers, models: choiceModels, value: { driver: "claude-code", model: "opus" }, resolved, opts: { onlyDriver: "claude-code" } },
    "onlyDriver elsewhere: no Default": { drivers, models: choiceModels, value: { driver: "anthropic-api", model: null }, resolved, opts: { onlyDriver: "anthropic-api" } },
    "onlyDriver not signed in": { drivers, models: choiceModels, value: { driver: "codex", model: "luna" }, resolved, opts: { onlyDriver: "codex" } },
    "onlyDriver unknown to the list": { drivers, models: choiceModels, value: { driver: "gone", model: "m" }, resolved: { driver: "gone", model: null }, opts: { onlyDriver: "gone" } },
    "onlyDriver empty string": { drivers, models: choiceModels, value: { driver: "gone", model: "m" }, resolved, opts: { onlyDriver: "" } },
    "inheritedModel names the driver default": {
      drivers,
      models: choiceModels,
      value: { driver: "claude-code", model: null },
      resolved: { driver: "anthropic-api", model: null },
      opts: { inheritedModels: { "claude-code": "opus" } },
    },
    "inheritedModel unknown id shown by id": { drivers, models: choiceModels, value: { driver: "claude-code", model: null }, resolved, opts: { inheritedModels: { "claude-code": "claude-x-9" } } },
    "inheritedModel null falls back to list default": { drivers, models: choiceModels, value: { driver: "claude-code", model: null }, resolved, opts: { inheritedModels: { "claude-code": null } } },
    "resolved with a model": { drivers, models: choiceModels, value: none, resolved: { driver: "claude-code", model: "opus" } },
    "resolved driver with no models loaded": { drivers, models: {}, value: none, resolved: { driver: "codex", model: null } },
    "resolved unknown driver": { drivers, models: choiceModels, value: none, resolved: { driver: "mystery", model: null } },
    "no resolved driver": { drivers, models: choiceModels, value: none, resolved: none },
    "empty resolved driver": { drivers, models: choiceModels, value: none, resolved: { driver: "", model: "x" } },
    "custom defaultLabel": { drivers, models: choiceModels, value: none, resolved, opts: { defaultLabel: "Same as work" } },
    "custom defaultLabel, nothing to name": { drivers, models: choiceModels, value: none, resolved: none, opts: { defaultLabel: "Inherit" } },
    "picked model on a multi-driver list": { drivers, models: choiceModels, value: { driver: "anthropic-api", model: "claude-sonnet-5" }, resolved },
    "picked unknown driver is appended": { drivers, models: choiceModels, value: { driver: "gone", model: "m" }, resolved },
    "picked unknown driver without model": { drivers, models: choiceModels, value: { driver: "gone", model: null }, resolved },
    "no drivers at all": { drivers: [], models: {}, value: none, resolved: none },
    "no drivers, picked one": { drivers: [], models: {}, value: { driver: "x", model: null }, resolved: { driver: "x", model: null } },
    "unavailable but signed in is hidden": {
      drivers: [...drivers, { id: "gemini", name: "Gemini", available: false, authenticated: true }],
      models: choiceModels,
      value: none,
      resolved,
    },
    "empty model is a driver default": { drivers, models: choiceModels, value: { driver: "claude-code", model: "" }, resolved },
    "default entry without a list default": { drivers, models: choiceModels, value: { driver: "codex", model: null }, resolved },
    "model with an empty name": {
      drivers,
      models: { ...choiceModels, "claude-code": [{ id: "anon", name: "", default: true }] },
      value: { driver: "claude-code", model: null },
      resolved,
    },
  },
);

// ---------------------------------------------------------------------------
// filterChoiceGroups
// ---------------------------------------------------------------------------

const opt = (driver: string, model: string, label: string) => ({ value: encodeChoice({ driver, model }), label });
const groups: ChoiceGroup[] = [
  { driver: "claude-code", label: "Claude Code", options: [opt("claude-code", "opus", "Opus 5.5"), opt("claude-code", "sonnet", "Sonnet 5")] },
  { driver: "openrouter", label: "OpenRouter", options: [opt("openrouter", "openai/gpt-4o", "GPT-4o")] },
];
const unicodeGroups: ChoiceGroup[] = [
  {
    driver: "x",
    label: "Ünïcode",
    options: [
      { value: encodeChoice({ driver: "x", model: "café" }), label: "Café" },
      { value: encodeChoice({ driver: "x", model: "sigma" }), label: "ΟΔΟΣ" },
      { value: encodeChoice({ driver: "x", model: "kelvin" }), label: "Kelvin" },
      { value: "", label: "Default (İstanbul)" },
    ],
  },
];

type FilterIn = { groups: ChoiceGroup[]; query: string; driverNames?: Record<string, string> };

export const filterChoiceGroupsCases = cases(({ groups, query, driverNames }: FilterIn) => filterChoiceGroups(groups, query, driverNames), {
  "blank query keeps all": { groups, query: "  " },
  "empty query keeps all": { groups, query: "" },
  "driver + model words": { groups, query: "claude op" },
  "by model id": { groups, query: "openai" },
  "case-insensitive": { groups, query: "SONNET" },
  "words split across drivers": { groups, query: "opus router" },
  "flat group matches through driverNames": { groups: [{ ...groups[0]!, label: null }], query: "claude", driverNames: { "claude-code": "Claude Code" } },
  "flat group without driverNames: driver id": { groups: [{ ...groups[0]!, label: null }], query: "claude-code" },
  "tabs and newlines separate words": { groups, query: "\tclaude\n5.5 " },
  "NBSP separates words": { groups, query: "claude sonnet" },
  "NEL doesn't separate words": { groups, query: "claude\u0085sonnet" },
  "combining mark query": { groups: unicodeGroups, query: "café" },
  "precomposed doesn't match decomposed": { groups: unicodeGroups, query: "café" },
  "final sigma lower-cases": { groups: unicodeGroups, query: "οδος" },
  "Kelvin sign lower-cases to k": { groups: unicodeGroups, query: "kelvin" },
  "dotted I lower-cases to i + combining dot": { groups: unicodeGroups, query: "i̇stanbul" },
  "label words with umlauts": { groups: unicodeGroups, query: "ÜNÏ" },
  "no match leaves nothing": { groups, query: "gpt-5" },
  "a word matching across the joined label/model boundary": { groups, query: "5.5 opus" },
  "matches the separator-free model id": { groups, query: "gpt-4o openai/gpt-4o" },
});

// ---------------------------------------------------------------------------
// ticket / project / settings picks
// ---------------------------------------------------------------------------

const settings = { defaultDriver: "claude-code", defaultModels: { "claude-code": "sonnet" } as Models };
const project = { defaultDriver: "codex", defaultModels: { codex: "luna", "claude-code": "opus" } as ProjectModels };
const plain = { defaultDriver: null, defaultModels: {} };

type PS = { project: ProjectIn; settings: SettingsIn };

export const projectDriverCases = cases(({ project, settings }: PS) => projectDriver(project, settings), {
  "the project's own": { project, settings },
  "else the settings'": { project: plain, settings },
  "nothing: empty": { project: null, settings: null },
  "empty project driver falls through": { project: { defaultDriver: "", defaultModels: {} }, settings },
  "no settings": { project, settings: null },
  "empty settings driver": { project: plain, settings: { defaultDriver: "", defaultModels: {} } },
});

type TicketIn = { ticket: { driver: string; model: string | null } } & PS;

export const ticketChoiceCases = cases(({ ticket, project, settings }: TicketIn) => ticketChoice(ticket, project, settings), {
  "project driver, no model: Default": { ticket: { driver: "codex", model: null }, project, settings },
  "project driver with model": { ticket: { driver: "codex", model: "luna" }, project, settings },
  "another driver without a model is a pick": { ticket: { driver: "claude-code", model: null }, project, settings },
  "empty model on the project driver: Default": { ticket: { driver: "codex", model: "" }, project, settings },
  "settings driver via plain project": { ticket: { driver: "claude-code", model: null }, project: plain, settings },
  "no project or settings, empty driver": { ticket: { driver: "", model: null }, project: null, settings: null },
  "empty model elsewhere keeps the empty model": { ticket: { driver: "claude-code", model: "" }, project, settings },
});

export const ticketResolvedChoiceCases = cases(({ project, settings }: PS) => ticketResolvedChoice(project, settings), {
  "project driver and its model": { project, settings },
  "settings driver and model": { project: plain, settings },
  "nothing: Default": { project: null, settings: null },
  "project driver without a model inherits settings' entry": { project: { defaultDriver: "claude-code", defaultModels: {} }, settings },
  "driver with no model anywhere": { project: { defaultDriver: "gemini", defaultModels: {} }, settings },
});

type PatchIn = { choice: TriageChoice } & PS;

export const ticketChoicePatchCases = cases(({ choice, project, settings }: PatchIn) => ticketChoicePatch(choice, project, settings), {
  "Default moves back to the project driver": { choice: none, project, settings },
  "a pick": { choice: { driver: "claude-code", model: "opus" }, project, settings },
  "Default with nothing to move to": { choice: none, project: null, settings: null },
  "driver default pick": { choice: { driver: "claude-code", model: null }, project, settings },
  "Default keeps a stray model": { choice: { driver: null, model: "stray" }, project, settings },
  "empty driver isn't nullish: model cleared": { choice: { driver: "", model: "x" }, project, settings },
});

type ProjectChoiceIn = { project: { defaultDriver: string | null; defaultModels: ProjectModels }; settings: SettingsIn };

export const projectChoiceCases = cases(({ project, settings }: ProjectChoiceIn) => projectChoice(project, settings), {
  "pinned driver with its model": { project, settings },
  "pinned driver without a model": { project: { defaultDriver: "codex", defaultModels: {} }, settings },
  "model for the settings driver": { project: { defaultDriver: null, defaultModels: { "claude-code": "opus" } }, settings },
  "model for another driver: Default": { project: { defaultDriver: null, defaultModels: { codex: "luna" } }, settings },
  "no settings: Default": { project: { defaultDriver: null, defaultModels: { "claude-code": "opus" } }, settings: null },
  "empty model for the settings driver: Default": { project: { defaultDriver: null, defaultModels: { "claude-code": "" } }, settings },
  "pinned driver, empty model": { project: { defaultDriver: "codex", defaultModels: { codex: "" } }, settings },
  "empty pinned driver falls through": { project: { defaultDriver: "", defaultModels: { "claude-code": "opus" } }, settings },
});

export const projectChoicePatchCases = cases(
  ({ choice, project }: { choice: TriageChoice; project: { defaultDriver: string | null; defaultModels: ProjectModels } }) => projectChoicePatch(choice, project),
  {
    "keeps only that driver's model": { choice: { driver: "claude-code", model: "haiku" }, project },
    "Default clears everything": { choice: none, project },
    "driver default": { choice: { driver: "gemini", model: null }, project },
    "no stored models": { choice: { driver: "codex", model: "luna" }, project: plain },
    "empty driver": { choice: { driver: "", model: "x" }, project },
  },
);

export const settingsChoiceCases = cases(settingsChoice, {
  "default driver with a model": settings,
  "default driver without one: Default": { defaultDriver: "codex", defaultModels: { "claude-code": "sonnet" } },
  "null entry: Default": { defaultDriver: "codex", defaultModels: { codex: null } },
  "empty entry: Default": { defaultDriver: "codex", defaultModels: { codex: "" } },
});

const s2 = { defaultDriver: "claude-code", defaultModels: { "claude-code": "sonnet", codex: "luna" } as Models };

export const settingsChoicePatchCases = cases(({ choice, settings }: { choice: TriageChoice; settings: { defaultDriver: string; defaultModels: Models } }) => settingsChoicePatch(choice, settings), {
  "driver default": { choice: { driver: "codex", model: null }, settings: s2 },
  "driver and model": { choice: { driver: "codex", model: "luna-2" }, settings: s2 },
  "Default keeps the driver": { choice: none, settings: s2 },
  "Default keeps a stray model": { choice: { driver: null, model: "stray" }, settings: s2 },
  "empty driver isn't nullish": { choice: { driver: "", model: "x" }, settings: s2 },
});

// ---------------------------------------------------------------------------
// Real protocol entities (Project, Settings, PublicSettings, Ticket shapes)
// ---------------------------------------------------------------------------

type EntityIn = { project: P.Project | null; settings: P.Settings | P.PublicSettings | null; ticket: { driver: string; model: string | null } };

export const entityCases = cases(
  ({ project, settings, ticket }: EntityIn) => ({
    projectDriver: projectDriver(project, settings),
    resolved: ticketResolvedChoice(project, settings),
    ticketChoice: ticketChoice(ticket, project, settings),
    ticketPatch: ticketChoicePatch({ driver: null, model: null }, project, settings),
    inheritedTicket: inheritedModel("claude-code", "ticket", project, settings),
    projectChoice: project ? projectChoice(project, settings) : null,
    projectPatch: project ? projectChoicePatch({ driver: "claude-code", model: "haiku" }, project) : null,
    settingsChoice: settings ? settingsChoice(settings) : null,
    settingsPatch: settings ? settingsChoicePatch({ driver: null, model: null }, settings) : null,
  }),
  [
    ...projectSamples.flatMap((p, i) =>
      [...settingsSamples, ...publicSettingsSamples].map((s, j) => [`project ${i} × settings ${j}`, { project: p, settings: s, ticket: { driver: "claude-code", model: null } }] as const),
    ),
    ["no project, settings 0", { project: null, settings: settingsSamples[0]!, ticket: { driver: "claude-code", model: "opus" } }],
    ["nothing", { project: null, settings: null, ticket: { driver: "x", model: null } }],
  ],
);
