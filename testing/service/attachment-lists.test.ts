import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_PROMPT_ATTACHMENTS, type Attachment } from "@harness/shared";
import { HarnessError } from "../../service/src/orchestrator/errors";
import {
  isUploadPath,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES,
  ORPHAN_UPLOAD_AGE_MS,
  registerFile,
  resolveAttachments,
  runAttachments,
  safeUploadName,
  sniffImage,
  storeUpload,
  sweepUploads,
  uploadDirs,
  type AttachmentRegistry,
} from "../../service/src/attachment-lists";
import { addProject, addTicket, makeStore } from "../builders/store";
import { tempDir } from "../builders/tmp";
import { gifBytes, jpegBytes, pngBytes, writeFile } from "./files";

/** The real attachments table behind the registry interface, plus the uploads folder it's paired with. */
function rig() {
  const store = makeStore();
  const uploads = join(tempDir(), "uploads");
  const files = tempDir();
  return { store, registry: store.attachments as AttachmentRegistry, uploads, files };
}
const rejects = (fn: () => unknown, status: number, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(status);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a HarnessError");
};

test("safeUploadName keeps one safe path component, adds the MIME extension and caps length keeping the extension", () => {
  expect(safeUploadName("../../etc/passwd")).toBe("passwd");
  expect(safeUploadName("a\\b\\c.png")).toBe("c.png");
  expect(safeUploadName("  \u0000x\u0007.txt ")).toBe("x.txt");
  expect(safeUploadName("..")).toBe("Attachment");
  expect(safeUploadName(null)).toBe("Attachment");
  expect(safeUploadName(".env")).toBe("Attachment.env");
  expect(safeUploadName("shot", "image/png; charset=x")).toBe("shot.png");
  expect(safeUploadName("shot.jpg", "image/png")).toBe("shot.jpg");
  const long = safeUploadName(`${"n".repeat(200)}.jpeg`);
  expect(long).toHaveLength(120);
  expect(long.endsWith(".jpeg")).toBe(true);
});

test("isUploadPath is true only for a file in its own folder directly under uploads", () => {
  const up = "/h/uploads";
  expect(isUploadPath(up, "/h/uploads/abc/f.png")).toBe(true);
  expect(isUploadPath(up, "/h/uploads/f.png")).toBe(false);
  expect(isUploadPath(up, "/h/uploads/abc/sub/f.png")).toBe(false);
  expect(isUploadPath(up, "/h/uploads/../elsewhere/abc/f.png")).toBe(false);
  expect(isUploadPath(up, "/h/uploadsX/abc/f.png")).toBe(false);
});

test("storeUpload writes uploads/<id>/<name>, refuses empty bytes, and takes the client's MIME for what the bytes can't say", () => {
  const { uploads } = rig();
  const a = storeUpload(uploads, pngBytes(3, 4), "../shot.png", "image/png");
  expect(a).toMatchObject({ source: "upload", name: "shot.png", kind: "image", mimeType: "image/png", width: 3, height: 4 });
  expect(isUploadPath(uploads, a.path)).toBe(true);
  expect(storeUpload(uploads, Buffer.from("%PDF"), "doc", "application/pdf")).toMatchObject({ kind: "file", mimeType: "application/pdf", name: "doc.pdf" });
  rejects(() => storeUpload(uploads, new Uint8Array(), "x", null), 400, /empty/);
});

test("registerFile needs an absolute path to a real file, reuses the row for the same file and honours a per-use name", () => {
  const { registry, uploads, files } = rig();
  const path = writeFile(files, "a.png", pngBytes());
  rejects(() => registerFile(registry, uploads, "rel/a.png"), 400, /must be absolute/);
  rejects(() => registerFile(registry, uploads, join(files, "nope.png")), 400, /not found/);
  rejects(() => registerFile(registry, uploads, files), 400, /isn't a file/);
  const first = registerFile(registry, uploads, path);
  const again = registerFile(registry, uploads, path, "  Renamed ");
  expect(again.id).toBe(first.id);
  expect(again.name).toBe("Renamed");
  expect(registry.get(first.id)!.name).toBe("a.png");
  expect(first.source).toBe("file");
});

test("registerFile calls a file in the uploads folder an upload and a stored spec image a spec attachment", () => {
  const { registry, uploads, files } = rig();
  const up = storeUpload(uploads, pngBytes(), "p.png", "image/png");
  expect(registerFile(registry, uploads, up.path).source).toBe("upload");
  const specPath = writeFile(files, "spec.png", pngBytes());
  registry.add(null, [{ id: "s1", path: specPath, name: "spec.png", source: "spec", kind: "image", mimeType: "image/png" }]);
  expect(registerFile(registry, uploads, specPath)).toMatchObject({ id: "s1", source: "spec" });
});

test("resolveAttachments takes ids and paths, keeps one copy of a file listed twice, and applies this use's name", () => {
  const { registry, uploads, files } = rig();
  const path = writeFile(files, "a.png", pngBytes());
  const reg = registerFile(registry, uploads, path);
  const out = resolveAttachments([{ id: reg.id, name: " Mine " }, { path }, { path: writeFile(files, "b.png", gifBytes()) }], [], registry, uploads);
  expect(out.map((a) => a.name)).toEqual(["Mine", "b.png"]);
  expect(out[0]!.id).toBe(reg.id);
});

test("resolveAttachments refuses unknown ids, vanished files, malformed items and too many", () => {
  const { registry, uploads, files } = rig();
  const path = writeFile(files, "a.png", pngBytes());
  const reg = registerFile(registry, uploads, path);
  const run = (raw: unknown, previous: Attachment[] = []) => () => resolveAttachments(raw, previous, registry, uploads);
  rejects(run("x"), 400, /must be a list/);
  rejects(run([null]), 400, /needs an id or a path/);
  rejects(run([{}]), 400, /needs an id or a path/);
  rejects(run([{ id: 5 }]), 400, /id must be a string/);
  rejects(run([{ path: 5 }]), 400, /path must be a string/);
  rejects(run([{ path, name: 5 }]), 400, /name must be a string/);
  rejects(run([{ id: "nope" }]), 400, /Unknown attachment/);
  rejects(run(Array.from({ length: MAX_PROMPT_ATTACHMENTS + 1 }, (_, i) => ({ path: writeFile(files, `m${i}.png`, pngBytes()) }))), 400, /At most/);
  // The file goes away: a fresh reference fails, but a draft that already holds it keeps it.
  const gone = writeFile(files, "gone.png", pngBytes());
  const held = registerFile(registry, uploads, gone);
  rmSync(gone);
  rejects(run([{ id: held.id }]), 400, /not found/);
  expect(run([{ id: held.id }], [held])().map((a) => a.id)).toEqual([held.id]);
});

test("an annotation is checked: it must be well-formed, and only an image can carry one", () => {
  const { registry, uploads, files } = rig();
  const png = writeFile(files, "a.png", pngBytes(100, 50));
  const txt = writeFile(files, "a.txt", "hello");
  const note = { width: 100, height: 50, marks: [{ n: 1, x: 10, y: 10, message: " look " }] };
  const [ok] = resolveAttachments([{ path: png, annotation: note }], [], registry, uploads);
  expect(ok!.annotation!.marks[0]!.message).toBe("look");
  rejects(() => resolveAttachments([{ path: txt, annotation: note }], [], registry, uploads), 400, /only a PNG, JPEG, GIF or WebP image can be annotated/);
  rejects(() => resolveAttachments([{ path: png, annotation: { ...note, marks: [] } }], [], registry, uploads), 400, /at least one note/);
  // Re-sending a kept attachment without its annotation clears it.
  const [cleared] = resolveAttachments([{ id: ok!.id }], [ok!], registry, uploads);
  expect(cleared!.annotation).toBeUndefined();
});

test("uploadDirs names only upload folders; sweepUploads removes old unreferenced ones and spares young and referenced ones", () => {
  const { uploads } = rig();
  const old = storeUpload(uploads, pngBytes(), "old.png", "image/png");
  const kept = storeUpload(uploads, pngBytes(), "kept.png", "image/png");
  const young = storeUpload(uploads, pngBytes(), "young.png", "image/png");
  expect(uploadDirs(uploads, [old, { path: "/elsewhere/x/y.png", source: "upload" }, { path: kept.path, source: "file" }])).toEqual([dirname(old.path)]);
  const past = new Date(Date.now() - 2 * ORPHAN_UPLOAD_AGE_MS);
  for (const a of [old, kept]) utimesSync(dirname(a.path), past, past);
  mkdirSync(join(uploads, "stray-empty"));
  utimesSync(join(uploads, "stray-empty"), past, past);
  const removed = sweepUploads(uploads, new Set([kept.path]));
  expect(removed.sort()).toEqual([dirname(old.path), join(uploads, "stray-empty")].sort());
  expect(existsSync(dirname(kept.path))).toBe(true);
  expect(existsSync(dirname(young.path))).toBe(true);
  expect(existsSync(dirname(old.path))).toBe(false);
  expect(sweepUploads(join(uploads, "missing"), new Set())).toEqual([]);
});

test("sweepUploads ages a folder by the `at` it's given against the folder's mtime", () => {
  const { uploads } = rig();
  const up = storeUpload(uploads, pngBytes(), "f.png", "image/png");
  const mtime = statSync(dirname(up.path)).mtimeMs;
  expect(sweepUploads(uploads, new Set(), 1000, mtime + 999)).toEqual([]);
  expect(sweepUploads(uploads, new Set(), 1000, mtime + 1000)).toEqual([dirname(up.path)]);
});

test("sniffImage reads the first bytes, not the name", () => {
  expect(sniffImage(pngBytes())).toBe("image/png");
  expect(sniffImage(jpegBytes())).toBe("image/jpeg");
  expect(sniffImage(gifBytes())).toBe("image/gif");
  const webp = Buffer.alloc(16);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBP", 8, "latin1");
  expect(sniffImage(webp)).toBe("image/webp");
  expect(sniffImage(Buffer.from("plain text here!"))).toBeNull();
});

test("runAttachments: none gives null; images go inline, others by path, missing ones are marked, annotations are listed", () => {
  const { registry, uploads, files } = rig();
  expect(runAttachments([])).toBeNull();
  const png = registerFile(registry, uploads, writeFile(files, "a.png", pngBytes(100, 50)));
  const txt = registerFile(registry, uploads, writeFile(files, "n.txt", "hi"));
  const gone = registerFile(registry, uploads, writeFile(files, "g.png", pngBytes()));
  rmSync(gone.path);
  const annotated: Attachment = { ...png, id: "x", annotation: { width: 100, height: 50, marks: [{ n: 1, x: 10, y: 20, message: "here" }] } };
  const out = runAttachments([png, txt, gone, annotated])!;
  expect(out.images.map((i) => i.name)).toEqual(["a.png", "a.png"]);
  expect(out.images[0]!.data).toBe(pngBytes(100, 50).toString("base64"));
  expect(out.attached).toEqual(["a.png", "n.txt", "a.png"]);
  expect(out.missing.map((m) => m.name)).toEqual(["g.png"]);
  expect(out.block).toContain(`- ${png.path} (image, included in this message)`);
  expect(out.block).toContain(`- ${txt.path}\n`);
  expect(out.block).toContain("(missing: it was moved or deleted after it was attached)");
  expect(out.block).toContain("1. (10, 20) px, 10% across, 40% down: here");
  expect(out.block).toContain("The human drew numbered notes");
});

test("runAttachments leaves an oversized image and any past the inline limit listed by path only", () => {
  const { registry, uploads, files } = rig();
  const big = Buffer.concat([pngBytes(), Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]);
  const bigAtt = registerFile(registry, uploads, writeFile(files, "big.png", big));
  const many = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, i) => registerFile(registry, uploads, writeFile(files, `i${i}.png`, pngBytes(i + 1, 1))));
  const out = runAttachments([bigAtt, ...many])!;
  expect(out.images).toHaveLength(MAX_INLINE_IMAGES);
  expect(out.notInline.map((n) => n.name)).toEqual(["big.png", `i${MAX_INLINE_IMAGES}.png`]);
  expect(out.notInline[0]!.reason).toMatch(/^over 3\.75 MB/);
  expect(out.notInline[1]!.reason).toMatch(/more than 10 images/);
});

test("with a ticket in the store, the registered file survives as the same attachment id across writes", () => {
  const { store, registry, uploads, files } = rig();
  addTicket(store, addProject(store));
  const path = writeFile(files, "a.png", pngBytes());
  const [a] = resolveAttachments([{ path }], [], registry, uploads);
  const [b] = resolveAttachments([{ path }], [], registry, uploads);
  expect(b!.id).toBe(a!.id);
  expect(store.attachments.listUnowned()).toHaveLength(1);
});
