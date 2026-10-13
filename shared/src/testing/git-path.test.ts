import { describe, expect, test } from "bun:test";
import { pathBeforeUsrBin, realGitBehindShim, useRealGit } from "./git-path";
import { tempDir } from "./tmp";

const REAL = "/Library/Developer/CommandLineTools/usr/bin/git";
const mac = { platform: "darwin" as const, which: () => "/usr/bin/git", xcrunFind: () => REAL, exists: () => true };

describe("realGitBehindShim", () => {
  test("the shim on macOS gives xcrun's binary", () => {
    expect(realGitBehindShim("/usr/bin", mac)).toBe(REAL);
  });

  test("Linux, a git that isn't the shim, a failed xcrun, xcrun naming the shim, or a missing binary give nothing", () => {
    expect(realGitBehindShim("/usr/bin", { ...mac, platform: "linux" })).toBeNull();
    expect(realGitBehindShim("/opt/homebrew/bin", { ...mac, which: () => "/opt/homebrew/bin/git" })).toBeNull();
    expect(realGitBehindShim("/usr/bin", { ...mac, xcrunFind: () => null })).toBeNull();
    expect(realGitBehindShim("/usr/bin", { ...mac, xcrunFind: () => "/usr/bin/git" })).toBeNull();
    expect(realGitBehindShim("/usr/bin", { ...mac, exists: () => false })).toBeNull();
  });
});

describe("pathBeforeUsrBin", () => {
  test("goes just before /usr/bin, so Homebrew's tools still come first", () => {
    expect(pathBeforeUsrBin("/opt/homebrew/bin:/usr/bin:/bin", "/clt")).toBe("/opt/homebrew/bin:/clt:/usr/bin:/bin");
  });

  test("a second call doesn't add it twice, and a PATH without /usr/bin gets it last", () => {
    expect(pathBeforeUsrBin("/a:/clt:/usr/bin", "/clt")).toBe("/a:/clt:/usr/bin");
    expect(pathBeforeUsrBin("/a:/b", "/clt")).toBe("/a:/b:/clt");
  });
});

test("useRealGit changes PATH only when git is the shim", () => {
  const env: Record<string, string | undefined> = { PATH: "/opt/homebrew/bin:/usr/bin" };
  useRealGit(env, mac);
  expect(env.PATH).toBe("/opt/homebrew/bin:/Library/Developer/CommandLineTools/usr/bin:/usr/bin");
  const linux: Record<string, string | undefined> = { PATH: "/usr/bin" };
  useRealGit(linux, { ...mac, platform: "linux" });
  expect(linux.PATH).toBe("/usr/bin");
});

// The reason it isn't a link: git run from the real directory finds its own helpers, so script
// commands (submodule) work and `init` finds its templates.
test("on this machine, the git PATH now finds runs script commands and inits without warnings", async () => {
  const env: Record<string, string | undefined> = { ...process.env };
  useRealGit(env);
  const repo = tempDir("harness-git-path-");
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const init = run("init", "-q");
  expect(init.exitCode).toBe(0);
  expect(init.stderr.toString()).toBe("");
  expect(run("submodule", "status").exitCode).toBe(0);
});
