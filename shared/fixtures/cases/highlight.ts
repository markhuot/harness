// Syntax highlighting (mobile/src/lib/highlight.ts) for the native app's HarnessHighlight target.
// `highlightCases` runs the RN app's real highlight() over a corpus, and HighlighterTests checks
// that the JavaScriptCore bundle (ios/Tools/build-highlighter.ts) returns the same tokens and
// colors. The pure helpers (gitColors, diffTints, plainLines, reuseLines) are ported to Swift and
// checked against their TS outputs here. Highlight outputs go through wellFormed() exactly as the
// bundle's do (ios/Tools/highlighter/wellFormed.ts).

import { diffTints, gitColors, highlight, LANGUAGE_IDS, MAX_HIGHLIGHT_CHARS, plainLines, reuseLines, SYNTAX_THEME_IDS, type HighlightedLine } from "../../../mobile/src/lib/highlight";
import { wellFormed, wellFormedLines } from "../../../ios/Tools/highlighter/wellFormed";
import type { ThemeAppearance } from "../../src/themes";
import { asyncCases, cases } from "../case";

export const languages = LANGUAGE_IDS;
export const syntaxThemes = SYNTAX_THEME_IDS;
export const maxChars = MAX_HIGHLIGHT_CHARS;

interface HighlightInput {
  /** The block, or `repeat` × `times` for inputs too big to write out */
  code?: string;
  repeat?: string;
  times?: number;
  lang: string | null;
  theme: string;
  diff: boolean;
  appearance: ThemeAppearance;
}

const codeOf = (i: { code?: string; repeat?: string; times?: number }) => i.code ?? (i.repeat ?? "").repeat(i.times ?? 0);

const TS = 'import { a } from "./a";\n\n/** Doc comment */\nexport const greet = (name: string): string => `hi ${name}`;\nlet n = 42; // trailing';
const SWIFT = 'struct Point: Equatable {\n    var x = 0.5\n    /* block\n       comment */\n    func moved(by d: Double) -> Point { Point(x: x + d) }\n}\nlet s = """\nmulti\n"""';
const PHP = '<?php\nnamespace App;\n\nclass User extends Model {\n    protected $fillable = [\'name\'];\n    public function greet(): string { return "Hi {$this->name}"; }\n}\n?>\n<div class="x"><?= $user->name ?></div>';
const PY = 'def fib(n: int) -> int:\n    """Docstring\n    spans lines"""\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n\n@decorator\nclass A: pass';
const RUST = 'fn main() {\n    let v: Vec<u8> = vec![1, 2];\n    println!("{:?}", v);\n}';
const SH = '#!/bin/bash\nset -euo pipefail\nfor f in *.ts; do echo "$f" | grep -v test; done';
const JSON_SRC = '{\n  "name": "harness",\n  "n": 1.5,\n  "ok": true,\n  "list": [null]\n}';
const MD = '# Title\n\nSome *em* and **strong** with `code`.\n\n```ts\nconst x = 1\n```';
const MAKE = 'all: build\n\nbuild:\n\t@echo "building $(NAME)"';
const UNICODE = 'const café = "naïve 👋🏽 é"; // ünïcödé\nlet 𝒳 = 1';

const RB_DIFF = ["--- a/app.rb", "+++ b/app.rb", "@@ -1 +1 @@", "-def old = 1", "+def new = 2"].join("\n");
const MULTI_DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "index 1234..5678 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,4 +1,4 @@",
  " /* a comment",
  "-   old text */",
  "+   new text */",
  " const a = 1;",
  "diff --git a/App.swift b/App.swift",
  "--- a/App.swift",
  "+++ b/App.swift",
  "@@ -1,2 +1,2 @@",
  '-let s = "old"',
  '+let s = "new"',
  " // end",
  "\\ No newline at end of file",
].join("\n");
const BARE_DIFF = "-a = 1\n+b = 2\n c = 3";
const EMOJI_DIFF = "@@ -1,2 +1,2 @@\n👋 hello\n-x = 1\n+x = 2";
const CRLF_DIFF = "--- a/x.py\r\n+++ b/x.py\r\n@@ -1 +1 @@\r\n-x = 1\r\n+x = 2";

const opts = (theme: string, appearance: ThemeAppearance) => ({ theme, appearance, diff: false });

const HIGHLIGHT_INPUTS: Record<string, HighlightInput> = {
  "typescript, pierre-light": { code: TS, lang: "typescript", ...opts("pierre-light", "light") },
  "typescript, pierre-dark": { code: TS, lang: "typescript", ...opts("pierre-dark", "dark") },
  "tsx, one-dark-pro": { code: "const A = () => <div className=\"a\">{x}</div>;", lang: "tsx", ...opts("one-dark-pro", "dark") },
  "swift, github-light-default": { code: SWIFT, lang: "swift", ...opts("github-light-default", "light") },
  "swift, github-dark-default": { code: SWIFT, lang: "swift", ...opts("github-dark-default", "dark") },
  "php with embedded html, catppuccin-latte": { code: PHP, lang: "php", ...opts("catppuccin-latte", "light") },
  "python, catppuccin-mocha (italics)": { code: PY, lang: "python", ...opts("catppuccin-mocha", "dark") },
  "rust, dracula": { code: RUST, lang: "rust", ...opts("dracula", "dark") },
  "shellscript, solarized-light": { code: SH, lang: "shellscript", ...opts("solarized-light", "light") },
  "json, nord": { code: JSON_SRC, lang: "json", ...opts("nord", "dark") },
  "markdown with a fence, rose-pine-dawn": { code: MD, lang: "markdown", ...opts("rose-pine-dawn", "light") },
  "makefile (Shiki name make), tokyo-night": { code: MAKE, lang: "makefile", ...opts("tokyo-night", "dark") },
  "unicode and emoji, one-light": { code: UNICODE, lang: "typescript", ...opts("one-light", "light") },
  "crlf line endings": { code: "let a = 1\r\nlet b = 2\r\n", lang: "typescript", ...opts("pierre-light", "light") },
  "empty block": { code: "", lang: "typescript", ...opts("pierre-light", "light") },
  "trailing newline": { code: "x = 1\n", lang: "python", ...opts("pierre-dark", "dark") },
  "unbundled language": { code: "IDENTIFICATION DIVISION.", lang: "cobol", ...opts("pierre-light", "light") },
  "no language": { code: "plain", lang: null, ...opts("pierre-light", "light") },
  "the diff language without diff: plain": { code: "-a\n+b", lang: "diff", ...opts("pierre-light", "light") },
  "unknown theme": { code: "let a = 1", lang: "typescript", ...opts("no-such-theme", "light") },
  "exactly the size limit": { repeat: "a", times: MAX_HIGHLIGHT_CHARS, lang: "python", ...opts("pierre-light", "light") },
  "one past the size limit": { repeat: "a", times: MAX_HIGHLIGHT_CHARS + 1, lang: "python", ...opts("pierre-light", "light") },
  "diff: ruby by path, light": { code: RB_DIFF, lang: "diff", theme: "pierre-light", appearance: "light", diff: true },
  "diff: ruby by path, dark": { code: RB_DIFF, lang: "diff", theme: "pierre-dark", appearance: "dark", diff: true },
  "diff: two files in two languages, comment spanning lines": { code: MULTI_DIFF, lang: "diff", theme: "github-dark-default", appearance: "dark", diff: true },
  "diff: no paths, fence language": { code: BARE_DIFF, lang: "python", theme: "one-light", appearance: "light", diff: true },
  "diff: no paths, no language": { code: BARE_DIFF, lang: null, theme: "one-light", appearance: "light", diff: true },
  "diff: context line starting with an emoji": { code: EMOJI_DIFF, lang: "python", theme: "pierre-light", appearance: "light", diff: true },
  "diff: crlf": { code: CRLF_DIFF, lang: "diff", theme: "gruvbox-dark-medium", appearance: "dark", diff: true },
};

export const highlightCases = asyncCases(async (i: HighlightInput) => wellFormed(await highlight(codeOf(i), i.lang, i.theme, { diff: i.diff, appearance: i.appearance })), HIGHLIGHT_INPUTS);

type Colors = Record<string, string> | null;
export const gitColorsCases = cases(
  ({ colors, appearance }: { colors: Colors; appearance: ThemeAppearance }) => gitColors(colors ?? undefined, appearance),
  {
    "gitDecoration wins": { colors: { "gitDecoration.addedResourceForeground": "#00ff00", "gitDecoration.deletedResourceForeground": "#ff00ff", "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#ff0000" }, appearance: "light" },
    "mixed sources": { colors: { "gitDecoration.addedResourceForeground": "#00ff00", "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#ff0000" }, appearance: "light" },
    "terminal colors": { colors: { "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#222222" }, appearance: "dark" },
    "no colors, light": { colors: null, appearance: "light" },
    "no colors, dark": { colors: null, appearance: "dark" },
    "empty colors, dark": { colors: {}, appearance: "dark" },
  },
);

export const diffTintsCases = cases(
  ({ bg, added, deleted, appearance }: { bg: string; added: string; deleted: string; appearance: ThemeAppearance }) => diffTints(bg, { added, deleted }, appearance),
  {
    "black, light": { bg: "#000000", added: "#00ff00", deleted: "#ff0000", appearance: "light" },
    "black, dark": { bg: "#000000", added: "#00ff00", deleted: "#ff0000", appearance: "dark" },
    "pierre light on white": { bg: "#ffffff", added: "#0dbe4e", deleted: "#ff6762", appearance: "light" },
    "pierre dark on a dark sunken bg": { bg: "#141415", added: "#5ecc71", deleted: "#ff6762", appearance: "dark" },
    "short hex and rgb()": { bg: "#fff", added: "rgb(26, 127, 55)", deleted: "#cf222e", appearance: "light" },
    "rounding halves": { bg: "#010203", added: "#fefdfc", deleted: "#808080", appearance: "dark" },
  },
);

const PLAIN_INPUTS: Record<string, { code: string; diff: boolean }> = {
  "code lines": { code: "a\nbc\n\nd", diff: false },
  "code with crlf keeps the \\r": { code: "a\r\nb", diff: false },
  "empty code": { code: "", diff: false },
  "diff kinds and signs": { code: RB_DIFF, diff: true },
  "multi-file git diff": { code: MULTI_DIFF, diff: true },
  "bare diff": { code: BARE_DIFF, diff: true },
  "emoji context line": { code: EMOJI_DIFF, diff: true },
  "crlf diff": { code: CRLF_DIFF, diff: true },
  "dashes inside a hunk are code": { code: "@@ -1,2 +1,2 @@\n--- not a header\n+++ nor this\n ctx", diff: true },
  "hunk without counts": { code: "@@ edits @@\n-a\n+b\n", diff: true },
  "header lines": { code: "new file mode 100644\nBinary files a/x and b/x differ\nsimilarity index 90%\nrename from a\nrename to b", diff: true },
  "empty diff": { code: "", diff: true },
};
export const plainLinesCases = cases(({ code, diff }: { code: string; diff: boolean }) => wellFormedLines(plainLines(code, diff)), PLAIN_INPUTS);

interface ReuseInput {
  plain: HighlightedLine[];
  prev: HighlightedLine[] | null;
}
const colored = (text: string, color: string, kind?: HighlightedLine["kind"]): HighlightedLine => ({ ...(kind ? { kind } : {}), spans: [{ text, color }] });
export const reuseLinesCases = cases(({ plain, prev }: ReuseInput) => reuseLines(plain, prev), {
  "no previous lines": { plain: plainLines("a\nb", false), prev: null },
  "unchanged lines keep their colors, changed and new ones stay plain": { plain: plainLines("a\nbc\nd", false), prev: [colored("a", "#1"), colored("b", "#2")] },
  "text split across spans still matches": { plain: plainLines("ab", false), prev: [{ spans: [{ text: "a", color: "#1" }, { text: "b", color: "#2", fontStyle: 2 }] }] },
  "a kind change isn't reused": { plain: [{ kind: "del", spans: [{ text: "-" }, { text: "x" }] }], prev: [{ kind: "ctx", spans: [{ text: "-" }, { text: "x", color: "#1" }] }] },
  "same kind and text is reused": { plain: [{ kind: "add", spans: [{ text: "+" }, { text: "x" }] }], prev: [{ kind: "add", spans: [{ text: "+" }, { text: "x", color: "#1" }] }] },
  "kindless previous vs a diff line": { plain: [{ kind: "ctx", spans: [{ text: " " }, { text: "x" }] }], prev: [colored(" x", "#1")] },
  "longer previous block": { plain: plainLines("a", false), prev: [colored("a", "#1"), colored("b", "#2")] },
});
