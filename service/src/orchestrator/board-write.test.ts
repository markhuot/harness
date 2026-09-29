// Board (write) HarnessOps against a real orchestrator: create / update / move / start / message /
// cancel / reopen as work and conductor runs see them, the guard rails (own ticket, reviews, tool
// approvals, permission modes, run kinds), and a work agent driving another card end to end.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket, TicketStatus } from "@harness/shared";
import { executeTool } from "../drivers/types";
import { createTicket as createTicketTool } from "../tools/board-write";
import { makeOrchestrator } from "../testing/fakes";
import { fakeContext, fakeSession } from "../tools/fakes";
import { toolsForRun } from "../tools";
import type { ToolContext, ToolResult } from "../tools/types";

async function setup() {
  const h = makeOrchestrator({ tools: toolsForRun });
  const project = (key: string) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    return h.orch.createProject({ path: dir, key });
  };
  const web = project("WEB");
  const api = project("API");
  const make = async (title: string, extra: { status?: TicketStatus; parentId?: string; kind?: "conductor"; projectId?: string } = {}) => {
    const t = await h.orch.createTicket({ projectId: extra.projectId ?? web.id, prompt: title, title, start: false, parentId: extra.parentId, kind: extra.kind });
    await h.orch.idle();
    if (extra.status && extra.status !== "planning") h.store.tickets.update(t.id, { status: extra.status });
    return h.store.tickets.get(t.id)!;
  };
  const ctx = (kind: RunKind, ticket: Ticket): ToolContext =>
    fakeContext({ runKind: kind, ticket, session: fakeSession({ id: ticket.sessionId, key: ticket.key, ticketId: ticket.id }), ops: h.orch.ops });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  const runKinds = (t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => r.kind);
  return { ...h, web, api, make, ctx, get, runKinds };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("create_ticket", () => {
  test("work run: a top-level ticket in planning with a plan run, on the project's driver", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.orch.ops.createTicket(h.ctx("work", me), { title: "Follow-up", description: "Fix the footer" });
    await h.orch.idle();
    const cur = h.get(t);
    expect([cur.parentId, cur.status, cur.autoStart, cur.projectId, cur.kind]).toEqual([null, "planning", false, h.web.id, "task"]);
    expect(h.runKinds(t)).toEqual(["plan"]);
  });

  test("work run: start true begins work; project_key and conductor pick another project and kind", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.orch.ops.createTicket(h.ctx("work", me), { title: "API job", description: "Split it up", projectKey: "api", conductor: true, start: true });
    expect(t.projectId).toBe(h.api.id);
    expect(t.kind).toBe("conductor");
    expect(t.parentId).toBeNull();
    await h.orch.idle();
    expect(h.runKinds(t)[0]).toBe("conductor");
  });

  test("conductor run: a child that auto-starts, on the conductor's driver and model", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { model: "fake-model" });
    const t = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", description: "do a part", autoStart: false });
    expect([t.parentId, t.autoStart, t.driver, t.model]).toEqual([c.id, false, c.driver, "fake-model"]);
    const auto = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child 2", description: "do a part" });
    expect(auto.autoStart).toBe(true);
  });

  test("use_worktree: a conductor's children follow the project unless the conductor opts out", async () => {
    const h = await setup();
    const repo = join(h.home, "proj", "repo");
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo, env });
    Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env });
    const proj = h.orch.createProject({ path: repo, key: "REPO" });
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress", projectId: proj.id });
    // Through the tool itself, so the snake_case input is what's checked.
    const create = async (input: Record<string, unknown>) => {
      const r = await executeTool([createTicketTool], "create_ticket", { description: "do a part", ...input }, h.ctx("conductor", h.get(c)));
      expect(r.isError).toBeFalsy();
      return h.store.tickets.getByKey(text(r).match(/Created (\S+)\./)![1]!)!;
    };
    const inRoot = await create({ title: "in the root", use_worktree: false });
    const followsProject = await create({ title: "follows the project" });
    await h.orch.idle();
    expect([h.get(inRoot).workdir, h.get(inRoot).branch]).toEqual([repo, null]);
    expect(h.get(followsProject).branch).toBe(`harness/${followsProject.key.toLowerCase()}`);
  });

  test("validation errors from the shared create path reach the model", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", description: "y", projectKey: "NOPE" })).rejects.toThrow("Unknown project: NOPE");
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", description: "y", dependsOn: ["WEB-99"] })).rejects.toThrow("Unknown dependency: WEB-99");
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", description: "y", driver: "nope" })).rejects.toThrow("Unknown driver: nope");
  });
});

describe("guard rails", () => {
  test("skip_agent_review: agents set it only where a human or conductor still reviews, and not mid-review", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    // Through the tool, so the snake_case input is what's checked.
    const r = await executeTool([createTicketTool], "create_ticket", { title: "Question", description: "Just answer it", skip_agent_review: true }, c);
    expect(r.isError).toBeFalsy();
    const created = h.store.tickets.getByKey(text(r).match(/Created (\S+)\./)![1]!)!;
    expect(created.skipAgentReview).toBe(true);
    expect(text(r)).toContain('"skipAgentReview": true');

    h.orch.updateProject(h.api.id, { requireHumanReview: false });
    await expect(h.orch.ops.createTicket(c, { title: "x", description: "y", projectKey: "API", skipAgentReview: true })).rejects.toThrow(
      "API doesn't require a human review, so the agent review is the only review its tickets get",
    );
    const apiTicket = await h.make("api work", { projectId: h.api.id });
    await expect(h.orch.ops.updateTicket(c, apiTicket.key, { skipAgentReview: true })).rejects.toThrow("doesn't require a human review");
    expect(h.get(apiTicket).skipAgentReview).toBe(false);

    const inReview = await h.make("in review", { status: "review" });
    await expect(h.orch.ops.updateTicket(c, inReview.key, { skipAgentReview: true })).rejects.toThrow(`${inReview.key} is in review; its reviewers decide`);
    const planned = await h.make("planned");
    expect((await h.orch.ops.updateTicket(c, planned.key, { skipAgentReview: true })).skipAgentReview).toBe(true);

    // A conductor is its child's reviewer, so it may skip the child's agent review in review too.
    const cond = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const child = await h.make("child", { parentId: cond.id, status: "review" });
    h.store.tickets.update(child.id, { agentReview: "pending" });
    const skipped = await h.orch.ops.updateTicket(h.ctx("conductor", h.get(cond)), child.key, { skipAgentReview: true });
    expect([skipped.skipAgentReview, skipped.agentReview]).toEqual([true, "skipped"]);
  });

  test("plan, review, complete and triage runs can't change the board, even calling ops directly", async () => {
    const h = await setup();
    const me = await h.make("me");
    const other = await h.make("other");
    for (const kind of ["plan", "review", "complete", "triage"] as RunKind[]) {
      await expect(h.orch.ops.createTicket(h.ctx(kind, me), { title: "x", description: "y" })).rejects.toThrow("only available in work and conductor runs");
      await expect(h.orch.ops.moveTicket(h.ctx(kind, me), other.key, "in_progress")).rejects.toThrow("only available in work and conductor runs");
    }
    expect(h.get(other).status).toBe("planning");
    expect(h.store.tickets.list({ projectId: h.web.id })).toHaveLength(2);
  });

  test("no tool acts on the caller's own ticket", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    const calls: [string, () => Promise<unknown>][] = [
      ["update_ticket", () => h.orch.ops.updateTicket(c, me.key, { title: "renamed" })],
      ["move_ticket", () => h.orch.ops.moveTicket(c, me.key, "done")],
      ["start_ticket", () => h.orch.ops.startTicket(c, me.key)],
      ["message_ticket", () => h.orch.ops.messageTicket(c, me.key, "hi")],
      ["cancel_ticket", () => h.orch.ops.cancelTicket(c, me.key.toLowerCase())],
      ["reopen_ticket", () => h.orch.ops.reopenTicket(c, me.key, "again")],
    ];
    for (const [name, call] of calls) await expect(call()).rejects.toThrow(`${me.key} is your own ticket. ${name} acts on other tickets; use block or submit_for_review`);
    expect([h.get(me).status, h.get(me).title]).toEqual(["in_progress", "me"]);
  });

  test("a conductor can't target itself either, and review/complete only reach the caller's own children", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const plain = await h.make("plain", { status: "review" });
    await expect(h.orch.ops.moveTicket(h.ctx("conductor", c), c.key, "planning")).rejects.toThrow("use submit_for_review to change your own");
    const me = await h.make("me", { status: "in_progress" });
    await expect(h.orch.ops.reviewTicket(h.ctx("work", me), plain.key, "approve", "")).rejects.toThrow(`${plain.key} is not a child of ${me.key}`);
    await expect(h.orch.ops.completeTicket(h.ctx("work", me), plain.key)).rejects.toThrow(`${plain.key} is not a child of ${me.key}`);
    // A review run can't stand in for the parent even on its own child.
    const kid = await h.make("kid", { parentId: me.id, status: "review" });
    await expect(h.orch.ops.reviewTicket(h.ctx("review", me), kid.key, "approve", "")).rejects.toThrow("only available in work and conductor runs");
    expect(h.get(plain).humanReview).toBe("pending");
    expect(h.get(kid).humanReview).toBe("pending");
  });

  test("done is only reachable from planning; review can't be entered or left by a move", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    const working = await h.make("working", { status: "in_progress" });
    const blocked = await h.make("blocked", { status: "blocked" });
    const reviewing = await h.make("reviewing", { status: "review" });
    const idea = await h.make("idea");

    await expect(h.orch.ops.moveTicket(c, working.key, "done")).rejects.toThrow("only a ticket still in planning can be moved straight to done");
    await expect(h.orch.ops.moveTicket(c, blocked.key, "done")).rejects.toThrow("only a ticket still in planning");
    await expect(h.orch.ops.moveTicket(c, working.key, "review")).rejects.toThrow("submit_for_review");
    for (const to of ["done", "in_progress", "planning", "blocked"] as TicketStatus[]) {
      await expect(h.orch.ops.moveTicket(c, reviewing.key, to)).rejects.toThrow("is in review: its reviewers decide");
    }
    expect([h.get(working).status, h.get(blocked).status, h.get(reviewing).status]).toEqual(["in_progress", "blocked", "review"]);

    const closed = await h.orch.ops.moveTicket(c, idea.key, "done");
    expect(closed.status).toBe("done");
    expect(h.runKinds(idea)).toEqual(["plan"]); // no complete run, like a drag to done
  });

  test("a message can't send another ticket back from review, except from its conductor", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const child = await h.make("child", { parentId: c.id, status: "review" });
    const me = await h.make("me", { status: "in_progress" });
    await expect(h.orch.ops.messageTicket(h.ctx("work", me), child.key, "redo it")).rejects.toThrow("is in review; messaging it would send it back");
    expect(h.get(child).status).toBe("review");
    await h.orch.ops.messageTicket(h.ctx("conductor", h.get(c)), child.key, "redo it");
    expect(h.get(child).status).toBe("in_progress");
  });

  test("a pending tool approval can't be answered, moved past, restarted or cancelled by another agent", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const waiting = await h.make("waiting", { status: "blocked", parentId: c.id });
    const approval = { id: "pa_1", runId: "run_x", toolName: "Bash", input: { command: "rm -rf build" }, requestedAt: 1 };
    h.store.tickets.update(waiting.id, { pendingApproval: approval });
    for (const ctx of [h.ctx("work", me), h.ctx("conductor", h.get(c))]) {
      await expect(h.orch.ops.messageTicket(ctx, waiting.key, "go ahead")).rejects.toThrow("waiting on a human to answer a tool approval (Bash)");
      await expect(h.orch.ops.moveTicket(ctx, waiting.key, "in_progress")).rejects.toThrow("tool approval");
      await expect(h.orch.ops.startTicket(ctx, waiting.key)).rejects.toThrow("tool approval");
      await expect(h.orch.ops.cancelTicket(ctx, waiting.key)).rejects.toThrow("tool approval");
    }
    const cur = h.get(waiting);
    expect(cur.status).toBe("blocked");
    expect(cur.pendingApproval).toEqual(approval);
    expect(cur.allowedTools).toEqual([]);
  });

  test("permission modes can be tightened, never loosened (including through inherit)", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    const t = await h.make("t"); // inherits auto from settings
    expect((await h.orch.ops.updateTicket(c, t.key, { permissionMode: "ask" })).permissionMode).toBe("ask");
    expect((await h.orch.ops.updateTicket(c, t.key, { permissionMode: "read_only" })).permissionMode).toBe("read_only");
    await expect(h.orch.ops.updateTicket(c, t.key, { permissionMode: "ask" })).rejects.toThrow("can't loosen a ticket's permission mode (WEB-2 runs in read_only; ask would be ask)");
    await expect(h.orch.ops.updateTicket(c, t.key, { permissionMode: null })).rejects.toThrow("inherit would be auto");
    expect(h.get(t).permissionMode).toBe("read_only");
    // Inheriting is fine when the project's mode is at least as strict.
    h.orch.updateProject(h.web.id, { permissionMode: "read_only" });
    expect((await h.orch.ops.updateTicket(c, t.key, { permissionMode: null })).permissionMode).toBeNull();
  });
});

describe("permission modes across tickets", () => {
  const mode = (h: Awaited<ReturnType<typeof setup>>, t: Ticket) => h.orch.permissionModeFor(h.get(t));

  test("a read_only work run's new ticket runs read_only, even when started straight away", async () => {
    const h = await setup(); // settings default: auto
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const t = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "x", description: "rm the build dir", start: true });
    expect(h.get(t).permissionMode).toBe("read_only");
    expect(mode(h, t)).toBe("read_only");
  });

  test("an ask conductor in an auto project gets ask children; equal strictness keeps inheriting", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { permissionMode: "ask" });
    const child = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", description: "part", autoStart: false });
    expect([h.get(child).permissionMode, mode(h, child)]).toEqual(["ask", "ask"]);

    h.orch.updateProject(h.web.id, { permissionMode: "ask" });
    const same = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "same", description: "part", autoStart: false });
    expect([h.get(same).permissionMode, mode(h, same)]).toEqual([null, "ask"]);

    // A stricter target project wins over a looser caller, and still by inheritance.
    const me = await h.make("me", { status: "in_progress" }); // ask via the project
    h.orch.updateProject(h.api.id, { permissionMode: "read_only" });
    const strict = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "api", description: "x", projectKey: "API" });
    expect([h.get(strict).permissionMode, mode(h, strict)]).toEqual([null, "read_only"]);
  });

  test("a stricter agent can't drive a looser ticket: message, start, reopen or move it into a run", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const c = h.ctx("work", h.get(me));
    const planning = await h.make("planning");
    const blocked = await h.make("blocked", { status: "blocked" });
    const done = await h.make("done", { status: "done" });
    const msg = "runs in auto, looser than your read_only; ask a human.";
    await expect(h.orch.ops.messageTicket(c, blocked.key, "delete X")).rejects.toThrow(`${blocked.key} ${msg}`);
    await expect(h.orch.ops.startTicket(c, planning.key)).rejects.toThrow(msg);
    await expect(h.orch.ops.reopenTicket(c, done.key, "again")).rejects.toThrow(msg);
    await expect(h.orch.ops.moveTicket(c, planning.key, "in_progress")).rejects.toThrow(msg);
    await expect(h.orch.ops.moveTicket(c, blocked.key, "planning")).rejects.toThrow(msg);
    expect([h.get(planning).status, h.get(blocked).status, h.get(done).status]).toEqual(["planning", "blocked", "done"]);
    // Moves that start nothing, and tickets at least as strict, are still fine.
    expect((await h.orch.ops.moveTicket(c, planning.key, "blocked")).status).toBe("blocked");
    h.store.tickets.update(done.id, { permissionMode: "read_only" });
    expect((await h.orch.ops.reopenTicket(c, done.key, "again")).status).toBe("in_progress");
  });

  test("a stricter agent can't edit a looser ticket, except to tighten its mode", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const c = h.ctx("work", h.get(me));
    const dep = await h.make("dep");
    h.store.tickets.update(dep.id, { permissionMode: "read_only" });
    const loose = await h.make("loose"); // auto via settings
    const msg = `${loose.key} runs in auto, looser than your read_only; ask a human.`;
    const before = h.get(loose);
    await expect(h.orch.ops.updateTicket(c, loose.key, { title: "renamed" })).rejects.toThrow(msg);
    await expect(h.orch.ops.updateTicket(c, loose.key, { description: "delete X" })).rejects.toThrow(msg);
    await expect(h.orch.ops.updateTicket(c, loose.key, { dependsOn: [dep.key] })).rejects.toThrow(msg);
    await expect(h.orch.ops.updateTicket(c, loose.key, { driver: "fake" })).rejects.toThrow(msg);
    // Bundling an edit with a tightening doesn't sneak it through.
    await expect(h.orch.ops.updateTicket(c, loose.key, { permissionMode: "read_only", description: "delete X" })).rejects.toThrow(msg);
    const after = h.get(loose);
    expect([after.title, after.description, after.dependsOn, after.driver, after.permissionMode]).toEqual([before.title, before.description, [], before.driver, null]);

    const tightened = await h.orch.ops.updateTicket(c, loose.key, { permissionMode: "ask" });
    expect(tightened.permissionMode).toBe("ask"); // still looser than read_only, but safer
    await expect(h.orch.ops.updateTicket(c, loose.key, { title: "renamed" })).rejects.toThrow("runs in ask, looser than your read_only");
    expect((await h.orch.ops.updateTicket(c, loose.key, { permissionMode: "read_only" })).permissionMode).toBe("read_only");
    // Now as strict as the caller: every field is editable again.
    const u = await h.orch.ops.updateTicket(c, loose.key, { title: "renamed", description: "new brief", dependsOn: [dep.key] });
    expect([u.title, u.description, u.dependsOn]).toEqual(["renamed", "new brief", [dep.key]]);
  });

  test("create_ticket with depends_on from a strict caller: the new ticket is never looser", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const dep = await h.make("dep"); // auto: depending on a looser ticket only waits on it
    const t = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "after", description: "x", dependsOn: [dep.key], start: true });
    expect([h.get(t).permissionMode, h.orch.permissionModeFor(h.get(t)), h.get(t).autoStart]).toEqual(["read_only", "read_only", true]);
  });

  test("an ask conductor still steers its ask children", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { permissionMode: "ask" });
    const child = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", description: "part", autoStart: false });
    h.store.tickets.update(child.id, { status: "blocked" });
    await h.orch.ops.messageTicket(h.ctx("conductor", h.get(c)), child.key, "use postgres");
    expect(h.get(child).status).toBe("in_progress");
  });
});

describe("update, move, start, cancel, reopen", () => {
  test("update_ticket edits another ticket's card through the shared validation", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const dep = await h.make("dep");
    const t = await h.make("t");
    const u = await h.orch.ops.updateTicket(h.ctx("work", me), t.key, { title: " Renamed ", description: "New brief", dependsOn: [dep.key.toLowerCase()] });
    expect([u.title, u.description, u.dependsOn]).toEqual(["Renamed", "New brief", [dep.key]]);
    expect(h.store.sessions.get(t.sessionId)!.title).toBe("Renamed");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, { dependsOn: [t.key] })).rejects.toThrow("cannot depend on itself");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, {})).rejects.toThrow("Nothing to update");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, { title: " " })).rejects.toThrow("title can't be empty");
  });

  test("move_ticket to in_progress starts a work run exactly like the board's PATCH", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const viaAgent = await h.make("same brief");
    const viaHttp = await h.make("same brief");
    await h.orch.ops.moveTicket(h.ctx("work", me), viaAgent.key, "in_progress");
    await h.orch.updateTicket(viaHttp.key, { status: "in_progress" });
    await h.orch.idle();
    expect(h.runKinds(viaAgent)).toEqual(h.runKinds(viaHttp));
    expect(h.runKinds(viaAgent)).toEqual(["plan", "work", "review"]);
    const workPrompt = (t: Ticket) => {
      const run = h.store.runs.listBySession(t.sessionId).find((r) => r.kind === "work")!;
      return h.driver.calls.find((c) => c.runId === run.id)!.prompt.replaceAll(t.key, "KEY");
    };
    expect(workPrompt(viaAgent)).toEqual(workPrompt(viaHttp));
    expect(h.get(viaAgent).status).toBe(h.get(viaHttp).status);
  });

  test("move_ticket reorders by 0-based slot within the column, and needs a change", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const [a, b, c] = [await h.make("a"), await h.make("b"), await h.make("c")];
    const order = () => h.store.tickets.list({ projectId: h.web.id, statuses: ["planning"] }).map((t) => t.title);
    expect(order()).toEqual(["a", "b", "c"]);
    await h.orch.ops.moveTicket(h.ctx("work", me), c.key, "planning", 0);
    expect(order()).toEqual(["c", "a", "b"]);
    await h.orch.ops.moveTicket(h.ctx("work", me), c.key, "planning", 1);
    expect(order()).toEqual(["a", "c", "b"]);
    await h.orch.ops.moveTicket(h.ctx("work", me), a.key, "planning", 99);
    expect(order()).toEqual(["c", "b", "a"]);
    await expect(h.orch.ops.moveTicket(h.ctx("work", me), b.key, "planning")).rejects.toThrow("already planning; pass position");
    await expect(h.orch.ops.moveTicket(h.ctx("work", me), b.key, "shipped" as TicketStatus)).rejects.toThrow("Unknown status: shipped");
    await expect(h.orch.ops.moveTicket(h.ctx("work", me), b.key, "planning", -1)).rejects.toThrow("position must be a whole number");
  });

  test("start_ticket and message_ticket work on any other ticket, not only a conductor's children", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.make("t", { projectId: h.api.id });
    const started = await h.orch.ops.startTicket(h.ctx("work", me), t.key);
    expect(started.status).toBe("in_progress");
    await h.orch.idle();
    const blocked = await h.make("blocked", { status: "blocked" });
    await h.orch.ops.messageTicket(h.ctx("work", me), blocked.key, "use postgres");
    await h.orch.idle();
    const run = h.store.runs.listBySession(blocked.sessionId).find((r) => r.kind === "work")!;
    expect(h.driver.calls.find((c) => c.runId === run.id)!.prompt).toContain("use postgres");
  });

  test("cancel_ticket aborts another ticket's run; reopen_ticket needs a done ticket and notes", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const busy = await h.orch.createTicket({ projectId: h.web.id, prompt: "long /hold" });
    while (!h.driver.holding) await Bun.sleep(2);
    await h.orch.ops.cancelTicket(h.ctx("work", me), busy.key);
    await h.orch.idle();
    expect(h.store.runs.listBySession(busy.sessionId).map((r) => `${r.kind}:${r.status}`)).toEqual(["work:cancelled"]);

    const t = await h.make("t");
    await expect(h.orch.ops.reopenTicket(h.ctx("work", me), t.key, "more")).rejects.toThrow("only done tickets can be re-opened");
    h.store.tickets.update(t.id, { status: "done" });
    await expect(h.orch.ops.reopenTicket(h.ctx("work", me), t.key, " ")).rejects.toThrow("notes are required");
    const r = await h.orch.ops.reopenTicket(h.ctx("work", me), t.key, "the footer is broken");
    expect(r.status).toBe("in_progress");
    expect(h.store.summaries.listBySession(t.sessionId).at(-1)!.body).toBe("Re-opened: the footer is broken");
  });
});

describe("end to end", () => {
  test("a work agent creates, edits and moves another ticket through the tool layer", async () => {
    const h = await setup();
    const results: string[] = [];
    let created = "";
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (req.kind !== "work" || ctx.ticket?.title !== "agent") return; // other runs end quietly (auto-submit)
      const run = async (name: string, input: unknown) => {
        const r = await executeTool(req.tools, name, input, ctx); // as a native-loop driver would
        results.push(`${name}: ${r.isError ? "error " : ""}${text(r).split("\n")[0]}`);
        return r;
      };
      const r = await run("create_ticket", { title: "Found bug", description: "The footer overlaps on mobile." });
      created = text(r).match(/Created (\S+)\./)![1]!;
      await run("update_ticket", { key: created, title: "Footer overlaps on mobile", permission_mode: "ask" });
      await run("move_ticket", { key: created, status: "in_progress" });
      await run("move_ticket", { key: ctx.ticket!.key, status: "done" }); // own ticket: refused
      await ctx.ops.submitForReview(ctx, "Filed and started a follow-up.");
    };
    const me = await h.orch.createTicket({ projectId: h.web.id, prompt: "agent", title: "agent" });
    await h.orch.idle();

    expect(results).toEqual([
      `create_ticket: Created ${created}.`,
      `update_ticket: Updated ${created}.`,
      `move_ticket: Moved ${created} (status: in_progress).`,
      `move_ticket: error ${me.key} is your own ticket. move_ticket acts on other tickets; use block or submit_for_review to change your own.`,
    ]);
    const other = h.orch.ticketDetail(created).ticket;
    expect([other.title, other.parentId, other.permissionMode]).toEqual(["Footer overlaps on mobile", null, "ask"]);
    // planning (plan run) → moved to in_progress (work run) → auto-submitted → reviewed
    expect(h.store.runs.listBySession(other.sessionId).map((r) => r.kind)).toEqual(["plan", "work", "review"]);
    expect(other.status).toBe("review");
    expect(h.orch.ticketDetail(me.key).ticket.status).toBe("review");
  });
});
