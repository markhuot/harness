import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { ChildService, spawnChild, type ChildProcessHandle } from "./child";

/** A fake process per spawn; `exit(code)` ends it, and SIGTERM ends it unless `ignoreTerm`. */
function fakes(opts: { ignoreTerm?: boolean } = {}) {
  const procs: { signals: string[]; exit: (code: number | null) => void }[] = [];
  const spawn = (): ChildProcessHandle => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const rec = { signals: [] as string[], exit };
    procs.push(rec);
    return {
      pid: procs.length,
      exited,
      kill: (s) => {
        rec.signals.push(s);
        if (s === "SIGKILL" || !opts.ignoreTerm) exit(null);
      },
    };
  };
  return { procs, spawn };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("ChildService", () => {
  test("starts the service again when it exits (a restart onto new code, a crash)", async () => {
    const f = fakes();
    const c = new ChildService({ spawn: f.spawn, respawnDelayMs: 0, minUptimeMs: 0 });
    c.start(["svc"], {}, "/log");
    f.procs[0]!.exit(0);
    await tick();
    expect(f.procs).toHaveLength(2);
    expect(c.running).toBe(true);
    expect(c.pid).toBe(2);
  });

  test("gives up after crashing on start too often, and a new start() resets that", async () => {
    const f = fakes();
    const c = new ChildService({ spawn: f.spawn, respawnDelayMs: 0, minUptimeMs: 60_000, maxQuickExits: 2 });
    c.start(["svc"], {}, "/log");
    f.procs[0]!.exit(1);
    await tick();
    f.procs[1]!.exit(1);
    await tick();
    expect(f.procs).toHaveLength(2);
    expect(c.running).toBe(false);
    expect(c.lastError).toContain("exited 2 times");
    c.start(["svc"], {}, "/log");
    expect(f.procs).toHaveLength(3);
    expect(c.lastError).toBeNull();
  });

  test("stop() isn't followed by a restart, and SIGKILLs a service that ignores SIGTERM", async () => {
    const f = fakes({ ignoreTerm: true });
    const c = new ChildService({ spawn: f.spawn, respawnDelayMs: 0, stopTimeoutMs: 20 });
    c.start(["svc"], {}, "/log");
    await c.stop();
    expect(f.procs[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await tick();
    expect(f.procs).toHaveLength(1);
    expect(c.running).toBe(false);
  });

  test("spawnChild appends the service's output to its log", async () => {
    const dir = tempDir("harness-child-");
    const log = join(dir, "logs", "service.log");
    await spawnChild(["/bin/sh", "-c", "echo first"], {}, log).exited;
    expect(await spawnChild(["/bin/sh", "-c", "echo second >&2; exit 3"], {}, log).exited).toBe(3);
    expect(readFileSync(log, "utf8")).toBe("first\nsecond\n");
  });
});
