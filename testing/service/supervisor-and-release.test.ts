import { expect, test } from "bun:test";
import { PULL_REQUEST_URL } from "../../service/src/pull-requests";
import { checkoutRelease, describeRelease, RELEASE_TTL_MS } from "../../service/src/release";
import { findSupervisor, restartThrough, type RestartDeps } from "../../service/src/supervisor";
import { LAUNCHD_LABEL } from "../../service/src/cli";
import { fakeClock } from "../builders/clock";
import { git, gitRepo } from "./git";

test("the app is the supervisor only when it is the daemon's own parent", () => {
  expect(findSupervisor({ HARNESS_SUPERVISOR_PID: "42" }, 42, 501)).toEqual({ kind: "app", pid: 42 });
  // An agent inherits the variable but its parent is some other process.
  expect(findSupervisor({ HARNESS_SUPERVISOR_PID: "42" }, 99, 501)).toBeNull();
  expect(findSupervisor({ HARNESS_SUPERVISOR_PID: "junk" }, 0, 501)).toBeNull();
});

test("launchd is the supervisor only for pid 1 with its label in XPC_SERVICE_NAME", () => {
  expect(findSupervisor({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 1, 501)).toEqual({ kind: "launchd", target: `gui/501/${LAUNCHD_LABEL}` });
  expect(findSupervisor({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 77, 501)).toBeNull();
  expect(findSupervisor({ XPC_SERVICE_NAME: "other" }, 1, 501)).toBeNull();
  expect(findSupervisor({}, 1, 501)).toBeNull();
});

function deps(exit: number | null) {
  const calls: string[] = [];
  const d: RestartDeps = {
    run: async (cmd) => (calls.push(cmd.join(" ")), exit),
    shutdown: (reason) => calls.push(`shutdown:${reason}`),
    log: (m) => calls.push(`log:${m.split(" ")[0]}`),
  };
  return { d, calls };
}

test("under the app a restart is just the normal shutdown", () => {
  const { d, calls } = deps(0);
  restartThrough({ kind: "app", pid: 1 }, d);
  expect(calls).toEqual(["shutdown:restart"]);
});

test("under launchd a restart asks launchctl to kickstart, and only exits itself when launchctl fails", async () => {
  const ok = deps(0);
  restartThrough({ kind: "launchd", target: "gui/501/x" }, ok.d);
  await Promise.resolve();
  await Promise.resolve();
  expect(ok.calls).toEqual(["log:restarting", "/bin/launchctl kickstart -k gui/501/x"]);
  const failed = deps(1);
  restartThrough({ kind: "launchd", target: "gui/501/x" }, failed.d);
  await Promise.resolve();
  await Promise.resolve();
  expect(failed.calls.at(-1)).toBe("shutdown:restart");
  const didntRun = deps(null);
  restartThrough({ kind: "launchd", target: "gui/501/x" }, didntRun.d);
  await Promise.resolve();
  await Promise.resolve();
  expect(didntRun.calls.at(-1)).toBe("shutdown:restart");
});

test("a checkout's release is asked of git once a minute of the clock it's given, and a change shows after that", () => {
  const clock = fakeClock(0);
  let tag: string | null = "app-1";
  let asked = 0;
  const release = checkoutRelease(() => (asked++, tag), clock);
  expect(release()).toBe("app-1");
  tag = "app-2";
  clock.advance(RELEASE_TTL_MS - 1);
  expect(release()).toBe("app-1");
  clock.advance(1);
  expect(release()).toBe("app-2");
  expect(asked).toBe(2);
});

test("describeRelease finds the newest annotated app-* tag at or before HEAD, ignoring lightweight and other tags", () => {
  const repo = gitRepo();
  expect(describeRelease(repo)).toBeNull();
  git(repo, "tag", "app-20260101.0000"); // lightweight: skipped
  git(repo, "tag", "-a", "v9", "-m", "other");
  expect(describeRelease(repo)).toBeNull();
  git(repo, "tag", "-a", "app-20260102.0000", "-m", "r1");
  git(repo, "commit", "-q", "--allow-empty", "-m", "ahead of the tag");
  expect(describeRelease(repo)).toBe("app-20260102.0000");
  git(repo, "tag", "-a", "app-20260103.0000", "-m", "r2");
  expect(describeRelease(repo)).toBe("app-20260103.0000");
  expect(describeRelease("/does/not/exist")).toBeNull();
});

test("a pull request link must be one http(s) URL with no whitespace", () => {
  for (const ok of ["https://github.com/o/r/pull/1", "http://ghe.local/o/r/pull/2"]) expect(PULL_REQUEST_URL.test(ok)).toBe(true);
  for (const bad of ["github.com/o/r/pull/1", "ftp://x/y", "https://x/y z", "", "https://x/y\nhttps://x/z"]) expect(PULL_REQUEST_URL.test(bad)).toBe(false);
});
