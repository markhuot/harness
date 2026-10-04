import { describe, expect, test } from "bun:test";
import type { AnnotationPage } from "@harness/shared";
import type { DraftMark } from "@harness/shared/state";
import { annotationFromMarks, browserShotName, coverRect, emptyHistory, endRun, hasAnnotatorWork, HISTORY_LIMIT, recordChange, undo, type AnnotatorSnapshot } from "./annotator";

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
    // Every mark of a reopened annotation deleted: Add would take its notes off, so closing loses that.
    expect(hasAnnotatorWork([], reopened)).toBe(true);
  });
});

describe("annotationFromMarks", () => {
  const page: AnnotationPage = { url: "http://127.0.0.1:5173/", title: "App", tabId: 2, viewport: { width: 640, height: 400 }, scale: 2 };
  const marks: DraftMark[] = [
    { anchor: { x: 0.5, y: 0.25 }, tail: { x: 0.1, y: 0.1 }, message: "  too tight  " },
    { anchor: { x: 1, y: 1 }, tail: null, message: "" },
  ];

  test("the marks in the image's pixels, numbered in order, messages trimmed", () => {
    expect(annotationFromMarks(marks, 1280, 800)).toEqual({
      width: 1280,
      height: 800,
      marks: [
        { n: 1, x: 640, y: 200, tailX: 128, tailY: 80, message: "too tight" },
        { n: 2, x: 1280, y: 800, message: "" },
      ],
    });
  });

  test("a screenshot keeps its page; re-annotating keeps the page it had", () => {
    expect(annotationFromMarks(marks, 1280, 800, page)?.page).toEqual(page);
    expect(annotationFromMarks(marks, 1280, 800, null)).not.toHaveProperty("page");
  });

  test("no marks left: null, which takes the notes off the attachment", () => {
    expect(annotationFromMarks([], 1280, 800, page)).toBeNull();
  });
});

describe("coverRect", () => {
  test("a wide image fills the height and overflows left and right, centred", () => {
    const r = coverRect(32, 32, 1280, 800);
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100) / 100)).toEqual([-9.6, 0, 51.2, 32]);
  });
  test("a tall image fills the width and overflows top and bottom", () => {
    expect(coverRect(40, 20, 100, 200)).toEqual({ x: 0, y: -30, w: 40, h: 80 });
  });
  test("an image of no size covers the box as is (nothing to scale)", () => {
    expect(coverRect(32, 32, 0, 800)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });
});

describe("browserShotName", () => {
  test("a browser page is named by its host, else its title", () => {
    expect(browserShotName("http://127.0.0.1:5173/settings", "Settings")).toBe("127.0.0.1");
    expect(browserShotName("about:blank", "Blank")).toBe("Blank");
    expect(browserShotName("not a url", "  ")).toBe("page");
  });
});
