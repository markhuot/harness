// A minimal RFC 6455 WebSocket client over node:net, without permessage-deflate.
//
// Why not Bun's global WebSocket: Bun (1.2.x) always offers permessage-deflate, Chrome's
// DevTools server accepts it, and after enough traffic Bun's inflater fails with
// "1002 Invalid compressed data", dropping the connection. There is no client option to
// turn compression off, so we speak the (small) uncompressed protocol ourselves.

import { randomBytes, createHash } from "node:crypto";
import { connect, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MessageTransport {
  send(text: string): void;
  close(): void;
  onMessage: (text: string) => void;
  onClose: (reason: string) => void;
}

export class RawWebSocket implements MessageTransport {
  onMessage: (text: string) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;

  private constructor(private socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.finish("socket closed"));
    socket.on("error", (e) => this.finish(`socket error: ${e.message}`));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<RawWebSocket> {
    const u = new URL(url);
    if (u.protocol !== "ws:") return Promise.reject(new Error(`Unsupported WebSocket URL (ws:// only): ${url}`));
    const port = Number(u.port || 80);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");

    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      let head = Buffer.alloc(0);
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Failed to connect to ${url}: ${why}`));
      };
      const timer = setTimeout(() => fail("timed out"), timeoutMs);
      socket.on("error", (e) => fail(e.message));
      socket.on("close", () => fail("connection closed during handshake"));
      socket.on("connect", () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      const onHandshakeData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onHandshakeData);
        const lines = head.subarray(0, end).toString("latin1").split("\r\n");
        const status = lines[0] ?? "";
        if (!/^HTTP\/1\.1 101/.test(status)) return fail(`unexpected handshake response: ${status}`);
        const headers = new Map(
          lines.slice(1).map((l) => {
            const i = l.indexOf(":");
            return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as const;
          }),
        );
        if (headers.get("sec-websocket-accept") !== expectedAccept) return fail("bad Sec-WebSocket-Accept");
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        const ws = new RawWebSocket(socket);
        resolve(ws);
        const rest = head.subarray(end + 4);
        if (rest.length) ws.onData(rest);
      };
      socket.on("data", onHandshakeData);
    });
  }

  send(text: string): void {
    if (this.closed) throw new Error("WebSocket is closed");
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(): void {
    if (this.closed) return;
    try {
      this.writeFrame(0x8, Buffer.from([0x03, 0xe8])); // 1000 normal closure
    } catch {}
    this.socket.end();
    this.finish("closed by client");
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose(reason);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    const headerLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const frame = Buffer.allocUnsafe(headerLen + 4 + len);
    frame[0] = 0x80 | opcode; // FIN
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    mask.copy(frame, headerLen);
    const off = headerLen + 4;
    for (let i = 0; i < len; i++) frame[off + i] = payload[i]! ^ mask[i & 3]!;
    this.socket.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const m = b.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ m[i & 3]!;
      }
      this.buf = b.subarray(off + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: {
        // binary
        // Copy: payload may be a view into a buffer that gets reused.
        this.fragments.push(Buffer.from(payload));
        if (!fin) return;
        const msg = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.onMessage(msg);
        return;
      }
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        try {
          this.writeFrame(0x8, payload.subarray(0, 2));
        } catch {}
        this.finish(`closed by server (${code}${payload.length > 2 ? ` ${payload.subarray(2).toString("utf8")}` : ""})`);
        return;
      }
      case 0x9: // ping
        this.writeFrame(0xa, payload);
        return;
      case 0xa: // pong
        return;
      default:
        this.finish(`protocol error: unknown opcode ${opcode}`);
    }
  }
}
