import { afterEach, expect, test } from "bun:test";
import type { BrowserService } from "../../service/src/browser/types";
import { QuietBrowser } from "../builders/harness";
import { boot, stopRigs } from "./boot";
import type { WsClient } from "./ws-client";

afterEach(stopRigs);

/** Everything but events, in order: the replies a socket gets to what it sent. */
const replies = (ws: WsClient) => ws.messages.filter((m) => m.type !== "event" && m.type !== "welcome");

/** Sends `ping` and waits for its `pong`: anything the service answered before it is in `replies` by then. */
async function fence(ws: WsClient) {
  ws.send({ type: "ping" });
  await ws.next((m) => m.type === "pong");
}

test("the first thing a socket gets is welcome with the service's version", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  expect(ws.messages[0]).toMatchObject({ type: "welcome", version: expect.any(String) });
});

test("ping is answered with pong", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  ws.send({ type: "ping" });
  expect(await ws.next((m) => m.type === "pong")).toEqual({ type: "pong" });
});

test("a message that isn't JSON, or has no known type, is answered with {type:'error'} and the socket stays open", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  ws.sendRaw("{nope");
  expect(await ws.next((m) => m.type === "error")).toEqual({ type: "error", message: "Invalid JSON" });
  ws.send({ type: "teleport" });
  expect(await ws.next((m) => m.type === "error")).toEqual({ type: "error", message: "Unknown message type: teleport" });
  ws.sendRaw("null");
  expect(await ws.next((m) => m.type === "error")).toEqual({ type: "error", message: "Unknown message type: undefined" });
  await fence(ws);
  expect(ws.closed).toBeNull();
});

test("hello and a valid presence are accepted without a reply, an incomplete presence is an error", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  ws.send({ type: "hello", client: "test" });
  ws.send({ type: "presence", deviceId: "d1", platform: "ios", visible: true, tickets: ["ACME-1"] });
  await fence(ws);
  expect(replies(ws)).toEqual([{ type: "pong" }]);
  ws.send({ type: "presence", deviceId: "d1" });
  expect(await ws.next((m) => m.type === "error")).toMatchObject({ type: "error", message: expect.stringMatching(/presence needs deviceId/) });
});

test("attaching to a terminal that doesn't exist reads as ended, not as an error", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  ws.send({ type: "terminal.attach", id: "nope", deviceId: "d1", cols: 80, rows: 24 });
  expect(await ws.next((m) => m.type === "terminal.exit")).toEqual({ type: "terminal.exit", id: "nope", exitCode: null });
  ws.send({ type: "terminal.write", id: "nope", data: "ls\n" });
  expect(await ws.next((m) => m.type === "terminal.exit")).toEqual({ type: "terminal.exit", id: "nope", exitCode: null });
  await fence(ws);
  expect(replies(ws).some((m) => m.type === "error")).toBe(false);
});

test("a browser request the browser can't serve comes back as an error naming it, and the socket stays open", async () => {
  const rig = await boot(); // QuietBrowser rejects subscribe and input
  const ws = await rig.socket();
  ws.send({ type: "browser.subscribe", sessionId: "s1" });
  expect(await ws.next((m) => m.type === "error")).toMatchObject({ message: expect.stringMatching(/^browser\.subscribe failed/) });
  ws.send({ type: "browser.input", sessionId: "s1", input: { type: "reload" } });
  expect(await ws.next((m) => m.type === "error")).toMatchObject({ message: expect.stringMatching(/^browser\.input failed/) });
  await fence(ws);
  expect(ws.closed).toBeNull();
});

/** A browser that lets a socket subscribe and records who unsubscribed. */
class WatchableBrowser extends QuietBrowser implements Pick<BrowserService, "subscribe"> {
  subscribers: string[] = [];
  unsubscribed: { sessionId: string; subscriberId: string }[] = [];
  private onUnsubscribe: (() => void)[] = [];
  override subscribe = (async (_sessionId: string, subscriberId: string) => {
    this.subscribers.push(subscriberId);
  }) as never;
  override unsubscribe = (async (sessionId: string, subscriberId: string) => {
    this.unsubscribed.push({ sessionId, subscriberId });
    for (const f of this.onUnsubscribe.splice(0)) f();
  }) as never;
  nextUnsubscribe() {
    return new Promise<void>((resolve) => this.onUnsubscribe.push(resolve));
  }
}

test("browser frames and state go only to the sockets watching that session; everything else goes to all", async () => {
  const browser = new WatchableBrowser();
  const rig = await boot({ browser });
  const [watcher, other] = [await rig.socket(), await rig.socket()];
  watcher.send({ type: "browser.subscribe", sessionId: "s1", viewerId: "v1" });
  await fence(watcher);

  const state = { url: "https://example.test/", title: "Example" } as never;
  rig.harness.bus.emit({ kind: "browser.state", sessionId: "s1", state });
  rig.harness.bus.emit({ kind: "browser.state", sessionId: "s2", state });
  rig.harness.bus.emit({ kind: "devices.changed" });
  await watcher.event("devices.changed");
  await other.event("devices.changed");

  const browserEvents = (ws: WsClient) => ws.events().flatMap((e) => (e.kind === "browser.state" ? [e.sessionId] : []));
  expect(browserEvents(watcher)).toEqual(["s1"]);
  expect(browserEvents(other)).toEqual([]);
});

test("a socket's browser viewers are unsubscribed when it closes", async () => {
  const browser = new WatchableBrowser();
  const rig = await boot({ browser });
  const ws = await rig.socket();
  ws.send({ type: "browser.subscribe", sessionId: "s1", viewerId: "left" });
  ws.send({ type: "browser.subscribe", sessionId: "s1", viewerId: "right" });
  await fence(ws);
  expect(browser.subscribers).toHaveLength(2);
  const done = Promise.all([browser.nextUnsubscribe(), browser.nextUnsubscribe()]);
  ws.close();
  await done;
  expect(browser.unsubscribed.map((u) => u.subscriberId).sort()).toEqual([...browser.subscribers].sort());
});
