// Board (read) HarnessOps: list_tickets / get_ticket / search_tickets / list_projects as every
// run kind sees them, against a real store (scopes, filters, caps, aliases, triage defaults,
// transcript tails, search paging), plus the tool layer on top.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket, TicketStatus } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";
import { fakeContext, fakeSession } from "../tools/fakes";
import { allTools } from "../tools";
import type { ToolContext } from "../tools/types";
import { BOARD_TRANSCRIPT_CHARS, BOARD_TRANSCRIPT_MAX } from "./orchestrator";

async function setup() {
  const h = makeOrchestrator();
  const project = (key: string) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    return h.orch.createProject({ path: dir, key });
  };
  const web = project("WEB");
  const api = project("API");
  const make = async (projectId: string, title: string, extra: { status?: TicketStatus; parentId?: string; kind?: "conductor"; description?: string } = {}) => {
    const t = await h.orch.createTicket({ projectId, prompt: extra.description ?? title, title, start: false, parentId: extra.parentId, kind: extra.kind });
    if (extra.status && extra.status !== "planning") h.store.tickets.update(t.id, { status: extra.status });
    return h.store.tickets.get(t.id)!;
  };
  await h.orch.idle();
  const ctx = (kind: RunKind, ticket: Ticket | null): ToolContext =>
    fakeContext({
      runKind: kind,
      ticket,
      session: ticket ? fakeSession({ id: ticket.sessionId, key: ticket.key, ticketId: ticket.id }) : fakeSession({ kind: "triage", ticketId: null, key: "TRIAGE-1" }),
      ops: h.orch.ops,
    });
  return { ...h, web, api, make, ctx };
}

const keys = (ts: { key: string }[]) => ts.map((t) => t.key);

describe("listTickets (board)", () => {
  test("default scope: conductor → children, task → its project, triage → every project", async () => {
    const h = await setup();
    const conductor = await h.make(h.web.id, "conduct", { kind: "conductor" });
    const child = await h.make(h.web.id, "child", { parentId: conductor.id });
    const task = await h.make(h.web.id, "task");
    const other = await h.make(h.api.id, "elsewhere");

    const c = await h.orch.ops.listTickets(h.ctx("conductor", conductor), {});
    expect(c.scope).toBe("children");
    expect(keys(c.tickets)).toEqual([child.key]);

    const w = await h.orch.ops.listTickets(h.ctx("work", task), {});
    expect(w.scope).toBe("project");
    expect(keys(w.tickets).sort()).toEqual([conductor.key, child.key, task.key].sort());

    const t = await h.orch.ops.listTickets(h.ctx("triage", null), {});
    expect(t.scope).toBe("all");
    expect(keys(t.tickets)).toContain(other.key);
    expect(t.total).toBe(4);
    expect(t.tickets.find((x) => x.key === other.key)!.projectKey).toBe("API");
  });

  test("project_key picks another project (case-insensitive), and implies project scope for a conductor", async () => {
    const h = await setup();
    const conductor = await h.make(h.web.id, "conduct", { kind: "conductor" });
    const other = await h.make(h.api.id, "elsewhere");
    const r = await h.orch.ops.listTickets(h.ctx("conductor", conductor), { projectKey: "api" });
    expect(r.scope).toBe("project");
    expect(keys(r.tickets)).toEqual([other.key]);
    const triage = await h.orch.ops.listTickets(h.ctx("triage", null), { scope: "project", projectKey: "API" });
    expect(keys(triage.tickets)).toEqual([other.key]);
  });

  test("status filter narrows; done tickets come newest-completed first and last on the board", async () => {
    const h = await setup();
    const a = await h.make(h.web.id, "a", { status: "done" });
    await Bun.sleep(5);
    const b = await h.make(h.web.id, "b", { status: "done" });
    const blocked = await h.make(h.web.id, "c", { status: "blocked" });
    const planning = await h.make(h.web.id, "d");
    const ctx = h.ctx("work", planning);
    expect(keys((await h.orch.ops.listTickets(ctx, {})).tickets)).toEqual([planning.key, blocked.key, b.key, a.key]);
    const only = await h.orch.ops.listTickets(ctx, { statuses: ["blocked", "planning"] });
    expect(keys(only.tickets)).toEqual([planning.key, blocked.key]);
    expect(only.total).toBe(2);
  });

  test("limit caps the page but total counts every match", async () => {
    const h = await setup();
    const first = await h.make(h.web.id, "t0");
    for (let i = 1; i < 5; i++) await h.make(h.web.id, `t${i}`);
    const r = await h.orch.ops.listTickets(h.ctx("review", first), { limit: 2 });
    expect(r.tickets).toHaveLength(2);
    expect(r.total).toBe(5);
    const huge = await h.orch.ops.listTickets(h.ctx("review", first), { limit: 10_000 });
    expect(huge.tickets).toHaveLength(5);
  });

  test("invalid combinations and unknown projects/statuses are errors", async () => {
    const h = await setup();
    const t = await h.make(h.web.id, "t");
    await expect(h.orch.ops.listTickets(h.ctx("work", t), { projectKey: "NOPE" })).rejects.toThrow("Unknown project: NOPE");
    await expect(h.orch.ops.listTickets(h.ctx("work", t), { scope: "all", projectKey: "WEB" })).rejects.toThrow('scope "all"');
    await expect(h.orch.ops.listTickets(h.ctx("triage", null), { scope: "children" })).rejects.toThrow("needs a ticket run");
    await expect(h.orch.ops.listTickets(h.ctx("triage", null), { scope: "project" })).rejects.toThrow("project_key is required");
    await expect(h.orch.ops.listTickets(h.ctx("work", t), { statuses: ["archived" as TicketStatus] })).rejects.toThrow("Unknown status: archived");
  });
});

describe("getTicket (board)", () => {
  test("reads a ticket in another project with parent, children, driver and summaries — from a triage run too", async () => {
    const h = await setup();
    const conductor = await h.make(h.api.id, "conduct", { kind: "conductor" });
    const child = await h.make(h.api.id, "child", { parentId: conductor.id, status: "blocked" });
    h.store.tickets.update(child.id, { blockedReason: "Which DB?" });
    h.store.summaries.add({ sessionId: child.sessionId, ticketId: child.id, author: "agent", body: "tried sqlite" });
    const me = await h.make(h.web.id, "me");

    const d = await h.orch.ops.getTicket(h.ctx("work", me), child.key.toLowerCase());
    expect(d.ticket.key).toBe(child.key);
    expect(d.ticket.projectKey).toBe("API");
    expect(d.ticket.blockedReason).toBe("Which DB?");
    expect(d.parent).toBe(conductor.key);
    expect(d.summaries.map((s) => s.body)).toEqual(["tried sqlite"]);
    expect(d.transcript).toBeUndefined();
    expect(d.resolvedFrom).toBeNull();

    const c = await h.orch.ops.getTicket(h.ctx("triage", null), conductor.key);
    expect(c.children).toEqual([child.key]);
    expect(c.parent).toBeNull();
  });

  test("old keys resolve after a project rename; unknown keys throw", async () => {
    const h = await setup();
    const t = await h.make(h.web.id, "t");
    h.orch.updateProject(h.web.id, { key: "SITE" });
    const d = await h.orch.ops.getTicket(h.ctx("plan", null), t.key);
    expect(d.ticket.key).toBe("SITE-1");
    expect(d.resolvedFrom).toBe("WEB-1");
    await expect(h.orch.ops.getTicket(h.ctx("plan", null), "WEB-99")).rejects.toThrow("Unknown ticket: WEB-99");
  });

  test("include_transcript returns the last N text/status/error entries, oldest first, clipped", async () => {
    const h = await setup();
    const t = await h.make(h.web.id, "t");
    const before = h.store.transcript.list(t.sessionId).length;
    h.store.transcript.append(t.sessionId, null, "assistant", { type: "text", text: "first" });
    h.store.transcript.append(t.sessionId, null, "assistant", { type: "tool_call", callId: "c1", name: "bash", input: { command: "ls" } });
    h.store.transcript.append(t.sessionId, null, "assistant", { type: "thinking", text: "hmm" });
    h.store.transcript.append(t.sessionId, null, "system", { type: "error", text: "boom" });
    h.store.transcript.append(t.sessionId, null, "assistant", { type: "text", text: "x".repeat(BOARD_TRANSCRIPT_CHARS + 500) });
    const ctx = h.ctx("review", t);

    const two = (await h.orch.ops.getTicket(ctx, t.key, { transcript: 2 })).transcript!;
    expect(two.map((e) => e.type)).toEqual(["error", "text"]);
    expect(two[0]).toMatchObject({ role: "system", text: "boom" });
    expect(two[1]!.text.length).toBeLessThan(BOARD_TRANSCRIPT_CHARS + 100);
    expect(two[1]!.text).toContain("characters truncated");

    const all = (await h.orch.ops.getTicket(ctx, t.key, { transcript: BOARD_TRANSCRIPT_MAX + 10 })).transcript!;
    expect(all.length).toBeLessThanOrEqual(BOARD_TRANSCRIPT_MAX);
    expect(all.map((e) => e.text)).not.toContain("hmm");
    expect(all.filter((e) => e.text === "first")).toHaveLength(1);
    expect(all.length).toBe(before + 3);
  });
});

describe("searchTickets (board)", () => {
  test("pages with nextCursor, scopes to project_key, and snippets the matching text", async () => {
    const h = await setup();
    for (let i = 0; i < 3; i++) {
      await h.make(h.web.id, `Checkout ${i}`, { description: `Intro text. The payment widget number ${i} needs work.` });
      await Bun.sleep(2);
    }
    const api = await h.make(h.api.id, "Payment API", { description: "server side" });
    const ctx = h.ctx("work", null);

    const p1 = await h.orch.ops.searchTickets(ctx, { query: "payment", limit: 2 });
    expect(p1.total).toBe(4);
    expect(p1.hits).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.hits[0]!.ticket.key).toBe(api.key); // title hit ranks above description hits
    const p2 = await h.orch.ops.searchTickets(ctx, { query: "payment", limit: 2, cursor: p1.nextCursor! });
    expect(p2.nextCursor).toBeNull();
    const seen = [...p1.hits, ...p2.hits].map((x) => x.ticket.key);
    expect(new Set(seen).size).toBe(4);

    const web = await h.orch.ops.searchTickets(ctx, { query: "payment widget", projectKey: "WEB" });
    expect(web.hits.map((x) => x.ticket.projectKey)).toEqual(["WEB", "WEB", "WEB"]);
    expect(web.hits[0]!.snippet).toContain("payment widget");

    await expect(h.orch.ops.searchTickets(ctx, { query: "payment", cursor: "garbage" })).rejects.toThrow("Invalid cursor");
    await expect(h.orch.ops.searchTickets(ctx, { query: "payment", projectKey: "NOPE" })).rejects.toThrow("Unknown project");
  });
});

describe("board tools over the real orchestrator", () => {
  const tool = (name: string) => allTools.find((t) => t.name === name)!;
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

  test("list_tickets notes when results were capped; search_tickets returns compact hits", async () => {
    const h = await setup();
    const t = await h.make(h.web.id, "Dark mode toggle");
    for (let i = 0; i < 3; i++) await h.make(h.web.id, `other ${i}`);
    const ctx = h.ctx("plan", t);
    const capped = text(await tool("list_tickets").execute({ limit: 2 }, ctx));
    expect(capped).toStartWith("Showing 2 of 4 tickets.");
    const full = text(await tool("list_tickets").execute({}, ctx));
    expect(JSON.parse(full)).toHaveLength(4);

    const found = JSON.parse(text(await tool("search_tickets").execute({ query: "dark" }, ctx)));
    expect(found).toEqual({
      total: 1,
      hits: [{ key: t.key, title: "Dark mode toggle", status: "planning", project: "WEB", snippet: "Dark mode toggle" }],
      nextCursor: null,
    });
    expect(text(await tool("search_tickets").execute({ query: "zebra" }, ctx))).toBe('No tickets match "zebra".');
  });

  test("get_ticket exposes description, driver and transcript only when asked", async () => {
    const h = await setup();
    const t = await h.make(h.web.id, "t", { description: "the brief" });
    h.store.transcript.append(t.sessionId, null, "assistant", { type: "text", text: "all done" });
    const ctx = h.ctx("complete", t);
    const plain = JSON.parse(text(await tool("get_ticket").execute({ key: t.key }, ctx)));
    expect(plain).toMatchObject({ key: t.key, project: "WEB", description: "the brief", driver: "fake", parent: null, children: [] });
    expect(plain.transcript).toBeUndefined();
    const withTail = JSON.parse(text(await tool("get_ticket").execute({ key: t.key, include_transcript: 1 }, ctx)));
    expect(withTail.transcript).toEqual([expect.objectContaining({ role: "assistant", type: "text", text: "all done" })]);
  });
});

describe("listInbox (board)", () => {
  async function inbox() {
    const h = await setup();
    const a = (await h.orch.injectOutput("events", '{"id":"E1","assignee":"mark"}', "Dispatch mine to WEB."))!;
    const b = (await h.orch.injectOutput("jira", "WEB-9 Fix the footer"))!;
    const c = (await h.orch.injectOutput("events", "x".repeat(BOARD_TRANSCRIPT_CHARS * 2), "Dispatch mine to WEB."))!;
    await h.orch.idle();
    // Newest first even when created in the same millisecond
    h.store.sessions.update(a.id, { triageStatus: "dispatched", outcome: "Dispatched as WEB-1" });
    h.store.sessions.update(b.id, { triageStatus: "declined", outcome: "Assigned to someone else" });
    h.store.sessions.update(c.id, { triageStatus: "failed", outcome: "The triage run failed" });
    return { ...h, a, b, c };
  }

  test("newest first, with source, status, outcome and the watcher prompt; output only on request", async () => {
    const h = await inbox();
    const { items, total } = await h.orch.ops.listInbox(h.ctx("work", null), {});
    expect(total).toBe(3);
    expect(items.map((i) => i.key)).toEqual([h.c.key, h.b.key, h.a.key]);
    expect(items[2]).toMatchObject({ source: "events", status: "dispatched", outcome: "Dispatched as WEB-1", prompt: "Dispatch mine to WEB." });
    expect(items[1]).toMatchObject({ source: "jira", status: "declined", prompt: "" });
    expect(items.every((i) => i.output === undefined)).toBe(true);

    const withOutput = await h.orch.ops.listInbox(h.ctx("work", null), { output: true });
    expect(withOutput.items[2]!.output).toBe('{"id":"E1","assignee":"mark"}');
    expect(withOutput.items[0]!.output!.length).toBeLessThan(BOARD_TRANSCRIPT_CHARS + 100); // long output is cut
  });

  test("filters by status and by source (case-insensitive), and limit keeps the total", async () => {
    const h = await inbox();
    const declined = await h.orch.ops.listInbox(h.ctx("review", null), { statuses: ["declined"] });
    expect(declined.items.map((i) => i.key)).toEqual([h.b.key]);
    const events = await h.orch.ops.listInbox(h.ctx("triage", null), { source: "EVENTS" });
    expect(events.items.map((i) => i.key)).toEqual([h.c.key, h.a.key]);
    const page = await h.orch.ops.listInbox(h.ctx("plan", null), { limit: 1 });
    expect(page).toMatchObject({ total: 3, items: [{ key: h.c.key }] });

    const listInbox = allTools.find((t) => t.name === "list_inbox")!;
    const r = await listInbox.execute({ limit: 1 }, h.ctx("work", null));
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text.startsWith("Showing 1 of 3 items.")).toBe(true);
    const none = await listInbox.execute({ source: "nope" }, h.ctx("work", null));
    expect(none.content[0]).toEqual({ type: "text", text: "No Inbox items match." });
  });
});
