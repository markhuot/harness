// Completion actions (DESIGN.md "Completion") against real git repos: what a project offers
// (merge, pr, custom) from its checkout and gh's login, the choice made at approval and kept until
// the completion runs, the prompts each action gets, the no-pull-request guard, "Approve and take
// no action", and children landing on their parent's branch.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { clearPullRequestTargets } from "../store/projects";
import { makeOrchestrator } from "../testing/fakes";
import { HarnessError } from "./errors";
import { RunQueue } from "./queue";
import { git as runGit } from "./worktree";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
setDefaultTimeout(30_000);

// gh "installed" (a stub on PATH) and logged into github.com, for every test in this file.
const saved = { PATH: process.env.PATH, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
beforeAll(() => {
  const dir = tempDir("harness-gh-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(dir, "hosts.yml"), "github.com:\n    user: me\n    git_protocol: ssh\n");
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.GH_CONFIG_DIR = dir;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  clearPullRequestTargets();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearPullRequestTargets();
});

async function setup(opts: { remote?: string | null; git?: boolean; commits?: boolean } = {}) {
  const h = makeOrchestrator();
  // Work runs commit, so tickets have something to merge (Ticket.hasChanges).
  h.driver.commitsWork = opts.commits ?? true;
  const repo = join(h.home, "repo");
  mkdirSync(repo);
  const git = async (...args: string[]) => {
    const r = await runGit(args, repo);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  if (opts.git !== false) {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    if (opts.remote !== null) await git("remote", "add", "origin", opts.remote ?? "git@github.com:acme/web.git");
  }
  clearPullRequestTargets();
  const project = h.orch.createProject({ path: repo, key: "web" });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  /** A ticket worked, agent-reviewed and waiting on the human. */
  const inReview = async (prompt = "x") => {
    const t = await h.orch.createTicket({ projectId: project.id, spec: prompt });
    await h.orch.idle();
    expect(get(t).status).toBe("review");
    return get(t);
  };
  const completes = () => h.driver.calls.filter((c) => c.kind === "complete");
  return { ...h, repo, git, project, get, inReview, completes };
}

function expectStatus(fn: () => unknown, status: number, match: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).status).toBe(status);
    expect((err as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected it to throw");
}

describe("what a project offers", () => {
  test("a GitHub remote gh is logged into offers pr; other hosts and no remote don't; outside git only custom", async () => {
    const gh = await setup();
    expect(gh.project.completionActions).toEqual(["merge", "pr", "cleanup", "custom"]);
    expect(gh.project.pullRequestHost).toBe("github.com");
    expect(gh.project.completionAction).toBe("merge");

    const bitbucket = await setup({ remote: "https://bitbucket.org/acme/web.git" });
    expect(bitbucket.project.completionActions).toEqual(["merge", "cleanup", "custom"]);
    expect(bitbucket.project.pullRequestHost).toBeNull();

    // An Enterprise host gh has no login for.
    const ghe = await setup({ remote: "https://ghe.acme.com/web/site.git" });
    expect(ghe.project.completionActions).toEqual(["merge", "cleanup", "custom"]);

    const local = await setup({ remote: null });
    expect(local.project.completionActions).toEqual(["merge", "cleanup", "custom"]);

    const plain = await setup({ git: false });
    expect(plain.project.completionActions).toEqual(["custom"]);
  });

  test("the project default must be offered; a default the project stops offering falls back to merge", async () => {
    const h = await setup();
    expect(h.orch.updateProject(h.project.id, { completionAction: "pr" }).completionAction).toBe("pr");
    expectStatus(() => h.orch.updateProject(h.project.id, { completionAction: "ship" as never }), 400, /must be one of merge, pr, cleanup, custom/);

    const local = await setup({ remote: null });
    expectStatus(() => local.orch.updateProject(local.project.id, { completionAction: "pr" }), 400, /gh is logged into/);

    // The remote goes away: the stored pr default is kept, but approving merges.
    await h.git("remote", "remove", "origin");
    clearPullRequestTargets();
    expect(h.orch.listProjects()[0]!.completionActions).toEqual(["merge", "cleanup", "custom"]);
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.get(t).completionAction).toBe("merge");
    expect(h.completes()[0]!.systemPrompt).toContain("## This run: completion\n");
    expect(h.get(t).status).toBe("done");
  });
});

describe("choosing at approval", () => {
  test("the choice made before the agent review finishes is kept and runs once the ticket is ready", async () => {
    const h = await setup();
    // Hold the agent review so the human approves first.
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    expect(h.get(t).agentReview).toBe("pending");
    h.orch.humanReview(t.key, { decision: "approve", action: "pr", instructions: "Label it design." });
    expect(h.get(t)).toMatchObject({ completionAction: "pr", completionInstructions: "Label it design.", humanReview: "approved" });
    h.driver.release();
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(run.systemPrompt).toContain("## This run: completion (pull request)");
    expect(run.systemPrompt).toContain("gh pr create --repo github.com/acme/web --base main");
    expect(run.prompt).toContain("Label it design.");
    expect(h.get(t)).toMatchObject({ status: "done", pullRequestUrl: expect.stringContaining("/pull/") });
    expect(h.get(t).pullRequestHead).toBe(await h.git("rev-parse", "harness/web-1"));
  });

  test("an action the ticket doesn't offer is refused before anything changes", async () => {
    const h = await setup({ remote: null });
    const t = await h.inReview();
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "pr" }), 400, /gh is logged into/);
    expect(h.get(t)).toMatchObject({ humanReview: "pending", completionAction: null });
    await expect(h.orch.completeTicket(t.key, { action: "pr" })).rejects.toThrow(/gh is logged into/);
    expect(h.completes()).toHaveLength(0);
  });

  test("custom follows the approver's instructions and gets no merge steps", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "Cherry-pick onto release-2.4" });
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(run.systemPrompt).toContain("## This run: completion (the approver's instructions)");
    expect(run.systemPrompt).not.toContain("fetch . harness/web-1:main");
    expect(run.prompt).toContain("## Instructions from the human\nCherry-pick onto release-2.4");
    expect(h.get(t).status).toBe("done");
  });

  test("a new action without instructions drops the earlier action's instructions", async () => {
    const h = await setup();
    // Hold the agent review so the approval waits, then Complete with another action.
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "Tag it" });
    await h.orch.completeTicket(t.key, { action: "merge" });
    h.driver.release();
    await h.orch.idle();
    expect(h.completes()).toHaveLength(1);
    expect(h.get(t)).toMatchObject({ completionAction: "merge", completionInstructions: null });
    expect(h.completes()[0]!.prompt).not.toContain("Tag it");
  });
});

describe("pull request completions", () => {
  test("a pr completion that records no pull request blocks instead of finishing", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "pr", instructions: "[no-pr]" });
    await h.orch.idle();
    expect(h.get(t).status).toBe("blocked");
    expect(h.get(t).blockedReason).toContain("without opening a pull request");
    expect(h.get(t).pullRequestUrl).toBeNull();
  });

  test("record_pull_request is refused outside a pr completion", async () => {
    const h = await setup();
    let refused = "";
    h.driver.script = async function* (req) {
      if (req.kind === "complete") {
        try {
          await req.toolContext.ops.recordPullRequest(req.toolContext, "https://github.com/acme/web/pull/9", "0123456789abcdef0123456789abcdef01234567");
        } catch (err) {
          refused = (err as Error).message;
        }
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    // The script also stands in for work and review: commit, submit and approve by hand.
    const u = h.get(t);
    await runGit(["commit", "-q", "--allow-empty", "-m", "work"], u.workdir!);
    h.store.tickets.update(u.id, { status: "review", agentReview: "approved", hasChanges: true });
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(refused).toContain("only for completion runs that open a pull request");
    expect(h.get(t).pullRequestUrl).toBeNull();
    expect(h.get(t).status).toBe("done");
  });

  test("record_pull_request wants the hash of a commit the repo has, and stores it in full", async () => {
    const h = await setup();
    const tried: string[] = [];
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      const head = (await runGit(["rev-parse", "HEAD"], req.cwd)).stdout.trim();
      for (const bad of ["HEAD", "harness/web-1", "0".repeat(40)]) {
        await req.toolContext.ops.recordPullRequest(req.toolContext, "https://github.com/acme/web/pull/9", bad).catch((err: Error) => tried.push(err.message));
      }
      await req.toolContext.ops.recordPullRequest(req.toolContext, "https://github.com/acme/web/pull/9", head.slice(0, 10));
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const u = h.get(t);
    await runGit(["commit", "-q", "--allow-empty", "-m", "work"], u.workdir!);
    const head = (await runGit(["rev-parse", "HEAD"], u.workdir!)).stdout.trim();
    h.store.tickets.update(u.id, { status: "review", agentReview: "approved", hasChanges: true });
    h.orch.humanReview(t.key, { decision: "approve", action: "pr" });
    await h.orch.idle();
    expect(tried).toHaveLength(3);
    expect(tried[0]).toContain("not a branch or ref name");
    expect(tried[1]).toContain("not a branch or ref name");
    expect(tried[2]).toContain("isn't a commit in this ticket's repository");
    expect(h.get(t)).toMatchObject({ status: "done", pullRequestHead: head });
  });
});

describe("tickets with nothing to land (Ticket.hasChanges)", () => {
  test("a worktree with no commits and nothing uncommitted offers no merge or pr, and approving cleans up", async () => {
    const h = await setup({ commits: false });
    const t = await h.inReview();
    expect(t.hasChanges).toBe(false);
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "merge" }), 400, /has no changes to land, so there is nothing to merge/);
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "pr" }), 400, /nothing to open a pull request from/);
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.completes()[0]!.prompt).toContain("is approved to clean up");
  });

  test("a commit made by hand during review shows up once the ticket is opened, and approving merges it", async () => {
    const h = await setup({ commits: false });
    const t = await h.inReview();
    expect(t.hasChanges).toBe(false);
    const upserts: Ticket[] = [];
    h.bus.on((e) => void (e.kind === "ticket.upserted" && e.ticket.id === t.id && upserts.push(e.ticket)));
    await runGit(["commit", "-q", "--allow-empty", "-m", "by hand"], t.workdir!);
    h.orch.ticketDetail(t.key);
    await h.orch.idle();
    expect(h.get(t).hasChanges).toBe(true);
    // The apps hear about it.
    expect(upserts.at(-1)?.hasChanges).toBe(true);
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.completes()[0]!.systemPrompt).toContain("into the base branch `main`");
    expect(h.get(t).completionAction).toBe("merge");
  });

  test("an uncommitted file counts as a change; one the base branch already has doesn't", async () => {
    const h = await setup({ commits: false });
    const t = await h.inReview();
    writeFileSync(join(t.workdir!, "notes.txt"), "draft\n");
    h.orch.ticketDetail(t.key);
    await h.orch.idle();
    expect(h.get(t).hasChanges).toBe(true);
    // Committed, then merged into main by hand: nothing left to land.
    await runGit(["add", "-A"], t.workdir!);
    await runGit(["commit", "-q", "-m", "notes"], t.workdir!);
    await h.git("merge", "-q", "--ff-only", "harness/web-1");
    h.orch.ticketDetail(t.key);
    await h.orch.idle();
    expect(h.get(t).hasChanges).toBe(false);
  });

  test("a ticket without a worktree of its own (it ran in the project checkout) can't merge or open a pr", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", useWorktree: false });
    await h.orch.idle();
    const u = h.get(t);
    expect(u).toMatchObject({ status: "review", branch: null, hasChanges: null });
    expectStatus(() => h.orch.humanReview(u.key, { decision: "approve", action: "merge" }), 400, /has no branch of its own, so there is nothing to merge/);
    expect(h.orch.humanReview(u.key, { decision: "approve", action: "cleanup" }).completionAction).toBe("cleanup");
  });
});

describe("cleanup completions", () => {
  /** From now on a complete run does the cleanup itself: removes the worktree, and deletes the branch when asked. */
  const cleansUp = (h: Awaited<ReturnType<typeof setup>>, deleteBranch: string | null) => {
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      const t = req.toolContext.ticket!;
      await h.git("worktree", "remove", t.workdir!);
      if (deleteBranch) await h.git("branch", "-D", deleteBranch);
      await req.toolContext.ops.postNote(req.toolContext, "Cleaned up.");
    };
  };

  test("a ticket working on its base branch (an existing PR head) can't merge or open a PR, and cleans up by default", async () => {
    const h = await setup();
    await h.git("branch", "feature/pr-head");
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Fix the PR", branch: "feature/pr-head", baseBranch: "feature/pr-head" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "review", branch: "feature/pr-head" });
    expect(h.driver.calls.find((c) => c.kind === "work")!.systemPrompt).toContain("which is also its base branch");
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "merge" }), 400, /works on its base branch feature\/pr-head/);
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "pr" }), 400, /nothing to open a pull request from/);
    cleansUp(h, null);
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(h.get(t)).toMatchObject({ status: "done", completionAction: "cleanup" });
    expect(run.systemPrompt).toContain("## This run: completion (clean up)");
    // On the base branch only remotes count: `--not --remotes feature/pr-head` would hide every commit.
    expect(run.systemPrompt).toContain("log --oneline feature/pr-head --not --remotes`");
    expect(run.systemPrompt).toContain("Keep `feature/pr-head`: the harness didn't create it, and it is the base branch.");
    expect(await h.git("branch", "--list", "feature/pr-head")).toContain("feature/pr-head");
  });

  test("a cleanup that leaves the harness worktree or branch behind blocks instead of finishing", async () => {
    const h = await setup();
    const t = await h.inReview();
    // The fake complete run removes nothing, as an agent that found unpushed commits would.
    h.orch.humanReview(t.key, { decision: "approve", action: "cleanup" });
    await h.orch.idle();
    expect(h.completes()[0]!.systemPrompt).toContain("log --oneline harness/web-1 --not --remotes main`");
    expect(h.get(t).status).toBe("blocked");
    expect(h.get(t).blockedReason).toContain("Cleanup didn't finish: the worktree at");
    expect(h.get(t).blockedReason).toContain("and the branch harness/web-1 still exist");
  });

  test("only the branch left behind still blocks; with both gone the ticket is done", async () => {
    const h = await setup();
    const kept = await h.inReview("kept");
    cleansUp(h, null);
    await h.orch.completeTicket(kept.key, { action: "cleanup" });
    await h.orch.idle();
    expect(h.get(kept).blockedReason).toMatch(/^Cleanup didn't finish: the branch harness\/web-1 still exists/);

    const h2 = await setup();
    const gone = await h2.inReview("gone");
    cleansUp(h2, "harness/web-1");
    await h2.orch.completeTicket(gone.key, { action: "cleanup" });
    await h2.orch.idle();
    expect(h2.get(gone).status).toBe("done");
  });

  test("a ticket whose worktree holds no work (a change made outside git) cleans up to done", async () => {
    const h = await setup({ commits: false });
    const t = await h.inReview();
    expect(await h.git("rev-list", "--count", "main..harness/web-1")).toBe("0");
    cleansUp(h, "harness/web-1");
    await h.orch.completeTicket(t.key, { action: "cleanup" });
    await h.orch.idle();
    expect(h.get(t).status).toBe("done");
    expect(await h.git("branch", "--list", "harness/web-1")).toBe("");
  });

  test("a ticket with a pull request open cleans up by default: it pushes the branch and records the pushed head", async () => {
    const h = await setup();
    const t = await h.inReview();
    const url = "https://github.com/acme/web/pull/1";
    h.store.tickets.update(t.id, { pullRequestUrl: url });
    let recorded = "";
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      const head = (await runGit(["rev-parse", "HEAD"], req.cwd)).stdout.trim();
      recorded = await req.toolContext.ops.recordPullRequest(req.toolContext, url, head);
      await h.git("worktree", "remove", req.toolContext.ticket!.workdir!);
      await h.git("branch", "-D", "harness/web-1");
    };
    const head = await h.git("rev-parse", "harness/web-1");
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(h.get(t)).toMatchObject({ status: "done", completionAction: "cleanup", pullRequestUrl: url, pullRequestHead: head });
    expect(recorded).toContain(url);
    expect(run.systemPrompt).toContain("## This run: completion (clean up)");
    expect(run.systemPrompt).toContain("push -u origin harness/web-1`");
    expect(run.systemPrompt).toContain(`record_pull_request\` { url: "${url}", head }`);
    expect(run.prompt).toContain("Push `harness/web-1` to origin");
  });

  test("without a remote a cleanup has nothing to push to, and record_pull_request stays refused without a pull request", async () => {
    const h = await setup({ remote: null });
    const t = await h.inReview();
    let refused = "";
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      await req.toolContext.ops.recordPullRequest(req.toolContext, "https://github.com/acme/web/pull/9", "0123456789abcdef0123456789abcdef01234567").catch((err: Error) => (refused = err.message));
    };
    h.orch.humanReview(t.key, { decision: "approve", action: "cleanup" });
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(run.systemPrompt).not.toContain("push -u");
    expect(run.prompt).toContain("there is nothing to merge or push");
    expect(refused).toContain("only for completion runs that open a pull request");
  });

  test("re-opening a done ticket forgets the landing it chose, so a ticket with a pull request then preselects clean up", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "pr", instructions: "Label it design." });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "done", completionAction: "pr", pullRequestUrl: expect.stringContaining("/pull/") });
    await h.orch.reopenTicket(t.key, { notes: "Address the review comments" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "review", completionAction: null, completionInstructions: null });
    h.driver.script = async function* () {};
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.completes()[1]!.systemPrompt).toContain("## This run: completion (clean up)");
  });
});

describe("Approve and take no action", () => {
  test("in review: done and approved with no completion run, the worktree and branch left alone", async () => {
    const h = await setup();
    // The agent review is still running when the human takes no action.
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    for (let i = 0; i < 100 && h.driver.holding === 0; i++) await Bun.sleep(20);
    expect(h.get(t)).toMatchObject({ status: "review", agentReview: "pending" });
    await h.orch.completeTicket(t.key, { skipAgent: true });
    h.driver.release();
    await h.orch.idle();
    const done = h.get(t);
    expect(done).toMatchObject({ status: "done", humanReview: "approved" });
    expect(h.completes()).toHaveLength(0);
    expect(await h.git("branch", "--list", "harness/web-1")).toContain("harness/web-1");
    const notes = h.store.transcript
      .list(done.sessionId)
      .filter((e) => e.content.type === "status")
      .map((e) => (e.content as { text: string }).text);
    expect(notes).toContain("Approved, no action taken");
    expect(notes).not.toContain("Marked done");
  });

  test("outside review it is plain Mark done", async () => {
    const h = await setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(h.get(t)).toMatchObject({ status: "done", humanReview: "pending" });
  });
});

describe("children land on their parent's branch", () => {
  test("a conductor's children branch from its branch, only merge, and merge into it", async () => {
    const h = await setup();
    h.orch.updateProject(h.project.id, { completionAction: "pr" });
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Big goal", kind: "conductor", start: false });
    // Work on the conductor's branch before the children exist.
    await h.orch.startTicket(parent.key);
    await h.orch.idle();
    const p = h.get(parent);
    expect(p.branch).toBe("harness/web-1");
    const kids = h.store.tickets.list({ parentId: p.id });
    expect(kids.length).toBeGreaterThan(0);
    const first = h.get(kids[0]!);
    // Branched from the conductor's branch, and its completion merged into it (not into main).
    const base = await h.orch.refreshBaseBranch(first);
    expect(base).toEqual({ branch: "harness/web-1", source: "parent" });
    const childRun = h.completes().find((c) => c.prompt.includes(first.key))!;
    expect(childRun.systemPrompt).toContain(`Merge \`${first.branch}\` into the base branch \`harness/web-1\``);
    expect(childRun.systemPrompt).not.toContain("gh pr create");
    expect(h.get(first).completionAction).toBe("merge");
  });

  test("a child on its parent's branch refuses pr and custom", async () => {
    const h = await setup();
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "goal", start: false });
    h.store.tickets.update(parent.id, { branch: "harness/web-1", workdir: h.repo, status: "in_progress" });
    const child = await h.orch.createTicket({ projectId: h.project.id, spec: "part", start: false });
    h.store.db.query("UPDATE tickets SET parent_id = $p WHERE id = $id").run({ p: parent.id, id: child.id });
    h.store.tickets.update(child.id, { status: "review", agentReview: "approved" });
    expectStatus(() => h.orch.humanReview(child.key, { decision: "approve", action: "pr" }), 400, /merges into its parent's branch harness\/web-1/);
    expectStatus(() => h.orch.humanReview(child.key, { decision: "approve", action: "custom" }), 400, /merges into its parent's branch/);
    expect(h.orch.humanReview(child.key, { decision: "approve", action: "merge" }).completionAction).toBe("merge");
  });

  test("a child with its own base branch, or under a finished parent, gets the project's choices again", async () => {
    const h = await setup();
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "goal", start: false });
    h.store.tickets.update(parent.id, { branch: "harness/web-1", workdir: h.repo, status: "in_progress" });
    const mk = async () => {
      const child = await h.orch.createTicket({ projectId: h.project.id, spec: "part", start: false });
      h.store.db.query("UPDATE tickets SET parent_id = $p WHERE id = $id").run({ p: parent.id, id: child.id });
      return h.store.tickets.update(child.id, { status: "review", agentReview: "approved", branch: `harness/${child.key.toLowerCase()}` })!;
    };
    const own = h.store.tickets.update((await mk()).id, { baseBranch: "release" })!;
    expect(h.orch.humanReview(own.key, { decision: "approve", action: "pr" }).completionAction).toBe("pr");
    expect(await h.orch.refreshBaseBranch(h.get(own))).toEqual({ branch: "release", source: "ticket" });
    const late = await mk();
    h.store.tickets.update(parent.id, { status: "done" });
    expect(h.orch.humanReview(late.key, { decision: "approve", action: "custom" }).completionAction).toBe("custom");
  });
});

describe("merge locks", () => {
  test("jobs sharing a lock never run at once; different locks and no lock do", async () => {
    const running = new Set<string>();
    let overlap = 0;
    const order: string[] = [];
    const q = new RunQueue({
      limit: () => 4,
      execute: async (job) => {
        if (job.lock && [...running].some((r) => r === job.lock)) overlap++;
        if (job.lock) running.add(job.lock);
        order.push(`start ${job.runId}`);
        await Bun.sleep(20);
        order.push(`end ${job.runId}`);
        if (job.lock) running.delete(job.lock);
      },
    });
    q.enqueue({ runId: "a", sessionId: "s1", kind: "complete", lock: "merge:p" });
    q.enqueue({ runId: "b", sessionId: "s2", kind: "complete", lock: "merge:p" });
    q.enqueue({ runId: "c", sessionId: "s3", kind: "complete", lock: "merge:q" });
    q.enqueue({ runId: "d", sessionId: "s4", kind: "complete" });
    await Bun.sleep(5);
    expect(q.runningCount).toBe(3); // a, c and d; b waits for a
    await q.idle();
    expect(overlap).toBe(0);
    expect(order.indexOf("start b")).toBeGreaterThan(order.indexOf("end a"));
    expect(order.indexOf("start c")).toBeLessThan(order.indexOf("end a"));
  });
});
