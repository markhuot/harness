import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "@harness/shared";
import { buildPlist, Cli, LAUNCHD_LABEL, type CliDeps, type Exec } from "./cli";
import { createHarness, type Harness } from "./app";
import { DummyDriver } from "./drivers/dummy";
import { stubBrowser, tempHome } from "./testing/fakes";

const baseOpts = {
  bunPath: "/Users/me/.bun/bin/bun",
  daemonPath: "/repo/service/src/daemon.ts",
  home: "/Users/me/.harness",
  port: 7717,
  logPath: "/Users/me/.harness/logs/service.log",
  userHome: "/Users/me",
};

describe("buildPlist", () => {
  test("runs bun on daemon.ts with a PATH that finds claude and git", () => {
    const xml = buildPlist(baseOpts);
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/me\/\.bun\/bin\/bun<\/string>\s*<string>\/repo\/service\/src\/daemon\.ts<\/string>\s*<\/array>/);
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)![1]!.split(":");
    for (const dir of ["/Users/me/.local/bin", "/Users/me/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
      expect(path).toContain(dir);
    }
    expect(new Set(path).size).toBe(path.length); // bun's dir is deduped with ~/.bun/bin
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/\.harness\/logs\/service\.log<\/string>/);
    expect(xml).toMatch(/<key>HARNESS_PORT<\/key>\s*<string>7717<\/string>/);
  });

  test("escapes XML metacharacters in paths", () => {
    const xml = buildPlist({ ...baseOpts, home: "/tmp/a&b<c>" });
    expect(xml).toContain("/tmp/a&amp;b&lt;c&gt;");
    expect(xml).not.toContain("a&b");
  });

  test("is a valid property list (plutil)", async () => {
    if (!Bun.which("plutil")) return;
    const dir = tempHome("harness-plist-");
    const file = join(dir, "x.plist");
    writeFileSync(file, buildPlist({ ...baseOpts, home: "/tmp/a&b" }));
    const r = Bun.spawnSync(["plutil", "-lint", file]);
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(new TextDecoder().decode(Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", file]).stdout));
    expect(j.EnvironmentVariables.HARNESS_HOME).toBe("/tmp/a&b");
    expect(j.KeepAlive).toBe(true);
  });
});

/** Fake launchctl tracking loaded state; bootstrap/kickstart can boot an in-process harness. */
function fakeLaunchctl(onStart?: () => Promise<void>) {
  const calls: string[][] = [];
  let loaded = false;
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    const [, verb] = cmd;
    if (verb === "print") return loaded ? { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "not found" };
    if (verb === "bootstrap") {
      loaded = true;
      await onStart?.();
    }
    if (verb === "bootout") loaded = false;
    if (verb === "kickstart") await onStart?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, verbs: () => calls.map((c) => c[1]) };
}

function deps(over: Partial<CliDeps>): CliDeps {
  const out: string[] = [];
  return {
    env: {},
    exec: fakeLaunchctl().exec,
    uid: 501,
    userHome: tempHome("harness-user-"),
    bunPath: "/bin/bun",
    daemonPath: "/repo/daemon.ts",
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    fetch: globalThis.fetch,
    sleep: (ms) => Bun.sleep(Math.min(ms, 10)),
    healthTimeoutMs: 300,
    ...over,
  };
}

async function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

let running: Harness | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe("Cli service commands", () => {
  test("install writes the plist once; changes trigger bootout + bootstrap", async () => {
    const la = fakeLaunchctl();
    const home = tempHome();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: home } });
    const cli = new Cli(d);
    expect((await cli.install()).changed).toBe(true);
    expect(existsSync(cli.plistPath)).toBe(true);
    expect(cli.plistPath.startsWith(d.userHome)).toBe(true);
    expect(la.verbs()).toEqual(["print", "bootstrap"]);
    expect(la.calls[1]).toEqual(["launchctl", "bootstrap", "gui/501", cli.plistPath]);

    expect((await cli.install()).changed).toBe(false);
    expect(la.verbs()).toEqual(["print", "bootstrap", "print"]);

    const moved = new Cli({ ...d, daemonPath: "/elsewhere/daemon.ts" });
    expect((await moved.install()).changed).toBe(true);
    expect(la.verbs().slice(3)).toEqual(["print", "bootout", "bootstrap"]);
    expect(readFileSync(cli.plistPath, "utf8")).toContain("/elsewhere/daemon.ts");
    expect(existsSync(join(home, "token"))).toBe(true);
  });

  test("ensure boots via launchd and waits for /health; prints JSON", async () => {
    const home = tempHome();
    const port = await freePort();
    const la = fakeLaunchctl(async () => {
      running ??= await createHarness({ home, port, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    });
    const out: string[] = [];
    const cli = new Cli(deps({ exec: la.exec, env: { HARNESS_HOME: home, HARNESS_PORT: String(port) }, out: (s) => out.push(s) }));
    expect(await cli.run(["service", "ensure", "--json"])).toBe(0);
    const res = JSON.parse(out[0]!);
    expect(res).toEqual({ url: `http://127.0.0.1:${port}`, tokenPath: join(home, "token"), home, pid: process.pid });

    // second ensure: already installed + healthy → no launchctl mutation
    const before = la.verbs().length;
    expect(await cli.run(["service", "ensure", "--json"])).toBe(0);
    expect(la.verbs().slice(before)).toEqual(["print"]);

    // status reports healthy
    out.length = 0;
    expect(await cli.run(["service", "status", "--json"])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ installed: true, loaded: true, healthy: true, pid: process.pid });
  });

  test("ensure fails when the service never becomes healthy", async () => {
    const out: string[] = [];
    const port = await freePort();
    const cli = new Cli(deps({ env: { HARNESS_HOME: tempHome(), HARNESS_PORT: String(port) }, out: (s) => out.push(s) }));
    expect(await cli.run(["service", "ensure", "--json"])).toBe(1);
    expect(JSON.parse(out[0]!).error).toMatch(/did not become healthy/);
  });

  test("uninstall boots out and removes the plist", async () => {
    const la = fakeLaunchctl();
    const cli = new Cli(deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } }));
    await cli.install();
    await cli.uninstall();
    expect(existsSync(cli.plistPath)).toBe(false);
    expect(la.verbs().at(-1)).toBe("bootout");
  });

  test("unknown commands print usage and exit 2", async () => {
    const out: string[] = [];
    const cli = new Cli(deps({ out: (s) => out.push(s), err: (s) => out.push(s) }));
    expect(await cli.run(["service", "bogus"])).toBe(2);
    expect(out.join("\n")).toContain("usage:");
  });
});

describe("Cli new / tickets", () => {
  test("new creates the project once and a started ticket; tickets lists it", async () => {
    const home = tempHome();
    const port = await freePort();
    running = await createHarness({ home, port, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const dir = join(home, "code", "my-app");
    mkdirSync(dir, { recursive: true });
    const out: string[] = [];
    const cli = new Cli(deps({ env: { HARNESS_HOME: home, HARNESS_PORT: String(port) }, out: (s) => out.push(s) }));
    expect(await cli.run(["new", dir, "Fix", "the", "footer", "--driver", "dummy", "--json"])).toBe(0);
    const t = JSON.parse(out[0]!);
    expect([t.key, t.title, t.status]).toEqual(["MYAPP-1", "Fix the footer", "in_progress"]);
    expect(await cli.run(["new", dir, "Second", "--driver", "dummy", "--json"])).toBe(0);
    expect(JSON.parse(out[1]!).key).toBe("MYAPP-2");
    expect(running.orchestrator.listProjects().length).toBe(1);
    await running.orchestrator.idle();
    out.length = 0;
    expect(await cli.run(["tickets"])).toBe(0);
    expect(out[0]).toMatch(/MYAPP-1\s+review/);
  });
});

describe("Cli network / listen / pair / token", () => {
  test("listen rejects a non-local host, pair refuses in localhost mode, token rotate invalidates the old token", async () => {
    const home = tempHome();
    const port = await freePort();
    running = await createHarness({ home, port, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const out: string[] = [];
    const err: string[] = [];
    const cli = new Cli(deps({ env: { HARNESS_HOME: home, HARNESS_PORT: String(port) }, out: (s) => out.push(s), err: (s) => err.push(s) }));
    expect(await cli.run(["network", "--json"])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ mode: "localhost", active: "localhost", bound: [{ address: "127.0.0.1", url: `http://127.0.0.1:${port}` }] });
    expect(await cli.run(["listen", "custom", "10.254.254.254"])).toBe(1);
    expect(err.at(-1)).toContain("isn't an address of this machine");
    expect(await cli.run(["listen", "custom"])).toBe(2);
    expect(await cli.run(["pair"])).toBe(1);
    expect(err.at(-1)).toContain("only listens on localhost");

    const old = running.token;
    expect(await cli.run(["token", "rotate"])).toBe(0);
    expect(running.token).not.toBe(old);
    await expect(new HarnessClient({ baseUrl: running.url, token: old }).listProjects()).rejects.toMatchObject({ status: 401 });
    // The CLI re-reads the token file on every command, so it keeps working.
    expect(await cli.run(["network"])).toBe(0);
  });
});
