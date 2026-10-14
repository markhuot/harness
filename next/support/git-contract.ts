import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileGit } from "../../service/src/orchestrator/file-git";
import type { GitPort } from "../../service/src/orchestrator/git-port";

/** What the contract needs from an implementation: a port, plus the few things a test does to git around it. */
export interface GitFixture {
  port: GitPort;
  /** A repository on `main` with one commit, and a directory that holds worktrees. */
  repo(): Promise<{ repo: string; worktrees: string }>;
  /** An existing directory that isn't a repository. */
  plainDir(): Promise<string>;
  /** A commit on whatever is checked out at `dir`, adding `file` when given. */
  commit(dir: string, file?: string): Promise<void>;
  /** Uncommitted changes in the checkout at `dir` (a new `file`, by default dirty.txt). */
  dirty(dir: string, file?: string): Promise<void>;
  /** A commit on `branch` that leaves every checkout alone. */
  commitOnBranch(repo: string, branch: string): Promise<void>;
  /** `git worktree add` from outside harness: `path` on `branch`, created at HEAD when `create`. */
  addWorktree(repo: string, path: string, branch: string, create?: boolean): Promise<void>;
  /** `git worktree remove --force`. */
  removeWorktree(repo: string, path: string): Promise<void>;
  /** `git branch -D`. */
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** A branch at the tip of main, checked out nowhere. */
  branch(repo: string, name: string): Promise<void>;
  /** Merge `branch` into the branch checked out at `repo`. */
  merge(repo: string, branch: string): Promise<void>;
}

/**
 * The assertions every GitPort must satisfy. They run against the in-memory port (next/git) on every
 * run and against real git (next/contract), so the fake can't drift from what git does.
 */
export function gitPortContract(label: string, make: () => GitFixture) {
  describe(`GitPort contract: ${label}`, () => {
    test("a repository is a repo; a plain or missing directory is not", async () => {
      const f = make();
      const { repo } = await f.repo();
      expect(await f.port.isRepo(repo)).toBe(true);
      expect(await f.port.isRepo(await f.plainDir())).toBe(false);
      expect(await f.port.isRepo(`${repo}/missing`)).toBe(false);
    });

    test("heads: the repo is on main with a commit; outside git there's nothing", async () => {
      const f = make();
      const { repo } = await f.repo();
      expect(await f.port.currentBranch(repo)).toBe("main");
      const head = await f.port.headCommit(repo);
      expect(head).toBeTruthy();
      expect(await f.port.resolveCommit(repo, "main")).toBe(head);
      expect(await f.port.resolveCommit(repo, "nope")).toBeNull();
      expect(await f.port.resolveCommit(repo, "HEAD")).toBe(head);
      expect(await f.port.resolveCommit(repo, "refs/heads/main")).toBe(head);
      expect(await f.port.resolveCommit(repo, "refs/heads/nope")).toBeNull();
      // An abbreviated sha resolves to the full one.
      expect(await f.port.resolveCommit(repo, head!.slice(0, 10))).toBe(head);
      const plain = await f.plainDir();
      expect(await f.port.headCommit(plain)).toBeNull();
      expect(await f.port.currentBranch(plain)).toBeNull();
    });

    test("ensureWorktree starts harness/<key> from the base, and is the same on a second call", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const first = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(first.branch).toBe("harness/web-1");
      expect(await f.port.currentBranch(first.workdir)).toBe("harness/web-1");
      expect(await f.port.headCommit(first.workdir)).toBe(await f.port.headCommit(repo));
      expect(await f.port.checkedOutElsewhere(repo, "harness/web-1")).toMatchObject({ branch: "harness/web-1" });
      expect(await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" })).toEqual(first);
    });

    test("ensureWorktree refuses a base that doesn't exist and a branch another worktree holds", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "develop" })).rejects.toThrow(/base branch develop doesn't exist/);
      await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", branch: "harness/web-1", base: "main" })).rejects.toThrow(/already checked out/);
      // The main checkout holds main, so a ticket can't take it either.
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-3", branch: "main", base: "main" })).rejects.toThrow(/already checked out/);
    });

    test("switchBranch creates a missing branch at HEAD and reports whether it did", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.switchBranch(workdir, "topic")).toEqual({ created: true });
      expect(await f.port.currentBranch(workdir)).toBe("topic");
      expect(await f.port.switchBranch(workdir, "harness/web-1")).toEqual({ created: false });
      expect(await f.port.currentBranch(workdir)).toBe("harness/web-1");
    });

    test("hasChangesToLand: clean is false, a commit or a dirty tree is true, a missing worktree is unknown", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(false);
      await f.commit(workdir);
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(true);
      await f.merge(repo, "harness/web-1");
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(false);
      await f.dirty(workdir);
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(true);
      expect(await f.port.hasChangesToLand(`${worktrees}/gone`, "harness/web-1", "main")).toBeNull();
      expect(await f.port.hasChangesToLand(repo, "harness/web-1", "no-such-base")).toBeNull();
      // Committing takes the uncommitted changes with it: once merged, nothing is left to land.
      await f.commit(workdir);
      await f.merge(repo, "harness/web-1");
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(false);
    });

    test("isMerged and aheadCount follow the commits, and count nothing for a missing branch", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(true);
      await f.commit(workdir);
      await f.commit(workdir);
      expect(await f.port.aheadCount(repo, "harness/web-1", "main")).toBe(2);
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(false);
      // A commit the base already has doesn't count: it arrives with the merge anyway.
      const parent = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", base: "main" });
      await f.commit(parent.workdir);
      const child = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-3", base: "harness/web-2" });
      await f.commit(child.workdir);
      expect(await f.port.aheadCount(repo, "harness/web-3", "main")).toBe(2);
      expect(await f.port.aheadCount(repo, "harness/web-3", "main", "harness/web-2")).toBe(1);
      await f.merge(repo, "harness/web-1");
      expect(await f.port.aheadCount(repo, "harness/web-1", "main")).toBe(0);
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(true);
      expect(await f.port.aheadCount(repo, "nope", "main")).toBe(0);
      expect(await f.port.isMerged(repo, "nope", "main")).toBe(false);
    });

    test("commitOnBranch moves a branch nobody has checked out, and leaves the checkout where it was", async () => {
      const f = make();
      const { repo } = await f.repo();
      const head = await f.port.headCommit(repo);
      await f.branch(repo, "topic");
      await f.commitOnBranch(repo, "topic");
      expect(await f.port.resolveCommit(repo, "topic")).not.toBe(head);
      expect(await f.port.headCommit(repo)).toBe(head);
      expect(await f.port.aheadCount(repo, "topic", "main")).toBe(1);
      expect(await f.port.hasChangesToLand(repo, "main", "main")).toBe(false);
    });

    test("a worktree added outside harness holds its branch until it's removed; then the branch can go", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const herdr = `${worktrees}/herdr`;
      await f.addWorktree(repo, herdr, "medl", true);
      expect(await f.port.currentBranch(herdr)).toBe("medl");
      expect(await f.port.headCommit(herdr)).toBe(await f.port.headCommit(repo));
      const held = await f.port.checkedOutElsewhere(repo, "medl");
      expect(held?.branch).toBe("medl");
      expect(held?.path.endsWith("/herdr")).toBe(true);
      expect(await f.port.checkedOutElsewhere(repo, "medl", held!.path)).toBeNull();
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", branch: "medl", base: "main" })).rejects.toThrow(/branch medl is already checked out in the worktree at .*herdr/);
      await expect(f.deleteBranch(repo, "medl")).rejects.toThrow();
      await f.removeWorktree(repo, herdr);
      expect(await f.port.isRepo(herdr)).toBe(false);
      expect(await f.port.checkedOutElsewhere(repo, "medl")).toBeNull();
      expect(await f.port.branchExists(repo, "medl")).toBe(true);
      // An existing branch goes into a worktree as is.
      await f.commitOnBranch(repo, "medl");
      const elsewhere = `${worktrees}/elsewhere`;
      await f.addWorktree(repo, elsewhere, "medl");
      expect(await f.port.headCommit(elsewhere)).toBe(await f.port.resolveCommit(repo, "medl"));
      await f.removeWorktree(repo, elsewhere);
      await f.deleteBranch(repo, "medl");
      expect(await f.port.branchExists(repo, "medl")).toBe(false);
      expect(await f.port.resolveCommit(repo, "medl")).toBeNull();
    });

    test("switchBranch refuses when local changes would be overwritten, and carries the others along", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      const { workdir: second } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", base: "main" });
      // main moves on with f.txt, and other starts there.
      await f.commit(repo, "f.txt");
      await f.branch(repo, "other");
      await f.dirty(workdir, "f.txt");
      await expect(f.port.switchBranch(workdir, "other")).rejects.toThrow(/git switch other failed/);
      expect(await f.port.currentBranch(workdir)).toBe("harness/web-1");
      // A change to a file the switch doesn't touch doesn't stand in the way.
      await f.dirty(second, "g.txt");
      expect(await f.port.switchBranch(second, "other")).toEqual({ created: false });
      expect(await f.port.currentBranch(second)).toBe("other");
      expect(await f.port.hasChangesToLand(second, "other", "main")).toBe(true);
    });

    test("listBranches: newest first, where each is checked out, substring before fuzzy", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      await f.branch(repo, "feature/login");
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      await f.commit(workdir);
      const all = await f.port.listBranches(repo, "", 10);
      expect(all.map((b) => b.name)).toEqual(["harness/web-1", ...all.slice(1).map((b) => b.name)]);
      expect(all.map((b) => b.name).sort()).toEqual(["feature/login", "harness/web-1", "main"]);
      expect(all.find((b) => b.name === "main")!.checkedOutAt).toBe(repo);
      expect(all.find((b) => b.name === "feature/login")!.checkedOutAt).toBeNull();
      expect((await f.port.listBranches(repo, "log", 10)).map((b) => b.name)).toEqual(["feature/login"]);
      // "flg" is no substring of anything, but its letters appear in order in feature/login.
      expect((await f.port.listBranches(repo, "flg", 10)).map((b) => b.name)).toEqual(["feature/login"]);
      expect(await f.port.listBranches(repo, "", 1)).toHaveLength(1);
      expect(await f.port.listBranches(await f.plainDir(), "", 10)).toEqual([]);
    });
  });
}

/** What the FileGit contract needs: a port, plus `git init`, `git add` and `git commit` around it. */
export interface FileGitFixture {
  git: FileGit;
  /** A fresh, empty directory. */
  dir(): string;
  /** `git init`: a repository with no commits. */
  init(dir: string): Promise<void>;
  /** `git add` of `paths` relative to `dir` (`git add .` when none). */
  stage(dir: string, ...paths: string[]): Promise<void>;
  /** `git commit` of what's staged. */
  commit(dir: string): Promise<void>;
}

function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/**
 * The assertions every FileGit must satisfy, against memory (next/git) and the git binary
 * (next/contract). Patches are compared whole, so the fake's headers, hashes and hunks are git's.
 */
export function fileGitContract(label: string, make: () => FileGitFixture) {
  describe(`FileGit contract: ${label}`, () => {
    async function committed(files: Record<string, string>) {
      const f = make();
      const root = f.dir();
      write(root, files);
      await f.init(root);
      await f.stage(root);
      await f.commit(root);
      return { f, root };
    }

    test("a repository and a folder inside it are repos; a plain or missing folder is not", async () => {
      const { f, root } = await committed({ "pkg/a.txt": "a\n" });
      expect(await f.git.isRepo(root)).toBe(true);
      expect(await f.git.isRepo(join(root, "pkg"))).toBe(true);
      expect(await f.git.isRepo(join(root, "missing"))).toBe(false);
      const plain = f.dir();
      expect(await f.git.isRepo(plain)).toBe(false);
      expect(await f.git.listFiles(plain)).toBeNull();
      expect(await f.git.status(plain, "a.txt")).toEqual([]);
    });

    test("listFiles: tracked and untracked files, ignored folders once, folders of nothing but ignored files, .git left out", async () => {
      const f = make();
      const root = f.dir();
      write(root, {
        ".gitignore": "dist/\n.env\n*.log\n",
        "src/app.ts": "x",
        "notes.md": "x",
        "dist/assets/app.css": "x",
        ".env": "x",
        "a/.env": "x",
        "a/b.log": "x",
        "deep/x/keep.txt": "x",
        "deep/x/c.log": "x",
        "e/dist/o.js": "x",
        "pkg/p.txt": "x",
        "pkg/p.log": "x",
        "vendor/pkg/.git/HEAD": "x",
        "vendor/pkg/index.js": "x",
      });
      await f.init(root);
      await f.stage(root, "src/app.ts");
      const all = await f.git.listFiles(root);
      expect(all!.files.sort()).toEqual([".gitignore", "deep/x/keep.txt", "notes.md", "pkg/p.txt", "src/app.ts", "vendor/pkg/index.js"]);
      expect(all!.ignored.sort()).toEqual([".env", "a/", "a/.env", "a/b.log", "deep/x/c.log", "dist/", "e/", "e/dist/", "pkg/p.log"]);
      // From a folder inside the repository, paths are relative to it.
      expect(await f.git.listFiles(join(root, "pkg"))).toEqual({ files: ["p.txt"], ignored: ["p.log"] });
      // A tracked file that's gone from disk is still listed.
      await f.commit(root);
      rmSync(join(root, "src/app.ts"));
      expect((await f.git.listFiles(root))!.files).toContain("src/app.ts");
    });

    test("status: the porcelain codes for one path", async () => {
      const { f, root } = await committed({ ".gitignore": ".env\ndist/\n", "clean.txt": "c\n", "mod.txt": "m\n", "staged.txt": "s\n", "both.txt": "b\n", "gone.txt": "g\n" });
      write(root, { "mod.txt": "m2\n", "staged.txt": "s2\n", "both.txt": "b2\n", "fresh/new.txt": "n\n", ".env": "S=1\n", "dist/out.js": "o\n", "added.txt": "a\n" });
      await f.stage(root, "staged.txt", "both.txt", "added.txt");
      write(root, { "both.txt": "b3\n" });
      rmSync(join(root, "gone.txt"));
      const codes = async (rel: string) => f.git.status(root, rel);
      expect(await codes("clean.txt")).toEqual([]);
      expect(await codes("mod.txt")).toEqual([" M"]);
      expect(await codes("staged.txt")).toEqual(["M "]);
      expect(await codes("both.txt")).toEqual(["MM"]);
      expect(await codes("added.txt")).toEqual(["A "]);
      expect(await codes("gone.txt")).toEqual([" D"]);
      expect(await codes("fresh/new.txt")).toEqual(["??"]);
      expect(await codes(".env")).toEqual(["!!"]);
      expect(await codes("dist/out.js")).toEqual(["!!"]);
      expect(await codes("never.txt")).toEqual([]);
      expect(await f.git.status(join(root, "fresh"), "new.txt")).toEqual(["??"]);
      // Adding a folder adds what's in it.
      await f.stage(root, "fresh");
      expect(await codes("fresh/new.txt")).toEqual(["A "]);
    });

    test("hasHead and headFile: nothing before the first commit; HEAD's bytes after, relative to a folder, null over the cap", async () => {
      const f = make();
      const root = f.dir();
      write(root, { "a.txt": "four", "pkg/s.ts": "s\n" });
      await f.init(root);
      await f.stage(root);
      expect(await f.git.hasHead(root)).toBe(false);
      expect(await f.git.headFile(root, "a.txt", 100)).toBeNull();
      await f.commit(root);
      write(root, { "a.txt": "changed" });
      expect(await f.git.hasHead(root)).toBe(true);
      expect(new TextDecoder().decode((await f.git.headFile(root, "a.txt", 100))!)).toBe("four");
      expect(new TextDecoder().decode((await f.git.headFile(join(root, "pkg"), "s.ts", 100))!)).toBe("s\n");
      expect(await f.git.headFile(root, "a.txt", 4)).not.toBeNull();
      expect(await f.git.headFile(root, "a.txt", 3)).toBeNull();
      expect(await f.git.headFile(root, "never.txt", 100)).toBeNull();
    });

    test("diff: modified, deleted, untracked, inside a folder, against the empty tree, and over the cap", async () => {
      const { f, root } = await committed({ "a.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n", "pkg/s.ts": "a\n", "tail.txt": "a", "clean.txt": "c\n" });
      write(root, { "a.txt": "one\nTWO\nthree\n" });
      await f.stage(root, "a.txt");
      write(root, { "a.txt": "one\nTWO\nthree\nfour\n", "pkg/s.ts": "b\n", "new [1].ts": "export {};\n", "tail.txt": "b" });
      rmSync(join(root, "gone.txt"));
      const text = async (r: string, rel: string, base: "head" | "empty" | "untracked") => {
        const d = await f.git.diff(r, rel, base, 1 << 20);
        expect(d.tooLarge).toBe(false);
        return new TextDecoder().decode(d.patch);
      };
      expect(await text(root, "a.txt", "head")).toBe(
        "diff --git a/a.txt b/a.txt\nindex 4cb29ea..6addb9b 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n",
      );
      expect(await text(root, "gone.txt", "head")).toBe("diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex b023018..0000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n");
      expect(await text(root, "new [1].ts", "untracked")).toBe(
        "diff --git a/new [1].ts b/new [1].ts\nnew file mode 100644\nindex 0000000..cb0ff5c\n--- /dev/null\n+++ b/new [1].ts\t\n@@ -0,0 +1 @@\n+export {};\n",
      );
      expect(await text(join(root, "pkg"), "s.ts", "head")).toBe("diff --git a/s.ts b/s.ts\nindex 7898192..6178079 100644\n--- a/s.ts\n+++ b/s.ts\n@@ -1 +1 @@\n-a\n+b\n");
      expect(await text(root, "tail.txt", "head")).toBe(
        "diff --git a/tail.txt b/tail.txt\nindex 2e65efe..63d8dbd 100644\n--- a/tail.txt\n+++ b/tail.txt\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
      );
      expect(await text(root, "clean.txt", "head")).toBe("");
      expect(await f.git.diff(root, "a.txt", "head", 10)).toEqual({ patch: new Uint8Array(0), tooLarge: true });

      const fresh = f.dir();
      write(fresh, { "a.txt": "a\n" });
      await f.init(fresh);
      await f.stage(fresh, "a.txt");
      expect(await text(fresh, "a.txt", "empty")).toBe("diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..7898192\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+a\n");
    });

    test("diff: changes far apart are separate hunks with three lines of context", async () => {
      const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
      const { f, root } = await committed({ "long.txt": body.join("") });
      const changed = [...body];
      changed[1] = "LINE 2\n";
      changed[17] = "LINE 18\n";
      write(root, { "long.txt": changed.join("") });
      const patch = new TextDecoder().decode((await f.git.diff(root, "long.txt", "head", 1 << 20)).patch);
      expect(patch.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@ line 14"]);
    });
  });
}
