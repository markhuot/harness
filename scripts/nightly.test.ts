import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { failedChecks, formatReport, listAppChecks, nightlyLayers, parseArgs, type LayerResult } from "./nightly";

const layer = (id: string, kind: "light" | "app" | "sim" = "light") => ({ id, title: `title of ${id}`, cmd: ["bun", id], kind });
const result = (id: string, code: number | null, output = "", skipped?: string): LayerResult => ({ layer: layer(id), code, output, ms: 1, skipped });

describe("failedChecks", () => {
  test("reads ✗ lines from sim-check and app checks, ignoring passes and duplicates", () => {
    const out = "✓ opens inbox\n✗ ticket sheet — never appeared\n✗ ticket sheet — never appeared\n✗ composer: draft survives relaunch";
    expect(failedChecks(out)).toEqual(["ticket sheet — never appeared", "composer: draft survives relaunch"]);
  });

  test("reads bun test (fail) lines without the timing suffix", () => {
    expect(failedChecks("(pass) a\n(fail) planLayers > maps ios [2.10ms]\n")).toEqual(["planLayers > maps ios"]);
  });

  test("reads tsc errors and strips ANSI colour", () => {
    const out = "\x1b[31mservice/src/a.ts(3,5): error TS2322: bad\x1b[0m\nservice/src/a.ts(9,1): error TS2322: again";
    expect(failedChecks(out)).toEqual(["service/src/a.ts TS2322"]);
  });

  test("returns nothing when the log names no check", () => {
    expect(failedChecks("swift: linker command failed")).toEqual([]);
  });
});

describe("formatReport", () => {
  const date = new Date("2026-10-14T03:00:00Z");

  test("is empty when every layer passed", () => {
    expect(formatReport([result("bun:all", 0, "ok"), result("typecheck", 0)], date)).toBe("");
  });

  test("names the failing layer, its checks and only the log tail", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n✗ walk: tickets — timeout";
    const report = formatReport([result("bun:all", 0), result("sim-check --shards=2", 1, log)], date);
    expect(report).toContain("2026-10-14: 1 of 2 layers failed: sim-check --shards=2");
    expect(report).toContain("Failing checks: walk: tickets — timeout");
    expect(report).toContain("Rerun: bun sim-check --shards=2");
    expect(report).toContain("✗ walk: tickets — timeout");
    expect(report).toContain("line 99");
    expect(report).not.toContain("line 10\n");
    expect(report).not.toContain("## bun:all");
  });

  test("caps the check list", () => {
    const log = Array.from({ length: 20 }, (_, i) => `✗ check ${i}`).join("\n");
    expect(formatReport([result("app-check:x", 1, log)], date)).toContain("check 11; +8 more");
  });

  test("reports a skipped layer as a failure with its reason", () => {
    const report = formatReport([result("sim-check", null, "", "not enough free disk")], date);
    expect(report).toContain("1 of 1 layers failed: sim-check");
    expect(report).toContain("Skipped: not enough free disk");
  });
});

describe("layers", () => {
  test("the sim-check layer is the full walk-through with two shards, after the app checks", () => {
    const layers = nightlyLayers(["smoke", "x-check"]);
    expect(layers.map((l) => l.id)).toEqual([
      "bun:all", "typecheck", "swift-test", "app-build", "app-check:smoke", "app-check:x-check", "sim-check --shards=2",
    ]);
    expect(layers.at(-1)!.cmd).toEqual(["bun", "ios/Tools/sim-check.ts", "--shards=2"]);
  });

  test("listAppChecks finds smoke and every real *-check script", () => {
    const checks = listAppChecks(join(import.meta.dir, "..", "app", "scripts"));
    expect(checks[0]).toBe("smoke");
    expect(checks).toContain("terminal-pane-check");
    expect(checks.every((c) => c === "smoke" || c.endsWith("-check"))).toBe(true);
  });

  test("sim-check documents the flags the nightly passes", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "ios", "Tools", "sim-check.ts")).text();
    expect(src).toContain("--shards=N");
  });
});

describe("parseArgs and the CLI", () => {
  test("parses --only and --list, rejects unknown flags", () => {
    expect(parseArgs(["--only=a,b", "--list"])).toEqual({ only: ["a", "b"], list: true });
    expect(() => parseArgs(["--nope"])).toThrow("unknown option");
  });

  test("--list prints the real plan without running anything", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "nightly.ts"), "--list"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain("sim-check --shards=2\tbun ios/Tools/sim-check.ts --shards=2");
  });

  test("a bad flag exits 2", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "nightly.ts"), "--nope"], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });

  test("a green run is silent on stdout and exits 4 (nothing to report)", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "nightly.ts"), "--only=no-such-layer"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(4);
    expect(out).toBe("");
    expect(err).toContain("all green");
  });
});

describe("the example watcher", () => {
  test("runs the nightly script daily from a checkout that has it, and tells triage to decline green runs", async () => {
    const w = await Bun.file(join(import.meta.dir, "..", "service", "examples", "watchers", "nightly.json")).json();
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(w.command).toBe("bun run nightly");
    expect(pkg.scripts.nightly).toBe("bun scripts/nightly.ts");
    expect(w.mode).toBe("interval");
    expect(w.intervalSec).toBe(86400);
    expect(w.prompt).toContain("HARNESS");
    expect(w.prompt).toContain("Decline");
  });
});
