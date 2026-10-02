// Ticket attachments through the orchestrator: images a spec write points at are copied into
// HARNESS_HOME/attachments, bad input stores nothing, browser_screenshot's save_to follows the run's
// read-only scope, and deleting a ticket or project removes the files.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RunKind, Ticket } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";
import { gif, mp4, png } from "../testing/media";
import { allTools } from "../tools";
import { fakeContext, fakeSession } from "../tools/fakes";

async function setup() {
  const h = makeOrchestrator();
  h.driver.script = async function* () {}; // no plan run rewriting the spec
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
    const t = await h.orch.createTicket({ projectId: project.id, spec: "task", title: "task", start: false });
    h.store.tickets.update(t.id, { status });
    return h.store.tickets.get(t.id)!;
  };
  const ctx = (t: Ticket, cwd = dir) =>
    fakeContext({ runKind: "work", ticket: t, cwd, session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
  const stored = () => readdirSync(h.paths.attachmentsDir);
  return { ...h, dir, project, events, make, ctx, stored };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;

describe("spec attachments", () => {
  test("relative image paths resolve against the run's working directory", async () => {
    const h = await setup();
    const t = await h.make();
    const elsewhere = join(h.home, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "after.png"), png(1, 2));
    await h.orch.ops.updateSpec(h.ctx(t, elsewhere), { spec: "![a](after.png)", note: "x", baseRevision: 1 });
    expect(h.store.attachments.listByTicket(t.id)[0]).toMatchObject({ name: "after.png", width: 1, height: 2 });
    const fresh = h.store.tickets.get(t.id)!;
    await expect(h.orch.ops.updateSpec(h.ctx(fresh, h.dir), { spec: "![b](after.png)", note: "x", baseRevision: 2 })).rejects.toThrow("Attachment not found: after.png");
  });

  test("too many, too large or missing files fail the write and store nothing", async () => {
    const h = await setup();
    const t = await h.make();
    const big = join(h.dir, "huge.mp4");
    writeFileSync(big, mp4());
    truncateSync(big, 100 * 1024 * 1024 + 1);
    const many = Array.from({ length: 11 }, (_, i) => {
      writeFileSync(join(h.dir, `a${i}.gif`), gif(1, 1));
      return `![${i}](a${i}.gif)`;
    }).join("\n");
    const cases: [string, string][] = [
      [many, "Too many attachments"],
      ["![a](anim.gif)\n![b](huge.mp4)", "Attachment too large: huge.mp4"],
      ["![a](anim.gif)\n![b](missing.png)", "Attachment not found: missing.png"],
    ];
    for (const [spec, error] of cases) {
      await expect(tool("update_spec").execute({ spec, note: "x", base_revision: 1 }, h.ctx(t))).rejects.toThrow(error);
    }
    expect(h.store.tickets.get(t.id)!.specRevision).toBe(1);
    expect(h.events.some((e) => e.kind === "spec.revised")).toBe(false);
    expect(h.stored()).toEqual([]);
  });

  test("a write refused for a stale revision keeps no copies", async () => {
    const h = await setup();
    const t = await h.make();
    await h.orch.updateTicket(t.key, { spec: "human edit", baseRevision: 1 });
    await expect(h.orch.ops.updateSpec(h.ctx(t), { spec: "![a](anim.gif)", note: "x", baseRevision: 1 })).rejects.toThrow("The spec is at revision 2, not 1");
    expect(h.stored()).toEqual([]);
    expect(h.store.attachments.listByTicket(t.id)).toEqual([]);
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
    await h.orch.ops.updateSpec(h.ctx(a), { spec: "![a](anim.gif)\n![b](flow.mp4)", note: "a", baseRevision: 1 });
    await h.orch.ops.updateSpec(h.ctx(b), { spec: "![a](anim.gif)", note: "b", baseRevision: 1 });
    const [kept] = h.store.attachments.listByTicket(b.id);
    expect(h.stored()).toHaveLength(3);
    await h.orch.deleteTicket(a.key);
    expect(h.stored()).toEqual([h.orch.attachmentFilePath(kept!).split("/").at(-1)!]);
    expect(h.orch.attachmentFile(kept!.id)).not.toBeNull();
  });

  test("deleteProject removes every ticket's files", async () => {
    const h = await setup();
    const a = await h.make();
    const b = await h.make("review");
    await h.orch.ops.updateSpec(h.ctx(a), { spec: "![a](anim.gif)", note: "a", baseRevision: 1 });
    await h.orch.ops.updateSpec(h.ctx(b), { spec: "![b](flow.mp4)", note: "b", baseRevision: 1 });
    expect(h.stored()).toHaveLength(2);
    await h.orch.deleteProject(h.project.id);
    expect(h.stored()).toEqual([]);
  });
});
