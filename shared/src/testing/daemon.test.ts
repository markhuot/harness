import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonAnswers, startDaemon, until, freePort, stopProcess } from "./daemon";
import { tempDir } from "./tmp";

const fixture = (name: string) => join(import.meta.dir, "__fixtures__", name);

describe("until", () => {
  test("retries a throwing check and reports the last error on timeout", async () => {
    let n = 0;
    await expect(until("never", async () => { n++; throw new Error("nope"); }, 150, 20)).rejects.toThrow(/timed out waiting for: never \(nope\)/);
    expect(n).toBeGreaterThan(1);
  });
  test("returns the first truthy value", async () => {
    let n = 0;
    expect(await until("third try", async () => (++n >= 3 ? "ok" : null), 2000, 5)).toBe("ok");
  });
});

describe("startDaemon", () => {
  test("a daemon that never answers fails with the readiness timeout", async () => {
    const err = await startDaemon({ entry: fixture("silent-daemon.ts"), readyMs: 400 }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out waiting for: daemon \/health/);
  });

  test("failed start leaves no home directory and no running process", async () => {
    const dirsBefore = new Set((await Array.fromAsync(new Bun.Glob("harness-daemon-*").scan({ cwd: tmpdir(), onlyFiles: false }))));
    await startDaemon({ entry: fixture("silent-daemon.ts"), readyMs: 300 }).catch(() => {});
    const dirsAfter = await Array.fromAsync(new Bun.Glob("harness-daemon-*").scan({ cwd: tmpdir(), onlyFiles: false }));
    expect(dirsAfter.filter((d) => !dirsBefore.has(d))).toEqual([]);
  });

  test("a daemon that exits early fails at once with its stderr", async () => {
    const t0 = Date.now();
    const err = (await startDaemon({ entry: fixture("crashing-daemon.ts"), readyMs: 10000 }).catch((e) => e)) as Error;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err.message).toMatch(/exited with code 3 before it was ready/);
    expect(err.message).toContain("boom: cannot bind");
  });

  test("a ready daemon hands back its base, token and an API that sends the token", async () => {
    const d = await startDaemon({ entry: fixture("health-daemon.ts") });
    try {
      expect(d.token).toBe("tok-123");
      expect(d.base).toBe(`http://127.0.0.1:${d.port}`);
      expect(await d.api<{ echo: string }>("GET", "/anything")).toEqual({ echo: "Bearer tok-123" });
    } finally {
      await d.stop();
    }
    expect(existsSync(d.home)).toBe(false);
    expect(await fetch(`${d.base}/health`).then(() => true, () => false)).toBe(false);
  });

  test("a home the caller gave is kept, and stop is safe to call twice", async () => {
    const home = tempDir("harness-daemon-given-");
    const d = await startDaemon({ entry: fixture("health-daemon.ts"), home });
    await d.stop();
    await d.stop();
    expect(existsSync(home)).toBe(true);
  });

  test("the real daemon boots with the dummy driver and a token", async () => {
    const d = await startDaemon();
    try {
      const drivers = await d.api<{ id: string }[]>("GET", "/drivers");
      expect(drivers.some((x) => x.id === "dummy")).toBe(true);
    } finally {
      await d.stop();
    }
  });
});

describe("stopProcess and freePort", () => {
  test("a process that ignores SIGTERM is killed after the grace period", async () => {
    const proc = Bun.spawn(["bun", "-e", 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)'], { stdout: "pipe" });
    await proc.stdout.getReader().read(); // handler installed
    expect(await stopProcess(proc, 300)).toBe(false);
    expect(proc.killed).toBe(true);
  });
  test("freePort stays inside the pool and skips a taken port", () => {
    const taken = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const p = freePort({ from: taken.port, span: 2 });
      expect(p).toBe(taken.port + 1);
    } finally {
      taken.stop(true);
    }
  });
});

describe("startDaemon's environment", () => {
  test("the app's launchd and supervisor variables don't reach the daemon, so PATH and the log stay the test's own", async () => {
    const before = { launchd: process.env.HARNESS_LAUNCHD, supervisor: process.env.HARNESS_SUPERVISOR_PID };
    process.env.HARNESS_LAUNCHD = "bundle";
    process.env.HARNESS_SUPERVISOR_PID = "1";
    const d = await startDaemon({ entry: fixture("env-daemon.ts"), env: { WORLD_MARK: "yes" } });
    try {
      const env = await d.api<Record<string, string | null>>("GET", "/env");
      expect(env).toEqual({ launchd: null, supervisor: null, mark: "yes", home: d.home });
    } finally {
      await d.stop();
      for (const [k, v] of [["HARNESS_LAUNCHD", before.launchd], ["HARNESS_SUPERVISOR_PID", before.supervisor]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("daemonAnswers", () => {
  test("is true for a live daemon with a token, false without the token or once it stops", async () => {
    const d = await startDaemon();
    try {
      const state = { daemonPid: d.proc.pid, port: Number(new URL(d.base).port) };
      expect(await daemonAnswers(state, d.home)).toBe(true);
      expect(await daemonAnswers(state, tempDir("harness-no-token-"))).toBe(false);
      await d.stop();
      expect(await daemonAnswers(state, d.home)).toBe(false);
    } finally {
      await d.stop();
    }
  });
});
