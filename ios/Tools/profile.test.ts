import { describe, expect, test } from "bun:test";
import { callerSite, diffProfiles, Profile, programOf, spawnsByProgram, summarize } from "./profile";

/** A clock the test moves by hand. */
function clock() {
  let t = 0;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

describe("spans", () => {
  test("a phase's exclusive time leaves out the chains and phases inside it", async () => {
    const c = clock();
    const p = new Profile([], c.now);
    await p.span("phase", "interactions", async () => {
      c.tick(100);
      await p.span("chain", "board", async () => {
        c.tick(400);
        await p.span("phase", "inner", async () => c.tick(50));
      });
      c.tick(10);
    });
    const d = p.data();
    expect(d.phases.interactions).toMatchObject({ ms: 560, exclusiveMs: 110, count: 1 });
    expect(d.phases.inner).toMatchObject({ ms: 50, exclusiveMs: 50 });
    expect(d.chains.board!.ms).toBe(450);
    // Exclusive times add up to the run's wall time, not past it.
    expect(d.phases.interactions!.exclusiveMs + d.phases.inner!.exclusiveMs + 400).toBe(560);
  });

  test("parallel children can't push exclusive time below zero", async () => {
    const c = clock();
    const p = new Profile([], c.now);
    await p.span("phase", "all", () => Promise.all([p.span("phase", "a", async () => c.tick(100)), p.span("phase", "b", async () => c.tick(100))]));
    expect(p.data().phases.all!.exclusiveMs).toBe(0);
  });

  test("a phase that repeats adds up", async () => {
    const c = clock();
    const p = new Profile([], c.now);
    for (const n of [30, 70]) await p.span("phase", "install", async () => c.tick(n));
    expect(p.data().phases.install).toMatchObject({ count: 2, ms: 100 });
  });
});

describe("attribution", () => {
  test("a spawn counts for its check, its chain and the run, and a spawn outside any goes only to the run", async () => {
    const p = new Profile();
    p.spawn(["xcrun", "simctl", "boot", "X"], 10);
    await p.span("chain", "board", async () => {
      await p.span("check", "opens a ticket", async () => {
        p.spawn(["axe", "tap", "--label", "x"], 200);
        p.spawn(["axe", "describe-ui"], 300);
      });
      p.spawn(["ffmpeg", "-i", "a"], 40);
    });
    const d = p.data();
    expect(Object.keys(d.checks["opens a ticket"]!.spawns).sort()).toEqual(["axe:describe-ui", "axe:tap"]);
    expect(Object.keys(d.chains.board!.spawns).sort()).toEqual(["axe:describe-ui", "axe:tap", "ffmpeg"]);
    expect(d.checks["opens a ticket"]!.spawns["ffmpeg"]).toBeUndefined();
    expect(Object.keys(d.total.spawns)).toContain("simctl:boot");
    expect(d.chains.board!.spawns["simctl:boot"]).toBeUndefined();
  });

  test("sleeps and polls inside a check land on it and on the sleeping line", async () => {
    const p = new Profile();
    await p.span("check", "c", async () => {
      p.sleep(300, "sim-check.ts:10");
      p.sleep(300, "sim-check.ts:10");
      p.sleep(500, "sim-check.ts:99");
      p.poll("board shows", 12, 1800);
    });
    p.sleep(100, "sim-check.ts:5");
    const d = p.data();
    expect(d.checks.c).toMatchObject({ sleep: { count: 3, ms: 1100 }, pollWaits: 1, pollIterations: 12 });
    expect(d.total.sleep).toEqual({ count: 4, ms: 1200 });
    expect(d.sleepSites["sim-check.ts:10"]).toEqual({ count: 2, ms: 600 });
    expect(d.polls["board shows"]).toEqual({ waits: 1, iterations: 12, ms: 1800 });
  });

  test("parallel checks in one process keep their spawns apart", async () => {
    const p = new Profile();
    await Promise.all(["a", "b"].map((n) => p.span("check", n, async () => {
      await Bun.sleep(n === "a" ? 5 : 1);
      p.spawn(["axe", "tap"], 1);
    })));
    const d = p.data();
    expect(d.checks.a!.spawns["axe:tap"]!.count).toBe(1);
    expect(d.checks.b!.spawns["axe:tap"]!.count).toBe(1);
  });
});

describe("programOf", () => {
  test("names the tool behind xcrun and keeps the verb of simctl and axe", () => {
    expect(programOf(["xcrun", "simctl", "openurl", "U", "harness://x"])).toBe("simctl:openurl");
    expect(programOf(["xcrun", "xcodebuild", "-scheme", "Harness"])).toBe("xcodebuild");
    expect(programOf(["/opt/homebrew/bin/axe", "describe-ui", "--udid", "U"])).toBe("axe:describe-ui");
    expect(programOf(["bun", "ios/Tools/build.ts", "sim"])).toBe("bun");
    expect(programOf(["kill", "-STOP", "1"])).toBe("kill");
  });

  test("folds verbs back into one program", () => {
    expect(spawnsByProgram({ "axe:tap": { count: 2, ms: 10 }, "axe:describe-ui": { count: 3, ms: 30 }, ffmpeg: { count: 1, ms: 5 } })).toEqual({ axe: { count: 5, ms: 40 }, ffmpeg: { count: 1, ms: 5 } });
  });
});

describe("callerSite", () => {
  test("skips this module's frames and names the calling line", () => {
    const stack = ["Error", "    at sleep (/x/ios/Tools/profile.ts:1:1)", "    at checkThing (/x/ios/Tools/sim-check.ts:1384:11)", "    at async run (/x/ios/Tools/sim-check.ts:5:1)"].join("\n");
    expect(callerSite(stack)).toBe("sim-check.ts:1384");
    expect(callerSite("Error")).toBe("?");
  });
});

describe("summary and diff", () => {
  const run = (tapMs: number, sleepMs: number, ticks: number) => {
    const c = clock();
    const p = new Profile(["--sheets"], c.now);
    return p.span("chain", "sheets", async () => {
      await p.span("check", "dock", async () => {
        c.tick(ticks);
        for (let i = 0; i < 3; i++) p.spawn(["axe", "tap"], tapMs);
        p.sleep(sleepMs, "sim-check.ts:7");
      });
    }).then(() => p.data());
  };

  test("the summary ranks by cost and names the sleeping line", async () => {
    const lines = summarize(await run(100, 2000, 3000)).join("\n");
    expect(lines).toContain("3 spawns, 1 sleeps = 2.0 s");
    expect(lines).toContain("sim-check.ts:7");
    expect(lines).toMatch(/3 {2}axe/);
  });

  test("the diff reports what moved, as time and as counts, and ignores noise", async () => {
    const before = await run(100, 2000, 3000);
    const after = await run(100, 0, 1000);
    const text = diffProfiles(before, after).join("\n");
    expect(text).toContain("total -2.0s");
    expect(text).toContain("sleep -2.0s");
    expect(text).toMatch(/-2\.0s\s+dock/);
    expect(text).not.toContain("spawns:"); // same spawn counts
    expect(diffProfiles(before, before).join("\n")).not.toContain("chains:");
  });
});
