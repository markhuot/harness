// Watcher helpers (shared/src/watchers.ts) for HarnessKit's Watchers.swift.
import type * as P from "../../src/protocol";
import {
  DEFAULT_TRIAGE_CHOICE,
  outputTitle,
  OUTPUT_TITLE_MAX,
  replaceModels,
  settingsWatcherChoice,
  settingsWatcherChoicePatch,
  shellQuote,
  type TriageChoice,
  watcherChoice,
  watcherChoiceBody,
  watcherCommandLine,
  watcherDriver,
  watcherModel,
} from "../../src/watchers";
import { cases } from "../case";
import { PublicSettings as publicSettingsSamples, Settings as settingsSamples, Watcher as watcherSamples } from "./protocol";

export const outputTitleMax = OUTPUT_TITLE_MAX;
export const defaultTriageChoice = DEFAULT_TRIAGE_CHOICE;

export const shellQuoteCases = cases(shellQuote, {
  plain: "plain",
  "path and flag characters": "~/Sites/a_b-c.d,e/f:g=h@i%j+k",
  "--flag=value": "--project=PLAYR",
  "lone dash": "-",
  empty: "",
  pipe: "a|b",
  "dollar variable": "$HOME",
  space: "FOO BAR",
  tab: "a\tb",
  newline: "a\nb",
  "single quote": "it's",
  "only a single quote": "'",
  "two single quotes": "''",
  "double quote": 'say "hi"',
  glob: "*.ts",
  bang: "wow!",
  semicolon: "a;b",
  backtick: "`id`",
  "non-ASCII letter": "café",
  emoji: "🚀",
  "combining mark": "é",
  "quote with a combining mark": "it'́s",
});

type CommandInput = { command: string; args?: string[] };

export const watcherCommandLineCases = cases((w: CommandInput) => watcherCommandLine(w as Pick<P.Watcher, "command" | "args">), {
  "shell watcher used as is": { command: "while true; do curl -s x; sleep 60; done", args: [] },
  "no args field": { command: "watch-jira --project=PLAYR --once | jq -c '.[]'" },
  "legacy args quoted only where needed": { command: "node", args: ["~/Sites/Jira/watch-jira.js", "--project", "FOO BAR", "it's"] },
  "legacy command with a space is quoted": { command: "/Applications/My Tool/bin/poll", args: ["--json"] },
  "legacy empty arg": { command: "poll", args: [""] },
  "legacy single arg": { command: "/usr/local/bin/poll", args: ["--since=1h"] },
  "shell command not re-quoted": { command: "echo 'it''s' | wc -l", args: [] },
  "empty command without args": { command: "", args: [] },
  "empty command with args": { command: "", args: ["x"] },
});

export const outputTitleCases = cases(outputTitle, {
  "first non-blank line, whitespace collapsed": "\n\n   Build   failed on main \nsecond line",
  "long line cut with an ellipsis": "x".repeat(200),
  "exactly the limit kept": "y".repeat(OUTPUT_TITLE_MAX),
  "one past the limit cut": "y".repeat(OUTPUT_TITLE_MAX + 1),
  "trailing space at the cut trimmed": "a".repeat(OUTPUT_TITLE_MAX - 2) + " " + "b".repeat(10),
  "skips an opening brace": '{\n  "summary": "Fix login"\n}',
  "blank output": "  \n\t",
  "empty output": "",
  "only punctuation": "{\n}\n---\n",
  "CRLF lines": "\r\n{\r\nDeploy done\r\nnext",
  "lone CR is not a line break": "alpha\rbeta\ngamma",
  "CR before CRLF": "a\r\r\nb",
  "digits count as readable": "---\n  42  \nlater",
  "fraction and roman numerals are numbers": "½\nx",
  "letter number": "Ⅻ",
  "CJK letters": "-- \n中文 标题",
  "emoji alone isn't readable": "🚀🚀\nlaunched",
  "lone combining mark isn't readable": "́\nnext",
  "non-breaking and ideographic spaces collapse": "a  b　c",
  "NEL is not whitespace in JS": "a\u0085b",
  "vertical tab and form feed collapse": "a\u000b\u000cb",
  // .length and .slice count UTF-16 code units.
  "emoji at the limit fit": "a" + "🚀".repeat(39) + "b",
  "emoji past the limit in code units": "a" + "🚀".repeat(40),
  "combining marks count as code units": "é".repeat(41),
  "leading whitespace before the cut": "   " + "z".repeat(100),
});

const baseSettings = { defaultDriver: "claude-code", watcherDriver: null, defaultModels: { "claude-code": "haiku" }, watcherModels: {} as Record<string, string | null> };

type DriverInput = { watcher: { driver: string | null } | null; settings: { defaultDriver: string; watcherDriver?: string | null } };

export const watcherDriverCases = cases(({ watcher, settings }: DriverInput) => watcherDriver(watcher, settings as Pick<P.Settings, "defaultDriver" | "watcherDriver">), {
  "watcher's driver wins": { watcher: { driver: "anthropic-api" }, settings: { ...baseSettings, watcherDriver: "dummy" } },
  "settings watcher driver next": { watcher: { driver: null }, settings: { ...baseSettings, watcherDriver: "dummy" } },
  "default driver last": { watcher: { driver: null }, settings: baseSettings },
  "no watcher": { watcher: null, settings: { defaultDriver: "claude-code" } },
  "empty watcher driver inherits": { watcher: { driver: "" }, settings: { ...baseSettings, watcherDriver: "dummy" } },
  "empty settings watcher driver inherits": { watcher: null, settings: { defaultDriver: "claude-code", watcherDriver: "" } },
});

type ModelsMap = Record<string, string | null>;
type ModelInput = {
  driver: string;
  watcher: { models?: ModelsMap } | null;
  settings: { watcherModels?: ModelsMap; defaultModels?: ModelsMap } | null;
};

export const watcherModelCases = cases(({ driver, watcher, settings }: ModelInput) => watcherModel(driver, watcher as Pick<P.Watcher, "models"> | null, settings as Partial<P.Settings> | null), {
  "watcher's model wins": { driver: "claude-code", watcher: { models: { "claude-code": "opus" } }, settings: { ...baseSettings, watcherModels: { "claude-code": "sonnet" } } },
  "watcher default next": { driver: "claude-code", watcher: { models: {} }, settings: { ...baseSettings, watcherModels: { "claude-code": "sonnet" } } },
  "global default last": { driver: "claude-code", watcher: null, settings: baseSettings },
  "nothing for this driver": { driver: "anthropic-api", watcher: { models: { "claude-code": "opus" } }, settings: { ...baseSettings, watcherModels: { "claude-code": "sonnet" } } },
  "watcher without models": { driver: "claude-code", watcher: {}, settings: { defaultModels: { "claude-code": "haiku" } } },
  "null settings": { driver: "claude-code", watcher: { models: { "claude-code": "opus" } }, settings: null },
  "null settings, no watcher": { driver: "claude-code", watcher: null, settings: null },
  "settings without maps": { driver: "claude-code", watcher: null, settings: {} },
  "empty watcher model inherits": { driver: "claude-code", watcher: { models: { "claude-code": "" } }, settings: { watcherModels: { "claude-code": "sonnet" } } },
  "null watcher-default entry inherits": { driver: "claude-code", watcher: null, settings: { watcherModels: { "claude-code": null }, defaultModels: { "claude-code": "haiku" } } },
  "empty global default is null": { driver: "claude-code", watcher: null, settings: { defaultModels: { "claude-code": "" } } },
});

type ChoiceWatcher = { driver: string | null; models?: ModelsMap } | null;
type ChoiceSettings = { defaultDriver: string; watcherDriver?: string | null };

const choiceSettings = { defaultDriver: "claude-code", watcherDriver: null as string | null };

export const watcherChoiceCases = cases(
  ({ watcher, settings }: { watcher: ChoiceWatcher; settings: ChoiceSettings }) =>
    watcherChoice(watcher as Pick<P.Watcher, "driver" | "models"> | null, settings as Pick<P.Settings, "defaultDriver" | "watcherDriver">),
  {
    "own driver and its model": { watcher: { driver: "codex", models: { codex: "luna", "claude-code": "opus" } }, settings: choiceSettings },
    "own driver without a model": { watcher: { driver: "codex", models: {} }, settings: choiceSettings },
    "own driver, models missing": { watcher: { driver: "codex" }, settings: choiceSettings },
    "own driver, empty model": { watcher: { driver: "codex", models: { codex: "" } }, settings: choiceSettings },
    "tools-set model for the default driver": { watcher: { driver: null, models: { "claude-code": "opus" } }, settings: choiceSettings },
    "model for another driver: Default": { watcher: { driver: null, models: { codex: "luna" } }, settings: choiceSettings },
    "model for the settings watcher driver": { watcher: { driver: null, models: { codex: "luna" } }, settings: { ...choiceSettings, watcherDriver: "codex" } },
    "no watcher: Default": { watcher: null, settings: { ...choiceSettings, watcherDriver: "codex" } },
    "no driver, no models: Default": { watcher: { driver: null }, settings: choiceSettings },
    "empty driver inherits": { watcher: { driver: "", models: { "claude-code": "opus" } }, settings: choiceSettings },
    "empty model for the default driver: Default": { watcher: { driver: null, models: { "claude-code": "" } }, settings: choiceSettings },
  },
);

type ReplaceInput = { current: ModelsMap | null; keep: TriageChoice };

export const replaceModelsCases = cases(({ current, keep }: ReplaceInput) => replaceModels(current ?? undefined, keep), {
  "keep one, clear the rest": { current: { codex: "luna", "claude-code": "sonnet" }, keep: { driver: "claude-code", model: "opus" } },
  "Default clears all": { current: { codex: "luna", "claude-code": "sonnet" }, keep: DEFAULT_TRIAGE_CHOICE },
  "no current map": { current: null, keep: { driver: "codex", model: null } },
  "no current map, Default": { current: null, keep: DEFAULT_TRIAGE_CHOICE },
  "kept driver's own default is an explicit null": { current: { codex: "luna" }, keep: { driver: "codex", model: null } },
  "existing nulls stay null": { current: { codex: null }, keep: { driver: "claude-code", model: "opus" } },
  "empty driver is not kept": { current: { codex: "luna" }, keep: { driver: "", model: "opus" } },
});

export const watcherChoiceBodyCases = cases(
  ({ choice, current }: { choice: TriageChoice; current: { models?: ModelsMap } | null }) =>
    watcherChoiceBody(choice, current as Pick<P.Watcher, "models"> | null),
  {
    "pin a driver, clear the others": { choice: { driver: "claude-code", model: "opus" }, current: { models: { codex: "luna", "claude-code": "sonnet" } } },
    "Default clears them all": { choice: DEFAULT_TRIAGE_CHOICE, current: { models: { codex: "luna", "claude-code": "sonnet" } } },
    "no current watcher": { choice: { driver: "codex", model: null }, current: null },
    "watcher without models": { choice: { driver: "codex", model: "luna" }, current: {} },
  },
);

type SettingsChoiceInput = { defaultDriver: string; watcherDriver?: string | null; watcherModels?: ModelsMap };

export const settingsWatcherChoiceCases = cases((s: SettingsChoiceInput) => settingsWatcherChoice(s as Pick<P.Settings, "defaultDriver" | "watcherDriver" | "watcherModels">), {
  "nothing set: Default": { defaultDriver: "claude-code", watcherDriver: null, watcherModels: {} },
  "model for the default driver": { defaultDriver: "claude-code", watcherDriver: null, watcherModels: { "claude-code": "sonnet" } },
  "watcher driver without a model": { defaultDriver: "claude-code", watcherDriver: "codex", watcherModels: {} },
  "watcher driver and model": { defaultDriver: "claude-code", watcherDriver: "codex", watcherModels: { codex: "luna", "claude-code": "sonnet" } },
  "model for another driver only: Default": { defaultDriver: "claude-code", watcherDriver: null, watcherModels: { codex: "luna" } },
  "no watcherModels field": { defaultDriver: "claude-code" },
  "empty watcher driver inherits": { defaultDriver: "claude-code", watcherDriver: "", watcherModels: { "claude-code": "sonnet" } },
  "null model entry": { defaultDriver: "claude-code", watcherDriver: null, watcherModels: { "claude-code": null } },
});

export const settingsWatcherChoicePatchCases = cases(
  ({ choice, watcherModels }: { choice: TriageChoice; watcherModels?: ModelsMap }) =>
    settingsWatcherChoicePatch(choice, { watcherModels } as Pick<P.Settings, "watcherModels">),
  {
    "pick replaces the old one": { choice: { driver: "codex", model: "luna" }, watcherModels: { "claude-code": "sonnet" } },
    "Default clears": { choice: DEFAULT_TRIAGE_CHOICE, watcherModels: { codex: "luna" } },
    "no stored map": { choice: { driver: "codex", model: null } },
  },
);

// The same helpers over decoded protocol entities, for the Watcher/Settings/PublicSettings overloads.
const [shellWatcher, legacyWatcher] = watcherSamples as [P.Watcher, P.Watcher];
const [fullSettings, plainSettings, noWatcherDriverSettings] = settingsSamples as [P.Settings, P.Settings, P.Settings];
const [fullPublic, plainPublic] = publicSettingsSamples as [P.PublicSettings, P.PublicSettings];

const entityWatchers: Record<string, P.Watcher | null> = {
  shell: shellWatcher,
  legacy: legacyWatcher,
  "legacy with a model for the default driver": { ...legacyWatcher, models: { "claude-code": "opus" } },
  none: null,
};
const entitySettings: Record<string, P.Settings> = { full: fullSettings, plain: plainSettings, "no watcher driver": noWatcherDriverSettings };

type EntityOutput = {
  commandLine: string | null;
  driver: string;
  model: string | null;
  choice: TriageChoice;
  settingsChoice: TriageChoice;
  body: Pick<P.WatcherBody, "driver" | "models">;
  patch: Pick<P.Settings, "watcherDriver" | "watcherModels">;
};

function entityOutputs(watcher: P.Watcher | null, settings: P.Settings | P.PublicSettings): EntityOutput {
  const driver = watcherDriver(watcher, settings);
  return {
    commandLine: watcher ? watcherCommandLine(watcher) : null,
    driver,
    model: watcherModel(driver, watcher, settings),
    choice: watcherChoice(watcher, settings),
    settingsChoice: settingsWatcherChoice(settings),
    body: watcherChoiceBody({ driver: "codex", model: "luna" }, watcher),
    patch: settingsWatcherChoicePatch(DEFAULT_TRIAGE_CHOICE, settings),
  };
}

export const watcherEntityCases = Object.entries(entityWatchers).flatMap(([wName, watcher]) =>
  Object.entries(entitySettings).map(([sName, settings]) => ({
    name: `${wName} watcher, ${sName} settings`,
    input: { watcher, settings },
    output: entityOutputs(watcher, settings),
  })),
);

export const watcherPublicSettingsEntityCases = [fullPublic, plainPublic].flatMap((settings, i) =>
  Object.entries(entityWatchers).map(([wName, watcher]) => ({
    name: `${wName} watcher, public settings ${i}`,
    input: { watcher, settings },
    output: entityOutputs(watcher, settings),
  })),
);
