// Annotations sent with a message (DESIGN.md "Annotations"): the run that answers it reads the
// numbered notes before its <attachments> block, a running agent gets them steered in, a queued
// run keeps them, and the transcript keeps them next to the human's own words.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type MessageAnnotation, type Ticket } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { FakeDriver, makeOrchestrator, stubBrowser, tempHome } from "../testing/fakes";
import { png } from "../testing/media";

function setup(steering = false) {
  const driver = new FakeDriver();
  driver.supportsSteering = steering;
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "proj", "web");
  const files = join(h.home, "desktop");
  mkdirSync(dir, { recursive: true });
  mkdirSync(files, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "WEB" });
  const file = (name: string, data: Uint8Array | string = "x") => {
    const p = join(files, name);
    writeFileSync(p, data);
    return p;
  };
  const userEntries = (t: Ticket) => h.store.transcript.list(t.sessionId).filter((e) => e.role === "user");
  return { ...h, project, file, userEntries };
}
type H = ReturnType<typeof setup>;

async function blocked(h: H) {
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which screenshot?" });
  await h.orch.idle();
  expect(h.store.tickets.get(t.id)!.status).toBe("blocked");
  return t;
}

async function untilHolding(h: H) {
  const start = Date.now();
  while (h.driver.holding === 0) {
    if (Date.now() - start > 2000) throw new Error("the run never reached /hold");
    await Bun.sleep(1);
  }
}

const note = (attachment: number): MessageAnnotation => ({
  attachment,
  source: { kind: "attachment", id: "att_1", name: "mockup.png" },
  width: 40,
  height: 20,
  marks: [{ n: 1, x: 10, y: 5, tailX: 30, tailY: 15, message: "Bigger" }],
});
const LINE = "1. (10, 5) px, 25% across, 25% down, arrow from (30, 15) px: Bigger";

describe("a message's annotations", () => {
  test("go in the answering run's prompt before <attachments>; the transcript keeps them and the human's words", async () => {
    const h = setup();
    const t = await blocked(h);
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    // The annotation names the second file sent.
    await h.orch.sendMessage(t.key, "Fix these", { attachments: [{ path: notes }, { path: shot }], annotations: [note(1)] });
    await h.orch.idle();

    const chat = h.driver.calls.at(-1)!;
    expect(chat.kind).toBe("chat");
    expect(chat.prompt.startsWith("Fix these")).toBe(true);
    const ann = chat.prompt.indexOf("<annotations>");
    const att = chat.prompt.indexOf("<attachments>");
    expect(ann).toBeGreaterThan(0);
    expect(att).toBeGreaterThan(ann);
    expect(chat.prompt.slice(ann, att)).toContain(`${shot} (40×20 px) is the spec image "mockup.png"`);
    expect(chat.prompt).toContain(LINE);

    const entry = h.userEntries(t).at(-1)!.content;
    expect(entry).toMatchObject({ type: "text", text: "Fix these", annotations: [note(1)] });
    expect(h.store.runs.listBySession(t.sessionId).at(-1)!.annotations).toEqual([note(1)]);
  });

  test("an index into attachments sent with a repeated file still lands on that image", async () => {
    const h = setup();
    const t = await blocked(h);
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    // notes.md twice: the normalized list is [notes, shot], so index 2 as sent is index 1.
    await h.orch.sendMessage(t.key, "See", { attachments: [{ path: notes }, { path: notes }, { path: shot }], annotations: [note(2)] });
    await h.orch.idle();
    expect(h.store.runs.listBySession(t.sessionId).at(-1)!.annotations).toEqual([note(1)]);
    expect(h.driver.calls.at(-1)!.prompt).toContain(`${shot} (40×20 px)`);
  });

  test("a later run doesn't get them again", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "Look", { attachments: [{ path: h.file("shot.png", png(40, 20)) }], annotations: [note(0)] });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "And now?");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.prompt).not.toContain("<annotations>");
  });

  test("without the attachments they annotate, or on a file that isn't an image, they're refused", async () => {
    const h = setup();
    const t = await blocked(h);
    await expect(h.orch.sendMessage(t.key, "x", { annotations: [note(0)] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: h.file("a.md") }], annotations: [note(0)] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: h.file("b.png", png(40, 20)) }], annotations: [note(1)] })).rejects.toMatchObject({ status: 400 });
    expect(h.store.runs.listBySession(t.sessionId).map((r) => r.kind)).toEqual(["work"]);
  });

  test("are refused while a tool approval waits", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: 'go /tool Bash {"command":"npm install"}' });
    await h.orch.idle();
    await expect(h.orch.sendMessage(t.key, "Here", { attachments: [{ path: h.file("a.png", png(40, 20)) }], annotations: [note(0)] })).rejects.toMatchObject({ status: 409 });
    expect(h.store.tickets.get(t.id)!.pendingApproval).not.toBeNull();
  });

  test("re-opening a done ticket with a message sends them with its work run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it" });
    await h.orch.idle();
    await h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "It broke /nosubmit", { move: true, attachments: [{ path: h.file("bug.png", png(40, 20)) }], annotations: [note(0)] });
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).toContain(LINE);
  });

  test("sending a review ticket back to work with a message sends them with its work run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it" });
    await h.orch.idle();
    expect(h.store.tickets.get(t.id)!.status).toBe("review");
    await h.orch.sendMessage(t.key, "Not yet /nosubmit", { move: true, attachments: [{ path: h.file("bug.png", png(40, 20)) }], annotations: [note(0)] });
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).toContain(LINE);
  });
});

describe("steering", () => {
  test("a running agent gets them in the steered message; the transcript keeps the human's text", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /nosubmit" });
    await untilHolding(h);
    const shot = h.file("shot.png", png(40, 20));
    await h.orch.sendMessage(t.key, "Match this", { attachments: [{ path: shot }], annotations: [note(0)] });
    h.driver.release();
    await h.orch.idle();

    const [m] = h.driver.steeredMessages;
    expect(m!.text.startsWith("Match this")).toBe(true);
    expect(m!.text.indexOf("<annotations>")).toBeLessThan(m!.text.indexOf("<attachments>"));
    expect(m!.text).toContain(LINE);
    const entry = h.userEntries(t).find((e) => e.content.type === "text" && e.content.text === "Match this");
    expect(entry?.content).toMatchObject({ annotations: [note(0)] });
  });

  test("a message the run never took in is queued with them", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /deaf /nosubmit" });
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "Match this /nosubmit", { attachments: [{ path: h.file("shot.png", png(40, 20)) }], annotations: [note(0)] });
    h.driver.release();
    await h.orch.idle();

    expect(h.driver.calls[1]!.prompt).toContain(LINE);
    expect(h.store.runs.listBySession(t.sessionId)[1]!.annotations).toEqual([note(0)]);
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("POST /messages takes annotations; GET /browser/:sessionId/screenshot answers the PNG and its sizes", async () => {
    const home = tempHome("harness-message-ann-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const t = await client.createTicket({ projectId: project.id, spec: "Plan it", start: false });

    // No tab yet: nothing to screenshot.
    const none = await client.browserScreenshot(t.sessionId).catch((e) => e);
    expect((none as HarnessApiError).status).toBe(404);
    await client.browserNavigate(t.sessionId, "http://localhost:3000/login");
    const shot = await client.browserScreenshot(t.sessionId);
    expect([shot.width, shot.height, shot.viewport, shot.scale, shot.tabId, shot.url]).toEqual([2560, 1600, { width: 1280, height: 800 }, 2, 1, "http://localhost:3000/login"]);
    expect(Buffer.from(shot.data, "base64").equals(png(2560, 1600))).toBe(true);
    expect(((await client.browserScreenshot(t.sessionId, 7).catch((e) => e)) as HarnessApiError).status).toBe(404);

    const up = await client.uploadPromptAttachment(new Blob([Buffer.from(shot.data, "base64")], { type: "image/png" }), "Browser.png", "image/png");
    const annotation: MessageAnnotation = {
      attachment: 0,
      source: { kind: "browser", url: shot.url, title: shot.title, tabId: shot.tabId, viewport: shot.viewport, scale: shot.scale },
      width: shot.width,
      height: shot.height,
      marks: [{ n: 1, x: 2000, y: 100, message: "Log in button" }],
    };
    await client.sendMessage(t.key, "Click this", { attachments: [{ path: up.path }], annotations: [annotation] });
    const entry = (await client.transcript(t.sessionId)).find((e) => e.role === "user" && e.content.type === "text" && !!e.content.annotations);
    expect(entry?.content).toMatchObject({ type: "text", text: "Click this", annotations: [annotation] });

    const bad = await client.sendMessage(t.key, "x", { attachments: [{ path: up.path }], annotations: [{ ...annotation, marks: [{ n: 1, x: 3000, y: 1, message: "" }] }] }).catch((e) => e);
    expect((bad as HarnessApiError).status).toBe(400);
  });
});
