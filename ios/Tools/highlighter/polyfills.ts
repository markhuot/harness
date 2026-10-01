// UTF-8 TextEncoder/TextDecoder for a bare JSContext (see entry.ts). Only what oniguruma-to-es uses:
// encode(string) and decode(Uint8Array). Lone surrogates encode as U+FFFD, as the spec says.

const g = globalThis as Record<string, unknown>;

if (typeof g.TextEncoder === "undefined") {
  g.TextEncoder = class {
    readonly encoding = "utf-8";
    encode(input = ""): Uint8Array {
      const out: number[] = [];
      for (const ch of input) {
        let c = ch.codePointAt(0)!;
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
}

if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class {
    readonly encoding = "utf-8";
    readonly fatal: boolean;
    constructor(_label = "utf-8", opts: { fatal?: boolean } = {}) {
      this.fatal = !!opts.fatal;
    }
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return "";
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let s = "";
      for (let i = 0; i < b.length; ) {
        const x = b[i]!;
        const n = x < 0x80 ? 1 : x >> 5 === 6 ? 2 : x >> 4 === 14 ? 3 : x >> 3 === 30 ? 4 : 0;
        let c = n === 1 ? x : n === 2 ? x & 31 : n === 3 ? x & 15 : x & 7;
        let ok = n > 0 && i + n <= b.length;
        for (let k = 1; ok && k < n; k++) {
          const y = b[i + k]!;
          if (y >> 6 !== 2) ok = false;
          else c = (c << 6) | (y & 63);
        }
        if (!ok) {
          if (this.fatal) throw new TypeError("The encoded data was not valid utf-8");
          s += "�";
          i += 1;
          continue;
        }
        s += String.fromCodePoint(c);
        i += n;
      }
      return s;
    }
  };
}

export {};
