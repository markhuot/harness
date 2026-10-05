// Message drafts (DESIGN.md "Message drafts"): the message the human is writing to a ticket's
// agent is saved on the ticket, so another device can finish it. An app's send uses it up; an
// agent's message_ticket doesn't. Uploads waiting in a draft survive the startup sweep.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessApiError, HarnessClient, type HarnessEvent, type Ticket } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { FakeDriver, makeOrchestrator, stubBrowser, tempHome } from "../testing/fakes";
import { png } from "../testing/media";

function setup() {
  const h = makeOrchestrator({ driver: new FakeDriver() });
  const dir = join(h.home, "proj", "web");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "WEB" });
  const upserts: Ticket[] = [];
  h.bus.on((e: HarnessEvent) => void (e.kind === "ticket.upserted" && upserts.push(e.ticket)));
  return { ...h, project, upserts };
}
type H = ReturnType<typeof setup>;

async function blocked(h: H) {
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which screenshot?" });
  await h.orch.idle();
  expect(h.store.tickets.get(t.id)!.status).toBe("blocked");
  return h.store.tickets.get(t.id)!;
}

describe("a message draft", () => {
  test("is saved on the ticket with its origin, and an upsert carries it", async () => {
    const h = setup();
    const t = await blocked(h);
    h.upserts.length = 0;
    const saved = h.orch.saveMessageDraft(t.key, { text: "Use the second one", origin: "phone-1" });
    expect(saved.messageDraft).toEqual({ text: "Use the second one", attachments: [], origin: "phone-1", updatedAt: expect.any(Number) });
    expect(h.store.tickets.get(t.id)!.messageDraft?.text).toBe("Use the second one");
    expect(h.upserts.map((u) => u.messageDraft?.text)).toEqual(["Use the second one"]);
    // Not a change to the ticket: its updatedAt (the board's recency) stays put.
    expect(saved.updatedAt).toBe(t.updatedAt);
  });

  test("a save that changes nothing emits nothing; the same text from another device does", async () => {
    const h = setup();
    const t = await blocked(h);
    h.orch.saveMessageDraft(t.key, { text: "Hi", origin: "a" });
    h.upserts.length = 0;
    h.orch.saveMessageDraft(t.key, { text: "Hi", origin: "a" });
    expect(h.upserts).toHaveLength(0);
    h.orch.saveMessageDraft(t.key, { text: "Hi", origin: "b" });
    expect(h.upserts.map((u) => u.messageDraft?.origin)).toEqual(["b"]);
  });

  test("empty text and no attachments clear it", async () => {
    const h = setup();
    const t = await blocked(h);
    h.orch.saveMessageDraft(t.key, { text: "Hi" });
    expect(h.orch.saveMessageDraft(t.key, { text: "", origin: "a" }).messageDraft).toBeNull();
    expect(h.store.tickets.get(t.id)!.messageDraft).toBeNull();
  });

  test("keeps its attachments with their notes; attachments alone are a draft", async () => {
    const h = setup();
    const t = await blocked(h);
    const up = h.orch.uploadAttachment(png(2, 2), "Pasted image.png", "image/png");
    const annotation = { width: 2, height: 2, marks: [{ n: 1, x: 1, y: 1, message: "this" }] };
    const saved = h.orch.saveMessageDraft(t.key, { text: "", attachments: [{ id: up.id, annotation }] });
    expect(saved.messageDraft?.attachments).toEqual([{ ...up, annotation }]);
  });

  test("bad input is a 400, and a draft ticket (no agent yet) is a 409", async () => {
    const h = setup();
    const t = await blocked(h);
    const status = (f: () => unknown) => {
      try {
        f();
        return 0;
      } catch (e) {
        return (e as { status?: number }).status;
      }
    };
    expect(status(() => h.orch.saveMessageDraft(t.key, { text: 3 as unknown as string }))).toBe(400);
    expect(status(() => h.orch.saveMessageDraft(t.key, { text: "x", origin: "o".repeat(201) }))).toBe(400);
    expect(status(() => h.orch.saveMessageDraft(t.key, { text: "x", attachments: [{ id: "nope" }] }))).toBe(400);
    const draft = await h.orch.createTicket({ projectId: h.project.id, spec: "later", draft: true });
    expect(status(() => h.orch.saveMessageDraft(draft.key, { text: "x" }))).toBe(409);
    expect(status(() => h.orch.saveMessageDraft("WEB-99", { text: "x" }))).toBe(404);
  });

  test("an app's send uses it up (one upsert clears it everywhere); an agent's message leaves it", async () => {
    const h = setup();
    const t = await blocked(h);
    h.orch.saveMessageDraft(t.key, { text: "half written", origin: "phone" });
    await h.orch.sendMessage(t.key, "From an agent");
    await h.orch.idle();
    expect(h.store.tickets.get(t.id)!.messageDraft?.text).toBe("half written");

    const back = await blocked(h);
    h.orch.saveMessageDraft(back.key, { text: "Use the second one", origin: "phone" });
    h.upserts.length = 0;
    const sent = await h.orch.sendMessage(back.key, "Use the second one", { fromApp: true });
    expect(sent.messageDraft).toBeNull();
    expect(h.store.tickets.get(back.id)!.messageDraft).toBeNull();
    expect(h.upserts.at(-1)!.messageDraft).toBeNull();
    await h.orch.idle();
  });

  test("a send that fails keeps the draft", async () => {
    const h = setup();
    const t = await blocked(h);
    h.orch.saveMessageDraft(t.key, { text: "keep me" });
    const err = await h.orch.sendMessage(t.key, "x", { fromApp: true, attachments: [{ id: "nope" }] }).catch((e) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(h.store.tickets.get(t.id)!.messageDraft?.text).toBe("keep me");
  });

  test("an upload waiting in a draft survives the startup sweep, and goes with its ticket", async () => {
    const h = setup();
    const t = await blocked(h);
    const waiting = h.orch.uploadAttachment(png(1, 1), "Pasted image.png", "image/png");
    h.orch.saveMessageDraft(t.key, { text: "", attachments: [{ id: waiting.id }] });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(dirname(waiting.path), old, old);
    h.orch.sweepUploads();
    expect(existsSync(waiting.path)).toBe(true);
    await h.orch.deleteTicket(t.key);
    expect(existsSync(waiting.path)).toBe(false);
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("PUT /tickets/:key/message-draft saves it, GET /tickets lists it, POST /messages clears it", async () => {
    const home = tempHome("harness-message-draft-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const t = await client.createTicket({ projectId: project.id, spec: "Plan it", start: false });

    const saved = await client.saveMessageDraft(t.key, { text: "Started on the phone", origin: "phone" });
    expect(saved.messageDraft?.text).toBe("Started on the phone");
    expect((await client.listTickets()).find((x) => x.id === t.id)?.messageDraft?.origin).toBe("phone");

    const bad = await client.saveMessageDraft(t.key, { text: "x", attachments: "nope" as never }).catch((e) => e);
    expect(bad).toBeInstanceOf(HarnessApiError);
    expect((bad as HarnessApiError).status).toBe(400);

    const sent = await client.sendMessage(t.key, "Finished on the Mac");
    expect(sent.messageDraft).toBeNull();
  });
});
