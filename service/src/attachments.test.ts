import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { attachmentPath, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, prepareAttachments, storeAttachments } from "./attachments";
import { gif, jpeg, mov, mp4, png, webm, webp } from "./testing/media";

function workdir(files: Record<string, Buffer | string> = {}) {
  const dir = tempDir("harness-attach-");
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}

describe("prepareAttachments", () => {
  test("detects each allowed type and reads image sizes from the header", () => {
    const dir = workdir({
      "a.png": png(640, 480),
      "b.JPG": jpeg(1024, 768),
      "c.jpeg": jpeg(3, 2),
      "d.gif": gif(32, 16),
      "e.webp": webp(300, 200),
      "f.mp4": mp4(),
      "g.webm": webm(),
      "h.mov": mov(),
    });
    const got = prepareAttachments(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.mp4", "g.webm", "h.mov"], dir);
    expect(got.map(({ kind, mimeType, name, width, height }) => ({ kind, mimeType, name, width, height }))).toEqual([
      { kind: "image", mimeType: "image/png", name: "a.png", width: 640, height: 480 },
      { kind: "image", mimeType: "image/jpeg", name: "b.JPG", width: 1024, height: 768 },
      { kind: "image", mimeType: "image/jpeg", name: "c.jpeg", width: 3, height: 2 },
      { kind: "image", mimeType: "image/gif", name: "d.gif", width: 32, height: 16 },
      { kind: "image", mimeType: "image/webp", name: "e.webp", width: 300, height: 200 },
      { kind: "video", mimeType: "video/mp4", name: "f.mp4", width: undefined, height: undefined },
      { kind: "video", mimeType: "video/webm", name: "g.webm", width: undefined, height: undefined },
      { kind: "video", mimeType: "video/quicktime", name: "h.mov", width: undefined, height: undefined },
    ]);
    expect(got[0]!.size).toBe(png(640, 480).length);
    expect(new Set(got.map((a) => a.id)).size).toBe(got.length);
  });

  test("relative paths resolve against the working directory; absolute paths are used as given", () => {
    const dir = workdir({ "shots/after.png": png(1, 1) });
    const other = workdir({ "x.png": png(2, 2) });
    const [rel, abs] = prepareAttachments(["shots/after.png", join(other, "x.png")], dir);
    expect(rel!.source).toBe(join(dir, "shots/after.png"));
    expect(abs!.source).toBe(join(other, "x.png"));
    // the same relative path from another cwd doesn't exist
    expect(() => prepareAttachments(["shots/after.png"], other)).toThrow(`Attachment not found: shots/after.png (looked at ${join(other, "shots/after.png")})`);
  });

  test("no attachments is an empty list", () => {
    expect(prepareAttachments(undefined, "/tmp")).toEqual([]);
    expect(prepareAttachments([], "/tmp")).toEqual([]);
  });

  test(`more than ${MAX_ATTACHMENTS} fails before any file is looked at`, () => {
    const dir = workdir({ "a.png": png(1, 1) });
    expect(prepareAttachments(Array(MAX_ATTACHMENTS).fill("a.png"), dir)).toHaveLength(MAX_ATTACHMENTS);
    expect(() => prepareAttachments(Array(MAX_ATTACHMENTS + 1).fill("missing.png"), dir)).toThrow("Too many attachments: 11");
  });

  test("a file over the size limit fails; one exactly at it passes", () => {
    const dir = workdir({ "big.mp4": mp4(), "edge.mp4": mp4() });
    truncateSync(join(dir, "big.mp4"), MAX_ATTACHMENT_BYTES + 1); // sparse, so cheap
    truncateSync(join(dir, "edge.mp4"), MAX_ATTACHMENT_BYTES);
    expect(() => prepareAttachments(["big.mp4"], dir)).toThrow("Attachment too large: big.mp4");
    expect(prepareAttachments(["edge.mp4"], dir)[0]!.size).toBe(MAX_ATTACHMENT_BYTES);
  });

  test("an unsupported extension, a mismatched file, a directory and a non-list fail", () => {
    const dir = workdir({ "notes.txt": "hi", "fake.png": "not a png", "clip.mp4": png(1, 1), "folder.png/inner": "x" });
    expect(() => prepareAttachments(["notes.txt"], dir)).toThrow("Unsupported attachment type: notes.txt (allowed: png, jpg, jpeg, gif, webp, mp4, webm, mov)");
    expect(() => prepareAttachments(["fake.png"], dir)).toThrow("fake.png is not a valid .png file");
    expect(() => prepareAttachments(["clip.mp4"], dir)).toThrow("clip.mp4 is not a valid .mp4 file");
    expect(() => prepareAttachments(["folder.png"], dir)).toThrow("Attachment is not a file: folder.png");
    expect(() => prepareAttachments(["  "], dir)).toThrow("An attachment path is empty");
    expect(() => prepareAttachments("a.png", dir)).toThrow("attachments must be a list of file paths");
  });

  test("the first bad path fails the whole list", () => {
    const dir = workdir({ "ok.png": png(1, 1) });
    expect(() => prepareAttachments(["ok.png", "missing.gif"], dir)).toThrow("Attachment not found: missing.gif");
  });
});

describe("storeAttachments", () => {
  test("copies each file to <id>.<ext> and drops the source path", () => {
    const dir = workdir({ "a.jpeg": jpeg(4, 4), "b.mov": mov() });
    const store = tempDir("harness-store-");
    const prepared = prepareAttachments(["a.jpeg", "b.mov"], dir);
    const stored = storeAttachments(join(store, "attachments"), prepared);
    expect(stored.map((a) => "source" in a)).toEqual([false, false]);
    expect(readdirSync(join(store, "attachments")).sort()).toEqual([`${prepared[0]!.id}.jpg`, `${prepared[1]!.id}.mov`].sort());
    expect(readFileSync(attachmentPath(join(store, "attachments"), stored[0]!))).toEqual(jpeg(4, 4));
  });

  test("a failed copy removes the copies already made", () => {
    const dir = workdir({ "a.png": png(1, 1), "b.png": png(1, 1) });
    const store = join(tempDir("harness-store-"), "attachments");
    const prepared = prepareAttachments(["a.png", "b.png"], dir);
    prepared[1]!.source = join(dir, "vanished.png"); // deleted between validation and copy
    expect(() => storeAttachments(store, prepared)).toThrow();
    expect(existsSync(attachmentPath(store, prepared[0]!))).toBe(false);
  });
});
