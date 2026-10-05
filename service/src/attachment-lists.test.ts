import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import {
  isUploadPath,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES,
  registerFile,
  resolveAttachments,
  runAttachments,
  safeUploadName,
  storeUpload,
  sweepUploads,
  uploadDirs,
} from "./attachment-lists";
import type { Attachment } from "@harness/shared";
import { openDb } from "./db";
import { Store } from "./store";
import { gif, jpeg, png, webp } from "./testing/media";

/** A list entry for a file, as the service would have registered it. */
const att = (path: string, name = path.split("/").at(-1)!): Attachment => ({ id: `id-${name}`, path, name, source: "file", kind: "file", mimeType: "" });

function dirs() {
  const root = tempDir("harness-prompt-att-");
  const uploads = join(root, "uploads");
  const files = join(root, "files");
  mkdirSync(uploads, { recursive: true });
  mkdirSync(files, { recursive: true });
  const file = (name: string, data: Uint8Array | string = "x") => {
    const p = join(files, name);
    writeFileSync(p, data);
    return p;
  };
  return { root, uploads, files, file };
}

describe("safeUploadName", () => {
  test("keeps the last path component only, so a name can't climb out of its folder", () => {
    expect(safeUploadName("../../etc/passwd")).toBe("passwd");
    expect(safeUploadName("a\\b\\c.png")).toBe("c.png");
    expect(safeUploadName("..")).toBe("Attachment");
    expect(safeUploadName(".bashrc")).toBe("Attachment.bashrc");
  });

  test("adds the MIME type's extension when the name has none, and falls back to Attachment", () => {
    expect(safeUploadName("Pasted image", "image/png")).toBe("Pasted image.png");
    expect(safeUploadName("shot.jpg", "image/png")).toBe("shot.jpg");
    expect(safeUploadName(null, "image/jpeg; charset=binary")).toBe("Attachment.jpg");
    expect(safeUploadName("  ", null)).toBe("Attachment");
  });

  test("drops control characters and caps the length, keeping the extension", () => {
    expect(safeUploadName("a\u0000b\nc.png")).toBe("abc.png");
    const long = safeUploadName(`${"n".repeat(300)}.webp`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".webp")).toBe(true);
  });
});

describe("storeUpload", () => {
  test("writes each upload to a folder of its own under uploads/, keeping its name", () => {
    const d = dirs();
    const a = storeUpload(d.uploads, png(2, 2), "Pasted image.png", "image/png");
    const b = storeUpload(d.uploads, png(2, 2), "Pasted image.png", "image/png");
    expect(a).toMatchObject({ name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png", width: 2, height: 2 });
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
    expect(isUploadPath(d.uploads, a.path)).toBe(true);
    expect(readFileSync(a.path).equals(png(2, 2))).toBe(true);
  });

  test("bytes that aren't an image or video are a file, named by the client's MIME type", () => {
    const d = dirs();
    expect(storeUpload(d.uploads, Buffer.from("%PDF-1.7"), "notes", "application/pdf")).toMatchObject({ name: "notes.pdf", kind: "file", mimeType: "application/pdf", size: 8 });
    expect(storeUpload(d.uploads, Buffer.from("??"), "blob", "application/x-custom")).toMatchObject({ kind: "file", mimeType: "application/x-custom" });
  });

  test("refuses an empty upload", () => {
    const d = dirs();
    expect(() => storeUpload(d.uploads, new Uint8Array(), "a.png", "image/png")).toThrow(/empty/);
  });
});

describe("isUploadPath", () => {
  test("only a file one folder deep under uploads/ counts", () => {
    const d = dirs();
    expect(isUploadPath(d.uploads, join(d.uploads, "u1", "a.png"))).toBe(true);
    expect(isUploadPath(d.uploads, join(d.uploads, "a.png"))).toBe(false);
    expect(isUploadPath(d.uploads, join(d.uploads, "u1", "x", "a.png"))).toBe(false);
    expect(isUploadPath(d.uploads, join(d.uploads, "u1", "..", "..", "files", "a.png"))).toBe(false);
    expect(isUploadPath(d.uploads, join(d.files, "a.png"))).toBe(false);
  });
});

describe("resolveAttachments", () => {
  const registry = () => new Store(openDb(":memory:")).attachments;

  test("a path must be an absolute file that exists; it's registered once, its source from where it is", () => {
    const d = dirs();
    const reg = registry();
    const shot = d.file("shot.png", png(3, 2));
    const up = storeUpload(d.uploads, png(1, 1), "Pasted image.png", "image/png");
    const [a, b] = resolveAttachments([{ path: shot }, { path: up.path, name: " Paste " }], [], reg, d.uploads);
    expect(a).toEqual({ id: expect.any(String), path: shot, name: "shot.png", source: "file", kind: "image", mimeType: "image/png", size: png(3, 2).length, width: 3, height: 2 });
    expect(b).toMatchObject({ path: up.path, name: "Paste", source: "upload" });
    expect(reg.get(a!.id)).toEqual(a!);
    // The record keeps the file's own name; the list keeps this use's.
    expect(reg.get(b!.id)!.name).toBe("Pasted image.png");
    // The same path again is the same attachment.
    expect(resolveAttachments([{ path: shot }], [], reg, d.uploads)[0]!.id).toBe(a!.id);
    expect(registerFile(reg, d.uploads, shot, " Renamed ")).toEqual({ ...a!, name: "Renamed" });
    expect(() => resolveAttachments([{ path: "shot.png" }], [], reg, d.uploads)).toThrow(/absolute/);
    expect(() => resolveAttachments([{ path: join(d.files, "nope.png") }], [], reg, d.uploads)).toThrow(/not found/);
    expect(() => resolveAttachments([{ path: d.files }], [], reg, d.uploads)).toThrow(/isn't a file/);
    expect(() => resolveAttachments("x", [], reg, d.uploads)).toThrow(/list/);
    expect(() => resolveAttachments([{ name: "a" }], [], reg, d.uploads)).toThrow(/id or a path/);
    expect(() => resolveAttachments([{ id: 7 }], [], reg, d.uploads)).toThrow(/id must be a string/);
  });

  test("an id names any registered attachment; an unknown one, or one whose file is gone, is refused", () => {
    const d = dirs();
    const reg = registry();
    const spec = { id: "spec1", path: d.file("after.png", png(2, 2)), name: "After", source: "spec" as const, kind: "image" as const, mimeType: "image/png" };
    reg.add(null, [spec]);
    const notes = registerFile(reg, d.uploads, d.file("notes.txt", "hi"));
    // A full Attachment is a valid input: only its id, name and annotation count.
    const got = resolveAttachments([{ id: "spec1" }, { ...notes, path: "/elsewhere", source: "upload", kind: "image", name: "Notes" }], [], reg, d.uploads);
    expect(got).toEqual([spec, { ...notes, name: "Notes" }]);
    expect(() => resolveAttachments([{ id: "nope" }], [], reg, d.uploads)).toThrow(/Unknown attachment: nope/);
    rmSync(notes.path);
    expect(() => resolveAttachments([{ id: notes.id }], [], reg, d.uploads)).toThrow(/not found/);
  });

  test("a path to a spec's stored file is that spec attachment", () => {
    const d = dirs();
    const reg = registry();
    const path = d.file("att.png", png(1, 1));
    reg.add(null, [{ id: "s", path, name: "After", source: "spec", kind: "image", mimeType: "image/png" }]);
    expect(resolveAttachments([{ path }], [], reg, d.uploads)[0]).toMatchObject({ id: "s", source: "spec", name: "After" });
  });

  test("a client can't pass a file off as an upload: the source is the service's call", () => {
    const d = dirs();
    const shot = d.file("shot.png");
    expect(resolveAttachments([{ path: shot, source: "upload" }], [], registry(), d.uploads)[0]!.source).toBe("file");
  });

  test("an attachment the list already had stays even after its file is gone, and can be renamed", () => {
    const d = dirs();
    const reg = registry();
    const shot = d.file("shot.png");
    const before = resolveAttachments([{ path: shot }], [], reg, d.uploads);
    rmSync(shot);
    const kept = { ...before[0]!, name: "Before" };
    expect(resolveAttachments([{ id: before[0]!.id, name: "Before" }], before, reg, d.uploads)).toEqual([kept]);
    expect(resolveAttachments([{ path: shot, name: "Before" }], before, reg, d.uploads)).toEqual([kept]);
    // A missing file that wasn't attached before is still refused.
    expect(() => resolveAttachments([{ path: shot }], [], reg, d.uploads)).toThrow(/not found/);
    expect(() => resolveAttachments([{ id: before[0]!.id }], [], reg, d.uploads)).toThrow(/not found/);
  });

  test("a file listed twice is kept once, and the limit counts what's left", () => {
    const d = dirs();
    const reg = registry();
    const shot = d.file("shot.png");
    const [first] = resolveAttachments([{ path: shot }], [], reg, d.uploads);
    expect(resolveAttachments([{ path: shot }, { id: first!.id }], [], reg, d.uploads)).toHaveLength(1);
    const many = Array.from({ length: 21 }, (_, i) => ({ path: d.file(`f${i}.txt`) }));
    expect(() => resolveAttachments(many, [], reg, d.uploads)).toThrow(/At most 20/);
    expect(resolveAttachments(many.slice(0, 20), [], reg, d.uploads)).toHaveLength(20);
  });
});

describe("uploadDirs and sweepUploads", () => {
  test("a ticket's upload folders are the ones to delete with it, never a referenced file elsewhere", () => {
    const d = dirs();
    const up = storeUpload(d.uploads, png(1, 1), "a.png", "image/png");
    const shot = d.file("shot.png");
    const forged = { path: shot, source: "upload" as const };
    expect(uploadDirs(d.uploads, [up, att(shot), forged])).toEqual([join(d.uploads, up.path.split("/").at(-2)!)]);
  });

  test("the sweep removes old unreferenced uploads only", () => {
    const d = dirs();
    const kept = storeUpload(d.uploads, png(1, 1), "kept.png", "image/png");
    const orphan = storeUpload(d.uploads, png(1, 1), "orphan.png", "image/png");
    const fresh = storeUpload(d.uploads, png(1, 1), "fresh.png", "image/png");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const a of [kept, orphan]) utimesSync(join(a.path, ".."), old, old);
    const removed = sweepUploads(d.uploads, new Set([kept.path]));
    expect(removed).toEqual([join(orphan.path, "..")]);
    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
  });

  test("a missing uploads folder sweeps nothing", () => {
    expect(sweepUploads(join(dirs().root, "nope"), new Set())).toEqual([]);
  });
});

describe("runAttachments", () => {
  test("lists every path, sends real images inline by their bytes (not their extension), and marks missing files", () => {
    const d = dirs();
    const shot = d.file("shot.png", png(4, 3));
    const photo = d.file("photo.jpg", jpeg(4, 3));
    const anim = d.file("anim.gif", gif(1, 1));
    const sticker = d.file("sticker.webp", webp(2, 2));
    const fake = d.file("fake.png", "not really a png");
    const notes = d.file("notes.pdf", "%PDF-1.7");
    const gone = join(d.files, "gone.png");
    const list = [shot, photo, anim, sticker, fake, notes].map((p) => att(p));
    const r = runAttachments([...list, att(gone)])!;
    expect(r.images.map((i) => [i.name, i.mediaType])).toEqual([
      ["shot.png", "image/png"],
      ["photo.jpg", "image/jpeg"],
      ["anim.gif", "image/gif"],
      ["sticker.webp", "image/webp"],
    ]);
    expect(Buffer.from(r.images[0]!.data, "base64").equals(png(4, 3))).toBe(true);
    expect(r.attached).toEqual(["shot.png", "photo.jpg", "anim.gif", "sticker.webp", "fake.png", "notes.pdf"]);
    expect(r.missing.map((m) => m.path)).toEqual([gone]);
    expect(r.block).toContain(`- ${shot} (image, included in this message)`);
    expect(r.block).toContain(`- ${fake}\n`);
    expect(r.block).toContain(`- ${notes}\n`);
    expect(r.block).toContain(`- ${gone} (missing: it was moved or deleted after it was attached)`);
    expect(r.block.trim().startsWith("<attachments>")).toBe(true);
  });

  test("images over the inline limit, or past the count, go by path only", () => {
    const d = dirs();
    const big = d.file("big.png", Buffer.concat([png(1, 1), Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]));
    const small = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, i) => d.file(`s${i}.png`, png(1, 1)));
    const r = runAttachments([big, ...small].map((p) => att(p)))!;
    expect(r.images).toHaveLength(MAX_INLINE_IMAGES);
    expect(r.notInline.map((n) => n.name)).toEqual(["big.png", `s${MAX_INLINE_IMAGES}.png`]);
    expect(r.notInline[0]!.reason).toMatch(/over 3\.75 MB/);
    expect(r.block).toContain(`- ${big}\n`);
  });

  test("no attachments, nothing to add", () => {
    expect(runAttachments([])).toBeNull();
  });
});
