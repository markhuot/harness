import { expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { fingerprint, isCollapsed, MAX_FILES, MAX_TICKETS, prune, readViewed, saveViewed, VIEWED_KEY, type Viewed } from "./changes";

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  return { m, get: () => store };
}
const throwing = () => {
  throw new Error("SecurityError: localStorage is not available");
};

const patch = (path: string, body: string, header = `--- a/${path}\n+++ b/${path}\n`) => `diff --git a/${path} b/${path}\n${header}${body}`;
const parse = (text: string) => parsePatchFiles(text, `t${Math.random()}`).flatMap((p) => p.files);
const fpOf = (text: string) => fingerprint(parse(text)[0]!);

test("fingerprint is stable for the same diff and changes when the file's diff does", () => {
  const a = patch("src/a.ts", "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n");
  expect(fpOf(a)).toBe(fpOf(a));
  // A different added line, a different hunk position, and a different path all read as a new diff.
  expect(fpOf(patch("src/a.ts", "@@ -1,2 +1,2 @@\n ctx\n-old\n+newer\n"))).not.toBe(fpOf(a));
  expect(fpOf(patch("src/a.ts", "@@ -5,2 +5,2 @@\n ctx\n-old\n+new\n"))).not.toBe(fpOf(a));
  expect(fpOf(patch("src/b.ts", "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n"))).not.toBe(fpOf(a));
  // Moving a line from the deletion side to the addition side is a different diff with the same text.
  expect(fpOf(patch("x", "@@ -1,1 +1,1 @@\n-a\n+b\n"))).not.toBe(fpOf(patch("x", "@@ -1,1 +1,1 @@\n-b\n+a\n")));
});

test("a file's fingerprint ignores changes to other files in the same patch", () => {
  const a = patch("a.ts", "@@ -1 +1 @@\n-x\n+y\n");
  const before = parse(a + patch("b.ts", "@@ -1 +1 @@\n-1\n+2\n"));
  const after = parse(a + patch("b.ts", "@@ -1 +1 @@\n-1\n+3\n"));
  expect(fingerprint(after[0]!)).toBe(fingerprint(before[0]!));
  expect(fingerprint(after[1]!)).not.toBe(fingerprint(before[1]!));
});

test("marks round-trip per ticket without touching other tickets", () => {
  const s = memory();
  saveViewed("A-1", new Map([["a.ts", "f1"]]), s.get, 1);
  saveViewed("B-2", new Map([["b.ts", "f2"]]), s.get, 2);
  expect([...readViewed("A-1", s.get)]).toEqual([["a.ts", "f1"]]);
  expect([...readViewed("B-2", s.get)]).toEqual([["b.ts", "f2"]]);
  expect(readViewed("C-3", s.get).size).toBe(0);
  // Clearing a ticket's last mark removes the ticket entirely.
  saveViewed("A-1", new Map(), s.get, 3);
  expect(Object.keys(JSON.parse(s.m.get(VIEWED_KEY)!))).toEqual(["B-2"]);
});

test("corrupt or unexpected stored values read as nothing viewed, and saving over them recovers", () => {
  for (const raw of ["{not json", "[]", "null", '"str"', "42", '{"A-1":{"at":1,"files":[1,2]}}', '{"A-1":null}']) {
    const s = memory({ [VIEWED_KEY]: raw });
    expect(readViewed("A-1", s.get).size).toBe(0);
    saveViewed("A-1", new Map([["a", "f"]]), s.get, 5);
    expect([...readViewed("A-1", s.get)]).toEqual([["a", "f"]]);
  }
  // Non-string fingerprints are skipped, valid ones in the same ticket survive.
  const mixed = memory({ [VIEWED_KEY]: JSON.stringify({ "A-1": { at: 1, files: { a: "f", b: 7, c: null } } }) });
  expect([...readViewed("A-1", mixed.get)]).toEqual([["a", "f"]]);
  // A malformed sibling ticket is dropped on the next write instead of breaking it.
  const sibling = memory({ [VIEWED_KEY]: JSON.stringify({ "B-2": "junk", "C-3": { at: 1, files: { c: "f" } } }) });
  saveViewed("A-1", new Map([["a", "f"]]), sibling.get, 2);
  expect(Object.keys(JSON.parse(sibling.m.get(VIEWED_KEY)!)).sort()).toEqual(["A-1", "C-3"]);
});

test("unavailable storage reads as nothing viewed and writes don't throw", () => {
  expect(readViewed("A-1", throwing).size).toBe(0);
  expect(() => saveViewed("A-1", new Map([["a", "f"]]), throwing)).not.toThrow();
  expect(() => saveViewed("A-1", new Map([["a", "f"]]), () => ({ getItem: () => null, setItem: throwing }))).not.toThrow();
});

test("storage keeps the most recently written tickets and caps marks per ticket", () => {
  const s = memory();
  for (let i = 0; i < MAX_TICKETS + 5; i++) saveViewed(`T-${i}`, new Map([["a", "f"]]), s.get, i);
  const kept = Object.keys(JSON.parse(s.m.get(VIEWED_KEY)!));
  expect(kept.length).toBe(MAX_TICKETS);
  expect(kept).not.toContain("T-0");
  expect(kept).not.toContain("T-4");
  expect(kept).toContain("T-5");
  // Re-saving an old ticket makes it the newest, so it survives the next eviction.
  saveViewed("T-5", new Map([["a", "f"]]), s.get, 1000);
  saveViewed("NEW", new Map([["a", "f"]]), s.get, 1001);
  const after = Object.keys(JSON.parse(s.m.get(VIEWED_KEY)!));
  expect(after).toContain("T-5");
  expect(after).not.toContain("T-6");

  const many: Viewed = new Map(Array.from({ length: MAX_FILES + 10 }, (_, i) => [`f${i}`, "x"]));
  saveViewed("BIG", many, s.get, 2000);
  const big = readViewed("BIG", s.get);
  expect(big.size).toBe(MAX_FILES);
  expect(big.has(`f${MAX_FILES + 9}`)).toBe(true); // the most recent marks are the ones kept
  expect(big.has("f0")).toBe(false);
});

test("prune drops changed and vanished files but keeps truncated ones", () => {
  const viewed: Viewed = new Map([
    ["same.ts", "f1"],
    ["edited.ts", "old"],
    ["gone.ts", "f3"],
    ["truncated.ts", "f4"],
  ]);
  const current = new Map([
    ["same.ts", "f1"],
    ["edited.ts", "new"],
    ["other.ts", "f5"],
  ]);
  const changed = new Set(["same.ts", "edited.ts", "other.ts", "truncated.ts"]);
  expect([...prune(viewed, current, changed).keys()]).toEqual(["same.ts", "truncated.ts"]);
});

test("collapse follows viewed unless the arrow was toggled for this version of the diff", () => {
  expect(isCollapsed(true, undefined, "f")).toBe(true);
  expect(isCollapsed(false, undefined, "f")).toBe(false);
  expect(isCollapsed(true, { fp: "f", collapsed: false }, "f")).toBe(false); // peeking at a viewed file
  expect(isCollapsed(false, { fp: "f", collapsed: true }, "f")).toBe(true); // folding an unviewed file
  // A toggle made on an older version of the diff no longer applies.
  expect(isCollapsed(false, { fp: "old", collapsed: true }, "new")).toBe(false);
  expect(isCollapsed(true, { fp: "old", collapsed: false }, "new")).toBe(true);
});
