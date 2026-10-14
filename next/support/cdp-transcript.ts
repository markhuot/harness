// Record and replay of Chrome DevTools traffic at the MessageTransport seam CdpClient already has.
// Record: wrap the real transport while a real-Chrome run drives the browser, and save the log.
// Replay: stand in for Chrome from that log, so browser code runs in-process with no Chrome. A
// recorded transcript is what real Chrome said, not hand-written events.

import type { MessageTransport } from "../../service/src/browser/websocket";

export type Transcript = { dir: "out" | "in"; text: string }[];

/** Wrap `real`, appending every message either way to `log`. Hand the result to `new CdpClient(...)`. */
export function recordTransport(real: MessageTransport, log: Transcript): MessageTransport {
  const wrapped: MessageTransport = {
    send(text) {
      log.push({ dir: "out", text });
      real.send(text);
    },
    close: () => real.close(),
    onMessage: () => {},
    onClose: () => {},
  };
  real.onMessage = (text) => {
    log.push({ dir: "in", text });
    wrapped.onMessage(text);
  };
  real.onClose = (reason) => wrapped.onClose(reason);
  return wrapped;
}

const shape = (text: string) => {
  const { id: _id, ...rest } = JSON.parse(text) as { id?: number };
  return JSON.stringify(rest);
};

/**
 * Answer a client from a transcript. Each command the client sends must be the next recorded one
 * (method, params and session; the id may differ); the messages Chrome sent after it are delivered
 * in order, with the response carrying the id the client actually used. A command the recording
 * doesn't have next throws, naming both.
 */
export function replayTransport(transcript: Transcript): MessageTransport & { remaining(): number } {
  let at = 0;
  const t: MessageTransport & { remaining(): number } = {
    onMessage: () => {},
    onClose: () => {},
    remaining: () => transcript.slice(at).filter((m) => m.dir === "out").length,
    close() {},
    send(text) {
      // Chrome events that arrived before the next command was sent come first.
      while (transcript[at]?.dir === "in") deliver(transcript[at++]!.text);
      const expected = transcript[at++];
      if (!expected || shape(expected.text) !== shape(text)) {
        throw new Error(`CDP replay: the client sent ${text}, but the recording has ${expected ? expected.text : "nothing more to send"}`);
      }
      const sentId = (JSON.parse(text) as { id?: number }).id;
      const recordedId = (JSON.parse(expected.text) as { id?: number }).id;
      while (transcript[at]?.dir === "in") {
        const msg = JSON.parse(transcript[at++]!.text) as { id?: number };
        if (msg.id !== undefined && msg.id === recordedId) msg.id = sentId;
        deliver(JSON.stringify(msg));
      }
    },
  };
  // Delivered on a microtask, as a socket would: after the caller's `send` has returned.
  function deliver(text: string) {
    queueMicrotask(() => t.onMessage(text));
  }
  return t;
}
