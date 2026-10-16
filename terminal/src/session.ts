// The client half of a terminal attach, with no DOM: what to do with each terminal.* message from
// the service. A snapshot restores the screen and says where live output continues (a byte offset);
// output continues from there. A chunk at or before what's been drawn is dropped, one that straddles
// it is trimmed, and a chunk that leaves a gap means output was lost, so the feed asks to resync
// (detach and attach again, which brings a fresh snapshot).

import type { ServerMessage } from "@harness/shared";

export type TerminalMessage = Extract<ServerMessage, { type: "terminal.snapshot" | "terminal.output" | "terminal.exit" }>;

export function isTerminalMessage(msg: ServerMessage): msg is TerminalMessage {
  return msg.type === "terminal.snapshot" || msg.type === "terminal.output" || msg.type === "terminal.exit";
}

/** What a feed draws on. */
export interface TerminalSink {
  /** Start over at this size: the next write is a snapshot. */
  reset(cols: number, rows: number): void;
  write(data: string): void;
  exited(exitCode: number | null): void;
  /** The snapshot began mid-history (the service keeps a bounded scrollback). */
  truncated?(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The part of `data` after its first `skip` UTF-8 bytes. */
export function dropBytes(data: string, skip: number): string {
  return decoder.decode(encoder.encode(data).slice(skip));
}

export class TerminalFeed {
  private seen = 0;
  private synced = false;
  private resyncing = false;

  constructor(
    private readonly id: string,
    private readonly sink: TerminalSink,
    private readonly resync: () => void,
  ) {}

  /** Whether a snapshot has been drawn and output is flowing. */
  get isSynced() {
    return this.synced;
  }

  /** The offset drawn up to. */
  get offset() {
    return this.seen;
  }

  /** The socket (re)connected: wait for a fresh snapshot, drawing nothing until it comes. */
  reconnecting() {
    this.synced = false;
    this.resyncing = true;
  }

  handle(msg: TerminalMessage) {
    if (msg.id !== this.id) return;
    switch (msg.type) {
      case "terminal.snapshot":
        this.sink.reset(msg.cols, msg.rows);
        if (msg.truncated) this.sink.truncated?.();
        if (msg.data) this.sink.write(msg.data);
        this.seen = msg.offset;
        this.synced = true;
        this.resyncing = false;
        return;
      case "terminal.output": {
        if (!this.synced) return; // before the snapshot, or while resyncing: the snapshot covers it
        const length = encoder.encode(msg.data).length;
        const start = msg.offset - length;
        if (msg.offset <= this.seen) return;
        if (start > this.seen) {
          // A gap: something was lost. Ask for a fresh snapshot, once.
          this.synced = false;
          if (!this.resyncing) {
            this.resyncing = true;
            this.resync();
          }
          return;
        }
        this.sink.write(start < this.seen ? dropBytes(msg.data, this.seen - start) : msg.data);
        this.seen = msg.offset;
        return;
      }
      case "terminal.exit":
        this.sink.exited(msg.exitCode);
        return;
    }
  }
}
