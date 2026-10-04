import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ANNOTATION_MARKS, MAX_ANNOTATION_MESSAGE, MAX_ANNOTATION_PATH, MAX_ANNOTATION_TEXT, type Attachment } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { annotationLines, compactNotes, normalizeAnnotation } from "./annotations";
import { resolveAttachments, runAttachments } from "./attachment-lists";
import { openDb } from "./db";
import { Store } from "./store";
import { png } from "./testing/media";

const dir = tempDir("harness-annotations-");
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
const registry = new Store(openDb(":memory:")).attachments;
/** The list a create, PATCH or message stores for these inputs. */
const normalize = (raw: unknown, previous: readonly Attachment[] = []) => resolveAttachments(raw, previous, registry, uploads);
const write = (name: string, data: Uint8Array | string) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};
const shot = write("shot.png", png(200, 100));
const notes = write("notes.md", "# notes");
// The extension says image; the bytes say otherwise.
const fake = write("fake.png", "not an image");

const good = () => ({
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
  return a;
};
const page = { url: "http://localhost:3000/login", title: "Sign in", tabId: 2, viewport: { width: 1280, height: 800 }, scale: 1 };
const rejects = (raw: unknown, pattern: RegExp) => {
  let err: unknown;
  try {
    normalizeAnnotation(raw, "attachments[0]");
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ status: 400 });
  expect((err as Error).message).toMatch(pattern);
};

describe("normalizeAnnotation", () => {
  test("keeps a good one, trims messages, drops unknown fields, and keeps a click without a tail tail-less", () => {
    const raw = { ...good(), extra: 1, page: { ...page, junk: true } };
    (raw.marks[1] as Record<string, unknown>).tailX = null;
    (raw.marks[1] as Record<string, unknown>).tailY = null;
    expect(normalizeAnnotation(raw, "a")).toEqual({
      width: 200,
      height: 100,
      marks: [
        { n: 1, x: 50, y: 25, tailX: 150, tailY: 75, message: "Make this bigger" },
        { n: 2, x: 200, y: 100, message: "" },
      ],
      page,
    });
    expect(normalizeAnnotation({ ...good(), page: null }, "a")).not.toHaveProperty("page");
  });

  test("refuses anything but an object", () => {
    rejects([], /annotation must be/);
    rejects("x", /annotation must be/);
  });

  test("refuses a size that isn't positive whole pixels", () => {
    rejects({ ...good(), width: 0 }, /width and height/);
    rejects({ ...good(), height: 10.5 }, /width and height/);
    rejects({ ...good(), width: "200" }, /width and height/);
  });

  test("refuses no marks and too many", () => {
    rejects({ ...good(), marks: [] }, /at least one/);
    rejects({ ...good(), marks: undefined }, /at least one/);
    const many = Array.from({ length: MAX_ANNOTATION_MARKS + 1 }, (_, i) => ({ n: i + 1, x: 1, y: 1, message: "" }));
    rejects({ ...good(), marks: many }, new RegExp(`at most ${MAX_ANNOTATION_MARKS}`));
    expect(normalizeAnnotation({ ...good(), marks: many.slice(0, MAX_ANNOTATION_MARKS) }, "a").marks).toHaveLength(MAX_ANNOTATION_MARKS);
  });

  test("refuses numbers that aren't 1…k in order", () => {
    rejects(withMark({ n: 2 }), /numbered 1, 2, 3/);
    rejects(withMark({ n: 3 }, 1), /numbered 1, 2, 3/);
    const a = good();
    a.marks.reverse();
    rejects(a, /numbered/);
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
    expect(normalizeAnnotation(withMark({ message: ` ${"x".repeat(MAX_ANNOTATION_MESSAGE)} ` }), "a").marks[0]!.message).toHaveLength(MAX_ANNOTATION_MESSAGE);
  });

  test("a mark's element (path, text) is kept on a browser screenshot, within its limits, and refused anywhere else", () => {
    const onPage = (patch: Record<string, unknown>) => ({ ...withMark(patch), page });
    const kept = normalizeAnnotation(onPage({ path: "#login > button", text: "Sign in" }), "a").marks[0]!;
    expect([kept.path, kept.text]).toEqual(["#login > button", "Sign in"]);
    expect(normalizeAnnotation(onPage({ path: "x".repeat(MAX_ANNOTATION_PATH), text: "y".repeat(MAX_ANNOTATION_TEXT) }), "a").marks[0]!.text).toHaveLength(MAX_ANNOTATION_TEXT);
    // Unknown fields still don't pass through, and a mark without an element has none.
    expect(normalizeAnnotation({ ...good(), page }, "a").marks[0]).not.toHaveProperty("path");
    rejects(onPage({ path: "x".repeat(MAX_ANNOTATION_PATH + 1) }), /path is over 1000 characters/);
    rejects(onPage({ text: "y".repeat(MAX_ANNOTATION_TEXT + 1) }), /text is over 200 characters/);
    rejects(onPage({ path: 5 }), /path must be a string/);
    rejects(onPage({ text: ["Sign in"] }), /text must be a string/);
    rejects(withMark({ path: "#login" }), /path is only for a browser screenshot/);
    rejects(withMark({ text: "Sign in" }), /text is only for a browser screenshot/);
  });

  test("refuses a malformed page", () => {
    const bad: unknown[] = [
      "http://x",
      { ...page, url: "" },
      { ...page, title: 3 },
      { ...page, tabId: 0 },
      { ...page, tabId: 1.5 },
      { ...page, viewport: { width: 1 } },
      { ...page, viewport: { width: 0, height: 1 } },
      { ...page, scale: 0 },
      { ...page, scale: "1" },
    ];
    for (const p of bad) rejects({ ...good(), page: p }, /page/);
  });
});

describe("annotationLines", () => {
  test("an image: its size, then one line per note with pixels and percentages", () => {
    const lines = annotationLines(normalizeAnnotation(good(), "a"));
    expect(lines).toEqual([
      "200×100 px. Notes:",
      "1. (50, 25) px, 25% across, 25% down, arrow from (150, 75) px: Make this bigger",
      "2. (200, 100) px, 100% across, 100% down: (no note)",
    ]);
  });

  test("a browser page: the tab, title, URL and viewport, and every point in CSS pixels at its scale", () => {
    // A page zoomed so a CSS pixel is 1.5 image pixels.
    const marks = [
      { n: 1, x: 41, y: 30, message: "" },
      { n: 2, x: 100, y: 50, tailX: 181, tailY: 9, message: "Wrong colour\nshould be blue" },
    ];
    const lines = annotationLines(normalizeAnnotation({ width: 200, height: 100, marks, page: { ...page, viewport: { width: 133.33, height: 66.67 }, scale: 1.5 } }, "a"));
    expect(lines[0]).toBe(
      'A screenshot of browser tab 2 "Sign in" http://localhost:3000/login (viewport 133.33×66.67 CSS px at 1.5× scale), 200×100 px. Points are in the image\'s pixels, then in the page\'s CSS pixels (what browser tools and page coordinates use). Notes:',
    );
    // 41 / 1.5 = 27.33 → 27; a click has no arrow.
    expect(lines[1]).toBe("1. (41, 30) px = (27, 20) CSS px, 21% across, 30% down: (no note)");
    expect(lines[2]).toBe("2. (100, 50) px = (67, 33) CSS px, 50% across, 50% down, arrow from (181, 9) px = (121, 6) CSS px: Wrong colour\n   should be blue");
  });

  test("a mark's element follows its position, set apart from the note", () => {
    const a = normalizeAnnotation(
      {
        width: 980,
        height: 360,
        page: { ...page, viewport: { width: 980, height: 360 } },
        marks: [
          { n: 1, x: 490, y: 180, tailX: 600, tailY: 300, path: "#login > form > button:nth-of-type(2)", text: 'Sign "in"', message: "Make this smaller" },
          { n: 2, x: 10, y: 10, path: "body > main", message: "" },
          { n: 3, x: 20, y: 20, text: "Hello", message: "Here" },
        ],
      },
      "a",
    );
    const lines = annotationLines(a);
    expect(lines[1]).toBe('1. (490, 180) px = (490, 180) CSS px, 50% across, 50% down, arrow from (600, 300) px = (600, 300) CSS px: element `#login > form > button:nth-of-type(2)` "Sign \\"in\\"": Make this smaller');
    expect(lines[2]).toBe("2. (10, 10) px = (10, 10) CSS px, 1% across, 3% down: element `body > main`: (no note)");
    expect(lines[3]).toBe('3. (20, 20) px = (20, 20) CSS px, 2% across, 6% down: element "Hello": Here');
    expect(compactNotes(a)[0]).toBe('1. (490, 180) px: element `#login > form > button:nth-of-type(2)` "Sign \\"in\\"": Make this smaller');
  });

  test("get_ticket's compact form", () => {
    expect(compactNotes(normalizeAnnotation(good(), "a"))).toEqual(["1. (50, 25) px: Make this bigger", "2. (200, 100) px: (no note)"]);
  });
});

describe("resolveAttachments with annotations", () => {
  const annotated = (path: string, annotation: unknown = good()) => ({ path, annotation });

  test("carries a checked annotation on its attachment, and none on the rest", () => {
    const list = normalize([{ path: notes }, annotated(shot)]);
    expect(list.map((a) => [a.path, a.kind, a.annotation ?? null])).toEqual([
      [notes, "file", null],
      [shot, "image", normalizeAnnotation(good(), "a")],
    ]);
  });

  test("refuses an annotation on a file that isn't an image by its bytes, and a malformed one", () => {
    expect(() => normalize([annotated(notes)])).toThrow(/notes\.md\): only a PNG, JPEG, GIF or WebP image can be annotated/);
    expect(() => normalize([annotated(fake)])).toThrow(/fake\.png\): only a PNG/);
    expect(() => normalize([{ path: notes }, annotated(shot, withMark({ x: 999 }))])).toThrow(/attachments\[1\] \(shot\.png\), mark 1: the point/);
  });

  test("a kept attachment whose file has gone missing keeps a new annotation unsniffed, but its shape is still checked", () => {
    const gone = write("gone.png", png(200, 100));
    const previous = normalize([annotated(gone)]);
    rmSync(gone);
    const changed = { ...good(), marks: [{ n: 1, x: 1, y: 1, message: "Moved" }] };
    const byId = (annotation?: unknown) => ({ id: previous[0]!.id, annotation });
    expect(normalize([byId(changed)], previous)[0]!.annotation!.marks[0]!.message).toBe("Moved");
    expect(() => normalize([byId(withMark({ n: 5 }))], previous)).toThrow(/numbered/);
    // Sent without one, the kept attachment drops it.
    expect(normalize([byId()], previous)[0]).not.toHaveProperty("annotation");
    // A kept file that's still there is sniffed when it gets an annotation.
    const kept = normalize([{ path: fake }]);
    expect(() => normalize([annotated(fake)], kept)).toThrow(/only a PNG/);
  });

  test("a spec image by id takes an annotation; the record stays without it", () => {
    registry.add(null, [{ id: "att_1", path: shot, name: "mockup.png", source: "spec", kind: "image", mimeType: "image/png" }]);
    const [a] = normalize([{ id: "att_1", annotation: good(), name: "Renamed.png" }]);
    expect(a).toEqual({ id: "att_1", path: shot, name: "Renamed.png", source: "spec", kind: "image", mimeType: "image/png", annotation: normalizeAnnotation(good(), "a") });
    expect(registry.get("att_1")).not.toHaveProperty("annotation");
    expect(() => normalize([{ id: "att_9" }])).toThrow(/Unknown attachment: att_9/);
  });
});

describe("runAttachments", () => {
  test("lists each annotated file's notes under its path, with the intro said once", () => {
    const list: Attachment[] = normalize([{ path: notes }, { path: shot, annotation: good() }, { path: write("b.png", png(40, 20)), annotation: { width: 40, height: 20, marks: [{ n: 1, x: 4, y: 2, message: "Here" }], page } }]);
    const { block } = runAttachments(list)!;
    const lines = block.split("\n");
    expect(block.match(/The human drew numbered notes/g)).toHaveLength(1);
    const at = lines.indexOf(`- ${shot} (image, included in this message)`);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "  200×100 px. Notes:",
      "  1. (50, 25) px, 25% across, 25% down, arrow from (150, 75) px: Make this bigger",
      "  2. (200, 100) px, 100% across, 100% down: (no note)",
    ]);
    expect(lines[lines.indexOf(`- ${notes}`) + 1]).toBe(`- ${shot} (image, included in this message)`);
    expect(block).toContain('  A screenshot of browser tab 2 "Sign in" http://localhost:3000/login (viewport 1280×800 CSS px at 1× scale), 40×20 px.');
    expect(block).toContain("  1. (4, 2) px = (4, 2) CSS px, 10% across, 10% down: Here");
  });

  test("a missing annotated file still has its notes; no annotations, no intro", () => {
    const gone = write("gone2.png", png(200, 100));
    const list = normalize([{ path: gone, annotation: good() }]);
    rmSync(gone);
    const lines = runAttachments(list)!.block.split("\n");
    const at = lines.indexOf(`- ${gone} (missing: it was moved or deleted after it was attached)`);
    expect(lines[at + 1]).toBe("  200×100 px. Notes:");
    expect(runAttachments(normalize([{ path: shot }]))!.block).not.toContain("numbered notes");
  });
});
