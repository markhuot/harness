// PATCH /projects/:id { key }: validation, collisions, and the live rename of native tickets.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient, type HarnessEvent } from "@harness/shared";
import { onTempCleanup } from "@harness/shared/testing";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { stubBrowser, tempHome } from "../testing/fakes";

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot() {
  const home = tempHome("harness-rekey-");
  harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  await client.updateSettings({ defaultDriver: "dummy" });
  const dir = join(home, "work", "hello-harness");
  const other = join(home, "work", "other");
  mkdirSync(dir, { recursive: true });
  mkdirSync(other, { recursive: true });
  const events: HarnessEvent[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));
  const socket = client.connect({ onEvent: (e) => events.push(e), onStatus: (up) => up && connected() });
  onTempCleanup(() => socket.close());
  await ready;
  return { h: harness, client, dir, other, events, socket };
}

async function until(fn: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("project key", () => {
  test("rename rewrites native tickets, deps and sessions, leaves external keys, emits events", async () => {
    const { h, client, dir, other, events, socket } = await boot();
    try {
      const p = await client.createProject({ path: dir });
      expect(p.key).toBe("HELLOHARNESS");
      const t1 = await client.createTicket({ projectId: p.id, prompt: "one", start: false });
      const t2 = await client.createTicket({ projectId: p.id, prompt: "two", start: false, dependsOn: [t1.key] });
      const t3 = await client.createTicket({ projectId: p.id, prompt: "three", start: false });
      const mirror = await client.createTicket({
        projectId: p.id,
        prompt: "from jira",
        start: false,
        key: "FOO-123",
        externalRef: { source: "jira", key: "FOO-123", url: null, raw: {} },
      });
      const q = await client.createProject({ path: other });
      const cross = await client.createTicket({ projectId: q.id, prompt: "needs three", start: false, dependsOn: [t3.key, "FOO-123"] });
      await h.orchestrator.idle();
      expect([t1.key, t2.key, t3.key]).toEqual(["HELLOHARNESS-1", "HELLOHARNESS-2", "HELLOHARNESS-3"]);

      events.length = 0;
      const renamed = await client.updateProject(p.id, { key: "hel" });
      expect(renamed.key).toBe("HEL");
      expect(renamed.nextSeq).toBe(4);

      const tickets = await client.listTickets();
      const byId = (id: string) => tickets.find((t) => t.id === id)!;
      expect(byId(t1.id).key).toBe("HEL-1");
      expect(byId(t2.id).key).toBe("HEL-2");
      expect(byId(t2.id).dependsOn).toEqual(["HEL-1"]);
      expect(byId(t3.id).key).toBe("HEL-3");
      expect(byId(mirror.id).key).toBe("FOO-123");
      expect(byId(cross.id).dependsOn).toEqual(["HEL-3", "FOO-123"]);
      expect((await client.getSession(t1.sessionId)).key).toBe("HEL-1");
      expect((await client.getTicket("HEL-3")).dependents).toEqual([cross.key]);
      // Old keys (bookmarks, agents that learned them earlier) still resolve, to the current key.
      const viaOld = await client.getTicket("HELLOHARNESS-1");
      expect([viaOld.ticket.id, viaOld.ticket.key, viaOld.resolvedFrom]).toEqual([t1.id, "HEL-1", "HELLOHARNESS-1"]);
      expect((await client.getTicket("HEL-1")).resolvedFrom).toBeUndefined();
      await expect(client.getTicket("HELLOHARNESS-9")).rejects.toMatchObject({ status: 404 });
      // Worktree branch names aren't touched by a rename (none were created for planning tickets).
      expect(byId(t1.id).branch).toBeNull();

      await until(() => events.filter((e) => e.kind === "ticket.upserted").length >= 4);
      const ticketEvents = events.flatMap((e) => (e.kind === "ticket.upserted" ? [e.ticket] : []));
      expect(new Set(ticketEvents.map((t) => t.key))).toEqual(new Set(["HEL-1", "HEL-2", "HEL-3", cross.key]));
      expect(ticketEvents.find((t) => t.id === cross.id)!.dependsOn).toEqual(["HEL-3", "FOO-123"]);
      expect(ticketEvents.some((t) => t.id === mirror.id)).toBe(false);
      const sessionKeys = events.flatMap((e) => (e.kind === "session.upserted" ? [e.session.key] : []));
      for (const k of ["HEL-1", "HEL-2", "HEL-3"]) expect(sessionKeys).toContain(k);
      const projectEvent = events.find((e) => e.kind === "project.upserted");
      expect(projectEvent && projectEvent.kind === "project.upserted" && projectEvent.project.key).toBe("HEL");

      // The transcript records the rename.
      const transcript = await client.transcript(t1.sessionId);
      expect(transcript.some((e) => e.content.type === "status" && e.content.text === "Renamed HELLOHARNESS-1 → HEL-1")).toBe(true);

      // New tickets continue the sequence under the new key.
      const t4 = await client.createTicket({ projectId: p.id, prompt: "four", start: false });
      expect(t4.key).toBe("HEL-4");
      await h.orchestrator.idle();
    } finally {
      socket.close();
    }
  });

  test("invalid keys are 400, keys in use are 409, and a failed rename changes nothing", async () => {
    const { h, client, dir, other, socket } = await boot();
    try {
      const p = await client.createProject({ path: dir, key: "HH" });
      const t1 = await client.createTicket({ projectId: p.id, prompt: "one", start: false });
      await client.createTicket({ projectId: p.id, prompt: "two", start: false });
      const q = await client.createProject({ path: other });

      for (const bad of ["", "1ABC", "MY-APP", "A".repeat(17), "triage"]) {
        await expect(client.updateProject(p.id, { key: bad })).rejects.toMatchObject({ status: 400 });
      }
      await expect(client.updateProject(p.id, { key: "other" })).rejects.toMatchObject({ status: 409 });
      // A mirrored ticket already holds X-2, which HH-2 would become.
      await client.createTicket({ projectId: q.id, prompt: "ext", start: false, key: "X-2", externalRef: { source: "jira", key: "X-2", url: null, raw: {} } });
      const err = await client.updateProject(p.id, { key: "X", name: "Renamed" }).catch((e) => e);
      expect(err.status).toBe(409);
      expect(err.message).toContain("X-2");
      const after = (await client.listProjects()).find((x) => x.id === p.id)!;
      expect(after.key).toBe("HH");
      expect(after.name).toBe("hello-harness"); // the whole patch is refused, not just the key
      expect((await client.getTicket("HH-1")).ticket.id).toBe(t1.id);

      // Same key (any case) is accepted as a no-op alongside other fields.
      const same = await client.updateProject(p.id, { key: "hh", name: "Hello" });
      expect([same.key, same.name]).toEqual(["HH", "Hello"]);
      await expect(client.updateProject(p.id, { name: "  " })).rejects.toMatchObject({ status: 400 });
      await h.orchestrator.idle();
    } finally {
      socket.close();
    }
  });

  test("create validates an explicit key and refuses one already in use", async () => {
    const { client, dir, other, socket } = await boot();
    try {
      await expect(client.createProject({ path: dir, key: "my-app" })).rejects.toMatchObject({ status: 400 });
      await expect(client.createProject({ path: dir, key: "9LIVES" })).rejects.toMatchObject({ status: 400 });
      const p = await client.createProject({ path: dir, key: "hel" });
      expect(p.key).toBe("HEL");
      await expect(client.createProject({ path: other, key: "HEL" })).rejects.toMatchObject({ status: 409 });
      // Derived keys still de-duplicate instead of failing.
      const again = await client.createProject({ path: dir });
      const twice = await client.createProject({ path: dir });
      expect([again.key, twice.key]).toEqual(["HELLOHARNESS", "HELLOHARNESS2"]);
    } finally {
      socket.close();
    }
  });

  test("path can change to another existing directory, and must exist", async () => {
    const { client, dir, other, socket } = await boot();
    try {
      const p = await client.createProject({ path: dir });
      expect((await client.updateProject(p.id, { path: other })).path).toBe(other);
      await expect(client.updateProject(p.id, { path: join(other, "missing") })).rejects.toMatchObject({ status: 400 });
    } finally {
      socket.close();
    }
  });
});
