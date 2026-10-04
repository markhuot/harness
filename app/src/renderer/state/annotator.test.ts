import { describe, expect, test } from "bun:test";
import type { DraftMark } from "@harness/shared/state";
import { annotatedName, browserShotName, stripExtension, emptyHistory, encodeWithinLimit, endRun, hasAnnotatorWork, HISTORY_LIMIT, offersAnnotate, recordChange, undo, type AnnotatorSnapshot, type Encode } from "./annotator";

const mark = (x: number, message = ""): DraftMark => ({ anchor: { x, y: 0.5 }, tail: null, message });
const snap = (marks: DraftMark[], note = ""): AnnotatorSnapshot => ({ marks, note });

describe("undo history", () => {
  test("undo steps back through changes, newest first, then runs out", () => {
    let h = emptyHistory();
    const s0 = snap([]);
    const s1 = snap([mark(0.1)]);
    h = recordChange(h, s0);
    h = recordChange(h, s1);
    const a = undo(h)!;
    expect(a.state).toBe(s1);
    const b = undo(a.history)!;
    expect(b.state).toBe(s0);
    expect(undo(b.history)).toBeNull();
  });

  test("a run of changes with the same key is one step; a new run (after endRun) is another", () => {
    let h = emptyHistory();
    const beforeTyping = snap([mark(0.1, "")]);
    h = recordChange(h, beforeTyping, "msg:0");
    h = recordChange(h, snap([mark(0.1, "a")]), "msg:0");
    h = recordChange(h, snap([mark(0.1, "ab")]), "msg:0");
    expect(h.past).toHaveLength(1);
    h = endRun(h);
    h = recordChange(h, snap([mark(0.1, "abc")]), "msg:0");
    expect(h.past).toHaveLength(2);
    // Undoing the second run, then the first, lands before any typing.
    expect(undo(undo(h)!.history)!.state).toBe(beforeTyping);
  });

  test("a keyless change always starts its own step, even right after a keyed run", () => {
    let h = recordChange(emptyHistory(), snap([]), "msg:0");
    h = recordChange(h, snap([mark(0.2)]));
    h = recordChange(h, snap([mark(0.3)]));
    expect(h.past).toHaveLength(3);
  });

  test("undo ends the run, so typing after it records a fresh step", () => {
    let h = recordChange(emptyHistory(), snap([]), "msg:0");
    h = undo(h)!.history;
    h = recordChange(h, snap([mark(0.1)]), "msg:0");
    expect(h.past).toHaveLength(1);
  });

  test("keeps at most HISTORY_LIMIT steps, dropping the oldest", () => {
    let h = emptyHistory();
    const first = snap([mark(0)]);
    h = recordChange(h, first);
    for (let i = 0; i < HISTORY_LIMIT; i++) h = recordChange(h, snap([mark(i / 1000)]));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past).not.toContain(first);
  });

  test("work to lose: a mark or a note with text, not a blank note", () => {
    expect(hasAnnotatorWork(snap([]))).toBe(false);
    expect(hasAnnotatorWork(snap([], "   "))).toBe(false);
    expect(hasAnnotatorWork(snap([], "see 1"))).toBe(true);
    expect(hasAnnotatorWork(snap([mark(0.5)]))).toBe(true);
  });
});

describe("encodeWithinLimit", () => {
  const encoder = (sizes: Record<string, number>) => {
    const calls: string[] = [];
    const encode: Encode = async (type, quality) => {
      const k = type === "image/png" ? "png" : `jpeg@${quality}`;
      calls.push(k);
      return new Blob([new Uint8Array(sizes[k] ?? 0)], { type });
    };
    return { encode, calls };
  };

  test("a PNG within the limit goes as is, without trying JPEG", async () => {
    const { encode, calls } = encoder({ png: 100 });
    const out = await encodeWithinLimit(encode, 100);
    expect(out.type).toBe("image/png");
    expect(calls).toEqual(["png"]);
  });

  test("a PNG over the limit becomes the best-quality JPEG that fits", async () => {
    const { encode, calls } = encoder({ png: 500, "jpeg@0.9": 150, "jpeg@0.8": 90, "jpeg@0.7": 50 });
    const out = await encodeWithinLimit(encode, 100);
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(90);
    expect(calls).toEqual(["png", "jpeg@0.9", "jpeg@0.8"]);
  });

  test("when nothing fits, the smallest attempt goes", async () => {
    const { encode } = encoder({ png: 500, "jpeg@0.9": 400, "jpeg@0.8": 300, "jpeg@0.7": 250, "jpeg@0.6": 260, "jpeg@0.5": 280 });
    const out = await encodeWithinLimit(encode, 100);
    expect(out.size).toBe(250);
  });
});

describe("names", () => {
  test("annotated-<base>, with the extension the encoding has, made safe for a file name", () => {
    expect(annotatedName("mockup", "image/png")).toBe("annotated-mockup.png");
    expect(annotatedName("Screen Shot 2026", "image/jpeg")).toBe("annotated-Screen-Shot-2026.jpg");
    expect(annotatedName("127.0.0.1", "image/png")).toBe("annotated-127.0.0.1.png");
    expect(annotatedName("", "image/png")).toBe("annotated-image.png");
    expect(annotatedName("???", "image/png")).toBe("annotated-image.png");
  });

  test("stripExtension drops a file's extension and folders, not a version or an address", () => {
    expect(stripExtension("/Users/me/Shots/Screen Shot.jpeg")).toBe("Screen Shot");
    expect(stripExtension("mockup.png")).toBe("mockup");
    expect(stripExtension("Settings mockup")).toBe("Settings mockup");
    expect(stripExtension("release 1.2")).toBe("release 1.2");
  });

  test("a browser page is named by its host, else its title", () => {
    expect(browserShotName("http://127.0.0.1:5173/settings", "Settings")).toBe("127.0.0.1");
    expect(browserShotName("about:blank", "Blank")).toBe("Blank");
    expect(browserShotName("not a url", "  ")).toBe("page");
  });
});

describe("offersAnnotate", () => {
  const base = { scoped: true, kind: "image" as const, failed: false, hasSource: true };
  test("an image that loaded, in a ticket, with a known source", () => expect(offersAnnotate(base)).toBe(true));
  test("not outside a ticket (a draft, the composer's pending list)", () => expect(offersAnnotate({ ...base, scoped: false })).toBe(false));
  test("not a video", () => expect(offersAnnotate({ ...base, kind: "video" })).toBe(false));
  test("not one that failed to load", () => expect(offersAnnotate({ ...base, failed: true })).toBe(false));
  test("not when the caller has no source for it", () => expect(offersAnnotate({ ...base, hasSource: false })).toBe(false));
});
