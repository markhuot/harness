// Sub-agents (DESIGN.md "Sub-agents"): the driver's "subagent" events become Subagent records,
// their output goes to their own transcript, and a run's unfinished sub-agents stop with it.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Subagent } from "@harness/shared";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { Store } from "../store";
import { openDb } from "../db";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";

function setup(script: (req: RunRequest) => AsyncGenerator<DriverEvent>) {
  const driver = new FakeDriver();
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  driver.script = (req) => (req.kind === "work" ? script(req) : (async function* () {})());
  const upserts: Subagent[] = [];
  h.bus.onKind("subagent.upserted", (e) => upserts.push(e.subagent));
  const run = async (prompt = "do it") => {
    const t = await h.orch.createTicket({ projectId: project.id, prompt });
    await h.orch.idle();
    return t;
  };
  return { ...h, upserts, run };
}

const texts = (entries: { content: { type: string; text?: string } }[]) => entries.filter((e) => e.content.type === "text").map((e) => e.content.text);

describe("sub-agents", () => {
  test("a sub-agent's output lands in its own transcript, and the ticket's run keeps its own last word", async () => {
    const h = setup(async function* () {
      yield { type: "text", text: "Delegating." };
      yield { type: "tool_call", callId: "ag1", name: "Agent", input: { description: "Scan", prompt: "Scan the repo" } };
      yield { type: "subagent", subagent: { id: "ag1", description: "Scan", agentType: "Explore", prompt: "Scan the repo", status: "running" } };
      yield { type: "tool_call", callId: "b1", name: "Bash", input: { command: "ls" }, subagentId: "ag1" };
      yield { type: "tool_result", callId: "b1", name: "Bash", result: { content: [{ type: "text", text: "a b" }] }, subagentId: "ag1" };
      yield { type: "text", text: "Found a and b.", subagentId: "ag1" };
      yield { type: "tool_result", callId: "ag1", name: "Agent", result: { content: [{ type: "text", text: "Found a and b." }] } };
      yield { type: "subagent", subagent: { id: "ag1", status: "succeeded", result: "Found a and b." } };
      yield { type: "text", text: "The agent found two files." };
      yield { type: "text", text: "Sub-agent's late note", subagentId: "ag1" };
    });
    const t = await h.run();

    const main = h.orch.transcript(t.sessionId);
    expect(texts(main).slice(0, 3)).toEqual(["do it", "Delegating.", "The agent found two files."]);
    expect(texts(main).some((x) => x?.includes("Found a and b") || x?.includes("late note"))).toBe(false);
    expect(main.every((e) => e.subagentId === null)).toBe(true);
    const sub = h.orch.transcript(t.sessionId, 0, "ag1");
    expect(sub.map((e) => e.content.type)).toEqual(["tool_call", "tool_result", "text", "text"]);
    expect(sub.every((e) => e.subagentId === "ag1")).toBe(true);
    // Paging by seq works inside a sub-agent's view too.
    expect(h.orch.transcript(t.sessionId, sub[1]!.seq, "ag1").map((e) => e.id)).toEqual([sub[2]!.id, sub[3]!.id]);

    // Auto-submit uses the agent's last text, not the sub-agent's.
    expect(h.orch.summaries(t.key).at(-1)?.body).toBe("The agent found two files.");

    const [agent] = h.orch.ticketDetail(t.key).subagents!;
    expect(agent).toMatchObject({ id: "ag1", sessionId: t.sessionId, parentId: null, description: "Scan", agentType: "Explore", prompt: "Scan the repo", status: "succeeded", result: "Found a and b." });
    expect(agent!.endedAt).not.toBeNull();
    expect(h.upserts.map((s) => s.status)).toEqual(["running", "succeeded"]);
    expect(h.orch.subagents(t.sessionId)).toEqual([agent!]);
  });

  test("sub-agents still running when the run ends are stopped with it", async () => {
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "bg", description: "Background", status: "running" } };
      yield { type: "subagent", subagent: { id: "done", description: "Quick", status: "running" } };
      yield { type: "subagent", subagent: { id: "done", status: "failed", result: "nope" } };
      yield { type: "text", text: "Ended without waiting." };
    });
    const t = await h.run();
    const byId = Object.fromEntries(h.orch.subagents(t.sessionId).map((s) => [s.id, s]));
    expect(byId.bg!.status).toBe("stopped");
    expect(byId.bg!.endedAt).not.toBeNull();
    expect(byId.done).toMatchObject({ status: "failed", result: "nope" });
    // The stop was broadcast; the already-failed one wasn't touched again.
    expect(h.upserts.filter((s) => s.id === "done").map((s) => s.status)).toEqual(["running", "failed"]);
    expect(h.upserts.at(-1)).toMatchObject({ id: "bg", status: "stopped" });
  });

  test("a cancelled run stops its sub-agents", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "long", description: "Long", status: "running" } };
      await gate;
    });
    const t = await h.orch.createTicket({ projectId: h.orch.listProjects()[0]!.id, prompt: "go" });
    while (!h.orch.subagents(t.sessionId).length) await Bun.sleep(5);
    await h.orch.cancelTicket(t.key);
    release();
    await h.orch.idle();
    expect(h.orch.subagents(t.sessionId).map((s) => s.status)).toEqual(["stopped"]);
  });

  test("the transcript of an unknown sub-agent is a 404", async () => {
    const h = setup(async function* () {
      yield { type: "text", text: "hi" };
    });
    const t = await h.run();
    expect(() => h.orch.transcript(t.sessionId, 0, "nope")).toThrow(/Unknown sub-agent/);
  });

  test("the board's get_ticket transcript tail leaves sub-agent output out", async () => {
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "s", description: "S" } };
      yield { type: "text", text: "sub text", subagentId: "s" };
      yield { type: "text", text: "main text" };
    });
    const t = await h.run();
    const detail = await h.orch.ops.getTicket({} as never, t.key, { transcript: 20 });
    const lines = detail.transcript!.map((l) => l.text);
    expect(lines).toContain("main text");
    expect(lines).not.toContain("sub text");
  });

  test("deleting the ticket deletes its sub-agents", async () => {
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "s", description: "S", status: "succeeded" } };
    });
    const t = await h.run();
    await h.orch.deleteTicket(t.key);
    expect(h.store.subagents.listBySession(t.sessionId)).toEqual([]);
  });
});

describe("SubagentRepo.upsert", () => {
  const repo = () => {
    const store = new Store(openDb(":memory:"));
    store.db.query("INSERT INTO sessions (id, key, kind, driver, cwd, created_at, updated_at) VALUES ('s1', 'K-1', 'ticket', 'fake', '/', 0, 0)").run();
    return store.subagents;
  };

  test("fills in fields later reports carry, and reports no-ops as null", () => {
    const r = repo();
    const a = r.upsert("s1", "run1", { id: "a", description: "Sub-agent" })!;
    expect(a).toMatchObject({ status: "running", description: "Sub-agent", agentType: null, prompt: "", runId: "run1", endedAt: null });
    const b = r.upsert("s1", "run1", { id: "a", description: "Scan", agentType: "Explore", prompt: "p" })!;
    expect(b).toMatchObject({ description: "Scan", agentType: "Explore", prompt: "p", status: "running" });
    expect(r.upsert("s1", "run1", { id: "a", description: "Scan" })).toBeNull();
    // An empty description doesn't wipe a known one.
    expect(r.upsert("s1", "run1", { id: "a", description: "" })).toBeNull();
  });

  test("a finished sub-agent stays finished; the first outcome's result is kept", () => {
    const r = repo();
    r.upsert("s1", "run1", { id: "a", status: "running" });
    const done = r.upsert("s1", "run1", { id: "a", status: "succeeded", result: "first" })!;
    expect(done.endedAt).not.toBeNull();
    expect(r.upsert("s1", "run1", { id: "a", status: "running" })).toBeNull();
    expect(r.upsert("s1", "run1", { id: "a", status: "failed", result: "second" })).toBeNull();
    expect(r.get("s1", "a")).toMatchObject({ status: "succeeded", result: "first" });
  });

  test("a result arriving after a finish without one is kept (task_notification after the status)", () => {
    const r = repo();
    r.upsert("s1", "run1", { id: "a" });
    r.upsert("s1", "run1", { id: "a", status: "stopped" });
    expect(r.upsert("s1", "run1", { id: "a", status: "succeeded", result: "late report" })).toMatchObject({ status: "stopped", result: "late report" });
  });

  test("stopRunning only touches the run's running sub-agents", () => {
    const r = repo();
    r.upsert("s1", "run1", { id: "a" });
    r.upsert("s1", "run1", { id: "b", status: "succeeded" });
    r.upsert("s1", "run2", { id: "c" });
    expect(r.stopRunning("run1").map((s) => [s.id, s.status])).toEqual([["a", "stopped"]]);
    expect(r.listBySession("s1").map((s) => [s.id, s.status])).toEqual([
      ["a", "stopped"],
      ["b", "succeeded"],
      ["c", "running"],
    ]);
  });
});

test("service restart: a stale run's sub-agents are stopped", async () => {
  const h = setup(async function* () {
    yield { type: "text", text: "x" };
  });
  const t = await h.run();
  const run = h.store.runs.create({ sessionId: t.sessionId, kind: "work", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(run.id);
  h.store.subagents.upsert(t.sessionId, run.id, { id: "orphan" });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  h.orch.recoverStaleRuns();
  expect(h.store.subagents.get(t.sessionId, "orphan")!.status).toBe("stopped");
  expect(events.some((e) => e.kind === "subagent.upserted" && e.subagent.id === "orphan")).toBe(true);
});
