import { describe, expect, test } from "bun:test";
import { formatFileLink, parseFileLink } from "@harness/shared";
import { fileLines, fileRouteFor, fileScreenHref, formatSize, highlightWindow, initialScrollIndex, patchRows, readFileParams } from "./fileViewer";

const link = (url: string) => parseFileLink(url)!;

describe("fileRouteFor", () => {
  test("a relative link resolves in the markdown's ticket, with its line range", () => {
    expect(fileRouteFor(link("harness://file/src/app.ts#L10-L20"), { ticketKey: "HARNESS-1", projectId: "p1" })).toEqual({ path: "src/app.ts", ticket: "HARNESS-1", start: "10", end: "20" });
    expect(fileRouteFor(link("src/app.ts#L7"), { ticketKey: "HARNESS-1" })).toEqual({ path: "src/app.ts", ticket: "HARNESS-1", start: "7" });
  });

  test("the link's own ?ticket or ?project wins over the context", () => {
    expect(fileRouteFor(link("harness://file/a.ts?ticket=OTHER-2"), { ticketKey: "HARNESS-1" })).toEqual({ path: "a.ts", ticket: "OTHER-2" });
    expect(fileRouteFor(link("harness://file/a.ts?project=p9"), { ticketKey: "HARNESS-1" })).toEqual({ path: "a.ts", project: "p9" });
  });

  test("falls back to the context's project, and is null with no root at all", () => {
    expect(fileRouteFor(link("a.ts"), { projectId: "p1" })).toEqual({ path: "a.ts", project: "p1" });
    expect(fileRouteFor(link("a.ts"), {})).toBeNull();
  });

  test("absolute paths pass through for the service to resolve", () => {
    expect(fileRouteFor(link("/Users/me/site/a.ts#L3"), { ticketKey: "K-1" })).toEqual({ path: "/Users/me/site/a.ts", ticket: "K-1", start: "3" });
  });
});

describe("fileScreenHref", () => {
  test("rewrites a harness://file URL to the viewer's query form, keeping the #L range", () => {
    expect(fileScreenHref(formatFileLink({ path: "src/a b.ts", startLine: 4, endLine: 9, ticketKey: "HARNESS-3" }))).toBe("/file?path=src%2Fa%20b.ts&ticket=HARNESS-3&start=4&end=9");
    expect(fileScreenHref("HARNESS://FILE/x.ts?project=p1")).toBe("/file?path=x.ts&project=p1");
  });

  test("a link with no ticket or project still opens the viewer", () => {
    expect(fileScreenHref("harness://file/x.ts#L2")).toBe("/file?path=x.ts");
  });

  test("leaves other harness:// links and garbage alone", () => {
    expect(fileScreenHref("harness://pair?url=http%3A%2F%2Fh&token=t")).toBeNull();
    expect(fileScreenHref("harness://settings?theme=dark")).toBeNull();
    expect(fileScreenHref("harness://ticket/K-1?tab=transcript")).toBeNull();
    expect(fileScreenHref("harness://file/")).toBeNull();
    expect(fileScreenHref("harness://file/../etc/passwd")).toBeNull();
  });

  test("round-trips through readFileParams", () => {
    const href = fileScreenHref("harness://file/src/app.ts?ticket=K-1#L5-L2")!;
    const params = Object.fromEntries(
      href
        .slice("/file?".length)
        .split("&")
        .map((kv) => kv.split("=").map(decodeURIComponent) as [string, string]),
    );
    expect(readFileParams(params)).toEqual({ root: { kind: "ticket", key: "K-1" }, path: "src/app.ts", range: [2, 5] });
  });
});

describe("readFileParams", () => {
  test("needs a path", () => {
    expect(readFileParams({ ticket: "K-1" })).toBeNull();
    expect(readFileParams({ path: "", ticket: "K-1" })).toBeNull();
  });

  test("ticket over project; neither is a null root", () => {
    expect(readFileParams({ path: "a", ticket: "K-1", project: "p" })!.root).toEqual({ kind: "ticket", key: "K-1" });
    expect(readFileParams({ path: "a", project: "p" })!.root).toEqual({ kind: "project", id: "p" });
    expect(readFileParams({ path: "a" })!.root).toBeNull();
  });

  test("ranges: single line, reversed, and junk", () => {
    expect(readFileParams({ path: "a", start: "7" })!.range).toEqual([7, 7]);
    expect(readFileParams({ path: "a", start: "9", end: "3" })!.range).toEqual([3, 9]);
    expect(readFileParams({ path: "a", start: "0" })!.range).toBeNull();
    expect(readFileParams({ path: "a", start: "x", end: "4" })!.range).toBeNull();
    expect(readFileParams({ path: "a", start: "2.5" })!.range).toBeNull();
    expect(readFileParams({ path: "a", start: "4", end: "nope" })!.range).toEqual([4, 4]);
  });

  test("array params take the first value", () => {
    expect(readFileParams({ path: ["a.ts", "b.ts"], ticket: ["K-1"] })).toEqual({ root: { kind: "ticket", key: "K-1" }, path: "a.ts", range: null });
  });
});

describe("fileLines", () => {
  test("a trailing newline doesn't add an empty line, but a blank last line does", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\nb\n\n")).toEqual(["a", "b", ""]);
    expect(fileLines("a\r\nb")).toEqual(["a", "b"]);
    expect(fileLines("")).toEqual([""]);
  });
});

describe("initialScrollIndex", () => {
  test("opens a few lines above the range, clamped to the file", () => {
    expect(initialScrollIndex(50, 100)).toBe(46);
    expect(initialScrollIndex(2, 100)).toBe(0);
    expect(initialScrollIndex(500, 100)).toBe(99);
    expect(initialScrollIndex(undefined, 100)).toBe(0);
    expect(initialScrollIndex(5, 0)).toBe(0);
  });
});

describe("highlightWindow", () => {
  test("the whole file when it fits", () => {
    expect(highlightWindow([3, 3, 3], 1, 100)).toEqual([0, 3]);
  });

  test("grows around the center, both ways, within budget (newlines count)", () => {
    // Each line costs 10 (9 + newline); 35 fits three lines.
    expect(highlightWindow(Array(10).fill(9), 5, 35)).toEqual([4, 7]);
    // At the start it can only grow down.
    expect(highlightWindow(Array(10).fill(9), 0, 35)).toEqual([0, 3]);
    // At the end, only up.
    expect(highlightWindow(Array(10).fill(9), 9, 35)).toEqual([7, 10]);
  });

  test("skips past neither side's big line but keeps growing the other", () => {
    // Line 4 is huge; from center 5 the window grows down only.
    expect(highlightWindow([1, 1, 1, 1, 500, 1, 1, 1], 5, 20)).toEqual([5, 8]);
  });

  test("an oversized center line is a window of one; a center out of range is clamped", () => {
    expect(highlightWindow([1, 999, 1], 1, 50)).toEqual([1, 2]);
    expect(highlightWindow([1, 1], 40, 100)).toEqual([0, 2]);
    expect(highlightWindow([], 0, 100)).toEqual([0, 0]);
  });
});

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

describe("patchRows", () => {
  test("numbers each code line on its side, and restarts at each hunk", () => {
    const rows = patchRows(PATCH);
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine, r.text])).toEqual([
      ["hunk", null, null, "@@ -3,4 +3,5 @@ function main() {"],
      ["ctx", 3, 3, "const a = 1;"],
      ["del", 4, null, "const b = 2;"],
      ["add", null, 4, "const b = 3;"],
      ["add", null, 5, "const c = 4;"],
      ["ctx", 5, 6, ""],
      ["ctx", 6, 7, "return a;"],
      ["hunk", null, null, "@@ -20,2 +21,1 @@"],
      // A removed line that starts with dashes is code, not a file header.
      ["del", 20, null, "-- dashes removed"],
      ["ctx", 21, 21, "end"],
    ]);
  });

  test("source points back at parseDiff's line, for its colors", () => {
    const lines = PATCH.split("\n");
    for (const r of patchRows(PATCH)) expect(lines[r.source]!.slice(r.kind === "hunk" ? 0 : 1)).toBe(r.text);
  });

  test("an untracked file is all additions from line 1", () => {
    const rows = patchRows("diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(rows.slice(1).map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ["add", null, 1],
      ["add", null, 2],
    ]);
  });

  test("no hunks (a binary change, or a clean file) is no rows", () => {
    expect(patchRows("")).toEqual([]);
    expect(patchRows("diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n")).toEqual([]);
  });
});

describe("formatSize", () => {
  test("bytes, then one decimal under 10, then whole numbers", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024)).toBe("20 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
