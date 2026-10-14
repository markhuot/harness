// Branches (DESIGN.md "Branches") against memory git: base branch resolution and validation,
// where a ticket's worktree branch starts, a chosen branch, blocking when git can't give the
// ticket its branch, update_branch re-pointing, the branch list, and what completion is told.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket } from "@harness/shared";
import { HarnessError } from "../../service/src/orchestrator/errors";
import { fakeContext, fakeSession } from "../../service/src/tools/fakes";
import type { ToolContext } from "../../service/src/tools/types";
import { createService } from "../support/service";

/** A harness with a git repo (main + one commit) as project REPO. */
async function setup(opts: { init?: string; baseBranch?: string | null; useWorktrees?: boolean } = {}) {
  const h = createService();
  const repo = join(h.home, "repo");
  h.git.initRepo(repo, opts.init ?? "main");
  const project = h.orch.createProject({ path: repo, key: "repo", baseBranch: opts.baseBranch, useWorktrees: opts.useWorktrees });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  const ctx = (kind: RunKind, t: Ticket): ToolContext =>
    fakeContext({ runKind: kind, ticket: get(t), session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
  /** The commit `ref` names, seen from `dir` (HEAD: what `dir` has checked out). */
  const rev = async (ref: string, dir = repo) => (ref === "HEAD" ? h.git.port.headCommit(dir) : h.git.port.resolveCommit(dir, ref));
  return { ...h, repo, project, get, ctx, rev };
}

/** A commit on `branch` (created from `from` when given) without touching the main checkout. */
async function commitOn(h: Awaited<ReturnType<typeof setup>>, branch: string, from?: string) {
  if (from) h.git.createBranch(h.repo, branch, from);
  h.git.commitOnBranch(h.repo, branch);
  return (await h.rev(branch))!;
}

const expectHttp = (fn: () => unknown, status: number, match: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).status).toBe(status);
    expect((err as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected it to throw");
};

describe("base branch settings", () => {
  test("defaults to main; settings, projects and tickets refuse names git would refuse", async () => {
    const h = await setup();
    expect(h.orch.publicSettings().baseBranch).toBe("main");
    expect(h.orch.updateSettings({ baseBranch: "develop" }).baseBranch).toBe("develop");
    expectHttp(() => h.orch.updateSettings({ baseBranch: "bad name" }), 400, /isn't a valid branch name/);
    expectHttp(() => h.orch.updateSettings({ baseBranch: "" }), 400, /must be a branch name/);
    expectHttp(() => h.orch.updateProject(h.project.id, { baseBranch: "x..y" }), 400, /can't contain \.\./);
    expect(h.orch.updateProject(h.project.id, { baseBranch: " release " }).baseBranch).toBe("release");
    expect(h.orch.updateProject(h.project.id, { baseBranch: "" }).baseBranch).toBeNull();
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", baseBranch: "-x", start: false })).rejects.toThrow(/can't start with -/);
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", branch: "a b", start: false })).rejects.toThrow(/isn't a valid branch name/);
  });

  test("ticket beats project beats settings; the stored setting survives a reload", async () => {
    const h = await setup();
    h.orch.updateSettings({ baseBranch: "develop" });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.idle();
    h.git.createBranch(h.repo, "develop");
    expect(await h.orch.refreshBaseBranch(h.get(t))).toEqual({ branch: "develop", source: "settings" });
    h.orch.updateProject(h.project.id, { baseBranch: "staging" });
    expect(await h.orch.refreshBaseBranch(h.get(t))).toEqual({ branch: "staging", source: "project" });
    await h.orch.updateTicket(t.key, { baseBranch: "release" });
    expect(await h.orch.refreshBaseBranch(h.get(t))).toEqual({ branch: "release", source: "ticket" });
    await h.orch.updateTicket(t.key, { baseBranch: null });
    expect((await h.orch.refreshBaseBranch(h.get(t))).source).toBe("project");
  });

  test("a repo without the default branch falls back to its checked-out branch; an explicit base doesn't", async () => {
    const h = await setup({ init: "master" });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(h.get(t).branch).toBe("harness/repo-1");
    expect(await h.orch.refreshBaseBranch(h.get(t))).toEqual({ branch: "master", source: "checkout" });
    expect(await h.rev("harness/repo-1")).toBe(await h.rev("master"));

    h.orch.updateProject(h.project.id, { baseBranch: "main" });
    const u = await h.orch.createTicket({ projectId: h.project.id, spec: "y" });
    await h.orch.idle();
    const blocked = h.get(u);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toContain("Could not create worktree: the base branch main doesn't exist");
    expect(blocked.branch).toBeNull();
  });
});

describe("completion after a restart (nothing cached about the repo's branches)", () => {
  // What a fresh service process knows: nothing about which branches the repo has.
  const forget = (h: Awaited<ReturnType<typeof setup>>) => (h.orch as unknown as { baseFallback: Map<string, string> }).baseFallback.clear();

  for (const how of ["Complete button", "approval"] as const) {
    test(`${how}: the complete run's prompt names the fallback base, same as its system prompt`, async () => {
      const h = await setup({ init: "master" });
      h.driver.commitsWork = true;
      const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
      await h.orch.idle();
      forget(h);
      if (how === "Complete button") await h.orch.completeTicket(t.key);
      else h.orch.humanReview(t.key, { decision: "approve" });
      await h.orch.idle();
      const complete = h.driver.calls.find((c) => c.kind === "complete")!;
      expect(complete.prompt).toContain("into the base branch `master`");
      expect(complete.prompt).not.toContain("`main`");
      expect(complete.runContext).toContain("fetch . harness/repo-1:master");
      expect(h.get(t).status).toBe("done");
    });
  }

  test("while the complete run is being prepared the ticket counts as completing", async () => {
    const h = await setup({ init: "master" });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const pending = h.orch.completeTicket(t.key);
    await expect(h.orch.completeTicket(t.key)).rejects.toThrow(/already completing/);
    await expect(h.orch.sendMessage(t.key, "one more thing")).rejects.toThrow(/is completing/);
    await pending;
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "complete")).toHaveLength(1);
  });
});

describe("the ticket's worktree branch", () => {
  test("a new harness branch starts from the base branch, not the main checkout's HEAD", async () => {
    const h = await setup({ baseBranch: "develop" });
    const tip = await commitOn(h, "develop", "main");
    expect(await h.rev("HEAD")).not.toBe(tip);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const cur = h.get(t);
    expect(cur.branch).toBe("harness/repo-1");
    expect(await h.rev("HEAD", cur.workdir!)).toBe(tip);
    // The work run is told where it merges.
    expect(h.driver.calls.find((c) => c.kind === "work")!.runContext).toContain("Base branch: develop (the project's base branch)");
  });

  test("an existing branch is checked out as is; a new name is created from the base branch", async () => {
    const h = await setup();
    const feature = await commitOn(h, "feature/x", "main");
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "x", branch: "feature/x" });
    await h.orch.idle();
    expect([h.get(a).branch, h.get(a).requestedBranch]).toEqual(["feature/x", "feature/x"]);
    expect(await h.rev("HEAD", h.get(a).workdir!)).toBe(feature);

    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "y", branch: "medl-1223-ai-app" });
    await h.orch.idle();
    expect(h.get(b).branch).toBe("medl-1223-ai-app");
    expect(await h.rev("medl-1223-ai-app")).toBe(await h.rev("main"));
  });

  test("a branch checked out in another worktree blocks the ticket, naming the branch and the path", async () => {
    const h = await setup();
    const herdr = join(h.home, "herdr-medl");
    h.git.addWorktree(h.repo, herdr, "medl-1223-ai-app", true);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", branch: "medl-1223-ai-app" });
    await h.orch.idle();
    const cur = h.get(t);
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toContain("branch medl-1223-ai-app is already checked out in the worktree at");
    expect(cur.blockedReason).toContain("herdr-medl");
    expect(cur.workdir).toBeNull();
    // Picking another branch while it waits, then starting it, works.
    await h.orch.updateTicket(t.key, { branch: "other" });
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(h.get(t).branch).toBe("other");
  });

  test("branch needs a worktree; it can't be changed from outside once the worktree exists", async () => {
    const h = await setup();
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", branch: "b", useWorktree: false })).rejects.toThrow(/needs a worktree/);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.updateTicket(t.key, { branch: "chosen" });
    expect(h.get(t).requestedBranch).toBe("chosen");
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(h.get(t).branch).toBe("chosen");
    await expect(h.orch.updateTicket(t.key, { branch: "later" })).rejects.toThrow(/update_branch tool/);
    // The board tool says the same thing to another ticket's agent.
    const other = await h.orch.createTicket({ projectId: h.project.id, spec: "caller", start: false });
    await expect(h.orch.ops.updateTicket(h.ctx("work", other), t.key, { branch: "later" })).rejects.toThrow(/send it a message/);
    await h.orch.ops.updateTicket(h.ctx("work", other), t.key, { baseBranch: "develop" });
    expect(h.get(t).baseBranch).toBe("develop");
  });

  test("create_ticket passes branch and base_branch through for a child", async () => {
    const h = await setup();
    const me = await h.orch.createTicket({ projectId: h.project.id, spec: "parent", start: false });
    const child = await h.orch.ops.createTicket(h.ctx("work", me), { title: "c", spec: "d", child: true, autoStart: false, branch: "feat/c", baseBranch: "develop" });
    expect([child.requestedBranch, child.baseBranch, child.branch]).toEqual(["feat/c", "develop", null]);
  });
});

describe("update_branch", () => {
  test("a branch checked out in another worktree re-points the ticket there; nothing is deleted", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const before = h.get(t);
    await commitOn(h, before.branch!); // work the agent did on harness/repo-1
    const herdr = join(h.home, "herdr-medl");
    h.git.addWorktree(h.repo, herdr, "medl-1223-ai-app", true);

    const out = await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "medl-1223-ai-app" });
    const cur = h.get(t);
    expect(cur.branch).toBe("medl-1223-ai-app");
    expect(cur.requestedBranch).toBe("medl-1223-ai-app");
    expect(realpathSync(cur.workdir!)).toBe(realpathSync(herdr));
    expect(realpathSync(h.store.sessions.get(t.sessionId)!.cwd)).toBe(realpathSync(herdr));
    expect(out).toContain("now uses branch medl-1223-ai-app in the worktree at");
    expect(out).toContain("1 commit on harness/repo-1 isn't on medl-1223-ai-app");
    expect(out).toContain(`The old worktree at ${before.workdir} and branch harness/repo-1 are left in place for cleanup`);
    expect(existsSync(before.workdir!)).toBe(true);
    expect(await h.git.port.branchExists(h.repo, "harness/repo-1")).toBe(true);

    // The next run works in the new worktree (and commits there), and completion leaves what the
    // harness didn't create.
    h.driver.commitsWork = true;
    h.orch.humanReview(t.key, { decision: "request_changes", notes: "carry on" });
    await h.orch.idle();
    const last = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(realpathSync(last.cwd)).toBe(realpathSync(herdr));
    h.orch.humanReview(t.key, { decision: "approve" }); // approving completes
    await h.orch.idle();
    const complete = h.driver.calls.find((c) => c.kind === "complete")!;
    expect(complete.runContext).toContain("Merge `medl-1223-ai-app` into the base branch `main`");
    expect(complete.runContext).toContain(`leave the worktree at ${cur.workdir} in place`);
    expect(complete.runContext).not.toContain("branch -d medl-1223-ai-app");
    expect(complete.runContext).toContain(`An earlier harness worktree of this ticket is still at ${before.workdir}`);
  });

  test("once that worktree is gone, starting again puts the leftover harness worktree on the ticket's branch", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /block which branch?" });
    await h.orch.idle();
    const harnessDir = h.get(t).workdir!;
    const herdr = join(h.home, "herdr-medl");
    h.git.addWorktree(h.repo, herdr, "medl-1223-ai-app", true);
    await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "medl-1223-ai-app" });
    h.git.removeWorktree(herdr); // the human cleaned up their herdr worktree
    await h.orch.sendMessage(t.key, "carry on");
    await h.orch.idle();
    const cur = h.get(t);
    expect([cur.workdir, cur.branch]).toEqual([harnessDir, "medl-1223-ai-app"]);
    expect(await h.git.port.currentBranch(harnessDir)).toBe("medl-1223-ai-app");
  });

  test("when the ticket's branch can't go back into the leftover harness worktree, the ticket blocks saying why", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /block which branch?" });
    await h.orch.idle();
    const harnessDir = h.get(t).workdir!;
    const herdr = join(h.home, "herdr-medl");
    h.git.addWorktree(h.repo, herdr, "medl-1223-ai-app", true);
    await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "medl-1223-ai-app" });
    // The herdr worktree goes away, and the branch is checked out somewhere else instead.
    h.git.removeWorktree(herdr);
    const elsewhere = join(h.home, "elsewhere");
    h.git.addWorktree(h.repo, elsewhere, "medl-1223-ai-app");
    await h.orch.sendMessage(t.key, "carry on");
    await h.orch.idle();
    const cur = h.get(t);
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toContain("Could not create worktree: branch medl-1223-ai-app is already checked out in the worktree at");
    expect(cur.blockedReason).toContain("elsewhere");
    expect(cur.blockedReason).toContain(`this ticket's worktree at ${harnessDir} is on harness/repo-1`);
    // Nothing quietly went back to the harness branch.
    expect(cur.requestedBranch).toBe("medl-1223-ai-app");
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).not.toBe("carry on");
  });

  test("the commit count leaves out what the base branch already has", async () => {
    const h = await setup();
    h.git.createBranch(h.repo, "old-feature"); // made before main moved on
    await commitOn(h, "main"); // main moves ahead
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await commitOn(h, h.get(t).branch!); // the ticket's one commit
    const out = await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "old-feature" });
    expect(out).toContain("1 commit on harness/repo-1 isn't on old-feature");
  });

  test("otherwise it switches the ticket's worktree, creating the branch at HEAD when new; a dirty tree is refused", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const wt = h.get(t).workdir!;
    const head = await h.rev("HEAD", wt);
    const out = await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "feature/new" });
    expect(out).toContain("from harness/repo-1 to a new branch feature/new");
    expect(await h.git.port.currentBranch(wt)).toBe("feature/new");
    expect(await h.rev("feature/new")).toBe(head);
    expect([h.get(t).branch, h.get(t).workdir]).toEqual(["feature/new", wt]);
    expect(await h.git.port.branchExists(h.repo, "harness/repo-1")).toBe(true);

    // Uncommitted changes that the switch would overwrite: git refuses, the ticket stays put.
    await commitOn(h, "other", "main");
    await h.git.commitAt(h.repo, "f.txt");
    h.git.createBranch(h.repo, "other", "main"); // git branch -f other main
    h.git.makeDirty(wt, "f.txt");
    await expect(h.orch.ops.updateBranch(h.ctx("work", t), { branch: "other" })).rejects.toThrow(/git switch other failed/);
    expect(h.get(t).branch).toBe("feature/new");
  });

  test("base_branch alone; refused without a worktree, with nothing to change, and outside work runs", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.git.createBranch(h.repo, "develop");
    expect(await h.orch.ops.updateBranch(h.ctx("work", t), { baseBranch: "develop" })).toContain("Base branch: develop (set on this ticket)");
    expect(h.get(t).baseBranch).toBe("develop");
    expect(await h.orch.ops.updateBranch(h.ctx("work", t), { baseBranch: null })).toContain("Base branch: main (inherited from Settings)");
    await expect(h.orch.ops.updateBranch(h.ctx("work", t), {})).rejects.toThrow(/Nothing to update/);
    await expect(h.orch.ops.updateBranch(h.ctx("review", t), { branch: "x" })).rejects.toThrow(/only available in work, conductor and chat runs/);
    const plain = await h.orch.createTicket({ projectId: h.project.id, spec: "y", useWorktree: false });
    await h.orch.idle();
    await expect(h.orch.ops.updateBranch(h.ctx("work", plain), { branch: "x" })).rejects.toThrow(/runs in the project checkout/);
  });
});

describe("GET /projects/:id/branches", () => {
  // Ordering, checked-out paths and substring-then-fuzzy matching are the GitPort contract's (next/support/git-contract.ts).
  test("passes the query and limit to git, matches case-insensitively, and a project outside git has none", async () => {
    const h = await setup();
    h.git.createBranch(h.repo, "medl-1223-ai-app");
    expect((await h.orch.projectBranches(h.project.id, "MEDL")).map((b) => b.name)).toEqual(["medl-1223-ai-app"]);
    expect((await h.orch.projectBranches(h.project.id, "")).length).toBeGreaterThan(1);
    expect(await h.orch.projectBranches(h.project.id, "", 1)).toHaveLength(1);
    const dir = join(h.home, "plain");
    mkdirSync(dir);
    expect(await h.orch.projectBranches(h.orch.createProject({ path: dir, key: "plain" }).id, "")).toEqual([]);
  });
});
