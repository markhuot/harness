// Fenced code in agent messages (shared/src/state/code.ts) for HarnessKit's Code.swift.
import { codeKind, codeLanguage, looksLikeDiff, normalizePatch } from "../../src/state/code";
import { cases } from "../case";

export const codeLanguageCases = cases(codeLanguage, {
  // code.test.ts
  ts: "ts",
  "upper-case JS": "JS",
  zsh: "zsh",
  bash: "bash",
  yml: "yml",
  "padded php": " php ",
  empty: "",
  txt: "txt",
  patch: "patch",
  // more aliases
  "c#": "c#",
  "c++": "c++",
  mdx: "mdx",
  console: "console",
  dockerfile: "Dockerfile",
  "unknown passes through lowercased": "Haskell",
  "only whitespace": " \t\n ",
  "NBSP trims": " ts ",
  "NEL does not trim": "\u0085ts",
  "inner space kept": "ts x",
  "unicode lowercases": "ÜBER",
});

export const looksLikeDiffCases = cases(looksLikeDiff, {
  // code.test.ts
  "markdown list": "- one\n- two\n+ three",
  "heading underline": "--- a heading underline\nnot a +++ line",
  "bare @@ prose": "@@ not a hunk @@",
  // more
  "real hunk": "@@ -1,2 +1,2 @@\n-a\n+b",
  "hunk without counts": "@@ -1 +1 @@",
  "hunk with context": "@@ -10,3 +10,4 @@ function f() {",
  "hunk missing space": "@@ -1,2 +1,2@@",
  "hunk later in the text": "intro\n\n@@ -3 +3 @@\n-x",
  "header pair": "--- a/x.ts\n+++ b/x.ts",
  "header pair with CRLF": "--- a/x.ts\r\n+++ b/x.ts",
  "--- last line": "text\n--- a/x",
  "diff --git": "diff --git a/x b/x",
  "diff --git without trailing space": "diff --git",
  "+++ before ---": "+++ b/x\n--- a/x",
  empty: "",
  "hunk with leading space": " @@ -1 +1 @@",
});

export const codeKindCases = cases(({ fence, text }: { fence: string; text: string }) => codeKind(fence, text), {
  // code.test.ts
  "diff fence": { fence: "diff", text: "just words" },
  "patch fence": { fence: "patch", text: "+a" },
  "untagged hunk": { fence: "", text: "@@ -1,2 +1,2 @@\n-a\n+b" },
  "untagged header pair": { fence: "", text: "--- a/x.ts\n+++ b/x.ts\n-a\n+b" },
  "untagged diff --git": { fence: "", text: "diff --git a/x b/x\nindex 1..2" },
  "tagged language wins": { fence: "ts", text: "@@ -1,2 +1,2 @@\n-a\n+b" },
  // more
  "udiff fence": { fence: "UDIFF", text: "" },
  "whitespace fence is untagged": { fence: "  ", text: "@@ -1 +1 @@" },
  "untagged prose": { fence: "", text: "hello\n- world" },
  "text fence": { fence: "text", text: "@@ -1 +1 @@" },
});

type PatchInput = { text: string; name?: string };
const patch = ({ text, name }: PatchInput) => normalizePatch(text, name);

export const normalizePatchCases = cases(patch, {
  // code.test.ts
  "bare snippet": { text: "-old\n+new\n+more\n same" },
  "miscounted and bare hunks": { text: "@@ -10,9 +10,1 @@ function f() {\n a\n-b\n+c\n@@ @@\n-x\n+y\n+z", name: "f.php" },
  "context without leading space": { text: "@@ -1,1 +1,1 @@\nkeep\n\n-a\n+b" },
  "multi-file": {
    text: [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -5,3 +5,3 @@",
      "-x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ @@",
      "+new",
      "--- /dev/null",
      "+++ b/c.yml",
      "@@ -0,0 +1 @@",
      "+c: 1",
    ].join("\n"),
  },
  // headers and names
  "CRLF and trailing newlines": { text: "-a\r\n+b\r\n\r\n\n" },
  "empty text": { text: "" },
  "only newlines": { text: "\n\n" },
  "custom name": { text: "+x", name: "notes.md" },
  "header pair without diff --git": { text: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b" },
  "header with timestamps": { text: "--- a/x.ts\t2024-01-01 10:00\n+++ b/x.ts\t2024-01-02 10:00\n@@ -1 +1 @@\n-a\n+b" },
  "deleted file named by old path": { text: "--- a/gone.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x" },
  "both /dev/null uses the name": { text: "--- /dev/null\n+++ /dev/null\n@@ @@\n+x", name: "n.txt" },
  "paths without a/ b/": { text: "--- old.txt\n+++ new.txt\n@@ @@\n-a\n+b" },
  "commit message before the header kept": { text: "commit abc\nAuthor: me\n\n--- a/x\n+++ b/x\n@@ @@\n-a\n+b" },
  "lines before the first hunk under a header": { text: "--- a/x\n+++ b/x\nstray\n-a" },
  "lines before a hunk in a headerless snippet": { text: " a\n-b\n@@ -9 +9 @@\n-c\n+d" },
  // hunk headers
  "loose hunk with start only": { text: "@@ -4 +7 @@\n a\n-b" },
  "loose hunk without minus": { text: "@@ 4 7 @@\n a" },
  "loose hunk with only new start": { text: "@@ +7 @@\n+a" },
  "loose hunk with only old start": { text: "@@ -7 @@\n-a" },
  "loose hunk without spaces": { text: "@@-3+5@@\n-a" },
  "loose hunk keeps context text": { text: "@@ @@ class Foo\n+a" },
  "hunk header with extra spaces": { text: "@@   -2,1   +2,1   @@\n-a\n+b" },
  "hunk with tabs": { text: "@@\t-2\t+3\t@@\n-a" },
  "not a hunk: trailing junk in counts": { text: "@@ -1,2,3 +1 @@\n-a" },
  "not a hunk: letters": { text: "@@ abc @@\n-a" },
  "empty hunk then another": { text: "@@ -1 +1 @@\n@@ @@\n+a" },
  "leading zeros": { text: "@@ -007,1 +010,1 @@\n-a\n+b" },
  "lone CR in hunk context is not a hunk": { text: "@@ @@ x\ry\n+a" },
  "U+2028 in hunk context is not a hunk": { text: "@@ @@ x y\n+a" },
  // bodies
  "no newline marker is not counted": { text: "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file" },
  "blank lines become context": { text: "@@ @@\n-a\n\n+b" },
  "dashes inside a hunk start a new file": { text: "--- a/x\n+++ b/x\n@@ @@\n---\n+++ y\n-a" },
  "two files restart numbering": { text: "--- a/x\n+++ b/x\n@@ -5 +5 @@\n-a\n--- a/y\n+++ b/y\n@@ @@\n-b" },
  "next hunk continues from the previous": { text: "@@ -1 +1 @@\n a\n a\n-b\n@@ @@\n c" },
  "emoji and combining marks": { text: "@@ @@\n-café\n+café 😀\n ü" },
});
