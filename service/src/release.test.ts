import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "@harness/shared";
import { createHarness, type Harness } from "./app";
import { checkoutRelease, describeRelease, RELEASE_TTL_MS } from "./release";
import { stubBrowser, tempHome } from "./testing/fakes";

function repo() {
  const dir = tempHome("harness-release-");
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q");
  let n = 0;
  const commit = () => {
    writeFileSync(join(dir, "f"), String(++n));
    git("add", "f");
    git("commit", "-qm", `c${n}`);
  };
  return { dir, git, commit };
}

describe("describeRelease", () => {
  test("the newest annotated app-* tag at or before HEAD; lightweight and other tags don't count", () => {
    const r = repo();
    r.commit();
    expect(describeRelease(r.dir)).toBeNull();
    r.git("tag", "-a", "app-20261001.1200", "-m", "Release");
    expect(describeRelease(r.dir)).toBe("app-20261001.1200");
    // A checkout ahead of its last release still belongs to it.
    r.commit();
    expect(describeRelease(r.dir)).toBe("app-20261001.1200");
    r.git("tag", "app-20261002.1200");
    r.git("tag", "-a", "v9", "-m", "not a release");
    expect(describeRelease(r.dir)).toBe("app-20261001.1200");
    r.git("tag", "-a", "app-20261003.1200", "-m", "Release");
    expect(describeRelease(r.dir)).toBe("app-20261003.1200");
  });

  test("no repository: null", () => {
    expect(describeRelease(tempHome("harness-norepo-"))).toBeNull();
  });
});

describe("checkoutRelease", () => {
  test("asks git again once the TTL has passed, so a tag added later is noticed", () => {
    let now = 0;
    let tag: string | null = null;
    let asked = 0;
    const release = checkoutRelease(() => (asked++, tag), () => now);
    expect(release()).toBeNull();
    tag = "app-20261003.1524";
    now = RELEASE_TTL_MS - 1;
    expect(release()).toBeNull();
    expect(asked).toBe(1);
    now = RELEASE_TTL_MS;
    expect(release()).toBe("app-20261003.1524");
    expect(asked).toBe(2);
  });
});

describe("/health release", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  test("reports the release it's given, and null without one", async () => {
    harness = await createHarness({ home: tempHome(), port: 0, browser: stubBrowser(), watchers: null, log: () => {}, release: () => "app-20261003.1524" });
    expect(await new HarnessClient({ baseUrl: harness.url, token: harness.token }).health()).toMatchObject({ release: "app-20261003.1524" });
    await harness.stop();
    harness = await createHarness({ home: tempHome(), port: 0, browser: stubBrowser(), watchers: null, log: () => {} });
    expect(await new HarnessClient({ baseUrl: harness.url, token: harness.token }).health()).toMatchObject({ release: null });
  });
});
