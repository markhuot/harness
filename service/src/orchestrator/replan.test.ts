import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "@harness/shared";
import { toolsForRun } from "../tools";
import { replanPrompt } from "./prompts";
import { makeOrchestrator } from "../testing/fakes";

// Phase handoffs (HARNESS-409): Opus plans and reviews, Sonnet works. An agent that sends its own
// ticket back to planning ends its run; the Plan run follows on the Plan model.

function setup() {
  const h = makeOrchestrator({});
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const fake = (model: string) => ({ driver: "fake", model });
  h.orch.updateSettings({ phaseModels: { plan: fake("opus"), work: fake("sonnet"), review: fake("opus") } });
  return { ...h, project };
}
type H = ReturnType<typeof setup>;

const runKinds = (h: H, t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => `${r.kind}:${r.status}`);
const calls = (h: H) => h.driver.calls.map((c) => `${c.kind}:${c.model}`);
const cur = (h: H, t: Ticket) => h.orch.ticketDetail(t.key).ticket;
const lines = (h: H, t: Ticket) => h.orch.activity(t.key).map((e) => e.body);

/** A ticket the work run blocked on a question: the human's next message is a chat on the Work model. */
async function blocked(h: H, extra: { dependsOn?: string[] } = {}) {
  const t = await h.orch.createTicket({ projectId: h.project.id, title: "Add a button", spec: "Add a button /block Which color?", ...extra });
  await h.orch.idle();
  expect(cur(h, t).status).toBe("blocked");
  return t;
}

describe("review comments go to the Work model", () => {
  test("a chat in review runs on Work; resume_work keeps it there, and the re-review is Opus again", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    expect(cur(h, t)).toMatchObject({ status: "review", agentReview: "approved" });
    await h.orch.sendMessage(t.key, "also make it red /resume");
    await h.orch.idle();
    expect(calls(h)).toEqual(["work:sonnet", "review:opus", "chat:sonnet", "review:opus"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded", "review:succeeded"]);
  });
});

describe("return_to_planning", () => {
  test("a blocked work chat hands off to a Plan run on the Plan model; Start resumes work on the Work model", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "let's rethink this /replan");
    await h.orch.idle();
    expect(calls(h)).toEqual(["work:sonnet", "chat:sonnet", "plan:opus"]);
    const plan = h.driver.calls.at(-1)!;
    expect(plan.state).toBeNull(); // a fresh conversation, not the Sonnet chat's
    expect(plan.prompt).toContain("needs a new approach");
    expect(plan.prompt).toContain("let's rethink this /replan"); // the human's message that started the chat
    expect(plan.prompt).toContain("re-plan");
    expect(cur(h, t)).toMatchObject({ status: "planning", busy: false, startAfterPlan: false, blockedReason: null, agentReview: "pending", humanReview: "pending" });
    expect(lines(h, t)).toContain("Moved back to planning by the agent: needs a new approach");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "chat:succeeded", "plan:succeeded"]);

    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(calls(h).slice(3)).toEqual(["work:sonnet", "review:opus"]);
    expect(cur(h, t).status).toBe("review");
  });

  test("the Plan run is a new conversation even though the card left Blocked", async () => {
    const h = setup();
    const t = await blocked(h);
    expect(h.store.sessions.getDriverState(t.sessionId)).not.toBeNull(); // the blocked work run's conversation
    await h.orch.sendMessage(t.key, "again /replan");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "plan").map((c) => c.state)).toEqual([null]);
  });

  test("a work run can hand off too, and doesn't submit or block itself afterwards", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button /replan" });
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "plan:succeeded"]);
    expect(cur(h, t).status).toBe("planning");
  });

  test("start_after_plan: work starts on the Work model when the Plan run ends, never before", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "rethink it, no need to review /replan-auto");
    await h.orch.idle();
    expect(calls(h)).toEqual(["work:sonnet", "chat:sonnet", "plan:opus", "work:sonnet", "review:opus"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "chat:succeeded", "plan:succeeded", "work:succeeded", "review:succeeded"]);
    const l = lines(h, t);
    expect(l).toContain("Plan approved; work starts when planning finishes");
    expect(h.orch.activity(t.key).find((e) => e.body === "Plan approved; work starts when planning finishes")!.author).toBe("agent");
    expect(cur(h, t)).toMatchObject({ status: "review", startAfterPlan: false });
  });

  test("a failed Plan run clears the approval and starts nothing", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "go /replan-fail");
    await h.orch.idle();
    expect(calls(h)).toEqual(["work:sonnet", "chat:sonnet", "plan:opus"]);
    expect(runKinds(h, t).at(-1)).toBe("plan:failed");
    expect(cur(h, t)).toMatchObject({ status: "planning", startAfterPlan: false });
    expect(lines(h, t)).toContain("Planning run failed; work not started");
  });

  test("a message during the Plan run withdraws the approval", async () => {
    const h = setup();
    const t = await blocked(h);
    // The plan run only holds when its prompt says so: the human's message rides along in it.
    await h.orch.sendMessage(t.key, "go /replan-auto /hold");
    while (h.driver.holding === 0) await Bun.sleep(1);
    h.driver.release(); // the chat ends and replans; the plan prompt carries /hold too
    while (h.driver.holding === 0) await Bun.sleep(1);
    expect(cur(h, t)).toMatchObject({ status: "planning", startAfterPlan: true, busy: true });
    await h.orch.sendMessage(t.key, "wait, one more thing");
    expect(cur(h, t).startAfterPlan).toBe(false);
    while (!h.orch.isIdle()) {
      h.driver.release();
      await Bun.sleep(2);
    }
    await h.orch.idle();
    expect(cur(h, t).status).toBe("planning");
    expect(h.driver.calls.filter((c) => c.kind === "work")).toHaveLength(1);
  });

  test("without start_after_plan a child whose dependencies are done waits in Planning", async () => {
    const h = setup();
    const dep = await h.orch.createTicket({ projectId: h.project.id, spec: "dep", start: false });
    const t = await blocked(h);
    h.store.tickets.update(t.id, { autoStart: true });
    expect(cur(h, t).autoStart).toBe(true);
    await h.orch.sendMessage(t.key, "rethink /replan");
    await h.orch.idle();
    expect(cur(h, t)).toMatchObject({ status: "planning", autoStart: false });
    expect(h.driver.calls.filter((c) => c.kind === "work")).toHaveLength(1);
    expect(dep.status).toBe("planning");
  });

  test("from Review it stops a queued review run and resets both reviews", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "rethink /hold /replan");
    await Bun.sleep(5);
    h.orch.rerunAgentReview(t.key); // queued behind the chat
    while (!h.orch.isIdle()) {
      h.driver.release(); // the Plan run's prompt carries the chat's /hold too
      await Bun.sleep(2);
    }
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded", "review:cancelled", "plan:succeeded"]);
    expect(cur(h, t)).toMatchObject({ status: "planning", agentReview: "pending", humanReview: "pending" });
  });

  test("from Done it hands off too", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(cur(h, t).status).toBe("done");
    await h.orch.sendMessage(t.key, "new approach /replan");
    await h.orch.idle();
    expect(cur(h, t).status).toBe("planning");
    expect(calls(h).at(-1)).toBe("plan:opus");
  });

  test("refused for a ticket already in Planning, and for an empty reason", async () => {
    const h = setup();
    const t = await blocked(h);
    await h.orch.sendMessage(t.key, "rethink /replan");
    await h.orch.idle();
    const planning = cur(h, t);
    const ctx = { ticket: planning, session: h.store.sessions.get(planning.sessionId)!, runKind: "chat", runId: "x", cwd: "/", ops: (h.orch as any).opsFacade } as any;
    await expect(h.orch.returnToPlanning(ctx, "again", false)).rejects.toThrow(/already in planning/);
    const t2 = await blocked(h);
    const ctx2 = { ...ctx, ticket: cur(h, t2), session: h.store.sessions.get(t2.sessionId)!, runKind: "chat" };
    await expect(h.orch.returnToPlanning(ctx2, "  ", false)).rejects.toThrow(/reason is empty/);
    expect(cur(h, t2).status).toBe("blocked");
  });

  test("plan, review and complete runs don't get the tool; work, conductor and chat do", () => {
    const names = (kind: Parameters<typeof toolsForRun>[0], ticketKind: "task" | "conductor" = "task") =>
      toolsForRun(kind, { hasBuiltinTools: true, usesPermissionPromptTool: false }, { kind: ticketKind }).map((d) => d.name);
    for (const kind of ["work", "conductor", "chat"] as const) expect(names(kind)).toContain("return_to_planning");
    for (const kind of ["plan", "review", "complete", "triage"] as const) expect(names(kind)).not.toContain("return_to_planning");
  });
});

describe("replanPrompt", () => {
  const ticket = { key: "ACME-1", title: "Add a button", specRevision: 4, branch: "harness/acme-1" } as Ticket;

  test("carries the reason and the human's message, and points a started ticket's planner at its branch", () => {
    const p = replanPrompt(ticket, " the API can't do X ", "just use polling", false);
    expect(p).toContain('ACME-1 "Add a button" is going back to planning');
    expect(p).toContain("## Why\nthe API can't do X");
    expect(p).toContain("## The human's latest message\njust use polling");
    expect(p).toContain("revision 4");
    expect(p).toContain("`harness/acme-1`");
    expect(p).toContain("pressing Start");
    expect(p).not.toContain("starts on its own");
  });

  test("leaves out what isn't there, and says the work starts on its own when the re-plan is approved", () => {
    const p = replanPrompt({ ...ticket, branch: null } as Ticket, "why", "", true);
    expect(p).not.toContain("latest message");
    expect(p).not.toContain("git log");
    expect(p).toContain("starts on its own");
    expect(p).not.toContain("pressing Start");
  });
});
