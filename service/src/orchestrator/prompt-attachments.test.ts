// Prompt attachments (DESIGN.md "Prompt attachments") through the orchestrator and over HTTP:
// creating and editing a draft's list, what the first run gets, missing files, uploads and their
// cleanup, and the agent tools.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type Ticket } from "@harness/shared";
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
  const statusLines = (t: Ticket) => h.store.transcript.tail(t.sessionId, 50, ["status"]).map((e) => ("text" in e.content ? e.content.text : ""));
  return { ...h, web, file, statusLines };
}

describe("creating and editing", () => {
  test("a ticket keeps its attachments where they are, and the source comes from the service", async () => {
    const h = setup();
    const shot = h.file("shot.png", png(2, 2));
    const up = h.orch.uploadPromptAttachment(png(1, 1), "Pasted image.png", "image/png");
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: shot }, { path: up.path }] });
    expect(t.promptAttachments).toEqual([
      { path: shot, name: "shot.png", source: "file" },
      { path: up.path, name: "Pasted image.png", source: "upload" },
    ]);
    expect(up.path.startsWith(h.paths.uploadsDir)).toBe(true);
    await expect(h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: join(h.home, "nope.png") }] })).rejects.toMatchObject({ status: 400 });
  });

  test("a draft's list changes by PATCH, keeping one whose file has gone; a launched ticket's is fixed", async () => {
    const h = setup();
    const a = h.file("a.png");
    const b = h.file("b.txt");
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: a }] });
    rmSync(a);
    const t = await h.orch.updateTicket(d.key, { promptAttachments: [{ path: a }, { path: b }] });
    expect(t.promptAttachments!.map((x) => x.path)).toEqual([a, b]);
    const launched = await h.orch.submitTicket(d.key, { start: false });
    await expect(h.orch.updateTicket(launched.key, { promptAttachments: [] })).rejects.toMatchObject({ status: 409 });
    await h.orch.idle();
  });
});

describe("the first run", () => {
  test("gets every path in its prompt and the images inline; later runs don't get them again", async () => {
    const h = setup();
    const shot = h.file("shot.png", png(3, 2));
    const notes = h.file("notes.md", "# notes");
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "Fix what the screenshot shows", start: true, promptAttachments: [{ path: shot }, { path: notes }] });
    await h.orch.idle();
    const first = h.driver.calls[0]!;
    expect(first.kind).toBe("work");
    expect(first.prompt).toContain("<attachments>");
    expect(first.prompt).toContain(`- ${shot} (image, included in this message)`);
    expect(first.prompt).toContain(`- ${notes}\n`);
    expect(first.images?.map((i) => [i.name, i.mediaType, Buffer.from(i.data, "base64").equals(png(3, 2))])).toEqual([["shot.png", "image/png", true]]);
    expect(h.statusLines(t)).toContain("Attached shot.png, notes.md");

    await h.orch.sendMessage(t.key, "One more thing");
    await h.orch.idle();
    const later = h.driver.calls.slice(1).filter((c) => c.kind !== "review");
    expect(later.length).toBeGreaterThan(0);
    for (const c of later) {
      expect(c.prompt).not.toContain("<attachments>");
      expect(c.images).toBeUndefined();
    }
  });

  test("a file that went missing before the run is named in the prompt and the transcript", async () => {
    const h = setup();
    const shot = h.file("shot.png", png(1, 1));
    const d = await h.orch.createTicket({ projectId: h.web.id, spec: "Look", draft: true, promptAttachments: [{ path: shot }] });
    rmSync(shot);
    const t = await h.orch.submitTicket(d.key, { start: true });
    await h.orch.idle();
    expect(h.driver.calls[0]!.prompt).toContain(`- ${shot} (missing: it was moved or deleted after it was attached)`);
    expect(h.driver.calls[0]!.images).toBeUndefined();
    expect(h.statusLines(t)).toContain(`Attachment missing: shot.png (was at ${shot})`);
  });

  test("a ticket without attachments gets its prompt unchanged", async () => {
    const h = setup();
    await h.orch.createTicket({ projectId: h.web.id, spec: "Plain", start: true });
    await h.orch.idle();
    expect(h.driver.calls[0]!.prompt).not.toContain("<attachments>");
  });
});

describe("uploads", () => {
  test("deleting the ticket deletes its uploads, not the files it referenced elsewhere", async () => {
    const h = setup();
    const shot = h.file("shot.png");
    const up = h.orch.uploadPromptAttachment(png(1, 1), "Pasted image.png", "image/png");
    const t = await h.orch.createTicket({ projectId: h.web.id, spec: "x", draft: true, promptAttachments: [{ path: shot }, { path: up.path }] });
    await h.orch.deleteTicket(t.key);
    expect(existsSync(up.path)).toBe(false);
    expect(existsSync(shot)).toBe(true);
  });
});

describe("agent tools", () => {
  test("create_ticket attaches files (relative to the cwd), and get_ticket lists them with whether they're missing", async () => {
    const h = setup();
    const own = await h.orch.createTicket({ projectId: h.web.id, spec: "parent", start: false });
    await h.orch.idle();
    const cwd = join(h.home, "desktop");
    h.file("shot.png");
    h.file("gone.png");
    const ctx = fakeContext({ runKind: "work", ticket: own, cwd, session: fakeSession({ id: own.sessionId, key: own.key, ticketId: own.id }), ops: h.orch.ops });
    const tools = toolsForRun("work", h.driver);
    const run = (name: string, input: unknown) => executeTool(tools, name, input, ctx);
    const made = await run("create_ticket", { title: "Child", spec: "Look", attachments: ["shot.png", "gone.png"] });
    expect(made.isError).toBeFalsy();
    const key = /Created (WEB-\d+)/.exec(made.content.map((c) => (c.type === "text" ? c.text : "")).join(""))![1]!;
    rmSync(join(cwd, "gone.png"));
    const got = await run("get_ticket", { key });
    const detail = JSON.parse(got.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
    expect(detail.promptAttachments).toEqual([
      { name: "shot.png", path: join(cwd, "shot.png"), missing: false },
      { name: "gone.png", path: join(cwd, "gone.png"), missing: true },
    ]);
    await h.orch.idle();
  });
});

describe("over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("POST /uploads stores a paste; the file is served by index with ?token=, and 404s once it's gone", async () => {
    const home = tempHome("harness-prompt-att-http-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    await client.updateSettings({ defaultDriver: "dummy" });
    const dir = join(home, "work", "web");
    mkdirSync(dir, { recursive: true });
    const project = await client.createProject({ path: dir, key: "WEB" });
    const up = await client.uploadPromptAttachment(new Blob([png(2, 2)], { type: "image/png" }), "Pasted image", "image/png");
    expect(up).toMatchObject({ name: "Pasted image.png", source: "upload" });
    const other = join(home, "notes.txt");
    writeFileSync(other, "hello");
    const t = await client.createTicket({ projectId: project.id, spec: "Look", draft: true, promptAttachments: [{ path: up.path }, { path: other }] });

    const img = await fetch(client.promptAttachmentUrl(t.key, 0));
    expect([img.status, img.headers.get("content-type"), img.headers.get("cache-control")]).toEqual([200, "image/png", "no-cache"]);
    expect(Buffer.from(await img.arrayBuffer()).equals(png(2, 2))).toBe(true);
    const head = await fetch(client.promptAttachmentUrl(t.key, 1), { method: "HEAD" });
    expect(head.status).toBe(200);

    rmSync(other);
    expect((await fetch(client.promptAttachmentUrl(t.key, 1), { method: "HEAD" })).status).toBe(404);
    expect((await fetch(client.promptAttachmentUrl(t.key, 7))).status).toBe(404);
    expect((await fetch(client.promptAttachmentUrl(t.key, 0).replace(/token=[^&]+/, "token=nope"))).status).toBe(401);
    // The ticket itself still loads with its missing file listed.
    expect((await client.getTicket(t.key)).ticket.promptAttachments).toHaveLength(2);

    const empty = await client.uploadPromptAttachment(new Uint8Array(), "a.png", "image/png").catch((e) => e);
    expect(empty).toBeInstanceOf(HarnessApiError);
    expect((empty as HarnessApiError).status).toBe(400);
  });
});
