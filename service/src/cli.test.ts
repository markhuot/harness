import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "@harness/shared";
import { BUNDLED_ENV, buildBundledPlist, buildPlist, Cli, LAUNCHD_LABEL, type CliDeps, type Exec } from "./cli";
import { createHarness, type Harness } from "./app";
import { DummyDriver } from "./drivers/dummy";
import { stubBrowser, tempHome } from "./testing/fakes";

const baseOpts = {
  program: ["/Users/me/.bun/bin/bun", "/repo/service/src/daemon.ts"],
  pathDirs: ["/Users/me/.bun/bin"],
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

  test("runs the app's compiled executable in daemon mode, without its directory on PATH", () => {
    const exe = "/Applications/Harness.app/Contents/MacOS/harness-service";
    const xml = buildPlist({ ...baseOpts, program: [exe, "daemon"], pathDirs: [] });
    expect(xml).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Applications\/Harness\.app\/Contents\/MacOS\/harness-service<\/string>\s*<string>daemon<\/string>\s*<\/array>/);
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)![1]!.split(":");
    expect(path).not.toContain("/Applications/Harness.app/Contents/MacOS");
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
    // launchd SIGKILLs after ExitTimeOut (default 20s); the daemon needs up to 25s to close Chrome cleanly.
    expect(j.ExitTimeOut).toBeGreaterThan(25);
  });
});

describe("buildBundledPlist", () => {
  test("runs the bundle's service for any user: BundleProgram, the app's bundle id, and no paths", async () => {
    const xml = buildBundledPlist({ appBundleId: "com.markhuot.harness.app", executable: "harness-service" });
    expect(xml).not.toContain("/Users/");
    expect(xml).not.toMatch(/StandardOutPath|WorkingDirectory|<key>PATH<\/key>/);
    if (!Bun.which("plutil")) return;
    const file = join(tempHome("harness-bundled-plist-"), `${LAUNCHD_LABEL}.plist`);
    writeFileSync(file, xml);
    expect(Bun.spawnSync(["plutil", "-lint", file]).exitCode).toBe(0);
    const j = JSON.parse(new TextDecoder().decode(Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", file]).stdout));
    expect(j.Label).toBe(LAUNCHD_LABEL);
    expect(j.BundleProgram).toBe("Contents/MacOS/harness-service");
    expect(j.ProgramArguments).toEqual(["harness-service", "daemon"]);
    expect(j.AssociatedBundleIdentifiers).toEqual(["com.markhuot.harness.app"]);
    expect(j.EnvironmentVariables).toEqual({ [BUNDLED_ENV]: "bundle" });
    expect(j.KeepAlive).toBe(true);
    expect(j.ExitTimeOut).toBeGreaterThan(25);
  });
});

/**
 * Fake launchctl tracking loaded state; bootstrap/kickstart can boot an in-process harness. Like the
 * real one, bootout returns at once but the job stays (print finds it, bootstrap fails with 5) for
 * `lingerPrints` more prints while the daemon shuts down; then launchd removes it.
 */
function fakeLaunchctl(onStart?: () => Promise<void>, o: { lingerPrints?: number } = {}) {
  const calls: string[][] = [];
  let loaded = false;
  let dying = 0;
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    const [, verb] = cmd;
    if (verb === "print") {
      if (dying > 0 && --dying === 0) loaded = false;
      return loaded ? { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "not found" };
    }
    if (verb === "bootstrap") {
      if (dying > 0) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      loaded = true;
      await onStart?.();
    }
    if (verb === "bootout") {
      if (o.lingerPrints) dying = o.lingerPrints + 1;
      else loaded = false;
    }
    if (verb === "kickstart") await onStart?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, verbs: () => calls.map((c) => c[1]), get loaded() { return loaded; } };
}

function deps(over: Partial<CliDeps>): CliDeps {
  const out: string[] = [];
  return {
    env: {},
    exec: fakeLaunchctl().exec,
    uid: 501,
    userHome: tempHome("harness-user-"),
    program: ["/bin/bun", "/repo/daemon.ts"],
    pathDirs: ["/bin"],
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    fetch: globalThis.fetch,
    sleep: (ms) => Bun.sleep(Math.min(ms, 10)),
    healthTimeoutMs: 300,
    appManaged: false,
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

    const moved = new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] });
    expect((await moved.install()).changed).toBe(true);
    expect(la.verbs().slice(3)).toEqual(["print", "bootout", "print", "bootstrap"]);
    expect(readFileSync(cli.plistPath, "utf8")).toContain("/elsewhere/daemon.ts");
    expect(existsSync(join(home, "token"))).toBe(true);
  });

  test("a changed plist waits for launchd to drop the booted-out job before bootstrapping it again", async () => {
    const la = fakeLaunchctl(undefined, { lingerPrints: 3 });
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } });
    await new Cli(d).install();
    const before = la.verbs().length;
    await new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] }).install();
    // bootstrapping while the old job was still shutting down failed with 5, and launchd then
    // removed the job, leaving nothing loaded and nothing to restart it.
    expect(la.verbs().slice(before)).toEqual(["print", "bootout", "print", "print", "print", "print", "bootstrap"]);
    expect(la.loaded).toBe(true);
  });

  test("restart reloads a plist that changed since launchd loaded it instead of relaunching the old one", async () => {
    const la = fakeLaunchctl();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } });
    await new Cli(d).install();
    const before = la.verbs().length;
    await new Cli(d).restart();
    expect(la.calls.slice(before).map((c) => c.slice(1, 3))).toEqual([["print", "gui/501/com.markhuot.harness"], ["kickstart", "-k"]]);

    const moved = new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] });
    const mid = la.verbs().length;
    await moved.restart();
    expect(la.verbs().slice(mid)).toEqual(["print", "print", "bootout", "print", "bootstrap"]);
    expect(readFileSync(moved.plistPath, "utf8")).toContain("/elsewhere/daemon.ts");
  });

  test("a stopped job with a stale plist starts from the new plist", async () => {
    const la = fakeLaunchctl();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } });
    await new Cli(d).install();
    await new Cli(d).stop();
    const moved = new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] });
    await moved.start();
    expect(la.loaded).toBe(true);
    expect(readFileSync(moved.plistPath, "utf8")).toContain("/elsewhere/daemon.ts");
  });

  test("HARNESS_DUMMY_DRIVER=1 adds the dummy driver to the plist; installing without it takes it out", async () => {
    const la = fakeLaunchctl();
    const home = tempHome();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: home } });
    await new Cli(d).install();
    const plain = readFileSync(new Cli(d).plistPath, "utf8");
    expect(plain).not.toContain("HARNESS_DUMMY_DRIVER");

    const withDummy = new Cli({ ...d, env: { HARNESS_HOME: home, HARNESS_DUMMY_DRIVER: "1" } });
    expect((await withDummy.install()).changed).toBe(true);
    expect(readFileSync(withDummy.plistPath, "utf8")).toMatch(/<key>HARNESS_DUMMY_DRIVER<\/key>\s*<string>1<\/string>/);

    expect((await new Cli(d).install()).changed).toBe(true);
    expect(readFileSync(withDummy.plistPath, "utf8")).toBe(plain);
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

  test("ensure leaves a service with running agents alone when the plist changed, until --force", async () => {
    const home = tempHome();
    const port = await freePort();
    const la = fakeLaunchctl(async () => {
      running ??= await createHarness({ home, port, drivers: [new DummyDriver({ delayMs: 60_000 })], browser: stubBrowser(), watchers: null, log: () => {} });
    });
    const env = { HARNESS_HOME: home, HARNESS_PORT: String(port) };
    const out: string[] = [];
    const d = deps({ exec: la.exec, env, out: (s) => out.push(s) });
    expect(await new Cli(d).run(["service", "ensure", "--json"])).toBe(0);
    mkdirSync(join(home, "proj"), { recursive: true });
    const project = await running!.orchestrator.createProject({ path: join(home, "proj") });
    await running!.orchestrator.createTicket({ projectId: project.id, spec: "Long one", driver: "dummy" });

    const moved = new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] });
    const plistBefore = readFileSync(moved.plistPath, "utf8");
    const before = la.verbs().length;
    out.length = 0;
    expect(await moved.run(["service", "ensure", "--json"])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ pid: process.pid, deferred: { busy: 1 } });
    expect(la.verbs().slice(before)).not.toContain("bootout");
    // The plist stays as launchd loaded it, so the next ensure still sees the change.
    expect(readFileSync(moved.plistPath, "utf8")).toBe(plistBefore);

    out.length = 0;
    expect(await moved.run(["service", "ensure", "--force", "--json"])).toBe(0);
    expect(JSON.parse(out[0]!).deferred).toBeUndefined();
    expect(la.verbs().slice(before)).toContain("bootout");
    expect(readFileSync(moved.plistPath, "utf8")).toContain("/elsewhere/daemon.ts");
  });

  test("ensure reloads a changed plist right away when no agents are running", async () => {
    const home = tempHome();
    const port = await freePort();
    const la = fakeLaunchctl(async () => {
      running ??= await createHarness({ home, port, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    });
    const out: string[] = [];
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: home, HARNESS_PORT: String(port) }, out: (s) => out.push(s) });
    expect(await new Cli(d).run(["service", "ensure", "--json"])).toBe(0);
    const before = la.verbs().length;
    out.length = 0;
    expect(await new Cli({ ...d, program: ["/bin/bun", "/elsewhere/daemon.ts"] }).run(["service", "ensure", "--json"])).toBe(0);
    expect(JSON.parse(out[0]!).deferred).toBeUndefined();
    expect(la.verbs().slice(before)).toContain("bootout");
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
    expect(la.verbs().slice(-2)).toEqual(["bootout", "print"]);
  });

  test("app-managed (the compiled service in Harness.app): install, ensure and start never write a plist for the label", async () => {
    const la = fakeLaunchctl();
    const out: string[] = [];
    const cli = new Cli(deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() }, appManaged: true, out: (s) => out.push(s) }));
    for (const sub of ["install", "ensure", "start"]) {
      expect(await cli.run(["service", sub, "--json"])).toBe(1);
      expect(JSON.parse(out.pop()!).error).toMatch(/Start at login/);
    }
    expect(existsSync(cli.plistPath)).toBe(false);
    expect(la.verbs()).not.toContain("bootstrap");
  });

  test("app-managed restart and start kickstart the job SMAppService loaded, without reloading a plist", async () => {
    const la = fakeLaunchctl();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } });
    await new Cli(d).install(); // stands in for the job SMAppService registered
    unlinkSync(new Cli(d).plistPath);
    const cli = new Cli({ ...d, appManaged: true });
    const before = la.calls.length;
    await cli.restart();
    await cli.start();
    expect(la.calls.slice(before).map((c) => c.slice(1).join(" "))).toEqual([
      `print gui/501/${LAUNCHD_LABEL}`,
      `kickstart -k gui/501/${LAUNCHD_LABEL}`,
      `print gui/501/${LAUNCHD_LABEL}`,
      `kickstart gui/501/${LAUNCHD_LABEL}`,
    ]);
    expect(existsSync(cli.plistPath)).toBe(false);
  });

  test("app-managed uninstall removes a plist from before SMAppService, and leaves the app's own job alone", async () => {
    const la = fakeLaunchctl();
    const d = deps({ exec: la.exec, env: { HARNESS_HOME: tempHome() } });
    const cli = new Cli({ ...d, appManaged: true });
    await new Cli(d).install(); // an older Harness.app wrote this
    await cli.uninstall();
    expect(existsSync(cli.plistPath)).toBe(false);
    expect(la.loaded).toBe(false);

    await new Cli(d).install();
    unlinkSync(cli.plistPath); // only the SMAppService job is left
    const before = la.verbs().length;
    await cli.uninstall();
    expect(la.verbs().slice(before)).toEqual([]);
    expect(la.loaded).toBe(true);
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
    // A draft is listed as one, not as the planning ticket it technically is.
    const project = running.orchestrator.listProjects()[0]!;
    await running.orchestrator.createTicket({ projectId: project.id, spec: "Later idea", draft: true, driver: "dummy" });
    out.length = 0;
    expect(await cli.run(["tickets"])).toBe(0);
    expect(out[0]).toMatch(/MYAPP-3\s+draft\s/);
    // A ticket linked to a remote ID is listed by it, with its local key alongside.
    await running.orchestrator.createTicket({ projectId: project.id, spec: "From jira", start: false, driver: "dummy", externalRef: { source: "jira", key: "JIRA-5", url: null, raw: null } });
    await running.orchestrator.idle();
    out.length = 0;
    expect(await cli.run(["tickets"])).toBe(0);
    expect(out[0]).toMatch(/^JIRA-5 · MYAPP-4\s+planning\s/m);
    expect(out[0]).toMatch(/^MYAPP-1\s+review/m);
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
