import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "@harness/shared";
import { onTempCleanup } from "@harness/shared/testing";
import { bundledPath } from "./bundled-launchd";
import { BUNDLED_ENV, buildBundledPlist } from "./cli";
import { tempHome } from "./testing/fakes";

describe("daemon", () => {
  test("boots with real drivers, writes service.json, serves the API and exits cleanly on SIGTERM", async () => {
    const home = tempHome("harness-daemon-");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
      env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    onTempCleanup(async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      if ((await Promise.race([proc.exited, Bun.sleep(10_000)])) === undefined) proc.kill("SIGKILL");
      await proc.exited;
    });
    const serviceJson = join(home, "service.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(serviceJson) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(serviceJson)).toBe(true);
    const info = JSON.parse(readFileSync(serviceJson, "utf8"));
    expect(info.port).toBe(port);
    expect(info.pid).toBe(proc.pid);

    const client = new HarnessClient({ baseUrl: `http://127.0.0.1:${port}`, token: readFileSync(join(home, "token"), "utf8").trim() });
    expect((await client.health()).pid).toBe(proc.pid);
    // (listDrivers is skipped: claude-code's info() shells out to the real CLI)
    await expect(client.loginDriver("nope")).rejects.toMatchObject({ status: 404 });
    expect((await client.getSettings()).defaultDriver).toBe("claude-code");

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(existsSync(serviceJson)).toBe(false);
  }, 20_000);
});

describe("daemon run by the app (HARNESS_SUPERVISOR_PID)", () => {
  function freePort() {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    return port;
  }
  async function waitHealthy(port: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch {}
      await Bun.sleep(50);
    }
    throw new Error("daemon never became healthy");
  }
  function spawnDaemon(home: string, port: number, supervisor: string) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
      env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_SUPERVISOR_PID: supervisor },
      stdout: "ignore",
      stderr: "ignore",
    });
    onTempCleanup(async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    });
    return proc;
  }
  const restart = (home: string, port: number) =>
    fetch(`http://127.0.0.1:${port}/service/restart`, { method: "POST", headers: { authorization: `Bearer ${readFileSync(join(home, "token"), "utf8").trim()}` } });

  test("restarts itself on request when its parent is the supervisor", async () => {
    const home = tempHome("harness-daemon-");
    const port = freePort();
    const proc = spawnDaemon(home, port, String(process.pid));
    await waitHealthy(port);
    expect((await restart(home, port)).status).toBe(200);
    expect(await proc.exited).toBe(0);
  }, 20_000);

  test("a supervisor pid that isn't its parent doesn't count (agents inherit the variable)", async () => {
    const home = tempHome("harness-daemon-");
    const port = freePort();
    const proc = spawnDaemon(home, port, "1");
    await waitHealthy(port);
    expect((await restart(home, port)).status).toBe(409);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  }, 20_000);

  test("shuts down when the app that started it dies", async () => {
    const home = tempHome("harness-daemon-");
    const port = freePort();
    // A stand-in app: starts the daemon as its child, prints its pid, then waits to be killed.
    const app = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const p = Bun.spawn([process.execPath, ${JSON.stringify(join(import.meta.dir, "daemon.ts"))}], { env: { ...process.env, HARNESS_SUPERVISOR_PID: String(process.pid) }, stdout: "ignore", stderr: "ignore" });
         console.log(p.pid); setInterval(() => {}, 1000);`,
      ],
      { env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port) }, stdout: "pipe", stderr: "ignore" },
    );
    const reader = (app.stdout as ReadableStream<Uint8Array>).getReader();
    const daemonPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    onTempCleanup(() => {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {}
    });
    await waitHealthy(port);
    app.kill("SIGKILL"); // no chance to stop its child
    await app.exited;
    const isAlive = () => {
      try {
        process.kill(daemonPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 15_000;
    while (isAlive() && Date.now() < deadline) await Bun.sleep(100);
    expect(isAlive()).toBe(false);
  }, 25_000);
});

describe("daemon under Harness.app's bundled plist (SMAppService)", () => {
  test("logs to the service log itself, since the plist has no StandardOutPath for this user", async () => {
    const home = tempHome("harness-daemon-");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const plist = join(home, "bundled.plist");
    writeFileSync(plist, buildBundledPlist({ appBundleId: "com.markhuot.harness.app", executable: "harness-service" }));
    // launchd gives the job only what the plist names, plus a bare PATH.
    const plistEnv = Bun.which("plutil")
      ? JSON.parse(new TextDecoder().decode(Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plist]).stdout)).EnvironmentVariables
      : { [BUNDLED_ENV]: "bundle" };
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
      env: { ...plistEnv, HOME: process.env.HOME, PATH: "/usr/bin:/bin", HARNESS_HOME: home, HARNESS_PORT: String(port) },
      cwd: "/",
      stdout: "pipe",
      stderr: "pipe",
    });
    onTempCleanup(async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    });
    const logPath = join(home, "logs", "service.log");
    const listening = () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("harness listening");
    const deadline = Date.now() + 10_000;
    while (!listening() && Date.now() < deadline) await Bun.sleep(25);
    expect(listening()).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).not.toContain("harness listening");
    expect(readFileSync(logPath, "utf8")).toContain("shutting down (SIGTERM)");
  }, 20_000);
});

describe("bundledPath", () => {
  test("puts the user's tool directories ahead of launchd's bare PATH, once each", () => {
    const path = bundledPath("/usr/bin:/bin:/custom/bin", "/Users/me").split(":");
    expect(path.slice(0, 3)).toEqual(["/Users/me/.local/bin", "/Users/me/.bun/bin", "/opt/homebrew/bin"]);
    expect(path).toContain("/custom/bin");
    expect(path.filter((p) => p === "/usr/bin")).toHaveLength(1);
    expect(bundledPath(undefined, "/Users/me")).not.toContain("::");
  });
});
