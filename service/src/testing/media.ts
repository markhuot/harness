// Tiny media files for attachment tests: just the headers the service sniffs (magic bytes and,
// for images, the pixel size), plus a few bytes of payload.

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function png(width: number, height: number) {
  const ihdr = [...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...ascii("payload")]);
}

export function gif(width: number, height: number) {
  return Buffer.from([...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0, 0x3b]);
}

/** A JFIF APP0 segment before the SOF0 frame header, as real JPEGs have. */
export function jpeg(width: number, height: number) {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

export function webp(width: number, height: number) {
  const vp8x = [...ascii("VP8X"), ...u32be(10).reverse(), 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  return Buffer.from([...ascii("RIFF"), ...u32be(22).reverse(), ...ascii("WEBP"), ...vp8x]);
}

export function mp4(extra = 0) {
  return Buffer.concat([Buffer.from([...u32be(24), ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isomiso2mp41")]), Buffer.alloc(extra, 7)]);
}

export function webm() {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
}

export function mov() {
  return Buffer.from([...u32be(20), ...ascii("ftypqt  "), 0, 0, 2, 0, ...ascii("qt  ")]);
}
