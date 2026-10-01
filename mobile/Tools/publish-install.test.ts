import { expect, test } from "bun:test";
import { join } from "node:path";

// Only the option handling: everything past it builds, signs or publishes. --no-publish with both
// apps skipped runs no build and no tag checks, so it shows which options the script accepts.
const script = join(import.meta.dir, "publish-install.sh");
const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bash", script, ...args], { env: { ...process.env, NOTARY_PROFILE: "" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test("--ios-app accepts rn and native", () => {
  for (const app of ["rn", "native"]) {
    const r = run(`--ios-app=${app}`, "--no-publish", "--skip-ios", "--skip-mac");
    expect(r.err).not.toContain("error:");
    expect(r.code).toBe(0);
    expect(r.out).toContain("(not published)");
  }
});

test("--ios-app rejects anything else before building", () => {
  for (const bad of ["--ios-app=expo", "--ios-app=", "--ios-app"]) {
    const r = run(bad, "--no-publish", "--skip-ios", "--skip-mac");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--ios-app must be rn or native");
    expect(r.out).not.toContain("not published");
  }
});

test("unknown options still fail", () => {
  const r = run("--skip-android");
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown option --skip-android");
});
