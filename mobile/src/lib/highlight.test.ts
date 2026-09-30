import { describe, expect, test } from "bun:test";
import { THEMES } from "@harness/shared/themes";
import { codeLanguage } from "@harness/shared/state";
import { diffLines, diffTints, gitColors, hasLanguage, hasSyntaxTheme, highlight, highlightCached, MAX_HIGHLIGHT_CHARS, plainLines, reuseLines, type HighlightedLine } from "./highlight";

const colors = (l: HighlightedLine) => new Set(l.spans.map((s) => s.color).filter(Boolean));

describe("bundled themes and languages", () => {
  test("every app theme's syntaxTheme is bundled, so none falls back to Pierre's by accident", () => {
    const missing = THEMES.map((t) => t.syntaxTheme).filter((n): n is string => !!n && !hasSyntaxTheme(n));
    expect(missing).toEqual([]);
  });

  test("every bundled theme loads and colors code", async () => {
    for (const t of THEMES) {
      if (!t.syntaxTheme) continue;
      const r = await highlight("const a = 1", "typescript", t.syntaxTheme, { diff: false, appearance: t.appearance });
      expect(colors(r!.lines[0]!).size).toBeGreaterThan(1);
    }
  }, 60_000);

  test("every bundled language loads under its Shiki name", async () => {
    const langs = ["typescript", "tsx", "javascript", "jsx", "json", "jsonc", "shellscript", "shellsession", "yaml", "toml", "ini", "dotenv", "php", "blade", "ruby", "python", "go", "rust", "swift", "kotlin", "java", "c", "cpp", "csharp", "css", "scss", "html", "xml", "markdown", "sql", "graphql", "docker", "makefile"];
    for (const lang of langs) {
      expect(hasLanguage(lang)).toBe(true);
      expect(await highlight("x = 1", lang, "pierre-light", { diff: false, appearance: "light" })).not.toBeNull();
    }
  }, 60_000);

  test("the fence tags agents use resolve to bundled languages", () => {
    const tags = ["ts", "tsx", "js", "sh", "bash", "zsh", "yml", "yaml", "json", "php", "blade", "py", "rb", "md", "rs", "go", "kt", "swift", "cs", "htm", "css", "sql", "dockerfile", "makefile", "toml", "env", "console"];
    expect(tags.filter((t) => !hasLanguage(codeLanguage(t)))).toEqual([]);
  });
});

describe("highlight", () => {
  test("tokenizes with the theme's colors and default foreground", async () => {
    const r = await highlight('<?php\necho "hi";', "php", "pierre-dark", { diff: false, appearance: "dark" });
    expect(r!.lines).toHaveLength(2);
    expect(r!.lines[1]!.spans.map((s) => s.text).join("")).toBe('echo "hi";');
    expect(colors(r!.lines[1]!).size).toBeGreaterThan(1);
    expect(r!.fg).not.toBe("");
  });

  test("an unbundled language, an unknown theme or an oversized block stays plain", async () => {
    const opts = { diff: false, appearance: "light" as const };
    expect(await highlight("x", "cobol", "pierre-light", opts)).toBeNull();
    expect(await highlight("x", null, "pierre-light", opts)).toBeNull();
    expect(await highlight("x", "typescript", "no-such-theme", opts)).toBeNull();
    expect(await highlight("a".repeat(MAX_HIGHLIGHT_CHARS + 1), "typescript", "pierre-light", opts)).toBeNull();
  });

  test("a diff colors each file by its path and keeps line kinds", async () => {
    const code = ["--- a/app.rb", "+++ b/app.rb", "@@ -1 +1 @@", "-def old = 1", "+def new = 2"].join("\n");
    const r = await highlight(code, "diff", "pierre-light", { diff: true, appearance: "light" });
    expect(r!.lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add"]);
    // The sign is its own span; the Ruby after it has several colors.
    expect(r!.lines[4]!.spans[0]).toEqual({ text: "+" });
    expect(colors(r!.lines[4]!).size).toBeGreaterThan(1);
  });

  test("memoized per input: the same result comes back, different code gets its own", async () => {
    const opts = { diff: false, appearance: "light" as const };
    const a = await highlightCached("let memo = 1", "typescript", "one-light", opts);
    expect(await highlightCached("let memo = 1", "typescript", "one-light", opts)).toBe(a);
    expect(await highlightCached("let memo = 2", "typescript", "one-light", opts)).not.toBe(a);
    expect(await highlightCached("let memo = 1", "typescript", "pierre-light", opts)).not.toBe(a);
  });
});

describe("diffLines", () => {
  const tokenize = (code: string, lang: string) => code.split("\n").map((text) => [{ text, color: `${lang}:${text}` }]);

  test("old-side lines take tokens from the old file, new and context lines from the new one", () => {
    const code = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", " same", "-before", "+after"].join("\n");
    const seen: string[] = [];
    const out = diffLines(code, (src, lang) => (seen.push(src), tokenize(src, lang)), null);
    // Old side: context + removed; new side: context + added, each tokenized as one file.
    expect(seen).toEqual(["same\nbefore", "same\nafter"]);
    expect(out[4]!.spans).toEqual([{ text: "-" }, { text: "before", color: "typescript:before" }]);
    expect(out[5]!.spans).toEqual([{ text: "+" }, { text: "after", color: "typescript:after" }]);
    expect(out[3]!.spans[1]!.color).toBe("typescript:same");
  });

  test("the fence's language covers a diff without paths; with neither, lines stay plain", () => {
    expect(diffLines("-a\n+b", tokenize, "php")[1]!.spans[1]!.color).toBe("php:b");
    expect(diffLines("-a\n+b", tokenize, null)[1]!.spans).toEqual([{ text: "+" }, { text: "b" }]);
  });
});

describe("git colors and tints", () => {
  test("picks gitDecoration colors, then the terminal's, then Pierre's defaults", () => {
    expect(gitColors({ "gitDecoration.addedResourceForeground": "#00ff00", "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#ff0000" }, "light")).toEqual({ added: "#00ff00", deleted: "#ff0000" });
    expect(gitColors(undefined, "dark")).toEqual({ added: "#5ecc71", deleted: "#ff6762" });
  });

  test("dark themes mix in more of the git color than light ones", () => {
    const git = { added: "#00ff00", deleted: "#ff0000" };
    const light = diffTints("#000000", git, "light");
    const dark = diffTints("#000000", git, "dark");
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16);
    expect(green(light.add)).toBeGreaterThan(0);
    expect(green(dark.add)).toBeGreaterThan(green(light.add));
    expect(green(dark.del)).toBe(0);
  });
});

describe("reuseLines", () => {
  test("keeps the colored version of unchanged lines only", () => {
    const prev: HighlightedLine[] = [
      { spans: [{ text: "a", color: "#1" }] },
      { spans: [{ text: "b", color: "#2" }] },
    ];
    const out = reuseLines(plainLines("a\nbc\nd", false), prev);
    expect(out[0]).toBe(prev[0]!);
    expect(out[1]!.spans).toEqual([{ text: "bc" }]);
    expect(out[2]!.spans).toEqual([{ text: "d" }]);
  });

  test("a diff line whose kind changed isn't reused even when its text matches", () => {
    const prev: HighlightedLine[] = [{ kind: "ctx", spans: [{ text: "-" }, { text: "x", color: "#1" }] }];
    const plain: HighlightedLine[] = [{ kind: "del", spans: [{ text: "-" }, { text: "x" }] }];
    expect(reuseLines(plain, prev)[0]).toBe(plain[0]!);
  });
});
