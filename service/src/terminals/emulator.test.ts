import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createEmulator, parseCwdUri } from "./emulator";

function make() {
  const seen = { titles: [] as string[], cwds: [] as string[] };
  const emu = createEmulator(40, 8, { title: (t) => seen.titles.push(t), cwd: (c) => seen.cwds.push(c) });
  return { emu, seen };
}

describe("title and cwd from the output", () => {
  test("OSC 0/2 titles and OSC 7 cwds, with BEL and ST terminators", async () => {
    const { emu, seen } = make();
    emu.write("\x1b]0;first\x07\x1b]2;second\x1b\\\x1b]7;file://host/Users/mark/My%20Dir\x07\x1b]7;file:///tmp\x1b\\");
    await emu.idle();
    expect(seen.titles).toEqual(["first", "second"]);
    expect(seen.cwds).toEqual(["/Users/mark/My Dir", "/tmp"]);
  });

  test("a sequence split across chunks lands once, whole", async () => {
    const { emu, seen } = make();
    for (const chunk of ["\x1b", "]7;file://ho", "st/sr", "v/app\x1b", "\\", "\x1b]0;ti", "tle\x07"]) emu.write(chunk);
    await emu.idle();
    expect(seen.cwds).toEqual(["/srv/app"]);
    expect(seen.titles).toEqual(["title"]);
  });

  test("an unterminated title never reports, and an oversized one is ignored", async () => {
    const { emu, seen } = make();
    emu.write(`\x1b]0;${"x".repeat(10_000)}\x07`);
    emu.write("\x1b]7;not-a-uri\x07\x1b]7;file://nohost\x07");
    emu.write("\x1b]0;never ends");
    await emu.idle();
    expect(seen.titles).toEqual([]);
    expect(seen.cwds).toEqual([]);
  });

  test("parseCwdUri keeps only the path of a file URI", () => {
    expect(parseCwdUri("file://mac.local/Users/a%2Fb")).toBe("/Users/a/b");
    expect(parseCwdUri("http://x/y")).toBeNull();
    expect(parseCwdUri("file://%E0%A4%A/x")).toBe("/x");
    expect(parseCwdUri("file:///bad%zz")).toBeNull();
  });
});

describe("snapshots", () => {
  async function reference(cols: number, rows: number, chunks: string[]) {
    const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const s = new SerializeAddon();
    t.loadAddon(s);
    for (const c of chunks) await new Promise<void>((r) => t.write(c, r));
    return { t, s };
  }

  test("restoring a snapshot into a fresh emulator reproduces screen, scrollback and the alternate screen", async () => {
    const output = ["line1\r\n", ...Array.from({ length: 30 }, (_, i) => `row ${i} \x1b[32mgreen\x1b[0m\r\n`), "\x1b[?1049h\x1b[2J\x1b[Halt screen"];
    const { emu } = make();
    for (const c of output) emu.write(c);
    await emu.idle();
    const { data } = emu.serialize();
    const restored = await reference(40, 8, [data]);
    const original = await reference(40, 8, output);
    expect(restored.t.buffer.active.type).toBe("alternate");
    expect(restored.s.serialize()).toBe(original.s.serialize());
    // the normal buffer under the alt screen kept its scrollback
    restored.t.write("\x1b[?1049l");
    original.t.write("\x1b[?1049l");
    await new Promise((r) => setTimeout(r, 10));
    expect(restored.s.serialize()).toBe(original.s.serialize());
  });

  test("a resize between writes is reflected in the snapshot: written at 120 columns, resized to 80", async () => {
    const emu = createEmulator(120, 10, { title() {}, cwd() {} });
    emu.write(`${"a".repeat(100)}\r\nshort\r\n`);
    emu.resize(80, 10);
    emu.write("after\r\n");
    await emu.idle();
    const snap = emu.serialize().data;
    const restored = await reference(80, 10, [snap]);
    const ref = await reference(120, 10, [`${"a".repeat(100)}\r\nshort\r\n`]);
    ref.t.resize(80, 10);
    await new Promise<void>((r) => ref.t.write("after\r\n", r));
    expect(restored.s.serialize()).toBe(ref.s.serialize());
  });

  test("idle resolves only after everything written is parsed", async () => {
    const { emu } = make();
    for (let i = 0; i < 200; i++) emu.write(`line ${i}\r\n`);
    await emu.idle();
    expect(emu.serialize().data).toContain("line 199");
  });
});

describe("flow control", () => {
  test("a flood past the backlog limit is dropped instead of throwing, the emulator stays usable and the snapshot is truncated", async () => {
    const { emu } = make();
    const chunk = "y".repeat(1024 * 1024);
    expect(() => {
      for (let i = 0; i < 80; i++) emu.write(chunk); // ~80 MB queued without yielding
    }).not.toThrow();
    await emu.idle();
    emu.write("\r\nafter-flood");
    await emu.idle();
    const snap = emu.serialize();
    expect(snap.data).toContain("after-flood");
    expect(snap.truncated).toBe(true);
  });

  test("a resize waits for the output written before it", async () => {
    const { emu } = make();
    emu.write("a".repeat(60)); // 40 columns: wraps at the old width
    emu.resize(20, 8);
    await emu.idle();
    const ref = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    const ser = new SerializeAddon();
    ref.loadAddon(ser);
    await new Promise<void>((r) => ref.write("a".repeat(60), r));
    ref.resize(20, 8);
    expect(emu.serialize().data).toBe(ser.serialize({ scrollback: 5000 }));
  });
});
