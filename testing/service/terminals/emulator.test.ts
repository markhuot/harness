import { expect, test } from "bun:test";
import { createEmulator, parseCwdUri } from "../../../service/src/terminals/emulator";

test("parseCwdUri takes the path of a file:// URI and decodes it", () => {
  expect(parseCwdUri("file://host/Users/a%20b/proj")).toBe("/Users/a b/proj");
  expect(parseCwdUri("file:///tmp")).toBe("/tmp");
  expect(parseCwdUri("http://host/x")).toBeNull();
  expect(parseCwdUri("file://host")).toBeNull();
  expect(parseCwdUri("file://host/%E0%A4%A")).toBeNull();
  expect(parseCwdUri(`file://h/${"x".repeat(5000)}`)).toBeNull();
});

test("the emulator reports the title and the cwd the shell sets, even split across chunks and with either terminator", async () => {
  const titles: string[] = [];
  const cwds: string[] = [];
  const emu = createEmulator(40, 5, { title: (t) => titles.push(t), cwd: (p) => cwds.push(p) });
  emu.write("\x1b]0;my ti");
  emu.write("tle\x07");
  emu.write("\x1b]7;file://host/work/dir\x1b\\");
  await emu.idle();
  expect(titles).toEqual(["my title"]);
  expect(cwds).toEqual(["/work/dir"]);
  emu.dispose();
});

test("a snapshot restores the screen into a fresh emulator of the same size", async () => {
  const a = createEmulator(20, 4, { title() {}, cwd() {} });
  a.write("hello\r\nworld");
  await a.idle();
  const { data, truncated } = a.serialize();
  expect(truncated).toBe(false);
  expect(data).toContain("hello");
  expect(data).toContain("world");
  const b = createEmulator(20, 4, { title() {}, cwd() {} });
  b.write(data);
  await b.idle();
  expect(b.serialize().data).toBe(data);
  a.dispose();
  b.dispose();
});

test("lines() is plain text: no escapes, wrapped rows joined, trailing blanks trimmed, bounded to the last lines", async () => {
  const emu = createEmulator(10, 4, { title() {}, cwd() {} });
  emu.write("\x1b[31mred\x1b[0m line\r\n0123456789abcdef\r\n\r\nlast\r\n\r\n");
  await emu.idle();
  expect(emu.lines(100)).toEqual(["red line", "0123456789abcdef", "", "last"]);
  expect(emu.lines(2)).toEqual(["", "last"]);
  emu.dispose();
});

test("lines() reads the alternate screen while a full-screen program is up, and the scrollback after", async () => {
  const emu = createEmulator(20, 3, { title() {}, cwd() {} });
  emu.write("one\r\ntwo\r\nthree\r\nfour\r\n");
  emu.write("\x1b[?1049h\x1b[Htui screen");
  await emu.idle();
  expect(emu.lines(100)).toEqual(["tui screen"]);
  emu.write("\x1b[?1049l");
  await emu.idle();
  expect(emu.lines(100)).toEqual(["one", "two", "three", "four"]);
  emu.dispose();
});
