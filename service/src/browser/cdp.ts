// Minimal, dependency-free Chrome DevTools Protocol client over a WebSocket (websocket.ts).
//
// One CdpClient per browser-level WebSocket. Page targets are driven through *flattened*
// sessions (Target.attachToTarget { flatten: true }): every command/event for a target
// travels over the same socket, tagged with a top-level `sessionId`.

import { RawWebSocket, type MessageTransport } from "./websocket.ts";

export type CdpParams = Record<string, unknown>;
// CDP payloads are loosely typed; callers narrow what they read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CdpResult = any;
export type CdpEventHandler = (params: CdpResult, sessionId: string | undefined) => void;

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpTimeoutError extends CdpError {
  constructor(method: string, timeoutMs: number) {
    super(`CDP ${method} timed out after ${timeoutMs}ms`, method);
    this.name = "CdpTimeoutError";
  }
}

export class CdpClosedError extends CdpError {
  constructor(method: string, reason = "CDP connection closed") {
    super(`${reason} (${method})`, method);
    this.name = "CdpClosedError";
  }
}

interface Pending {
  method: string;
  sessionId?: string;
  resolve: (v: CdpResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpClientOptions {
  /** Default per-command timeout (ms). */
  timeoutMs?: number;
  /** Timeout for establishing the socket (ms). */
  connectTimeoutMs?: number;
}

export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<CdpEventHandler>>();
  private closeHandlers = new Set<(reason: string) => void>();
  private _closed = false;
  readonly timeoutMs: number;

  constructor(
    private transport: MessageTransport,
    opts: CdpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    transport.onMessage = (text) => this.onMessage(text);
    transport.onClose = (reason) => this.handleClose(`CDP connection closed (${reason})`);
  }

  /** Connect to a DevTools WebSocket URL (uncompressed; see websocket.ts for why). */
  static async connect(url: string, opts: CdpClientOptions = {}): Promise<CdpClient> {
    const ws = await RawWebSocket.connect(url, opts.connectTimeoutMs ?? 10_000);
    return new CdpClient(ws, opts);
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Send a command. `sessionId` routes it to a flattened target session. */
  send(method: string, params: CdpParams = {}, sessionId?: string, timeoutMs = this.timeoutMs): Promise<CdpResult> {
    if (this._closed) return Promise.reject(new CdpClosedError(method));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, sessionId, resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpClosedError(method, e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Subscribe to an event (any session). Returns an unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(method);
    };
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** A view of this client scoped to one flattened session. */
  session(sessionId: string): CdpSession {
    return new CdpSession(this, sessionId);
  }

  /** Resolve with the first matching event, or reject on timeout / close. */
  waitFor(
    method: string,
    opts: { sessionId?: string; timeoutMs?: number; predicate?: (params: CdpResult) => boolean } = {},
  ): Promise<CdpResult> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new CdpClosedError(method));
      const cleanup = () => {
        clearTimeout(timer);
        off();
        offClose();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      const off = this.on(method, (params, sid) => {
        if (opts.sessionId !== undefined && sid !== opts.sessionId) return;
        if (opts.predicate && !opts.predicate(params)) return;
        cleanup();
        resolve(params);
      });
      const offClose = this.onClose(() => {
        cleanup();
        reject(new CdpClosedError(method));
      });
    });
  }

  close(): void {
    if (this._closed) return;
    this.handleClose("CDP connection closed by client");
    try {
      this.transport.close();
    } catch {}
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const detail = msg.error.data ? `: ${String(msg.error.data)}` : "";
        p.reject(new CdpError(`CDP ${p.method} failed: ${msg.error.message ?? "unknown error"}${detail}`, p.method, msg.error.code, msg.error.data));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method !== "string") return;
    // A detached session will never answer; fail its in-flight commands now.
    if (msg.method === "Target.detachedFromTarget") {
      const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) this.rejectSession(sid, "Target detached");
    }
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(msg.params ?? {}, msg.sessionId);
      } catch (e) {
        console.error(`[cdp] handler for ${msg.method} threw:`, e);
      }
    }
  }

  private rejectSession(sessionId: string, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new CdpClosedError(p.method, reason));
    }
  }

  private handleClose(reason: string): void {
    if (this._closed) return;
    this._closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpClosedError(p.method, reason));
    }
    this.pending.clear();
    for (const h of [...this.closeHandlers]) {
      try {
        h(reason);
      } catch {}
    }
    this.closeHandlers.clear();
  }
}

/** A flattened target session sharing its parent client's socket. */
export class CdpSession {
  constructor(
    readonly client: CdpClient,
    readonly id: string,
  ) {}

  send(method: string, params: CdpParams = {}, timeoutMs?: number): Promise<CdpResult> {
    return this.client.send(method, params, this.id, timeoutMs);
  }

  on(method: string, handler: (params: CdpResult) => void): () => void {
    return this.client.on(method, (params, sid) => {
      if (sid === this.id) handler(params);
    });
  }

  waitFor(method: string, opts: { timeoutMs?: number; predicate?: (params: CdpResult) => boolean } = {}): Promise<CdpResult> {
    return this.client.waitFor(method, { ...opts, sessionId: this.id });
  }
}
