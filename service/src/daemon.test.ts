import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "@harness/shared";
import { tempHome } from "./testing/fakes";

describe("daemon", () => {
  test("boots with real drivers, writes service.json, serves the API and exits cleanly on SIGTERM", async () => {
    const home = tempHome("harness-daemon-");
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
      env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
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
