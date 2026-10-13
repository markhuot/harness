import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../shared/src/testing/tmp";
import { DEFAULT_LAYER_TIMEOUT_MS, layerTimeoutMs, runCommand } from "./run-layer";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A fake layer: starts a grandchild that records its pid, then waits. */
function fakeLayer(dir: string): string[] {
  const grandchild = `require("fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid)); setInterval(() => {}, 1000)`;
  return ["bun", "-e", `Bun.spawn(["bun", "-e", ${JSON.stringify(grandchild)}]); console.log("layer up"); setInterval(() => {}, 1000)`];
}

async function waitFor(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await Bun.sleep(50);
  expect(fn()).toBe(true);
}

test("layerTimeoutMs reads HARNESS_LAYER_TIMEOUT_MS and ignores nonsense", () => {
  expect(layerTimeoutMs({ HARNESS_LAYER_TIMEOUT_MS: "1500" })).toBe(1500);
  expect(layerTimeoutMs({ HARNESS_LAYER_TIMEOUT_MS: "soon" })).toBe(DEFAULT_LAYER_TIMEOUT_MS);
  expect(layerTimeoutMs({ HARNESS_LAYER_TIMEOUT_MS: "-1" })).toBe(DEFAULT_LAYER_TIMEOUT_MS);
  expect(layerTimeoutMs({})).toBe(DEFAULT_LAYER_TIMEOUT_MS);
});

test("a layer over its time limit is killed with its children and reported as timed out", async () => {
  const dir = tempDir();
  const r = await runCommand(fakeLayer(dir), { cwd: dir, timeoutMs: 1500 });
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
  expect(r.output).toContain("layer up");
  expect(r.output).toMatch(/timed out after 2s and was killed/);
  await waitFor(() => existsSync(join(dir, "pid")));
  await waitFor(() => !alive(Number(readFileSync(join(dir, "pid"), "utf8"))));
});

test("a layer that finishes keeps its exit code and output", async () => {
  const r = await runCommand(["bun", "-e", 'console.log("out"); console.error("err"); process.exit(3)'], { cwd: process.cwd(), timeoutMs: 10000 });
  expect(r).toMatchObject({ code: 3, timedOut: false });
  expect(r.output).toContain("out");
  expect(r.output).toContain("err");
});

test("a command that can't start reports exit 127", async () => {
  const r = await runCommand(["definitely-not-a-command-xyz"], { cwd: process.cwd() });
  expect(r.code).toBe(127);
});

test("SIGTERM to the runner reaches the layer's children, and the runner exits 143", async () => {
  const dir = tempDir();
  const driver = `import { runCommand } from ${JSON.stringify(join(import.meta.dir, "run-layer.ts"))};
await runCommand(${JSON.stringify(fakeLayer(dir))}, { cwd: ${JSON.stringify(dir)}, onOutput: (t) => process.stdout.write(t) });`;
  const proc = Bun.spawn(["bun", "-e", driver], { stdout: "pipe", stderr: "inherit" });
  await proc.stdout.getReader().read(); // "layer up"
  await waitFor(() => existsSync(join(dir, "pid")));
  const grandchild = Number(readFileSync(join(dir, "pid"), "utf8"));
  expect(alive(grandchild)).toBe(true);
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(143);
  await waitFor(() => !alive(grandchild));
});

test("a grandchild holding the output pipes doesn't keep a finished layer waiting for the time limit", async () => {
  const dir = tempDir();
  const started = Date.now();
  // The layer exits at once, leaving a child that inherited stdout/stderr and sleeps on.
  const r = await runCommand(["bun", "-e", 'Bun.spawn(["sleep", "60"], { stdout: "inherit", stderr: "inherit" }).unref(); console.log("done")'], { cwd: dir, timeoutMs: 30000 });
  expect(r).toMatchObject({ code: 0, timedOut: false });
  expect(r.output).toContain("done");
  expect(Date.now() - started).toBeLessThan(10000);
});
