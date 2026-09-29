// Git plugin routes against real temporary git repositories, through the real service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient, type Project, type Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { createHarness, type Harness } from "../../service/src/app";
import { DummyDriver } from "../../service/src/drivers/dummy";
import { stubBrowser } from "../../service/src/testing/fakes";
import type { ChangedFile, Changes, Commit } from "./git";
import { parseNameStatus, parseNumstat, truncatePatch } from "./git";
import { pinsSettled } from "./server";

let h: Harness;
let client: HarnessClient;
let root: string;

beforeAll(async () => {
  root = tempDir("harness-git-plugin-");
  h = await createHarness({ home: join(root, "home"), port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
  client = new HarnessClient({ baseUrl: h.url, token: h.token });
  await client.updateSettings({ defaultDriver: "dummy" });
});
afterAll(async () => {
  await h.stop();
});

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

let seq = 0;
async function makeRepo(files: Record<string, string>, branch = "main") {
  const dir = join(root, `repo-${++seq}`);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", branch);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  if (Object.keys(files).length) {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "initial");
  }
  return dir;
}

async function ticketFor(projectPath: string, patch: Partial<Ticket>) {
  const project = await client.createProject({ path: projectPath, key: `G${++seq}` });
  const t = await client.createTicket({ projectId: project.id, prompt: "work", start: false });
  h.store.tickets.update(t.id, patch as never);
  return { project: project as Project, ticket: h.store.tickets.getByKey(t.key)! };
}

const changes = (key: string, extra = "") => client.request<Changes>("GET", `/plugins/git/api/changes?ticket=${key}${extra}`);
const byPath = (files: ChangedFile[]) => Object.fromEntries(files.map((f) => [f.path, f]));
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("GET /plugins/git/api/changes", () => {
  test("branch mode: merge-base..worktree incl. commits, uncommitted edits, untracked files, deletions and renames; user index untouched", async () => {
    const repo = await makeRepo({
      "a.txt": lines(5),
      "b.txt": "delete me\n",
      "c.txt": lines(3),
      "src/old-name.ts": lines(20, "export const x ="),
      "d.txt": "main only\n",
      ".gitignore": "ignored.log\n",
    });
    const wt = join(root, `wt-${seq}`);
    await git(repo, "worktree", "add", "-q", wt, "-b", "harness/g-1");

    // Committed on the ticket branch
    writeFileSync(join(wt, "a.txt"), lines(5).replace("line 3", "line three") + "line 6\n");
    unlinkSync(join(wt, "b.txt"));
    renameSync(join(wt, "src/old-name.ts"), join(wt, "src/new-name.ts"));
    await git(wt, "add", "-A");
    await git(wt, "commit", "-qm", "ticket work");
    writeFileSync(join(wt, "a.txt"), lines(5).replace("line 3", "line three") + "line 6\nline 7\n");
    await git(wt, "commit", "-qam", "more ticket work");
    // Uncommitted + untracked + ignored
    writeFileSync(join(wt, "c.txt"), "changed\n");
    mkdirSync(join(wt, "notes"));
    writeFileSync(join(wt, "notes", "untracked.md"), "# new\nhello\n");
    writeFileSync(join(wt, "ignored.log"), "noise\n");
    // Something staged in the user's real index, to prove we don't disturb it
    writeFileSync(join(wt, "staged.txt"), "staged\n");
    await git(wt, "add", "staged.txt");
    // main moves on after the branch point: must not show up
    writeFileSync(join(repo, "d.txt"), "main moved\n");
    await git(repo, "commit", "-qam", "main work");

    const statusBefore = await git(wt, "status", "--porcelain=v1");
    const cachedBefore = await git(wt, "diff", "--cached", "--name-status");
    const { ticket } = await ticketFor(repo, { workdir: wt, branch: "harness/g-1" });
    const c = await changes(ticket.key);

    expect(c.mode).toBe("branch");
    expect(c.base).toBe("main");
    expect(c.branch).toBe("harness/g-1");
    expect(c.baseSha).toBe(await git(wt, "merge-base", "main", "HEAD"));
    expect(c.head).toBe(await git(wt, "rev-parse", "HEAD"));
    expect(c.truncated).toBe(false);
    const f = byPath(c.files);
    expect(Object.keys(f).sort()).toEqual(["a.txt", "b.txt", "c.txt", "notes/untracked.md", "src/new-name.ts", "staged.txt"]);
    expect(f["a.txt"]).toMatchObject({ status: "modified", additions: 3, deletions: 1 });
    expect(f["b.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(f["c.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 3 });
    expect(f["src/new-name.ts"]).toMatchObject({ status: "renamed", oldPath: "src/old-name.ts", additions: 0, deletions: 0 });
    expect(f["notes/untracked.md"]).toMatchObject({ status: "untracked", additions: 2, deletions: 0 });
    expect(f["staged.txt"]).toMatchObject({ status: "added" }); // in the index, so not "untracked"
    expect(c.additions).toBe(3 + 1 + 2 + 1);
    expect(c.patch).toContain("diff --git a/notes/untracked.md b/notes/untracked.md");
    expect(c.patch).toContain("rename from src/old-name.ts");
    expect(c.patch).toContain("+line three");
    expect(c.patch).not.toContain("main moved");
    expect(c.patch).not.toContain("ignored.log");

    // Nothing about the user's worktree or index changed.
    expect(await git(wt, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(await git(wt, "diff", "--cached", "--name-status")).toBe(cachedBefore);

    // The commit log only has the branch's commits.
    const log = await client.request<{ mode: string; base: string; commits: Commit[] }>("GET", `/plugins/git/api/log?ticket=${ticket.key}`);
    expect(log.base).toBe("main");
    expect(log.commits.map((x) => x.subject)).toEqual(["more ticket work", "ticket work"]);
    expect(log.commits[0]).toMatchObject({ author: "Test", email: "t@example.com" });
    expect(log.commits[0]!.sha).toHaveLength(40);
    expect(log.commits[0]!.date).toBeGreaterThan(Date.now() - 60_000);

    // File contents for context expansion: old side at the base, new side from the worktree.
    const oldA = await client.request<{ contents: string | null }>("GET", `/plugins/git/api/file?ticket=${ticket.key}&side=old&path=a.txt&ref=${c.baseSha}`);
    expect(oldA.contents).toBe(lines(5));
    const newA = await client.request<{ contents: string | null }>("GET", `/plugins/git/api/file?ticket=${ticket.key}&side=new&path=a.txt`);
    expect(newA.contents).toContain("line three");
    const gone = await client.request<{ contents: string | null }>("GET", `/plugins/git/api/file?ticket=${ticket.key}&side=new&path=b.txt`);
    expect(gone.contents).toBeNull();
    for (const bad of ["../secret", "/etc/passwd", ".git/config", "a/../../x"]) {
      await expect(client.request<any>("GET", `/plugins/git/api/file?ticket=${ticket.key}&side=new&path=${encodeURIComponent(bad)}`)).rejects.toMatchObject({ status: 400 });
    }
    await expect(client.request<any>("GET", `/plugins/git/api/file?ticket=${ticket.key}&side=old&path=a.txt&ref=HEAD;rm`)).rejects.toMatchObject({ status: 400 });
  });

  test("base branch follows the project's checked-out branch; a clean branch has no changes", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    await git(repo, "checkout", "-qb", "develop");
    writeFileSync(join(repo, "dev.txt"), "dev\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "develop work");
    const wt = join(root, `wt-${seq}`);
    await git(repo, "worktree", "add", "-q", wt, "-b", "harness/g-2");
    const { ticket } = await ticketFor(repo, { workdir: wt, branch: "harness/g-2" });
    const c = await changes(ticket.key);
    expect(c).toMatchObject({ mode: "branch", base: "develop", files: [], patch: "", additions: 0, deletions: 0, truncated: false });
    const log = await client.request<{ commits: Commit[] }>("GET", `/plugins/git/api/log?ticket=${ticket.key}`);
    expect(log.commits).toEqual([]);
  });

  test("base falls back to main/master when the project is detached", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" }, "master");
    const wt = join(root, `wt-${seq}`);
    await git(repo, "worktree", "add", "-q", wt, "-b", "harness/g-3");
    await git(repo, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "a.txt"), "b\n");
    const { ticket } = await ticketFor(repo, { workdir: wt, branch: "harness/g-3" });
    const c = await changes(ticket.key);
    expect(c.base).toBe("master");
    expect(c.files).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1, binary: false }]);
  });

  test("a ticket's base branch override beats the project's checked-out branch", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    await git(repo, "branch", "develop");
    // develop moves ahead of main with a change the ticket branch also has: diffing against main would show it.
    const dev = join(root, `dev-${seq}`);
    await git(repo, "worktree", "add", "-q", dev, "develop");
    writeFileSync(join(dev, "shared.txt"), "from develop\n");
    await git(dev, "add", "-A");
    await git(dev, "commit", "-qm", "develop work");
    const wt = join(root, `wt-${seq}`);
    await git(repo, "worktree", "add", "-q", wt, "-b", "harness/g-9", "develop");
    writeFileSync(join(wt, "ticket.txt"), "ticket\n");
    const { ticket } = await ticketFor(repo, { workdir: wt, branch: "harness/g-9", baseBranch: "develop" });
    const c = await changes(ticket.key);
    expect(c.base).toBe("develop");
    expect(c.files.map((f) => f.path)).toEqual(["ticket.txt"]);
    // Without the override the project's checked-out branch (main) is the base, and develop's commit shows.
    h.store.tickets.update(ticket.id, { baseBranch: null });
    const fallback = await changes(ticket.key);
    expect(fallback.base).toBe("main");
    expect(fallback.files.map((f) => f.path).sort()).toEqual(["shared.txt", "ticket.txt"]);
  });

  test("workdir mode (no branch): uncommitted + untracked changes vs HEAD", async () => {
    const repo = await makeRepo({ "a.txt": "a\n", "gone.txt": "x\n", "img.bin": "\0\0\0" });
    writeFileSync(join(repo, "a.txt"), "a\nb\n");
    unlinkSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "new.txt"), "n\n");
    writeFileSync(join(repo, "img.bin"), "\0\x01\0\x02");
    const { ticket } = await ticketFor(repo, { workdir: repo, branch: null });
    const c = await changes(ticket.key);
    expect(c.mode).toBe("workdir");
    expect(c.base).toBe("HEAD");
    expect(c.branch).toBe("main");
    expect(c.baseSha).toBe(await git(repo, "rev-parse", "HEAD"));
    const f = byPath(c.files);
    expect(f["a.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(f["gone.txt"]).toMatchObject({ status: "deleted" });
    expect(f["new.txt"]).toMatchObject({ status: "untracked", additions: 1 });
    expect(f["img.bin"]).toMatchObject({ status: "modified", binary: true, additions: 0, deletions: 0 });
    const log = await client.request<{ mode: string; commits: Commit[] }>("GET", `/plugins/git/api/log?ticket=${ticket.key}`);
    expect(log).toMatchObject({ mode: "workdir", commits: [] });
  });

  test("workdir mode on a repo with no commits yet", async () => {
    const repo = await makeRepo({});
    writeFileSync(join(repo, "first.txt"), "hello\n");
    const { ticket } = await ticketFor(repo, { workdir: repo, branch: null });
    const c = await changes(ticket.key);
    expect(c).toMatchObject({ mode: "workdir", head: null, baseSha: null });
    expect(c.files).toEqual([{ path: "first.txt", status: "untracked", additions: 1, deletions: 0, binary: false }]);
  });

  test("large diffs are truncated at a file boundary", async () => {
    const repo = await makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    writeFileSync(join(repo, "a.txt"), lines(50, "aaaa"));
    writeFileSync(join(repo, "b.txt"), lines(50, "bbbb"));
    writeFileSync(join(repo, "c.txt"), lines(50, "cccc"));
    const { ticket } = await ticketFor(repo, { workdir: repo, branch: null });
    const full = await changes(ticket.key);
    const firstFileEnd = full.patch.indexOf("diff --git a/b.txt");
    const c = await changes(ticket.key, `&maxBytes=${firstFileEnd + 40}`);
    expect(c.truncated).toBe(true);
    expect(c.files).toHaveLength(3); // the file list is always complete
    expect(c.patch.startsWith("diff --git a/a.txt b/a.txt")).toBe(true);
    expect(c.patch).not.toContain("b.txt");
    expect(c.patch).toBe(full.patch.slice(0, firstFileEnd));
  });

  test("errors: missing ticket param, unknown ticket, no workdir, not a git repo, auth", async () => {
    await expect(client.request<any>("GET", "/plugins/git/api/changes")).rejects.toMatchObject({ status: 400 });
    await expect(changes("NOPE-1")).rejects.toMatchObject({ status: 404 });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const none = await ticketFor(plain, { workdir: null });
    await expect(changes(none.ticket.key)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no workdir") });
    const notRepo = await ticketFor(plain, { workdir: plain });
    await expect(changes(notRepo.ticket.key)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not a git repository") });
    expect((await fetch(`${h.url}/plugins/git/api/changes?ticket=${notRepo.ticket.key}`)).status).toBe(401);
  });

  test("the built UI is served", async () => {
    const res = await fetch(`${h.url}/plugins/git/ui/index.html?tab=changes`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<script");
  });
});

describe("pinned diffs (the worktree is gone)", () => {
  const log = (key: string) => client.request<{ mode: string; base: string | null; commits: Commit[] }>("GET", `/plugins/git/api/log?ticket=${key}`);
  const file = (key: string, q: string) => client.request<{ contents: string | null }>("GET", `/plugins/git/api/file?ticket=${key}&${q}`);
  const refs = (repo: string, id: string) => git(repo, "for-each-ref", "--format=%(refname:lstrip=4) %(objectname)", `refs/harness/changes/${id}/`);
  const hasChanges = async (key: string) => (await client.ticketTabs(key)).some((t) => t.pluginId === "git" && t.id === "changes");

  /** Emit a ticket event the way the orchestrator does, then wait for the plugin's pin to settle. */
  async function upsert(key: string, patch: Partial<Ticket> = {}) {
    const t = h.store.tickets.getByKey(key)!;
    h.bus.emit({ kind: "ticket.upserted", ticket: h.store.tickets.update(t.id, patch as never)! });
    await pinsSettled();
  }

  async function ticketWithWork(key: string) {
    const repo = await makeRepo({ "a.txt": lines(5), "gone.txt": "bye\n" });
    const wt = join(root, `wt-${seq}`);
    const branch = `harness/${key}`;
    await git(repo, "worktree", "add", "-q", wt, "-b", branch);
    writeFileSync(join(wt, "a.txt"), lines(5).replace("line 2", "line two"));
    unlinkSync(join(wt, "gone.txt"));
    await git(wt, "add", "-A");
    await git(wt, "commit", "-qm", "ticket work");
    const { ticket } = await ticketFor(repo, { workdir: wt, branch, status: "in_progress" });
    return { repo, wt, branch, ticket };
  }

  test("a merged, removed and deleted branch keeps its Changes tab, diff, commits and file contents", async () => {
    const { repo, wt, branch, ticket } = await ticketWithWork("g-pin");
    expect(await refs(repo, ticket.id)).toBe("");

    // Uncommitted and untracked work is pinned too, as a snapshot commit on top of the branch head.
    writeFileSync(join(wt, "a.txt"), lines(5).replace("line 2", "line two").replace("line 4", "line four"));
    writeFileSync(join(wt, "new.txt"), "fresh\n");
    const statusBefore = await git(wt, "status", "--porcelain=v1");
    await upsert(ticket.key);
    const head = await git(wt, "rev-parse", "HEAD");
    const base = await git(wt, "merge-base", "main", "HEAD");
    const pinned = await refs(repo, ticket.id);
    expect(pinned).toContain(`base ${base}`);
    expect(pinned).toContain(`head ${head}`);
    const snapshot = /worktree ([0-9a-f]{40})/.exec(pinned)![1]!;
    expect(await git(repo, "rev-parse", `${snapshot}^`)).toBe(head);
    expect(await git(wt, "status", "--porcelain=v1")).toBe(statusBefore); // user's index untouched

    // The complete run: commit the rest, merge into main, and (still in the worktree) an event
    // arrives. The live diff is now empty (merge-base == HEAD); it must not replace the pin.
    await git(wt, "add", "-A");
    await git(wt, "commit", "-qm", "the rest");
    await upsert(ticket.key, { status: "review" });
    const beforeMerge = await refs(repo, ticket.id);
    expect(beforeMerge).not.toContain("worktree "); // committed now: no snapshot needed
    await git(repo, "merge", "-q", "--no-ff", "-m", "merge", branch);
    await upsert(ticket.key);
    expect(await refs(repo, ticket.id)).toBe(beforeMerge);
    writeFileSync(join(repo, "a.txt"), "main moved on\n");
    await git(repo, "commit", "-qam", "later main work");
    await git(repo, "worktree", "remove", wt);
    await git(repo, "branch", "-d", branch);
    await upsert(ticket.key, { status: "done" });
    expect(await refs(repo, ticket.id)).toBe(beforeMerge);

    expect(await hasChanges(ticket.key)).toBe(true);
    const c = await changes(ticket.key);
    expect(c).toMatchObject({ mode: "pinned", base: "main", baseSha: base, branch, worktree: null, truncated: false });
    expect(c.head).toBe(await git(repo, "rev-parse", "HEAD~1^2"));
    const f = byPath(c.files);
    expect(Object.keys(f).sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
    expect(f["a.txt"]).toMatchObject({ status: "modified", additions: 2, deletions: 2 });
    expect(f["gone.txt"]).toMatchObject({ status: "deleted" });
    expect(f["new.txt"]).toMatchObject({ status: "added", additions: 1 });
    expect(c.patch).toContain("+line four");
    expect(c.patch).not.toContain("main moved on");

    expect((await log(ticket.key)).commits.map((x) => x.subject)).toEqual(["the rest", "ticket work"]);
    expect((await file(ticket.key, `side=old&path=a.txt&ref=${c.baseSha}`)).contents).toBe(lines(5));
    // The new side comes from the pin, not the project checkout (where a.txt is "main moved on").
    expect((await file(ticket.key, "side=new&path=a.txt")).contents).toContain("line four");
    expect((await file(ticket.key, "side=new&path=gone.txt")).contents).toBeNull();
    await expect(file(ticket.key, "side=new&path=..%2Fx")).rejects.toMatchObject({ status: 400 });
  });

  test("uncommitted work survives a squash merge and gc once the branch is deleted", async () => {
    const { repo, wt, branch, ticket } = await ticketWithWork("g-squash");
    writeFileSync(join(wt, "wip.txt"), "never committed\n");
    await upsert(ticket.key, { status: "review" });
    await git(repo, "worktree", "remove", "--force", wt);
    await git(repo, "merge", "-q", "--squash", branch);
    await git(repo, "commit", "-qm", "squashed");
    await git(repo, "branch", "-D", branch);
    await git(repo, "reflog", "expire", "--expire=now", "--all");
    await git(repo, "gc", "-q", "--prune=now");

    const c = await changes(ticket.key);
    expect(c.mode).toBe("pinned");
    expect(c.worktree).toMatch(/^[0-9a-f]{40}$/);
    expect(c.files.map((x) => x.path)).toEqual(["a.txt", "gone.txt", "wip.txt"]);
    expect((await file(ticket.key, "side=new&path=wip.txt")).contents).toBe("never committed\n");
    // Commits come from base..head; the snapshot commit isn't one of the branch's commits.
    expect((await log(ticket.key)).commits.map((x) => x.subject)).toEqual(["ticket work"]);
  });

  test("nothing is pinned without changes, for done tickets, or without a branch; deleting the ticket drops its refs", async () => {
    const { repo, wt, ticket } = await ticketWithWork("g-rules");
    await upsert(ticket.key, { status: "done" });
    expect(await refs(repo, ticket.id)).toBe("");

    // A branch with no changes: nothing to pin, and no tab once the worktree is gone.
    const clean = await makeRepo({ "a.txt": "a\n" });
    const cleanWt = join(root, `wt-${seq}`);
    await git(clean, "worktree", "add", "-q", cleanWt, "-b", "harness/g-clean");
    const { ticket: cleanTicket } = await ticketFor(clean, { workdir: cleanWt, branch: "harness/g-clean", status: "in_progress" });
    await upsert(cleanTicket.key);
    expect(await refs(clean, cleanTicket.id)).toBe("");
    await git(clean, "worktree", "remove", cleanWt);
    expect(await hasChanges(cleanTicket.key)).toBe(false);
    await expect(changes(cleanTicket.key)).rejects.toMatchObject({ status: 409 });

    // Workdir mode (no branch) never pins.
    const plain = await makeRepo({ "a.txt": "a\n" });
    writeFileSync(join(plain, "a.txt"), "b\n");
    const { ticket: plainTicket } = await ticketFor(plain, { workdir: plain, branch: null, status: "in_progress" });
    await upsert(plainTicket.key);
    expect(await git(plain, "for-each-ref", "refs/harness/")).toBe("");

    await upsert(ticket.key, { status: "review" });
    expect(await refs(repo, ticket.id)).toContain("base ");
    await git(repo, "worktree", "remove", wt);
    expect(await hasChanges(ticket.key)).toBe(true);
    await client.deleteTicket(ticket.key);
    await pinsSettled();
    expect(await refs(repo, ticket.id)).toBe("");
  });
});

describe("git output parsers", () => {
  test("name-status and numstat -z, including renames and binaries", () => {
    expect(parseNameStatus("M\0a.txt\0R087\0old.ts\0new.ts\0D\0gone\0")).toEqual([
      { status: "M", path: "a.txt" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "D", path: "gone" },
    ]);
    const n = parseNumstat("3\t1\ta.txt\0" + "0\t0\t\0old.ts\0new.ts\0" + "-\t-\timg.png\0");
    expect(n.get("a.txt")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(n.get("new.ts")).toEqual({ additions: 0, deletions: 0, binary: false });
    expect(n.get("img.png")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(n.has("old.ts")).toBe(false);
  });

  test("truncatePatch keeps whole files only", () => {
    const p = "diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n";
    expect(truncatePatch(p, 1000)).toEqual({ patch: p, truncated: false });
    expect(truncatePatch(p, 25)).toEqual({ patch: "diff --git a/x b/x\n+1\n", truncated: true });
    expect(truncatePatch(p, 5)).toEqual({ patch: "", truncated: true });
  });
});
