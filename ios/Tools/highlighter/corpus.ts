// The highlight corpus for the native app's parity fixtures (shared/fixtures/cases/highlight.ts):
// a few languages in light and dark themes, diffs, an unknown language, the size limit.

import { MAX_HIGHLIGHT_CHARS } from "./highlight";
import type { ThemeAppearance } from "../../../shared/src/themes";

export interface HighlightInput {
  /** The block, or `repeat` × `times` for inputs too big to write out */
  code?: string;
  repeat?: string;
  times?: number;
  lang: string | null;
  theme: string;
  diff: boolean;
  appearance: ThemeAppearance;
}

export const codeOf = (i: { code?: string; repeat?: string; times?: number }) => i.code ?? (i.repeat ?? "").repeat(i.times ?? 0);

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

export const RB_DIFF = ["--- a/app.rb", "+++ b/app.rb", "@@ -1 +1 @@", "-def old = 1", "+def new = 2"].join("\n");
export const MULTI_DIFF = [
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
export const BARE_DIFF = "-a = 1\n+b = 2\n c = 3";
export const EMOJI_DIFF = "@@ -1,2 +1,2 @@\n👋 hello\n-x = 1\n+x = 2";
export const CRLF_DIFF = "--- a/x.py\r\n+++ b/x.py\r\n@@ -1 +1 @@\r\n-x = 1\r\n+x = 2";

const opts = (theme: string, appearance: ThemeAppearance) => ({ theme, appearance, diff: false });

export const HIGHLIGHT_INPUTS: Record<string, HighlightInput> = {
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
