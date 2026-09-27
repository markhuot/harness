// Claude Code auto-mode classifier denials (DriverEvent permission_denied) become approval cards,
// and human grants reach the driver as RunRequest.grants (DESIGN.md "Permissions").

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { grantKey } from "../store/tickets";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { MAX_AUTO_RETRIES } from "./orchestrator";

const CALL = { command: "npx -y harness-check-pkg init", description: "Scaffold the project" };
const REASON = "[Code from External]";

interface Sim {
  /** What the agent does after its call was denied */
  after: "none" | "block" | "submit";
  /** The CLI denies the call even with its exact rule (a rule the CLI doesn't match) */
  ruleIgnored: boolean;
  /** Each run tries a different command (never granted) */
  freshCommands: boolean;
}

/**
 * A driver that behaves like claude-code in auto mode: the call runs only if an exact one-time
 * grant for it was passed (bare "Bash" is ignored by the CLI's auto mode) or, for a viaPrompt
 * grant, if the prompt tool (requestApproval) allows it. Otherwise the classifier denies it.
 */
function setup(sim: Partial<Sim> = {}) {
  const s: Sim = { after: "none", ruleIgnored: false, freshCommands: false, ...sim };
  const driver = new FakeDriver();
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  let n = 0;
  driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
    if (req.kind !== "work" && req.kind !== "complete") return;
    if (req.prompt.includes("The human denied")) {
      yield { type: "text", text: "Did it another way." };
      return;
    }
    const call = s.freshCommands ? { command: `npx -y pkg-${++n} init` } : CALL;
    const ctx = req.toolContext;
    const grant = req.grants?.once.find((g) => grantKey(g.toolName, g.input) === grantKey("Bash", call));
    let ran = false;
    if (grant?.viaPrompt) {
      ran = (await ctx.ops.requestApproval(ctx, "Bash", call)).behavior === "allow";
    } else if (grant) {
      yield { type: "grant_applied", toolName: grant.toolName, input: grant.input };
      ran = !s.ruleIgnored;
    }
    yield { type: "tool_call", callId: "tu1", name: "Bash", input: call };
    if (ran) {
      yield { type: "tool_result", callId: "tu1", name: "Bash", result: { content: [{ type: "text", text: "scaffolded" }] } };
      yield { type: "text", text: "Scaffolded the project." };
      return;
    }
    yield { type: "tool_result", callId: "tu1", name: "Bash", result: { content: [{ type: "text", text: "denied by the Claude Code auto mode classifier" }], isError: true } };
    yield { type: "permission_denied", callId: "tu1", toolName: "Bash", input: call, reason: REASON };
    if (s.after === "block") await ctx.ops.block(ctx, "The classifier denied npx; may I run it?");
    else if (s.after === "submit") await ctx.ops.submitForReview(ctx, "Done without scaffolding.");
    else yield { type: "text", text: "It was denied." };
  };
  return { ...h, project, sim: s };
}

type H = ReturnType<typeof setup>;
const work = (h: H) => h.driver.calls.filter((c) => c.kind === "work");
const ticket = (h: H, key: string) => h.orch.ticketDetail(key).ticket;

async function denied(h: H) {
  const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "scaffold it" });
  await h.orch.idle();
  return t;
}

describe("classifier denials → approval cards", () => {
  test("a run that ends after a denial blocks the ticket with a classifier approval instead of auto-submitting", async () => {
    const h = setup();
    const t = await denied(h);
    const cur = ticket(h, t.key);
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Permission needed: Bash — npx -y harness-check-pkg init");
    expect(cur.pendingApproval).toMatchObject({ toolName: "Bash", input: CALL, reason: REASON, source: "classifier", runId: work(h)[0]!.runId });
    expect(h.store.runs.listBySession(t.sessionId).map((r) => r.kind)).toEqual(["work"]); // no review
    expect(h.orch.summaries(t.key).some((s) => s.author === "system" && s.body.endsWith(`Classifier: ${REASON}`))).toBe(true);
  });

  test("when the agent blocked after the denial, the approval is attached to its block", async () => {
    const h = setup({ after: "block" });
    const t = await denied(h);
    const cur = ticket(h, t.key);
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("The classifier denied npx; may I run it?"); // the agent's question stays
    expect(cur.pendingApproval).toMatchObject({ toolName: "Bash", source: "classifier" });
    const blockedNotes = h.store.transcript
      .list(t.sessionId)
      .filter((e) => e.content.type === "status" && e.content.text.startsWith("Blocked"));
    expect(blockedNotes).toHaveLength(1); // blocked once, not twice
    // one answer resumes it
    const resumed = await h.orch.answerApproval(t.key, { decision: "allow_once" });
    expect([resumed.status, resumed.blockedReason, resumed.pendingApproval]).toEqual(["in_progress", null, null]);
  });

  test("no card when the agent submitted anyway", async () => {
    const h = setup({ after: "submit" });
    const t = await denied(h);
    const cur = ticket(h, t.key);
    expect(cur.status).toBe("review");
    expect(cur.pendingApproval).toBeNull();
  });

  test("allow_once: the resumed run gets exactly that call as a one-time grant, used up by it", async () => {
    const h = setup();
    const t = await denied(h);
    expect(work(h)[0]!.grants).toEqual({ tools: [], once: [] });
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(work(h)[1]!.grants).toEqual({ tools: [], once: [{ toolName: "Bash", input: CALL }] });
    expect(work(h)[1]!.prompt).toBe("The human approved your request to use Bash (npx -y harness-check-pkg init). Retry it now and continue.");
    expect(ticket(h, t.key).status).toBe("review"); // the retry ran and the run auto-submitted
    expect(h.store.tickets.listGrants(t.id)).toEqual([]); // grant_applied consumed it
    // one time only: the next run doesn't get it, so the same call is denied again
    await h.orch.sendMessage(t.key, "scaffold it again");
    await h.orch.idle();
    expect(work(h)[2]!.grants).toEqual({ tools: [], once: [] });
    expect(ticket(h, t.key).pendingApproval).toMatchObject({ toolName: "Bash", source: "classifier" });
  });

  test("allow_tool on a classifier denial: the tool is always allowed and the denied call also gets a one-time grant", async () => {
    const h = setup();
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "allow_tool" });
    await h.orch.idle();
    expect(work(h)[1]!.grants).toEqual({ tools: ["Bash"], once: [{ toolName: "Bash", input: CALL }] });
    expect(ticket(h, t.key).status).toBe("review");
    expect(ticket(h, t.key).allowedTools).toEqual(["Bash"]);
  });

  test("a later denial of a tool the human allows on the ticket is retried with the call pre-approved, no card", async () => {
    const h = setup();
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "allow_tool" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "scaffold once more");
    await h.orch.idle();
    // run 3 was denied (auto mode ignores bare Bash), run 4 retried it with the exact grant
    expect(work(h).map((c) => c.grants?.once.length)).toEqual([0, 1, 0, 1]);
    expect(work(h)[3]!.prompt).toBe(
      "Bash (npx -y harness-check-pkg init) was denied by Claude Code's classifier, but the human allows Bash on this ticket. Retry it now and continue.",
    );
    const cur = ticket(h, t.key);
    expect([cur.status, cur.pendingApproval]).toEqual(["review", null]);
  });

  test(`automatic retries stop after ${MAX_AUTO_RETRIES} in a row; then a human is asked`, async () => {
    const h = setup({ freshCommands: true });
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "allow_tool" });
    await h.orch.idle();
    // the allow_tool run plus MAX_AUTO_RETRIES automatic ones, each denied a new command
    expect(work(h)).toHaveLength(2 + MAX_AUTO_RETRIES);
    expect(ticket(h, t.key).pendingApproval).toMatchObject({ toolName: "Bash", input: { command: `npx -y pkg-${2 + MAX_AUTO_RETRIES} init` } });
  });

  test("an exact rule the CLI still denied: the card comes back, and the next grant goes through the prompt tool", async () => {
    const h = setup({ ruleIgnored: true });
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(ticket(h, t.key).pendingApproval).toMatchObject({ toolName: "Bash", source: "classifier" }); // asked again, no loop
    expect(work(h)).toHaveLength(2);
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(work(h)[2]!.grants!.once).toEqual([{ toolName: "Bash", input: CALL, viaPrompt: true }]);
    expect(ticket(h, t.key).status).toBe("review"); // the prompt tool consumed the grant and allowed it
    expect(h.store.tickets.listGrants(t.id)).toEqual([]);
  });

  test("deny still resumes with the denial and no grant", async () => {
    const h = setup();
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "deny", message: "use the local template" });
    await h.orch.idle();
    expect(work(h)[1]!.prompt).toBe("The human denied Bash (npx -y harness-check-pkg init). use the local template. Find another way or call block if you can't proceed.");
    expect(work(h)[1]!.grants).toEqual({ tools: [], once: [] });
    expect(ticket(h, t.key).status).toBe("review");
  });

  test("a denial during a complete run blocks instead of marking done; allow_once resumes the complete run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle(); // denied → card
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(ticket(h, t.key).status).toBe("review");
    h.store.tickets.update(t.id, { humanReview: "approved", agentReview: "approved" });
    // the complete run hits the same classifier denial again
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    expect(ticket(h, t.key).status).toBe("blocked");
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(ticket(h, t.key).status).toBe("done");
    const complete = h.driver.calls.filter((c) => c.kind === "complete");
    expect(complete.map((c) => c.grants?.once.length)).toEqual([0, 1]);
  });

  test("review runs never get the ticket's grants, and their denials don't open cards", async () => {
    const h = setup();
    const t = await denied(h);
    await h.orch.answerApproval(t.key, { decision: "allow_tool" });
    await h.orch.idle();
    const review = h.driver.calls.find((c) => c.kind === "review")!;
    expect(review.grants).toBeUndefined();
    expect(ticket(h, t.key).status).toBe("review");
  });

  test("read-only tickets get no grants", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "look around", permissionMode: "read_only" });
    await h.orch.idle();
    expect(work(h)[0]!.grants).toBeUndefined();
    expect(ticket(h, t.key).pendingApproval).toBeNull(); // the denial isn't put to a human either
  });
});

describe("grantKey", () => {
  test("a Bash call's description isn't part of the grant; everything else is", () => {
    expect(grantKey("Bash", { command: "ls", description: "a" })).toBe(grantKey("Bash", { description: "b", command: "ls" }));
    expect(grantKey("Bash", { command: "ls", timeout: 5 })).not.toBe(grantKey("Bash", { command: "ls", timeout: 6 }));
    expect(grantKey("Write", { file_path: "a", description: "a" })).not.toBe(grantKey("Write", { file_path: "a", description: "b" }));
  });
});
