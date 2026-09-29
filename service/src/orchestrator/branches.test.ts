// Branches (DESIGN.md "Branches") against real git repos: base branch resolution and validation,
// where a ticket's worktree branch starts, a chosen branch, blocking when git can't give the
// ticket its branch, update_branch re-pointing, the branch list, and what completion is told.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";
import { fakeContext, fakeSession } from "../tools/fakes";
import { toolsForRun } from "../tools";
import type { ToolContext } from "../tools/types";
import { HarnessError } from "./errors";
import { git as runGit } from "./worktree";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
// Every test drives real git through several runs; a spawn can take ~100ms on a busy Mac.
setDefaultTimeout(30_000);

/** A harness with a git repo (main + one commit) as project REPO. */
async function setup(opts: { init?: string; baseBranch?: string | null; useWorktrees?: boolean } = {}) {
  const h = makeOrchestrator({ tools: toolsForRun });
  const repo = join(h.home, "repo");
  mkdirSync(repo);
  const git = async (...args: string[]) => {
    const r = await runGit(args, repo);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const gitIn = async (dir: string, ...args: string[]) => (await runGit(args, dir)).stdout;
  await git("init", "-q", "-b", opts.init ?? "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  const project = h.orch.createProject({ path: repo, key: "repo", baseBranch: opts.baseBranch, useWorktrees: opts.useWorktrees });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  const ctx = (kind: RunKind, t: Ticket): ToolContext =>
    fakeContext({ runKind: kind, ticket: get(t), session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
  const rev = (ref: string, dir = repo) => gitIn(dir, "rev-parse", ref);
  return { ...h, repo, git, gitIn, project, get, ctx, rev };
}

/** A commit on `branch` (created from `from` when given) without touching the main checkout. */
async function commitOn(h: Awaited<ReturnType<typeof setup>>, branch: string, from?: string) {
  if (from) await h.git("branch", branch, from);
  const tree = await h.git("rev-parse", `${branch}^{tree}`);
  const sha = await h.git("commit-tree", tree, "-p", branch, "-m", `on ${branch}`);
  await h.git("update-ref", `refs/heads/${branch}`, sha);
  return sha;
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
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "x", baseBranch: "-x", start: false })).rejects.toThrow(/can't start with -/);
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "x", branch: "a b", start: false })).rejects.toThrow(/isn't a valid branch name/);
  });

  test("ticket beats project beats settings; the stored setting survives a reload", async () => {
    const h = await setup();
    h.orch.updateSettings({ baseBranch: "develop" });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    await h.git("branch", "develop");
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
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    expect(h.get(t).branch).toBe("harness/repo-1");
    expect(await h.orch.refreshBaseBranch(h.get(t))).toEqual({ branch: "master", source: "checkout" });
    expect(await h.rev("harness/repo-1")).toBe(await h.rev("master"));

    h.orch.updateProject(h.project.id, { baseBranch: "main" });
    const u = await h.orch.createTicket({ projectId: h.project.id, prompt: "y" });
    await h.orch.idle();
    const blocked = h.get(u);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toContain("Could not create worktree: the base branch main doesn't exist");
    expect(blocked.branch).toBeNull();
  });
});

describe("the ticket's worktree branch", () => {
  test("a new harness branch starts from the base branch, not the main checkout's HEAD", async () => {
    const h = await setup({ baseBranch: "develop" });
    const tip = await commitOn(h, "develop", "main");
    expect(await h.rev("HEAD")).not.toBe(tip);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    const cur = h.get(t);
    expect(cur.branch).toBe("harness/repo-1");
    expect(await h.rev("HEAD", cur.workdir!)).toBe(tip);
    // The work run is told where it merges.
    expect(h.driver.calls.find((c) => c.kind === "work")!.systemPrompt).toContain("Base branch: develop (the project's base branch)");
  });

  test("an existing branch is checked out as is; a new name is created from the base branch", async () => {
    const h = await setup();
    const feature = await commitOn(h, "feature/x", "main");
    const a = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", branch: "feature/x" });
    await h.orch.idle();
    expect([h.get(a).branch, h.get(a).requestedBranch]).toEqual(["feature/x", "feature/x"]);
    expect(await h.rev("HEAD", h.get(a).workdir!)).toBe(feature);

    const b = await h.orch.createTicket({ projectId: h.project.id, prompt: "y", branch: "medl-1223-ai-app" });
    await h.orch.idle();
    expect(h.get(b).branch).toBe("medl-1223-ai-app");
    expect(await h.rev("medl-1223-ai-app")).toBe(await h.rev("main"));
  });

  test("a branch checked out in another worktree blocks the ticket, naming the branch and the path", async () => {
    const h = await setup();
    const herdr = join(h.home, "herdr-medl");
    await h.git("worktree", "add", "-q", "-b", "medl-1223-ai-app", herdr);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", branch: "medl-1223-ai-app" });
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
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "x", branch: "b", useWorktree: false })).rejects.toThrow(/needs a worktree/);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.updateTicket(t.key, { branch: "chosen" });
    expect(h.get(t).requestedBranch).toBe("chosen");
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(h.get(t).branch).toBe("chosen");
    await expect(h.orch.updateTicket(t.key, { branch: "later" })).rejects.toThrow(/update_branch tool/);
    // The board tool says the same thing to another ticket's agent.
    const other = await h.orch.createTicket({ projectId: h.project.id, prompt: "caller", start: false });
    await expect(h.orch.ops.updateTicket(h.ctx("work", other), t.key, { branch: "later" })).rejects.toThrow(/send it a message/);
    await h.orch.ops.updateTicket(h.ctx("work", other), t.key, { baseBranch: "develop" });
    expect(h.get(t).baseBranch).toBe("develop");
  });

  test("create_ticket passes branch and base_branch through for a child", async () => {
    const h = await setup();
    const me = await h.orch.createTicket({ projectId: h.project.id, prompt: "parent", start: false });
    const child = await h.orch.ops.createTicket(h.ctx("work", me), { title: "c", description: "d", child: true, autoStart: false, branch: "feat/c", baseBranch: "develop" });
    expect([child.requestedBranch, child.baseBranch, child.branch]).toEqual(["feat/c", "develop", null]);
  });
});

describe("update_branch", () => {
  test("a branch checked out in another worktree re-points the ticket there; nothing is deleted", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    const before = h.get(t);
    await commitOn(h, before.branch!); // work the agent did on harness/repo-1
    const herdr = join(h.home, "herdr-medl");
    await h.git("worktree", "add", "-q", "-b", "medl-1223-ai-app", herdr);

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
    expect(await h.git("branch", "--list", "harness/repo-1")).toContain("harness/repo-1");

    // The next run works in the new worktree, and completion leaves what the harness didn't create.
    await h.orch.sendMessage(t.key, "carry on");
    await h.orch.idle();
    const last = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(realpathSync(last.cwd)).toBe(realpathSync(herdr));
    h.orch.humanReview(t.key, { decision: "approve" }); // the project auto-completes
    await h.orch.idle();
    const complete = h.driver.calls.find((c) => c.kind === "complete")!;
    expect(complete.systemPrompt).toContain("Merge `medl-1223-ai-app` into the base branch `main`");
    expect(complete.systemPrompt).toContain(`leave the worktree at ${cur.workdir} in place`);
    expect(complete.systemPrompt).not.toContain("branch -d medl-1223-ai-app");
    expect(complete.systemPrompt).toContain(`An earlier harness worktree of this ticket is still at ${before.workdir}`);
  });

  test("otherwise it switches the ticket's worktree, creating the branch at HEAD when new; a dirty tree is refused", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    const wt = h.get(t).workdir!;
    const head = await h.rev("HEAD", wt);
    const out = await h.orch.ops.updateBranch(h.ctx("work", t), { branch: "feature/new" });
    expect(out).toContain("from harness/repo-1 to a new branch feature/new");
    expect(await h.gitIn(wt, "symbolic-ref", "--short", "HEAD")).toBe("feature/new");
    expect(await h.rev("feature/new")).toBe(head);
    expect([h.get(t).branch, h.get(t).workdir]).toEqual(["feature/new", wt]);
    expect(await h.git("branch", "--list", "harness/repo-1")).toContain("harness/repo-1");

    // Uncommitted changes that the switch would overwrite: git refuses, the ticket stays put.
    await commitOn(h, "other", "main");
    writeFileSync(join(h.repo, "f.txt"), "main");
    await h.git("add", "f.txt");
    await h.git("commit", "-q", "-m", "f on main");
    await h.git("branch", "-f", "other", "main");
    writeFileSync(join(wt, "f.txt"), "dirty");
    await expect(h.orch.ops.updateBranch(h.ctx("work", t), { branch: "other" })).rejects.toThrow(/git switch other failed/);
    expect(h.get(t).branch).toBe("feature/new");
  });

  test("base_branch alone; refused without a worktree, with nothing to change, and outside work runs", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    await h.git("branch", "develop");
    expect(await h.orch.ops.updateBranch(h.ctx("work", t), { baseBranch: "develop" })).toContain("Base branch: develop (set on this ticket)");
    expect(h.get(t).baseBranch).toBe("develop");
    expect(await h.orch.ops.updateBranch(h.ctx("work", t), { baseBranch: null })).toContain("Base branch: main (inherited from Settings)");
    await expect(h.orch.ops.updateBranch(h.ctx("work", t), {})).rejects.toThrow(/Nothing to update/);
    await expect(h.orch.ops.updateBranch(h.ctx("review", t), { branch: "x" })).rejects.toThrow(/only available in work and conductor runs/);
    const plain = await h.orch.createTicket({ projectId: h.project.id, prompt: "y", useWorktree: false });
    await h.orch.idle();
    await expect(h.orch.ops.updateBranch(h.ctx("work", plain), { branch: "x" })).rejects.toThrow(/runs in the project checkout/);
  });
});

describe("GET /projects/:id/branches", () => {
  test("most recent first, filtered by substring then in-order letters, with where each is checked out", async () => {
    const h = await setup();
    await h.git("branch", "medl-1223-ai-app");
    await h.git("branch", "feature/login");
    // Distinct commit times so the order is certain.
    await h.git("commit", "-q", "--allow-empty", "-m", "newer", "--date=2030-01-01T00:00:00");
    const herdr = join(h.home, "herdr");
    await h.git("worktree", "add", "-q", herdr, "feature/login");
    await runGit(["commit", "-q", "--allow-empty", "-m", "newest"], herdr).then(() => {});
    const all = await h.orch.projectBranches(h.project.id, "");
    expect(all[0]!.name).toBe("feature/login");
    expect(realpathSync(all[0]!.checkedOutAt!)).toBe(realpathSync(herdr));
    expect(all.find((b) => b.name === "main")!.checkedOutAt).not.toBeNull();
    expect(all.find((b) => b.name === "medl-1223-ai-app")!.checkedOutAt).toBeNull();
    expect(all.every((b, i) => i === 0 || all[i - 1]!.lastCommitAt >= b.lastCommitAt)).toBe(true);
    expect((await h.orch.projectBranches(h.project.id, "MEDL")).map((b) => b.name)).toEqual(["medl-1223-ai-app"]);
    // "fl" isn't a substring of anything, but f…l appears in order in feature/login.
    expect((await h.orch.projectBranches(h.project.id, "fl")).map((b) => b.name)).toEqual(["feature/login"]);
    expect(await h.orch.projectBranches(h.project.id, "", 1)).toHaveLength(1);
    const dir = join(h.home, "plain");
    mkdirSync(dir);
    expect(await h.orch.projectBranches(h.orch.createProject({ path: dir, key: "plain" }).id, "")).toEqual([]);
  });
});
