import { describe, expect, test } from "bun:test";
import {
  fileItemId, looksLikePath, matchLabel, paletteFileRoot, paletteBody, paletteSources, parseFileQuery, parsePaletteQuery, pushRecent, rankCommands, readRecents, recentFilePaths, recentRanks, RECENT_MAX,
  type PaletteItem,
} from "../../../app/src/renderer/state/palette";

const item = (label: string, o: Partial<PaletteItem> = {}): PaletteItem => ({ id: label, label, ...o });
const labels = (query: string, items: PaletteItem[]) => rankCommands(query, items).map((r) => r.item.label);

/** A Storage stand-in holding strings, with switches for the failure modes. */
function memory(initial: Record<string, string> = {}, o: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(k: string) {
      if (o.throwOnGet) throw new Error("denied");
      return data.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (o.throwOnSet) throw new Error("full");
      data.set(k, v);
    },
  };
}

describe("matchLabel", () => {
  test("a prefix is the top tier", () => {
    expect(matchLabel("new", "New Session")).toEqual({ tier: 4, ranges: [[0, 3]] });
  });
  test("a run that starts a word", () => {
    expect(matchLabel("sess", "New Session")).toEqual({ tier: 3, ranges: [[4, 8]] });
  });
  test("a camelCase hump starts a word", () => {
    expect(matchLabel("file", "openFile")).toEqual({ tier: 3, ranges: [[4, 8]] });
  });
  test("word initials, with the query's spaces ignored", () => {
    expect(matchLabel("ns", "New Session")).toEqual({ tier: 3, ranges: [[0, 1], [4, 5]] });
    expect(matchLabel("n s", "Not Sessions")).toEqual({ tier: 3, ranges: [[0, 1], [4, 5]] });
  });
  test("a run inside a word is the third tier", () => {
    expect(matchLabel("ess", "New Session")).toEqual({ tier: 2, ranges: [[5, 8]] });
  });
  test("scattered letters merge adjacent hits into one range", () => {
    expect(matchLabel("nsn", "New Session")).toEqual({ tier: 1, ranges: [[0, 1], [4, 5], [10, 11]] });
    expect(matchLabel("nes", "Newest")).toEqual({ tier: 1, ranges: [[0, 2], [4, 5]] });
  });
  test("no subsequence is no match; an all-space query can't match", () => {
    expect(matchLabel("xyz", "New Session")).toBeNull();
    expect(matchLabel("zn", "New Session")).toBeNull();
    expect(matchLabel(" ", "New Session")).toBeNull();
  });
  test("matches letters beyond ASCII as word characters", () => {
    expect(matchLabel("über", "Die Überprüfung")).toEqual({ tier: 3, ranges: [[4, 8]] });
  });
});

describe("rankCommands", () => {
  test("an empty query keeps everything: recents first by rank, then input order", () => {
    const items = [item("a"), item("b", { recentRank: 1 }), item("c"), item("d", { recentRank: 0 })];
    expect(labels("", items)).toEqual(["d", "b", "a", "c"]);
    expect(labels("   ", items)).toEqual(["d", "b", "a", "c"]);
  });
  test("non-matching items drop out", () => {
    expect(labels("zz", [item("New Session"), item("Settings")])).toEqual([]);
  });
  test("tiers order the results: prefix, then word start, then inside a word", () => {
    expect(labels("se", [item("Close"), item("Reset"), item("New Session"), item("Settings")])).toEqual(["Settings", "New Session", "Close", "Reset"]);
  });
  test("within a tier, fewer pieces win", () => {
    // "se": 'Save Edit' matches as two initials (298); 'New Session' as one word-start run (299)
    expect(labels("se", [item("Save Edit"), item("New Session")])).toEqual(["New Session", "Save Edit"]);
  });
  test("equal scores go to the more recent, then to input order", () => {
    expect(labels("a", [item("Alpha", { id: "1" }), item("Alpine", { id: "2", recentRank: 0 })])).toEqual(["Alpine", "Alpha"]);
    expect(labels("a", [item("Alpha"), item("Alpine")])).toEqual(["Alpha", "Alpine"]);
  });
  test("ranges come back for the label match, none for a keyword-only match", () => {
    const [hit] = rankCommands("sess", [item("New Session")]);
    expect(hit!.ranges).toEqual([[4, 8]]);
    const [kw] = rankCommands("child", [item("Hide tickets", { keywords: ["children"] })]);
    expect(kw!.ranges).toEqual([]);
  });
  test("a keyword match ranks below a label match of the same tier", () => {
    expect(labels("pull", [item("Open", { keywords: ["Pull request"] }), item("Pull branch")])).toEqual(["Pull branch", "Open"]);
  });
  test("a keyword still beats nothing, and uses its best tier", () => {
    expect(labels("rem", [item("Cleanup", { keywords: ["Remove worktree"] }), item("Other")])).toEqual(["Cleanup"]);
  });
  test("the query is case-insensitive and trimmed", () => {
    expect(labels("  NEW ", [item("new session")])).toEqual(["new session"]);
  });
});

describe("parsePaletteQuery / paletteSources", () => {
  test("prefix characters pick the kind and are stripped with surrounding space", () => {
    expect(parsePaletteQuery("> new ")).toEqual({ kind: "commands", q: "new" });
    expect(parsePaletteQuery("#HAR-1")).toEqual({ kind: "tickets", q: "HAR-1" });
    expect(parsePaletteQuery("  @ src/a.ts")).toEqual({ kind: "files", q: "src/a.ts" });
    expect(parsePaletteQuery("  hello ")).toEqual({ kind: "all", q: "hello" });
    expect(parsePaletteQuery("")).toEqual({ kind: "all", q: "" });
  });
  test("a prefix only counts at the start", () => {
    expect(parsePaletteQuery("a > b").kind).toBe("all");
  });
  test("all: commands always; tickets once there's a query; files only for path-like queries", () => {
    expect(paletteSources("")).toMatchObject({ commands: true, tickets: false, files: false });
    expect(paletteSources("settings")).toMatchObject({ commands: true, tickets: true, files: false });
    expect(paletteSources("src/app.ts")).toMatchObject({ commands: true, tickets: true, files: true });
    expect(paletteSources("app.ts:12")).toMatchObject({ files: true });
  });
  test("'>' is commands only, even for something path-shaped", () => {
    expect(paletteSources("> src/app.ts")).toEqual({ kind: "commands", q: "src/app.ts", commands: true, tickets: false, files: false });
  });
  test("'#' is tickets only and '@' is files only, path-like or not", () => {
    expect(paletteSources("#src/app.ts")).toMatchObject({ commands: false, tickets: true, files: false });
    expect(paletteSources("@")).toMatchObject({ commands: false, tickets: false, files: true });
    expect(paletteSources("@readme")).toMatchObject({ commands: false, tickets: false, files: true });
  });
});

describe("parseFileQuery", () => {
  test("no line suffix is just the search", () => {
    expect(parseFileQuery(" src/a.ts ")).toEqual({ search: "src/a.ts" });
  });
  test("colon forms: line, range, and a dropped column", () => {
    expect(parseFileQuery("a.ts:12")).toEqual({ search: "a.ts", startLine: 12 });
    expect(parseFileQuery("a.ts:12-20")).toEqual({ search: "a.ts", startLine: 12, endLine: 20 });
    expect(parseFileQuery("a.ts:12:3")).toEqual({ search: "a.ts", startLine: 12 });
  });
  test("hash forms: #L12, #L12-L20 and #L12-20", () => {
    expect(parseFileQuery("a.ts#L12")).toEqual({ search: "a.ts", startLine: 12 });
    expect(parseFileQuery("a.ts#L12-L20")).toEqual({ search: "a.ts", startLine: 12, endLine: 20 });
    expect(parseFileQuery("a.ts#L12-20")).toEqual({ search: "a.ts", startLine: 12, endLine: 20 });
  });
  test("a reversed range is put in order; a one-line range is just its start", () => {
    expect(parseFileQuery("a.ts:20-12")).toEqual({ search: "a.ts", startLine: 12, endLine: 20 });
    expect(parseFileQuery("a.ts:5-5")).toEqual({ search: "a.ts", startLine: 5 });
  });
  test("line 0 isn't a line: the suffix is dropped", () => {
    expect(parseFileQuery("a.ts:0")).toEqual({ search: "a.ts" });
    expect(parseFileQuery("a.ts#L0-L4")).toEqual({ search: "a.ts" });
  });
  test("a dangling or non-numeric suffix stays part of the search", () => {
    expect(parseFileQuery("a.ts:")).toEqual({ search: "a.ts:" });
    expect(parseFileQuery("a.ts:12-")).toEqual({ search: "a.ts:12-" });
    expect(parseFileQuery("a.ts:abc")).toEqual({ search: "a.ts:abc" });
  });
  test("space before the suffix is trimmed off the search", () => {
    expect(parseFileQuery("src/a.ts :7")).toEqual({ search: "src/a.ts", startLine: 7 });
  });
});

describe("looksLikePath", () => {
  test("a slash or a dot with some letters", () => {
    for (const q of ["src/app", "app.ts", " x.ts "]) expect(looksLikePath(q)).toBe(true);
  });
  test("plain words, spaced text and punctuation alone don't", () => {
    for (const q of ["settings", "new session", "a b.ts", ".", "./", ""]) expect(looksLikePath(q)).toBe(false);
  });
});

describe("paletteFileRoot", () => {
  test("a focused ticket pane's ticket wins", () => {
    expect(paletteFileRoot({ kind: "ticket", ticketKey: "A-1" }, "p")).toEqual({ ticketKey: "A-1" });
  });
  test("a focused file pane's root", () => {
    expect(paletteFileRoot({ kind: "file", root: { projectId: "q" } }, "p")).toEqual({ projectId: "q" });
  });
  test("any other focus, or none, falls to the board's project", () => {
    expect(paletteFileRoot({ kind: "terminal" }, "p")).toEqual({ projectId: "p" });
    expect(paletteFileRoot(null, "p")).toEqual({ projectId: "p" });
    expect(paletteFileRoot(undefined, "p")).toEqual({ projectId: "p" });
  });
  test("All projects with nothing focused has no root", () => {
    expect(paletteFileRoot(null, null)).toBeNull();
    expect(paletteFileRoot({ kind: "board" }, "")).toBeNull();
  });
});

describe("file recents", () => {
  test("recentFilePaths picks one root's files, most recent first", () => {
    const recents = [fileItemId({ ticketKey: "A-1" }, "b.ts"), fileItemId({ projectId: "p" }, "x.ts"), fileItemId({ ticketKey: "A-1" }, "a.ts")];
    expect(recentFilePaths(recents, { ticketKey: "A-1" })).toEqual(["b.ts", "a.ts"]);
    expect(recentFilePaths(recents, { projectId: "p" })).toEqual(["x.ts"]);
  });
  test("a ticket and a project of the same name don't share files", () => {
    const recents = [fileItemId({ ticketKey: "x" }, "a.ts")];
    expect(recentFilePaths(recents, { projectId: "x" })).toEqual([]);
  });
  test("a key that prefixes another ticket's key doesn't pick up its files", () => {
    const recents = [fileItemId({ ticketKey: "A-10" }, "a.ts")];
    expect(recentFilePaths(recents, { ticketKey: "A-1" })).toEqual([]);
  });
  test("an id with an empty path is skipped", () => {
    expect(recentFilePaths([fileItemId({ ticketKey: "A-1" }, "")], { ticketKey: "A-1" })).toEqual([]);
  });
});

describe("readRecents / pushRecent / recentRanks", () => {
  test("no storage, missing key, corrupt JSON and non-arrays are an empty list", () => {
    expect(readRecents(null)).toEqual([]);
    expect(readRecents(memory())).toEqual([]);
    expect(readRecents(memory({ "harness.palette.recent": "{nope" }))).toEqual([]);
    expect(readRecents(memory({ "harness.palette.recent": '{"a":1}' }))).toEqual([]);
  });
  test("storage that throws on read is an empty list", () => {
    expect(readRecents(memory({}, { throwOnGet: true }))).toEqual([]);
  });
  test("non-strings are dropped, duplicates collapse to the first, and the list is cut to max", () => {
    const s = memory({ k: JSON.stringify(["a", 1, "b", "a", null, "c", "d"]) });
    expect(readRecents(s, "k", 3)).toEqual(["a", "b", "c"]);
  });
  test("pushRecent puts the id first once and writes it back", () => {
    const s = memory({ "harness.palette.recent": JSON.stringify(["a", "b", "c"]) });
    expect(pushRecent("c", s)).toEqual(["c", "a", "b"]);
    expect(JSON.parse(s.data.get("harness.palette.recent")!)).toEqual(["c", "a", "b"]);
  });
  test("pushRecent keeps at most max, dropping the oldest", () => {
    const s = memory({ k: JSON.stringify(["a", "b", "c"]) });
    expect(pushRecent("z", s, "k", 3)).toEqual(["z", "a", "b"]);
    const full = Array.from({ length: RECENT_MAX }, (_, i) => `i${i}`);
    expect(pushRecent("new", memory({ "harness.palette.recent": JSON.stringify(full) }))).toHaveLength(RECENT_MAX);
  });
  test("a failing or missing store still returns the new list", () => {
    expect(pushRecent("a", memory({}, { throwOnSet: true }))).toEqual(["a"]);
    expect(pushRecent("a", null)).toEqual(["a"]);
  });
  test("recentRanks maps id to position", () => {
    expect([...recentRanks(["x", "y"])]).toEqual([["x", 0], ["y", 1]]);
  });
});

describe("qualifier queries", () => {
  test("a label: or project: query is a ticket search only: no commands, no files", () => {
    expect(paletteSources('label:"Release 1.2.3" src/app.ts')).toMatchObject({ commands: false, tickets: true, files: false });
    expect(paletteSources("project:HAR")).toMatchObject({ commands: false, tickets: true });
  });
  test("other words with a colon stay a plain query", () => {
    expect(paletteSources("foo:bar")).toMatchObject({ commands: true, tickets: true });
  });
  test("paletteBody keeps the trailing space a finished qualifier ends with", () => {
    expect(paletteBody("  #label:Bugfix ")).toEqual({ prefix: "#", body: "label:Bugfix " });
    expect(paletteBody("label:")).toEqual({ prefix: "", body: "label:" });
  });
});
