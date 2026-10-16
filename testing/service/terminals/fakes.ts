import type { ServerMessage } from "@harness/shared";
import type { CreateEmulator, Emulator, EmulatorEvents } from "../../../service/src/terminals/emulator";
import type { PtyProcess, SpawnPty, SpawnPtyOptions } from "../../../service/src/terminals/pty";
import type { TerminalClient } from "../../../service/src/terminals/registry";
import type { Timers } from "../../../service/src/terminals/sizing";

/** The timer seam the terminal code takes, driven by hand: `advance` runs what's due, in order. */
export function manualTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    get pending() {
      return pending.size;
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

export class FakePty implements PtyProcess {
  writes: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  kills: (string | undefined)[] = [];
  /** Make write and resize throw, as a closed master does before the exit is reported. */
  dead = false;
  constructor(
    readonly pid: number,
    readonly opts: SpawnPtyOptions,
    readonly file: string,
    readonly args: string[],
  ) {}
  write(data: string) {
    if (this.dead) throw new Error("closed");
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    if (this.dead) throw new Error("closed");
    this.resizes.push({ cols, rows });
  }
  kill(signal?: string) {
    this.kills.push(signal);
  }
  emit(text: string) {
    this.opts.onData(new TextEncoder().encode(text));
  }
  exit(code: number | null = 0) {
    this.opts.onExit({ exitCode: code, signal: null });
  }
}

export function fakeSpawn() {
  const ptys: FakePty[] = [];
  const spawn: SpawnPty = (file, args, opts) => {
    const pty = new FakePty(1000 + ptys.length, opts, file, args);
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

/** An emulator that keeps what it was fed, so a test sees exactly what the registry sent it. */
export class FakeEmulator implements Emulator {
  written: string[] = [];
  sizes: { cols: number; rows: number }[] = [];
  disposed = false;
  constructor(
    public cols: number,
    public rows: number,
    readonly events: EmulatorEvents,
  ) {}
  write(data: string) {
    this.written.push(data);
  }
  async idle() {}
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.sizes.push({ cols, rows });
  }
  serialize() {
    return { data: `SCREEN(${this.written.join("")})@${this.cols}x${this.rows}`, truncated: false };
  }
  dispose() {
    this.disposed = true;
  }
}

export function fakeEmulators() {
  const made: FakeEmulator[] = [];
  const create: CreateEmulator = (cols, rows, events) => {
    const e = new FakeEmulator(cols, rows, events);
    made.push(e);
    return e;
  };
  return { create, made };
}

export class FakeClient implements TerminalClient {
  messages: ServerMessage[] = [];
  queued = 0;
  constructor(readonly id: string) {}
  send(msg: ServerMessage) {
    this.messages.push(msg);
  }
  buffered() {
    return this.queued;
  }
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as never;
  }
}
