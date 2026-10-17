import type { ClientMessage, HarnessEvent, ServerMessage } from "@harness/shared";

/**
 * A `/ws` client that keeps every message from the moment the socket is created (the service
 * sends `welcome` on open and the bus is synchronous, so a client that starts listening later
 * would miss events). `ready` resolves at `welcome`. `next` takes the first message after the
 * last one taken that matches, waiting on the socket (never on a timer); it rejects if the socket
 * closes first.
 */
export class WsClient {
  readonly messages: ServerMessage[] = [];
  /** The close code once the socket has closed. */
  closed: { code: number; reason: string } | null = null;
  readonly ready: Promise<ServerMessage>;
  private cursor = 0;
  private socket: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (e) => {
      this.messages.push(JSON.parse(String(e.data)) as ServerMessage);
      this.wake();
    };
    this.socket.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    };
    this.ready = this.next((m) => m.type === "welcome");
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  send(msg: ClientMessage | { type: string; [k: string]: unknown }) {
    this.socket.send(JSON.stringify(msg));
  }

  sendRaw(text: string) {
    this.socket.send(text);
  }

  /** The next message (after the last taken) that satisfies `match`. */
  async next(match: (m: ServerMessage) => boolean = () => true): Promise<ServerMessage> {
    for (;;) {
      while (this.cursor < this.messages.length) {
        const m = this.messages[this.cursor++]!;
        if (match(m)) return m;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code} ${this.closed.reason}) before the message arrived`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** The next event of `kind` (optionally also satisfying `where`). */
  async event<K extends HarnessEvent["kind"]>(kind: K, where: (e: Extract<HarnessEvent, { kind: K }>) => boolean = () => true): Promise<Extract<HarnessEvent, { kind: K }>> {
    const m = await this.next((m) => m.type === "event" && m.event.kind === kind && where(m.event as never));
    return (m as unknown as { event: Extract<HarnessEvent, { kind: K }> }).event;
  }

  /** Every event received so far, in arrival order. */
  events(): HarnessEvent[] {
    return this.messages.flatMap((m) => (m.type === "event" ? [m.event] : []));
  }

  /** Resolves once the service (or `close()`) has closed the socket. */
  async waitClosed(): Promise<{ code: number; reason: string }> {
    while (!this.closed) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.closed;
  }

  close() {
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close();
  }
}
