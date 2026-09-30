// Messages a human sends to a run while it's going (DESIGN.md "Steering"). The orchestrator
// pushes; the driver takes them into the live conversation and reports when its agent has
// actually seen each one. Whatever is still undelivered when the run ends becomes a queued run.

export interface SteerMessage {
  /** Unique per message (claude-code sends it as the stream-json uuid and matches the CLI's replay) */
  id: string;
  text: string;
}

type Entry = SteerMessage & { taken: boolean; original: string };

export class RunInput {
  private entries: Entry[] = [];
  private closed = false;
  private listeners = new Set<() => void>();

  /**
   * Add a message for the running agent. False once the run stopped taking input. `original` is
   * what the human wrote when `text` has more in it (@-mentioned files attached); a message that
   * goes undelivered is queued as written, and its run attaches the files again.
   */
  push(text: string, original = text): boolean {
    if (this.closed) return false;
    this.entries.push({ id: crypto.randomUUID(), text, original, taken: false });
    for (const cb of this.listeners) cb();
    return true;
  }

  /** Messages the driver hasn't taken yet, in order. Taken ones stay undelivered until delivered(). */
  take(): SteerMessage[] {
    const out: SteerMessage[] = [];
    for (const e of this.entries) {
      if (e.taken) continue;
      e.taken = true;
      out.push({ id: e.id, text: e.text });
    }
    return out;
  }

  /** The agent has seen this message. Returns whether it was still undelivered. */
  delivered(id: string): boolean {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    return true;
  }

  /** Taken by the driver but not yet seen by the agent */
  inFlight(): SteerMessage[] {
    return this.entries.filter((e) => e.taken).map(({ id, text }) => ({ id, text }));
  }

  /** Any message not yet delivered (taken or not) */
  get pending(): boolean {
    return this.entries.length > 0;
  }

  /** Called on every successful push. Returns an unsubscribe function. */
  onPush(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Stop taking input: later pushes return false. */
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Every message not delivered, as the human wrote it, in the order they were pushed. */
  undelivered(): string[] {
    return this.entries.map((e) => e.original);
  }
}
