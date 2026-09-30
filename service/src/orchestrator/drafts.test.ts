// Drafts (DESIGN.md "Drafts"): a New session saved before it launches. A real planning ticket with
// `draft` set that never runs, isn't shown to agents, and is edited (kind, worktree, project) until
// POST /tickets/:key/submit launches it the way createTicket would have.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RunKind, Ticket } from "@harness/shared";
import { executeTool } from "../drivers/types";
import { makeOrchestrator } from "../testing/fakes";
import { toolsForRun } from "../tools";
import { fakeContext, fakeSession } from "../tools/fakes";
import type { ToolContext, ToolResult } from "../tools/types";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function setup() {
  const h = makeOrchestrator({ tools: toolsForRun });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  const project = (key: string, git = false) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    if (git) {
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
      Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: gitEnv });
    }
    return h.orch.createProject({ path: dir, key });
  };
  const web = project("WEB");
  const draft = (prompt = "Fix the footer", extra: Record<string, unknown> = {}) =>
    h.orch.createTicket({ projectId: web.id, prompt, draft: true, ...extra });
  const runKinds = (t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => r.kind);
  const statusLines = (t: Ticket) =>
    h.store.transcript
      .tail(t.sessionId, 50, ["status"])
      .map((e) => ("text" in e.content ? e.content.text : ""));
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  const ctx = (kind: RunKind, ticket: Ticket): ToolContext =>
    fakeContext({ runKind: kind, ticket, session: fakeSession({ id: ticket.sessionId, key: ticket.key, ticketId: ticket.id }), ops: h.orch.ops });
  return { ...h, events, project, web, draft, runKinds, statusLines, get, ctx };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("creating a draft", () => {
  test("is a planning ticket with no run, a Draft saved line, and no autoStart whatever start says", async () => {
    const h = setup();
    const t = await h.draft("Fix the footer", { start: true, autoStart: true });
    await h.orch.idle();
    expect([t.draft, t.status, t.autoStart, t.title, t.key]).toEqual([true, "planning", false, "Fix the footer", "WEB-1"]);
    expect(h.runKinds(t)).toEqual([]);
    expect(h.statusLines(t)).toEqual(["Draft saved"]);
    expect(h.driver.calls).toHaveLength(0);
  });

  test("a blank prompt is allowed only for a draft, which is then titled Untitled draft", async () => {
    const h = setup();
    const t = await h.draft("   ");
    expect(t.title).toBe("Untitled draft");
    await expect(h.orch.createTicket({ projectId: h.web.id, prompt: "  " })).rejects.toMatchObject({ status: 400 });
  });

  test("a launched ticket reports draft false", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.web.id, prompt: "real", start: false });
    expect(t.draft).toBe(false);
    await h.orch.idle();
  });

  test("a draft can't be a child, nor have children, nor be depended on", async () => {
    const h = setup();
    const parent = await h.orch.createTicket({ projectId: h.web.id, prompt: "parent", start: false });
    await expect(h.draft("child", { parentId: parent.id })).rejects.toMatchObject({ status: 400 });
    const d = await h.draft("d");
    await expect(h.orch.createTicket({ projectId: h.web.id, prompt: "kid", parentId: d.id, start: false })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.web.id, prompt: "after", dependsOn: [d.key], start: false })).rejects.toThrow(/is a draft/);
    await expect(h.orch.updateTicket(parent.key, { dependsOn: [d.key] })).rejects.toThrow(/is a draft/);
    await h.orch.idle();
  });
});

describe("submitting a draft", () => {
  test("start true: in progress with a work run on its description, keeping its board position", async () => {
    const h = setup();
    const d = await h.draft("Fix the footer");
    const later = await h.orch.createTicket({ projectId: h.web.id, prompt: "later", start: false });
    await h.orch.idle();
    const pos = h.get(d).position;
    expect(pos).toBeLessThan(later.position);
    const t = await h.orch.submitTicket(d.key, { start: true });
    await h.orch.idle();
    const cur = h.get(t);
    // The fake agent submits its work right away, so the ticket has moved on from in progress.
    expect([cur.draft, cur.status === "planning", cur.position]).toEqual([false, false, pos]);
    expect(h.runKinds(t)[0]).toBe("work");
    expect(h.driver.calls.find((c) => c.kind === "work")?.prompt).toBe("Fix the footer");
    expect(h.statusLines(t).slice(0, 2)).toEqual(["Draft saved", "Ticket created"]);
  });

  test("start false: stays in planning with a plan run", async () => {
    const h = setup();
    const d = await h.draft("Plan the footer");
    const t = await h.orch.submitTicket(d.key, { start: false });
    await h.orch.idle();
    expect([h.get(t).draft, h.get(t).status]).toEqual([false, "planning"]);
    expect(h.runKinds(t)).toEqual(["plan"]);
  });

  test("start true with an open dependency: waits (autoStart on) and starts when the dependency is done", async () => {
    const h = setup();
    const dep = await h.orch.createTicket({ projectId: h.web.id, prompt: "dep", start: false });
    await h.orch.idle();
    const d = await h.draft("after dep", { dependsOn: [dep.key] });
    const t = await h.orch.submitTicket(d.key, { start: true });
    expect([t.status, t.autoStart]).toEqual(["planning", true]);
    expect(h.statusLines(t).at(-1)).toBe(`Waiting on ${dep.key}`);
    await h.orch.updateTicket(dep.key, { status: "done" });
    await h.orch.idle();
    expect(h.runKinds(t)).toContain("work");
  });

  test("refused for a launched ticket (409), a blank draft (400) and a missing start (400)", async () => {
    const h = setup();
    const real = await h.orch.createTicket({ projectId: h.web.id, prompt: "real", start: false });
    await expect(h.orch.submitTicket(real.key, { start: true })).rejects.toMatchObject({ status: 409 });
    const blank = await h.draft("");
    await expect(h.orch.submitTicket(blank.key, { start: true })).rejects.toMatchObject({ status: 400, message: "prompt is required" });
    expect(h.get(blank).draft).toBe(true);
    const d = await h.draft("ok");
    await expect(h.orch.submitTicket(d.key, {} as never)).rejects.toMatchObject({ status: 400 });
    expect(h.get(d).draft).toBe(true);
    await h.orch.idle();
  });
});

describe("drafts never run", () => {
  test("start, status moves, messages, reviews, completion, cancel and reopen are refused with 409", async () => {
    const h = setup();
    const d = await h.draft("x");
    await expect(h.orch.startTicket(d.key)).rejects.toMatchObject({ status: 409 });
    for (const status of ["in_progress", "done", "blocked", "review"] as const) {
      await expect(h.orch.updateTicket(d.key, { status })).rejects.toMatchObject({ status: 409 });
    }
    await expect(h.orch.sendMessage(d.key, "hi")).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.sendMessage(d.key, "hi", { move: true })).rejects.toMatchObject({ status: 409 });
    expect(() => h.orch.humanReview(d.key, { decision: "approve" })).toThrow(expect.objectContaining({ status: 409 }));
    await expect(h.orch.completeTicket(d.key, { skipAgent: true })).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.cancelTicket(d.key)).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.reopenTicket(d.key, { notes: "again" })).rejects.toMatchObject({ status: 409 });
    expect(() => h.orch.rerunAgentReview(d.key)).toThrow(expect.objectContaining({ status: 409 }));
    // A PATCH that keeps its status (planning) is fine.
    expect((await h.orch.updateTicket(d.key, { status: "planning", title: "named" })).title).toBe("named");
    await h.orch.idle();
    expect([h.get(d).status, h.runKinds(d)]).toEqual(["planning", []]);
  });

  test("the scheduler skips a draft whose dependencies finish, even with autoStart set", async () => {
    const h = setup();
    const dep = await h.orch.createTicket({ projectId: h.web.id, prompt: "dep", start: false });
    await h.orch.idle();
    const d = await h.draft("after", { dependsOn: [dep.key] });
    h.store.tickets.update(d.id, { autoStart: true }); // as if an old client had set it
    const other = await h.orch.createTicket({ projectId: h.web.id, prompt: "other", dependsOn: [dep.key], start: true });
    await h.orch.updateTicket(dep.key, { status: "done" });
    await h.orch.idle();
    // The launched ticket behind the same dependency starts; the draft is left alone (no throw either).
    expect(h.runKinds(other)).toContain("work");
    expect([h.get(d).status, h.runKinds(d)]).toEqual(["planning", []]);
  });

  test("enqueueRun refuses a draft's session", async () => {
    const h = setup();
    const d = await h.draft("x");
    const enqueue = (h.orch as unknown as { enqueueRun: (s: string, k: string, p: string) => unknown }).enqueueRun.bind(h.orch);
    expect(() => enqueue(d.sessionId, "plan", "go")).toThrow(/draft/);
    expect(h.store.runs.listBySession(d.sessionId)).toEqual([]);
  });
});

describe("editing a draft", () => {
  test("kind and useWorktree: applied on a draft, 409 on a launched ticket; validated", async () => {
    const h = setup();
    const d = await h.draft("x");
    const t = await h.orch.updateTicket(d.key, { kind: "conductor", useWorktree: false });
    expect([t.kind, t.useWorktree]).toEqual(["conductor", false]);
    expect((await h.orch.updateTicket(d.key, { useWorktree: null })).useWorktree).toBeNull();
    await expect(h.orch.updateTicket(d.key, { kind: "epic" as never })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.updateTicket(d.key, { useWorktree: "yes" as never })).rejects.toMatchObject({ status: 400 });
    const real = await h.orch.createTicket({ projectId: h.web.id, prompt: "real", start: false });
    await expect(h.orch.updateTicket(real.key, { kind: "conductor" })).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.updateTicket(real.key, { useWorktree: false })).rejects.toMatchObject({ status: 409 });
    expect(h.get(real).kind).toBe("task");
    await h.orch.idle();
  });

  test("a description change re-titles a draft until it's named, never a launched ticket", async () => {
    const h = setup();
    const d = await h.draft("");
    expect((await h.orch.updateTicket(d.key, { description: "First idea\nmore" })).title).toBe("First idea");
    expect((await h.orch.updateTicket(d.key, { description: "Second idea" })).title).toBe("Second idea");
    expect(h.store.sessions.get(d.sessionId)!.title).toBe("Second idea");
    expect((await h.orch.updateTicket(d.key, { description: "" })).title).toBe("Untitled draft");
    expect((await h.orch.updateTicket(d.key, { description: "Third", title: "My name" })).title).toBe("My name");
    expect((await h.orch.updateTicket(d.key, { description: "Fourth" })).title).toBe("My name");
    const real = await h.orch.createTicket({ projectId: h.web.id, prompt: "Launched", start: false });
    expect((await h.orch.updateTicket(real.key, { description: "Changed brief" })).title).toBe("Launched");
    await h.orch.idle();
  });

  test("turning the worktree off clears a requested branch; a branch needs a worktree and git", async () => {
    const h = setup();
    const repo = h.project("REPO", true);
    const d = await h.orch.createTicket({ projectId: repo.id, prompt: "x", draft: true, branch: "feature/x", baseBranch: "main" });
    expect(d.requestedBranch).toBe("feature/x");
    const off = await h.orch.updateTicket(d.key, { useWorktree: false });
    expect([off.useWorktree, off.requestedBranch, off.baseBranch]).toEqual([false, null, "main"]);
    await expect(h.orch.updateTicket(d.key, { branch: "feature/y" })).rejects.toMatchObject({ status: 400 });
    const on = await h.orch.updateTicket(d.key, { useWorktree: true, branch: "feature/y" });
    expect([on.useWorktree, on.requestedBranch]).toEqual([true, "feature/y"]);
    // Not a git project: no branch, whatever the worktree says.
    const plain = await h.draft("y", { useWorktree: true });
    await expect(h.orch.updateTicket(plain.key, { branch: "feature/z" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("moving a draft to another project", () => {
  test("takes the other project's next key, keeps the old one as an alias, resets branch choices", async () => {
    const h = setup();
    const repo = h.project("REPO", true);
    const api = h.project("API", true);
    await h.orch.createTicket({ projectId: api.id, prompt: "existing", start: false });
    await h.orch.idle();
    const d = await h.orch.createTicket({ projectId: repo.id, prompt: "move me", draft: true, branch: "feature/x", baseBranch: "main", useWorktree: true });
    expect(d.key).toBe("REPO-1");
    h.events.length = 0;
    const moved = await h.orch.updateTicket(d.key, { projectId: api.id });
    expect([moved.id, moved.key, moved.projectId, moved.draft]).toEqual([d.id, "API-2", api.id, true]);
    expect([moved.requestedBranch, moved.baseBranch, moved.useWorktree]).toEqual([null, null, null]);
    expect(moved.position).toBeGreaterThan(h.store.tickets.getByKey("API-1")!.position);
    // The old key resolves to the moved ticket (like a project rename), and the session follows.
    const detail = h.orch.ticketDetail("REPO-1");
    expect([detail.ticket.id, detail.ticket.key, detail.resolvedFrom]).toEqual([d.id, "API-2", "REPO-1"]);
    expect([detail.session.key, detail.session.cwd]).toEqual(["API-2", api.path]);
    // Both projects' nextSeq moved on or stayed, and clients hear about both, the ticket and its session.
    expect(h.store.projects.get(api.id)!.nextSeq).toBe(3);
    const upserted = (kind: HarnessEvent["kind"]) => h.events.filter((e) => e.kind === kind);
    expect(upserted("project.upserted").map((e) => (e as { project: { id: string } }).project.id).sort()).toEqual([api.id, repo.id].sort());
    expect(upserted("ticket.upserted").some((e) => (e as { ticket: Ticket }).ticket.key === "API-2")).toBe(true);
    expect(upserted("session.upserted").some((e) => (e as { session: { key: string } }).session.key === "API-2")).toBe(true);
    // A new REPO ticket doesn't reuse REPO-1 (the number is spent), so the alias stays unambiguous.
    const next = await h.orch.createTicket({ projectId: repo.id, prompt: "next", draft: true });
    expect(next.key).toBe("REPO-2");
  });

  test("a move and a branch in one PATCH: the branch is checked against the new project", async () => {
    const h = setup();
    const repo = h.project("REPO", true);
    const d = await h.draft("x"); // WEB isn't a git project
    const moved = await h.orch.updateTicket(d.key, { projectId: repo.id, branch: "feature/new" });
    expect([moved.key, moved.requestedBranch]).toEqual(["REPO-1", "feature/new"]);
    const back = h.orch.ticketDetail("WEB-1");
    expect(back.ticket.id).toBe(d.id);
  });

  test("refused for a launched ticket (409) and an unknown project (404); a failed PATCH doesn't move it", async () => {
    const h = setup();
    const api = h.project("API");
    const real = await h.orch.createTicket({ projectId: h.web.id, prompt: "real", start: false });
    await expect(h.orch.updateTicket(real.key, { projectId: api.id })).rejects.toMatchObject({ status: 409 });
    const d = await h.draft("x");
    await expect(h.orch.updateTicket(d.key, { projectId: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(h.orch.updateTicket(d.key, { projectId: api.id, driver: "no-such-driver" })).rejects.toMatchObject({ status: 400 });
    expect([h.get(d).key, h.get(d).projectId]).toEqual([d.key, h.web.id]);
    expect(h.store.projects.get(api.id)!.nextSeq).toBe(1);
    await h.orch.idle();
  });

  test("submitting under the new key launches it there", async () => {
    const h = setup();
    const api = h.project("API");
    const d = await h.draft("go");
    await h.orch.updateTicket(d.key, { projectId: api.id });
    const t = await h.orch.submitTicket("WEB-1", { start: false }); // the old key still works
    await h.orch.idle();
    expect([t.key, t.draft, h.runKinds(t)]).toEqual(["API-1", false, ["plan"]]);
  });
});

describe("agents don't see drafts", () => {
  test("list_tickets, search_tickets and get_ticket leave drafts out; acting on one is unknown", async () => {
    const h = setup();
    const me = await h.orch.createTicket({ projectId: h.web.id, prompt: "me footer", start: false });
    await h.orch.idle();
    h.store.tickets.update(me.id, { status: "in_progress" });
    const d = await h.draft("secret footer");
    const c = h.ctx("work", h.get(me));
    for (const scope of ["project", "all"] as const) {
      const list = await h.orch.ops.listTickets(c, { scope });
      expect(list.tickets.map((t) => t.key)).toEqual([me.key]);
      expect(list.total).toBe(1);
    }
    const hits = await h.orch.ops.searchTickets(c, { query: "footer" });
    expect(hits.hits.map((x) => x.ticket.key)).toEqual([me.key]);
    expect(hits.total).toBe(1);
    await expect(h.orch.ops.getTicket(c, d.key)).rejects.toThrow(/Unknown ticket/);
    await expect(h.orch.ops.messageTicket(c, d.key, "hi")).rejects.toThrow(/Unknown ticket/);
    await expect(h.orch.ops.startTicket(c, d.key)).rejects.toThrow(/Unknown ticket/);
    await expect(h.orch.ops.moveTicket(c, d.key, "in_progress")).rejects.toThrow(/Unknown ticket/);
    await expect(h.orch.ops.updateTicket(c, d.key, { title: "x" })).rejects.toThrow(/Unknown ticket/);
    await expect(h.orch.ops.createTicket(c, { title: "after", description: "after", dependsOn: [d.key] })).rejects.toThrow(/is a draft/);
    // Through the MCP tool too, as the agent calls it.
    const r = await executeTool(toolsForRun("work", h.driver), "get_ticket", { key: d.key }, c);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown ticket/);
    // Humans still see it.
    expect(h.orch.listTickets(h.web.id).map((t) => t.key)).toContain(d.key);
    expect(h.orch.searchTickets({ q: "secret" }).tickets.map((t) => t.key)).toEqual([d.key]);
    // Once submitted, agents see it.
    await h.orch.submitTicket(d.key, { start: false });
    expect((await h.orch.ops.getTicket(c, d.key)).ticket.key).toBe(d.key);
    await h.orch.idle();
  });

  test("triage can't dispatch into a draft by its key", async () => {
    const h = setup();
    const d = await h.draft("secret");
    let prompt = "";
    let error = "";
    h.driver.script = async function* (req) {
      if (req.kind !== "triage") return;
      prompt = req.prompt;
      await req.toolContext.ops
        .dispatchTicket(req.toolContext, { projectKey: "WEB", key: d.key, title: "t", description: "update" })
        .catch((err: Error) => (error = err.message));
    };
    h.orch.triage({ source: "jira", output: { text: `about ${d.key}`, truncated: false }, prompt: "", driver: h.driver.id });
    await h.orch.idle();
    // The draft isn't offered as an existing ticket, and dispatching under its key doesn't reach it.
    expect(prompt).toContain(d.key);
    expect(prompt).not.toContain("secret");
    expect(error).toMatch(/already exists/);
    expect(h.store.transcript.tail(d.sessionId, 50, ["text"]).length).toBe(0);
    expect(h.get(d).draft).toBe(true);
  });
});
