import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../builders/tmp";
import { generate } from "./cases";
import { TYPE_EXEMPTIONS } from "./exemptions";

const root = join(import.meta.dir, "../..");

/** The Xcode CLAUDE.md pins for simulator work, when installed; the Swift package needs only a toolchain. */
function developerDir(): Record<string, string> {
  const pinned = "/Applications/Xcode-27.1.0.app/Contents/Developer";
  return process.env.DEVELOPER_DIR || !existsSync(pinned) ? {} : { DEVELOPER_DIR: pinned };
}

// A cold build of HarnessKit is slow; the warm run is seconds.
test("HarnessKit decodes and re-encodes every wire fixture generated from protocol.ts", async () => {
  const { types, literals, consts } = generate(join(root, "shared/src/protocol.ts"), TYPE_EXEMPTIONS);
  const fixtures = join(tempDir(), "fixtures.json");
  writeFileSync(fixtures, JSON.stringify({ types, literals, consts }));

  const proc = Bun.spawn(["swift", "test", "--package-path", join(root, "testing/swift"), "--filter", "ContractTests"], {
    env: { ...process.env, ...developerDir(), HARNESS_CONTRACT_FIXTURES: fixtures },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) console.error(`${out}\n${err}`);
  expect(code).toBe(0);
}, 900_000);
