// Annotations on a New session's prompt attachments (PromptAttachment.annotation, DESIGN.md
// "Annotations"): checked on create and on a draft's PATCH, saved or cleared per attachment, and
// listed under their file in the first run's <attachments> block and by get_ticket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type AttachmentAnnotation, type PromptAttachment, type Ticket } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { executeTool } from "../drivers/types";
import { makeOrchestrator, stubBrowser, tempHome } from "../testing/fakes";
import { png } from "../testing/media";
import { toolsForRun } from "../tools";
import { fakeContext, fakeSession } from "../tools/fakes";

function setup() {
  const h = makeOrchestrator({ tools: toolsForRun });
  const dir = join(h.home, "proj", "web");
  const files = join(h.home, "desktop");
  mkdirSync(dir, { recursive: true });
  mkdirSync(files, { recursive: true });
  const web = h.orch.createProject({ path: dir, key: "WEB" });
  const file = (name: string, data: Uint8Array | string = "x") => {
    const p = join(files, name);
    writeFileSync(p, data);
    return p;
  };
  const specImage = (t: Ticket, id: string) => {
    const a = { id, kind: "image" as const, mimeType: "image/png", name: "mockup.png", size: 1, width: 40, height: 20 };
    mkdirSync(h.paths.attachmentsDir, { recursive: true });
    h.store.attachments.add(t.id, [a]);
    const path = h.orch.attachmentFilePath(a);
    writeFileSync(path, png(40, 20));
    return path;
  };
  return { ...h, web, file, specImage };
}

const note = (message = "Bigger"): AttachmentAnnotation => ({ width: 40, height: 20, marks: [{ n: 1, x: 10, y: 5, tailX: 30, tailY: 15, message }] });

describe("creating and editing", () => {
  test("a New session keeps an annotation on its image; on a file that isn't one, or malformed, it's refused", async () => {
    const h = setup();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: notes }, { path: shot, annotation: note() }] });
    const expected: PromptAttachment[] = [
      { path: notes, name: "notes.md", source: "file" },
      { path: shot, name: "shot.png", source: "file", annotation: note() },
    ];
    expect(t.promptAttachments).toEqual(expected);
    expect(h.store.tickets.get(t.id)!.promptAttachments).toEqual(expected);
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: notes, annotation: note() }] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: shot, annotation: { ...note(), width: 0 } }] })).rejects.toMatchObject({ status: 400 });
  });

  test("a create can't name a spec image: a new ticket has none", async () => {
    const h = setup();
    const err = await h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: "attachment:att_1" }] }).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect((err as Error).message).toMatch(/new ticket has no spec images/);
  });

  test("a draft PATCH saves, changes and clears the annotation on one attachment, leaving the others", async () => {
    const h = setup();
    const a = h.file("a.png", png(40, 20));
    const b = h.file("b.png", png(40, 20));
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: a }, { path: b, annotation: note("On b") }] });
    const annotations = (t: Ticket) => t.promptAttachments!.map((x) => x.annotation?.marks[0]!.message ?? null);
    // Something else changed: the annotations stay.
    expect(annotations(await h.orch.updateTicket(d.key, { title: "Renamed" }))).toEqual([null, "On b"]);
    expect(annotations(await h.orch.updateTicket(d.key, { promptAttachments: [{ path: a, annotation: note("On a") }, { path: b, annotation: note("On b") }] }))).toEqual(["On a", "On b"]);
    expect(annotations(await h.orch.updateTicket(d.key, { promptAttachments: [{ path: a, annotation: note("Changed") }, { path: b }] }))).toEqual(["Changed", null]);
    // A refused PATCH changed nothing.
    await expect(h.orch.updateTicket(d.key, { promptAttachments: [{ path: a }, { path: b, annotation: { ...note(), marks: [] } }] })).rejects.toMatchObject({ status: 400 });
    expect(annotations(h.store.tickets.get(d.id)!)).toEqual(["Changed", null]);
  });

  test("a kept attachment whose file has gone missing keeps a changed annotation; its shape is still checked", async () => {
    const h = setup();
    const gone = h.file("gone.png", png(40, 20));
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: gone, annotation: note() }] });
    rmSync(gone);
    const t = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: gone, annotation: note("Still") }] });
    expect(t.promptAttachments![0]!.annotation).toEqual(note("Still"));
    await expect(h.orch.updateTicket(d.key, { promptAttachments: [{ path: gone, annotation: { ...note(), marks: [{ n: 2, x: 1, y: 1, message: "" }] } }] })).rejects.toMatchObject({ status: 400 });
  });

  test("a draft can take one of its own spec images as attachment:<id>, not another ticket's", async () => {
    const h = setup();
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true });
    const other = await h.orch.createTicket({ projectId: h.web.id, spec: "Other", draft: true });
    const stored = h.specImage(d, "att_mine");
    h.specImage(other, "att_theirs");
    const t = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: "attachment:att_mine", annotation: note() }] });
    expect(t.promptAttachments).toEqual([{ path: stored, name: "mockup.png", source: "file", annotation: note() }]);
    await expect(h.orch.updateTicket(d.key, { promptAttachments: [{ path: "attachment:att_theirs" }] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.updateTicket(d.key, { promptAttachments: [{ path: "attachment:att_nope" }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("the first run", () => {
  test("lists the notes under their file in <attachments>; later runs don't", async () => {
    const h = setup();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Fix it", start: true, promptAttachments: [{ path: notes }, { path: shot, annotation: note() }] });
    await h.orch.idle();
    const lines = h.driver.calls[0]!.prompt.split("\n");
    const at = lines.indexOf(`- ${shot} (image, included in this message)`);
    expect(at).toBeGreaterThan(lines.indexOf("<attachments>"));
    expect(lines.slice(at + 1, at + 3)).toEqual(["  40×20 px. Notes:", "  1. (10, 5) px, 25% across, 25% down, arrow from (30, 15) px: Bigger"]);

    await h.orch.sendMessage(t.key, "One more thing");
    await h.orch.idle();
    const later = h.driver.calls.slice(1).filter((c) => c.kind !== "review");
    expect(later.length).toBeGreaterThan(0);
    for (const c of later) expect(c.prompt).not.toContain("Notes:");
  });
});

describe("agent tools", () => {
  test("get_ticket lists each annotated prompt attachment's notes", async () => {
    const h = setup();
    const own = await h.orch.createTicket({ projectId: h.web.id, spec: "parent", start: false });
    await h.orch.idle();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const two: AttachmentAnnotation = { ...note(), marks: [...note().marks, { n: 2, x: 40, y: 20, message: "" }] };
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", start: false, promptAttachments: [{ path: notes }, { path: shot, annotation: two }] });
    await h.orch.idle();
    const ctx = fakeContext({ runKind: "work", ticket: own, cwd: h.home, session: fakeSession({ id: own.sessionId, key: own.key, ticketId: own.id }), ops: h.orch.ops });
    const got = await executeTool(toolsForRun("work", h.driver), "get_ticket", { key: d.key }, ctx);
    const detail = JSON.parse(got.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
    expect(detail.promptAttachments).toEqual([
      { name: "notes.md", path: notes, missing: false },
      { name: "shot.png", path: shot, missing: false, notes: ["1. (10, 5) px: Bigger", "2. (40, 20) px: (no note)"] },
    ]);
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("POST and PATCH /tickets carry an attachment's annotation, and refuse a malformed one", async () => {
    const home = tempHome("harness-prompt-ann-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const up = await client.uploadPromptAttachment(new Blob([png(40, 20)], { type: "image/png" }), "Pasted image", "image/png");
    const t = await client.createTicket({ projectId: project.id, spec: "Look", draft: true, promptAttachments: [{ path: up.path, annotation: note() }] });
    expect((await client.getTicket(t.key)).ticket.promptAttachments![0]!.annotation).toEqual(note());
    const cleared = await client.updateTicket(t.key, { promptAttachments: [{ path: up.path }] });
    expect(cleared.promptAttachments![0]).not.toHaveProperty("annotation");
    const bad = await client.updateTicket(t.key, { promptAttachments: [{ path: up.path, annotation: { ...note(), marks: [{ n: 1, x: 10, y: 5, tailX: 30, message: "" }] } }] }).catch((e) => e);
    expect((bad as HarnessApiError).status).toBe(400);
    expect((bad as HarnessApiError).message).toMatch(/tailX and tailY go together/);
  });
});
