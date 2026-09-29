import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { ghHosts, parseRemotes, parseRemoteUrl, pickRemote, pullRequestTarget } from "./remotes";

describe("remote URLs", () => {
  test("https, ssh and scp forms give host and owner/repo; local paths give nothing", () => {
    expect(parseRemoteUrl("https://github.com/acme/web.git")).toEqual({ host: "github.com", path: "acme/web" });
    expect(parseRemoteUrl("https://user@GitHub.com/acme/web/")).toEqual({ host: "github.com", path: "acme/web" });
    expect(parseRemoteUrl("git@github.com:acme/web.git")).toEqual({ host: "github.com", path: "acme/web" });
    expect(parseRemoteUrl("ssh://git@ghe.acme.com:2222/web/site.git")).toEqual({ host: "ghe.acme.com", path: "web/site" });
    expect(parseRemoteUrl("/Users/me/bare.git")).toBeNull();
    expect(parseRemoteUrl("../bare")).toBeNull();
    expect(parseRemoteUrl("file:///tmp/bare.git")).toBeNull();
  });

  test("git config remotes: origin, else the only remote; several without origin is ambiguous", () => {
    const config = `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/upstream/*\n[branch "main"]\n\tremote = upstream\n`;
    const remotes = parseRemotes(config);
    expect([...remotes]).toEqual([["upstream", "git@github.com:acme/web.git"]]);
    expect(pickRemote(remotes)).toEqual({ name: "upstream", url: "git@github.com:acme/web.git" });
    const two = parseRemotes(`${config}[remote "fork"]\n\turl = git@github.com:me/web.git\n`);
    expect(pickRemote(two)).toBeNull();
    const withOrigin = parseRemotes(`${config}[remote "origin"]\n\turl = https://github.com/acme/web\n`);
    expect(pickRemote(withOrigin)?.name).toBe("origin");
  });
});

describe("gh's logins", () => {
  test("hosts.yml keys, GH_CONFIG_DIR over XDG over HOME, and a token counts for github.com", () => {
    const dir = tempDir("harness-gh-");
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n    user: me\nghe.acme.com:\n    oauth_token: x\n");
    expect([...ghHosts({ GH_CONFIG_DIR: dir })].sort()).toEqual(["ghe.acme.com", "github.com"]);
    const xdg = tempDir("harness-xdg-");
    mkdirSync(join(xdg, "gh"));
    writeFileSync(join(xdg, "gh", "hosts.yml"), "ghe.acme.com:\n  user: me\n");
    expect([...ghHosts({ XDG_CONFIG_HOME: xdg })]).toEqual(["ghe.acme.com"]);
    expect([...ghHosts({ HOME: tempDir("harness-empty-") })]).toEqual([]);
    expect([...ghHosts({ HOME: tempDir("harness-empty-"), GH_TOKEN: "t" })]).toEqual(["github.com"]);
  });
});

describe("pullRequestTarget", () => {
  function repo(config: string) {
    const root = tempDir("harness-repo-");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), config);
    return root;
  }
  function gh(hosts: string) {
    const dir = tempDir("harness-gh-");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "gh"), 0o755);
    writeFileSync(join(dir, "hosts.yml"), hosts);
    return { GH_CONFIG_DIR: dir, PATH: join(dir, "bin"), HOME: dir };
  }
  const origin = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;

  test("a remote on a host gh is logged into; github.com and Enterprise alike", () => {
    const env = gh("github.com:\n  user: me\nghe.acme.com:\n  user: me\n");
    expect(pullRequestTarget(repo(origin("git@github.com:acme/web.git")), env)).toEqual({ host: "github.com", remote: "origin", repo: "github.com/acme/web" });
    expect(pullRequestTarget(repo(origin("https://ghe.acme.com/web/site.git")), env)?.repo).toBe("ghe.acme.com/web/site");
  });

  test("no pull request for Bitbucket, GitLab, a host gh isn't logged into, no remote, or no gh", () => {
    const env = gh("github.com:\n  user: me\n");
    for (const url of ["git@bitbucket.org:acme/web.git", "https://gitlab.com/acme/web.git", "https://ghe.acme.com/web/site.git", "/Users/me/bare.git"]) {
      expect(pullRequestTarget(repo(origin(url)), env)).toBeNull();
    }
    expect(pullRequestTarget(repo("[core]\n\tbare = false\n"), env)).toBeNull();
    expect(pullRequestTarget(repo(origin("git@github.com:acme/web.git")), { ...env, PATH: tempDir("harness-nogh-") })).toBeNull();
    expect(pullRequestTarget(tempDir("harness-plain-"), env)).toBeNull();
  });

  test("a worktree's .git file leads to the main repository's config", () => {
    const env = gh("github.com:\n  user: me\n");
    const main = repo(origin("git@github.com:acme/web.git"));
    const wtGit = join(main, ".git", "worktrees", "WEB-1");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = tempDir("harness-wt-");
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(pullRequestTarget(join(wt), env)?.repo).toBe("github.com/acme/web");
  });
});
