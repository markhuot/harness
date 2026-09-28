import { describe, expect, test } from "bun:test";
import { matchLabel, parsePaletteQuery, pushRecent, rankCommands, readRecents, RECENT_KEY, RECENT_MAX, recentRanks, type PaletteItem } from "./palette";

const items = (...labels: string[]): PaletteItem[] => labels.map((label, i) => ({ id: `i${i}`, label }));
const labels = (q: string, list: PaletteItem[]) => rankCommands(q, list).map((r) => r.item.label);

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("rankCommands", () => {
  test("a label prefix beats scattered letters, whatever the order they came in", () => {
    // "set" is scattered in "Select Tab" (s-e-…-t) and the prefix of "Settings".
    expect(labels("set", items("Select Tab", "Settings"))).toEqual(["Settings", "Select Tab"]);
  });

  test("a word start beats the same letters inside a word", () => {
    // "tab" starts a word in "Next Tab" but sits mid-word in "Stable".
    expect(labels("tab", items("Stable build", "Next Tab"))).toEqual(["Next Tab", "Stable build"]);
  });

  test("word initials count as a word-start match, above a run inside a word", () => {
    // "ns": initials of New Session; a mid-word run in "Transcript".
    expect(labels("ns", items("Transcript", "New Session…"))).toEqual(["New Session…", "Transcript"]);
  });

  test("a run inside a word beats scattered letters", () => {
    // "ear" is scattered in "Re-run agent review" and a mid-word run in the other two.
    expect(labels("ear", items("Re-run agent review", "Clear all", "Search tickets"))).toEqual(["Clear all", "Search tickets", "Re-run agent review"]);
  });

  test("recency breaks ties; without it the original order does", () => {
    const list: PaletteItem[] = [
      { id: "a", label: "Open Settings" },
      { id: "b", label: "Open Inbox", recentRank: 3 },
      { id: "c", label: "Open Board", recentRank: 0 },
      { id: "d", label: "Open Terminal" },
    ];
    expect(labels("open", list)).toEqual(["Open Board", "Open Inbox", "Open Settings", "Open Terminal"]);
  });

  test("recency doesn't lift a worse match over a better one", () => {
    const list: PaletteItem[] = [
      { id: "a", label: "Select Tab", recentRank: 0 },
      { id: "b", label: "Settings" },
    ];
    expect(labels("set", list)).toEqual(["Settings", "Select Tab"]);
  });

  test("the empty query lists recents first, by rank, then the rest in order", () => {
    const list: PaletteItem[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B", recentRank: 1 },
      { id: "c", label: "C" },
      { id: "d", label: "D", recentRank: 0 },
    ];
    expect(rankCommands("  ", list).map((r) => r.item.id)).toEqual(["d", "b", "a", "c"]);
  });

  test("non-matches are left out", () => {
    expect(labels("zq", items("Go to Board", "Open Settings", "Approve"))).toEqual([]);
    // Every letter must appear, in order.
    expect(labels("vorppa", items("Approve"))).toEqual([]);
  });

  test("a keyword match is kept with no ranges, below a label match of the same tier", () => {
    const list: PaletteItem[] = [
      { id: "p", label: "Harness board", keywords: ["NYT"] },
      { id: "q", label: "nytimes board" },
    ];
    const r = rankCommands("nyt", list);
    expect(r.map((x) => x.item.id)).toEqual(["q", "p"]);
    expect(r[1]!.ranges).toEqual([]);
  });

  test("matching ignores case", () => {
    expect(labels("GO TO", items("go to board"))).toEqual(["go to board"]);
  });
});

describe("match ranges", () => {
  test("a prefix is one range from 0", () => {
    expect(matchLabel("new", "New Session…")?.ranges).toEqual([[0, 3]]);
  });
  test("a word-start run covers the run", () => {
    expect(matchLabel("sess", "New Session…")?.ranges).toEqual([[4, 8]]);
  });
  test("initials are one range each", () => {
    expect(matchLabel("fpl", "Focus Pane Left")?.ranges).toEqual([
      [0, 1],
      [6, 7],
      [11, 12],
    ]);
  });
  test("scattered letters are one range per piece, adjacent letters merged", () => {
    expect(matchLabel("mapp", "Mark approved")?.ranges).toEqual([
      [0, 2],
      [6, 8],
    ]);
  });
  test("spaces in the query are skipped for scattered matches", () => {
    expect(matchLabel("gt b", "Go to Board")).not.toBeNull();
  });
  test("a camelCase hump is a word start", () => {
    expect(matchLabel("ck", "copyKey")?.ranges).toEqual([
      [0, 1],
      [4, 5],
    ]);
  });
});

describe("parsePaletteQuery", () => {
  test("> limits to commands and # to tickets, and the prefix leaves the query", () => {
    expect(parsePaletteQuery(">  approve ")).toEqual({ kind: "commands", q: "approve" });
    expect(parsePaletteQuery("#HAR-3")).toEqual({ kind: "tickets", q: "HAR-3" });
    expect(parsePaletteQuery("  #")).toEqual({ kind: "tickets", q: "" });
  });
  test("a prefix only counts at the start", () => {
    expect(parsePaletteQuery("fix #12")).toEqual({ kind: "all", q: "fix #12" });
    expect(parsePaletteQuery("a > b")).toEqual({ kind: "all", q: "a > b" });
  });
});

describe("recents", () => {
  test("corrupt storage reads as empty, and the next push repairs it", () => {
    for (const bad of ["{not json", '{"a":1}', "42", "null"]) {
      const s = memoryStorage({ [RECENT_KEY]: bad });
      expect(readRecents(s)).toEqual([]);
      expect(pushRecent("cmd:board", s)).toEqual(["cmd:board"]);
      expect(JSON.parse(s.data.get(RECENT_KEY)!)).toEqual(["cmd:board"]);
    }
  });
  test("non-string entries are dropped", () => {
    expect(readRecents(memoryStorage({ [RECENT_KEY]: '["a", 3, null, "b", "a"]' }))).toEqual(["a", "b"]);
  });
  test("storage that throws reads as empty and push still returns the list", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readRecents(broken)).toEqual([]);
    expect(pushRecent("x", broken)).toEqual(["x"]);
  });
  test("a push moves the id to the front once and keeps the last RECENT_MAX", () => {
    const s = memoryStorage();
    for (let i = 0; i < RECENT_MAX + 3; i++) pushRecent(`c${i}`, s);
    pushRecent("c5", s);
    const r = readRecents(s);
    expect(r.length).toBe(RECENT_MAX);
    expect(r[0]).toBe("c5");
    expect(r.filter((x) => x === "c5").length).toBe(1);
    expect(r).not.toContain("c0");
    expect(recentRanks(r).get("c5")).toBe(0);
  });
});
