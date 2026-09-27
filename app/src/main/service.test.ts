import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureService, parseEnsureOutput, reloadToken } from "./service";

describe("parseEnsureOutput", () => {
  test("takes the last JSON line after log noise", () => {
    const out = 'starting launchd job…\n{"url":"http://a","tokenPath":"/x"}\n{"url":"http://b","tokenPath":"/y","pid":3}\n';
    expect(parseEnsureOutput(out)).toEqual({ url: "http://b", tokenPath: "/y", pid: 3 });
  });
  test("accepts pretty-printed JSON", () => {
    expect(parseEnsureOutput('{\n  "url": "http://a",\n  "tokenPath": "/t"\n}\n')).toEqual({ url: "http://a", tokenPath: "/t" });
  });
  test("rejects JSON without the required fields, and non-JSON", () => {
    expect(parseEnsureOutput('{"ok":true}')).toBeNull();
    expect(parseEnsureOutput("service is running")).toBeNull();
  });
});

describe("ensureService", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A fake app root + repo whose service CLI is a script we control. */
  function fixture(cli: string) {
    const root = mkdtempSync(join(tmpdir(), "harness-app-test-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, "service/src"), { recursive: true });
    writeFileSync(join(repo, "service/src/cli.ts"), cli);
    const app = join(root, "app");
    mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(app, "resources/harness.json"), JSON.stringify({ repoRoot: repo, bunPath: process.execPath }));
    return { root, app };
  }

  test("env overrides skip the CLI entirely", async () => {
    const res = await ensureService("/definitely/missing", { HARNESS_URL: "http://127.0.0.1:1", HARNESS_TOKEN: "t" });
    expect(res).toEqual({ baseUrl: "http://127.0.0.1:1", token: "t", source: "env" });
  });

  test("runs `service ensure --json` with the right args and reads the token file", async () => {
    const { root, app } = fixture(`
      const [cmd, sub, flag] = process.argv.slice(2);
      if (cmd !== "service" || sub !== "ensure" || flag !== "--json") { console.error("bad args", process.argv); process.exit(2); }
      const tokenPath = process.env.FIXTURE_ROOT + "/token";
      await Bun.write(tokenPath, "secret-token\\n");
      console.log("launchd: already loaded");
      console.log(JSON.stringify({ url: "http://127.0.0.1:7717", tokenPath, home: process.env.FIXTURE_ROOT, pid: 42 }));
    `);
    const res = await ensureService(app, { PATH: process.env.PATH, FIXTURE_ROOT: root });
    expect(res).toEqual({ baseUrl: "http://127.0.0.1:7717", token: "secret-token", source: "service", tokenPath: join(root, "token"), home: root, pid: 42 });
  });

  test("a failing CLI returns an error carrying its output", async () => {
    const { app } = fixture(`console.error("launchctl bootstrap failed: 5"); process.exit(1);`);
    const res = await ensureService(app, { PATH: process.env.PATH });
    expect("error" in res && res.error).toBe("The harness service didn't start.");
    expect("output" in res && res.output).toContain("launchctl bootstrap failed: 5");
  });

  test("a token path that can't be read is an error, not an empty token", async () => {
    const { app } = fixture(`console.log(JSON.stringify({ url: "http://x", tokenPath: "/nonexistent/token" }));`);
    const res = await ensureService(app, { PATH: process.env.PATH });
    expect("error" in res && res.error).toBe("Couldn't read the service token.");
  });

  test("missing build resources and HARNESS_REPO_ROOT pointing nowhere are reported", async () => {
    const missing = await ensureService("/definitely/missing", {});
    expect("error" in missing && missing.output).toContain("harness.json");
    const { app } = fixture("");
    const moved = await ensureService(app, { HARNESS_REPO_ROOT: "/nope" });
    expect("error" in moved && moved.output).toBe("Expected /nope/service/src/cli.ts");
  });
});

describe("reloadToken", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-token-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "token");
  const conn = { baseUrl: "http://127.0.0.1:7717", token: "old", source: "service" as const, tokenPath, pid: 1 };

  test("service connections re-read the rotated token file (and ignore the passed token)", () => {
    writeFileSync(tokenPath, "new-token\n");
    expect(reloadToken(conn, "from-response")).toEqual({ ...conn, token: "new-token" });
  });

  test("an empty or missing token file is an error, not a connection with a blank token", () => {
    writeFileSync(tokenPath, "\n");
    expect(reloadToken(conn)).toMatchObject({ error: "The service token is empty." });
    rmSync(tokenPath);
    expect(reloadToken(conn)).toMatchObject({ error: "Couldn't read the service token." });
  });

  test("env connections (no token file) take the rotated token; without one they're unchanged", () => {
    const env = { baseUrl: "http://x", token: "old", source: "env" as const };
    expect(reloadToken(env, "rotated")).toEqual({ ...env, token: "rotated" });
    expect(reloadToken(env)).toEqual(env);
  });

  test("no connection or a failed one stays an error", () => {
    expect("error" in reloadToken(null)).toBe(true);
    const failed = { error: "down", output: "" };
    expect(reloadToken(failed)).toBe(failed);
  });
});
