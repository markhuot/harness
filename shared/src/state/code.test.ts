import { expect, test } from "bun:test";
import { codeKind, codeLanguage, looksLikeDiff, normalizePatch } from "./code";

test("fence names map to Shiki languages; unknown names pass through, empty is plain text", () => {
  expect(codeLanguage("ts")).toBe("typescript");
  expect(codeLanguage("JS")).toBe("javascript");
  expect(codeLanguage("zsh")).toBe("shellscript");
  expect(codeLanguage("bash")).toBe("shellscript");
  expect(codeLanguage("yml")).toBe("yaml");
  expect(codeLanguage(" php ")).toBe("php");
  expect(codeLanguage("")).toBe("text");
  expect(codeLanguage("txt")).toBe("text");
  expect(codeLanguage("patch")).toBe("diff");
});

test("diff detection: tagged fences, hunk headers and file headers; not lists or prose with dashes", () => {
  expect(codeKind("diff", "just words")).toBe("diff");
  expect(codeKind("patch", "+a")).toBe("diff");
  expect(codeKind("", "@@ -1,2 +1,2 @@\n-a\n+b")).toBe("diff");
  expect(codeKind("", "--- a/x.ts\n+++ b/x.ts\n-a\n+b")).toBe("diff");
  expect(codeKind("", "diff --git a/x b/x\nindex 1..2")).toBe("diff");
  // A tagged language wins even when the body is diff-shaped.
  expect(codeKind("ts", "@@ -1,2 +1,2 @@\n-a\n+b")).toBe("code");
  expect(looksLikeDiff("- one\n- two\n+ three")).toBe(false);
  expect(looksLikeDiff("--- a heading underline\nnot a +++ line")).toBe(false);
  expect(looksLikeDiff("@@ not a hunk @@")).toBe(false);
});

test("a bare +/- snippet gets file and hunk headers counted from its lines", () => {
  expect(normalizePatch("-old\n+new\n+more\n same")).toBe("diff --git a/snippet b/snippet\n--- a/snippet\n+++ b/snippet\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same\n");
});

test("miscounted and bare hunk headers are recounted; later hunks continue numbering", () => {
  const src = "@@ -10,9 +10,1 @@ function f() {\n a\n-b\n+c\n@@ @@\n-x\n+y\n+z";
  expect(normalizePatch(src, "f.php")).toBe(
    "diff --git a/f.php b/f.php\n--- a/f.php\n+++ b/f.php\n@@ -10,2 +10,2 @@ function f() {\n a\n-b\n+c\n@@ -12,1 +12,2 @@\n-x\n+y\n+z\n",
  );
});

test("context lines without their leading space (and blank ones) count as context", () => {
  expect(normalizePatch("@@ -1,1 +1,1 @@\nkeep\n\n-a\n+b")).toBe("diff --git a/snippet b/snippet\n--- a/snippet\n+++ b/snippet\n@@ -1,3 +1,3 @@\n keep\n \n-a\n+b\n");
});

test("multi-file patches keep their headers, gain a diff --git line where missing, and restart numbering per file", () => {
  const src = [
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
  ].join("\n");
  expect(normalizePatch(src).split("\n")).toEqual([
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -5,1 +5,1 @@",
    "-x",
    "+y",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,0 +1,1 @@",
    "+new",
    "diff --git a/c.yml b/c.yml",
    "--- /dev/null",
    "+++ b/c.yml",
    "@@ -0,0 +1,1 @@",
    "+c: 1",
    "",
  ]);
});
