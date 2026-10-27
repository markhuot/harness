import { afterEach, expect, test } from "bun:test";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

/** A board with one other ticket (OTHER, in planning), then a work run of a second ticket that calls `calls`. */
async function agent(calls: [string, unknown][], opts: { other?: { spec?: string; title?: string } } = {}) {
  const h = makeOrchestrator({ tools: undefined });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: opts.other?.spec ?? "Other ticket spec", title: opts.other?.title, start: false });
  await h.settle();
  const { steps, results } = callTools(calls);
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "My ticket", skipAgentReview: true });
  await h.settle();
  return { h, other, me, results };
}
const json = (text: string) => JSON.parse(text.slice(text.indexOf("[") >= 0 && text.indexOf("[") < text.indexOf("{") ? text.indexOf("[") : text.indexOf("{")));

test("list_tickets lists the project's tickets compactly, filters by status, and says when nothing matches", async () => {
  const { results, other, me } = await agent([["list_tickets", { scope: "project" }], ["list_tickets", { scope: "project", status: ["done"] }], ["list_tickets", { scope: "project", status: ["planning"] }]]);
  const all = json(results[0]!.text) as { key: string; status: string; project: string; draft: boolean }[];
  expect(all.map((t) => t.key)).toEqual([other.key, me.key]);
  expect(all[0]).toMatchObject({ status: "planning", project: "ACME", draft: false });
  expect(results[1]!.text).toBe('No tickets match (scope "project", status done).');
  expect((json(results[2]!.text) as unknown[]).length).toBe(1);
});

test("list_tickets says how many it left out when the limit cuts the list", async () => {
  const { results } = await agent([["list_tickets", { scope: "project", limit: 1 }]]);
  expect(results[0]!.text).toMatch(/^Showing 1 of 2 tickets\./);
});

test("get_ticket returns another ticket's spec, revision and Activity; an unknown key is an error the agent can read", async () => {
  const { results, other } = await agent([["get_ticket", { key: "ACME-1" }], ["get_ticket", { key: "NOPE-9" }]]);
  const t = json(results[0]!.text) as { key: string; spec: string; specRevision: number; activity: unknown[]; effectiveBaseBranch: string };
  expect(t).toMatchObject({ key: other.key, spec: "Other ticket spec", specRevision: 1 });
  expect(Array.isArray(t.activity)).toBe(true);
  expect(results[1]!.isError).toBe(true);
  expect(results[1]!.text).toMatch(/Unknown ticket: NOPE-9/);
});

test("get_ticket with include_transcript adds that many recent entries", async () => {
  const { results } = await agent([["get_ticket", { key: "ACME-1", include_transcript: 2 }]]);
  expect((json(results[0]!.text) as { transcript: unknown[] }).transcript.length).toBeLessThanOrEqual(2);
  expect((json(results[0]!.text) as { transcript: unknown[] }).transcript.length).toBeGreaterThan(0);
});

test("search_tickets finds a ticket by a word in its spec, with a snippet, and says when there's no match", async () => {
  const { results, other } = await agent([["search_tickets", { query: "unicorn" }], ["search_tickets", { query: "zzzzzz" }]], { other: { spec: "Please add a unicorn mode" } });
  const out = json(results[0]!.text) as { total: number; hits: { key: string; snippet: string }[] };
  expect(out.hits.map((h) => h.key)).toEqual([other.key]);
  expect(out.hits[0]!.snippet).toContain("unicorn");
  expect(results[1]!.text).toBe('No tickets match "zzzzzz".');
});

test("list_projects returns the projects with their key and directory", async () => {
  const { results, h } = await agent([["list_projects", {}]]);
  expect(json(results[0]!.text)).toEqual([expect.objectContaining({ key: "ACME", path: h.project.path })]);
});

test("list_inbox says the inbox is empty when nothing has arrived", async () => {
  const { results } = await agent([["list_inbox", {}]]);
  expect(results[0]!.text).toBe("The Inbox is empty.");
});

test("list_inbox returns only the events addressed to the caller's own ticket, and a chief's match what its Inbox API returns", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", start: false });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", start: false });
  const cos = h.orch.openCos("all");
  const base = { projectId: null, ticketId: null, actor: "watcher:x" };
  const add = (title: string, owner: { cosId: string | null; targetId?: string | null }, sourceKind: "watcher" | "child" = "watcher") =>
    h.store.ticketEvents.insert({ ...base, ...owner, sourceKind, sourceRef: title, title })!;
  const forA = add("for A", { cosId: cos.ticketId, targetId: a.id });
  const forB = add("for B", { cosId: cos.ticketId, targetId: b.id }, "child");
  const forCos = add("for chief", { cosId: cos.ticketId });
  const unassigned = add("unclaimed", { cosId: null });
  const ctxOf = (key: string) => {
    const ticket = h.ticket(key);
    return { runId: "r", runKind: ticket.kind === "cos" ? "cos" : "work", session: h.store.sessions.get(ticket.sessionId)!, ticket, cwd: h.home, ops: h.orch.ops, browser: undefined as never, signal: new AbortController().signal } as Parameters<typeof h.orch.ops.listInbox>[0];
  };
  const ids = async (key: string, filter: Parameters<typeof h.orch.ops.listInbox>[1] = {}) => (await h.orch.ops.listInbox(ctxOf(key), filter)).items.map((e) => e.id);

  expect(await ids(a.key)).toEqual([forA.id]);
  expect(await ids(b.key)).toEqual([forB.id]);
  expect(await ids(b.key, { source: "watcher" })).toEqual([]);
  expect(await ids(b.key, { statuses: ["handled"] })).toEqual([]);
  expect(await ids(a.key, { key: "NOPE-1" })).toEqual([]);
  // A chief reads its Inbox: its own events and the unclaimed ones, exactly the rows the Inbox API returns. A child row is the ticket feed's, never the Inbox's.
  const api = h.orch.eventsPage(cos.ticketId, {}).items.map((e) => e.id);
  expect(await ids(cos.key)).toEqual(api);
  expect(new Set(api)).toEqual(new Set([forA.id, forCos.id, unassigned.id]));
  expect((await h.orch.ops.listInbox(ctxOf(cos.key), { limit: 2 })).total).toBe(3);
  // The filters run in the query, so the total counts what matches, not what a page holds.
  h.store.ticketEvents.update(forCos.id, { status: "handled" });
  expect(await h.orch.ops.listInbox(ctxOf(cos.key), { statuses: ["pending"], limit: 1 })).toMatchObject({ total: 2, items: [{ status: "pending" }] });
  expect(await ids(cos.key, { key: forA.id.toLowerCase() })).toEqual([forA.id]);
});

test("create_ticket makes a ticket on the board in the agent's project and says its key", async () => {
  const { results, h } = await agent([["create_ticket", { title: "Follow up", spec: "Do the follow up" }]]);
  expect(results[0]!.text).toMatch(/^Created ACME-3\./);
  expect(h.store.tickets.getByKey("ACME-3")).toMatchObject({ title: "Follow up", spec: "Do the follow up", parentId: null });
});

test("create_ticket with child makes the agent the new ticket's conductor", async () => {
  const { results, h, me } = await agent([["create_ticket", { title: "Child", spec: "Part one", child: true }]]);
  expect(results[0]!.isError).toBe(false);
  expect(h.store.tickets.getByKey("ACME-3")!.parentId).toBe(me.id);
});

test("update_ticket edits another ticket's title and dependencies, but never the agent's own", async () => {
  const { results, h, other, me } = await agent([
    ["update_ticket", { key: "ACME-1", title: "Renamed by agent", depends_on: ["ACME-2"] }],
    ["update_ticket", { key: "ACME-2", title: "Nope" }],
  ]);
  expect(results[0]!.text).toMatch(/^Updated ACME-1\./);
  expect(h.ticket(other.key)).toMatchObject({ title: "Renamed by agent", dependsOn: ["ACME-2"] });
  expect(results[1]!.isError).toBe(true);
  expect(h.ticket(me.key).title).not.toBe("Nope");
});

test("update_ticket takes pull_request_urls alone on the agent's own ticket in a work run, and refuses any other field with it", async () => {
  const { results, h, me } = await agent([
    ["update_ticket", { key: "ACME-2", pull_request_urls: ["https://github.com/acme/app/pull/7"] }],
    ["update_ticket", { key: "ACME-2", title: "Nope", pull_request_urls: ["https://github.com/acme/app/pull/8"] }],
  ]);
  expect(results[0]!.isError).toBe(false);
  expect(h.ticket(me.key).pullRequests.map((p) => p.url)).toEqual(["https://github.com/acme/app/pull/7"]);
  expect(results[1]!.isError).toBe(true);
  expect(h.ticket(me.key).title).not.toBe("Nope");
});

test("a chat run records a pull request on its own ticket with update_ticket, but can't edit anything else on it", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const first = callTools([["submit_for_review", { note: "done", spec_is_up_to_date: true }]]);
  const chat = callTools([
    ["update_ticket", { key: "ACME-1", pull_request_urls: ["https://github.com/acme/app/pull/9"] }],
    ["update_ticket", { key: "ACME-1", title: "Nope" }],
  ]);
  h.driver.script(first.steps, chat.steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  await h.orch.sendMessage(t.key, "I opened a PR, record it");
  await h.settle();
  expect(h.driver.requests[1]!.kind).toBe("chat");
  expect(chat.results[0]!.isError).toBe(false);
  expect(h.ticket(t.key).pullRequests.map((p) => p.url)).toEqual(["https://github.com/acme/app/pull/9"]);
  expect(chat.results[1]!.isError).toBe(true);
  expect(h.ticket(t.key).title).not.toBe("Nope");
});

test("move_ticket moves another ticket to a column; in_progress isn't offered", async () => {
  const { results, h, other } = await agent([["move_ticket", { key: "ACME-1", status: "blocked" }], ["move_ticket", { key: "ACME-1", status: "in_progress" }]]);
  expect(results[0]!.text).toBe("Moved ACME-1 (status: blocked).");
  expect(h.ticket(other.key).status).toBe("blocked");
  expect(results[1]!).toMatchObject({ isError: true });
  expect(results[1]!.text).toMatch(/"status" must be one of/);
});

test("start_ticket starts another ticket's work, and message_ticket reaches its agent", async () => {
  const { results, h } = await agent([["start_ticket", { key: "ACME-1" }]]);
  expect(results[0]!.text).toBe("Started ACME-1 (status: in_progress).");
  expect(h.driver.requests.map((r) => r.kind)).toContain("work");
  const second = await agent([["message_ticket", { key: "ACME-1", text: "Use blue" }]]);
  expect(second.results[0]!.text).toBe("Message sent to ACME-1.");
  expect(second.h.driver.requests.some((r) => r.prompt.includes("Use blue"))).toBe(true);
});

test("a board tool can't act on a ticket that doesn't exist", async () => {
  const { results } = await agent([["start_ticket", { key: "NOPE-1" }], ["message_ticket", { key: "NOPE-1", text: "hi" }], ["cancel_ticket", { key: "NOPE-1" }]]);
  for (const r of results) {
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown ticket|NOPE-1/);
  }
});

test("a conductor reviews and completes its child: approve, then complete, lands it in done", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const conductor = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", skipAgentReview: true });
  await h.settle();
  // The child submits itself without an agent review, then waits for its conductor.
  const child = await h.orch.createTicket({ projectId: h.project.id, spec: "Child work", parentId: conductor.key, skipAgentReview: true, start: true });
  await h.settle();
  const { steps, results } = callTools([["review_ticket", { key: child.key, decision: "approve", notes: "Approved, looks right." }], ["complete_ticket", { key: child.key }]]);
  h.driver.script(steps);
  await h.orch.sendMessage(conductor.key, "go ahead and review it");
  await h.settle();
  expect(results.map((r) => r.isError)).toEqual([false, false]);
  expect(results[0]!.text).toContain("Review recorded");
  expect(h.ticket(child.key).status).toBe("done");
});

test("review_ticket refuses a ticket that isn't one of the agent's children", async () => {
  const { results } = await agent([["review_ticket", { key: "ACME-1", decision: "approve", notes: "n" }]]);
  expect(results[0]!.isError).toBe(true);
});

test("create_ticket takes labels, update_ticket add_labels / remove_labels change only those, and list_labels shows the registry", async () => {
  const { results, h, other } = await agent([
    ["create_ticket", { title: "Labeled", spec: "s", labels: ["Bugfix", "bugfix", "Release 1"] }],
    ["update_ticket", { key: "ACME-1", add_labels: ["Docs", "release 1"], remove_labels: ["BUGFIX", "never had it"] }],
    ["list_labels", {}],
    ["update_ticket", { key: "ACME-1", add_labels: ['say "hi"'] }],
  ]);
  expect(results[0]!.text).toMatch(/Created ACME-3/);
  expect(h.store.tickets.getByKey("ACME-3")!.labels).toEqual(["Bugfix", "Release 1"]);
  expect(h.store.tickets.getByKey(other.key)!.labels).toEqual(["Docs", "Release 1"]);
  expect((json(results[2]!.text) as { name: string }[]).map((l) => l.name).sort()).toEqual(["Bugfix", "Docs", "Release 1"]);
  expect(results[3]!.isError).toBe(true);
  expect(results[3]!.text).toMatch(/Invalid label/);
  const announced = h.events.filter((e) => e.kind === "labels.changed");
  expect(announced.length).toBeGreaterThan(0);
  expect(announced.at(-1)).toMatchObject({ labels: expect.arrayContaining([expect.objectContaining({ name: "Docs", count: 1 })]) });
});

test("a work run labels its own ticket with add_labels, but can't edit anything else on it", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const { steps, results } = callTools([
    ["update_ticket", { key: "ACME-1", add_labels: ["Mine"] }],
    ["update_ticket", { key: "ACME-1", add_labels: ["Mine"], title: "Renamed" }],
  ]);
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "My ticket", skipAgentReview: true });
  await h.settle();
  expect(results[0]!.isError).toBeFalsy();
  expect(results[1]!.isError).toBe(true);
  expect(h.store.tickets.getByKey(me.key)!.labels).toEqual(["Mine"]);
});

test("search_tickets understands label: and project: terms", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other ticket spec", start: false, labels: ["Reference"] });
  await h.settle();
  const { steps, results } = callTools([["search_tickets", { query: "label:Reference project:acme" }], ["search_tickets", { query: "label:Nope" }]]);
  h.driver.script(steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "My ticket", skipAgentReview: true });
  await h.settle();
  expect((json(results[0]!.text) as { hits: { key: string }[] }).hits.map((x) => x.key)).toEqual([other.key]);
  expect(results[1]!.text).toBe('No tickets match "label:Nope".');
});
