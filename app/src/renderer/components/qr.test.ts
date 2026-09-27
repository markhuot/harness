import { describe, expect, test } from "bun:test";
import { buildPairUrl } from "@harness/shared";
import { BLOCKS_M, MASKS, MAX_VERSION, alignmentPositions, encodeQr, gfExp, gfMul, qrPath, reedSolomon, totalCodewords } from "./qr";

// --- An independent decoder working from the module matrix -----------------------------------------

/** Function-module map built from the spec's region rules (not from the encoder's drawing code). */
function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn[y]![x] = true;
  };
  mark(0, 0, 9, 9); // top-left finder + separator + format
  mark(size - 8, 0, 8, 9); // top-right finder + separator + format row
  mark(0, size - 8, 9, 8); // bottom-left finder + separator + format column (incl. dark module)
  mark(6, 0, 1, size); // timing
  mark(0, 6, size, 1);
  const al = alignmentPositions(version);
  const first = al[0];
  const last = al[al.length - 1];
  for (const cx of al)
    for (const cy of al) {
      if ((cx === first && cy === first) || (cx === first && cy === last) || (cx === last && cy === first)) continue; // finder corners
      mark(cx - 2, cy - 2, 5, 5);
    }
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return fn;
}

function bchFormatValid(raw15: number): { ecl: number; mask: number } | null {
  const v = raw15 ^ 0x5412;
  const data = v >>> 10;
  // Polynomial remainder of the whole 15-bit word by the generator must be 0.
  let rem = v;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return rem === 0 ? { ecl: data >>> 3, mask: data & 7 } : null;
}

function decodeQr(m: boolean[][]): string {
  const size = m.length;
  const version = (size - 17) / 4;
  expect(Number.isInteger(version) && version >= 1 && version <= MAX_VERSION).toBe(true);
  const at = (x: number, y: number) => (m[y]![x] ? 1 : 0);

  // Format info copy 1 (around the top-left finder), bits 0..14.
  const coords1: [number, number][] = [];
  for (let i = 0; i <= 5; i++) coords1.push([8, i]);
  coords1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) coords1.push([14 - i, 8]);
  const coords2: [number, number][] = [];
  for (let i = 0; i < 8; i++) coords2.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) coords2.push([8, size - 15 + i]);
  const read15 = (cs: [number, number][]) => cs.reduce((acc, [x, y], i) => acc | (at(x, y) << i), 0);
  const f1 = read15(coords1);
  expect(read15(coords2)).toBe(f1); // both copies agree
  const format = bchFormatValid(f1);
  expect(format).not.toBeNull();
  expect(format!.ecl).toBe(0b00); // level M
  expect(at(8, size - 8)).toBe(1); // dark module

  if (version >= 7) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      a |= at(size - 11 + (i % 3), Math.floor(i / 3)) << i;
      b |= at(Math.floor(i / 3), size - 11 + (i % 3)) << i;
    }
    expect(a).toBe(b);
    expect(a >>> 12).toBe(version);
    let rem = a;
    for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
    expect(rem).toBe(0);
  }

  // Timing patterns alternate.
  for (let i = 8; i < size - 8; i++) {
    expect(at(6, i)).toBe(i % 2 === 0 ? 1 : 0);
    expect(at(i, 6)).toBe(i % 2 === 0 ? 1 : 0);
  }

  // Unmask and read in zigzag order.
  const fn = functionMap(version);
  const mask = MASKS[format!.mask]!;
  const bits: number[] = [];
  let x = size - 1;
  let upward = true;
  while (x > 0) {
    if (x === 6) x--;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (const cx of [x, x - 1]) if (!fn[y]![cx]) bits.push(at(cx, y) ^ (mask(cx, y) ? 1 : 0));
    }
    upward = !upward;
    x -= 2;
  }
  const total = totalCodewords(version);
  expect(bits.length).toBeGreaterThanOrEqual(total * 8);
  expect(bits.length - total * 8).toBeLessThan(8); // only remainder bits left over
  const cw: number[] = [];
  for (let i = 0; i < total; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));

  // De-interleave, check every block's RS syndromes are zero, collect data.
  const [ec, b1, d1, b2, d2] = BLOCKS_M[version]!;
  const nb = b1 + b2;
  const blocks = Array.from({ length: nb }, (_, i) => ({ data: [] as number[], ec: [] as number[], len: i < b1 ? d1 : d2 }));
  let k = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.len) b.data.push(cw[k++]!);
  for (let i = 0; i < ec; i++) for (const b of blocks) b.ec.push(cw[k++]!);
  expect(k).toBe(total);
  const data: number[] = [];
  for (const b of blocks) {
    const poly = [...b.data, ...b.ec];
    for (let r = 0; r < ec; r++) {
      const root = gfExp(r);
      let acc = 0;
      for (const c of poly) acc = gfMul(acc, root) ^ c;
      expect(acc).toBe(0);
    }
    data.push(...b.data);
  }

  // Byte-mode segment.
  const dbits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++]!;
    return v;
  };
  expect(take(4)).toBe(0b0100);
  const count = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = take(8);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// --- Tests ----------------------------------------------------------------------------------------

describe("qr encoder", () => {
  test("Reed–Solomon matches the published 1-M HELLO WORLD example", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("block table adds up to each version's codeword count", () => {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const [ec, b1, d1, b2, d2] = BLOCKS_M[v]!;
      expect(b1 * (d1 + ec) + b2 * (d2 + ec)).toBe(totalCodewords(v));
    }
  });

  const pair = buildPairUrl("http://100.107.188.66:7717", "9f2c4e1d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d");
  const cases: [string, string][] = [
    ["one char", "a"],
    ["version-1 byte limit (14)", "12345678901234"],
    ["one past it (15 → v2)", "123456789012345"],
    ["utf-8", "harness — pünktlich ✓"],
    ["pair url", pair],
    ["version 7+ (version info)", "x".repeat(130)],
    ["16-bit count (v10+)", "y".repeat(200)],
  ];
  for (const [name, text] of cases)
    test(`round-trips: ${name}`, () => {
      expect(decodeQr(encodeQr(text))).toBe(text);
    });

  test("versions grow with length and the pair url is a scannable size", () => {
    expect(encodeQr("12345678901234").length).toBe(21);
    expect(encodeQr("123456789012345").length).toBe(25);
    expect(encodeQr(pair).length).toBeLessThanOrEqual(10 * 4 + 17);
  });

  test("every mask decodes", () => {
    for (let mask = 0; mask < 8; mask++) expect(decodeQr(encodeQr("mask test", { mask }))).toBe("mask test");
  });

  test("too long throws", () => {
    expect(() => encodeQr("z".repeat(700))).toThrow(/don't fit/);
  });

  test("qrPath merges horizontal runs and honours the border", () => {
    expect(qrPath([[true, true, false, true]], 1)).toBe("M1 1h2v1h-2zM4 1h1v1h-1z");
  });
});
