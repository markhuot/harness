// Notifications through the whole service: device routes over REST, presence over a real
// WebSocket, and activity from real orchestrator flows reaching a fake APNs transport.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type HarnessEvent } from "@harness/shared";
import { onTempCleanup } from "@harness/shared/testing";
import { createHarness, type Harness } from "../app";
import { FakeDriver, stubBrowser, tempHome } from "../testing/fakes";
import type { ApnsHttpResponse, ApnsTransport } from "./apns";

class FakeTransport implements ApnsTransport {
  posts: { origin: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  async post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ApnsHttpResponse> {
    this.posts.push({ origin, path, headers, body: JSON.parse(body) });
    return { status: 200, body: "", headers: {} };
  }
  close() {}
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

const PEM = (await import("node:crypto")).generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TOKEN = "d".repeat(64);

async function boot() {
  const home = tempHome("harness-notify-");
  const fake = new FakeDriver("fake");
  const apns = new FakeTransport();
  harness = await createHarness({ home, port: 0, drivers: [fake], browser: stubBrowser(), watchers: null, log: () => {}, apnsTransport: apns });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  const keyDir = join(home, "keys");
  mkdirSync(keyDir);
  writeFileSync(join(keyDir, "AuthKey_D2RG5FFJC5_APN_Production.p8"), PEM);
  await client.updateSettings({ defaultDriver: "fake", notifications: { apnsKeyDir: keyDir } });
  const dir = join(home, "work", "acme");
  mkdirSync(dir, { recursive: true });
  const project = await client.createProject({ path: dir, key: "SPEC" });
  return { h: harness, client, fake, apns, project, keyDir };
}

function socket(client: HarnessClient) {
  const events: HarnessEvent[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));
  const s = client.connect({ onEvent: (e) => events.push(e), onStatus: (up) => up && connected() });
  onTempCleanup(() => s.close());
  return { s, events, ready };
}

async function until(fn: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("notifications end to end", () => {
  test("devices over REST: register, list without the token, remove; devices.changed fires", async () => {
    const { client } = await boot();
    const { events, ready } = socket(client);
    await ready;
    const d = await client.registerDevice({ id: "mac-1", platform: "mac", name: "Mac", apnsToken: TOKEN, environment: "production" });
    expect(d).toMatchObject({ id: "mac-1", topic: "com.markhuot.harness", tokenSuffix: "dddddddd" });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    const status = await client.notificationStatus();
    expect(status.devices.map((x) => x.id)).toEqual(["mac-1"]);
    expect(status.keys.find((k) => k.environment === "production")?.keyId).toBe("D2RG5FFJC5");
    expect(status.keys.find((k) => k.environment === "sandbox")?.keyId).toBeNull();
    await until(() => events.some((e) => e.kind === "devices.changed"));
    await client.removeDevice("mac-1");
    expect((await client.notificationStatus()).devices).toEqual([]);
    await expect(client.removeDevice("mac-1")).rejects.toBeInstanceOf(HarnessApiError);
    await expect(client.registerDevice({ id: "x", platform: "ios", name: "", apnsToken: "zz", environment: "production" })).rejects.toThrow("apnsToken");
  });

  test("settings: partial notifications patches merge per category; unknown categories are refused", async () => {
    const { client, keyDir } = await boot();
    const s = await client.updateSettings({ notifications: { categories: { notes: false } } });
    expect(s.notifications).toEqual({ enabled: true, categories: { status: true, review: true, notes: false, spec: true, other: true }, apnsKeyDir: keyDir, apnsTeamId: "47P4ZSALX4" });
    const t = await client.updateSettings({ notifications: { enabled: false } });
    expect(t.notifications?.categories.notes).toBe(false);
    expect(t.notifications?.enabled).toBe(false);
    await expect(client.updateSettings({ notifications: { categories: { chatter: true } as never } })).rejects.toThrow("Unknown notification category");
  });

  test("an agent's run notifies; presence over the socket suppresses it; a closed socket stops suppressing", async () => {
    const { h, client, apns, project } = await boot();
    await client.registerDevice({ id: "ios-1", platform: "ios", name: "iPhone", apnsToken: TOKEN, environment: "production" });

    // Nothing on screen: the work run's entries (submitted, review decision, …) notify.
    const a = await client.createTicket({ projectId: project.id, spec: "do it", title: "First" });
    await h.orchestrator.idle();
    await h.notifications.idle();
    const forA = apns.posts.filter((p) => (p.body as { ticketKey?: string }).ticketKey === a.key);
    expect(forA.length).toBeGreaterThan(0);
    expect(forA[0]!.origin).toBe("https://api.push.apple.com");
    expect(forA[0]!.path).toBe(`/3/device/${TOKEN}`);
    expect(forA[0]!.headers["apns-topic"]).toBe("com.markhuot.harness");

    // The phone shows the next ticket while its run goes: nothing for it.
    const { s, ready } = socket(client);
    await ready;
    const b = await client.createTicket({ projectId: project.id, spec: "do it", title: "Second", start: false });
    await h.orchestrator.idle();
    await h.notifications.idle();
    apns.posts = [];
    s.setPresence({ deviceId: "ios-1", platform: "ios", visible: true, tickets: [b.key] });
    await until(() => h.notifications["opts"].presence.isOnScreen(b.key));
    const before = Date.now();
    await client.updateTicket(b.key, { status: "in_progress" });
    await h.orchestrator.idle();
    await h.notifications.idle();
    // The run did write agent activity (so the silence is the presence's doing).
    expect(h.orchestrator.activity(b.key).filter((e) => e.author !== "human" && e.createdAt >= before).length).toBeGreaterThan(0);
    expect(apns.posts.filter((p) => (p.body as { ticketKey?: string }).ticketKey === b.key)).toEqual([]);

    // The app went to the background: it notifies again.
    s.setPresence({ deviceId: "ios-1", platform: "ios", visible: false, tickets: [b.key] });
    await until(() => !h.notifications["opts"].presence.isOnScreen(b.key));
    s.setPresence({ deviceId: "ios-1", platform: "ios", visible: true, tickets: [b.key] });
    await until(() => h.notifications["opts"].presence.isOnScreen(b.key));
    s.close();
    await until(() => !h.notifications["opts"].presence.isOnScreen(b.key));
  });

  test("a malformed presence is answered with an error and changes nothing", async () => {
    const { h, client } = await boot();
    const ws = new WebSocket(h.url.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(h.token)}`);
    const errors: string[] = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === "error") errors.push(msg.message);
    };
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "presence", deviceId: "x", platform: "android", visible: true, tickets: ["SPEC-1"] }));
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("presence");
    expect(h.notifications["opts"].presence.all()).toEqual([]);
    ws.close();
    void client;
  });
});
