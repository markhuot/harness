import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commonGitDir, ghHosts, ghInstalled, parseRemotes, parseRemoteUrl, pickRemote, pullRequestTarget, pushRemote } from "../../../service/src/store/remotes";
import { tempDir } from "../../builders/tmp";

test("parseRemoteUrl reads https, ssh and scp-style URLs and refuses local paths", () => {
  expect(parseRemoteUrl("https://GitHub.com/owner/repo.git")).toEqual({ host: "github.com", path: "owner/repo" });
  expect(parseRemoteUrl("https://user@host.example/o/r/")).toEqual({ host: "host.example", path: "o/r" });
  expect(parseRemoteUrl("ssh://git@ghe.corp:2222/o/r.git")).toEqual({ host: "ghe.corp", path: "o/r" });
  expect(parseRemoteUrl("git@github.com:o/r.git")).toEqual({ host: "github.com", path: "o/r" });
  expect(parseRemoteUrl("/srv/git/repo.git")).toBeNull();
  expect(parseRemoteUrl("../relative")).toBeNull();
});

test("parseRemotes keeps the first url per remote and ignores other sections and comments", () => {
  const config = `[core]\n\turl = nope\n# c\n[remote "origin"]\n\turl = https://h/o/r\n\turl = https://other\n[remote "up stream"]\n  url = "git@h:u/r.git"\n[branch "main"]\n\turl = x\n`;
  expect([...parseRemotes(config)]).toEqual([["origin", "https://h/o/r"], ["up stream", "git@h:u/r.git"]]);
});

test("pickRemote prefers origin, accepts a sole remote, and gives up on several", () => {
  expect(pickRemote(new Map([["a", "1"], ["origin", "2"]]))).toEqual({ name: "origin", url: "2" });
  expect(pickRemote(new Map([["fork", "1"]]))).toEqual({ name: "fork", url: "1" });
  expect(pickRemote(new Map([["a", "1"], ["b", "2"]]))).toBeNull();
  expect(pickRemote(new Map())).toBeNull();
});

test("ghHosts reads top-level keys of hosts.yml and adds github.com for a token", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "hosts.yml"), `github.com:\n    user: me\n"GHE.Corp":\n  user: x\n# comment\n`);
  expect([...ghHosts({ GH_CONFIG_DIR: dir })].sort()).toEqual(["ghe.corp", "github.com"]);
  expect([...ghHosts({ GH_CONFIG_DIR: tempDir(), GITHUB_TOKEN: "t" })]).toEqual(["github.com"]);
  expect([...ghHosts({ GH_CONFIG_DIR: tempDir(), GH_ENTERPRISE_TOKEN: "t", GH_HOST: "Ghe.Corp" })]).toEqual(["ghe.corp"]);
  expect(ghHosts({ GH_CONFIG_DIR: tempDir() }).size).toBe(0);
});

test("ghInstalled looks for a gh binary on the given PATH", () => {
  const withGh = tempDir();
  writeFileSync(join(withGh, "gh"), "");
  expect(ghInstalled({ PATH: `/nonexistent:${withGh}` })).toBe(true);
  expect(ghInstalled({ PATH: tempDir() })).toBe(false);
  expect(ghInstalled({})).toBe(false);
});

function repo(url: string | null) {
  const root = tempDir();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), url ? `[remote "origin"]\n\turl = ${url}\n` : "[core]\n");
  mkdirSync(join(root, "sub"));
  return root;
}

function env(hosts: string[]) {
  const gh = tempDir();
  writeFileSync(join(gh, "gh"), "");
  const cfg = tempDir();
  writeFileSync(join(cfg, "hosts.yml"), hosts.map((h) => `${h}:\n  user: x\n`).join(""));
  return { PATH: gh, GH_CONFIG_DIR: cfg };
}

test("a pull request target needs a repo, a parsable remote on a host gh is logged into, and gh installed", () => {
  const e = env(["github.com"]);
  const root = repo("git@github.com:o/r.git");
  expect(pullRequestTarget(join(root, "sub"), e)).toEqual({ host: "github.com", remote: "origin", repo: "github.com/o/r" });
  expect(pullRequestTarget(repo("git@gitlab.com:o/r.git"), e)).toBeNull();
  expect(pullRequestTarget(repo("/local/path"), e)).toBeNull();
  expect(pullRequestTarget(repo("https://github.com/onlyowner"), e)).toBeNull();
  expect(pullRequestTarget(repo(null), e)).toBeNull();
  expect(pullRequestTarget(root, { ...e, PATH: tempDir() })).toBeNull();
  expect(pullRequestTarget(tempDir(), e)).toBeNull();
});

test("a git worktree's .git file leads back to the common dir's config", () => {
  const main = repo("https://github.com/o/r.git");
  const wtGit = join(main, ".git", "worktrees", "wt");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, "commondir"), "../..");
  const wt = tempDir();
  writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
  expect(commonGitDir(wt)).toBe(join(wtGit, "../.."));
  expect(pushRemote(wt)).toBe("origin");
  const broken = tempDir();
  writeFileSync(join(broken, ".git"), "not a pointer");
  expect(commonGitDir(broken)).toBeNull();
  expect(pushRemote(tempDir())).toBeNull();
});
