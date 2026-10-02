import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { ChildService, type ChildProcessHandle } from "./child";
import { parseEnsureOutput, parseStatusOutput, reloadToken, resolveSource, ServiceManager } from "./service";

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

describe("parseStatusOutput", () => {
  test("needs installed, healthy and the paths; an ensure result isn't a status", () => {
    const status = { installed: false, healthy: false, pid: null, url: "http://a", home: "/h", tokenPath: "/t", logPath: "/l" };
    expect(parseStatusOutput(`noise\n${JSON.stringify(status)}\n`)).toEqual(status);
    expect(parseStatusOutput(JSON.stringify({ url: "http://a", tokenPath: "/t" }))).toBeNull();
  });
});

const URL = "http://127.0.0.1:7717";

/**
 * A fake app + repo whose service CLI is a script backed by state.json ({ installed, healthy,
 * ensureFails }), logging each call to `calls`. The fake child "serves" /health while it runs.
 */
function fixture(state: { installed?: boolean; healthy?: boolean; ensureFails?: boolean; stalePlist?: boolean; busy?: number } = {}) {
  const root = tempDir("harness-app-test-");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "service/src"), { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, "token"), "secret-token\n");
  writeFileSync(
    join(repo, "service/src/cli.ts"),
    `
    const fs = require("node:fs");
    const root = ${JSON.stringify(root)};
    const args = process.argv.slice(2).join(" ");
    fs.appendFileSync(root + "/calls", args + "\\n");
    const state = JSON.parse(fs.readFileSync(root + "/state.json", "utf8"));
    const save = () => fs.writeFileSync(root + "/state.json", JSON.stringify(state));
    const base = { url: ${JSON.stringify(URL)}, home: root, tokenPath: root + "/token", logPath: root + "/service.log" };
    if (args === "service status --json") {
      console.log(JSON.stringify({ ...base, installed: !!state.installed, healthy: !!state.healthy, pid: state.healthy ? 99 : null }));
      process.exit(state.healthy ? 0 : 3);
    }
    if (args === "service ensure --json") {
      if (state.ensureFails) { console.error("launchctl bootstrap failed: 5"); process.exit(1); }
      if (state.stalePlist && state.busy) {
        console.log(JSON.stringify({ url: base.url, tokenPath: base.tokenPath, home: root, pid: 41, deferred: { busy: state.busy } }));
        process.exit(0);
      }
      state.installed = true; state.healthy = true; state.stalePlist = false; save();
      console.log("launchd: loaded");
      console.log(JSON.stringify({ url: base.url, tokenPath: base.tokenPath, home: root, pid: 42 }));
      process.exit(0);
    }
    if (args === "service uninstall --json") { state.installed = false; state.healthy = false; save(); console.log('{"ok":true}'); process.exit(0); }
    if (args === "service restart --json") { console.log('{"ok":true}'); process.exit(0); }
    process.exit(2);
  `,
  );
  const app = join(root, "app");
  mkdirSync(join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "resources/harness.json"), JSON.stringify({ repoRoot: repo, bunPath: process.execPath }));

  const spawned: { cmd: string[]; env: NodeJS.ProcessEnv; logPath: string; signals: string[] }[] = [];
  let up = false;
  let pid = 1000;
  let exitImmediately = false;
  const child = new ChildService({
    respawnDelayMs: 0,
    maxQuickExits: 3,
    stopTimeoutMs: 1000,
    spawn: (cmd, env, logPath): ChildProcessHandle => {
      const rec = { cmd, env, logPath, signals: [] as string[] };
      spawned.push(rec);
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      if (exitImmediately) setTimeout(() => exit(1), 0);
      else up = true;
      const myPid = ++pid;
      return {
        pid: myPid,
        exited,
        kill: (s) => {
          rec.signals.push(s);
          up = false;
          exit(null);
        },
      };
    },
  });
  const state$ = () => JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as { installed?: boolean; healthy?: boolean; stalePlist?: boolean; busy?: number };
  const setState = (patch: Record<string, unknown>) => writeFileSync(join(root, "state.json"), JSON.stringify({ ...state$(), ...patch }));
  const fetch = (async (url: string) => {
    if (url === `${URL}/health`) {
      if (up) return Response.json({ data: { ok: true, pid } });
      if (state$().healthy) return Response.json({ data: { ok: true, pid: 99 } });
      throw new Error("ECONNREFUSED");
    }
    if (url === `${URL}/sessions`) return Response.json({ data: Array.from({ length: state$().busy ?? 0 }, () => ({ busy: true })) });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof globalThis.fetch;
  const manager = (env: NodeJS.ProcessEnv = {}) =>
    new ServiceManager({ appRoot: app, exeDir: join(root, "MacOS"), env: { PATH: process.env.PATH, ...env }, child, fetch, healthTimeoutMs: 500, pid: 4242 });
  const calls = () => {
    try {
      return readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { root, repo, app, child, spawned, manager, calls, state: state$, setState, exitImmediately: () => (exitImmediately = true) };
}

describe("ServiceManager.connect", () => {
  test("env overrides skip the CLI entirely", async () => {
    const m = new ServiceManager({ appRoot: "/definitely/missing", exeDir: "/x", env: { HARNESS_URL: "http://127.0.0.1:1", HARNESS_TOKEN: "t" } });
    expect(await m.connect()).toEqual({ baseUrl: "http://127.0.0.1:1", token: "t", source: "env" });
  });

  test("by default it starts the daemon as its child, told who its supervisor is", async () => {
    const f = fixture();
    const res = await f.manager().connect();
    expect(res).toEqual({ baseUrl: URL, token: "secret-token", source: "service", mode: "app", tokenPath: join(f.root, "token"), home: f.root, pid: 1001 });
    expect(f.calls()).toEqual(["service status --json"]);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.cmd).toEqual([process.execPath, join(f.repo, "service/src/daemon.ts")]);
    expect(f.spawned[0]!.env.HARNESS_SUPERVISOR_PID).toBe("4242");
    expect(f.spawned[0]!.env.PATH!.split(":")).toContain(join(process.execPath, ".."));
    expect(f.spawned[0]!.logPath).toBe(join(f.root, "service.log"));
    // Connecting again (a reload, Retry) reuses the running child.
    expect(await f.manager().connect()).toMatchObject({ mode: "app" });
    expect(f.spawned).toHaveLength(1);
  });

  test("an installed login item goes through launchd (`service ensure`), never a child", async () => {
    const f = fixture({ installed: true });
    const res = await f.manager().connect();
    expect(res).toEqual({ baseUrl: URL, token: "secret-token", source: "service", mode: "login", tokenPath: join(f.root, "token"), home: f.root, pid: 42 });
    expect(f.calls()).toEqual(["service status --json", "service ensure --json"]);
    expect(f.spawned).toHaveLength(0);
  });

  test("a service someone else started is used as is (external), not doubled", async () => {
    const f = fixture({ healthy: true });
    expect(await f.manager().connect()).toMatchObject({ mode: "external", pid: 99 });
    expect(f.spawned).toHaveLength(0);
  });

  test("a child that keeps dying on start is an error with the log tail", async () => {
    const f = fixture();
    f.exitImmediately();
    writeFileSync(join(f.root, "service.log"), "boot\nerror: EADDRINUSE 7717\n");
    const res = await f.manager().connect();
    expect("error" in res && res.error).toBe("The harness service didn't start.");
    expect("error" in res && res.output).toContain("exited 3 times right after starting");
    expect("error" in res && res.output).toContain("EADDRINUSE 7717");
    expect(f.child.running).toBe(false);
  });

  test("a packaged app runs its compiled executable: the CLI and `daemon`", async () => {
    const root = tempDir("harness-app-exe-");
    const app = join(root, "Resources/app");
    mkdirSync(join(app, "resources"), { recursive: true });
    writeFileSync(join(app, "resources/harness.json"), JSON.stringify({ executable: "harness-service" }));
    mkdirSync(join(root, "MacOS"));
    const exe = join(root, "MacOS/harness-service");
    writeFileSync(join(root, "token"), "t\n");
    writeFileSync(
      exe,
      `#!/bin/sh\necho "$@" >> ${root}/calls\necho '{"installed":false,"healthy":false,"pid":null,"url":"${URL}","home":"${root}","tokenPath":"${root}/token","logPath":"${root}/log"}'\nexit 3\n`,
    );
    chmodSync(exe, 0o755);
    const spawned: string[][] = [];
    let up = false;
    const child = new ChildService({ spawn: (cmd) => ((up = true), spawned.push(cmd), { pid: 7, kill: () => {}, exited: new Promise(() => {}) }) });
    const fetch = (async () => (up ? Response.json({ data: { pid: 7 } }) : Promise.reject(new Error("down")))) as unknown as typeof globalThis.fetch;
    const m = new ServiceManager({ appRoot: app, exeDir: join(root, "MacOS"), env: {}, child, fetch, healthTimeoutMs: 500 });
    expect(await m.connect()).toMatchObject({ mode: "app", token: "t", pid: 7 });
    expect(readFileSync(join(root, "calls"), "utf8").trim()).toBe("service status --json");
    expect(spawned).toEqual([[exe, "daemon"]]);
  });

  test("a token path that can't be read is an error, not an empty token", async () => {
    const f = fixture({ installed: true });
    rmSync(join(f.root, "token"));
    const res = await f.manager().connect();
    expect("error" in res && res.error).toBe("Couldn't read the service token.");
  });

  test("a CLI that prints no status is reported with its output", async () => {
    const f = fixture();
    writeFileSync(join(f.repo, "service/src/cli.ts"), `console.error("SyntaxError: boom"); process.exit(1);`);
    const res = await f.manager().connect();
    expect("error" in res && res.error).toBe("The harness service returned something unexpected.");
    expect("error" in res && res.output).toContain("SyntaxError: boom");
  });
});

describe("resolveSource", () => {
  test("missing build resources, a missing executable and HARNESS_REPO_ROOT pointing nowhere are reported", () => {
    const missing = resolveSource("/definitely/missing", "/x", {});
    expect("error" in missing && missing.output).toContain("harness.json");
    const f = fixture();
    const moved = resolveSource(f.app, "/x", { HARNESS_REPO_ROOT: "/nope" });
    expect("error" in moved && moved.output).toBe("Expected /nope/service/src/cli.ts");
    writeFileSync(join(f.app, "resources/harness.json"), JSON.stringify({ executable: "harness-service" }));
    const noExe = resolveSource(f.app, join(f.root, "MacOS"), {});
    expect("error" in noExe && noExe.output).toBe(`Expected ${join(f.root, "MacOS/harness-service")} inside the app.`);
  });
});

describe("ServiceManager.setMode", () => {
  test("login: stops the child, then installs and starts the launchd job", async () => {
    const f = fixture();
    const m = f.manager();
    await m.connect();
    const res = await m.setMode("login");
    expect(res.error).toBeUndefined();
    expect(res.connection).toMatchObject({ mode: "login", pid: 42 });
    expect(f.spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(f.child.running).toBe(false);
    expect(f.calls()).toEqual(["service status --json", "service ensure --json"]);
  });

  test("login that launchd refuses: the login item is removed and the app runs its child again", async () => {
    const f = fixture({ ensureFails: true });
    const m = f.manager();
    await m.connect();
    const res = await m.setMode("login");
    expect(res.error?.output).toContain("launchctl bootstrap failed: 5");
    expect(res.connection).toMatchObject({ mode: "app" });
    expect(f.spawned).toHaveLength(2);
    expect(f.calls()).toEqual(["service status --json", "service ensure --json", "service uninstall --json", "service status --json"]);
  });

  test("app: removes the login item, waits for the port to go quiet, then starts the child", async () => {
    const f = fixture({ installed: true, healthy: true });
    const m = f.manager();
    expect(await m.connect()).toMatchObject({ mode: "login" });
    const res = await m.setMode("app");
    expect(res.error).toBeUndefined();
    expect(res.connection).toMatchObject({ mode: "app" });
    expect(f.state().installed).toBe(false);
    expect(f.spawned).toHaveLength(1);
    expect(f.calls().slice(2)).toEqual(["service status --json", "service uninstall --json", "service status --json"]);
  });

  test("app when it already is: nothing restarts", async () => {
    const f = fixture();
    const m = f.manager();
    await m.connect();
    expect((await m.setMode("app")).connection).toMatchObject({ mode: "app" });
    expect(f.spawned).toHaveLength(1);
    expect(f.calls()).not.toContain("service uninstall --json");
  });

  test("a HARNESS_URL window can't switch", async () => {
    const m = new ServiceManager({ appRoot: "/x", exeDir: "/x", env: { HARNESS_URL: "http://a", HARNESS_TOKEN: "t" } });
    const res = await m.setMode("login");
    expect(res.error?.error).toContain("HARNESS_URL");
    expect(res.connection).toMatchObject({ source: "env" });
  });
});

describe("ServiceManager.restart", () => {
  test("the app's child restarts in place", async () => {
    const f = fixture();
    const m = f.manager();
    const conn = await m.connect();
    expect(await m.restart(conn)).toEqual({ ok: true });
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[0]!.signals).toEqual(["SIGTERM"]);
    expect(f.child.running).toBe(true);
  });

  test("a login item restarts through launchd: `service restart --json`", async () => {
    const f = fixture({ installed: true });
    const m = f.manager();
    expect(await m.restart(await m.connect())).toEqual({ ok: true });
    expect(f.calls().at(-1)).toBe("service restart --json");
  });

  test("other connections ask the service itself, and report its refusal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const env = { baseUrl: "http://10.0.0.2:7717/", token: "tok", source: "env" } as const;
    const m = (f: typeof fetch) => new ServiceManager({ appRoot: "/x", exeDir: "/x", env: {}, fetch: f });
    expect(await m(answer(200, { data: { ok: true } })).restart(env)).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://10.0.0.2:7717/service/restart");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // A service started by hand isn't supervised, and says so.
    const external = { ...env, source: "service", mode: "external" } as const;
    const refused = await m(answer(409, { error: "This service isn't run by launchd" })).restart(external);
    expect(refused).toEqual({ error: "The harness service didn't restart.", output: "This service isn't run by launchd" });
  });

  test("no connection is an error, not a crash", async () => {
    const m = new ServiceManager({ appRoot: "/x", exeDir: "/x", env: {} });
    expect("error" in (await m.restart(null))).toBe(true);
    expect("error" in (await m.restart({ error: "down", output: "" }))).toBe(true);
  });
});

describe("ServiceManager.settleDeferred", () => {
  test("a login item another build installed stays deferred while agents run, then reloads once they're done", async () => {
    const f = fixture({ installed: true, healthy: true, stalePlist: true, busy: 2 });
    const m = f.manager();
    const conn = await m.connect();
    expect(conn).toMatchObject({ mode: "login", pid: 41, deferred: { busy: 2 } });
    // Agents still running: nothing to do, and no CLI call.
    const before = f.calls().length;
    expect(await m.settleDeferred(conn)).toBeNull();
    expect(f.calls().length).toBe(before);

    f.setState({ busy: 0 });
    const next = await m.settleDeferred(conn);
    expect(next).toMatchObject({ mode: "login", pid: 42 });
    expect(next && "deferred" in next ? next.deferred : undefined).toBeUndefined();
    expect(f.calls().at(-1)).toBe("service ensure --json");
    expect(f.state().stalePlist).toBe(false);
  });

  test("nothing deferred, or no connection: nothing to settle", async () => {
    const f = fixture({ installed: true });
    const m = f.manager();
    expect(await m.settleDeferred(await m.connect())).toBeNull();
    expect(await m.settleDeferred(null)).toBeNull();
    expect(await m.settleDeferred({ error: "down", output: "" })).toBeNull();
  });
});

describe("ServiceManager.busyAgents", () => {
  test("counts busy sessions, and 0 when the service can't say", async () => {
    const conn = { baseUrl: URL, token: "t", source: "service", mode: "app" } as const;
    const sessions = (async () => Response.json({ data: [{ busy: true }, { busy: false }, { busy: true }] })) as unknown as typeof fetch;
    const down = (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(await new ServiceManager({ appRoot: "/x", exeDir: "/x", fetch: sessions }).busyAgents(conn)).toBe(2);
    expect(await new ServiceManager({ appRoot: "/x", exeDir: "/x", fetch: down }).busyAgents(conn)).toBe(0);
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
