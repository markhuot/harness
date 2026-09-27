// Dependency-free QR code encoder (ISO/IEC 18004): byte mode, UTF-8, error correction level M,
// versions 1–20 (up to 666 bytes; a pairing link is ~150). Output is a square boolean matrix
// (true = dark), indexed [y][x], without the quiet zone.

/** M-level block structure per version: [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]. */
export const BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 0, 0], // (no version 0)
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
];
export const MAX_VERSION = BLOCKS_M.length - 1;

// --- GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 -----------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

export function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

export function gfExp(i: number): number {
  return EXP[i % 255]!;
}

/** Reed–Solomon error-correction codewords for `data` (generator roots α^0 … α^(ecLen-1)). */
export function reedSolomon(data: ArrayLike<number>, ecLen: number): number[] {
  // Generator polynomial coefficients, highest degree first (leading 1 implied).
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = next[j]! ^ gen[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(gen[j]!, gfExp(i));
    }
    gen = next;
  }
  const rem = new Array<number>(ecLen).fill(0);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k]! ^ rem.shift()!;
    rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] = rem[j]! ^ gfMul(gen[j + 1]!, factor);
  }
  return rem;
}

// --- Geometry -------------------------------------------------------------------------------------

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Data + EC codewords a version holds (from its module count). */
export function totalCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    bits -= (25 * n - 10) * n - 55;
    if (version >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

export function dataCapacity(version: number): number {
  const [, b1, d1, b2, d2] = BLOCKS_M[version]!;
  return b1 * d1 + b2 * d2;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** 15 format bits for level M (00) and the given mask, BCH(15,5) + the fixed XOR mask. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 18 version bits (versions ≥ 7), BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

export const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFunctionPatterns(g: Grid) {
  const { size, version } = g;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
  }
  const al = alignmentPositions(version);
  const last = al.length - 1;
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(g, 0); // reserve
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, bit(bits, i));
      g.set(b, a, bit(bits, i));
    }
  }
}

function drawFormat(g: Grid, mask: number) {
  const bits = formatBits(mask);
  const { size } = g;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(bits, i));
  g.set(8, 7, bit(bits, 6));
  g.set(8, 8, bit(bits, 7));
  g.set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(bits, i));
  g.set(8, size - 8, true); // the dark module
}

/** Visit data-module coordinates in placement order (two-column zigzag from the bottom right). */
export function forEachDataModule(size: number, isFunction: (x: number, y: number) => boolean, visit: (x: number, y: number) => void) {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!isFunction(x, y)) visit(x, y);
      }
    }
  }
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    // Finder-like 1011101 with four light modules on either side.
    for (let i = 0; i + 7 <= n; i++) {
      if (!(get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6))) continue;
      const lightRun = (from: number, to: number) => {
        for (let k = from; k < to; k++) if (k >= 0 && k < n && get(k)) return false;
        return true;
      };
      if (lightRun(i - 4, i) || lightRun(i + 7, i + 11)) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((i) => m[y]![i]!);
  for (let x = 0; x < n; x++) line((i) => m[i]![x]!);
  let dark = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < n && y + 1 < n) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Split data into blocks, add EC to each, and interleave (data columns first, then EC columns). */
export function interleave(version: number, data: number[]): number[] {
  const [ec, b1, d1, b2, d2] = BLOCKS_M[version]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let off = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const d = data.slice(off, off + len);
    off += len;
    blocks.push({ data: d, ec: reedSolomon(d, ec) });
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

/** Encode text (UTF-8, byte mode, level M) into a QR matrix. Throws when it doesn't fit version 20. */
export function encodeQr(text: string, opts: { mask?: number } = {}): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(version) * 8) break;
  }
  if (version > MAX_VERSION) throw new Error(`QR: ${bytes.length} bytes don't fit (max version ${MAX_VERSION})`);

  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const codewords = interleave(version, data);
  const g = new Grid(version);
  drawFunctionPatterns(g);
  let i = 0;
  forEachDataModule(
    g.size,
    (x, y) => g.fn[y]![x]!,
    (x, y) => {
      g.dark[y]![x] = i < codewords.length * 8 && bit(codewords[i >>> 3]!, 7 - (i & 7));
      i++;
    },
  );

  const withMask = (mask: number) => {
    const m = g.dark.map((row) => row.slice());
    const view = new Grid(version);
    drawFormat(view, mask);
    for (let y = 0; y < g.size; y++)
      for (let x = 0; x < g.size; x++) {
        if (view.fn[y]![x]) m[y]![x] = view.dark[y]![x]!;
        else if (!g.fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x];
      }
    return m;
  };
  if (opts.mask !== undefined) return withMask(opts.mask);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = withMask(mask);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best!;
}

/** SVG path data drawing the dark modules (runs merged per row), offset by `border` modules. */
export function qrPath(matrix: boolean[][], border = 4): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      parts.push(`M${x + border} ${y + border}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  });
  return parts.join("");
}

/** A standalone SVG document (black on white, 4-module quiet zone). */
export function qrSvg(text: string, border = 4): string {
  const m = encodeQr(text);
  const n = m.length + border * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(m, border)}" fill="#000"/></svg>`;
}
