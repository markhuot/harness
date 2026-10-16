import { expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutoModeRulesProvider, BUILTIN_RULES, parseAutoModeConfig } from "../../../service/src/permissions/rules";
import { fakeClock } from "../../builders/clock";
import { tempDir } from "../../builders/tmp";

const config = (over: object = {}) => JSON.stringify({ environment: ["e"], allow: ["a"], soft_deny: ["s"], hard_deny: ["h"], ...over });

test("parseAutoModeConfig reads the JSON after any warnings, and refuses anything that isn't a rule set", () => {
  const out = parseAutoModeConfig(`warning: extra certs\n${config()}`, 42);
  expect(out).toEqual({ environment: ["e"], allow: ["a"], soft_deny: ["s"], hard_deny: ["h"], source: "claude-cli", fetchedAt: 42 });
  expect(parseAutoModeConfig("no json at all", 1)).toBeNull();
  expect(parseAutoModeConfig("{not json", 1)).toBeNull();
  expect(parseAutoModeConfig(config({ allow: "a" }), 1)).toBeNull();
  expect(parseAutoModeConfig(config({ hard_deny: [1] }), 1)).toBeNull();
  expect(parseAutoModeConfig('{"allow": []}', 1)).toBeNull();
});

function rig(opts: { run?: (bin: string) => Promise<string>; bin?: string | null; maxAgeMs?: number } = {}) {
  const dir = tempDir();
  const clock = fakeClock(10_000_000);
  const runs: string[] = [];
  const cachePath = join(dir, "rules.json");
  const settingsPath = join(dir, "settings.json");
  const provider = new AutoModeRulesProvider({
    bin: () => (opts.bin === undefined ? "/bin/claude" : opts.bin),
    env: () => ({}),
    cachePath,
    settingsPath,
    maxAgeMs: opts.maxAgeMs,
    now: clock,
    run: async (bin) => {
      runs.push(bin);
      return (opts.run ?? (async () => config()))(bin);
    },
  });
  return { provider, clock, runs, cachePath, settingsPath };
}

test("rules are read from the CLI once, cached in memory and on disk, and used again while fresh", async () => {
  const r = rig();
  const first = await r.provider.get();
  expect(first).toMatchObject({ source: "claude-cli", fetchedAt: 10_000_000, allow: ["a"] });
  expect(JSON.parse(readFileSync(r.cachePath, "utf8")).fetchedAt).toBe(10_000_000);
  await r.provider.get();
  expect(r.runs).toEqual(["/bin/claude"]);
});

test("a fresh on-disk cache from an earlier process is used without running the CLI", async () => {
  const r = rig();
  writeFileSync(r.cachePath, JSON.stringify({ environment: [], allow: ["from disk"], soft_deny: [], hard_deny: [], fetchedAt: r.clock() - 1000 }));
  expect((await r.provider.get()).allow).toEqual(["from disk"]);
  expect(r.runs).toEqual([]);
});

test("rules older than a day are read again", async () => {
  const r = rig();
  await r.provider.get();
  r.clock.advance(24 * 3600_000 - 1);
  await r.provider.get();
  expect(r.runs).toHaveLength(1);
  r.clock.advance(1);
  await r.provider.get();
  expect(r.runs).toHaveLength(2);
});

test("a change to the user's settings file after the rules were read makes them stale", async () => {
  const r = rig();
  await r.provider.get();
  writeFileSync(r.settingsPath, "{}");
  const later = new Date(r.clock() + 5000);
  utimesSync(r.settingsPath, later, later);
  r.clock.advance(10_000);
  await r.provider.get();
  expect(r.runs).toHaveLength(2);
});

test("without the CLI the built-in rules are used", async () => {
  const r = rig({ bin: null });
  expect(await r.provider.get()).toBe(BUILTIN_RULES);
  expect(r.runs).toEqual([]);
});

test("a failing CLI falls back to built-in rules, doesn't respawn for five minutes, and then retries", async () => {
  let fail = true;
  const r = rig({
    run: async () => {
      if (fail) throw new Error("exit 1");
      return config({ allow: ["recovered"] });
    },
  });
  expect(await r.provider.get()).toBe(BUILTIN_RULES);
  await r.provider.get();
  expect(r.runs).toHaveLength(1);
  fail = false;
  r.clock.advance(5 * 60_000 - 1);
  expect(await r.provider.get()).toBe(BUILTIN_RULES);
  r.clock.advance(1);
  expect((await r.provider.get()).allow).toEqual(["recovered"]);
});

test("stale CLI rules beat the built-in ones when a refresh fails", async () => {
  let fail = false;
  const r = rig({
    run: async () => {
      if (fail) throw new Error("exit 1");
      return config({ allow: ["old"] });
    },
  });
  await r.provider.get();
  fail = true;
  r.clock.advance(24 * 3600_000);
  expect((await r.provider.get()).allow).toEqual(["old"]);
});

test("unparseable CLI output counts as a failure, and a broken disk cache is ignored", async () => {
  const r = rig({ run: async () => "garbage" });
  writeFileSync(r.cachePath, "{broken");
  expect(await r.provider.get()).toBe(BUILTIN_RULES);
  expect(existsSync(r.cachePath)).toBe(true);
});

test("concurrent callers share one CLI run", async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.provider.get(), r.provider.get()]);
  expect(a).toBe(b);
  expect(r.runs).toHaveLength(1);
});
