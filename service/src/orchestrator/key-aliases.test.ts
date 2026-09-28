// Old ticket keys (from before a project rename) keep working through the orchestrator:
// detail lookups, dependsOn inputs, conductor tools and triage dispatch.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";

function setup() {
  const h = makeOrchestrator({ driver: new FakeDriver() });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "OLD" });
  return { ...h, project };
}

describe("old ticket keys after a project rename", () => {
  test("ticketDetail by old key returns the ticket with its current key and resolvedFrom", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "one", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    const d = h.orch.ticketDetail("old-1");
    expect(d.ticket.id).toBe(t.id);
    expect(d.ticket.key).toBe("NEW-1");
    expect(d.resolvedFrom).toBe("OLD-1");
    expect(h.orch.ticketDetail("NEW-1").resolvedFrom).toBeUndefined();
    // Mutating routes take the old key too.
    const patched = await h.orch.updateTicket("OLD-1", { title: "renamed title" });
    expect(patched.title).toBe("renamed title");
  });

  test("dependsOn with an old key is stored as the current key; self-dependency via old key is refused", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, prompt: "a", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    const b = await h.orch.createTicket({ projectId: h.project.id, prompt: "b", start: false, dependsOn: ["OLD-1"] });
    expect(b.dependsOn).toEqual(["NEW-1"]);
    expect(h.orch.ticketDetail("NEW-1").dependents).toEqual([b.key]);
    await expect(h.orch.updateTicket(a.key, { dependsOn: ["OLD-1"] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "c", dependsOn: ["OLD-9"] })).rejects.toMatchObject({ status: 400 });
    await h.orch.idle();
  });

  test("deleting a ticket by its old key works, and the old key then 404s", async () => {
    const h = setup();
    await h.orch.createTicket({ projectId: h.project.id, prompt: "a", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    await h.orch.deleteTicket("OLD-1");
    expect(() => h.orch.ticketDetail("OLD-1")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => h.orch.ticketDetail("NEW-1")).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("a conductor that learned a child's key before the rename can still drive it", async () => {
    const h = setup();
    let child = "";
    let renamed!: () => void;
    const afterRename = new Promise<void>((r) => (renamed = r));
    const seen: Record<string, unknown> = {};
    h.driver.script = async function* (req) {
      if (req.kind !== "conductor" || child) return;
      const ops = req.toolContext.ops;
      child = (await ops.createTicket(req.toolContext, { title: "child", description: "child", autoStart: false })).key;
      await afterRename;
      seen.get = (await ops.getTicket(req.toolContext, child)).ticket.key;
      await ops.messageTicket(req.toolContext, child, "hello from the conductor");
      seen.sibling = (await ops.createTicket(req.toolContext, { title: "next", description: "next", dependsOn: [child], autoStart: false })).dependsOn;
      seen.start = (await ops.startTicket(req.toolContext, child)).key;
    };
    await h.orch.createTicket({ projectId: h.project.id, prompt: "go", kind: "conductor" });
    while (!child) await Bun.sleep(2);
    expect(child).toBe("OLD-2");
    h.orch.updateProject(h.project.id, { key: "NEW" });
    renamed();
    await h.orch.idle(20_000);
    expect(seen).toEqual({ get: "NEW-2", sibling: ["NEW-2"], start: "NEW-2" });
    expect(h.driver.calls.some((c) => c.prompt === "hello from the conductor")).toBe(true);
  });

  test("triage for an item carrying an old key updates the renamed ticket instead of creating a duplicate", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "a", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    h.orch.createMapping({ pattern: "OLD", projectId: h.project.id });
    const s = await h.orch.injectOutput("jira", { key: "OLD-1", summary: "follow-up", updated: "1" });
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).outcome).toBe("Sent update to existing NEW-1");
    expect(h.orch.listTickets().map((x) => x.id)).toEqual([t.id]);
  });
});
