import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TRIAGE_AGENT_SYSTEM, TriageIncomplete, type AgentTriageRequest } from "../../../service/src/cos/triage";
import type { Classifier } from "../../../service/src/permissions/classifier";
import { toolsForRun } from "../../../service/src/tools";
import { FakeDriver, failScript, toolCall, type Step } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

async function rig() {
  const driver = new FakeDriver({ id: "claude-code", usesPermissionPromptTool: true });
  const h = makeOrchestrator({ driver, tools: toolsForRun });
  const dir = join(h.home, "proj", "gr");
  mkdirSync(dir, { recursive: true });
  h.orch.createProject({ path: dir, name: "Group", key: "GR", useWorktrees: false });
  const chief = h.orch.openCos("all");
  const request = (ids: string[], over: Partial<AgentTriageRequest> = {}): AgentTriageRequest => ({ system: TRIAGE_AGENT_SYSTEM, prompt: "events", cosId: chief.ticketId, model: "haiku", ids, timeoutMs: 60_000, ...over });
  return { h, driver, chief, request };
}

const verdictCall = (id: string, verdict: "ignore" | "escalate", extra: Record<string, string> = {}): Step[] => toolCall("triage_verdict", { id, verdict, reason: `because ${id}`, ...extra });

test("triage is a read-only run on its own session: its tools, its model, a turn limit, and no ticket", async () => {
  const { h, driver, request } = await rig();
  driver.script([...verdictCall("e1", "escalate", { brief: "Copilot review on PR #1297 with 2 open threads; owning ticket ACAMD-87" }), ...verdictCall("e2", "ignore")]);
  const res = await h.orch.runTriage(request(["e1", "e2"]), new AbortController().signal);

  expect(res.verdicts).toEqual([
    { id: "e1", verdict: "escalate", reason: "because e1", brief: "Copilot review on PR #1297 with 2 open threads; owning ticket ACAMD-87", project: null },
    { id: "e2", verdict: "ignore", reason: "because e2", brief: null, project: null },
  ]);
  const req = driver.requests[0]!;
  expect(req.kind).toBe("triage");
  expect(req.model).toBe("haiku");
  expect(req.maxTurns).toBeGreaterThan(0);
  expect(req.systemPrompt).toBe(TRIAGE_AGENT_SYSTEM);
  expect(req.toolContext.ticket).toBeNull();
  const names = req.tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["search_tickets", "get_ticket", "list_tickets", "list_inbox", "list_projects", "triage_verdict", "permission_prompt"]));
  // Nothing that changes the board, a spec, a config or a file.
  for (const write of ["create_ticket", "update_ticket", "message_ticket", "reopen_ticket", "move_ticket", "edit_spec", "bash", "write_file", "update_notes"]) expect(names).not.toContain(write);

  // Its session is kept (the Inbox links to it), is not a board session, and holds what the run did.
  const session = h.store.sessions.get(res.sessionId)!;
  expect(session.kind).toBe("triage");
  expect(session.ticketId).toBeNull();
  expect(h.orch.listSessions().map((s) => s.id)).not.toContain(res.sessionId);
  const calls = h.store.transcript.list(res.sessionId).flatMap((e) => (e.content.type === "tool_call" ? [e.content.name] : []));
  expect(calls).toEqual(["triage_verdict", "triage_verdict"]);
});

test("a lookup goes through the gate: gh reads and read-only MCP tools run, writes are refused", async () => {
  const { h, driver, request } = await rig();
  const answers: Record<string, { behavior: string }> = {};
  const decide = (key: string, tool: string, input: unknown) => toolCall("permission_prompt", { tool_name: tool, input, tool_use_id: key }, (r) => (answers[key] = JSON.parse((r.content[0] as { text: string }).text)));
  driver.script([
    ...decide("gh-read", "Bash", { command: "gh pr view 1297 --repo ACAMSLLC/CMS-Drupal --json reviews" }),
    ...decide("gh-merge", "Bash", { command: "gh pr merge 1297" }),
    ...decide("gh-post", "Bash", { command: "gh api repos/a/b/issues/1/comments -f body=hi" }),
    ...decide("jira-read", "mcp__claude_ai_hc-jira__get-issue", { key: "ACAMD-87" }),
    ...decide("jira-write", "mcp__claude_ai_hc-jira__add-comment", { key: "ACAMD-87", body: "x" }),
    ...decide("edit", "Edit", { file_path: "/tmp/x" }),
    ...verdictCall("e1", "ignore"),
  ]);
  await h.orch.runTriage(request(["e1"]), new AbortController().signal);
  expect(answers["gh-read"]!.behavior).toBe("allow");
  expect(answers["jira-read"]!.behavior).toBe("allow");
  for (const k of ["gh-merge", "gh-post", "jira-write", "edit"]) expect(answers[k]!.behavior).toBe("deny");
});

/** A classifier that answers by the command: allow `curl`, soft-deny `gh pr comment`, hard-deny the rest. */
function fakeClassifier(seen: string[]): Classifier {
  return {
    backend: "fake",
    async classify(req) {
      const command = (req.input as { command?: string }).command ?? "";
      seen.push(command);
      if (command.startsWith("curl")) return { decision: "allow", reason: "a read" };
      if (command.startsWith("gh pr comment")) return { decision: "soft_deny", reason: "posts a comment" };
      return { decision: "hard_deny", reason: "destructive" };
    },
  };
}

async function decideAll(mode: "auto" | "read_only" | null, commands: Record<string, string>) {
  const seen: string[] = [];
  const driver = new FakeDriver({ id: "claude-code", usesPermissionPromptTool: true });
  const h = makeOrchestrator({ driver, tools: toolsForRun, classifier: fakeClassifier(seen) });
  const chief = h.orch.openCos("all");
  h.orch.updateSettings({ cosTriagePermissionMode: mode });
  const answers: Record<string, { behavior: string; message?: string }> = {};
  driver.script([
    ...Object.entries(commands).flatMap(([key, command]) =>
      toolCall("permission_prompt", { tool_name: "Bash", input: { command }, tool_use_id: key }, (r) => (answers[key] = JSON.parse((r.content[0] as { text: string }).text))),
    ),
    ...verdictCall("e1", "ignore"),
  ]);
  await h.orch.runTriage({ system: TRIAGE_AGENT_SYSTEM, prompt: "events", cosId: chief.ticketId, model: "haiku", ids: ["e1"], timeoutMs: 60_000 }, new AbortController().signal);
  return { answers, seen, req: driver.requests[0]! };
}

test("in auto mode, what the CLI asks about is judged by Harness's classifier; what would need a human is refused", async () => {
  const { answers, seen, req } = await decideAll("auto", { read: "curl -s https://api.github.com/repos/o/r/pulls/1", post: "gh pr comment 1 --body hi", wipe: "rm -rf ~" });
  expect(req.permissionMode).toBe("auto");
  expect(seen).toEqual(["curl -s https://api.github.com/repos/o/r/pulls/1", "gh pr comment 1 --body hi", "rm -rf ~"]);
  expect(answers.read!.behavior).toBe("allow"); // the read-only policy would refuse curl
  expect(answers.post).toMatchObject({ behavior: "deny" });
  expect(answers.post!.message).toMatch(/posts a comment.*No human is available.*escalate/s);
  expect(answers.wipe!.behavior).toBe("deny");
});

test("in read-only mode (the default) the read-only policy answers and the classifier is never asked", async () => {
  for (const mode of ["read_only", null] as const) {
    const { answers, seen, req } = await decideAll(mode, { gh: "gh pr view 1", curl: "curl -s https://api.github.com/repos/o/r/pulls/1" });
    expect(req.permissionMode).toBe("read_only");
    expect(seen).toEqual([]);
    expect(answers.gh!.behavior).toBe("allow");
    expect(answers.curl!.behavior).toBe("deny");
  }
});

test("a verdict for an id the run wasn't asked about, or a bad verdict, is refused and not recorded", async () => {
  const { h, driver, request } = await rig();
  const seen: string[] = [];
  const call = (input: unknown) => toolCall("triage_verdict", input, (r) => seen.push(`${r.isError ? "error" : "ok"}: ${(r.content[0] as { text: string }).text}`));
  driver.script([...call({ id: "nope", verdict: "ignore", reason: "r" }), ...call({ id: "e1", verdict: "maybe", reason: "r" }), ...call({ id: "e1", verdict: "ignore", reason: "r" })]);
  const res = await h.orch.runTriage(request(["e1"]), new AbortController().signal);
  expect(seen[0]).toMatch(/^error: .*must be one of e1/);
  expect(seen[1]).toMatch(/^error/);
  expect(seen[2]).toMatch(/^ok: Recorded\. Every event has a verdict/);
  expect(res.verdicts.map((v) => v.id)).toEqual(["e1"]);
});

test("a run that fails after recording some verdicts throws TriageIncomplete holding them; one that records none holds none", async () => {
  const { h, driver, request } = await rig();
  driver.script([...verdictCall("e1", "ignore"), ...failScript("usage limit")], failScript("claude exited"));
  const err = await h.orch.runTriage(request(["e1", "e2"]), new AbortController().signal).catch((e) => e);
  expect(err).toBeInstanceOf(TriageIncomplete);
  expect(err.message).toContain("usage limit");
  expect(err.verdicts.map((v: { id: string }) => v.id)).toEqual(["e1"]);
  const none = await h.orch.runTriage(request(["e1"]), new AbortController().signal).catch((e) => e);
  expect(none).toBeInstanceOf(TriageIncomplete);
  expect(none.verdicts).toEqual([]);
  // A run that ends with no verdict at all is a failure too, not an empty success.
  const quiet = await h.orch.runTriage(request(["e1"]), new AbortController().signal).catch((e) => e);
  expect(quiet.message).toMatch(/no verdicts/);
});

test("aborting the call (the engine's timeout) cancels the run and keeps the verdicts recorded so far", async () => {
  const { h, driver, request } = await rig();
  const stuck = { wait: { wait: (signal: AbortSignal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) } } as unknown as Step;
  driver.script([...verdictCall("e1", "ignore"), stuck]);
  const controller = new AbortController();
  const pending = h.orch.runTriage(request(["e1", "e2"]), controller.signal).catch((e) => e);
  await driver.runStarted(1);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const err = await pending;
  expect(err).toBeInstanceOf(TriageIncomplete);
  expect(err.verdicts.map((v: { id: string }) => v.id)).toEqual(["e1"]);
  await h.settle();
  expect(driver.aborted).toHaveLength(1);
});

test("the first verdict for an event is final: a later call can't flip it", async () => {
  const { h, driver, request } = await rig();
  const seen: string[] = [];
  const call = (verdict: "ignore" | "escalate") => toolCall("triage_verdict", { id: "e1", verdict, reason: verdict }, (r) => seen.push((r.content[0] as { text: string }).text));
  driver.script([...call("escalate"), ...call("ignore")]);
  const res = await h.orch.runTriage(request(["e1"]), new AbortController().signal);
  expect(res.verdicts.map((v) => v.verdict)).toEqual(["escalate"]);
  expect(seen[1]).toMatch(/already has a verdict/);
});

test("the run's own time limit counts from when it starts, and cuts it off keeping what it recorded", async () => {
  const { h, driver, request } = await rig();
  const stuck = { wait: { wait: (signal: AbortSignal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) } } as unknown as Step;
  driver.script([...verdictCall("e1", "ignore"), stuck]);
  const err = await h.orch.runTriage(request(["e1", "e2"], { timeoutMs: 100 }), new AbortController().signal).catch((e) => e);
  expect(err).toBeInstanceOf(TriageIncomplete);
  expect(err.message).toMatch(/timed out/);
  expect(err.verdicts.map((v: { id: string }) => v.id)).toEqual(["e1"]);
});

test("a triage run's session isn't a legacy Inbox item: list_inbox and get_ticket don't show it", async () => {
  const { h, driver, request } = await rig();
  let inbox = "";
  let ticket = "";
  driver.script([
    ...toolCall("list_inbox", {}, (r) => (inbox = (r.content[0] as { text: string }).text)),
    ...toolCall("get_ticket", { key: "TRIAGE-1" }, (r) => (ticket = (r.content[0] as { text: string }).text)),
    ...verdictCall("e1", "ignore"),
  ]);
  await h.orch.runTriage(request(["e1"]), new AbortController().signal);
  expect(inbox).not.toMatch(/TRIAGE-1/);
  expect(ticket).toMatch(/Unknown ticket/);
});

test("a triage run reads only what its chief covers: with no chief behind it, the board tools refuse", async () => {
  const { h, driver, request } = await rig();
  let text = "";
  driver.script([...toolCall("list_tickets", {}, (r) => (text = (r.content[0] as { text: string }).text)), ...verdictCall("e1", "ignore")]);
  await h.orch.runTriage(request(["e1"], { cosId: "gone" }), new AbortController().signal);
  expect(text).toMatch(/no chief/);
});
