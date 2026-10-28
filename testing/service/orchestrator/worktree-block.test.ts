import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, gitRepo } from "../git";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";
import { replyScript } from "../fake-driver";

afterEach(stopAll);

/** A ticket that asked for `main`, which the project checkout has checked out: its worktree can't be made. */
async function blockedOnWorktree() {
  const h = makeOrchestrator({ tools: undefined });
  const repo = gitRepo();
  const project = h.orch.createProject({ path: repo, name: "Wt", key: "WT", useWorktrees: true });
  const t = await h.orch.createTicket({ projectId: project.id, spec: "Cut a release", branch: "main", skipAgentReview: true });
  await h.settle();
  return { h, repo, t };
}

test("a ticket whose worktree can't be made blocks without running", async () => {
  const { h, t } = await blockedOnWorktree();
  expect(h.driver.requests).toHaveLength(0);
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", workdir: null });
  expect(h.ticket(t.key).blockedReason).toContain("already checked out");
});

test("the human's message reaches a temporary chat in the project checkout, and its unblock starts the work in a fresh session in the worktree", async () => {
  const { h, repo, t } = await blockedOnWorktree();
  const attempts = callTools([["unblock", { note: "still on main" }]]);
  let fixed = false;
  const retry = callTools([["unblock", { note: "worktree freed" }]]);
  h.driver.script(
    [
      ...attempts.steps,
      // The agent frees `main` in the project checkout, then retries.
      { run: async () => void (git(repo, "switch", "-q", "-c", "scratch"), (fixed = true)) },
      ...retry.steps,
    ],
    replyScript("working in the worktree"),
  );
  await h.orch.sendMessage(t.key, "Please free up main");
  await h.settle();

  const [chat, work] = h.driver.requests;
  expect(chat).toMatchObject({ kind: "chat", cwd: repo });
  expect(chat!.prompt).toContain("Please free up main");
  expect(chat!.prompt).toContain("This chat runs in the project checkout");
  // The first unblock failed and left the ticket blocked, naming why; the second one worked.
  expect(attempts.results[0]).toMatchObject({ isError: true });
  expect(attempts.results[0]!.text).toContain("stays blocked");
  expect(fixed).toBe(true);
  expect(retry.results[0]).toMatchObject({ isError: false });

  const ticket = h.ticket(t.key);
  // The fresh work run ran to the end (the agent review is skipped), so the ticket is in review.
  expect(ticket).toMatchObject({ status: "review", blockedReason: null });
  expect(ticket.workdir).toBe(join(h.orch["paths"].worktreesDir, t.key));
  expect(existsSync(ticket.workdir!)).toBe(true);
  // The work run is a new conversation in the worktree, not the chat's.
  expect(work).toMatchObject({ kind: "work", cwd: ticket.workdir, state: null });
});

test("the human's Unblock button with notes starts a temporary chat in the project checkout when the worktree still can't be made", async () => {
  const { h, repo, t } = await blockedOnWorktree();
  h.driver.script(replyScript("looking into it"));
  const out = await h.orch.unblockTicket(t.key, { notes: "remove the old worktree" });
  await h.settle();
  expect(out.status).toBe("blocked");
  expect(h.driver.requests).toHaveLength(1);
  expect(h.driver.requests[0]).toMatchObject({ kind: "chat", cwd: repo });
  expect(h.driver.requests[0]!.prompt).toContain("remove the old worktree");
  expect(h.driver.requests[0]!.prompt).toContain("already checked out");
});
