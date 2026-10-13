import { expect, test } from "bun:test";
import { join } from "node:path";

// A failure before the daemon starts (here a bad --only) has no home dir or daemon yet: the error
// path must report the real error, not crash on the missing daemon.err or a null daemon.
test("sim-check reports a failure that happens before the daemon starts", async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "sim-check.ts"), "--only=no-such-screen"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  expect(code).toBe(1);
  expect(err).toContain("--only: unknown no-such-screen");
  expect(out + err).not.toMatch(/ENOENT|TypeError/);
});
