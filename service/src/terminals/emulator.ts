// The service's headless emulator for one terminal. It reads the shell's output beside the PTY and
// never writes to it. It holds the screen (grid, cursor, modes, alternate screen) and scrollback so
// an attaching client gets a snapshot to restore, and it reports the title and cwd the shell sets
// (OSC 0/2 and OSC 7), with the emulator's parser handling sequences split across chunks and both
// terminators (BEL, ST).

import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export const SCROLLBACK_LINES = 5000;
/** Output waiting to be parsed beyond this many characters is dropped from the emulator. */
export const MAX_BACKLOG = 8 * 1024 * 1024;
/** A title or cwd longer than this is ignored (a runaway sequence, not a title). */
const MAX_VALUE = 4096;

export interface EmulatorEvents {
  title(title: string): void;
  cwd(path: string): void;
}

export interface Emulator {
  /** Feed output; parsing is asynchronous, `idle()` resolves once everything fed is parsed. */
  write(data: string): void;
  idle(): Promise<void>;
  resize(cols: number, rows: number): void;
  /** Escape sequences that restore the screen into an empty emulator of the current size. */
  serialize(): { data: string; truncated: boolean };
  /**
   * The last `max` logical lines of the visible buffer (the alternate screen while a full-screen
   * program runs, else screen plus scrollback) as plain text: wrapped rows joined, trailing blanks
   * trimmed, no escape sequences.
   */
  lines(max: number): string[];
  dispose(): void;
}

export type CreateEmulator = (cols: number, rows: number, events: EmulatorEvents) => Emulator;

/** The path in an OSC 7 `file://host/path` URI, or null when it isn't one. */
export function parseCwdUri(uri: string): string | null {
  if (uri.length > MAX_VALUE || !uri.startsWith("file://")) return null;
  const slash = uri.indexOf("/", 7);
  if (slash === -1) return null;
  try {
    return decodeURIComponent(uri.slice(slash));
  } catch {
    return null;
  }
}

export const createEmulator: CreateEmulator = (cols, rows, events) => {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  term.onTitleChange((title) => {
    if (title.length <= MAX_VALUE) events.title(title);
  });
  term.parser.registerOscHandler(7, (data) => {
    const path = parseCwdUri(data);
    if (path) events.cwd(path);
    return true;
  });
  let pending = 0;
  let backlog = 0;
  let dropped = false;
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (--pending > 0) return;
    const done = waiters;
    waiters = [];
    for (const w of done) w();
  };
  return {
    write(data) {
      // xterm throws once ~50 MB is queued ("use flow control"). Past our own limit the output is
      // dropped from the emulator (clients still get it live) and the snapshot says it is truncated.
      if (backlog + data.length > MAX_BACKLOG) {
        dropped = true;
        return;
      }
      backlog += data.length;
      pending++;
      try {
        term.write(data, () => {
          backlog -= data.length;
          settle();
        });
      } catch {
        backlog -= data.length;
        dropped = true;
        settle();
      }
    },
    idle() {
      return pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
    resize(c, r) {
      // Queued behind the output already written, so that output is parsed at the old size.
      pending++;
      try {
        term.write("", () => {
          term.resize(c, r);
          settle();
        });
      } catch {
        term.resize(c, r);
        settle();
      }
    },
    serialize() {
      const data = serializer.serialize({ scrollback: SCROLLBACK_LINES });
      return { data, truncated: dropped || term.buffer.normal.length >= SCROLLBACK_LINES + term.rows };
    },
    lines(max) {
      const buf = term.buffer.active;
      const out: string[] = [];
      let current = "";
      for (let y = 0; y < buf.length; y++) {
        const row = buf.getLine(y);
        if (!row) continue;
        // A row that continues onto the next keeps its trailing cells so the join has no gap.
        const text = row.translateToString(!buf.getLine(y + 1)?.isWrapped);
        if (row.isWrapped) current += text;
        else {
          if (y > 0) out.push(current);
          current = text;
        }
      }
      out.push(current);
      while (out.length && out[out.length - 1] === "") out.pop();
      return out.slice(-Math.max(0, max));
    },
    dispose() {
      term.dispose();
    },
  };
};
