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

async function setup(opts: { remote?: string | null; git?: boolean; autoComplete?: boolean } = {}) {
  const h = makeOrchestrator();
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
  const project = h.orch.createProject({ path: repo, key: "web", autoComplete: opts.autoComplete ?? false });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  /** A ticket worked, agent-reviewed and waiting on the human. */
  const inReview = async (prompt = "x") => {
    const t = await h.orch.createTicket({ projectId: project.id, prompt });
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
    expect(gh.project.completionActions).toEqual(["merge", "pr", "custom"]);
    expect(gh.project.pullRequestHost).toBe("github.com");
    expect(gh.project.completionAction).toBe("merge");

    const bitbucket = await setup({ remote: "https://bitbucket.org/acme/web.git" });
    expect(bitbucket.project.completionActions).toEqual(["merge", "custom"]);
    expect(bitbucket.project.pullRequestHost).toBeNull();

    // An Enterprise host gh has no login for.
    const ghe = await setup({ remote: "https://ghe.acme.com/web/site.git" });
    expect(ghe.project.completionActions).toEqual(["merge", "custom"]);

    const local = await setup({ remote: null });
    expect(local.project.completionActions).toEqual(["merge", "custom"]);

    const plain = await setup({ git: false });
    expect(plain.project.completionActions).toEqual(["custom"]);
  });

  test("the project default must be offered; a default the project stops offering falls back to merge", async () => {
    const h = await setup();
    expect(h.orch.updateProject(h.project.id, { completionAction: "pr" }).completionAction).toBe("pr");
    expectStatus(() => h.orch.updateProject(h.project.id, { completionAction: "ship" as never }), 400, /must be one of merge, pr, custom/);

    const local = await setup({ remote: null });
    expectStatus(() => local.orch.updateProject(local.project.id, { completionAction: "pr" }), 400, /gh is logged into/);

    // The remote goes away: the stored pr default is kept, but approving merges.
    await h.git("remote", "remove", "origin");
    clearPullRequestTargets();
    expect(h.orch.listProjects()[0]!.completionActions).toEqual(["merge", "custom"]);
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    expect(h.get(t).completionAction).toBe("merge");
    expect(h.completes()[0]!.systemPrompt).toContain("## This run: completion\n");
    expect(h.get(t).status).toBe("done");
  });
});

describe("choosing at approval", () => {
  test("the choice made before the agent review finishes is kept and runs once the ticket is ready", async () => {
    const h = await setup({ autoComplete: true });
    // Hold the agent review so the human approves first.
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x [hold-review]" });
    await h.orch.idle().catch(() => {});
    await Bun.sleep(50);
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
  });

  test("an action the ticket doesn't offer is refused before anything changes", async () => {
    const h = await setup({ remote: null });
    const t = await h.inReview();
    expectStatus(() => h.orch.humanReview(t.key, { decision: "approve", action: "pr" }), 400, /gh is logged into/);
    expect(h.get(t)).toMatchObject({ humanReview: "pending", completionAction: null });
    h.orch.humanReview(t.key, { decision: "approve" });
    await expect(h.orch.completeTicket(t.key, { action: "pr" })).rejects.toThrow(/gh is logged into/);
    expect(h.completes()).toHaveLength(0);
  });

  test("custom follows the approver's instructions and gets no merge steps", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "Cherry-pick onto release-2.4" });
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    const run = h.completes()[0]!;
    expect(run.systemPrompt).toContain("## This run: completion (the approver's instructions)");
    expect(run.systemPrompt).not.toContain("fetch . harness/web-1:main");
    expect(run.prompt).toContain("## Instructions from the human\nCherry-pick onto release-2.4");
    expect(h.get(t).status).toBe("done");
  });

  test("a new action without instructions drops the earlier action's instructions", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "Tag it" });
    await h.orch.completeTicket(t.key, { action: "merge" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ completionAction: "merge", completionInstructions: null });
    expect(h.completes()[0]!.prompt).not.toContain("Tag it");
  });
});

describe("pull request completions", () => {
  test("a pr completion that records no pull request blocks instead of finishing", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "pr", instructions: "[no-pr]" });
    await h.orch.completeTicket(t.key);
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
          await req.toolContext.ops.recordPullRequest(req.toolContext, "https://github.com/acme/web/pull/9");
        } catch (err) {
          refused = (err as Error).message;
        }
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    // The script also stands in for work and review: submit and approve by hand.
    const u = h.get(t);
    h.store.tickets.update(u.id, { status: "review", agentReview: "approved" });
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    expect(refused).toContain("only for completion runs that open a pull request");
    expect(h.get(t).pullRequestUrl).toBeNull();
    expect(h.get(t).status).toBe("done");
  });
});

describe("Approve and take no action", () => {
  test("in review: done and approved with no completion run, the worktree and branch left alone", async () => {
    const h = await setup({ autoComplete: true });
    // The agent review is still running when the human takes no action.
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x [hold-review]" });
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
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(h.get(t)).toMatchObject({ status: "done", humanReview: "pending" });
  });
});

describe("children land on their parent's branch", () => {
  test("a conductor's children branch from its branch, only merge, and merge into it", async () => {
    const h = await setup();
    h.orch.updateProject(h.project.id, { completionAction: "pr" });
    const parent = await h.orch.createTicket({ projectId: h.project.id, prompt: "Big goal", kind: "conductor", start: false });
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
    const parent = await h.orch.createTicket({ projectId: h.project.id, prompt: "goal", start: false });
    h.store.tickets.update(parent.id, { branch: "harness/web-1", workdir: h.repo, status: "in_progress" });
    const child = await h.orch.createTicket({ projectId: h.project.id, prompt: "part", start: false });
    h.store.db.query("UPDATE tickets SET parent_id = $p WHERE id = $id").run({ p: parent.id, id: child.id });
    h.store.tickets.update(child.id, { status: "review", agentReview: "approved" });
    expectStatus(() => h.orch.humanReview(child.key, { decision: "approve", action: "pr" }), 400, /merges into its parent's branch harness\/web-1/);
    expectStatus(() => h.orch.humanReview(child.key, { decision: "approve", action: "custom" }), 400, /merges into its parent's branch/);
    expect(h.orch.humanReview(child.key, { decision: "approve", action: "merge" }).completionAction).toBe("merge");
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
