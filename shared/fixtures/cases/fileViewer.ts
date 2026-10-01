// The file viewer's pure parts (mobile/src/lib/fileViewer.ts) for HarnessKit's FileViewer.swift.
import { fileLines, fileRouteFor, fileScreenHref, type FileLinkContext, formatSize, highlightWindow, initialScrollIndex, patchRows, readFileParams, triageLinkContext } from "../../../mobile/src/lib/fileViewer";
import { type FileLink, formatFileLink, parseFileLink } from "../../src/fileLinks";
import { cases } from "../case";

const link = (url: string) => parseFileLink(url)!;

type RouteInput = { link: FileLink; ctx?: FileLinkContext };

export const fileRouteForCases = cases(({ link, ctx }: RouteInput) => fileRouteFor(link, ctx), {
  // fileViewer.test.ts
  "relative link in the markdown's ticket": { link: link("harness://file/src/app.ts#L10-L20"), ctx: { ticketKey: "HARNESS-1", projectId: "p1" } },
  "one line": { link: link("src/app.ts#L7"), ctx: { ticketKey: "HARNESS-1" } },
  "link's ticket wins": { link: link("harness://file/a.ts?ticket=OTHER-2"), ctx: { ticketKey: "HARNESS-1" } },
  "link's project wins": { link: link("harness://file/a.ts?project=p9"), ctx: { ticketKey: "HARNESS-1" } },
  "context project": { link: link("a.ts"), ctx: { projectId: "p1" } },
  "no root": { link: link("a.ts"), ctx: {} },
  "absolute path passes through": { link: link("/Users/me/site/a.ts#L3"), ctx: { ticketKey: "K-1" } },
  "triage context project": { link: link("src/app.ts#L3"), ctx: triageLinkContext("GREET-4", { projectId: "p1" }) },
  "triage context empty": { link: link("src/app.ts"), ctx: triageLinkContext(undefined, undefined) },
  // more
  "no context at all": { link: link("a.ts") },
  "link's ticket over its project": { link: link("harness://file/a.ts?project=p&ticket=T-1"), ctx: { projectId: "q" } },
  "link's project over context ticket": { link: link("harness://file/a.ts?project=p"), ctx: { ticketKey: "T-1", projectId: "q" } },
  "empty context ticket falls to project": { link: link("a.ts"), ctx: { ticketKey: "", projectId: "p" } },
  "empty context project is no root": { link: link("a.ts"), ctx: { projectId: "" } },
  "end without start is dropped": { link: { path: "a.ts", endLine: 4, absolute: false }, ctx: { ticketKey: "K" } },
  "start zero is no range": { link: { path: "a.ts", startLine: 0, endLine: 4, absolute: false }, ctx: { ticketKey: "K" } },
  "end zero is dropped": { link: { path: "a.ts", startLine: 3, endLine: 0, absolute: false }, ctx: { ticketKey: "K" } },
  "empty link ticket falls back": { link: { path: "a.ts", ticketKey: "", projectId: "lp", absolute: false }, ctx: { ticketKey: "K" } },
});

/**
 * fileScreenHref's rewrite of an OS-level harness://file URL, read back into its params (the
 * Swift side builds the params struct rather than an expo-router href). Null when it's left alone.
 */
function screenParams(url: string): Record<string, string> | null {
  const href = fileScreenHref(url);
  if (href === null) return null;
  return Object.fromEntries(
    href
      .slice("/file?".length)
      .split("&")
      .map((kv) => kv.split("=").map(decodeURIComponent) as [string, string]),
  );
}

export const fileRouteForURLCases = cases(screenParams, {
  // fileViewer.test.ts
  "keeps the range and ticket": formatFileLink({ path: "src/a b.ts", startLine: 4, endLine: 9, ticketKey: "HARNESS-3" }),
  "upper-case prefix with project": "HARNESS://FILE/x.ts?project=p1",
  "no ticket or project still opens": "harness://file/x.ts#L2",
  "pair link": "harness://pair?url=http%3A%2F%2Fh&token=t",
  "settings link": "harness://settings?theme=dark",
  "ticket link": "harness://ticket/K-1?tab=transcript",
  "empty path": "harness://file/",
  "escaping the root": "harness://file/../etc/passwd",
  "reversed range": "harness://file/src/app.ts?ticket=K-1#L5-L2",
  // more
  "relative path is not an OS link": "src/app.ts#L3",
  "absolute path": "harness://file//Users/me/a.ts#L1-L2",
  "unicode path": "harness://file/%C3%BCber.ts",
  "mixed-case prefix": "Harness://File/a.ts?ticket=K-9#L3",
  "empty string": "",
  "short string": "harness://fil",
});

export const triageLinkContextCases = cases(
  ({ key, dispatched }: { key?: string; dispatched?: { projectId: string } }) => triageLinkContext(key, dispatched),
  {
    "dispatched and loaded": { key: "GREET-4", dispatched: { projectId: "p1" } },
    "not loaded": { key: "GREET-4" },
    "nothing dispatched": {},
    "empty key": { key: "" },
    "loaded without key": { dispatched: { projectId: "p2" } },
  },
);

export const readFileParamsCases = cases(readFileParams, {
  // fileViewer.test.ts
  "no path": { ticket: "K-1" },
  "empty path": { path: "", ticket: "K-1" },
  "ticket over project": { path: "a", ticket: "K-1", project: "p" },
  project: { path: "a", project: "p" },
  "no root": { path: "a" },
  "single line": { path: "a", start: "7" },
  reversed: { path: "a", start: "9", end: "3" },
  "start zero": { path: "a", start: "0" },
  "junk start": { path: "a", start: "x", end: "4" },
  "fractional start": { path: "a", start: "2.5" },
  "junk end": { path: "a", start: "4", end: "nope" },
  arrays: { path: ["a.ts", "b.ts"], ticket: ["K-1"] },
  // more
  "empty array path": { path: [] as string[] },
  "empty first array value": { path: ["", "b"] },
  "empty ticket falls to project": { path: "a", ticket: "", project: "p" },
  "empty project": { path: "a", project: "" },
  "end without start": { path: "a", end: "5" },
  "same start and end": { path: "a", start: "5", end: "5" },
  "negative start": { path: "a", start: "-3" },
  "padded number": { path: "a", start: " 12 ", end: "\n14\t" },
  "NBSP-padded number": { path: "a", start: " 12" },
  "NEL-padded number is NaN": { path: "a", start: "\u008512" },
  "plus sign": { path: "a", start: "+3" },
  "hex start": { path: "a", start: "0x10" },
  "upper-case hex": { path: "a", start: "0XfF" },
  "binary start": { path: "a", start: "0b11" },
  "octal start": { path: "a", start: "0o17" },
  "signed hex is NaN": { path: "a", start: "-0x10" },
  "exponent start": { path: "a", start: "1e2" },
  "upper-case exponent": { path: "a", start: "2E1" },
  "negative exponent": { path: "a", start: "50e-1" },
  "fraction that is whole": { path: "a", start: "3.0", end: "6." },
  "leading dot": { path: "a", start: ".5e1" },
  "leading zeros": { path: "a", start: "007" },
  "empty start is zero": { path: "a", start: "" },
  "whitespace start is zero": { path: "a", start: "  " },
  Infinity: { path: "a", start: "Infinity" },
  "underscore separator": { path: "a", start: "1_000" },
  "lone dot": { path: "a", start: "." },
  "lone e": { path: "a", start: "e5" },
  "inner space": { path: "a", start: "1 2" },
  "arabic digits": { path: "a", start: "١٢" },
  "2^53 + 1 rounds": { path: "a", start: "9007199254740993" },
  "inf literal is NaN": { path: "a", start: "inf" },
  "hex float is NaN": { path: "a", start: "0x1p3" },
  "nan literal is NaN": { path: "a", start: "nan" },
  "unicode path": { path: "über/naïve.ts", ticket: "K" },
});

export const fileLinesCases = cases(fileLines, {
  // fileViewer.test.ts
  "trailing newline": "a\nb\n",
  "blank last line": "a\nb\n\n",
  CRLF: "a\r\nb",
  empty: "",
  // more
  "only newline": "\n",
  "two newlines": "\n\n",
  "lone CR kept": "a\rb",
  "CRLF trailing": "a\r\nb\r\n",
  "no trailing newline": "x",
  "U+2028 is not a line break": "a b",
  emoji: "😀\ncafé\n",
});

export const initialScrollIndexCases = cases(
  ({ start, total, context }: { start?: number; total: number; context?: number }) => initialScrollIndex(start, total, context),
  {
    // fileViewer.test.ts
    middle: { start: 50, total: 100 },
    "near the top": { start: 2, total: 100 },
    "past the end": { start: 500, total: 100 },
    "no start": { total: 100 },
    "empty file": { start: 5, total: 0 },
    // more
    "start zero": { start: 0, total: 100 },
    "negative start": { start: -5, total: 100 },
    "exactly context + 1": { start: 4, total: 100 },
    "custom context": { start: 50, total: 100, context: 10 },
    "zero context": { start: 50, total: 100, context: 0 },
    "last line": { start: 100, total: 100 },
    "negative total": { start: 5, total: -1 },
    "one-line file": { start: 1, total: 1 },
  },
);

export const highlightWindowCases = cases(
  ({ lengths, center, maxChars }: { lengths: number[]; center: number; maxChars: number }) => highlightWindow(lengths, center, maxChars),
  {
    // fileViewer.test.ts
    "whole file fits": { lengths: [3, 3, 3], center: 1, maxChars: 100 },
    "grows both ways": { lengths: Array(10).fill(9), center: 5, maxChars: 35 },
    "at the start": { lengths: Array(10).fill(9), center: 0, maxChars: 35 },
    "at the end": { lengths: Array(10).fill(9), center: 9, maxChars: 35 },
    "big line on one side": { lengths: [1, 1, 1, 1, 500, 1, 1, 1], center: 5, maxChars: 20 },
    "oversized center": { lengths: [1, 999, 1], center: 1, maxChars: 50 },
    "center past the end": { lengths: [1, 1], center: 40, maxChars: 100 },
    empty: { lengths: [], center: 0, maxChars: 100 },
    // more
    "negative center": { lengths: [1, 1, 1], center: -4, maxChars: 4 },
    "exact budget": { lengths: [4, 4, 4], center: 1, maxChars: 15 },
    "one short of budget": { lengths: [4, 4, 4], center: 1, maxChars: 14 },
    "zero budget": { lengths: [1, 1, 1], center: 1, maxChars: 0 },
    "grows down before up": { lengths: [1, 1, 1], center: 1, maxChars: 4 },
    "empty lines": { lengths: [0, 0, 0, 0, 0], center: 2, maxChars: 3 },
    "uneven sides": { lengths: [10, 1, 1, 5, 1, 1, 1, 30], center: 3, maxChars: 16 },
  },
);

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -3,4 +3,5 @@ function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;

 return a;
@@ -20,2 +21,1 @@
--- dashes removed
 end
\\ No newline at end of file
`;

export const patchRowsCases = cases(patchRows, {
  // fileViewer.test.ts
  "two hunks": PATCH,
  "untracked file": "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n",
  empty: "",
  binary: "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n",
  // more
  "no trailing newline": "@@ -1 +1 @@\n-a\n+b",
  "trailing blank context kept when not last": "@@ -1,2 +1,2 @@\n-a\n+b\n\n x\n",
  CRLF: "@@ -1 +1 @@\r\n-a\r\n+b\r\n",
  "lines before the first hunk": "-stray\n+stray\n@@ -4 +4 @@\n-a\n+b\n",
  "bare @@ keeps numbering": "@@ -1 +1 @@\n-a\n+b\n@@ @@\n c\n",
  "first hunk bare starts at zero": "@@ @@\n a\n+b\n",
  "deleted file": "--- a/g.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
  "only a newline": "\n",
  "header only": "diff --git a/a b/a\nold mode 100644\nnew mode 100755\n",
  "emoji and combining marks": "@@ -1 +1 @@\n-café\n+café 😀\n",
});

export const formatSizeCases = cases(formatSize, {
  // fileViewer.test.ts
  bytes: 512,
  "1.5 KB": 1536,
  "20 KB": 20 * 1024,
  "3.0 MB": 3 * 1024 * 1024,
  // more
  zero: 0,
  "1023 B": 1023,
  "1 KB": 1024,
  "just under 10 KB": 10 * 1024 - 1,
  "10 KB": 10 * 1024,
  "toFixed tie 1.25 rounds up": 1.25 * 1024,
  "toFixed tie 1.75": 1.75 * 1024,
  "toFixed 9.95 tie": 9.95 * 1024,
  "9.96 KB reads 10.0": 9.96 * 1024,
  "Math.round half up": 10.5 * 1024,
  "1023.9 KB does not promote": 1024 * 1024 - 100,
  "1 MB": 1024 * 1024,
  "1.5 GB": 1.5 * 1024 ** 3,
  "beyond GB stays GB": 5 * 1024 ** 4,
  "fractional bytes": 12.5,
  negative: -5,
});
