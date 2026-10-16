import { afterEach, expect, test } from "bun:test";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

async function triage(calls: [string, unknown][], output = "FOO-12 failed on staging", opts: { prompt?: string; setup?: (h: ReturnType<typeof makeOrchestrator>) => Promise<void> | void } = {}) {
  const h = makeOrchestrator({ tools: undefined });
  await opts.setup?.(h);
  const { steps, results } = callTools(calls);
  h.driver.script(steps);
  const session = (await h.orch.injectOutput("jira", output, opts.prompt))!;
  await h.settle();
  return { h, session, results };
}

test("watcher output becomes a triage session whose run is told the source, the output and the projects", async () => {
  const { h, session } = await triage([]);
  expect(session).toMatchObject({ kind: "triage", key: "TRIAGE-1", triageStatus: "triaging" });
  const req = h.driver.requests[0]!;
  expect(req.kind).toBe("triage");
  expect(req.prompt).toContain("FOO-12 failed on staging");
  expect(req.prompt).toContain("ACME: Acme");
  // A triage session has no project: it runs in the service's own folder.
  expect(req.cwd).toBe(h.home);
});

test("the same output from the same source is triaged once", async () => {
  const h = makeOrchestrator({ tools: undefined });
  expect(await h.orch.injectOutput("jira", "same text")).not.toBeNull();
  expect(await h.orch.injectOutput("jira", "same text")).toBeNull();
  expect(await h.orch.injectOutput("other", "same text")).not.toBeNull();
  await h.settle();
  expect(h.store.sessions.list("triage")).toHaveLength(2);
});

test("injected output needs a source and some text, and a non-string prompt is refused", async () => {
  const h = makeOrchestrator();
  await expect(h.orch.injectOutput(" ", "x")).rejects.toThrow(/source is required/);
  await expect(h.orch.injectOutput("s", "   ")).rejects.toThrow(/text is required/);
  await expect(h.orch.injectOutput("s", "x", 5)).rejects.toThrow(/prompt must be a string/);
  expect((await h.orch.injectOutput("s", { a: 1 }))!.title).toContain("a");
});

test("dispatch_ticket creates a ticket in the chosen project linked to the remote item, and marks the Inbox item dispatched", async () => {
  const { h, session, results } = await triage([["dispatch_ticket", { project_key: "ACME", key: "FOO-12", url: "https://j/FOO-12", title: "Fix staging", spec: "Staging is failing." }]]);
  expect(results[0]!.text).toMatch(/^Dispatched as ACME-1 \(task, status: planning, remote ID FOO-12\)/);
  const ticket = h.store.tickets.getByKey("ACME-1")!;
  expect(ticket).toMatchObject({ title: "Fix staging", externalRef: { key: "FOO-12", url: "https://j/FOO-12" } });
  const after = h.store.sessions.get(session.id)!;
  expect(after.triageStatus).toBe("dispatched");
  expect(after.outcome).toContain("ACME-1");
});

test("dispatch_ticket with start works the ticket at once", async () => {
  const { h, results } = await triage([["dispatch_ticket", { project_key: "ACME", title: "Go", spec: "Do it", start: true }]]);
  expect(results[0]!.text).toContain("status: in_progress");
  expect(h.driver.requests.map((r) => r.kind)).toContain("work");
});

test("dispatch_ticket with ticket_key sends the update to that ticket's agent instead of making a new ticket", async () => {
  const { h, results } = await triage([["dispatch_ticket", { project_key: "ACME", ticket_key: "ACME-1", title: "Update", spec: "New info: it is the cache." }]], "ACME-1 has news", {
    setup: async (h) => {
      await h.orch.createTicket({ projectId: h.project.id, spec: "Original", start: false });
      await h.settle();
    },
  });
  expect(results[0]!.text).toMatch(/^Sent the update to ACME-1/);
  expect(h.store.tickets.list()).toHaveLength(1);
  expect(h.driver.requests.some((r) => r.prompt.includes("it is the cache"))).toBe(true);
});

test("an unknown project is an error the triage agent can read, and the item isn't marked dispatched", async () => {
  const { h, session, results } = await triage([["dispatch_ticket", { project_key: "NOPE", title: "t", spec: "s" }]]);
  expect(results[0]!.isError).toBe(true);
  expect(h.store.tickets.list()).toEqual([]);
  expect(h.store.sessions.get(session.id)!.triageStatus).not.toBe("dispatched");
});

test("decline_work records the reason and an optional title on the Inbox item", async () => {
  const { h, session, results } = await triage([["decline_work", { reason: "Not assigned to me", title: "Deploy finished" }]]);
  expect(results[0]!.text).toContain("declined");
  const after = h.store.sessions.get(session.id)!;
  expect(after).toMatchObject({ triageStatus: "declined", outcome: "Declined: Not assigned to me", title: "Deploy finished" });
});

test("a triage run that ends without deciding is marked failed", async () => {
  const { h, session } = await triage([]);
  expect(h.store.sessions.get(session.id)!.triageStatus).toBe("failed");
});

test("list_inbox shows the triaged items with their decision, newest first", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const first = callTools([["decline_work", { reason: "skip" }]]);
  h.driver.script(first.steps);
  await h.orch.injectOutput("jira", "one");
  await h.settle();
  h.clock.advance(1000);
  const second = callTools([["list_inbox", { include_output: true }]]);
  h.driver.script(second.steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  const [item] = JSON.parse(second.results[0]!.text);
  expect(item).toMatchObject({ key: "TRIAGE-1", source: "jira", status: "declined", outcome: "Declined: skip", output: "one" });
});
