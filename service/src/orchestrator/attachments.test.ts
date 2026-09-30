// Summary attachments through the orchestrator: post_summary / submit_for_review copy files into
// HARNESS_HOME/attachments, bad input posts nothing, get_ticket and the review prompt name the
// stored copies, and deleting a ticket or project removes them.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RunKind, Ticket } from "@harness/shared";
import type { RunRequest } from "../drivers/types";
import { makeOrchestrator } from "../testing/fakes";
import { gif, mp4, png } from "../testing/media";
import { allTools } from "../tools";
import { fakeContext, fakeSession } from "../tools/fakes";
import type { ToolResult } from "../tools/types";

async function setup() {
  const h = makeOrchestrator();
  const dir = join(h.home, "proj", "web");
  mkdirSync(join(dir, "shots"), { recursive: true });
  writeFileSync(join(dir, "shots", "after.png"), png(800, 600));
  writeFileSync(join(dir, "flow.mp4"), mp4(64));
  writeFileSync(join(dir, "anim.gif"), gif(10, 20));
  writeFileSync(join(dir, "notes.txt"), "not media");
  const project = h.orch.createProject({ path: dir, key: "WEB" });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  const make = async (status: Ticket["status"] = "in_progress") => {
    const t = await h.orch.createTicket({ projectId: project.id, prompt: "task", title: "task", start: false });
    h.store.tickets.update(t.id, { status });
    return h.store.tickets.get(t.id)!;
  };
  const ctx = (t: Ticket, cwd = dir) =>
    fakeContext({ runKind: "work", ticket: t, cwd, session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
  const stored = () => readdirSync(h.paths.attachmentsDir);
  return { ...h, dir, project, events, make, ctx, stored };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("post_summary attachments", () => {
  test("copies the files, keeps their order and emits them on summary.added", async () => {
    const h = await setup();
    const t = await h.make();
    const r = await tool("post_summary").execute({ summary: "Toggle works", attachments: ["shots/after.png", join(h.dir, "flow.mp4")] }, h.ctx(t));
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("Summary posted with 2 attachments.");

    const [summary] = h.orch.summaries(t.key);
    expect(summary!.attachments.map(({ kind, mimeType, name, width, height }) => ({ kind, mimeType, name, width, height }))).toEqual([
      { kind: "image", mimeType: "image/png", name: "after.png", width: 800, height: 600 },
      { kind: "video", mimeType: "video/mp4", name: "flow.mp4", width: undefined, height: undefined },
    ]);
    const added = h.events.filter((e) => e.kind === "summary.added").at(-1);
    expect(added).toMatchObject({ summary: { id: summary!.id, attachments: summary!.attachments } });

    // The copies outlive the originals (worktrees are deleted after the merge).
    unlinkSync(join(h.dir, "shots", "after.png"));
    const copy = h.orch.attachmentFile(summary!.attachments[0]!.id)!;
    expect(copy.path.startsWith(h.paths.attachmentsDir)).toBe(true);
    expect(readFileSync(copy.path)).toEqual(png(800, 600));
  });

  test("relative paths resolve against the run's working directory", async () => {
    const h = await setup();
    const t = await h.make();
    const elsewhere = join(h.home, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "after.png"), png(1, 2));
    await h.orch.ops.postSummary(h.ctx(t, elsewhere), "from another cwd", ["after.png"]);
    const [s] = h.orch.summaries(t.key);
    expect(s!.attachments[0]).toMatchObject({ name: "after.png", width: 1, height: 2 });
    await expect(h.orch.ops.postSummary(h.ctx(t, h.dir), "x", ["after.png"])).rejects.toThrow("Attachment not found: after.png");
  });

  test("invalid input fails the call and posts nothing, even when earlier files were fine", async () => {
    const h = await setup();
    const t = await h.make();
    const big = join(h.dir, "huge.mp4");
    writeFileSync(big, mp4());
    truncateSync(big, 100 * 1024 * 1024 + 1);
    const cases: [string[], string][] = [
      [Array(11).fill("anim.gif"), "Too many attachments"],
      [["anim.gif", "huge.mp4"], "Attachment too large: huge.mp4"],
      [["anim.gif", "notes.txt"], "Unsupported attachment type: notes.txt"],
      [["anim.gif", "missing.png"], "Attachment not found: missing.png"],
    ];
    // (the MCP layer turns the thrown error into an isError result)
    for (const [attachments, error] of cases) {
      await expect(tool("post_summary").execute({ summary: "should not post", attachments }, h.ctx(t))).rejects.toThrow(error);
    }
    expect(h.orch.summaries(t.key)).toEqual([]);
    expect(h.events.some((e) => e.kind === "summary.added")).toBe(false);
    expect(h.stored()).toEqual([]);
  });
});

describe("submit_for_review attachments", () => {
  test("a bad attachment leaves the ticket in progress with no summary", async () => {
    const h = await setup();
    const t = await h.make();
    await expect(tool("submit_for_review").execute({ summary: "done", attachments: ["shots/after.png", "notes.txt"] }, h.ctx(t))).rejects.toThrow(
      "Unsupported attachment type: notes.txt",
    );
    expect(h.store.tickets.get(t.id)!.status).toBe("in_progress");
    expect(h.orch.summaries(t.key)).toEqual([]);
    expect(h.stored()).toEqual([]);
  });

  test("attachments land on the submit summary, and the review prompt and get_ticket name the stored copies", async () => {
    const h = await setup();
    h.driver.script = async function* (req: RunRequest) {
      if (req.kind === "work") await req.toolContext.ops.submitForReview(req.toolContext, "Header toggle done", ["shots/after.png"]);
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "task", title: "task", start: true });
    await h.orch.idle();
    expect(h.store.tickets.get(t.id)!.status).toBe("review");
    const [summary] = h.orch.summaries(t.key);
    expect(summary!.body).toBe("Header toggle done");
    const path = h.orch.attachmentFilePath(summary!.attachments[0]!);
    expect(existsSync(path)).toBe(true);

    const review = h.driver.calls.find((c) => c.kind === "review")!;
    expect(review.prompt).toContain(`Header toggle done\nAttachments:\n* after.png (image): ${path}`);

    const detail = await h.orch.ops.getTicket(h.ctx(h.store.tickets.get(t.id)!), t.key);
    expect(detail.summaries[0]!.attachments).toEqual([{ name: "after.png", kind: "image", path }]);
  });
});

describe("fileOutputScope (browser_screenshot save_to)", () => {
  test("read-only follows the run kind and the effective mode (ticket → project → settings)", async () => {
    const h = await setup();
    const t = await h.make();
    const scope = (kind: RunKind, ticket = h.store.tickets.get(t.id)!) => h.orch.ops.fileOutputScope({ ...h.ctx(ticket), runKind: kind });
    expect(await scope("work")).toEqual({ scratchDir: join(h.paths.scratchDir, t.sessionId), readOnly: false });
    for (const kind of ["plan", "review"] as RunKind[]) expect((await scope(kind)).readOnly).toBe(true);
    // A chat run saves where a work run would: it has the ticket's own mode.
    expect((await scope("chat")).readOnly).toBe(false);

    h.store.settings.set({ permissionMode: "read_only" });
    expect((await scope("work")).readOnly).toBe(true);
    h.store.projects.setPermissionMode(h.project.id, "ask");
    expect((await scope("work")).readOnly).toBe(false);
    h.store.tickets.update(t.id, { permissionMode: "read_only" });
    expect((await scope("work")).readOnly).toBe(true);
  });

  test("a read-only run's relative save_to lands in its scratch folder, which goes with the ticket", async () => {
    const h = await setup();
    const t = await h.make();
    h.store.tickets.update(t.id, { permissionMode: "read_only" });
    const ctx = h.ctx(h.store.tickets.get(t.id)!);
    await tool("browser_screenshot").execute({ save_to: "shot.png" }, ctx);
    const scratch = join(h.paths.scratchDir, t.sessionId);
    expect(existsSync(join(scratch, "shot.png"))).toBe(true);
    expect(existsSync(join(h.dir, "shot.png"))).toBe(false);
    await h.orch.deleteTicket(t.key);
    expect(existsSync(scratch)).toBe(false);
  });
});

describe("deleting removes attachment files", () => {
  test("deleteTicket removes the ticket's files and leaves other tickets' alone", async () => {
    const h = await setup();
    const a = await h.make();
    const b = await h.make();
    await h.orch.ops.postSummary(h.ctx(a), "a", ["anim.gif", "flow.mp4"]);
    await h.orch.ops.postSummary(h.ctx(b), "b", ["anim.gif"]);
    const [kept] = h.orch.summaries(b.key)[0]!.attachments;
    expect(h.stored()).toHaveLength(3);
    await h.orch.deleteTicket(a.key);
    expect(h.stored()).toEqual([h.orch.attachmentFilePath(kept!).split("/").at(-1)!]);
    expect(h.orch.attachmentFile(kept!.id)).not.toBeNull();
  });

  test("deleteProject removes every ticket's files", async () => {
    const h = await setup();
    const a = await h.make();
    const b = await h.make("review");
    await h.orch.ops.postSummary(h.ctx(a), "a", ["anim.gif"]);
    await h.orch.ops.postSummary(h.ctx(b), "b", ["flow.mp4"]);
    expect(h.stored()).toHaveLength(2);
    await h.orch.deleteProject(h.project.id);
    expect(h.stored()).toEqual([]);
  });
});
