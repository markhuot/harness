// HARNESS-68: a human message sent while the ticket's agent is working goes into that run
// (steering); it waits for a run of its own only when the running agent can't take it in.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "@harness/shared";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { STEER_FALLBACK_STATUS } from "./orchestrator";

function setup(steering = true) {
  const driver = new FakeDriver();
  driver.supportsSteering = steering;
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  return { ...h, project };
}
type H = ReturnType<typeof setup>;

const runs = (h: H, t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => `${r.kind}:${r.status}`);
const entries = (h: H, t: Ticket) => h.store.transcript.list(t.sessionId);
const userTexts = (h: H, t: Ticket) => entries(h, t).filter((e) => e.role === "user").map((e) => (e.content as { text: string }).text);
const statuses = (h: H, t: Ticket) => entries(h, t).filter((e) => e.content.type === "status").map((e) => (e.content as { text: string }).text);
const texts = (h: H, t: Ticket) => entries(h, t).filter((e) => e.role === "assistant" && e.content.type === "text").map((e) => (e.content as { text: string }).text);

async function untilHolding(h: H) {
  const start = Date.now();
  while (h.driver.holding === 0) {
    if (Date.now() - start > 2000) throw new Error("the run never reached /hold");
    await Bun.sleep(1);
  }
}

describe("steering a running agent", () => {
  test("a message to an in-progress ticket goes into the running work run, not a new run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /nosubmit" });
    await untilHolding(h);
    const [active] = h.store.runs.listBySession(t.sessionId);
    await h.orch.sendMessage(t.key, "Stop and write HELLO.md instead");
    expect(runs(h, t)).toEqual(["work:running"]);
    // In the transcript right away, as part of the run that's going.
    const entry = entries(h, t).find((e) => e.role === "user" && (e.content as { text: string }).text === "Stop and write HELLO.md instead");
    expect(entry?.runId).toBe(active!.id);

    h.driver.release();
    await h.orch.idle();
    expect(texts(h, t)).toContain("Steered: Stop and write HELLO.md instead");
    expect(h.driver.calls.map((c) => c.kind)).toEqual(["work", "review"]);
    expect(runs(h, t)).toEqual(["work:succeeded", "review:succeeded"]);
    expect(statuses(h, t)).not.toContain(STEER_FALLBACK_STATUS);
  });

  test("a message to a planning ticket steers its plan run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Plan the thing /hold", start: false });
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "Keep it to three steps");
    h.driver.release();
    await h.orch.idle();
    expect(runs(h, t)).toEqual(["plan:succeeded"]);
    expect(texts(h, t)).toContain("Steered: Keep it to three steps");
    expect(h.store.tickets.getByKey(t.key)!.status).toBe("planning");
  });

  test("a driver that can't steer queues the message behind the run, with a note", async () => {
    const h = setup(false);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /nosubmit" });
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "second /nosubmit");
    expect(runs(h, t)).toEqual(["work:running", "work:queued"]);
    expect(statuses(h, t)).toContain(STEER_FALLBACK_STATUS);
    h.driver.release();
    await h.orch.idle();
    expect(h.driver.calls[1]!.prompt).toBe("second /nosubmit");
    expect(userTexts(h, t).filter((x) => x === "second /nosubmit")).toHaveLength(1);
  });

  test("a message the run ended without taking in becomes one queued run, shown once", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /deaf /nosubmit" });
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "Also update the README");
    expect(runs(h, t)).toEqual(["work:running"]);
    h.driver.release();
    await h.orch.idle();
    // The first run's end didn't auto-submit: the message's run was already waiting.
    expect(h.driver.calls[1]!.prompt).toBe("Also update the README");
    expect(runs(h, t).slice(0, 2)).toEqual(["work:succeeded", "work:succeeded"]);
    expect(userTexts(h, t).filter((x) => x === "Also update the README")).toHaveLength(1);
    expect(statuses(h, t).filter((s) => s === STEER_FALLBACK_STATUS)).toHaveLength(1);
  });

  test("cancelling the run drops a message it never took in, like the rest of the queue", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Build it /hold /deaf" });
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "Never mind");
    await h.orch.cancelTicket(t.key);
    await h.orch.idle();
    expect(runs(h, t)).toEqual(["work:cancelled"]);
    expect(statuses(h, t)).not.toContain(STEER_FALLBACK_STATUS);
  });

  test("a message to a blocked ticket steers its running chat, with the unblock note for the agent", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "hmm /hold");
    await untilHolding(h);
    await h.orch.sendMessage(t.key, "Postgres");
    expect(runs(h, t)).toEqual(["work:succeeded", "chat:running"]);
    h.driver.release();
    await h.orch.idle();
    expect(runs(h, t)).toEqual(["work:succeeded", "chat:succeeded"]);
    // The agent read the note; the transcript has only the human's words.
    expect(texts(h, t)).toContain("Steered: Postgres\n\n[Harness note: this ticket is blocked on: Which database?. If this message resolves that, call unblock before you continue the work; if it doesn't, answer and leave the ticket blocked.]");
    expect(userTexts(h, t)).toContain("Postgres");
    expect(userTexts(h, t).some((u) => u.includes("[Harness note"))).toBe(false);
  });

  test("once a chat has unblocked the ticket, a message to it (now in progress) still reaches that chat", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "Postgres /hold");
    await untilHolding(h);
    h.store.tickets.update(t.id, { status: "in_progress", blockedReason: null }); // as unblock does
    await h.orch.sendMessage(t.key, "and add an index");
    expect(runs(h, t)).toEqual(["work:succeeded", "chat:running"]);
    h.driver.release();
    await h.orch.idle();
    // No blocked note once it's in progress, and no second run.
    expect(texts(h, t)).toContain("Steered: and add an index");
    expect(runs(h, t)).toEqual(["work:succeeded", "chat:succeeded", "review:succeeded"]);
  });
});
