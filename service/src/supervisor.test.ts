import { describe, expect, test } from "bun:test";
import { LAUNCHD_LABEL } from "./cli";
import { findSupervisor, restartThrough, type RestartDeps } from "./supervisor";

describe("findSupervisor", () => {
  test("the app, when HARNESS_SUPERVISOR_PID is the parent", () => {
    expect(findSupervisor({ HARNESS_SUPERVISOR_PID: "4242" }, 4242, 501)).toEqual({ kind: "app", pid: 4242 });
  });

  test("launchd, when the parent is pid 1 and XPC_SERVICE_NAME is the label", () => {
    expect(findSupervisor({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 1, 501)).toEqual({ kind: "launchd", target: `gui/501/${LAUNCHD_LABEL}` });
  });

  test("an agent inherits the variables but not the parent: unsupervised", () => {
    expect(findSupervisor({ HARNESS_SUPERVISOR_PID: "4242", XPC_SERVICE_NAME: LAUNCHD_LABEL }, 777, 501)).toBeNull();
    expect(findSupervisor({ XPC_SERVICE_NAME: "com.example.other" }, 1, 501)).toBeNull();
    expect(findSupervisor({}, 1, 501)).toBeNull();
  });
});

function recorder(code: number | null) {
  const ran: string[][] = [];
  const shutdowns: string[] = [];
  const logs: string[] = [];
  let settled!: () => void;
  const done = new Promise<void>((r) => (settled = r));
  const d: RestartDeps = {
    run: async (cmd) => {
      ran.push(cmd);
      queueMicrotask(settled);
      return code;
    },
    shutdown: (reason) => void shutdowns.push(reason),
    log: (m) => void logs.push(m),
  };
  return { d, ran, shutdowns, logs, done };
}

describe("restartThrough", () => {
  test("the app's child just exits; the app starts it again", () => {
    const r = recorder(0);
    restartThrough({ kind: "app", pid: 4242 }, r.d);
    expect(r.shutdowns).toEqual(["restart"]);
    expect(r.ran).toEqual([]);
  });

  test("under launchd it asks for a kickstart -k (a demand) instead of exiting for KeepAlive", async () => {
    const r = recorder(0);
    restartThrough({ kind: "launchd", target: `gui/501/${LAUNCHD_LABEL}` }, r.d);
    await r.done;
    await Bun.sleep(0);
    expect(r.ran).toEqual([["/bin/launchctl", "kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`]]);
    // launchd's SIGTERM runs the shutdown, not the restart itself.
    expect(r.shutdowns).toEqual([]);
  });

  test("a kickstart that fails, or launchctl that won't run, falls back to exiting for KeepAlive", async () => {
    for (const code of [113, null]) {
      const r = recorder(code);
      restartThrough({ kind: "launchd", target: `gui/501/${LAUNCHD_LABEL}` }, r.d);
      await r.done;
      await Bun.sleep(0);
      expect(r.shutdowns).toEqual(["restart"]);
      expect(r.logs.at(-1)).toContain("kickstart failed");
    }
  });
});
