// Reading a background task's output (DESIGN.md "Background tasks"). Claude Code writes each
// background Bash command's or Monitor's output to a file under its temp folder
// (/tmp/claude-<uid>/<cwd>/<session>/tasks/<task>.output); the service reads it in bounded
// slices for GET /sessions/:id/subagents/:subagentId/output, and keeps the tail once the task ends.

import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskOutput } from "@harness/shared";
import { inside } from "./safe-path";

/** The most output one read sends, and what's kept when a task ends. */
export const TASK_OUTPUT_MAX_BYTES = 256 * 1024;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

/**
 * The folders the CLI keeps task output in: `claude-<uid>` under /tmp, $CLAUDE_CODE_TMPDIR and
 * the OS temp folder. Paths come from the CLI's stream-json, so a read outside them is refused.
 */
export function taskOutputRoots(): string[] {
  const bases = ["/tmp", process.env.CLAUDE_CODE_TMPDIR, tmpdir()].filter((b): b is string => !!b);
  const roots = new Set<string>();
  for (const base of bases) {
    const root = join(base, `claude-${uid()}`);
    roots.add(root);
    try {
      roots.add(realpathSync(root));
    } catch {
      // not there (yet): the plain path still covers files created later
    }
  }
  return [...roots];
}

/** The folder the dummy driver writes its fake task output to (inside taskOutputRoots). */
export const dummyTaskOutputDir = () => join("/tmp", `claude-${uid()}`, "harness-dummy");

/** The real path of `path` when it's a file inside one of `roots`, else null. */
export function confineOutputPath(path: string, roots = taskOutputRoots()): string | null {
  if (!path || path.includes("\0")) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  return roots.some((root) => inside(real, root)) ? real : null;
}

const ESC = 0x1b;

/**
 * How many leading bytes of `buf` decode cleanly: not ending inside a UTF-8 sequence or a terminal
 * escape sequence, so the next read picks up the rest. Only for a read that may be cut short.
 */
export function cleanEnd(buf: Uint8Array): number {
  let end = buf.length;
  // A UTF-8 sequence cut short: back up to its lead byte when it's missing continuation bytes.
  for (let i = end - 1, n = 0; i >= 0 && n < 4; i--, n++) {
    const b = buf[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (end - i < need) end = i;
    break;
  }
  // An escape sequence cut short: an ESC in the last few bytes with no final byte after it.
  for (let i = end - 1; i >= Math.max(0, end - 32); i--) {
    if (buf[i] !== ESC) continue;
    if (!escapeComplete(buf.subarray(i, end))) end = i;
    break;
  }
  return end;
}

function escapeComplete(seq: Uint8Array): boolean {
  if (seq.length < 2) return false;
  const kind = seq[1]!;
  if (kind === 0x5b) {
    // CSI: parameters, then a final byte in @..~
    for (let i = 2; i < seq.length; i++) if (seq[i]! >= 0x40 && seq[i]! <= 0x7e) return true;
    return false;
  }
  if (kind === 0x5d) {
    // OSC: ends with BEL or ESC \
    for (let i = 2; i < seq.length; i++) if (seq[i] === 0x07 || (seq[i] === ESC && seq[i + 1] === 0x5c)) return true;
    return false;
  }
  return true;
}

/** Skip continuation bytes at the start of a slice that begins mid-file. */
function cleanStart(buf: Uint8Array): number {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** Terminal escape sequences (colors, cursor moves, titles), removed from the text we send. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export const stripAnsi = (text: string) => text.replace(ANSI, "");

/**
 * Read a slice of the output file at `path` (already confined). Without `offset`, the tail; with
 * one, what follows it, skipping ahead to the tail when more than `max` bytes came in since.
 */
export function readTaskOutput(path: string, offset: number | undefined, done: boolean, max = TASK_OUTPUT_MAX_BYTES): TaskOutput {
  const raw = readRaw(path, offset, done, max);
  return raw ? { ...raw, text: stripAnsi(raw.text) } : unavailable(offset, done);
}

/** readTaskOutput without removing escapes (offsets stay byte positions in the file). */
function readRaw(path: string, offset: number | undefined, done: boolean, max: number): Omit<TaskOutput, "available"> & { available: true } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let start = offset === undefined ? Math.max(0, size - max) : Math.min(Math.max(0, offset), size);
    if (size - start > max) start = size - max;
    const buf = Buffer.alloc(size - start);
    const read = buf.length ? readSync(fd, buf, 0, buf.length, start) : 0;
    let bytes = buf.subarray(0, read);
    const skip = start > 0 && start !== offset ? cleanStart(bytes) : 0;
    bytes = bytes.subarray(skip);
    // A finished task's file is complete; a running one may stop mid-character.
    const end = done ? bytes.length : cleanEnd(bytes);
    return {
      text: bytes.subarray(0, end).toString("utf8"),
      start: start + skip,
      end: start + skip + end,
      size,
      done,
      available: true,
    };
  } finally {
    closeSync(fd);
  }
}

/** The same read over the tail kept when the task ended (raw text, as snapshotTaskOutput keeps it). */
export function readSnapshot(snapshot: { text: string; start: number; size: number }, offset: number | undefined): TaskOutput {
  const bytes = Buffer.from(snapshot.text, "utf8");
  const end = snapshot.start + bytes.length;
  const from = offset === undefined || offset < snapshot.start ? snapshot.start : Math.min(offset, end);
  let slice = bytes.subarray(from - snapshot.start);
  const skip = from > snapshot.start ? cleanStart(slice) : 0;
  slice = slice.subarray(skip);
  return { text: stripAnsi(slice.toString("utf8")), start: from + skip, end, size: snapshot.size, done: true, available: true };
}

/** The tail of a finished task's output, to keep. Raw, so its offsets match the file's. */
export function snapshotTaskOutput(path: string): { text: string; start: number; size: number } | null {
  const out = readRaw(path, undefined, true, TASK_OUTPUT_MAX_BYTES);
  return out ? { text: out.text, start: out.start, size: out.size } : null;
}

export function unavailable(offset: number | undefined, done: boolean): TaskOutput {
  const at = offset ?? 0;
  return { text: "", start: at, end: at, size: 0, done, available: false };
}
