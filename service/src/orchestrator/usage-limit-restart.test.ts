import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeOrchestrator } from "../testing/fakes";
import { RESUME_GRACE_MS } from "./usage-limit";

const RESET = 1_791_230_400_000; // what the limit message names (epoch form, so no zone math here)
const LIMIT = `Claude AI usage limit reached|${RESET / 1000}`;

function setup() {
  let now = RESET - 10 * 60_000;
  const h = makeOrchestrator({ now: () => now });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  return { ...h, project, setNow: (ms: number) => (now = ms) };
}

describe("usage-limit restarts", () => {
  test("a run stopped by a usage limit blocks until 5 minutes after the reset, then restarts", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: `/fail ${LIMIT}` });
    await h.orch.idle();
    let d = h.orch.ticketDetail(t.key).ticket;
    expect(d.status).toBe("blocked");
    expect(d.blockedReason).toBe(LIMIT);
    expect(d.resumeAt).toBe(RESET + RESUME_GRACE_MS);
    expect(h.orch.activity(t.key).at(-1)!.body).toMatch(/^Run failed: .+ Restarts on its own at \d{1,2}:\d{2} [AP]M\.$/);

    // A minute before: nothing yet.
    h.setNow(RESET + RESUME_GRACE_MS - 60_000);
    await h.orch.resumeDue();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked");
    expect(h.store.runs.listBySession(t.sessionId)).toHaveLength(1);

    // Due: it restarts as a work run. The fake fails it on the same limit again, whose reset has
    // passed now, so the next try is 5 minutes from now.
    const later = RESET + RESUME_GRACE_MS + 1;
    h.setNow(later);
    await h.orch.resumeDue();
    await h.orch.idle();
    expect(h.store.runs.listBySession(t.sessionId).map((r) => `${r.kind}:${r.status}`)).toEqual(["work:failed", "work:failed"]);
    // Out of Blocked: the restart carries on the failed run's conversation.
    expect(h.driver.calls.map((c) => c.state)).toEqual([null, { turns: 1 }]);
    expect(h.orch.activity(t.key).map((a) => a.body)).toContain("Restarted after the usage limit reset");
    d = h.orch.ticketDetail(t.key).ticket;
    expect(d.status).toBe("blocked");
    expect(d.resumeAt).toBe(later + RESUME_GRACE_MS);
  });

  test("any other failure blocks without a restart", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "/fail disk full" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.resumeAt).toBeNull();
    expect(h.orch.activity(t.key).at(-1)!.body).toBe("Run failed: disk full");
  });

  test("moving the ticket drops the restart", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: `/fail ${LIMIT}` });
    await h.orch.idle();
    await h.orch.updateTicket(t.key, { status: "planning" });
    expect(h.orch.ticketDetail(t.key).ticket.resumeAt).toBeNull();
    h.setNow(RESET + RESUME_GRACE_MS + 1);
    await h.orch.resumeDue();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("planning");
    expect(h.store.runs.listBySession(t.sessionId)).toHaveLength(1);
  });
});
