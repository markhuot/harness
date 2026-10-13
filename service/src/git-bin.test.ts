import { describe, expect, test } from "bun:test";
import { gitBin, gitBinSync, resolveGitBin } from "./git-bin";

const SHIM = "/usr/bin/git";
const REAL = "/Library/Developer/CommandLineTools/usr/bin/git";

describe("resolveGitBin", () => {
  test("HARNESS_GIT_BIN wins without asking PATH or xcrun", async () => {
    const bin = await resolveGitBin({
      env: { HARNESS_GIT_BIN: "/opt/git", PATH: "/usr/bin" },
      platform: "darwin",
      which: () => {
        throw new Error("which called");
      },
      xcrunFind: async () => {
        throw new Error("xcrun called");
      },
    });
    expect(bin).toBe("/opt/git");
  });

  test("on macOS the /usr/bin/git shim is swapped for the binary xcrun names", async () => {
    expect(await resolveGitBin({ env: {}, platform: "darwin", which: () => SHIM, xcrunFind: async () => REAL, exists: () => true })).toBe(REAL);
  });

  test("keeps the shim when xcrun fails, names a missing file, or names the shim itself", async () => {
    const base = { env: {}, platform: "darwin" as const, which: () => SHIM };
    expect(await resolveGitBin({ ...base, xcrunFind: async () => null, exists: () => true })).toBe(SHIM);
    expect(await resolveGitBin({ ...base, xcrunFind: async () => REAL, exists: () => false })).toBe(SHIM);
    expect(await resolveGitBin({ ...base, xcrunFind: async () => SHIM, exists: () => true })).toBe(SHIM);
  });

  test("a non-shim git on PATH (Homebrew) is used as is, and xcrun isn't asked", async () => {
    const bin = await resolveGitBin({
      env: {},
      platform: "darwin",
      which: () => "/opt/homebrew/bin/git",
      xcrunFind: async () => {
        throw new Error("xcrun called");
      },
    });
    expect(bin).toBe("/opt/homebrew/bin/git");
  });

  test("off macOS /usr/bin/git is the real binary; no git on PATH falls back to the bare name", async () => {
    const xcrunFind = async () => {
      throw new Error("xcrun called");
    };
    expect(await resolveGitBin({ env: {}, platform: "linux", which: () => SHIM, xcrunFind })).toBe(SHIM);
    expect(await resolveGitBin({ env: {}, platform: "darwin", which: () => null, xcrunFind })).toBe("git");
  });

  test("searches the PATH from the env it's given", async () => {
    let seen: string | undefined;
    await resolveGitBin({ env: { PATH: "/a:/b" }, platform: "linux", which: (_, path) => ((seen = path), "/a/git") });
    expect(seen).toBe("/a:/b");
  });
});

test("gitBin resolves to a git that runs, and only once; gitBinSync reports it afterwards", async () => {
  expect(gitBin()).toBe(gitBin());
  const first = await gitBin();
  expect(gitBinSync()).toBe(first);
  const r = Bun.spawnSync([first, "--version"], { stdout: "pipe" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toStartWith("git version");
});
