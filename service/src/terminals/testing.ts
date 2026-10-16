// Fakes for terminal tests: a manual clock with timers, a scripted PTY, and a socket client.

import type { ServerMessage } from "@harness/shared";
import type { PtyProcess, SpawnPty, SpawnPtyOptions } from "./pty";
import type { TerminalClient } from "./registry";
import type { Timers } from "./sizing";

export function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(h) {
      pending.delete(h as number);
    },
  };
  return {
    timers,
    now: () => now,
    /** Run every timer due within `ms`, in order, and move the clock there. */
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
  constructor(
    readonly pid: number,
    readonly opts: SpawnPtyOptions,
    readonly file: string,
    readonly args: string[],
  ) {}
  /** Set to make write and resize throw, as a closed master does before the exit is reported. */
  dead = false;
  write(data: string) {
    if (this.dead) throw new Error("Terminal is closed");
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    if (this.dead) throw new Error("Terminal is closed");
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
  /** Everything the client would have drawn: the snapshot, then output in order. */
  screen(): string {
    return this.messages.map((m) => (m.type === "terminal.snapshot" ? `\u0000SNAP:${m.data}` : m.type === "terminal.output" ? m.data : "")).join("");
  }
}
