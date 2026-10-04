import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ANNOTATION_MARKS, MAX_ANNOTATION_MESSAGE, type MessageAnnotation, type PromptAttachment } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { formatAnnotations, normalizeAnnotations } from "./annotations";
import { png } from "./testing/media";

const dir = tempDir("harness-annotations-");
mkdirSync(dir, { recursive: true });
const file = (name: string, data: Uint8Array | string): PromptAttachment => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return { path, name, source: "file" };
};
const shot = file("shot.png", png(200, 100));
const notes = file("notes.md", "# notes");
// The extension says image; the bytes say otherwise.
const fake = file("fake.png", "not an image");
const files = [shot, notes, fake];

const good = () => ({
  attachment: 0,
  source: { kind: "attachment", id: "att_1", name: "mockup.png" },
  width: 200,
  height: 100,
  marks: [
    { n: 1, x: 50, y: 25, tailX: 150, tailY: 75, message: "  Make this bigger  " },
    { n: 2, x: 200, y: 100, message: "" },
  ],
});
const withMark = (patch: Record<string, unknown>, i = 0) => {
  const a = good();
  a.marks[i] = { ...a.marks[i]!, ...patch } as (typeof a.marks)[number];
  return [a];
};
const rejects = (raw: unknown, pattern: RegExp) => {
  let err: unknown;
  try {
    normalizeAnnotations(raw, files);
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ status: 400 });
  expect((err as Error).message).toMatch(pattern);
};

describe("normalizeAnnotations", () => {
  test("keeps a good entry, trims messages, drops unknown fields, and keeps a click without a tail tail-less", () => {
    const raw = [{ ...good(), extra: 1, source: { ...good().source, junk: true } }];
    (raw[0]!.marks[1] as Record<string, unknown>).tailX = null;
    (raw[0]!.marks[1] as Record<string, unknown>).tailY = null;
    expect(normalizeAnnotations(raw, files)).toEqual([
      {
        attachment: 0,
        source: { kind: "attachment", id: "att_1", name: "mockup.png" },
        width: 200,
        height: 100,
        marks: [
          { n: 1, x: 50, y: 25, tailX: 150, tailY: 75, message: "Make this bigger" },
          { n: 2, x: 200, y: 100, message: "" },
        ],
      },
    ]);
  });

  test("accepts each source kind", () => {
    const sources = [
      { kind: "prompt-attachment", index: 0, name: "a.png" },
      { kind: "message-attachment", entryId: "e1", index: 2, name: "b.png" },
      { kind: "browser", url: "http://x.test/", title: "X", tabId: 2, viewport: { width: 100, height: 50 }, scale: 2 },
    ];
    for (const source of sources) expect(normalizeAnnotations([{ ...good(), source }], files)[0]!.source).toEqual(source as MessageAnnotation["source"]);
  });

  test("refuses anything but a list", () => {
    rejects({}, /must be a list/);
    rejects("x", /must be a list/);
  });

  test("refuses an attachment index that isn't one of the message's files, or one annotated twice", () => {
    rejects([{ ...good(), attachment: 3 }], /index of a file/);
    rejects([{ ...good(), attachment: -1 }], /index of a file/);
    rejects([{ ...good(), attachment: 0.5 }], /index of a file/);
    rejects([{ ...good(), attachment: "0" }], /index of a file/);
    rejects([good(), good()], /annotated twice/);
  });

  test("refuses a file that isn't an image, by its bytes", () => {
    rejects([{ ...good(), attachment: 1 }], /notes\.md isn't a PNG/);
    rejects([{ ...good(), attachment: 2 }], /fake\.png isn't a PNG/);
  });

  test("refuses a size that isn't positive whole pixels", () => {
    rejects([{ ...good(), width: 0 }], /width and height/);
    rejects([{ ...good(), height: 10.5 }], /width and height/);
    rejects([{ ...good(), width: "200" }], /width and height/);
  });

  test("refuses no marks and too many", () => {
    rejects([{ ...good(), marks: [] }], /at least one/);
    rejects([{ ...good(), marks: undefined }], /at least one/);
    const many = Array.from({ length: MAX_ANNOTATION_MARKS + 1 }, (_, i) => ({ n: i + 1, x: 1, y: 1, message: "" }));
    rejects([{ ...good(), marks: many }], new RegExp(`at most ${MAX_ANNOTATION_MARKS}`));
    const most = many.slice(0, MAX_ANNOTATION_MARKS);
    expect(normalizeAnnotations([{ ...good(), marks: most }], files)[0]!.marks).toHaveLength(MAX_ANNOTATION_MARKS);
  });

  test("refuses numbers that aren't 1…k in order", () => {
    rejects(withMark({ n: 2 }), /numbered 1, 2, 3/);
    rejects(withMark({ n: 3 }, 1), /numbered 1, 2, 3/);
    const a = good();
    a.marks.reverse();
    rejects([a], /numbered/);
  });

  test("refuses a point or an arrow start outside the image, and half a tail", () => {
    rejects(withMark({ x: 201 }), /the point must be inside the 200×100 image/);
    rejects(withMark({ y: -1 }), /the point must be inside/);
    rejects(withMark({ x: Number.NaN }), /the point must be inside/);
    rejects(withMark({ x: "5" }), /the point must be inside/);
    rejects(withMark({ tailY: 101 }), /arrow's start must be inside/);
    rejects(withMark({ tailY: undefined }), /tailX and tailY go together/);
    rejects(withMark({ tailX: 3 }, 1), /go together/);
  });

  test("refuses a message that isn't a string, or is too long", () => {
    rejects(withMark({ message: undefined }), /message must be a string/);
    rejects(withMark({ message: 5 }), /message must be a string/);
    rejects(withMark({ message: "x".repeat(MAX_ANNOTATION_MESSAGE + 1) }), /over 2000 characters/);
    // Trimmed before it's measured.
    expect(normalizeAnnotations(withMark({ message: ` ${"x".repeat(MAX_ANNOTATION_MESSAGE)} ` }), files)[0]!.marks[0]!.message).toHaveLength(MAX_ANNOTATION_MESSAGE);
  });

  test("refuses a malformed source for its kind", () => {
    const bad: unknown[] = [
      undefined,
      { kind: "nope", name: "a" },
      { kind: "attachment", name: "a" },
      { kind: "attachment", id: "x" },
      { kind: "prompt-attachment", index: -1, name: "a" },
      { kind: "message-attachment", index: 0, name: "a" },
      { kind: "message-attachment", entryId: "e", index: 1.5, name: "a" },
      { kind: "browser", title: "t", tabId: 1, viewport: { width: 1, height: 1 }, scale: 1 },
      { kind: "browser", url: "u", title: "t", tabId: 0, viewport: { width: 1, height: 1 }, scale: 1 },
      { kind: "browser", url: "u", title: "t", tabId: 1, viewport: { width: 1 }, scale: 1 },
      { kind: "browser", url: "u", title: "t", tabId: 1, viewport: { width: 1, height: 1 }, scale: 0 },
    ];
    for (const source of bad) rejects([{ ...good(), source }], /source/);
  });
});

describe("formatAnnotations", () => {
  test("nothing for no annotations", () => {
    expect(formatAnnotations(undefined, files)).toBe("");
    expect(formatAnnotations([], files)).toBe("");
  });

  test("a spec image: its file, size and origin, then one line per note with pixels and percentages", () => {
    const [a] = normalizeAnnotations([good()], files);
    const text = formatAnnotations([a!], files);
    expect(text.startsWith("\n\n<annotations>\n")).toBe(true);
    expect(text.endsWith("\n</annotations>")).toBe(true);
    expect(text).toContain(`${shot.path} (200×100 px) is the spec image "mockup.png". The human drew the numbered notes below onto it.`);
    expect(text).toContain("1. (50, 25) px, 25% across, 25% down, arrow from (150, 75) px: Make this bigger");
    expect(text).toContain("2. (200, 100) px, 100% across, 100% down: (no note)");
    expect(text).not.toContain("CSS");
  });

  test("a browser page: the page, tab and viewport, and every point in CSS pixels at its scale", () => {
    const source = { kind: "browser", url: "http://localhost:3000/login", title: "Sign in", tabId: 2, viewport: { width: 100, height: 50 }, scale: 2 };
    const marks = [
      { n: 1, x: 41, y: 30, message: "" },
      { n: 2, x: 100, y: 50, tailX: 181, tailY: 9, message: "Wrong colour\nshould be blue" },
    ];
    const [a] = normalizeAnnotations([{ attachment: 0, source, width: 200, height: 100, marks }], files);
    const text = formatAnnotations([a!], files);
    expect(text).toContain(
      `${shot.path} (200×100 px) is a screenshot of browser tab 2, "Sign in" at http://localhost:3000/login (viewport 100×50 CSS px at 2× scale).`,
    );
    // 41 / 2 = 20.5 rounds to 21; a click has no arrow.
    expect(text).toContain("1. (41, 30) px = (21, 15) CSS px, 21% across, 30% down: (no note)");
    expect(text).toContain("2. (100, 50) px = (50, 25) CSS px, 50% across, 50% down, arrow from (181, 9) px = (91, 5) CSS px: Wrong colour\n   should be blue");
  });

  test("names where each other kind of image came from", () => {
    const of = (source: unknown) => formatAnnotations(normalizeAnnotations([{ ...good(), source }], files), files);
    expect(of({ kind: "prompt-attachment", index: 0, name: "brief.png" })).toContain(`is the ticket's attached file "brief.png"`);
    expect(of({ kind: "message-attachment", entryId: "e", index: 0, name: "old.png" })).toContain(`is the file "old.png" sent with an earlier message`);
  });
});
