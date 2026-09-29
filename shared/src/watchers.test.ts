import { describe, expect, test } from "bun:test";
import { outputTitle, OUTPUT_TITLE_MAX, shellQuote, watcherCommandLine, watcherDriver, watcherModel } from "./watchers";

describe("watcherCommandLine", () => {
  test("a shell watcher's command is used as is", () => {
    expect(watcherCommandLine({ command: "while true; do curl -s x; sleep 60; done", args: [] })).toBe("while true; do curl -s x; sleep 60; done");
  });

  test("legacy command + args are quoted only where needed", () => {
    expect(watcherCommandLine({ command: "node", args: ["~/Sites/Jira/watch-jira.js", "--project", "FOO BAR", "it's"] })).toBe(
      "node ~/Sites/Jira/watch-jira.js --project 'FOO BAR' 'it'\\''s'",
    );
  });

  test("empty and shell-special words are quoted", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a|b")).toBe("'a|b'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
  });
});

describe("outputTitle", () => {
  test("uses the first non-blank line, whitespace collapsed", () => {
    expect(outputTitle("\n\n   Build   failed on main \nsecond line")).toBe("Build failed on main");
  });

  test("cuts long lines with an ellipsis at the limit", () => {
    const t = outputTitle("x".repeat(200));
    expect(t.length).toBe(OUTPUT_TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(outputTitle("y".repeat(OUTPUT_TITLE_MAX))).toBe("y".repeat(OUTPUT_TITLE_MAX));
  });

  test("skips lines with nothing readable, like an opening brace", () => {
    expect(outputTitle('{\n  "summary": "Fix login"\n}')).toBe('"summary": "Fix login"');
  });

  test("blank output gets a placeholder", () => {
    expect(outputTitle("  \n\t")).toBe("Watcher output");
  });
});

describe("watcherDriver / watcherModel", () => {
  const settings = { defaultDriver: "claude-code", watcherDriver: null, defaultModels: { "claude-code": "haiku" }, watcherModels: {} as Record<string, string | null> };

  test("the watcher's driver wins, then settings.watcherDriver, then the default driver", () => {
    expect(watcherDriver({ driver: "anthropic-api" }, { ...settings, watcherDriver: "dummy" })).toBe("anthropic-api");
    expect(watcherDriver({ driver: null }, { ...settings, watcherDriver: "dummy" })).toBe("dummy");
    expect(watcherDriver({ driver: null }, settings)).toBe("claude-code");
    expect(watcherDriver(null, { defaultDriver: "claude-code" })).toBe("claude-code");
  });

  test("model precedence: watcher, then watcher default, then global default, then null", () => {
    const s = { ...settings, watcherModels: { "claude-code": "sonnet" } };
    expect(watcherModel("claude-code", { models: { "claude-code": "opus" } }, s)).toBe("opus");
    expect(watcherModel("claude-code", { models: {} }, s)).toBe("sonnet");
    expect(watcherModel("claude-code", null, settings)).toBe("haiku");
    expect(watcherModel("anthropic-api", { models: { "claude-code": "opus" } }, s)).toBeNull();
  });
});
