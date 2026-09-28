import { describe, expect, test } from "bun:test";
import { outputTitle, OUTPUT_TITLE_MAX, shellQuote, watcherCommandLine } from "./watchers";

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

  test("blank output gets a placeholder", () => {
    expect(outputTitle("  \n\t")).toBe("Watcher output");
  });
});
