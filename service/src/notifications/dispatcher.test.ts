import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY_KINDS, type ActivityEntry, type ActivityKind, type ActivityMeta, type HarnessEvent, type NotificationSettings } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";
import { fakeContext, fakeSession } from "../tools/fakes";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@harness/shared";
import type { ApnsKeyFile, ApnsResult, ApnsSend } from "./apns";
import { NotificationService, isMoveToBlocked, pushPayload, skipReason } from "./dispatcher";
import { PresenceRegistry } from "./presence";

const SANDBOX_TOKEN = "a".repeat(64);
const PROD_TOKEN = "b".repeat(64);

class FakeApns {
  sent: { key: ApnsKeyFile; teamId: string; n: ApnsSend }[] = [];
  answer: (n: ApnsSend) => ApnsResult = () => ({ ok: true, status: 200, reason: null });
  async send(key: ApnsKeyFile, teamId: string, n: ApnsSend) {
    this.sent.push({ key, teamId, n });
    return this.answer(n);
  }
  close() {}
}

function setup(opts: { keys?: ("sandbox" | "production")[]; settings?: Partial<NotificationSettings> } = {}) {
  const h = makeOrchestrator();
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "SPEC" });
  const keyDir = join(h.home, "keys");
  mkdirSync(keyDir, { recursive: true });
  for (const env of opts.keys ?? ["sandbox", "production"]) {
    const id = env === "sandbox" ? "FBUNLH99K7" : "D2RG5FFJC5";
    writeFileSync(join(keyDir, `AuthKey_${id}_APN_${env === "sandbox" ? "Sandbox" : "Production"}.p8`), "unused by the fake");
  }
  const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, apnsKeyDir: keyDir, ...opts.settings };
  const presence = new PresenceRegistry();
  const apns = new FakeApns();
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  const svc = new NotificationService({ store: h.store, bus: h.bus, settings: () => settings, presence, apns });
  svc.start();
  svc.registerDevice({ id: "mac-1", platform: "mac", name: "Mark's Mac", apnsToken: PROD_TOKEN, environment: "production" });
  svc.registerDevice({ id: "ios-1", platform: "ios", name: "Mark's iPhone", apnsToken: SANDBOX_TOKEN, environment: "sandbox" });
  apns.sent = [];
  /** A ticket that isn't started, so only the entries a test writes notify. */
  const ticket = async (title: string, parentId?: string) => {
    const t = await h.orch.createTicket({ projectId: project.id, spec: title, title, start: false });
    if (parentId) h.store.db.query("UPDATE tickets SET parent_id = $p WHERE id = $id").run({ p: parentId, id: t.id });
    await h.orch.idle();
    await svc.idle();
    apns.sent = [];
    return h.store.tickets.get(t.id)!;
  };
  /** Write an activity entry the way the orchestrator does. */
  const write = async (t: { id: string; sessionId: string }, kind: ActivityKind, author: ActivityEntry["author"], body = "Body", meta: ActivityMeta = {}) => {
    const entry = h.store.activity.add({ sessionId: t.sessionId, ticketId: t.id, kind, author, body, meta });
    h.bus.emit({ kind: "activity.added", entry });
    await svc.idle();
    return entry;
  };
  return { ...h, project, settings, presence, apns, svc, events, ticket, write, keyDir };
}

describe("skipReason", () => {
  const ticket = { key: "SPEC-1", parentId: null };
  const on = DEFAULT_NOTIFICATION_SETTINGS;
  const nobody = () => false;

  test("every activity kind notifies by default, from an agent or the system", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(skipReason({ kind, author: "agent", meta: {} }, ticket, on, nobody)).toBeNull();
      expect(skipReason({ kind, author: "system", meta: {} }, ticket, on, nobody)).toBeNull();
    }
  });

  test("a human's entry never notifies, whatever else is true", () => {
    for (const kind of ACTIVITY_KINDS) expect(skipReason({ kind, author: "human", meta: {} }, ticket, on, nobody)).toBe("human");
  });

  test("the master switch and the category switches", () => {
    expect(skipReason({ kind: "note", author: "agent", meta: {} }, ticket, { ...on, enabled: false }, nobody)).toBe("disabled");
    const notesOff = { ...on, categories: { ...on.categories, notes: false } };
    expect(skipReason({ kind: "note", author: "agent", meta: {} }, ticket, notesOff, nobody)).toBe("category");
    expect(skipReason({ kind: "spec_revised", author: "agent", meta: {} }, ticket, notesOff, nobody)).toBeNull();
  });

  test("a conductor's child notifies only on a move to blocked, and the category switch still applies to it", () => {
    const child = { key: "SPEC-2", parentId: "tkt_parent" };
    expect(skipReason({ kind: "note", author: "agent", meta: {} }, child, on, nobody)).toBe("conductor_child");
    expect(skipReason({ kind: "spec_revised", author: "agent", meta: {} }, child, on, nobody)).toBe("conductor_child");
    expect(skipReason({ kind: "submitted", author: "agent", meta: { from: "in_progress", to: "review" } }, child, on, nobody)).toBe("conductor_child");
    expect(skipReason({ kind: "moved", author: "system", meta: { from: "review", to: "done" } }, child, on, nobody)).toBe("conductor_child");
    expect(skipReason({ kind: "blocked", author: "agent", meta: { question: "?" } }, child, on, nobody)).toBeNull();
    expect(skipReason({ kind: "moved", author: "agent", meta: { from: "in_progress", to: "blocked" } }, child, on, nobody)).toBeNull();
    const statusOff = { ...on, categories: { ...on.categories, status: false } };
    expect(skipReason({ kind: "blocked", author: "agent", meta: {} }, child, statusOff, nobody)).toBe("category");
  });

  test("an entry with no ticket (a triage session) doesn't notify", () => {
    expect(skipReason({ kind: "note", author: "agent", meta: {} }, null, on, nobody)).toBe("no_ticket");
  });

  test("isMoveToBlocked", () => {
    expect(isMoveToBlocked({ kind: "blocked", meta: {} })).toBe(true);
    expect(isMoveToBlocked({ kind: "moved", meta: { to: "blocked" } })).toBe(true);
    expect(isMoveToBlocked({ kind: "moved", meta: { to: "review" } })).toBe(false);
    expect(isMoveToBlocked({ kind: "changes_requested", meta: { to: "blocked" } })).toBe(false);
  });
});

describe("pushPayload", () => {
  test("groups by ticket and carries the key for the deep link", () => {
    const p = pushPayload({ kind: "submitted", author: "agent", body: "Ready", meta: {} }, { key: "SPEC-9", title: "Login" });
    expect(p).toEqual({
      aps: { alert: { title: "SPEC-9 · Login", subtitle: "Agent · Submitted for review", body: "Ready" }, "thread-id": "SPEC-9", sound: "default" },
      ticketKey: "SPEC-9",
    });
  });

  test("clips a long body so the payload stays under APNs' 4 KB", () => {
    const p = pushPayload({ kind: "note", author: "agent", body: "x".repeat(5000), meta: {} }, { key: "SPEC-9", title: "t".repeat(500) });
    expect(p.aps.alert.body.length).toBe(1000);
    expect(p.aps.alert.body.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(4096);
  });
});

describe("NotificationService", () => {
  test("one request per registered device, each with its topic and its environment's key", async () => {
    const h = setup();
    const t = await h.ticket("Login");
    await h.write(t, "note", "agent", "Tests pass");
    expect(h.apns.sent.map((s) => [s.n.deviceToken, s.n.environment, s.key.keyId, s.n.topic, s.teamId]).sort()).toEqual([
      [SANDBOX_TOKEN, "sandbox", "FBUNLH99K7", "com.markhuot.harness", "47P4ZSALX4"],
      [PROD_TOKEN, "production", "D2RG5FFJC5", "com.markhuot.harness", "47P4ZSALX4"],
    ]);
    expect(h.apns.sent[0]!.n.payload).toMatchObject({ aps: { "thread-id": t.key }, ticketKey: t.key });
  });

  test("a missing key skips that environment's devices and reports the key as missing", async () => {
    const h = setup({ keys: ["production"] });
    const t = await h.ticket("Login");
    await h.write(t, "note", "agent");
    expect(h.apns.sent.map((s) => s.n.environment)).toEqual(["production"]);
    const status = h.svc.status();
    expect(status.keys.find((k) => k.environment === "sandbox")).toMatchObject({ keyId: null, path: null, lastResult: null });
    expect(status.keys.find((k) => k.environment === "production")).toMatchObject({ keyId: "D2RG5FFJC5", lastResult: { ok: true, status: 200 } });
  });

  test("human-authored entries never notify, even with nothing on screen", async () => {
    const h = setup();
    const t = await h.ticket("Login");
    await h.write(t, "approved", "human", "Approved");
    await h.write(t, "changes_requested", "human", "Fix it");
    await h.write(t, "moved", "human", "", { from: "planning", to: "in_progress" });
    expect(h.apns.sent).toEqual([]);
  });

  describe("who started the work", () => {
    /** Tickets a "Moved to In progress" push went out for; the started run's own entries notify as usual. */
    const pushedKeys = (h: ReturnType<typeof setup>) =>
      h.apns.sent
        .map((s) => s.n.payload as { aps: { alert: { subtitle: string } }; ticketKey: string })
        .filter((p) => p.aps.alert.subtitle.endsWith("Moved to In progress"))
        .map((p) => p.ticketKey);
    const settle = async (h: ReturnType<typeof setup>) => {
      await h.orch.idle();
      await h.svc.idle();
    };
    /** A work run on another ticket in the project, the way an agent's board tools see it. */
    const agentCtx = async (h: ReturnType<typeof setup>) => {
      const own = await h.ticket("Agent's own ticket");
      return fakeContext({ runKind: "work", ticket: own, session: fakeSession({ id: own.sessionId, key: own.key, ticketId: own.id }), ops: h.orch.ops });
    };

    test("a human creating a ticket that starts right away gets no push for it (the UI hasn't shown it yet)", async () => {
      const h = setup();
      const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Login", title: "Login" });
      await settle(h);
      expect(h.store.activity.listBySession(t.sessionId).find((e) => e.kind === "moved")).toMatchObject({ author: "human", body: "Work started" });
      expect(pushedKeys(h)).not.toContain(t.key);
    });

    test("a human submitting a draft, pressing Start, or dragging to in progress gets no push", async () => {
      const h = setup();
      const draft = await h.orch.createTicket({ projectId: h.project.id, spec: "Draft", draft: true });
      await h.orch.submitTicket(draft.key, { start: true });
      const planned = await h.ticket("Planned");
      await h.orch.startTicket(planned.key);
      const dragged = await h.ticket("Dragged");
      await h.orch.updateTicket(dragged.key, { status: "in_progress" });
      await settle(h);
      expect(pushedKeys(h)).not.toContainAnyValues([draft.key, planned.key, dragged.key]);
    });

    test("an agent starting or moving another ticket still notifies, as the agent", async () => {
      const h = setup();
      const ctx = await agentCtx(h);
      const started = await h.ticket("Started by an agent");
      const moved = await h.ticket("Moved by an agent");
      await h.orch.ops.startTicket(ctx, started.key);
      await h.orch.ops.moveTicket(ctx, moved.key, "in_progress");
      await settle(h);
      for (const t of [started, moved]) {
        expect(h.store.activity.listBySession(t.sessionId).find((e) => e.kind === "moved")).toMatchObject({ author: "agent" });
      }
      expect(pushedKeys(h)).toContainValues([started.key, moved.key]);
    });

    test("an agent creating a ticket that starts right away notifies", async () => {
      const h = setup();
      const ctx = await agentCtx(h);
      const t = await h.orch.ops.createTicket(ctx, { title: "Spun off", spec: "Spun off", start: true });
      await settle(h);
      expect(pushedKeys(h)).toContain(t.key);
    });

    test("the scheduler starting a ticket once its dependency is done notifies", async () => {
      const h = setup();
      const dep = await h.ticket("Dependency");
      const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Waits", title: "Waits", dependsOn: [dep.key] });
      await settle(h);
      expect(pushedKeys(h)).not.toContain(t.key);
      await h.orch.updateTicket(dep.key, { status: "done" });
      await settle(h);
      expect(h.store.activity.listBySession(t.sessionId).find((e) => e.kind === "moved")).toMatchObject({ author: "system", body: "Work started" });
      expect(pushedKeys(h)).toContain(t.key);
    });
  });

  test("turning off the master switch or a category stops matching entries", async () => {
    const h = setup();
    const t = await h.ticket("Login");
    h.settings.categories = { ...h.settings.categories, spec: false };
    await h.write(t, "spec_revised", "agent", "Plan");
    expect(h.apns.sent).toEqual([]);
    await h.write(t, "note", "agent");
    expect(h.apns.sent.length).toBe(2);
    h.settings.enabled = false;
    await h.write(t, "note", "agent");
    expect(h.apns.sent.length).toBe(2);
  });

  test("a conductor's child is quiet except for a move to blocked; the conductor's own entries notify", async () => {
    const h = setup();
    const conductor = await h.ticket("Conductor");
    const child = await h.ticket("Child", conductor.id);
    await h.write(child, "note", "agent");
    await h.write(child, "spec_revised", "agent");
    await h.write(child, "submitted", "agent", "Done", { from: "in_progress", to: "review" });
    await h.write(child, "moved", "system", "", { from: "review", to: "done" });
    expect(h.apns.sent).toEqual([]);
    await h.write(child, "blocked", "agent", "Which API?", { question: "Which API?", from: "in_progress", to: "blocked" });
    expect(h.apns.sent.map((s) => s.n.payload)).toContainEqual(expect.objectContaining({ ticketKey: child.key }));
    h.apns.sent = [];
    await h.write(conductor, "note", "agent");
    expect(h.apns.sent.length).toBe(2);
  });

  describe("presence", () => {
    test("a visible client showing the ticket suppresses it; a hidden one or another ticket doesn't", async () => {
      const h = setup();
      const t = await h.ticket("Login");
      h.presence.set("sock-1", { deviceId: "mac-1", platform: "mac", visible: false, tickets: [t.key] });
      await h.write(t, "note", "agent");
      expect(h.apns.sent.length).toBe(2);
      h.apns.sent = [];
      h.presence.set("sock-2", { deviceId: "ios-1", platform: "ios", visible: true, tickets: ["SPEC-999"] });
      await h.write(t, "note", "agent");
      expect(h.apns.sent.length).toBe(2);
      h.apns.sent = [];
      h.presence.set("sock-2", { deviceId: "ios-1", platform: "ios", visible: true, tickets: ["SPEC-999", t.key] });
      await h.write(t, "note", "agent");
      expect(h.apns.sent).toEqual([]);
    });

    test("presence clears when the socket closes", async () => {
      const h = setup();
      const t = await h.ticket("Login");
      h.presence.set("sock-1", { deviceId: "ios-1", platform: "ios", visible: true, tickets: [t.key] });
      await h.write(t, "note", "agent");
      expect(h.apns.sent).toEqual([]);
      h.presence.drop("sock-1");
      await h.write(t, "note", "agent");
      expect(h.apns.sent.length).toBe(2);
    });

    // The three scenarios from the ticket's Goal.
    test("approving on iOS: the Mac shows nothing (the human wrote it)", async () => {
      const h = setup();
      const t = await h.ticket("Login");
      h.presence.set("ios", { deviceId: "ios-1", platform: "ios", visible: true, tickets: [t.key] });
      h.presence.set("mac", { deviceId: "mac-1", platform: "mac", visible: false, tickets: [] });
      await h.write(t, "approved", "human", "Approved");
      expect(h.apns.sent).toEqual([]);
    });

    test("Mac hidden, the board open on iOS, an agent blocks a ticket: nothing anywhere", async () => {
      const h = setup();
      const t = await h.ticket("Login");
      const other = await h.ticket("Other");
      h.presence.set("mac", { deviceId: "mac-1", platform: "mac", visible: false, tickets: [t.key, other.key] });
      h.presence.set("ios", { deviceId: "ios-1", platform: "ios", visible: true, tickets: [t.key, other.key] });
      await h.write(t, "blocked", "agent", "Which API?", { question: "Which API?", from: "in_progress", to: "blocked" });
      expect(h.apns.sent).toEqual([]);
    });

    test("Mac hidden, iOS showing SPEC-890, an agent finishes planning SPEC-123: a notification", async () => {
      const h = setup();
      const planned = await h.ticket("Planned");
      const shown = await h.ticket("Shown");
      h.presence.set("mac", { deviceId: "mac-1", platform: "mac", visible: false, tickets: [planned.key, shown.key] });
      h.presence.set("ios", { deviceId: "ios-1", platform: "ios", visible: true, tickets: [shown.key] });
      await h.write(planned, "spec_revised", "agent", "Plan drafted");
      expect(h.apns.sent.length).toBe(2);
      expect(h.apns.sent[0]!.n.payload).toMatchObject({ ticketKey: planned.key });
    });
  });

  test("a 410 or BadDeviceToken removes that device; other failures keep it", async () => {
    const h = setup();
    const t = await h.ticket("Login");
    h.apns.answer = (n) =>
      n.deviceToken === SANDBOX_TOKEN ? { ok: false, status: 410, reason: "Unregistered" } : { ok: false, status: 500, reason: "InternalServerError" };
    await h.write(t, "note", "agent");
    expect(h.store.devices.list().map((d) => d.id)).toEqual(["mac-1"]);
    expect(h.events.filter((e) => e.kind === "devices.changed").length).toBeGreaterThan(0);
    h.apns.answer = () => ({ ok: false, status: 400, reason: "BadDeviceToken" });
    await h.write(t, "note", "agent");
    expect(h.store.devices.list()).toEqual([]);
  });

  test("the test notification goes to every device, ignoring the switches", async () => {
    const h = setup({ settings: { enabled: false } });
    const result = await h.svc.sendTest();
    expect(result.sent).toBe(2);
    expect(h.apns.sent.length).toBe(2);
  });

  describe("devices", () => {
    test("registering again updates in place; the same token under a new id replaces the old row", () => {
      const h = setup();
      h.svc.registerDevice({ id: "ios-1", platform: "ios", name: "Renamed", apnsToken: SANDBOX_TOKEN.toUpperCase(), environment: "sandbox" });
      expect(h.svc.devices().find((d) => d.id === "ios-1")).toMatchObject({ name: "Renamed", tokenSuffix: "aaaaaaaa" });
      h.svc.registerDevice({ id: "ios-reinstalled", platform: "ios", name: "iPhone", apnsToken: SANDBOX_TOKEN, environment: "sandbox" });
      expect(h.svc.devices().map((d) => d.id).sort()).toEqual(["ios-reinstalled", "mac-1"]);
      expect(JSON.stringify(h.svc.status())).not.toContain(SANDBOX_TOKEN);
    });

    test("bad bodies are refused", () => {
      const h = setup();
      expect(() => h.svc.registerDevice({ id: "x", platform: "android", apnsToken: PROD_TOKEN, environment: "production" })).toThrow("platform");
      expect(() => h.svc.registerDevice({ id: "x", platform: "ios", apnsToken: "not hex", environment: "production" })).toThrow("apnsToken");
      expect(() => h.svc.registerDevice({ id: "x", platform: "ios", apnsToken: PROD_TOKEN, environment: "dev" })).toThrow("environment");
      expect(() => h.svc.registerDevice({ id: "x y", platform: "ios", apnsToken: PROD_TOKEN, environment: "sandbox" })).toThrow("id");
      expect(() => h.svc.removeDevice("nope")).toThrow("No device");
    });
  });
});
