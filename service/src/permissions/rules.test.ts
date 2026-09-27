import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModeRulesProvider, BUILTIN_RULES, parseAutoModeConfig } from "./rules";

const cfg = (tag: string) => JSON.stringify({ environment: [`env ${tag}`], allow: [`allow ${tag}`], soft_deny: [`soft ${tag}`], hard_deny: [`hard ${tag}`] });

function setup(opts: { outputs?: (string | Error)[]; bin?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rules-"));
  const settingsPath = join(dir, "settings.json");
  const cachePath = join(dir, "cache.json");
  let t = 1_000_000;
  const runs: string[] = [];
  const outputs = [...(opts.outputs ?? [cfg("a")])];
  const make = () =>
    new AutoModeRulesProvider({
      bin: () => (opts.bin === undefined ? "/fake/claude" : opts.bin),
      env: () => ({}),
      cachePath,
      settingsPath,
      now: () => t,
      run: async (bin) => {
        runs.push(bin);
        const out = outputs.shift() ?? cfg("again");
        if (out instanceof Error) throw out;
        return out;
      },
    });
  return { make, runs, settingsPath, cachePath, advance: (ms: number) => (t += ms), now: () => t };
}

describe("parseAutoModeConfig", () => {
  test("tolerates CLI warnings before the JSON and rejects malformed configs", () => {
    expect(parseAutoModeConfig(`Warning: extra certs\n${cfg("x")}`, 5)).toMatchObject({ soft_deny: ["soft x"], source: "claude-cli", fetchedAt: 5 });
    expect(parseAutoModeConfig(JSON.stringify({ allow: "not a list" }), 5)).toBeNull();
    expect(parseAutoModeConfig("no json", 5)).toBeNull();
  });
});

describe("AutoModeRulesProvider", () => {
  test("loads once, then serves the cache (memory, and disk for a new process)", async () => {
    const s = setup();
    const p = s.make();
    expect((await p.get()).soft_deny).toEqual(["soft a"]);
    expect((await p.get()).soft_deny).toEqual(["soft a"]);
    expect((await s.make().get()).soft_deny).toEqual(["soft a"]); // from cache.json
    expect(s.runs).toHaveLength(1);
  });

  test("refreshes after a day", async () => {
    const s = setup({ outputs: [cfg("a"), cfg("b")] });
    const p = s.make();
    await p.get();
    s.advance(25 * 60 * 60 * 1000);
    expect((await p.get()).soft_deny).toEqual(["soft b"]);
    expect(s.runs).toHaveLength(2);
  });

  test("refreshes when ~/.claude/settings.json changes after the fetch", async () => {
    const s = setup({ outputs: [cfg("a"), cfg("b")] });
    const p = s.make();
    await p.get();
    writeFileSync(s.settingsPath, "{}");
    const later = (s.now() + 1000) / 1000;
    utimesSync(s.settingsPath, later, later);
    expect((await p.get()).soft_deny).toEqual(["soft b"]);
  });

  test("falls back to built-in rules without the CLI, and to stale rules when a refresh fails", async () => {
    expect(await setup({ bin: null }).make().get()).toBe(BUILTIN_RULES);
    const s = setup({ outputs: [cfg("a"), new Error("boom")] });
    const p = s.make();
    await p.get();
    s.advance(25 * 60 * 60 * 1000);
    expect((await p.get()).soft_deny).toEqual(["soft a"]);
    // and doesn't respawn the CLI on every call right after a failure
    await p.get();
    expect(s.runs).toHaveLength(2);
  });

  test("concurrent callers share one CLI run", async () => {
    const s = setup();
    const p = s.make();
    await Promise.all([p.get(), p.get(), p.get()]);
    expect(s.runs).toHaveLength(1);
  });
});
