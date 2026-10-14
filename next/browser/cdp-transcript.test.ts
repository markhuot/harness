import { describe, expect, test } from "bun:test";
import { CdpClient } from "../../service/src/browser/cdp";
import type { MessageTransport } from "../../service/src/browser/websocket";
import { recordTransport, replayTransport, type Transcript } from "../support/cdp-transcript";

/** A stand-in for Chrome: answers Target.getTargets and fires an event after it. */
function fakeChrome(): MessageTransport {
  const t: MessageTransport = {
    onMessage: () => {},
    onClose: () => {},
    close() {},
    send(text) {
      const { id, method } = JSON.parse(text);
      queueMicrotask(() => {
        t.onMessage(JSON.stringify({ id, result: method === "Target.getTargets" ? { targetInfos: [{ targetId: "T1" }] } : {} }));
        if (method === "Target.getTargets") t.onMessage(JSON.stringify({ method: "Target.targetCreated", params: { targetId: "T2" } }));
      });
    },
  };
  return t;
}

async function record(): Promise<Transcript> {
  const log: Transcript = [];
  const client = new CdpClient(recordTransport(fakeChrome(), log));
  await client.send("Target.getTargets");
  await client.send("Page.enable", {}, "S1");
  client.close();
  return log;
}

describe("CDP transcripts", () => {
  test("recording keeps both directions in order", async () => {
    const log = await record();
    expect(log.map((m) => m.dir)).toEqual(["out", "in", "in", "out", "in"]);
    expect(JSON.parse(log[3]!.text)).toMatchObject({ method: "Page.enable", sessionId: "S1" });
  });

  test("a replay answers the client's commands and fires the recorded events", async () => {
    const replay = replayTransport(await record());
    const client = new CdpClient(replay);
    const created: unknown[] = [];
    client.on("Target.targetCreated", (p) => created.push(p));
    expect(await client.send("Target.getTargets")).toEqual({ targetInfos: [{ targetId: "T1" }] });
    await client.send("Page.enable", {}, "S1");
    expect(created).toEqual([{ targetId: "T2" }]);
    expect(replay.remaining()).toBe(0);
  });

  test("a response goes to the id the client used, even when the ids differ from the recording", async () => {
    const replay = replayTransport(await record());
    const client = new CdpClient(replay);
    // The recording's first command had id 1; this client has already used it.
    (client as unknown as { nextId: number }).nextId = 40;
    expect(await client.send("Target.getTargets")).toEqual({ targetInfos: [{ targetId: "T1" }] });
  });

  test("a command the recording doesn't have next is an error naming both", async () => {
    const client = new CdpClient(replayTransport(await record()));
    await expect(client.send("Page.navigate", { url: "https://x.test" })).rejects.toThrow(/Page\.navigate.*Target\.getTargets/s);
  });
});
