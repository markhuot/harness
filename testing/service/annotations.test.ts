import { expect, test } from "bun:test";
import { MAX_ANNOTATION_MARKS, MAX_ANNOTATION_MESSAGE } from "@harness/shared";
import { annotationLines, compactNotes, normalizeAnnotation } from "../../service/src/annotations";
import { HarnessError } from "../../service/src/orchestrator/errors";

const base = () => ({ width: 200, height: 100, marks: [{ n: 1, x: 50, y: 25, message: "  hi  " }] });
const page = { url: "http://x/", title: "T", tabId: 3, viewport: { width: 100, height: 50 }, scale: 2 };

const rejects = (raw: unknown, match: RegExp) => {
  try {
    normalizeAnnotation(raw, "att");
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(400);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a 400");
};

test("returns a clean copy: trims messages, drops unknown fields", () => {
  const out = normalizeAnnotation({ ...base(), extra: 1, marks: [{ n: 1, x: 1, y: 2, message: " m ", junk: true }] }, "att");
  expect(out).toEqual({ width: 200, height: 100, marks: [{ n: 1, x: 1, y: 2, message: "m" }] });
});

test("size, mark count and numbering are enforced", () => {
  rejects({ ...base(), width: 0 }, /positive whole/);
  rejects({ ...base(), height: 1.5 }, /positive whole/);
  rejects({ ...base(), marks: [] }, /at least one/);
  rejects({ ...base(), marks: Array.from({ length: MAX_ANNOTATION_MARKS + 1 }, (_, i) => ({ n: i + 1, x: 0, y: 0, message: "" })) }, /at most/);
  rejects({ ...base(), marks: [{ n: 2, x: 0, y: 0, message: "" }] }, /numbered 1, 2, 3/);
});

test("points must sit inside the image, edges included", () => {
  expect(normalizeAnnotation({ ...base(), marks: [{ n: 1, x: 200, y: 100, message: "" }] }, "a").marks[0]).toMatchObject({ x: 200, y: 100 });
  rejects({ ...base(), marks: [{ n: 1, x: 201, y: 0, message: "" }] }, /inside the 200×100/);
  rejects({ ...base(), marks: [{ n: 1, x: 0, y: -1, message: "" }] }, /inside/);
});

test("an arrow tail needs both coordinates, inside the image", () => {
  rejects({ ...base(), marks: [{ n: 1, x: 1, y: 1, tailX: 5, message: "" }] }, /go together/);
  rejects({ ...base(), marks: [{ n: 1, x: 1, y: 1, tailX: 500, tailY: 5, message: "" }] }, /arrow's start/);
  const ok = normalizeAnnotation({ ...base(), marks: [{ n: 1, x: 1, y: 1, tailX: 5, tailY: 6, message: "" }] }, "a");
  expect(ok.marks[0]).toMatchObject({ tailX: 5, tailY: 6 });
});

test("message length is checked after trimming", () => {
  const long = "x".repeat(MAX_ANNOTATION_MESSAGE);
  expect(normalizeAnnotation({ ...base(), marks: [{ n: 1, x: 0, y: 0, message: ` ${long} ` }] }, "a").marks[0]!.message).toBe(long);
  rejects({ ...base(), marks: [{ n: 1, x: 0, y: 0, message: long + "y" }] }, /over 2000/);
});

test("element path and text are only accepted on a page annotation", () => {
  rejects({ ...base(), marks: [{ n: 1, x: 0, y: 0, message: "", path: "div" }] }, /only for a browser screenshot/);
  const ok = normalizeAnnotation({ ...base(), page, marks: [{ n: 1, x: 0, y: 0, message: "", path: "div>a", text: "Go" }] }, "a");
  expect(ok.page).toEqual(page);
  expect(ok.marks[0]).toMatchObject({ path: "div>a", text: "Go" });
  rejects({ ...base(), page, marks: [{ n: 1, x: 0, y: 0, message: "", text: "x".repeat(201) }] }, /over 200/);
});

test("a page needs url, tabId, viewport and a positive scale", () => {
  rejects({ ...base(), page: { ...page, url: "" } }, /url/);
  rejects({ ...base(), page: { ...page, tabId: 0 } }, /tabId/);
  rejects({ ...base(), page: { ...page, viewport: { width: 0, height: 5 } } }, /viewport/);
  rejects({ ...base(), page: { ...page, scale: -1 } }, /scale/);
});

test("annotationLines converts to CSS pixels by the page scale and quotes element text as JSON", () => {
  const a = normalizeAnnotation({ ...base(), page, marks: [{ n: 1, x: 100, y: 50, tailX: 20, tailY: 10, message: "line1\nline2", path: "a`b", text: 'say "hi"' }] }, "a");
  const [head, mark] = annotationLines(a);
  expect(head).toContain('browser tab 3 "T" http://x/');
  expect(mark).toContain("(100, 50) px = (50, 25) CSS px, 50% across, 50% down");
  expect(mark).toContain("arrow from (20, 10) px = (10, 5) CSS px");
  expect(mark).toContain('element `a\\`b` "say \\"hi\\""');
  expect(mark).toContain("line1\n   line2");
});

test("an image without a page has no CSS conversion, and an empty note reads (no note)", () => {
  const a = normalizeAnnotation(base(), "a");
  a.marks[0]!.message = "";
  const lines = annotationLines(a);
  expect(lines[0]).toBe("200×100 px. Notes:");
  expect(lines[1]).toBe("1. (50, 25) px, 25% across, 25% down: (no note)");
  expect(compactNotes(a)).toEqual(["1. (50, 25) px: (no note)"]);
});
