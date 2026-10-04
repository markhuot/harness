import { describe, expect, test } from "bun:test";
import type { MessageAnnotation, PromptAttachment } from "@harness/shared";
import type { DraftMark } from "@harness/shared/state";
import {
  annotatedName,
  browserShotName,
  carryAnnotations,
  stripExtension,
  emptyHistory,
  encodeWithinLimit,
  endRun,
  hasAnnotatorWork,
  HISTORY_LIMIT,
  offersAnnotate,
  pendingSource,
  recordChange,
  sourceBaseName,
  undo,
  withAnnotatedImage,
  type AnnotatorSnapshot,
  type Encode,
} from "./annotator";

const mark = (x: number, message = ""): DraftMark => ({ anchor: { x, y: 0.5 }, tail: null, message });
const snap = (marks: DraftMark[]): AnnotatorSnapshot => ({ marks });

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

  test("work to lose: marks, unless they're the ones it reopened with", () => {
    expect(hasAnnotatorWork([])).toBe(false);
    expect(hasAnnotatorWork([mark(0.5)])).toBe(true);
    const reopened = [mark(0.5, "too tight")];
    expect(hasAnnotatorWork([mark(0.5, "too tight")], reopened)).toBe(false);
    expect(hasAnnotatorWork([mark(0.5, "too tight!")], reopened)).toBe(true);
    expect(hasAnnotatorWork([mark(0.6, "too tight")], reopened)).toBe(true);
    expect(hasAnnotatorWork([...reopened, mark(0.1)], reopened)).toBe(true);
    // Every mark deleted: nothing left to add, so nothing to lose.
    expect(hasAnnotatorWork([], reopened)).toBe(false);
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
  const base = { scoped: true, kind: "image" as const, failed: false, offered: true };
  test("an image that loaded, where there's a message to add it to, offered by its list", () => expect(offersAnnotate(base)).toBe(true));
  test("not outside an annotate scope", () => expect(offersAnnotate({ ...base, scoped: false })).toBe(false));
  test("not a video", () => expect(offersAnnotate({ ...base, kind: "video" })).toBe(false));
  test("not one that failed to load", () => expect(offersAnnotate({ ...base, failed: true })).toBe(false));
  test("not when its list doesn't offer it (a reopened draft's annotated picture)", () => expect(offersAnnotate({ ...base, offered: false })).toBe(false));
});

describe("sourceBaseName", () => {
  test("a file or attachment by its name without the extension; a browser page by its host", () => {
    expect(sourceBaseName({ kind: "file", name: "Screen Shot.png" })).toBe("Screen Shot");
    expect(sourceBaseName({ kind: "attachment", id: "a1", name: "Settings mockup" })).toBe("Settings mockup");
    expect(sourceBaseName({ kind: "message-attachment", entryId: "e", index: 0, name: "annotated-mockup.png" })).toBe("annotated-mockup");
    expect(sourceBaseName({ kind: "browser", url: "http://127.0.0.1:5173/x", title: "X", tabId: 1, viewport: { width: 1, height: 1 }, scale: 1 })).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// The annotated picture in a message
// ---------------------------------------------------------------------------

const file = (name: string): PromptAttachment => ({ path: `/tmp/${name}`, name, source: "upload" });
const note = (attachment: number, message: string): MessageAnnotation => ({
  attachment,
  source: { kind: "file", name: `f${attachment}.png` },
  width: 100,
  height: 50,
  marks: [{ n: 1, x: 10, y: 10, message }],
});
const msgs = (as: MessageAnnotation[]) => as.map((a) => `${a.attachment}:${a.marks[0]!.message}`);

describe("carryAnnotations", () => {
  const [a, b, c] = [file("a.png"), file("b.png"), file("c.png")];
  test("a file removed: its notes go, the later ones move up", () => {
    expect(msgs(carryAnnotations([a, b, c], [a, c], [note(1, "on b"), note(2, "on c")]))).toEqual(["1:on c"]);
  });
  test("a send that took the first files: what's left keeps its notes at its new index", () => {
    const d = file("d.png");
    // a and b went; d was attached while the message was on its way, then c's notes stay with c.
    expect(msgs(carryAnnotations([a, b, c, d], [c, d], [note(0, "on a"), note(2, "on c"), note(3, "on d")]))).toEqual(["0:on c", "1:on d"]);
  });
  test("files added at the end leave the notes where they are", () => {
    expect(msgs(carryAnnotations([a, b], [a, b, c], [note(1, "on b")]))).toEqual(["1:on b"]);
  });
  test("a note pointing past the list (a stale index) is dropped", () => {
    expect(carryAnnotations([a], [a], [note(3, "nowhere")])).toEqual([]);
  });
  test("the result is in attachment order, whatever order the notes came in", () => {
    expect(msgs(carryAnnotations([a, b, c], [c, b, a], [note(0, "on a"), note(2, "on c")]))).toEqual(["0:on c", "2:on a"]);
  });
});

describe("withAnnotatedImage", () => {
  const [a, b, c] = [file("a.png"), file("b.png"), file("c.png")];
  const shot = file("annotated-b.png");
  const image = { attachment: shot, annotation: { source: { kind: "file" as const, name: "b.png" }, width: 100, height: 50, marks: [{ n: 1, x: 1, y: 1, message: "new" }] } };

  test("re-annotating a waiting file replaces it in place with its notes, the other notes untouched", () => {
    const out = withAnnotatedImage({ attachments: [a, b, c], annotations: [note(0, "on a"), note(1, "old b"), note(2, "on c")] }, image, b.path, 10)!;
    expect(out.attachments.map((x) => x.name)).toEqual(["a.png", "annotated-b.png", "c.png"]);
    expect(msgs(out.annotations)).toEqual(["0:on a", "1:new", "2:on c"]);
  });
  test("from elsewhere (or the file it replaced is gone): it goes at the end", () => {
    const out = withAnnotatedImage({ attachments: [a], annotations: [note(0, "on a")] }, image, "/tmp/gone.png", 10)!;
    expect(out.attachments.map((x) => x.name)).toEqual(["a.png", "annotated-b.png"]);
    expect(msgs(out.annotations)).toEqual(["0:on a", "1:new"]);
    expect(withAnnotatedImage({ attachments: [], annotations: [] }, image, null, 10)!.annotations[0]!.attachment).toBe(0);
  });
  test("a full list takes no new picture, but a replacement still fits", () => {
    expect(withAnnotatedImage({ attachments: [a, b], annotations: [] }, image, null, 2)).toBeNull();
    expect(withAnnotatedImage({ attachments: [a, b], annotations: [] }, image, b.path, 2)!.attachments).toHaveLength(2);
  });
});

describe("pendingSource", () => {
  test("a plain waiting file is its own source; an annotated one keeps the source it was first annotated from", () => {
    expect(pendingSource([], 0, file("shot.png"))).toEqual({ kind: "file", name: "shot.png" });
    const fromSpec: MessageAnnotation = { ...note(1, "x"), source: { kind: "attachment", id: "att1", name: "Settings mockup" } };
    expect(pendingSource([fromSpec], 1, file("annotated-Settings-mockup.png"))).toEqual(fromSpec.source);
    expect(pendingSource([fromSpec], 0, file("other.png"))).toEqual({ kind: "file", name: "other.png" });
  });
});
