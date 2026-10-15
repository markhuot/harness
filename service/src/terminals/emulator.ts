// The service's headless emulator for one terminal. It reads the shell's output beside the PTY and
// never writes to it. It holds the screen (grid, cursor, modes, alternate screen) and scrollback so
// an attaching client gets a snapshot to restore, and it reports the title and cwd the shell sets
// (OSC 0/2 and OSC 7), with the emulator's parser handling sequences split across chunks and both
// terminators (BEL, ST).

import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export const SCROLLBACK_LINES = 5000;
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
  let waiters: (() => void)[] = [];
  return {
    write(data) {
      pending++;
      term.write(data, () => {
        if (--pending > 0) return;
        const done = waiters;
        waiters = [];
        for (const w of done) w();
      });
    },
    idle() {
      return pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
    resize(c, r) {
      term.resize(c, r);
    },
    serialize() {
      const data = serializer.serialize({ scrollback: SCROLLBACK_LINES });
      return { data, truncated: term.buffer.normal.length >= SCROLLBACK_LINES + term.rows };
    },
    dispose() {
      term.dispose();
    },
  };
};
