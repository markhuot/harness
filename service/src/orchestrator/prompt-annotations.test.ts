// Annotations on a ticket's prompt attachments (Ticket.promptAnnotations, DESIGN.md
// "Annotations"): validated on create and on a draft's PATCH, cleared when a PATCH changes the
// attachments without them, fixed once launched, and listed in the first run's prompt before its
// <attachments> block.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient, type MessageAnnotation } from "@harness/shared";
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
  return { ...h, web, file };
}

const note = (attachment: number, message = "Bigger"): MessageAnnotation => ({
  attachment,
  source: { kind: "file", name: "shot.png" },
  width: 40,
  height: 20,
  marks: [{ n: 1, x: 10, y: 5, tailX: 30, tailY: 15, message }],
});

describe("creating and editing", () => {
  test("a ticket keeps its notes on an image among its attachments; one on a file it doesn't have is refused", async () => {
    const h = setup();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: notes }, { path: shot }], promptAnnotations: [note(1)] });
    expect(t.promptAnnotations).toEqual([note(1)]);
    expect(h.store.tickets.get(t.id)!.promptAnnotations).toEqual([note(1)]);
    // Index 2 is past the list; index 0 is the markdown file.
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: shot }], promptAnnotations: [note(2)] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: notes }, { path: shot }], promptAnnotations: [note(0)] })).rejects.toMatchObject({ status: 400 });
    // Without attachments there's nothing to annotate.
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAnnotations: [note(0)] })).rejects.toMatchObject({ status: 400 });
  });

  test("a ticket created without them has none", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true });
    expect(t.promptAnnotations).toEqual([]);
  });

  test("a draft PATCH changing the attachments without the notes clears them; with them, keeps them", async () => {
    const h = setup();
    const shot = h.file("shot.png", png(40, 20));
    const other = h.file("other.png", png(40, 20));
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: shot }], promptAnnotations: [note(0)] });
    // Something else changed: the notes stay.
    expect((await h.orch.updateTicket(d.key, { title: "Renamed" })).promptAnnotations).toEqual([note(0)]);
    // A file was added in front, with the notes moved along.
    const moved = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: other }, { path: shot }], promptAnnotations: [note(1)] });
    expect(moved.promptAnnotations).toEqual([note(1)]);
    // The list changed without them: none is left pointing at another file.
    const cleared = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: shot }] });
    expect(cleared.promptAnnotations).toEqual([]);
    expect(h.store.tickets.get(d.id)!.promptAnnotations).toEqual([]);
    // Notes alone, against the list it has.
    expect((await h.orch.updateTicket(d.key, { promptAnnotations: [note(0, "Again")] })).promptAnnotations).toEqual([note(0, "Again")]);
    await expect(h.orch.updateTicket(d.key, { promptAnnotations: [note(1)] })).rejects.toMatchObject({ status: 400 });
    // A refused PATCH changed nothing.
    expect(h.store.tickets.get(d.id)!.promptAnnotations).toEqual([note(0, "Again")]);
  });

  test("a kept annotated file that has gone missing doesn't fail a PATCH; a newly annotated one is still checked", async () => {
    const h = setup();
    const gone = h.file("gone.bin", png(40, 20));
    const text = h.file("text.bin", "not an image");
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: gone }, { path: text }], promptAnnotations: [note(0)] });
    rmSync(gone);
    // Unreadable with no image extension, it would fail a fresh check.
    const t = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: gone }, { path: text }], promptAnnotations: [note(0, "Still")] });
    expect(t.promptAnnotations).toEqual([note(0, "Still")]);
    await expect(h.orch.updateTicket(d.key, { promptAnnotations: [note(0), note(1)] })).rejects.toMatchObject({ status: 400 });
  });

  test("a launched ticket's notes are fixed", async () => {
    const h = setup();
    const shot = h.file("shot.png", png(40, 20));
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: shot }] });
    const launched = await h.orch.submitTicket(d.key, { start: false });
    await expect(h.orch.updateTicket(launched.key, { promptAnnotations: [note(0)] })).rejects.toMatchObject({ status: 409 });
    await h.orch.idle();
  });
});

describe("the first run", () => {
  test("reads the notes before its <attachments> block; later runs don't", async () => {
    const h = setup();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Fix it", start: true, promptAttachments: [{ path: notes }, { path: shot }], promptAnnotations: [note(1)] });
    await h.orch.idle();
    const first = h.driver.calls[0]!.prompt;
    const ann = first.indexOf("<annotations>");
    const att = first.indexOf("<attachments>");
    expect(ann).toBeGreaterThan(0);
    expect(att).toBeGreaterThan(ann);
    expect(first.slice(ann, att)).toContain(`${shot} (40×20 px) is the attached image "shot.png"`);
    expect(first).toContain("1. (10, 5) px, 25% across, 25% down, arrow from (30, 15) px: Bigger");

    await h.orch.sendMessage(t.key, "One more thing");
    await h.orch.idle();
    const later = h.driver.calls.slice(1).filter((c) => c.kind !== "review");
    expect(later.length).toBeGreaterThan(0);
    for (const c of later) expect(c.prompt).not.toContain("<annotations>");
  });

  test("with a message's own files too, each note names its own file in the combined list", async () => {
    const h = setup();
    const ticketShot = h.file("ticket.png", png(40, 20));
    const msgNotes = h.file("msg.md", "# notes");
    const msgShot = h.file("msg.png", png(40, 20));
    // The first run fails, so the next one is still the first to get through and carries both.
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Fix it /fail boom", start: true, promptAttachments: [{ path: ticketShot }], promptAnnotations: [note(0, "Ticket note")] });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "Also this", { attachments: [{ path: msgNotes }, { path: msgShot }], annotations: [note(1, "Message note")] });
    await h.orch.idle();
    const chat = h.driver.calls.at(-1)!.prompt;
    expect(chat.match(/<annotations>/g)).toHaveLength(1);
    const block = chat.slice(chat.indexOf("<annotations>"), chat.indexOf("<attachments>"));
    // Index 1 of the message's files is msg.png, not the ticket's second file (there is none) or msg.md.
    expect(block).toMatch(new RegExp(`${ticketShot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(40×20 px\\)[^\\n]*\\n1\\.[^\\n]*Ticket note`));
    expect(block).toMatch(new RegExp(`${msgShot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(40×20 px\\)[^\\n]*\\n1\\.[^\\n]*Message note`));
    expect(block).not.toContain(msgNotes);
    // The chat's transcript entry has only the message's own notes.
    const entry = h.store.transcript.list(t.sessionId).filter((e) => e.role === "user").at(-1)!.content;
    expect(entry).toMatchObject({ text: "Also this", annotations: [note(1, "Message note")] });
  });
});

describe("agent tools", () => {
  test("get_ticket lists each annotated file's notes", async () => {
    const h = setup();
    const own = await h.orch.createTicket({ projectId: h.web.id, spec: "parent", start: false });
    await h.orch.idle();
    const notes = h.file("notes.md", "# notes");
    const shot = h.file("shot.png", png(40, 20));
    const two: MessageAnnotation = { ...note(1), marks: [...note(1).marks, { n: 2, x: 40, y: 20, message: "" }] };
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", start: false, promptAttachments: [{ path: notes }, { path: shot }], promptAnnotations: [two] });
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

  test("POST and PATCH /tickets take promptAnnotations, and the ticket sends them back", async () => {
    const home = tempHome("harness-prompt-ann-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const up = await client.uploadPromptAttachment(new Blob([png(40, 20)], { type: "image/png" }), "Pasted image", "image/png");
    const t = await client.createTicket({ projectId: project.id, spec: "Look", draft: true, promptAttachments: [{ path: up.path }], promptAnnotations: [note(0)] });
    expect((await client.getTicket(t.key)).ticket.promptAnnotations).toEqual([note(0)]);
    const patched = await client.updateTicket(t.key, { promptAttachments: [{ path: up.path }] });
    expect(patched.promptAnnotations).toEqual([]);
  });
});
