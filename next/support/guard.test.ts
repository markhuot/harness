import { describe, expect, test } from "bun:test";
import { GuardError, cpuOverCap, installGuard, type GuardTarget } from "./guard";

/** A stand-in for the Bun global, so the guard is exercised without touching the real one. */
function standIn() {
  const slept: unknown[] = [];
  const target = Object.fromEntries(["spawn", "spawnSync", "serve", "listen", "connect", "udpSocket", "sleepSync"].map((k) => [k, () => "real"])) as unknown as GuardTarget;
  (target as any).sleep = (ms: unknown) => (slept.push(ms), Promise.resolve());
  return { target, slept };
}

describe("the guard", () => {
  test("real git fails, and the message names the GitPort seam", () => {
    const { target } = standIn();
    installGuard(target);
    expect(() => target.spawn(["git", "worktree", "add"])).toThrow(/Real git.*GitPort/s);
  });

  test("Chrome fails and names the recorded-transcript browser; any other process names the seams", () => {
    const { target } = standIn();
    installGuard(target);
    expect(() => target.spawn({ cmd: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] })).toThrow(/Launching Chrome.*transcript/s);
    expect(() => target.spawn(["bash", "-c", "true"])).toThrow(/Spawning bash.*FakeDriver/s);
    expect(() => target.spawnSync(["ps"])).toThrow(GuardError);
  });

  test("a socket or server fails and says to call the handler", () => {
    const { target } = standIn();
    installGuard(target);
    for (const k of ["serve", "listen", "connect", "udpSocket"] as const) expect(() => target[k]()).toThrow(/createService/);
  });

  test("a short sleep passes through, a long one fails", () => {
    const { target, slept } = standIn();
    installGuard(target);
    target.sleep(1);
    expect(slept).toEqual([1]);
    expect(() => target.sleep(500)).toThrow(/Sleeping 500 ms.*tick\(ms\)/s);
    expect(() => target.sleepSync(500)).toThrow(GuardError);
  });

  test("the returned function puts the originals back", () => {
    const { target } = standIn();
    const restore = installGuard(target);
    restore();
    expect(target.spawn(["git"])).toBe("real");
  });

  test("the CPU cap fails a test over it and names the way out; one under it passes", () => {
    expect(cpuOverCap(40)).toBeNull();
    expect(cpuOverCap(2000)).toMatch(/over the 1500 ms cap.*next\/contract/s);
    expect(cpuOverCap(1500)).toBeNull();
  });
});
