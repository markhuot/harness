// An annotation sent with a message (DESIGN.md "Annotations") is metadata on its attachment: it
// rides in MessageBody.attachments into the transcript entry, a queued run's attachments and a
// steered message, and the run that answers lists its notes under that file's path in the
// <attachments> block. A spec image is sent as attachment:<id> and referenced where it's stored.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type AttachmentAnnotation, type PromptAttachment, type Ticket } from "@harness/shared";
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
  /** Store a spec image on the ticket as the spec's attachment:<id> would. */
  const specImage = (t: Ticket, id: string, name = "mockup.png") => {
    const a = { id, kind: "image" as const, mimeType: "image/png", name, size: 1, width: 40, height: 20 };
    mkdirSync(h.paths.attachmentsDir, { recursive: true });
    h.store.attachments.add(t.id, [a]);
    const path = h.orch.attachmentFilePath(a);
    writeFileSync(path, png(40, 20));
    return path;
  };
  const userEntries = (t: Ticket) => h.store.transcript.list(t.sessionId).filter((e) => e.role === "user");
  return { ...h, project, file, specImage, userEntries };
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

const note = (message = "Bigger"): AttachmentAnnotation => ({ width: 40, height: 20, marks: [{ n: 1, x: 10, y: 5, tailX: 30, tailY: 15, message }] });
const LINE = "1. (10, 5) px, 25% across, 25% down, arrow from (30, 15) px: Bigger";
/** The lines of the prompt's <attachments> block right under `path`'s line. */
const under = (prompt: string, path: string, n = 2) => {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`- ${path}`));
  expect(at).toBeGreaterThan(0);
  return lines.slice(at + 1, at + 1 + n);
};

describe("a message's annotated attachment", () => {
  test("is in the transcript entry and the run's attachments, and the answering run lists its notes under that file", async () => {
    const h = setup();
    const t = await blocked(h);
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    await h.orch.sendMessage(t.key, "Fix these", { attachments: [{ path: notes }, { path: shot, annotation: note() }] });
    await h.orch.idle();

    const chat = h.driver.calls.at(-1)!;
    expect(chat.kind).toBe("chat");
    expect(chat.prompt.startsWith("Fix these")).toBe(true);
    expect(under(chat.prompt, shot)).toEqual(["  40×20 px. Notes:", `  ${LINE}`]);
    // The markdown file has no notes: the next line is the image's.
    expect(under(chat.prompt, notes, 1)).toEqual([`- ${shot} (image, included in this message)`]);
    // The image goes inline, unchanged.
    expect(Buffer.from(chat.images![0]!.data, "base64").equals(png(40, 20))).toBe(true);

    const files: PromptAttachment[] = [
      { path: notes, name: "notes.md", source: "file" },
      { path: shot, name: "shot.png", source: "file", annotation: note() },
    ];
    expect(h.userEntries(t).at(-1)!.content).toEqual({ type: "text", text: "Fix these", attachments: files });
    expect(h.store.runs.listBySession(t.sessionId).at(-1)!.attachments).toEqual(files);
  });

  test("a later run doesn't get the notes again", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "Look", { attachments: [{ path: h.file("shot.png", png(40, 20)), annotation: note() }] });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "And now?");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.prompt).not.toContain("Notes:");
  });

  test("on a file that isn't an image, or malformed, it's refused and nothing runs", async () => {
    const h = setup();
    const t = await blocked(h);
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: h.file("a.md"), annotation: note() }] })).rejects.toMatchObject({ status: 400 });
    const bad = { ...note(), marks: [{ n: 1, x: 41, y: 1, message: "" }] };
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: h.file("b.png", png(40, 20)), annotation: bad }] })).rejects.toMatchObject({ status: 400 });
    expect(h.store.runs.listBySession(t.sessionId).map((r) => r.kind)).toEqual(["work"]);
  });

  test("re-opening a done ticket or sending a review one back to work carries it into the work run", async () => {
    const h = setup();
    const done = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it" });
    const review = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it too" });
    await h.orch.idle();
    await h.orch.humanReview(done.key, { decision: "approve" });
    await h.orch.idle();
    for (const t of [done, review]) {
      const bug = h.file(`${t.key}.png`, png(40, 20));
      await h.orch.sendMessage(t.key, "It broke /nosubmit", { move: true, attachments: [{ path: bug, annotation: note() }] });
      await h.orch.idle();
      const work = h.driver.calls.filter((c) => c.kind === "work" && c.prompt.startsWith("It broke")).at(-1)!;
      expect(under(work.prompt, bug)).toEqual(["  40×20 px. Notes:", `  ${LINE}`]);
    }
  });
});

describe("a spec image as attachment:<id>", () => {
  test("resolves to its stored file, named after it, and its notes are listed under that path", async () => {
    const h = setup();
    const t = await blocked(h);
    const stored = h.specImage(t, "att_1");
    await h.orch.sendMessage(t.key, "This one", { attachments: [{ path: "attachment:att_1", annotation: note() }] });
    await h.orch.idle();
    expect(h.userEntries(t).at(-1)!.content).toMatchObject({ attachments: [{ path: stored, name: "mockup.png", source: "file", annotation: note() }] });
    expect(under(h.driver.calls.at(-1)!.prompt, stored)).toEqual(["  40×20 px. Notes:", `  ${LINE}`]);
  });

  test("an unknown id, or another ticket's, is refused", async () => {
    const h = setup();
    const t = await blocked(h);
    const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
    h.specImage(other, "att_other");
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: "attachment:att_9" }] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.sendMessage(t.key, "x", { attachments: [{ path: "attachment:att_other" }] })).rejects.toMatchObject({ status: 400 });
    expect(h.store.runs.listBySession(t.sessionId).map((r) => r.kind)).toEqual(["work"]);
  });
});

describe("steering", () => {
  test("a running agent gets the notes in the steered message; the transcript keeps the annotated attachment", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /nosubmit" });
    await untilHolding(h);
    const shot = h.file("shot.png", png(40, 20));
    await h.orch.sendMessage(t.key, "Match this", { attachments: [{ path: shot, annotation: note() }] });
    h.driver.release();
    await h.orch.idle();

    const [m] = h.driver.steeredMessages;
    expect(m!.text.startsWith("Match this")).toBe(true);
    expect(under(m!.text, shot)).toEqual(["  40×20 px. Notes:", `  ${LINE}`]);
    const entry = h.userEntries(t).find((e) => e.content.type === "text" && e.content.text === "Match this");
    expect(entry?.content).toMatchObject({ attachments: [{ path: shot, annotation: note() }] });
  });

  test("a message the run never took in is queued with its annotated attachment", async () => {
    const h = setup(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /deaf /nosubmit" });
    await untilHolding(h);
    const shot = h.file("shot.png", png(40, 20));
    await h.orch.sendMessage(t.key, "Match this /nosubmit", { attachments: [{ path: shot, annotation: note() }] });
    h.driver.release();
    await h.orch.idle();

    expect(under(h.driver.calls[1]!.prompt, shot)).toEqual(["  40×20 px. Notes:", `  ${LINE}`]);
    expect(h.store.runs.listBySession(t.sessionId)[1]!.attachments).toEqual([{ path: shot, name: "shot.png", source: "file", annotation: note() }]);
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("POST /messages takes an annotated attachment and refuses a malformed one; GET /browser/:sessionId/screenshot answers the PNG and its sizes", async () => {
    const home = tempHome("harness-message-ann-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const t = await client.createTicket({ projectId: project.id, spec: "Plan it", start: false });

    // No tab yet: nothing to screenshot.
    expect(((await client.browserScreenshot(t.sessionId).catch((e) => e)) as HarnessApiError).status).toBe(404);
    await client.browserNavigate(t.sessionId, "http://localhost:3000/login");
    const shot = await client.browserScreenshot(t.sessionId);
    expect([shot.width, shot.height, shot.viewport, shot.scale, shot.tabId, shot.url]).toEqual([1280, 800, { width: 1280, height: 800 }, 1, 1, "http://localhost:3000/login"]);
    expect(Buffer.from(shot.data, "base64").equals(png(1280, 800))).toBe(true);
    expect(((await client.browserScreenshot(t.sessionId, 7).catch((e) => e)) as HarnessApiError).status).toBe(404);

    const up = await client.uploadPromptAttachment(new Blob([Buffer.from(shot.data, "base64")], { type: "image/png" }), "Browser.png", "image/png");
    const annotation: AttachmentAnnotation = {
      width: shot.width,
      height: shot.height,
      marks: [{ n: 1, x: 1000, y: 100, message: "Log in button" }],
      page: { url: shot.url, title: shot.title, tabId: shot.tabId, viewport: shot.viewport, scale: shot.scale },
    };
    await client.sendMessage(t.key, "Click this", { attachments: [{ path: up.path, annotation }] });
    const entry = (await client.transcript(t.sessionId)).find((e) => e.role === "user" && e.content.type === "text" && e.content.text === "Click this");
    expect(entry?.content).toMatchObject({ attachments: [{ path: up.path, name: "Browser.png", source: "upload", annotation }] });

    const bad = await client.sendMessage(t.key, "x", { attachments: [{ path: up.path, annotation: { ...annotation, marks: [{ n: 1, x: 3000, y: 1, message: "" }] } }] }).catch((e) => e);
    expect((bad as HarnessApiError).status).toBe(400);
    expect((bad as HarnessApiError).message).toMatch(/inside the 1280×800 image/);
  });
});
