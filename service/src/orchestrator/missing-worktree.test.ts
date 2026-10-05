// A ticket whose worktree is gone, and runs that fail on their way to landing the work (HARNESS-249):
// runs start from the project checkout with a note telling the agent what's missing, a failed
// completion keeps its approvals instead of blocking, and a failed review run says so in Activity.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "@harness/shared";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { makeOrchestrator } from "../testing/fakes";
import { git as runGit } from "./worktree";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
setDefaultTimeout(30_000);

async function setup() {
  let now = Date.now();
  const h = makeOrchestrator({ now: () => now });
  h.driver.commitsWork = true;
  const repo = join(h.home, "repo");
  mkdirSync(repo);
  const git = async (...args: string[]) => {
    const r = await runGit(args, repo);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  const project = h.orch.createProject({ path: repo, key: "web" });
  const get = (t: Ticket) => h.store.tickets.get(t.id)!;
  const behave = (h.driver as unknown as { behave(req: RunRequest): AsyncIterable<DriverEvent> }).behave.bind(h.driver);
  /** Fail the runs `fails` picks with `message`; every other run behaves as usual. */
  const failWhen = (fails: (req: RunRequest) => boolean, message: string) => {
    h.driver.script = async function* (req) {
      if (fails(req)) {
        yield { type: "error", message };
        return;
      }
      yield* behave(req);
    };
  };
  /** A ticket worked and agent-reviewed, waiting on the human. */
  const inReview = async () => {
    const t = await h.orch.createTicket({ projectId: project.id, spec: "x" });
    await h.orch.idle();
    expect(get(t)).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    return get(t);
  };
  const activity = (t: Ticket) => h.store.activity.listBySession(t.sessionId);
  const runsOf = (t: Ticket, kind: string) => h.driver.calls.filter((c) => c.kind === kind && h.store.runs.get(c.runId)?.sessionId === t.sessionId);
  return { ...h, repo, git, project, get, failWhen, inReview, activity, runsOf, setNow: (ms: number) => (now = ms) };
}

describe("a missing worktree", () => {
  test("a review runs from the project checkout, told the branch still exists and the commit it last reviewed", async () => {
    const h = await setup();
    const t = await h.inReview();
    const reviewed = await h.git("rev-parse", "harness/web-1");
    await h.git("worktree", "remove", "--force", t.workdir!);
    h.orch.rerunAgentReview(t.key);
    await h.orch.idle();
    const run = h.runsOf(t, "review").at(-1)!;
    expect(run.cwd).toBe(h.repo);
    expect(run.prompt).toContain(`this ticket's worktree at ${t.workdir} is missing`);
    expect(run.prompt).toContain("Branch `harness/web-1` still exists, and it isn't in the base branch `main`.");
    expect(run.prompt).toContain(`The last commit an earlier review round checked is ${reviewed}.`);
    expect(run.prompt).toContain(`worktree add ${t.workdir} harness/web-1`);
    // The run got through (it didn't fail on the missing directory) and decided.
    expect(h.get(t).agentReview).toBe("approved");
    expect(h.activity(t).some((e) => e.kind === "failed")).toBe(false);
  });

  test("with the branch merged and deleted, the note says it's gone and the reviewed commit already landed", async () => {
    const h = await setup();
    const t = await h.inReview();
    const reviewed = await h.git("rev-parse", "harness/web-1");
    // What HARNESS-244's agent did by hand: merge, remove the worktree, delete the branch.
    await h.git("merge", "-q", "--no-ff", "-m", "merge", "harness/web-1");
    await h.git("worktree", "remove", "--force", t.workdir!);
    await h.git("branch", "-D", "harness/web-1");
    h.orch.rerunAgentReview(t.key);
    await h.orch.idle();
    const run = h.runsOf(t, "review").at(-1)!;
    expect(run.cwd).toBe(h.repo);
    expect(run.prompt).toContain(`Branch \`harness/web-1\` no longer exists, and commit ${reviewed} is already in the base branch \`main\`.`);
    expect(run.prompt).toContain(`worktree add -b harness/web-1 ${t.workdir} ${reviewed}`);
    expect(run.prompt).toContain(`review it straight from git instead (\`git show\`, \`git diff ${reviewed} main\`)`);
  });

  test("a work run is told to recreate the worktree from the base when the branch is gone", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.driver.commitsWork = false;
    await h.git("worktree", "remove", "--force", t.workdir!);
    await h.git("branch", "-D", "harness/web-1");
    // A request for changes queues a work run without preparing a workdir.
    h.orch.humanReview(t.key, { decision: "request_changes", notes: "Rename it." });
    await h.orch.idle();
    const run = h.runsOf(t, "work").at(-1)!;
    expect(run.cwd).toBe(h.repo);
    expect(run.prompt).toContain("Branch `harness/web-1` no longer exists.");
    expect(run.prompt).toContain(`worktree add -b harness/web-1 ${t.workdir} main`);
    expect(run.prompt).not.toContain("earlier review round");
  });

  test("a completion is told it doesn't need the worktree back, and a cleanup with nothing left ends done", async () => {
    const h = await setup();
    const t = await h.inReview();
    await h.git("merge", "-q", "--no-ff", "-m", "merge", "harness/web-1");
    await h.git("worktree", "remove", "--force", t.workdir!);
    await h.git("branch", "-D", "harness/web-1");
    h.orch.humanReview(t.key, { decision: "approve", action: "cleanup" });
    await h.orch.idle();
    const run = h.runsOf(t, "complete").at(-1)!;
    expect(run.cwd).toBe(h.repo);
    expect(run.prompt).toContain("A completion doesn't need the worktree back");
    expect(run.prompt).not.toContain("recreate the worktree");
    expect(h.get(t).status).toBe("done");
  });

  test("a chat about a done ticket gets no note: its worktree was removed on purpose", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t).status).toBe("done");
    await h.git("worktree", "remove", "--force", t.workdir!).catch(() => {});
    await h.orch.sendMessage(t.key, "what changed?");
    await h.orch.idle();
    const run = h.runsOf(t, "chat").at(-1)!;
    expect(run.cwd).toBe(h.repo);
    expect(run.prompt).not.toContain("worktree at");
  });
});

describe("a failed completion", () => {
  test("stays in review with the agent review approved; approving again lands it", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.failWhen((req) => req.kind === "complete", "driver crashed");
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending", completionAction: "merge", blockedReason: null });
    const all = h.activity(t);
    const entries = all.slice(all.findIndex((e) => e.kind === "approved"));
    expect(entries.some((e) => e.kind === "failed" && e.body === "Completion failed: driver crashed")).toBe(true);
    expect(entries.some((e) => e.meta.to === "blocked" || e.meta.to === "in_progress")).toBe(false);
    expect(h.runsOf(t, "work")).toHaveLength(1);
    h.driver.script = null;
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t).status).toBe("done");
    expect(h.runsOf(t, "complete")).toHaveLength(2);
  });

  test("a conductor's child stays approved, and its conductor completes it again", async () => {
    const h = await setup();
    let failed = 0;
    h.failWhen((req) => req.kind === "complete" && failed++ === 0, "driver crashed");
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Goal\n- Only child", kind: "conductor", start: true });
    await h.orch.idle();
    const [kid] = h.store.tickets.list({ parentId: parent.id });
    const child = h.get(kid!);
    expect(h.runsOf(child, "complete")).toHaveLength(2);
    expect(child.status).toBe("done");
    const entries = h.activity(child);
    expect(entries.some((e) => e.kind === "failed" && e.body === "Completion failed: driver crashed")).toBe(true);
    expect(entries.some((e) => e.meta.to === "blocked")).toBe(false);
    // The conductor heard about it: its update run named the failure.
    expect(h.runsOf(parent, "conductor").some((c) => c.prompt.includes("Completion failed (driver crashed)") && c.prompt.includes("call complete_ticket again"))).toBe(true);
  });
});

describe("a completion stopped by a usage limit", () => {
  test("blocks with both reviews back to pending, restarts after the reset, and goes through review and completion again", async () => {
    const h = await setup();
    const t = await h.inReview();
    const now = Date.now();
    h.setNow(now);
    const reset = Math.floor(now / 1000) * 1000 + 3600_000;
    const limit = `Claude AI usage limit reached|${reset / 1000}`;
    h.failWhen((req) => req.kind === "complete", limit);
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "blocked", agentReview: "pending", humanReview: "pending", blockedReason: limit, resumeAt: reset + 5 * 60_000 });
    expect(h.activity(t).some((e) => e.kind === "failed" && /^Completion failed: .+ Restarts on its own at \d{1,2}:\d{2} [AP]M\.$/.test(e.body))).toBe(true);

    h.driver.script = null;
    h.setNow(reset + 5 * 60_000 + 1);
    await h.orch.resumeDue();
    await h.orch.idle();
    expect(h.activity(t).map((e) => e.body)).toContain("Restarted after the usage limit reset");
    expect(h.get(t)).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    expect(h.runsOf(t, "work")).toHaveLength(2);
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t).status).toBe("done");
    expect(h.runsOf(t, "complete")).toHaveLength(2);
  });

  test("a spend limit that names no reset time blocks without a restart", async () => {
    const h = await setup();
    const t = await h.inReview();
    h.failWhen((req) => req.kind === "complete", "You've hit your spend limit");
    h.orch.humanReview(t.key, { decision: "approve", action: "merge" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "blocked", humanReview: "pending", blockedReason: "You've hit your spend limit", resumeAt: null });
    expect(h.activity(t).at(-1)!.body).toBe("Completion failed: You've hit your spend limit");
  });
});

describe("a failed review run", () => {
  test("adds a failed entry, and the ticket stays in review with the review pending", async () => {
    const h = await setup();
    h.failWhen((req) => req.kind === "review", "reviewer crashed");
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(h.get(t)).toMatchObject({ status: "review", agentReview: "pending" });
    expect(h.activity(t).at(-1)).toMatchObject({ kind: "failed", body: "Agent review failed: reviewer crashed. Re-run agent review to try again." });
  });
});
