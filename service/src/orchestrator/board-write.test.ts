// Board (write) HarnessOps against a real orchestrator: create / update / move / start / message /
// cancel / reopen as work and conductor runs see them, the guard rails (own ticket, reviews, tool
// approvals, permission modes, run kinds), and a work agent driving another card end to end.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket, TicketStatus } from "@harness/shared";
import { executeTool } from "../drivers/types";
import { createTicket as createTicketTool, updateTicket as updateTicketTool } from "../tools/board-write";
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
    const t = await h.orch.createTicket({ projectId: extra.projectId ?? web.id, spec: title, title, start: false, parentId: extra.parentId, kind: extra.kind });
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
    const t = await h.orch.ops.createTicket(h.ctx("work", me), { title: "Follow-up", spec: "Fix the footer" });
    await h.orch.idle();
    const cur = h.get(t);
    expect([cur.parentId, cur.status, cur.autoStart, cur.projectId, cur.kind]).toEqual([null, "planning", false, h.web.id, "task"]);
    expect(h.runKinds(t)).toEqual(["plan"]);
  });

  test("work run: start true begins work; project_key and conductor pick another project and kind", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.orch.ops.createTicket(h.ctx("work", me), { title: "API job", spec: "Split it up", projectKey: "api", conductor: true, start: true });
    expect(t.projectId).toBe(h.api.id);
    expect(t.kind).toBe("conductor");
    expect(t.parentId).toBeNull();
    await h.orch.idle();
    expect(h.runKinds(t)[0]).toBe("conductor");
  });

  test("conductor run: a child that auto-starts, on the conductor's driver and model", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { phaseModels: { work: { driver: c.driver, model: "fake-model" } } });
    const t = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", spec: "do a part", autoStart: false });
    expect([t.parentId, t.autoStart, t.driver, t.model]).toEqual([c.id, false, c.driver, "fake-model"]);
    const auto = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child 2", spec: "do a part" });
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
      const r = await executeTool([createTicketTool], "create_ticket", { spec: "do a part", ...input }, h.ctx("conductor", h.get(c)));
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
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", spec: "y", projectKey: "NOPE" })).rejects.toThrow("Unknown project: NOPE");
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", spec: "y", dependsOn: ["WEB-99"] })).rejects.toThrow("Unknown dependency: WEB-99");
    await expect(h.orch.ops.createTicket(h.ctx("work", me), { title: "x", spec: "y", driver: "nope" })).rejects.toThrow("Unknown driver: nope");
  });
});

describe("guard rails", () => {
  test("skip_agent_review: agents set it on create and update, but not mid-review", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    // Through the tool, so the snake_case input is what's checked.
    const r = await executeTool([createTicketTool], "create_ticket", { title: "Question", spec: "Just answer it", skip_agent_review: true }, c);
    expect(r.isError).toBeFalsy();
    const created = h.store.tickets.getByKey(text(r).match(/Created (\S+)\./)![1]!)!;
    expect(created.skipAgentReview).toBe(true);
    expect(text(r)).toContain('"skipAgentReview": true');

    // On top of a project default that skips the human review, the ticket skips both.
    h.orch.updateProject(h.api.id, { skipHumanReview: true });
    const unreviewed = await h.orch.ops.createTicket(c, { title: "x", spec: "y", projectKey: "API", skipAgentReview: true });
    expect([unreviewed.skipAgentReview, unreviewed.skipHumanReview]).toEqual([true, true]);
    const apiTicket = await h.make("api work", { projectId: h.api.id });
    expect(apiTicket.skipHumanReview).toBe(true);
    expect((await h.orch.ops.updateTicket(c, apiTicket.key, { skipAgentReview: true })).skipAgentReview).toBe(true);

    const inReview = await h.make("in review", { status: "review" });
    await expect(h.orch.ops.updateTicket(c, inReview.key, { skipAgentReview: true })).rejects.toThrow(`${inReview.key} is in review; its reviewers decide`);
    expect(h.get(inReview).skipAgentReview).toBe(false);

    // A conductor is its child's reviewer, so it may skip the child's agent review in review too.
    const cond = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const child = await h.make("child", { parentId: cond.id, status: "review" });
    h.store.tickets.update(child.id, { agentReview: "pending" });
    const skipped = await h.orch.ops.updateTicket(h.ctx("conductor", h.get(cond)), child.key, { skipAgentReview: true });
    expect([skipped.skipAgentReview, skipped.agentReview]).toEqual([true, "skipped"]);
  });

  test("skip_human_review: agents may skip both reviews when asked, in one call or across two, but not mid-review", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const c = h.ctx("work", me);
    const r = await executeTool([createTicketTool], "create_ticket", { title: "Land it", spec: "Merge once reviewed", skip_human_review: true }, c);
    expect(r.isError).toBeFalsy();
    const created = h.store.tickets.getByKey(text(r).match(/Created (\S+)\./)![1]!)!;
    expect([created.skipHumanReview, created.skipAgentReview]).toEqual([true, false]);
    expect(text(r)).toContain('"skipHumanReview": true');

    const both = await executeTool([createTicketTool], "create_ticket", { title: "x", spec: "y", skip_agent_review: true, skip_human_review: true }, c);
    expect(both.isError).toBeFalsy();
    const bothTicket = h.store.tickets.getByKey(text(both).match(/Created (\S+)\./)![1]!)!;
    expect([bothTicket.skipAgentReview, bothTicket.skipHumanReview]).toEqual([true, true]);
    const noBot = await h.make("no bot");
    await h.orch.ops.updateTicket(c, noBot.key, { skipAgentReview: true });
    expect((await h.orch.ops.updateTicket(c, noBot.key, { skipHumanReview: true })).skipHumanReview).toBe(true);
    // Turning a skip off is allowed too.
    expect((await h.orch.ops.updateTicket(c, created.key, { skipHumanReview: false })).skipHumanReview).toBe(false);

    const inReview = await h.make("in review", { status: "review" });
    await expect(h.orch.ops.updateTicket(c, inReview.key, { skipHumanReview: true })).rejects.toThrow(`${inReview.key} is in review; its reviewers decide`);
  });

  test("a plan run's update_ticket edits its own ticket, every field, looser permission mode included", async () => {
    const h = await setup();
    // A branch needs a git repository to land in.
    expect(Bun.spawnSync(["git", "init", "-q", h.web.path]).exitCode).toBe(0);
    const dep = await h.make("dep");
    h.orch.updateProject(h.web.id, { permissionMode: "read_only" });
    const me = await h.make("me");
    expect(h.orch.ticketDetail(me.key).ticket.permissionMode).toBeNull();
    const c = h.ctx("plan", me);
    // Through the tool, as a planning agent applying `/depends: … /branch: … /skip-*` from the brief.
    const r = await executeTool(
      [updateTicketTool],
      "update_ticket",
      { key: me.key, title: "Renamed", depends_on: [dep.key], branch: "feature/x", base_branch: "develop", model: "fake-model", permission_mode: "auto", skip_agent_review: true, skip_human_review: true },
      c,
    );
    expect(text(r)).toStartWith(`Updated ${me.key}.`);
    const cur = h.get(me);
    expect([cur.title, cur.dependsOn, cur.requestedBranch, cur.baseBranch, cur.model, cur.permissionMode, cur.skipAgentReview, cur.skipHumanReview, cur.status]).toEqual([
      "Renamed",
      [dep.key],
      "feature/x",
      "develop",
      "fake-model",
      "auto",
      true,
      true,
      "planning",
    ]);
    // Dependency rules still hold on its own ticket.
    await expect(h.orch.ops.updateTicket(c, me.key, { dependsOn: [me.key] })).rejects.toThrow("cannot depend on itself");
    expect(h.get(me).dependsOn).toEqual([dep.key]);
  });

  test("end to end: a planning agent applies the brief's settings to its ticket before the human presses Start", async () => {
    const h = await setup();
    const dep = await h.make("dep");
    const t = await h.make(`Cut a release\n/depends: ${dep.key}\n/skip-human-review\n/skip-agent-review\n/set-ticket {"depends_on":["${dep.key}"],"skip_agent_review":true,"skip_human_review":true}`);
    expect(h.runKinds(t)).toEqual(["plan"]);
    const cur = h.get(t);
    expect([cur.status, cur.dependsOn, cur.skipAgentReview, cur.skipHumanReview, cur.spec]).toEqual(["planning", [dep.key], true, true, "1. Do Cut a release"]);
    const said = h.store.transcript.list(t.sessionId).flatMap((e) => (e.content.type === "text" ? [(e.content as { text: string }).text] : []));
    expect(said.some((x) => x.startsWith(`Updated ${t.key}.`))).toBe(true);
  });

  test("a plan run's update_ticket can't reach another ticket, and a work run still can't edit its own", async () => {
    const h = await setup();
    const me = await h.make("me");
    const other = await h.make("other");
    await expect(h.orch.ops.updateTicket(h.ctx("plan", me), other.key, { title: "hijacked" })).rejects.toThrow(`In a planning run, update_ticket only edits your own ticket (${me.key})`);
    await expect(h.orch.ops.updateTicket(h.ctx("plan", me), "WEB-99", { title: "nope" })).rejects.toThrow("only edits your own ticket");
    expect(h.get(other).title).toBe("other");
    h.store.tickets.update(me.id, { status: "in_progress" });
    await expect(h.orch.ops.updateTicket(h.ctx("work", h.get(me)), me.key, { title: "renamed" })).rejects.toThrow(`${me.key} is your own ticket`);
    expect(h.get(me).title).toBe("me");
    // Plan runs are offered update_ticket and no other board write.
    const offered = toolsForRun("plan", { hasBuiltinTools: true, usesPermissionPromptTool: false }).map((t) => t.name);
    expect(offered).toContain("update_ticket");
    for (const name of ["create_ticket", "move_ticket", "start_ticket", "message_ticket", "cancel_ticket", "reopen_ticket"]) expect(offered).not.toContain(name);
  });

  test("plan, review, complete and triage runs can't change the board, even calling ops directly", async () => {
    const h = await setup();
    const me = await h.make("me");
    const other = await h.make("other");
    for (const kind of ["plan", "review", "complete", "triage"] as RunKind[]) {
      await expect(h.orch.ops.createTicket(h.ctx(kind, me), { title: "x", spec: "y" })).rejects.toThrow("only available in work, conductor and chat runs");
      await expect(h.orch.ops.moveTicket(h.ctx(kind, me), other.key, "in_progress")).rejects.toThrow("only available in work, conductor and chat runs");
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
    await expect(h.orch.ops.reviewTicket(h.ctx("review", me), kid.key, "approve", "")).rejects.toThrow("only available in work, conductor and chat runs");
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

  test("a message to a ticket in review leaves it in review, from any agent: its reviewers decide", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const child = await h.make("child", { parentId: c.id, status: "review" });
    const me = await h.make("me", { status: "in_progress" });
    await h.orch.ops.messageTicket(h.ctx("work", me), child.key, "why this approach?");
    expect(h.get(child).status).toBe("review");
    await h.orch.ops.messageTicket(h.ctx("conductor", h.get(c)), child.key, "and this one?");
    expect(h.get(child).status).toBe("review");
    await h.orch.idle();
    expect(h.store.runs.listBySession(child.sessionId).map((r) => r.kind).slice(-2)).toEqual(["chat", "chat"]);
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
      await expect(h.orch.ops.moveTicket(ctx, waiting.key, "planning")).rejects.toThrow("tool approval");
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
    const t = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "x", spec: "rm the build dir", start: true });
    expect(h.get(t).permissionMode).toBe("read_only");
    expect(mode(h, t)).toBe("read_only");
  });

  test("an ask conductor in an auto project gets ask children; equal strictness keeps inheriting", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { permissionMode: "ask" });
    const child = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", spec: "part", autoStart: false });
    expect([h.get(child).permissionMode, mode(h, child)]).toEqual(["ask", "ask"]);

    h.orch.updateProject(h.web.id, { permissionMode: "ask" });
    const same = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "same", spec: "part", autoStart: false });
    expect([h.get(same).permissionMode, mode(h, same)]).toEqual([null, "ask"]);

    // A stricter target project wins over a looser caller, and still by inheritance.
    const me = await h.make("me", { status: "in_progress" }); // ask via the project
    h.orch.updateProject(h.api.id, { permissionMode: "read_only" });
    const strict = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "api", spec: "x", projectKey: "API" });
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
    await expect(h.orch.ops.moveTicket(c, planning.key, "in_progress")).rejects.toThrow("doesn't start it");
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
    await expect(h.orch.ops.updateTicket(c, loose.key, { spec: "delete X" })).rejects.toThrow(msg);
    await expect(h.orch.ops.updateTicket(c, loose.key, { dependsOn: [dep.key] })).rejects.toThrow(msg);
    await expect(h.orch.ops.updateTicket(c, loose.key, { driver: "fake" })).rejects.toThrow(msg);
    // Bundling an edit with a tightening doesn't sneak it through.
    await expect(h.orch.ops.updateTicket(c, loose.key, { permissionMode: "read_only", spec: "delete X" })).rejects.toThrow(msg);
    const after = h.get(loose);
    expect([after.title, after.spec, after.dependsOn, after.driver, after.permissionMode]).toEqual([before.title, before.spec, [], before.driver, null]);

    const tightened = await h.orch.ops.updateTicket(c, loose.key, { permissionMode: "ask" });
    expect(tightened.permissionMode).toBe("ask"); // still looser than read_only, but safer
    await expect(h.orch.ops.updateTicket(c, loose.key, { title: "renamed" })).rejects.toThrow("runs in ask, looser than your read_only");
    expect((await h.orch.ops.updateTicket(c, loose.key, { permissionMode: "read_only" })).permissionMode).toBe("read_only");
    // Now as strict as the caller: every field is editable again.
    const u = await h.orch.ops.updateTicket(c, loose.key, { title: "renamed", spec: "new brief", baseRevision: h.get(loose).specRevision, dependsOn: [dep.key] });
    expect([u.title, u.spec, u.dependsOn]).toEqual(["renamed", "new brief", [dep.key]]);
  });

  test("create_ticket with depends_on from a strict caller: the new ticket is never looser", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const dep = await h.make("dep"); // auto: depending on a looser ticket only waits on it
    const t = await h.orch.ops.createTicket(h.ctx("work", h.get(me)), { title: "after", spec: "x", dependsOn: [dep.key], start: true });
    expect([h.get(t).permissionMode, h.orch.permissionModeFor(h.get(t)), h.get(t).autoStart]).toEqual(["read_only", "read_only", true]);
  });

  test("an ask conductor still steers its ask children", async () => {
    const h = await setup();
    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    h.store.tickets.update(c.id, { permissionMode: "ask" });
    const child = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "child", spec: "part", autoStart: false });
    h.store.tickets.update(child.id, { status: "blocked" });
    await h.orch.ops.messageTicket(h.ctx("conductor", h.get(c)), child.key, "use postgres");
    // The child's agent gets the answer (a chat) and moves the ticket on itself.
    expect(h.get(child).status).toBe("blocked");
    expect(h.store.runs.listBySession(child.sessionId).map((r) => r.kind).at(-1)).toBe("chat");
  });
});

describe("update, move, start, cancel, reopen", () => {
  test("update_ticket edits another ticket's card through the shared validation", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const dep = await h.make("dep");
    const t = await h.make("t");
    const u = await h.orch.ops.updateTicket(h.ctx("work", me), t.key, { title: " Renamed ", spec: "New brief", baseRevision: h.get(t).specRevision, dependsOn: [dep.key.toLowerCase()] });
    expect([u.title, u.spec, u.dependsOn]).toEqual(["Renamed", "New brief", [dep.key]]);
    expect(h.store.sessions.get(t.sessionId)!.title).toBe("Renamed");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, { dependsOn: [t.key] })).rejects.toThrow("cannot depend on itself");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, {})).rejects.toThrow("Nothing to update");
    await expect(h.orch.ops.updateTicket(h.ctx("work", me), t.key, { title: " " })).rejects.toThrow("title can't be empty");
  });

  test("move_ticket and PATCH refuse in_progress: Start is the only way to begin work", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const planned = await h.make("planned");
    const blocked = await h.make("blocked", { status: "blocked" });
    const done = await h.make("done", { status: "done" });
    await h.orch.idle();
    for (const t of [planned, blocked, done]) {
      await expect(h.orch.ops.moveTicket(h.ctx("work", me), t.key, "in_progress")).rejects.toThrow("start_ticket");
      await expect(h.orch.updateTicket(t.key, { status: "in_progress" })).rejects.toThrow("/start");
      expect(h.get(t).status).toBe(t.status);
    }
    // Nothing started: no work run on any of them.
    expect([planned, blocked, done].flatMap((t) => h.runKinds(t)).filter((k) => k === "work")).toEqual([]);
    // Start (the agent tool) is how it begins.
    await h.orch.ops.startTicket(h.ctx("work", me), planned.key);
    await h.orch.idle();
    expect(h.runKinds(planned)).toContain("work");
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
    const run = h.store.runs.listBySession(blocked.sessionId).find((r) => r.kind === "chat")!;
    expect(h.driver.calls.find((c) => c.runId === run.id)!.prompt).toContain("use postgres");
  });

  test("cancel_ticket aborts another ticket's run; reopen_ticket needs a done ticket and notes", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const busy = await h.orch.createTicket({ projectId: h.web.id, spec: "long /hold" });
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
    expect(h.store.activity.listBySession(t.sessionId).at(-1)).toMatchObject({ kind: "reopened", body: "the footer is broken" });
  });
});

describe("remote IDs (remote_id / remote_url)", () => {
  const tools = [createTicketTool, updateTicketTool];

  test("create_ticket links the new ticket, a top-level one or a conductor's child, to a manual remote ID", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const r = await executeTool(tools, "create_ticket", { title: "Hero", spec: "Dress the hero", remote_id: " rfawc-726 ", remote_url: "https://jira.test/browse/RFAWC-726" }, h.ctx("work", me));
    expect(r.isError).toBeFalsy();
    const key = text(r).match(/Created (\S+)\./)![1]!;
    expect(key).toMatch(/^WEB-\d+$/); // a native key: the remote ID never becomes the ticket's key
    expect(text(r)).toContain('"externalKey": "RFAWC-726"');
    expect(h.orch.ticketDetail(key).ticket.externalRef).toEqual({ source: "manual", key: "RFAWC-726", url: "https://jira.test/browse/RFAWC-726", raw: null });

    const c = await h.make("conduct", { kind: "conductor", status: "in_progress" });
    const child = await h.orch.ops.createTicket(h.ctx("conductor", h.get(c)), { title: "part", spec: "a part", remoteId: "RFAWC-727" });
    expect([child.parentId, child.externalRef?.key, child.externalRef?.url]).toEqual([c.id, "RFAWC-727", null]);
    // Blank strings through the tool mean "no remote ID", not a validation error.
    const plain = await executeTool(tools, "create_ticket", { title: "Plain", spec: "No item", remote_id: " ", remote_url: "" }, h.ctx("work", me));
    expect(h.orch.ticketDetail(text(plain).match(/Created (\S+)\./)![1]!).ticket.externalRef).toBeNull();
  });

  test("create_ticket refuses a bad remote ID or link before creating anything", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const before = h.orch.listTickets().length;
    const create = (input: Record<string, unknown>) => executeTool(tools, "create_ticket", { title: "x", spec: "y", ...input }, h.ctx("work", me));
    expect(text(await create({ remote_id: "not a key" }))).toContain("Invalid remote ID: not a key");
    expect(text(await create({ remote_id: "FOO-1", remote_url: "ftp://x/FOO-1" }))).toContain("must be an http(s) link");
    expect(text(await create({ remote_url: "https://x/FOO-1" }))).toContain("remote_url needs remote_id");
    expect(h.orch.listTickets().length).toBe(before);
  });

  test("update_ticket links, re-links, changes or clears the link, and unlinks", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.make("t");
    const update = async (input: Record<string, unknown>) => {
      const r = await executeTool(tools, "update_ticket", { key: t.key, ...input }, h.ctx("work", me));
      if (r.isError) throw new Error(text(r));
      return h.get(t).externalRef;
    };
    await expect(update({ remote_url: "https://x/FOO-1" })).rejects.toThrow(`${t.key} has no remote ID to change the link of`);
    expect(await update({ remote_id: "foo-1", remote_url: "https://x/FOO-1" })).toEqual({ source: "manual", key: "FOO-1", url: "https://x/FOO-1", raw: null });
    // The same remote ID again keeps its link; a different one doesn't carry the old item's link over.
    expect((await update({ remote_id: "FOO-1" }))?.url).toBe("https://x/FOO-1");
    expect(await update({ remote_url: "https://x/browse/FOO-1" })).toMatchObject({ key: "FOO-1", url: "https://x/browse/FOO-1" });
    expect(await update({ remote_url: "" })).toMatchObject({ key: "FOO-1", url: null });
    expect(await update({ remote_id: "BAR-2" })).toMatchObject({ key: "BAR-2", url: null });
    await expect(update({ remote_id: "", remote_url: "https://x" })).rejects.toThrow("remote_url can't be set while unlinking");
    expect(await update({ remote_id: "" })).toBeNull();
    const status = h.store.transcript.tail(t.sessionId, 50, ["status"]).map((e) => (e.content.type === "status" ? e.content.text : ""));
    expect(status).toEqual(expect.arrayContaining(["Linked to FOO-1", "Linked to BAR-2", "Unlinked from BAR-2"]));
  });

  test("update_ticket keeps a watcher's link source when only the URL changes", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    const t = await h.make("t");
    h.store.tickets.setExternalRef(t.id, { source: "jira", key: "FOO-9", url: null, raw: { id: 9 } });
    const u = await h.orch.ops.updateTicket(h.ctx("work", me), t.key, { remoteUrl: "https://x/FOO-9" });
    expect(u.externalRef).toEqual({ source: "jira", key: "FOO-9", url: "https://x/FOO-9", raw: { id: 9 } });
  });

  test("a stricter agent can't relink a looser ticket", async () => {
    const h = await setup();
    const me = await h.make("me", { status: "in_progress" });
    h.store.tickets.update(me.id, { permissionMode: "read_only" });
    const t = await h.make("t");
    await expect(h.orch.ops.updateTicket(h.ctx("work", h.get(me)), t.key, { remoteId: "FOO-1" })).rejects.toThrow("looser than your read_only");
    expect(h.get(t).externalRef).toBeNull();
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
      const r = await run("create_ticket", { title: "Found bug", spec: "The footer overlaps on mobile." });
      created = text(r).match(/Created (\S+)\./)![1]!;
      await run("update_ticket", { key: created, title: "Footer overlaps on mobile", permission_mode: "ask" });
      await run("start_ticket", { key: created });
      await run("move_ticket", { key: ctx.ticket!.key, status: "done" }); // own ticket: refused
      await ctx.ops.submitForReview(ctx, "Filed and started a follow-up.", true);
    };
    const me = await h.orch.createTicket({ projectId: h.web.id, spec: "agent", title: "agent" });
    await h.orch.idle();

    expect(results).toEqual([
      `create_ticket: Created ${created}.`,
      `update_ticket: Updated ${created}.`,
      `start_ticket: Started ${created} (status: in_progress).`,
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
