// bunSpawn against a real process: the parts of the watcher spawn that only the OS can show. The
// runner's own handling (argv, batching, restarts, kill on stop) is next/orchestrator/watchers.test.ts
// on fake processes. This tier is allowed to spawn.

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tempDir } from "@harness/shared/testing";
import { bunSpawn } from "../../service/src/orchestrator/watchers";

const dir = realpathSync(tempDir("next-watcher-spawn-"));
// A sleep only this test runs, so pgrep can tell whether it outlived the stop
const marker = `sleep 3${String(process.pid).slice(-3)}7`;
const leftovers = () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();

afterEach(() => {
  delete process.env.HARNESS_SPAWN_PROBE;
  delete process.env.WHO;
  Bun.spawnSync(["pkill", "-f", marker]);
});

async function readUntil(stream: ReadableStream<Uint8Array>, done: (text: string) => boolean): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: end } = await reader.read();
    if (end) break;
    text += dec.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

test("bunSpawn runs in the watcher's cwd with its env over the service's, pipes stderr, and kill stops the whole process group", async () => {
  // The shell sits in a `sleep` child holding the pipes, like a `while true; do curl …; sleep 60; done`
  // watcher: killing only the shell used to leave the run (and the service stopping it) hanging.
  // The service's own env reaches the watcher; the watcher's wins where both set a variable.
  process.env.HARNESS_SPAWN_PROBE = "from-service";
  process.env.WHO = "service";
  const proc = bunSpawn("/bin/sh", ["-c", `echo "$WHO|$PWD|$HARNESS_SPAWN_PROBE"; echo "bad credentials" >&2; while true; do ${marker}; done`], {
    cwd: dir,
    env: { WHO: "mark" },
  });
  const out = await readUntil(proc.stdout, (t) => t.includes("\n"));
  expect(out.trim()).toBe(`mark|${dir}|from-service`);
  expect(await readUntil(proc.stderr!, (t) => t.includes("\n"))).toBe("bad credentials\n");
  await Bun.sleep(50); // the loop is in its sleep
  expect(leftovers()).not.toBe("");

  proc.kill();
  const code = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "hung")]);
  expect(code).not.toBe("hung");
  await Bun.sleep(100);
  expect(leftovers()).toBe("");
});
