import { expect, test } from "bun:test";
import { applySpecEdits, localImageSources, numberLines, rewriteImageSources, SpecEditError, unifiedDiff } from "../../service/src/spec";

const body = "one\ntwo\nthree\nfour";

test("numberLines right-aligns to at least four columns and separates with a tab", () => {
  expect(numberLines("a\nb")).toBe("   1\ta\n   2\tb");
  const big = Array.from({ length: 12345 }, () => "x").join("\n");
  expect(numberLines(big).split("\n")[12344]).toBe("12345\tx");
});

test("string edits replace one unique match; ambiguity and misses refuse the whole batch", () => {
  expect(applySpecEdits(body, [{ old_string: "two", new_string: "2" }], 1)).toBe("one\n2\nthree\nfour");
  expect(() => applySpecEdits("a a", [{ old_string: "a", new_string: "b" }], 3)).toThrow(/appears 2 times/);
  expect(applySpecEdits("a a", [{ old_string: "a", new_string: "b", replace_all: true }], 3)).toBe("b b");
  expect(() => applySpecEdits(body, [{ old_string: "nope", new_string: "x" }], 1)).toThrow(/wasn't found/);
  expect(() => applySpecEdits(body, [{ old_string: "x", new_string: "x" }], 1)).toThrow(/same/);
  expect(() => applySpecEdits(body, [{ old_string: "", new_string: "x" }], 1)).toThrow(/empty/);
});

test("a batch is all or nothing: the error names the failing edit", () => {
  try {
    applySpecEdits(body, [{ old_string: "one", new_string: "1" }, { old_string: "zzz", new_string: "x" }], 7);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(SpecEditError);
    expect((e as Error).message).toContain("Edit 2");
    expect((e as Error).message).toContain("revision 7");
  }
});

test("line edits address base-revision numbers even after an earlier edit changed the length", () => {
  const out = applySpecEdits(body, [
    { start_line: 1, end_line: 1, new_text: "a\nb\nc" },
    { start_line: 4, end_line: 4, new_text: "FOUR" },
  ], 1);
  expect(out).toBe("a\nb\nc\ntwo\nthree\nFOUR");
});

test("end_line = start_line - 1 inserts, at the end too, and an empty new_text deletes", () => {
  expect(applySpecEdits(body, [{ start_line: 2, end_line: 1, new_text: "ins" }], 1)).toBe("one\nins\ntwo\nthree\nfour");
  expect(applySpecEdits(body, [{ start_line: 5, end_line: 4, new_text: "end" }], 1)).toBe("one\ntwo\nthree\nfour\nend");
  expect(applySpecEdits(body, [{ start_line: 2, end_line: 3, new_text: "" }], 1)).toBe("one\nfour");
});

test("a line edit over lines an earlier edit rewrote is refused", () => {
  expect(() => applySpecEdits(body, [{ old_string: "two", new_string: "2" }, { start_line: 2, end_line: 2, new_text: "x" }], 1)).toThrow(/overlap an earlier edit/);
});

test("line edits check bounds and `expected`", () => {
  expect(() => applySpecEdits(body, [{ start_line: 0, end_line: 1, new_text: "x" }], 1)).toThrow(/aren't in revision/);
  expect(() => applySpecEdits(body, [{ start_line: 3, end_line: 9, new_text: "x" }], 1)).toThrow(/aren't in revision/);
  expect(() => applySpecEdits(body, [{ start_line: 2, end_line: 2, new_text: "x", expected: "nope" }], 1)).toThrow(/don't match expected/);
  expect(applySpecEdits(body, [{ start_line: 2, end_line: 2, new_text: "x", expected: "two\n" }], 1)).toBe("one\nx\nthree\nfour");
});

test("non-list and malformed edits are rejected", () => {
  expect(() => applySpecEdits(body, [], 1)).toThrow(/non-empty/);
  expect(() => applySpecEdits(body, "x", 1)).toThrow(/non-empty/);
  expect(() => applySpecEdits(body, [{ foo: 1 }], 1)).toThrow(/give either/);
});

test("unifiedDiff is empty for equal text and prints git-style hunks otherwise", () => {
  expect(unifiedDiff("a", "a", "x", "y")).toBe("");
  expect(unifiedDiff("a\nb\nc", "a\nB\nc", "r1", "r2")).toBe("--- r1\n+++ r2\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
});

test("unifiedDiff from empty uses git's -0,0 and splits distant changes into separate hunks", () => {
  expect(unifiedDiff("", "x", "a", "b")).toBe("--- a\n+++ b\n@@ -0,0 +1,1 @@\n+x");
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l1\n", "L1\n").replace("l18", "L18");
  expect(unifiedDiff(before, after, "a", "b", 1).match(/^@@/gm)).toHaveLength(2);
});

test("localImageSources lists local images once, in order, skipping attachments and links", () => {
  const md = "![a](shots/a.png) ![b](https://x/b.png) ![c](attachment:9) ![d](<my pic.png> \"t\") ![e](shots/a.png) ![f](data:image/png;base64,AA)";
  expect(localImageSources(md)).toEqual(["shots/a.png", "my pic.png"]);
});

test("rewriteImageSources swaps only the srcs it has ids for and keeps alt and title", () => {
  const md = "![a](shots/a.png \"cap\") ![b](other.png)";
  expect(rewriteImageSources(md, new Map([["shots/a.png", "42"]]))).toBe("![a](attachment:42 \"cap\") ![b](other.png)");
});
