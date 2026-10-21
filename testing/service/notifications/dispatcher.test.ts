import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { APNS_TOPIC, DEFAULT_NOTIFICATION_SETTINGS, type ActivityEntry, type NotificationSettings } from "@harness/shared";
import { EventBus } from "../../../service/src/events";
import { ApnsClient, ApnsTokens, type ApnsHttpResponse, type ApnsTransport } from "../../../service/src/notifications/apns";
import { NotificationService, pushPayload, skipReason, validateDeviceBody } from "../../../service/src/notifications/dispatcher";
import { PresenceRegistry } from "../../../service/src/notifications/presence";
import { HarnessError } from "../../../service/src/orchestrator/errors";
import { fakeClock } from "../../builders/clock";
import { addProject, addTicket, makeStore } from "../../builders/store";
import { tempDir } from "../../builders/tmp";

const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, ...over });
const entry = (over: Partial<ActivityEntry> = {}) => ({ kind: "note" as const, author: "agent" as const, meta: {}, ...over });
const ticket = { key: "T-1", parentId: null as string | null };

test("skipReason checks, in order: no ticket, human author, master switch, category, conductor child, on screen", () => {
  const off = () => false;
  expect(skipReason(entry(), null, settings(), off)).toBe("no_ticket");
  expect(skipReason(entry({ author: "human" }), ticket, settings({ enabled: false }), off)).toBe("human");
  expect(skipReason(entry(), ticket, settings({ enabled: false }), off)).toBe("disabled");
  expect(skipReason(entry(), ticket, settings({ categories: { ...DEFAULT_NOTIFICATION_SETTINGS.categories, notes: false } }), off)).toBe("category");
  expect(skipReason(entry(), { ...ticket, parentId: "p" }, settings(), off)).toBe("conductor_child");
  expect(skipReason(entry(), ticket, settings(), () => true)).toBe("on_screen");
  expect(skipReason(entry(), ticket, settings(), off)).toBeNull();
});

test("a conductor's child still notifies when it moves to blocked", () => {
  const child = { ...ticket, parentId: "p" };
  expect(skipReason(entry({ kind: "blocked" }), child, settings(), () => false)).toBeNull();
  expect(skipReason(entry({ kind: "moved", meta: { to: "blocked" } }), child, settings(), () => false)).toBeNull();
  expect(skipReason(entry({ kind: "moved", meta: { to: "done" } }), child, settings(), () => false)).toBe("conductor_child");
});

test("pushPayload groups by ticket and clips long fields with an ellipsis", () => {
  const p = pushPayload({ kind: "note", author: "agent", meta: {}, body: "x".repeat(2000) }, { key: "T-1", title: "y".repeat(500) });
  expect(p.aps["thread-id"]).toBe("T-1");
  expect(p.aps.alert.body).toHaveLength(1000);
  expect(p.aps.alert.body.endsWith("…")).toBe(true);
  expect(p.aps.alert.title).toHaveLength(180);
});

const goodBody = { id: "dev-1", platform: "ios", apnsToken: ` ${"AB".repeat(20)} `, environment: "sandbox" };

test("validateDeviceBody lowercases the token, defaults name and topic, and trims the name", () => {
  const out = validateDeviceBody(goodBody);
  expect(out).toEqual({ id: "dev-1", platform: "ios", name: "iPhone", apnsToken: "ab".repeat(20), environment: "sandbox", topic: APNS_TOPIC });
  expect(validateDeviceBody({ ...goodBody, platform: "mac" }).name).toBe("Mac");
  expect(validateDeviceBody({ ...goodBody, name: `  ${"n".repeat(150)}  ` }).name).toHaveLength(100);
});

test("validateDeviceBody refuses a malformed body with a 400", () => {
  for (const patch of [{ id: "has space" }, { platform: "android" }, { apnsToken: "xyz" }, { apnsToken: "ab".repeat(15) }, { environment: "dev" }, { name: 3 }, { topic: "bad topic!" }]) {
    try {
      validateDeviceBody({ ...goodBody, ...patch });
      throw new Error(`accepted ${JSON.stringify(patch)}`);
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as HarnessError).status).toBe(400);
    }
  }
  expect(() => validateDeviceBody(null)).toThrow(HarnessError);
});

// ---- NotificationService end to end: store, bus, presence, a real ApnsClient over a fake transport ----

interface Post {
  path: string;
  body: string;
}

async function rig(opts: { settings?: NotificationSettings; answer?: (p: Post) => ApnsHttpResponse } = {}) {
  const clock = fakeClock(5_000_000);
  const store = makeStore({ now: clock });
  const bus = new EventBus();
  const presence = new PresenceRegistry();
  const keyDir = tempDir();
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  writeFileSync(join(keyDir, "AuthKey_ABCDE12345_APN_Sandbox.p8"), `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`);
  const posts: Post[] = [];
  const transport: ApnsTransport = {
    async post(_origin, path, _headers, body) {
      posts.push({ path, body });
      return opts.answer?.({ path, body }) ?? { status: 200, body: "", headers: {} };
    },
    close() {},
  };
  const logs: string[] = [];
  const service = new NotificationService({
    store,
    bus,
    presence,
    settings: () => opts.settings ?? settings({ apnsKeyDir: keyDir, apnsTeamId: "TEAM123456" }),
    apns: new ApnsClient({ transport, tokens: new ApnsTokens(undefined, clock), now: clock }),
    log: (m) => logs.push(m),
    now: clock,
  });
  service.start();
  const project = addProject(store);
  const t = addTicket(store, project);
  const note = (over: Partial<Parameters<typeof store.activity.add>[0]> = {}) =>
    store.activity.add({ sessionId: t.sessionId, ticketId: t.id, kind: "note", author: "agent", body: "Tests pass", ...over });
  return { service, store, bus, presence, posts, logs, clock, t, note, keyDir };
}

const register = (r: Awaited<ReturnType<typeof rig>>, id: string, token: string, environment: "sandbox" | "production" = "sandbox") =>
  r.service.registerDevice({ id, platform: "ios", apnsToken: token.repeat(64), environment });

test("an agent activity entry pushes once to each registered device with a key for its environment", async () => {
  const r = await rig();
  register(r, "d1", "a");
  register(r, "d2", "b");
  register(r, "d3", "c", "production"); // no production key in the dir
  r.service.onActivity(r.note());
  await r.service.idle();
  expect(r.posts.map((p) => p.path).sort()).toEqual([`/3/device/${"a".repeat(64)}`, `/3/device/${"b".repeat(64)}`]);
  expect(JSON.parse(r.posts[0]!.body).aps.alert.body).toBe("Tests pass");
  expect(r.logs.some((l) => l.includes("sent"))).toBe(true);
});

test("start subscribes to activity.added on the bus and stop unsubscribes", async () => {
  const r = await rig();
  register(r, "d1", "a");
  r.bus.emit({ kind: "activity.added", entry: r.note() });
  await r.service.idle();
  expect(r.posts).toHaveLength(1);
  r.service.stop();
  r.bus.emit({ kind: "activity.added", entry: r.note() });
  await r.service.idle();
  expect(r.posts).toHaveLength(1);
});

test("a visible client with the ticket on screen holds the push back; a hidden one doesn't", async () => {
  const r = await rig();
  register(r, "d1", "a");
  r.presence.set("s", { deviceId: "mac", platform: "mac", visible: true, tickets: [r.t.key] });
  r.service.onActivity(r.note());
  await r.service.idle();
  expect(r.posts).toHaveLength(0);
  expect(r.logs.some((l) => l.includes("skipped on_screen"))).toBe(true);
  r.presence.set("s", { deviceId: "mac", platform: "mac", visible: false, tickets: [r.t.key] });
  r.service.onActivity(r.note());
  await r.service.idle();
  expect(r.posts).toHaveLength(1);
});

test("a human's own entries never push", async () => {
  const r = await rig();
  register(r, "d1", "a");
  r.service.onActivity(r.note({ author: "human", kind: "message" }));
  await r.service.idle();
  expect(r.posts).toHaveLength(0);
});

test("a device APNs says is gone is deleted and clients are told once", async () => {
  const r = await rig({ answer: () => ({ status: 410, body: '{"reason":"Unregistered"}', headers: {} }) });
  register(r, "d1", "a");
  const changes: string[] = [];
  r.bus.onKind("devices.changed", () => changes.push("changed"));
  r.service.onActivity(r.note());
  await r.service.idle();
  expect(r.store.devices.list()).toEqual([]);
  expect(changes).toEqual(["changed"]);
});

test("a transient failure keeps the device", async () => {
  const r = await rig({ answer: () => ({ status: 429, body: '{"reason":"TooManyRequests"}', headers: {} }) });
  register(r, "d1", "a");
  r.service.onActivity(r.note());
  await r.service.idle();
  expect(r.store.devices.list()).toHaveLength(1);
  expect(r.logs.some((l) => l.includes("failed: 429 TooManyRequests"))).toBe(true);
});

test("status reports the key found, the last push result stamped by the injected clock, and presence", async () => {
  const r = await rig();
  register(r, "d1", "a");
  r.clock.set(9_000_000);
  r.service.onActivity(r.note());
  await r.service.idle();
  const sandbox = r.service.status().keys.find((k) => k.environment === "sandbox")!;
  expect(sandbox.keyId).toBe("ABCDE12345");
  expect(sandbox.lastResult).toEqual({ at: 9_000_000, ok: true, status: 200, reason: null });
  expect(r.service.status().keys.find((k) => k.environment === "production")!.keyId).toBeNull();
});

test("registering the same device again emits devices.changed only when something changed; removing an unknown one is a 404", async () => {
  const r = await rig();
  const changes: string[] = [];
  r.bus.onKind("devices.changed", () => changes.push("c"));
  register(r, "d1", "a");
  register(r, "d1", "a");
  expect(changes).toEqual(["c"]);
  r.service.registerDevice({ id: "d1", platform: "ios", apnsToken: "b".repeat(64), environment: "sandbox" });
  expect(changes).toEqual(["c", "c"]);
  expect(() => r.service.removeDevice("nope")).toThrow(/No device nope/);
  expect(r.service.removeDevice("d1")).toEqual({ ok: true });
  expect(changes).toHaveLength(3);
});

test("the public device list never carries the full token", async () => {
  const r = await rig();
  const d = register(r, "d1", "a");
  expect(JSON.stringify(d)).not.toContain("a".repeat(20));
  expect(d.tokenSuffix).toBe("a".repeat(8));
});

test("a reminder reaches every device with no ticket behind it, even when a ticket is on screen; the master switch silences it", async () => {
  const r = await rig();
  register(r, "d1", "a");
  r.presence.set("s", { deviceId: "mac", platform: "mac", visible: true, tickets: [r.t.key] });
  r.service.remind({ title: "Deploy SHOP-4", body: "Friday morning" });
  await r.service.idle();
  expect(r.posts).toHaveLength(1);
  const payload = JSON.parse(r.posts[0]!.body);
  expect(payload.aps.alert).toMatchObject({ title: "Reminder", subtitle: "Deploy SHOP-4", body: "Friday morning" });
  expect(payload.ticketKey).toBeUndefined();

  const off = await rig({ settings: settings({ enabled: false }) });
  register(off, "d1", "a");
  off.service.remind({ title: "x", body: "y" });
  await off.service.idle();
  expect(off.posts).toHaveLength(0);
});

test("sendTest reaches every device regardless of the master switch or presence", async () => {
  const r = await rig({ settings: undefined });
  register(r, "d1", "a");
  r.presence.set("s", { deviceId: "mac", platform: "mac", visible: true, tickets: [r.t.key] });
  const out = await r.service.sendTest();
  expect(out.sent).toBe(1);
  expect(JSON.parse(r.posts[0]!.body).aps.alert.subtitle).toBe("Test notification");
});
