// Every way a ticket leaves review is recorded in Activity as a review decision, so the
// notification dispatcher (and the human reading Activity) sees who decided what.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";

function setup(driver = new FakeDriver()) {
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const decisions = (key: string) =>
    h.orch
      .activity(key)
      .filter((a) => a.kind === "review_approved" || a.kind === "changes_requested" || a.kind === "approved")
      .map((a) => ({ kind: a.kind, author: a.author, by: a.meta.by ?? null }));
  return { ...h, project, decisions };
}

describe("review decisions in Activity", () => {
  test("the agent reviewer's approval, then the human's", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    expect(h.decisions(t.key)).toEqual([{ kind: "review_approved", author: "agent", by: "agent" }]);
    await h.orch.humanReview(t.key, { decision: "approve", notes: "Ship it" });
    await h.orch.idle();
    expect(h.decisions(t.key)).toEqual([
      { kind: "review_approved", author: "agent", by: "agent" },
      { kind: "approved", author: "human", by: "human" },
    ]);
  });

  test("the agent reviewer's and the human's requested changes", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 1;
    const h = setup(driver);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    await h.orch.humanReview(t.key, { decision: "request_changes", notes: "Rename it" });
    await h.orch.idle();
    expect(h.decisions(t.key)).toEqual([
      { kind: "changes_requested", author: "agent", by: "agent" },
      { kind: "review_approved", author: "agent", by: "agent" },
      { kind: "changes_requested", author: "human", by: "human" },
      { kind: "review_approved", author: "agent", by: "agent" },
    ]);
  });

  test("approve and take no action records the human's approval and the move to done once", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    const approval = h.orch.activity(t.key).filter((a) => a.kind === "approved");
    expect(approval).toEqual([expect.objectContaining({ author: "human", body: "Approved, no action taken", meta: expect.objectContaining({ by: "human", from: "review", to: "done" }) })]);
    expect(h.orch.activity(t.key).filter((a) => a.meta.to === "done")).toHaveLength(1);
  });

  test("a ticket that skips its human review records that it was approved without one", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go", skipHumanReview: true });
    await h.orch.idle();
    expect(h.decisions(t.key)).toEqual([
      { kind: "review_approved", author: "agent", by: "agent" },
      { kind: "approved", author: "system", by: null },
    ]);
    expect(h.orch.activity(t.key).find((a) => a.kind === "approved")?.body).toBe("Human review skipped: completing automatically");
  });

  test("turning skip-human-review on while a ticket waits in review records it too", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    await h.orch.updateTicket(t.key, { skipHumanReview: true });
    await h.orch.idle();
    expect(h.decisions(t.key).at(-1)).toEqual({ kind: "approved", author: "system", by: null });
  });

  test("a conductor's approval of its child is recorded as the conductor's", async () => {
    const h = setup();
    const c = await h.orch.createTicket({ projectId: h.project.id, spec: "Split it\n- Only child", kind: "conductor" });
    await h.orch.idle(20_000);
    const [child] = h.orch.ticketDetail(c.key).children;
    expect(child?.status).toBe("done");
    expect(h.decisions(child!.key)).toEqual([
      { kind: "review_approved", author: "agent", by: "agent" },
      { kind: "approved", author: "agent", by: "conductor" },
    ]);
  });
});
