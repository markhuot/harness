import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { ensureService, parseEnsureOutput, reloadToken, restartService } from "./service";

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
  /** A fake app root + repo whose service CLI is a script we control. */
  function fixture(cli: string) {
    const root = tempDir("harness-app-test-");
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

describe("restartService", () => {
  function fixture(cli: string) {
    const root = tempDir("harness-app-test-");
    const repo = join(root, "repo");
    mkdirSync(join(repo, "service/src"), { recursive: true });
    writeFileSync(join(repo, "service/src/cli.ts"), cli);
    const app = join(root, "app");
    mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(app, "resources/harness.json"), JSON.stringify({ repoRoot: repo, bunPath: process.execPath }));
    return { root, app };
  }
  const managed = { baseUrl: "http://127.0.0.1:7717", token: "t", source: "service" } as const;
  const noFetch = (() => {
    throw new Error("fetch shouldn't be called");
  }) as unknown as typeof fetch;

  test("the service the app started restarts through launchd: `service restart --json`", async () => {
    const { root, app } = fixture(`
      const args = process.argv.slice(2).join(" ");
      await Bun.write(process.env.FIXTURE_ROOT + "/args", args);
      if (args !== "service restart --json") process.exit(2);
      console.log(JSON.stringify({ ok: true }));
    `);
    expect(await restartService(app, managed, { PATH: process.env.PATH, FIXTURE_ROOT: root }, noFetch)).toEqual({ ok: true });
    expect(await Bun.file(join(root, "args")).text()).toBe("service restart --json");
  });

  test("a failing launchctl is an error carrying the CLI output", async () => {
    const { app } = fixture(`console.error("kickstart: Operation not permitted"); process.exit(1);`);
    const res = await restartService(app, managed, { PATH: process.env.PATH }, noFetch);
    expect("error" in res && res.error).toBe("The harness service didn't restart.");
    expect("error" in res && res.output).toContain("kickstart: Operation not permitted");
  });

  test("other connections ask the service itself, and report its refusal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const env = { baseUrl: "http://10.0.0.2:7717/", token: "tok", source: "env" } as const;
    expect(await restartService("/definitely/missing", env, {}, answer(200, { data: { ok: true } }))).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://10.0.0.2:7717/service/restart");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // A service from before the endpoint existed.
    const old = await restartService("/definitely/missing", env, {}, answer(404, { error: "Not found" }));
    expect(old).toEqual({ error: "The harness service didn't restart.", output: "Not found" });
  });

  test("no connection is an error, not a crash", async () => {
    expect("error" in (await restartService("/x", null, {}, noFetch))).toBe(true);
    expect("error" in (await restartService("/x", { error: "down", output: "" }, {}, noFetch))).toBe(true);
  });
});

describe("reloadToken", () => {
  const dir = tempDir("harness-token-test-");
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
