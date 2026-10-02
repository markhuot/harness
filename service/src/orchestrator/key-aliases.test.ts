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
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "one", start: false });
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
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "a", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "b", start: false, dependsOn: ["OLD-1"] });
    expect(b.dependsOn).toEqual(["NEW-1"]);
    expect(h.orch.ticketDetail("NEW-1").dependents).toEqual([b.key]);
    await expect(h.orch.updateTicket(a.key, { dependsOn: ["OLD-1"] })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "c", dependsOn: ["OLD-9"] })).rejects.toMatchObject({ status: 400 });
    await h.orch.idle();
  });

  test("deleting a ticket by its old key works, and the old key then 404s", async () => {
    const h = setup();
    await h.orch.createTicket({ projectId: h.project.id, spec: "a", start: false });
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
      child = (await ops.createTicket(req.toolContext, { title: "child", spec: "child", autoStart: false })).key;
      await afterRename;
      seen.get = (await ops.getTicket(req.toolContext, child)).ticket.key;
      await ops.messageTicket(req.toolContext, child, "hello from the conductor");
      seen.sibling = (await ops.createTicket(req.toolContext, { title: "next", spec: "next", dependsOn: [child], autoStart: false })).dependsOn;
      seen.start = (await ops.startTicket(req.toolContext, child)).key;
    };
    await h.orch.createTicket({ projectId: h.project.id, spec: "go", kind: "conductor" });
    while (!child) await Bun.sleep(2);
    expect(child).toBe("OLD-2");
    h.orch.updateProject(h.project.id, { key: "NEW" });
    renamed();
    await h.orch.idle(20_000);
    expect(seen).toEqual({ get: "NEW-2", sibling: ["NEW-2"], start: "NEW-2" });
    expect(h.driver.calls.some((c) => c.prompt === "hello from the conductor")).toBe(true);
  });

  test("triage sends an update to a renamed ticket by its old key only as ticket_key; the old key alone as key makes a new linked ticket", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "a", start: false });
    await h.orch.idle();
    h.orch.updateProject(h.project.id, { key: "NEW" });
    const routed = await h.orch.injectOutput("jira", { key: "OLD-1", summary: "follow-up", updated: "1" }, "Dispatch follow-ups. [dummy:project NEW] [dummy:ticket OLD-1]");
    await h.orch.idle();
    // ticket_key resolves through the alias, and the output's key links the unlinked ticket.
    expect(h.orch.getSession(routed!.id).outcome).toBe("Linked NEW-1 to OLD-1 and sent update");
    expect(h.orch.listTickets().map((x) => x.id)).toEqual([t.id]);
    expect(h.store.tickets.get(t.id)!.externalRef).toMatchObject({ source: "jira", key: "OLD-1" });

    const fresh = await h.orch.injectOutput("jira", { key: "OLD-1", summary: "another", updated: "2" }, "Dispatch follow-ups. [dummy:project NEW]");
    await h.orch.idle();
    const created = h.orch.listTickets().find((x) => x.id !== t.id)!;
    expect(h.orch.getSession(fresh!.id).outcome).toBe(`Dispatched to ${created.key} (OLD-1) in NEW`);
    expect(created.key).toBe("NEW-2");
    expect(created.externalRef?.key).toBe("OLD-1");
  });
});
