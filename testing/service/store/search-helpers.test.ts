import { expect, test } from "bun:test";
import { clampLimit, CursorError, decodeCursor, encodeCursor, ftsQuery, keyCandidate, likePattern, searchSnippet, searchTerms, MAX_PAGE_LIMIT } from "../../../service/src/store/search";

test("clampLimit keeps 1..200, truncates, and falls back for missing or junk input", () => {
  expect(clampLimit(10, 50)).toBe(10);
  expect(clampLimit(0, 50)).toBe(1);
  expect(clampLimit(-5, 50)).toBe(1);
  expect(clampLimit(9999, 50)).toBe(MAX_PAGE_LIMIT);
  expect(clampLimit(7.9, 50)).toBe(7);
  expect(clampLimit("25", 50)).toBe(25);
  for (const junk of [undefined, null, "", "  ", "abc", NaN]) expect(clampLimit(junk as never, 50)).toBe(50);
});

test("a cursor round-trips only for the tag and shape it was made with", () => {
  const c = encodeCursor("p", [3, 1000, "id-1"]);
  expect(decodeCursor(c, "p", ["n", "n", "s"])).toEqual([3, 1000, "id-1"]);
  expect(() => decodeCursor(c, "d", ["n", "n", "s"])).toThrow(CursorError);
  expect(() => decodeCursor(c, "p", ["n", "s"])).toThrow(CursorError);
  expect(() => decodeCursor(c, "p", ["s", "n", "s"])).toThrow(CursorError);
  expect(() => decodeCursor("%%%not-base64-json", "p", ["n"])).toThrow(CursorError);
  expect(() => decodeCursor(encodeCursor("p", [Infinity as number]), "p", ["n"])).toThrow(CursorError);
});

test("ftsQuery quotes every term so FTS operators are plain text", () => {
  expect(ftsQuery("foo bar")).toBe('"foo"* "bar"*');
  expect(ftsQuery('say "hi" AND -x:y')).toBe('"say"* """hi"""* "AND"* "-x:y"*');
  expect(ftsQuery("title words", "title")).toBe('{title} : ("title"* "words"*)');
  expect(ftsQuery("  -- ** ")).toBeNull();
  expect(searchTerms("a -- b")).toEqual(["a", "b"]);
});

test("likePattern escapes LIKE wildcards and appends % only for a prefix", () => {
  expect(likePattern("50%_off\\", false)).toBe("50\\%\\_off\\\\");
  expect(likePattern("AB", true)).toBe("AB%");
});

test("keyCandidate is the whole query upper-cased, or null when it has spaces or is empty", () => {
  expect(keyCandidate("  abc-12 ")).toBe("ABC-12");
  expect(keyCandidate("two words")).toBeNull();
  expect(keyCandidate("   ")).toBeNull();
});

test("searchSnippet windows around the earliest hit, marks cut ends, and falls back to the start", () => {
  const long = `${"x ".repeat(100)}needle ${"y ".repeat(100)}`;
  const s = searchSnippet([null, long], "needle", 60);
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s).toContain("needle");
  expect(searchSnippet(["short text", "needle here"], "needle")).toBe("needle here");
  expect(searchSnippet(["alpha beta", "gamma"], "zzz")).toBe("alpha beta");
  expect(searchSnippet([null, "  "], "q")).toBe("");
  expect(searchSnippet(["  a \n b  "], "q")).toBe("a b");
});
