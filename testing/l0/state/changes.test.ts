import { describe, expect, test } from "bun:test";
import {
  AUTO_SPLIT_WIDTH,
  MAX_FILES,
  MAX_TICKETS,
  SIDEBAR_KEY,
  STYLE_KEY,
  VIEWED_KEY,
  changesApi,
  changesEmptyState,
  changesNotices,
  effectiveStyle,
  fileDecoration,
  fingerprint,
  hash,
  isCollapsed,
  plural,
  prune,
  readSidebarCollapsed,
  readStyle,
  readViewed,
  relTime,
  sameMarks,
  saveSidebarCollapsed,
  saveStyle,
  saveViewed,
  type ChangedFile,
  type Fingerprinted,
} from "../../../shared/src/state/changes";

type Store = Pick<Storage, "getItem" | "setItem">;
const memory = (initial: Record<string, string> = {}): Store & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};
const throwing: Store = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
};

const file = (over: Partial<ChangedFile> = {}): ChangedFile => ({ path: "a.ts", status: "modified", additions: 2, deletions: 1, binary: false, ...over });

describe("changesApi", () => {
  test("encodes the ticket and path; ref only rides along on the old side", () => {
    expect(changesApi.changes("A B")).toBe("/plugins/git/api/changes?ticket=A%20B");
    expect(changesApi.log("A&B")).toBe("/plugins/git/api/log?ticket=A%26B");
    expect(changesApi.file("T-1", "old", "src/a b.ts", "abc")).toBe("/plugins/git/api/file?ticket=T-1&side=old&path=src%2Fa%20b.ts&ref=abc");
    expect(changesApi.file("T-1", "new", "x", "abc")).not.toContain("ref=");
    expect(changesApi.file("T-1", "old", "x", null)).not.toContain("ref=");
    expect(changesApi.file("T-1", "old", "x")).not.toContain("ref=");
  });
});

describe("plural / fileDecoration", () => {
  test("pluralises everything except exactly one", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "file")).toBe("2 files");
  });

  test("binary wins over everything", () => {
    expect(fileDecoration(file({ binary: true, status: "renamed", oldPath: "o" }))).toEqual({ text: "bin", title: "Binary file" });
  });

  test("a pure rename shows 'moved' with the old path; without an old path there is no decoration", () => {
    expect(fileDecoration(file({ status: "renamed", additions: 0, deletions: 0, oldPath: "old.ts" }))).toEqual({ text: "moved", title: "Renamed from old.ts" });
    expect(fileDecoration(file({ status: "renamed", additions: 0, deletions: 0 }))).toBeNull();
  });

  test("a rename that also edits shows counts; counts carry tones", () => {
    const d = fileDecoration(file({ status: "renamed", oldPath: "o", additions: 3, deletions: 0 }))!;
    expect(d.text).toBe("+3 −0");
    expect(d.parts).toEqual([{ text: "+3", tone: "add" }, { text: " " }, { text: "−0", tone: "del" }]);
    expect(d.title).toBe("3 additions, 0 deletions");
  });

  test("a rename with only deletions is not 'moved'", () => {
    expect(fileDecoration(file({ status: "renamed", additions: 0, deletions: 4, oldPath: "o" }))!.text).toBe("+0 −4");
  });
});

describe("changesEmptyState / changesNotices", () => {
  test("branch mode names the branch and base, with fallbacks", () => {
    expect(changesEmptyState({ mode: "branch", branch: "feat", base: "main" }).detail).toStartWith("feat matches main ");
    expect(changesEmptyState({ mode: "branch", branch: null, base: null }).detail).toStartWith("This branch matches its base ");
  });

  test("pinned mode says the worktree was removed; workdir mode talks about the tree", () => {
    const pinned = changesEmptyState({ mode: "pinned", branch: "feat", base: null });
    expect(pinned.title).toBe("No changes");
    expect(pinned.detail).toContain("feat didn't change anything");
    expect(changesEmptyState({ mode: "pinned", branch: null, base: null }).detail).toStartWith("This branch didn't");
    expect(changesEmptyState({ mode: "workdir", branch: "x", base: "HEAD" }).detail).toStartWith("The working tree is clean");
  });

  test("notices: truncation counts files, a refresh error only shows once something loaded", () => {
    const loaded = { truncated: true, files: [file(), file({ path: "b" })] };
    expect(changesNotices(loaded, null)).toEqual(["This diff is large, so only the first part is shown. 2 files changed in total."]);
    expect(changesNotices({ truncated: true, files: [file()] }, null)[0]).toContain("1 file changed");
    expect(changesNotices({ truncated: false, files: [] }, "boom")).toEqual(["Refresh failed: boom"]);
    expect(changesNotices(null, "boom")).toEqual([]);
    expect(changesNotices(null, null)).toEqual([]);
    expect(changesNotices(loaded, "boom")).toHaveLength(2);
  });
});

describe("relTime", () => {
  const now = 10_000_000;
  test("buckets: now, minutes, hours, days", () => {
    expect(relTime(now - 59_000, now)).toBe("just now");
    expect(relTime(now - 60_000, now)).toBe("1m ago");
    expect(relTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relTime(now - 47 * 3_600_000, now)).toBe("2d ago");
    expect(relTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("a time in the future reads as just now", () => {
    expect(relTime(now + 5000, now)).toBe("just now");
  });
});

describe("style and sidebar preferences", () => {
  test("a saved style reads back; junk or empty storage gives null", () => {
    const s = memory();
    expect(readStyle(() => s)).toBeNull();
    saveStyle("split", () => s);
    expect(readStyle(() => s)).toBe("split");
    saveStyle("unified", () => s);
    expect(readStyle(() => s)).toBe("unified");
    s.data[STYLE_KEY] = "wide";
    expect(readStyle(() => s)).toBeNull();
  });

  test("storage that throws on read gives null; a throwing write is dropped silently", () => {
    expect(readStyle(() => throwing)).toBeNull();
    expect(() => saveStyle("split", () => throwing)).not.toThrow();
    expect(() => saveSidebarCollapsed(true, () => throwing)).not.toThrow();
    expect(readSidebarCollapsed(() => throwing)).toBe(false);
  });

  test("a store that cannot even be obtained reads as no preference", () => {
    const missing = () => {
      throw new ReferenceError("localStorage is not defined");
    };
    expect(readStyle(missing)).toBeNull();
    expect(() => saveStyle("split", missing)).not.toThrow();
  });

  test("effectiveStyle: chosen wins; otherwise split from the threshold up", () => {
    expect(effectiveStyle("unified", 5000)).toBe("unified");
    expect(effectiveStyle("split", 10)).toBe("split");
    expect(effectiveStyle(null, AUTO_SPLIT_WIDTH)).toBe("split");
    expect(effectiveStyle(null, AUTO_SPLIT_WIDTH - 1)).toBe("unified");
  });

  test("sidebar: only an explicit 1 means collapsed", () => {
    const s = memory();
    expect(readSidebarCollapsed(() => s)).toBe(false);
    saveSidebarCollapsed(true, () => s);
    expect(s.data[SIDEBAR_KEY]).toBe("1");
    expect(readSidebarCollapsed(() => s)).toBe(true);
    saveSidebarCollapsed(false, () => s);
    expect(readSidebarCollapsed(() => s)).toBe(false);
    s.data[SIDEBAR_KEY] = "true";
    expect(readSidebarCollapsed(() => s)).toBe(false);
  });
});

describe("hash / fingerprint", () => {
  const diff = (over: Partial<Fingerprinted> = {}): Fingerprinted => ({
    name: "a.ts",
    type: "change",
    hunks: [{ deletionStart: 1, deletionCount: 1, additionStart: 1, additionCount: 1 }],
    deletionLines: ["old"],
    additionLines: ["new"],
    ...over,
  });

  test("hash is deterministic and distinguishes different strings", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
    expect(hash("")).toBe(hash(""));
  });

  test("equal diffs fingerprint equal", () => {
    expect(fingerprint(diff())).toBe(fingerprint(diff()));
  });

  test("every field a viewer would notice changes the fingerprint", () => {
    const base = fingerprint(diff());
    for (const changed of [
      diff({ name: "b.ts" }),
      diff({ prevName: "old.ts" }),
      diff({ type: "rename-pure" }),
      diff({ mode: "100755" }),
      diff({ prevMode: "100644" }),
      diff({ hunks: [{ deletionStart: 2, deletionCount: 1, additionStart: 1, additionCount: 1 }] }),
      diff({ deletionLines: ["older"] }),
      diff({ additionLines: ["newer"] }),
    ]) {
      expect(fingerprint(changed)).not.toBe(base);
    }
  });

  test("a line moving from deletions to additions is a different diff", () => {
    expect(fingerprint(diff({ deletionLines: ["x"], additionLines: [] }))).not.toBe(fingerprint(diff({ deletionLines: [], additionLines: ["x"] })));
  });
});

describe("viewed marks storage", () => {
  const marks = (...pairs: [string, string][]) => new Map(pairs);

  test("a saved ticket reads back, other tickets stay empty", () => {
    const s = memory();
    saveViewed("T-1", marks(["a", "fp1"], ["b", "fp2"]), () => s, 1);
    expect([...readViewed("T-1", () => s)]).toEqual([["a", "fp1"], ["b", "fp2"]]);
    expect(readViewed("T-2", () => s).size).toBe(0);
  });

  test("saving an empty map removes the ticket", () => {
    const s = memory();
    saveViewed("T-1", marks(["a", "x"]), () => s, 1);
    saveViewed("T-1", new Map(), () => s, 2);
    expect(readViewed("T-1", () => s).size).toBe(0);
    expect(JSON.parse(s.data[VIEWED_KEY]!)).toEqual({});
  });

  test("garbage storage reads as nothing viewed and is overwritten by a save", () => {
    for (const raw of ["not json", "[]", "null", "42", ""]) {
      const s = memory({ [VIEWED_KEY]: raw });
      expect(readViewed("T-1", () => s).size).toBe(0);
    }
    const s = memory({ [VIEWED_KEY]: "not json" });
    saveViewed("T-1", marks(["a", "x"]), () => s, 1);
    expect(readViewed("T-1", () => s).get("a")).toBe("x");
  });

  test("malformed entries are skipped: non-string fingerprints and a bad files shape", () => {
    const s = memory({ [VIEWED_KEY]: JSON.stringify({ "T-1": { at: 1, files: { ok: "fp", bad: 5, worse: null } }, "T-2": { at: 1, files: ["x"] }, "T-3": { at: 1, files: "x" } }) });
    expect([...readViewed("T-1", () => s)]).toEqual([["ok", "fp"]]);
    expect(readViewed("T-2", () => s).size).toBe(0);
    expect(readViewed("T-3", () => s).size).toBe(0);
  });

  test("throwing storage: reads empty, writes are dropped", () => {
    expect(readViewed("T-1", () => throwing).size).toBe(0);
    expect(() => saveViewed("T-1", marks(["a", "x"]), () => throwing, 1)).not.toThrow();
  });

  test("a ticket keeps at most MAX_FILES marks, the most recent ones", () => {
    const s = memory();
    const many = new Map<string, string>();
    for (let i = 0; i < MAX_FILES + 5; i++) many.set(`f${i}`, "x");
    saveViewed("T-1", many, () => s, 1);
    const back = readViewed("T-1", () => s);
    expect(back.size).toBe(MAX_FILES);
    expect(back.has("f0")).toBe(false);
    expect(back.has(`f${MAX_FILES + 4}`)).toBe(true);
  });

  test("beyond MAX_TICKETS the least recently written ticket is evicted", () => {
    const s = memory();
    for (let i = 0; i < MAX_TICKETS; i++) saveViewed(`T-${i}`, marks(["a", "x"]), () => s, 100 + i);
    saveViewed("NEW", marks(["a", "x"]), () => s, 1000);
    expect(readViewed("T-0", () => s).size).toBe(0);
    expect(readViewed("T-1", () => s).size).toBe(1);
    expect(readViewed("NEW", () => s).size).toBe(1);
    expect(Object.keys(JSON.parse(s.data[VIEWED_KEY]!))).toHaveLength(MAX_TICKETS);
  });

  test("re-saving an existing ticket refreshes its age instead of evicting it", () => {
    const s = memory();
    for (let i = 0; i < MAX_TICKETS; i++) saveViewed(`T-${i}`, marks(["a", "x"]), () => s, 100 + i);
    saveViewed("T-0", marks(["a", "y"]), () => s, 500);
    saveViewed("NEW", marks(["a", "x"]), () => s, 600);
    expect(readViewed("T-0", () => s).get("a")).toBe("y");
    expect(readViewed("T-1", () => s).size).toBe(0);
  });

  test("entries without a numeric timestamp are dropped on the next save", () => {
    const s = memory({ [VIEWED_KEY]: JSON.stringify({ old: { files: { a: "x" } } }) });
    saveViewed("T-1", marks(["a", "x"]), () => s, 1);
    expect(readViewed("old", () => s).size).toBe(0);
  });
});

describe("prune / sameMarks / isCollapsed", () => {
  test("keeps unchanged fingerprints, drops changed ones and files no longer changed", () => {
    const viewed = new Map([["same", "1"], ["edited", "1"], ["gone", "1"]]);
    const current = new Map([["same", "1"], ["edited", "2"]]);
    expect([...prune(viewed, current, new Set(["same", "edited"]))]).toEqual([["same", "1"]]);
  });

  test("a changed file missing from the parsed diff (truncated) keeps its mark", () => {
    const viewed = new Map([["unparsed", "1"], ["gone", "1"]]);
    const out = prune(viewed, new Map(), new Set(["unparsed"]));
    expect([...out]).toEqual([["unparsed", "1"]]);
  });

  test("sameMarks compares size and values, not order", () => {
    expect(sameMarks(new Map([["a", "1"], ["b", "2"]]), new Map([["b", "2"], ["a", "1"]]))).toBe(true);
    expect(sameMarks(new Map([["a", "1"]]), new Map([["a", "2"]]))).toBe(false);
    expect(sameMarks(new Map([["a", "1"]]), new Map([["a", "1"], ["b", "1"]]))).toBe(false);
    expect(sameMarks(new Map([["a", "1"]]), new Map([["b", "1"]]))).toBe(false);
  });

  test("collapsed: viewed collapses by default; a toggle for the same diff version overrides; a stale toggle does not", () => {
    expect(isCollapsed(true, undefined, "fp")).toBe(true);
    expect(isCollapsed(false, undefined, "fp")).toBe(false);
    expect(isCollapsed(true, { fp: "fp", collapsed: false }, "fp")).toBe(false);
    expect(isCollapsed(false, { fp: "fp", collapsed: true }, "fp")).toBe(true);
    expect(isCollapsed(true, { fp: "old", collapsed: false }, "fp")).toBe(true);
  });
});
