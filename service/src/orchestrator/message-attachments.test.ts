// Files sent with a human message (DESIGN.md "Prompt attachments"): the run that answers it gets
// their paths and its images inline, a running agent gets them steered in, a message the run never
// took in keeps them in its queued run, and their uploads live as long as the ticket.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessApiError, HarnessClient, type PromptAttachment, type Ticket } from "@harness/shared";
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

describe("a message's attachments", () => {
  test("go with the run that answers it: paths in the prompt, images inline, listed on the transcript entry", async () => {
    const h = setup();
    const t = await blocked(h);
    const shot = h.file("shot.png", png(3, 2));
    const notes = h.file("notes.md", "# notes");
    await h.orch.sendMessage(t.key, "This one", { attachments: [{ path: shot }, { path: notes, name: "Notes" }] });
    await h.orch.idle();

    const chat = h.driver.calls.at(-1)!;
    expect(chat.kind).toBe("chat");
    expect(chat.prompt.startsWith("This one")).toBe(true);
    expect(chat.prompt).toContain(`- ${shot} (image, included in this message)`);
    expect(chat.prompt).toContain(`- ${notes}\n`);
    expect(chat.images?.map((i) => [i.name, Buffer.from(i.data, "base64").equals(png(3, 2))])).toEqual([["shot.png", true]]);

    const sent: PromptAttachment[] = [
      { path: shot, name: "shot.png", source: "file" },
      { path: notes, name: "Notes", source: "file" },
    ];
    expect(h.userEntries(t).at(-1)!.content).toEqual({ type: "text", text: "This one", attachments: sent });
    expect(h.store.runs.listBySession(t.sessionId).at(-1)!.attachments).toEqual(sent);
  });

  test("a later run doesn't get them again", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "Look", { attachments: [{ path: h.file("shot.png", png(1, 1)) }] });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "And now?");
    await h.orch.idle();
    const last = h.driver.calls.at(-1)!;
    expect(last.prompt).not.toContain("<attachments>");
    expect(last.images).toBeUndefined();
    expect(h.userEntries(t).at(-1)!.content).toEqual({ type: "text", text: "And now?" });
  });

  test("attachments alone are a message; no text and no attachments isn't; a path that isn't there is refused", async () => {
    const h = setup();
    const t = await blocked(h);
    await expect(h.orch.sendMessage(t.key, "  ", { attachments: [] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: join(h.home, "nope.png") }] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: "relative.png" }] })).rejects.toMatchObject({ status: 400 });
    expect(h.store.runs.listBySession(t.sessionId).map((r) => r.kind)).toEqual(["work"]);

    const shot = h.file("shot.png", png(1, 1));
    await h.orch.sendMessage(t.key, "", { attachments: [{ path: shot }] });
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.kind).toBe("chat");
    expect(h.driver.calls.at(-1)!.images).toHaveLength(1);
    expect(h.userEntries(t).at(-1)!.content).toMatchObject({ text: "", attachments: [{ path: shot }] });
  });

  test("are refused while a tool approval waits, since that message answers the approval", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: 'go /tool Bash {"command":"npm install"}' });
    await h.orch.idle();
    expect(h.store.tickets.get(t.id)!.pendingApproval).not.toBeNull();
    await expect(h.orch.sendMessage(t.key, "No, use bun", { attachments: [{ path: h.file("a.png") }] })).rejects.toMatchObject({ status: 409 });
    expect(h.store.tickets.get(t.id)!.pendingApproval).not.toBeNull();
  });

  test("re-opening a done ticket with a message sends them with its work run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it" });
    await h.orch.idle();
    await h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.store.tickets.get(t.id)!.status).toBe("done");
    const shot = h.file("bug.png", png(2, 2));
    await h.orch.sendMessage(t.key, "It broke /nosubmit", { move: true, attachments: [{ path: shot }] });
    await h.orch.idle();
    const work = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(work.prompt).toContain("It broke /nosubmit");
    expect(work.prompt).toContain(`- ${shot} (image, included in this message)`);
    expect(work.images).toHaveLength(1);
  });
});

describe("steering", () => {
  test("a running agent takes the message in with its images; the transcript keeps the words and the files", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /nosubmit" });
    await untilHolding(h);
    const shot = h.file("shot.png", png(2, 2));
    await h.orch.sendMessage(t.key, "Match this", { attachments: [{ path: shot }] });
    h.driver.release();
    await h.orch.idle();

    expect(h.store.runs.listBySession(t.sessionId).filter((r) => r.kind === "work")).toHaveLength(1);
    const [m] = h.driver.steeredMessages;
    expect(m!.text.startsWith("Match this")).toBe(true);
    expect(m!.text).toContain(`- ${shot} (image, included in this message)`);
    expect(m!.images?.map((i) => i.name)).toEqual(["shot.png"]);
    // The review run's prompt is a user entry too, so find the message's.
    const entry = h.userEntries(t).find((e) => e.content.type === "text" && e.content.text === "Match this");
    expect(entry?.content).toEqual({ type: "text", text: "Match this", attachments: [{ path: shot, name: "shot.png", source: "file" }] });
  });

  test("a message the run never took in is queued with its attachments, and shown once", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /deaf /nosubmit" });
    await untilHolding(h);
    const shot = h.file("shot.png", png(2, 2));
    await h.orch.sendMessage(t.key, "Match this /nosubmit", { attachments: [{ path: shot }] });
    h.driver.release();
    await h.orch.idle();

    const next = h.driver.calls[1]!;
    expect(next.prompt.startsWith("Match this /nosubmit")).toBe(true);
    expect(next.prompt).toContain(`- ${shot} (image, included in this message)`);
    expect(next.images?.map((i) => i.name)).toEqual(["shot.png"]);
    expect(h.store.runs.listBySession(t.sessionId)[1]!.attachments).toEqual([{ path: shot, name: "shot.png", source: "file" }]);
    expect(h.userEntries(t).filter((e) => e.content.type === "text" && e.content.text === "Match this /nosubmit")).toHaveLength(1);
  });
});

describe("uploads", () => {
  test("an upload sent with a message survives the startup sweep, and goes when its ticket is deleted", async () => {
    const h = setup();
    const t = await blocked(h);
    const sent = h.orch.uploadPromptAttachment(png(1, 1), "Pasted image.png", "image/png");
    const stray = h.orch.uploadPromptAttachment(png(1, 1), "Stray.png", "image/png");
    await h.orch.sendMessage(t.key, "From my phone", { attachments: [{ path: sent.path }] });
    await h.orch.idle();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const p of [sent.path, stray.path]) utimesSync(dirname(p), old, old);

    h.orch.sweepUploads();
    expect(existsSync(sent.path)).toBe(true);
    expect(existsSync(stray.path)).toBe(false);

    await h.orch.deleteTicket(t.key);
    expect(existsSync(sent.path)).toBe(false);
  });

  test("an upload a message shares with another ticket stays until neither uses it", async () => {
    const h = setup();
    const t = await blocked(h);
    const up = h.orch.uploadPromptAttachment(png(1, 1), "Pasted image.png", "image/png");
    await h.orch.sendMessage(t.key, "See", { attachments: [{ path: up.path }] });
    await h.orch.idle();
    const child = await h.orch.createTicket({ projectId: h.project.id, spec: "child", draft: true, promptAttachments: [{ path: up.path }] });
    await h.orch.deleteTicket(t.key);
    expect(existsSync(up.path)).toBe(true);
    await h.orch.deleteTicket(child.key);
    expect(existsSync(up.path)).toBe(false);
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("POST /messages takes attachments; each is served from its transcript entry with ?token=, 404 once gone", async () => {
    const home = tempHome("harness-message-att-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const t = await client.createTicket({ projectId: project.id, spec: "Plan it", start: false });
    const up = await client.uploadPromptAttachment(new Blob([png(2, 2)], { type: "image/png" }), "Pasted image", "image/png");
    const other = join(home, "notes.txt");
    writeFileSync(other, "hello");

    await client.sendMessage(t.key, "", { attachments: [{ path: up.path }, { path: other }] });
    const entry = (await client.transcript(t.sessionId)).find((e) => e.role === "user" && e.content.type === "text" && !!e.content.attachments);
    expect(entry?.content).toEqual({
      type: "text",
      text: "",
      attachments: [
        { path: up.path, name: "Pasted image.png", source: "upload" },
        { path: other, name: "notes.txt", source: "file" },
      ],
    });

    const img = await fetch(client.messageAttachmentUrl(entry!.id, 0));
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(Buffer.from(await img.arrayBuffer()).equals(png(2, 2))).toBe(true);
    expect((await fetch(client.messageAttachmentUrl(entry!.id, 1), { method: "HEAD" })).status).toBe(200);
    rmSync(other);
    expect((await fetch(client.messageAttachmentUrl(entry!.id, 1), { method: "HEAD" })).status).toBe(404);
    expect((await fetch(client.messageAttachmentUrl(entry!.id, 5))).status).toBe(404);
    expect((await fetch(client.messageAttachmentUrl("nope", 0))).status).toBe(404);
    expect((await fetch(client.messageAttachmentUrl(entry!.id, 0).replace(/token=[^&]+/, "token=nope"))).status).toBe(401);

    const missing = await client.sendMessage(t.key, "x", { attachments: [{ path: join(home, "gone.png") }] }).catch((e) => e);
    expect(missing).toBeInstanceOf(HarnessApiError);
    expect((missing as HarnessApiError).status).toBe(400);
  });
});
