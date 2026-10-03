import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import {
  isUploadPath,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES,
  normalizePromptAttachments,
  runAttachments,
  safeUploadName,
  storeUpload,
  sweepUploads,
  uploadDirs,
} from "./prompt-attachments";
import { gif, jpeg, png, webp } from "./testing/media";

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
    expect(a).toMatchObject({ name: "Pasted image.png", source: "upload" });
    expect(a.path).not.toBe(b.path);
    expect(isUploadPath(d.uploads, a.path)).toBe(true);
    expect(readFileSync(a.path).equals(png(2, 2))).toBe(true);
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

describe("normalizePromptAttachments", () => {
  test("new paths must be absolute files that exist; the name defaults to the file's and the source comes from where it is", () => {
    const d = dirs();
    const shot = d.file("shot.png");
    const up = storeUpload(d.uploads, png(1, 1), "Pasted image.png", "image/png");
    expect(normalizePromptAttachments([{ path: shot }, { path: up.path, name: " Paste " }], [], d.uploads)).toEqual([
      { path: shot, name: "shot.png", source: "file" },
      { path: up.path, name: "Paste", source: "upload" },
    ]);
    expect(() => normalizePromptAttachments([{ path: "shot.png" }], [], d.uploads)).toThrow(/absolute/);
    expect(() => normalizePromptAttachments([{ path: join(d.files, "nope.png") }], [], d.uploads)).toThrow(/not found/);
    expect(() => normalizePromptAttachments([{ path: d.files }], [], d.uploads)).toThrow(/isn't a file/);
    expect(() => normalizePromptAttachments("x", [], d.uploads)).toThrow(/list/);
    expect(() => normalizePromptAttachments([{ name: "a" }], [], d.uploads)).toThrow(/path/);
  });

  test("a client can't pass a file off as an upload: the source is the service's call", () => {
    const d = dirs();
    const shot = d.file("shot.png");
    expect(normalizePromptAttachments([{ path: shot, source: "upload" }], [], d.uploads)[0]!.source).toBe("file");
  });

  test("an attachment the ticket already had stays even after its file is gone, and can be renamed", () => {
    const d = dirs();
    const shot = d.file("shot.png");
    const before = normalizePromptAttachments([{ path: shot }], [], d.uploads);
    rmSync(shot);
    expect(normalizePromptAttachments([{ path: shot, name: "Before" }], before, d.uploads)).toEqual([{ path: shot, name: "Before", source: "file" }]);
    // A missing file that wasn't attached before is still refused.
    expect(() => normalizePromptAttachments([{ path: shot }], [], d.uploads)).toThrow(/not found/);
  });

  test("a path listed twice is kept once, and the limit counts what's left", () => {
    const d = dirs();
    const shot = d.file("shot.png");
    expect(normalizePromptAttachments([{ path: shot }, { path: shot }], [], d.uploads)).toHaveLength(1);
    const many = Array.from({ length: 21 }, (_, i) => ({ path: d.file(`f${i}.txt`) }));
    expect(() => normalizePromptAttachments(many, [], d.uploads)).toThrow(/At most 20/);
    expect(normalizePromptAttachments(many.slice(0, 20), [], d.uploads)).toHaveLength(20);
  });
});

describe("uploadDirs and sweepUploads", () => {
  test("a ticket's upload folders are the ones to delete with it, never a referenced file elsewhere", () => {
    const d = dirs();
    const up = storeUpload(d.uploads, png(1, 1), "a.png", "image/png");
    const shot = d.file("shot.png");
    const forged = { path: shot, name: "x", source: "upload" as const };
    expect(uploadDirs(d.uploads, [up, { path: shot, name: "shot.png", source: "file" }, forged])).toEqual([join(d.uploads, up.path.split("/").at(-2)!)]);
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
    const list = [shot, photo, anim, sticker, fake, notes].map((p) => ({ path: p, name: p.split("/").at(-1)!, source: "file" as const }));
    const r = runAttachments([...list, { path: gone, name: "gone.png", source: "file" }])!;
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
    const r = runAttachments([big, ...small].map((p) => ({ path: p, name: p.split("/").at(-1)!, source: "file" as const })))!;
    expect(r.images).toHaveLength(MAX_INLINE_IMAGES);
    expect(r.notInline.map((n) => n.name)).toEqual(["big.png", `s${MAX_INLINE_IMAGES}.png`]);
    expect(r.notInline[0]!.reason).toMatch(/over 3\.75 MB/);
    expect(r.block).toContain(`- ${big}\n`);
  });

  test("no attachments, nothing to add", () => {
    expect(runAttachments([])).toBeNull();
  });
});
