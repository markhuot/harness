import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnd, confineOutputPath, readSnapshot, readTaskOutput, snapshotTaskOutput, stripAnsi, TASK_OUTPUT_MAX_BYTES, unavailable } from "../../service/src/task-output";
import { tempDir } from "../builders/tmp";

const bytes = (s: string) => Buffer.from(s, "utf8");

test("a read stops before a UTF-8 character or an escape sequence that's been cut short", () => {
  const euro = bytes("a€");
  expect(cleanEnd(euro)).toBe(euro.length);
  expect(cleanEnd(euro.subarray(0, 2))).toBe(1);
  expect(cleanEnd(euro.subarray(0, 3))).toBe(1);
  expect(cleanEnd(bytes("ok\x1b[3"))).toBe(2);
  expect(cleanEnd(bytes("ok\x1b[31m"))).toBe(7);
  expect(cleanEnd(bytes("ok\x1b]0;title"))).toBe(2);
  expect(cleanEnd(bytes("ok\x1b]0;title\x07"))).toBe(12);
  expect(cleanEnd(bytes("ok\x1b"))).toBe(2);
  expect(cleanEnd(bytes(""))).toBe(0);
});

test("colors, cursor moves and titles are stripped from what's sent", () => {
  expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07plain \x1b[2K\x1b[1Gdone")).toBe("red plain done");
});

test("a task's output file is read from the tail by default and from an offset after that", () => {
  const dir = tempDir();
  const path = join(dir, "t.output");
  writeFileSync(path, "line one\nline two\n");
  const all = readTaskOutput(path, undefined, false);
  expect(all).toEqual({ text: "line one\nline two\n", start: 0, end: 18, size: 18, done: false, available: true });
  writeFileSync(path, "line one\nline two\nline three\n");
  const next = readTaskOutput(path, all.end, false);
  expect(next).toMatchObject({ text: "line three\n", start: 18, end: 29, size: 29 });
});

test("a read past the size cap skips ahead to the tail, and the start says where it landed", () => {
  const path = join(tempDir(), "big.output");
  writeFileSync(path, "x".repeat(100) + "TAIL");
  const out = readTaskOutput(path, 0, false, 10);
  expect(out).toMatchObject({ text: "xxxxxxTAIL", start: 94, end: 104, size: 104 });
  const tail = readTaskOutput(path, undefined, true, 10);
  expect(tail.text).toBe("xxxxxxTAIL");
});

test("a running task's read doesn't end inside a character, but a finished task's does end where the file does", () => {
  const path = join(tempDir(), "t.output");
  writeFileSync(path, Buffer.concat([bytes("ab"), bytes("€").subarray(0, 2)]));
  expect(readTaskOutput(path, undefined, false)).toMatchObject({ text: "ab", end: 2, size: 4 });
  expect(readTaskOutput(path, undefined, true).end).toBe(4);
});

test("a read starting mid-file skips the continuation bytes of a character it landed in the middle of", () => {
  const path = join(tempDir(), "t.output");
  writeFileSync(path, bytes("a€b"));
  expect(readTaskOutput(path, undefined, true, 3)).toMatchObject({ start: 4, text: "b" });
});

test("a file that isn't there is unavailable, at the offset asked for", () => {
  expect(readTaskOutput(join(tempDir(), "nope"), 7, false)).toEqual(unavailable(7, false));
  expect(unavailable(undefined, true)).toEqual({ text: "", start: 0, end: 0, size: 0, done: true, available: false });
});

test("the tail kept when a task ends reads back like the file, from any offset, with escapes stripped", () => {
  const path = join(tempDir(), "t.output");
  writeFileSync(path, "\x1b[32mhello\x1b[0m world\n");
  const snap = snapshotTaskOutput(path)!;
  expect(snap.text).toBe("\x1b[32mhello\x1b[0m world\n");
  expect(readSnapshot(snap, undefined)).toMatchObject({ text: "hello world\n", done: true, available: true });
  expect(readSnapshot({ text: "abcdef", start: 10, size: 16 }, 13)).toMatchObject({ text: "def", start: 13, end: 16 });
  expect(readSnapshot({ text: "abcdef", start: 10, size: 16 }, 2)).toMatchObject({ text: "abcdef", start: 10 });
  expect(readSnapshot({ text: "abc", start: 0, size: 3 }, 99)).toMatchObject({ text: "", start: 3, end: 3 });
  expect(snapshotTaskOutput(join(tempDir(), "gone"))).toBeNull();
  expect(TASK_OUTPUT_MAX_BYTES).toBe(256 * 1024);
});

test("only a file inside one of the allowed folders may be read, whatever path the CLI named", () => {
  // The folder the service allows is a real path (taskOutputRoots adds the realpath of each root).
  const root = realpathSync(tempDir());
  const outside = tempDir();
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "t.output"), "x");
  writeFileSync(join(outside, "secret"), "s");
  symlinkSync(join(outside, "secret"), join(root, "a", "link"));
  expect(confineOutputPath(join(root, "a", "t.output"), [root])).toBeTruthy();
  expect(confineOutputPath(join(outside, "secret"), [root])).toBeNull();
  expect(confineOutputPath(join(root, "a", "link"), [root])).toBeNull();
  expect(confineOutputPath(join(root, "a", "missing"), [root])).toBeNull();
  expect(confineOutputPath("", [root])).toBeNull();
  expect(confineOutputPath(`${join(root, "a")}\0/../../etc/passwd`, [root])).toBeNull();
});
