import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, GREETER_FILES, readSetting, seedRepo, setSessionContext, withDb, writeSetting } from "./seed";
import { startDaemon } from "./daemon";
import { tempDir } from "./tmp";

describe("seedRepo", () => {
  test("commits the files on main with the extra branches and worktrees", async () => {
    const root = tempDir("harness-seed-");
    const repo = join(root, "greeter");
    await seedRepo(repo, GREETER_FILES, { branches: ["feature/x"], worktrees: [{ branch: "release/v2", path: join(root, "release") }] });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(GREETER_FILES["README.md"]!);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect((await git(repo, "branch", "--format=%(refname:short)")).split("\n").sort()).toEqual(["feature/x", "main", "release/v2"]);
    expect(existsSync(join(root, "release", "README.md"))).toBe(true);
  });

  test("seeding twice adds no commit, keeps local edits and doesn't fail on existing branches", async () => {
    const root = tempDir("harness-seed-");
    const repo = join(root, "r");
    const opts = { branches: ["b1"], worktrees: [{ branch: "wt", path: join(root, "wt") }] };
    await seedRepo(repo, { "a.txt": "one\n" }, opts);
    const head = await git(repo, "rev-parse", "HEAD");
    await Bun.write(join(repo, "a.txt"), "edited\n");
    await seedRepo(repo, { "a.txt": "one\n", "b.txt": "new\n" }, opts);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("edited\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  test("a git failure surfaces git's message", async () => {
    await expect(git(tempDir("harness-seed-"), "log")).rejects.toThrow(/exit 128/);
  });
});

describe("database seeds", () => {
  test("settings and session context written under a running daemon are read back by the service", async () => {
    const d = await startDaemon();
    try {
      writeSetting(d.home, "contextGaugeLimit", 400000);
      expect(readSetting<number>(d.home, "contextGaugeLimit")).toBe(400000);
      const repo = await seedRepo(tempDir("harness-seed-"), GREETER_FILES);
      const project = await d.api<{ id: string }>("POST", "/projects", { path: repo, name: "greeter", key: "GREET" });
      const t = await d.api<{ key: string; sessionId: string }>("POST", "/tickets", { projectId: project.id, spec: "x", driver: "dummy", start: false });
      setSessionContext(d.home, t.sessionId, { input: 1000, cacheRead: 61000, cacheWrite: 20000, output: 800, prefix: 50000, at: Date.now(), estimated: false, misses: 0, missTokens: 0 });
      const detail = await d.api<{ ticket: { context?: { cacheRead: number } } }>("GET", `/tickets/${t.key}`);
      expect(detail.ticket.context?.cacheRead).toBe(61000);
      expect(withDb(d.home, (db) => (db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n)).toBeGreaterThan(0);
    } finally {
      await d.stop();
    }
  });
});
