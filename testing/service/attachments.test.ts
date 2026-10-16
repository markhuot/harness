import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { attachmentPath, describeFile, imageSize, MAX_ATTACHMENTS, prepareAttachments, removeAttachmentFiles, storeAttachments } from "../../service/src/attachments";
import { tempDir } from "../builders/tmp";
import { gifBytes, jpegBytes, mp4Bytes, pngBytes, writeFile } from "./files";

test("image sizes come from the header for PNG, GIF and JPEG, and null when the header is cut short", () => {
  expect(imageSize("image/png", pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
  expect(imageSize("image/gif", gifBytes(10, 20))).toEqual({ width: 10, height: 20 });
  expect(imageSize("image/jpeg", jpegBytes(300, 200))).toEqual({ width: 300, height: 200 });
  expect(imageSize("image/png", pngBytes().subarray(0, 20))).toBeNull();
  expect(imageSize("image/jpeg", Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
  expect(imageSize("text/plain", pngBytes())).toBeNull();
});

test("prepareAttachments accepts a real image, resolves relative paths against cwd, and reports its pixel size", () => {
  const cwd = tempDir();
  writeFile(cwd, "shots/a.PNG", pngBytes(5, 7));
  const [a] = prepareAttachments(["shots/a.PNG"], cwd);
  expect(a).toMatchObject({ kind: "image", mimeType: "image/png", name: "a.PNG", width: 5, height: 7, from: join(cwd, "shots", "a.PNG") });
});

test("prepareAttachments refuses the first bad path and says why", () => {
  const cwd = tempDir();
  writeFile(cwd, "fake.png", "just text");
  writeFile(cwd, "doc.txt", "x");
  mkdirSyncFile(cwd);
  const bad = (paths: unknown, match: RegExp) => expect(() => prepareAttachments(paths, cwd)).toThrow(match);
  bad(["fake.png"], /not a valid \.png/);
  bad(["doc.txt"], /Unsupported attachment type/);
  bad(["missing.png"], /not found/);
  bad(["dir.png"], /not a file/);
  bad(["  "], /empty/);
  bad("a.png", /list of file paths/);
  bad([1], /list of file paths/);
  bad(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => "a.png"), /Too many/);
  expect(prepareAttachments(undefined, cwd)).toEqual([]);
  expect(prepareAttachments(null, cwd)).toEqual([]);
});

function mkdirSyncFile(cwd: string) {
  writeFile(cwd, "dir.png/inner", "x");
}

test("a video needs a matching extension and first bytes; a PNG renamed .mp4 is refused", () => {
  const cwd = tempDir();
  writeFile(cwd, "clip.mp4", mp4Bytes());
  writeFile(cwd, "liar.mp4", pngBytes());
  expect(prepareAttachments(["clip.mp4"], cwd)[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
  expect(() => prepareAttachments(["liar.mp4"], cwd)).toThrow(/not a valid \.mp4/);
});

test("storeAttachments copies into the folder as <id>.<ext> marked as spec media", () => {
  const cwd = tempDir();
  const dest = join(tempDir(), "attachments");
  writeFile(cwd, "a.png", pngBytes());
  const prepared = prepareAttachments(["a.png"], cwd);
  const [stored] = storeAttachments(dest, prepared);
  expect(stored).toMatchObject({ source: "spec", path: attachmentPath(dest, prepared[0]!) });
  expect(stored!.path.endsWith(`${prepared[0]!.id}.png`)).toBe(true);
  expect(existsSync(stored!.path)).toBe(true);
  expect("from" in stored!).toBe(false);
  expect(storeAttachments(dest, [])).toEqual([]);
});

test("a copy that fails midway removes the copies already made", () => {
  const cwd = tempDir();
  const dest = join(tempDir(), "attachments");
  writeFile(cwd, "a.png", pngBytes());
  writeFile(cwd, "b.png", pngBytes());
  const [a, b] = prepareAttachments(["a.png", "b.png"], cwd);
  // The second source vanishes between validation and copy.
  removeAttachmentFiles([b!.from]);
  expect(() => storeAttachments(dest, [a!, b!])).toThrow();
  expect(readdirSync(dest)).toEqual([]);
});

test("attachmentPath falls back to .bin for a MIME type it doesn't know", () => {
  expect(attachmentPath("/d", { id: "x", mimeType: "image/jpeg" })).toBe("/d/x.jpg");
  expect(attachmentPath("/d", { id: "x", mimeType: "text/plain" })).toBe("/d/x.bin");
});

test("describeFile recognizes images by bytes whatever the name, videos only with their extension, and other files by name", () => {
  const dir = tempDir();
  expect(describeFile(writeFile(dir, "photo.dat", pngBytes(9, 8)))).toMatchObject({ kind: "image", mimeType: "image/png", width: 9, height: 8, size: 33 });
  expect(describeFile(writeFile(dir, "clip.m4v", mp4Bytes()))).toMatchObject({ kind: "video", mimeType: "video/mp4" });
  // An ftyp box also opens HEIC images: without a video extension it's just a file.
  expect(describeFile(writeFile(dir, "pic.heic", mp4Bytes()))).toMatchObject({ kind: "file" });
  expect(describeFile(writeFile(dir, "notes.txt", "hi"))).toMatchObject({ kind: "file", mimeType: "text/plain", size: 2 });
  expect(describeFile(writeFile(dir, "blob.zzzz", "hi"))).toMatchObject({ kind: "file", mimeType: "" });
  expect(describeFile(dir)).toBeNull();
  expect(describeFile(join(dir, "missing"))).toBeNull();
});
