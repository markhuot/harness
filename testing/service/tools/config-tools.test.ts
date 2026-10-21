import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callTools, makeOrchestrator, stopAll, type OrchestratorRig } from "../orchestrator-harness";

afterEach(stopAll);

/** A run of the agent calling `calls`, on a fresh orchestrator (watchers off, no real service around it). */
async function run(calls: [string, unknown][]) {
  const h = makeOrchestrator({ tools: undefined });
  const { steps, results } = callTools(calls);
  h.driver.script(steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Configure things", skipAgentReview: true });
  await h.settle();
  return { h, t, results };
}
const json = (text: string) => JSON.parse(text);

test("get_settings shows the settings without any secret, and which prompts the user customized", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.orch.updateSettings({ anthropicApiKey: "sk-secret", prompts: { "run.work_start": "Start: {{spec}}" } });
  const { steps, results } = callTools([["get_settings", {}]]);
  h.driver.script(steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(results[0]!.text).not.toContain("sk-secret");
  expect(json(results[0]!.text)).toMatchObject({ anthropicApiKeySet: true, customizedPrompts: ["run.work_start"], maxConcurrentRuns: 4 });
});

test("list_drivers lists each driver with its models", async () => {
  const { results } = await run([["list_drivers", {}]]);
  expect(json(results[0]!.text)).toEqual([expect.objectContaining({ id: "fake", models: [{ id: "fake-model", name: "Fake Model", default: true }] })]);
});

test("a config change is never run on the agent's say-so: it opens an approval card saying what it would do, and blocks the ticket", async () => {
  const { h, t, results } = await run([["update_project", { project_key: "ACME", name: "Renamed", color: "red" }]]);
  expect(results[0]!.isError).toBe(true);
  expect(h.store.projects.get(h.project.id)!.name).not.toBe("Renamed");
  const card = h.ticket(t.key);
  expect(card.status).toBe("blocked");
  expect(card.pendingApproval).toMatchObject({ toolName: "update_project", onceOnly: true, source: "policy" });
  expect(card.pendingApproval!.summary).toContain("ACME");
  expect(card.pendingApproval!.summary).toContain("Renamed");
});

test("allowing the call once lets the identical retry through, and it runs exactly once", async () => {
  const input = { max_concurrent_runs: 3 };
  const h = makeOrchestrator({ tools: undefined });
  const first = callTools([["update_settings", input]]);
  const retry = callTools([["update_settings", input], ["update_settings", input]]);
  h.driver.script(first.steps, retry.steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(h.orch.settings().maxConcurrentRuns).not.toBe(3);
  await h.orch.answerApproval(t.key, { decision: "allow_once" });
  await h.settle();
  expect(retry.results[0]!.isError).toBe(false);
  expect(h.orch.settings().maxConcurrentRuns).toBe(3);
  // The grant is used up: a second identical call needs a new approval.
  expect(retry.results[1]!.isError).toBe(true);
});

test("allowing a gated tool for the whole ticket isn't possible: only one call at a time", async () => {
  const { h, t } = await run([["update_settings", { max_concurrent_runs: 2 }]]);
  expect(h.ticket(t.key).pendingApproval?.toolName).toBe("update_settings");
  await expect(h.orch.answerApproval(t.key, { decision: "allow_tool" })).rejects.toThrow(/can only be allowed once/);
});

test("a call that's invalid is refused without bothering a human", async () => {
  const { h, t, results } = await run([["update_project", { project_key: "NOPE", name: "x" }]]);
  expect(results[0]!.isError).toBe(true);
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

test("in a read-only ticket a gated tool is denied outright", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.store.settings.set({ permissionMode: "read_only" });
  mkdirSync(join(h.home, "x"));
  const { steps, results } = callTools([["create_project", { path: join(h.home, "x") }]]);
  h.driver.script(steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(results[0]!.text).toContain("read-only");
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

/** The agent makes the same gated call twice in two runs, with the human's allow-once in between. */
async function approvedOnce(h: OrchestratorRig, call: [string, unknown]) {
  const first = callTools([call]);
  const retry = callTools([call]);
  h.driver.script(first.steps, retry.steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).pendingApproval?.toolName).toBe(call[0]);
  await h.orch.answerApproval(t.key, { decision: "allow_once" });
  await h.settle();
  return { ticket: t, result: retry.results[0]! };
}

test("an approved create_project makes the project", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const dir = join(h.home, "newproj");
  mkdirSync(dir);
  const { result } = await approvedOnce(h, ["create_project", { path: dir, key: "NEWP", use_worktrees: false }]);
  expect(result.isError).toBe(false);
  expect(h.orch.listProjects().find((p) => p.key === "NEWP")).toMatchObject({ path: dir, useWorktrees: false });
});

test("an approved delete_ticket removes the other ticket", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const victim = await h.orch.createTicket({ projectId: h.project.id, spec: "to delete", start: false });
  await h.settle();
  const { result } = await approvedOnce(h, ["delete_ticket", { key: victim.key }]);
  expect(result.isError).toBe(false);
  expect(h.store.tickets.getByKey(victim.key)).toBeNull();
});

test("an approved update_settings changes the settings, and an approved update_project renames the project", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const { result } = await approvedOnce(h, ["update_settings", { max_concurrent_runs: 2 }]);
  expect(result.isError).toBe(false);
  expect(h.orch.settings().maxConcurrentRuns).toBe(2);
  const h2 = makeOrchestrator({ tools: undefined });
  const renamed = await approvedOnce(h2, ["update_project", { project_key: "ACME", name: "Renamed" }]);
  expect(renamed.result.isError).toBe(false);
  expect(h2.store.projects.get(h2.project.id)!.name).toBe("Renamed");
});
