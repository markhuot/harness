import { expect, test } from "bun:test";
import { descendantPids, signalAll } from "../../service/src/process-tree";

test("descendantPids finds a child and grandchild of a real process tree, but not the root or siblings", async () => {
  // sh starts a sleeping grandchild and waits; the child is sh itself.
  const root = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  try {
    // Wait on the tree itself, not a timer: poll the ps walk until the grandchild exists.
    let found: number[] = [];
    for (let i = 0; i < 200 && found.length < 1; i++) {
      found = descendantPids(root.pid);
      if (found.length < 1) await new Promise((r) => setImmediate(r));
    }
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found).not.toContain(root.pid);
    expect(found).not.toContain(other.pid);
    signalAll(found, "SIGKILL");
  } finally {
    root.kill("SIGKILL");
    other.kill("SIGKILL");
    await Promise.all([root.exited, other.exited]);
  }
});

test("a pid with no children yields nothing, and signalling a gone pid doesn't throw", async () => {
  const p = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  expect(descendantPids(p.pid)).toEqual([]);
  p.kill("SIGKILL");
  await p.exited;
  expect(() => signalAll([p.pid], "SIGTERM")).not.toThrow();
});
