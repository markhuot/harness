import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { RawWebSocket } from "./websocket.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Server-side frame (unmasked). */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (len >= 126 && len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Decode one masked client frame from the start of buf. */
function readClientFrame(buf: Buffer): { opcode: number; payload: Buffer; masked: boolean; size: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const mask = buf.subarray(off, off + 4);
  off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
  return { opcode, payload, masked, size: off + len };
}

interface Fake {
  port: number;
  server: Server;
  conn: Promise<Socket>;
  frames: { opcode: number; payload: Buffer; masked: boolean }[];
}

let fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes) f.server.close();
  fakes = [];
});

function fakeServer(opts: { status?: string; badAccept?: boolean } = {}): Promise<Fake> {
  return new Promise((resolve) => {
    const frames: Fake["frames"] = [];
    let onConn!: (s: Socket) => void;
    const conn = new Promise<Socket>((r) => (onConn = r));
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const end = buf.indexOf("\r\n\r\n");
          if (end === -1) return;
          const req = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 4);
          const key = /sec-websocket-key: (.+)/i.exec(req)![1]!.trim();
          const accept = opts.badAccept ? "nope" : createHash("sha1").update(key + GUID).digest("base64");
          sock.write(
            `${opts.status ?? "HTTP/1.1 101 Switching Protocols"}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upgraded = true;
          onConn(sock);
        }
        for (let f = readClientFrame(buf); f; f = readClientFrame(buf)) {
          frames.push(f);
          buf = buf.subarray(f.size);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const fake = { port, server, conn, frames };
      fakes.push(fake);
      resolve(fake);
    });
  });
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("RawWebSocket", () => {
  test("sends masked text frames, including 16- and 64-bit lengths", async () => {
    const fake = await fakeServer();
    const ws = await RawWebSocket.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/abc`);
    const big = "x".repeat(70_000);
    const mid = "é".repeat(200); // multi-byte: length is in bytes, not chars
    ws.send("hi");
    ws.send(mid);
    ws.send(big);
    await until(() => fake.frames.length === 3);
    expect(fake.frames.every((f) => f.masked && f.opcode === 1)).toBe(true);
    expect(fake.frames.map((f) => f.payload.toString("utf8"))).toEqual(["hi", mid, big]);
    ws.close();
  });

  test("reassembles fragmented and split server messages, incl. data sent with the handshake", async () => {
    const fake = await fakeServer();
    const got: string[] = [];
    const ws = await RawWebSocket.connect(`ws://127.0.0.1:${fake.port}/`);
    ws.onMessage = (m) => got.push(m);
    const sock = await fake.conn;
    const big = "y".repeat(100_000);
    const bytes = Buffer.concat([
      frame(1, Buffer.from("first"), false),
      frame(0, Buffer.from("-second"), true),
      frame(1, Buffer.from(big)),
    ]);
    // Deliver in awkward chunks that split headers and payloads.
    for (let i = 0; i < bytes.length; i += 7777) {
      sock.write(bytes.subarray(i, i + 7777));
      await Bun.sleep(1);
    }
    await until(() => got.length === 2);
    expect(got[0]).toBe("first-second");
    expect(got[1]).toBe(big);
    ws.close();
  });

  test("answers ping with pong carrying the same payload", async () => {
    const fake = await fakeServer();
    const ws = await RawWebSocket.connect(`ws://127.0.0.1:${fake.port}/`);
    (await fake.conn).write(frame(0x9, Buffer.from("are-you-there")));
    await until(() => fake.frames.length === 1);
    expect(fake.frames[0]!.opcode).toBe(0xa);
    expect(fake.frames[0]!.payload.toString()).toBe("are-you-there");
    ws.close();
  });

  test("server close frame reports the code and further sends throw", async () => {
    const fake = await fakeServer();
    const ws = await RawWebSocket.connect(`ws://127.0.0.1:${fake.port}/`);
    let reason = "";
    ws.onClose = (r) => (reason = r);
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1011);
    (await fake.conn).write(frame(0x8, Buffer.concat([payload, Buffer.from("going away")])));
    await until(() => reason !== "");
    expect(reason).toContain("1011");
    expect(reason).toContain("going away");
    expect(() => ws.send("late")).toThrow(/closed/);
  });

  test("rejects a non-101 handshake and a bad accept key", async () => {
    const refused = await fakeServer({ status: "HTTP/1.1 403 Forbidden" });
    await expect(RawWebSocket.connect(`ws://127.0.0.1:${refused.port}/`)).rejects.toThrow(/403/);
    const liar = await fakeServer({ badAccept: true });
    await expect(RawWebSocket.connect(`ws://127.0.0.1:${liar.port}/`)).rejects.toThrow(/Sec-WebSocket-Accept/);
    await expect(RawWebSocket.connect("wss://127.0.0.1:1/")).rejects.toThrow(/ws:\/\/ only/);
  });
});
