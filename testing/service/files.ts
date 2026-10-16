import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The first bytes of a PNG of `width` × `height`: signature, IHDR chunk header and size. Enough for anything that reads headers. */
export function pngBytes(width = 4, height = 3): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A GIF header of `width` × `height`. */
export function gifBytes(width = 2, height = 2): Buffer {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** A JPEG with one APP0 segment then a baseline frame header of `width` × `height`. */
export function jpegBytes(width = 8, height = 6): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

/** A fake MP4: just the box that names it. */
export function mp4Bytes(): Buffer {
  const b = Buffer.alloc(16);
  b.write("ftypisom", 4, "latin1");
  return b;
}

/** Write `bytes` to `dir`/`name` (making folders) and return the path. */
export function writeFile(dir: string, name: string, bytes: Uint8Array | string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}
