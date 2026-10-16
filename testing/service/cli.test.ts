import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPath } from "../../service/src/bundled-launchd";
import { buildBundledPlist, buildPlist, BUNDLED_ENV, Cli, EXIT_TIMEOUT_S, launchdPath, LAUNCHD_LABEL, type CliDeps, type ExecResult } from "../../service/src/cli";
import { ensureHome, ensureToken } from "../../service/src/config";
import { tempDir } from "../builders/tmp";

test("launchd's PATH puts the user's tools first, then the system's, each once", () => {
  const dirs = launchdPath("/Users/me", ["/opt/bun/bin", "/usr/bin"]).split(":");
  expect(dirs.slice(0, 3)).toEqual(["/Users/me/.local/bin", "/Users/me/.bun/bin", "/opt/bun/bin"]);
  expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  expect(dirs.at(-1)).toBe("/sbin");
});

test("the service plist runs the daemon with its home, port and log, escapes XML, and only adds the dummy driver when asked", () => {
  const base = { program: ["/bin/bun", "/repo/daemon.ts"], home: "/h&m", port: 4321, logPath: "/h/service.log", userHome: "/Users/me" };
  const plist = buildPlist(base);
  expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  expect(plist).toContain("<string>/bin/bun</string>");
  expect(plist).toContain("<string>/repo/daemon.ts</string>");
  expect(plist).toContain("<key>HARNESS_HOME</key>\n      <string>/h&amp;m</string>");
  expect(plist).toContain("<string>4321</string>");
  expect(plist).toContain("/h/service.log");
  expect(plist).not.toContain("HARNESS_DUMMY_DRIVER");
  expect(buildPlist({ ...base, dummyDriver: true })).toContain("<key>HARNESS_DUMMY_DRIVER</key>");
  expect(buildPlist({ ...base, label: "x.y" })).toContain("<string>x.y</string>");
});

test("the bundled plist holds no paths: the app's bundle id, the executable and the marker the daemon looks for", () => {
  const plist = buildBundledPlist({ appBundleId: "com.example.App&Co", executable: "harness-service" });
  expect(plist).toContain("<string>Contents/MacOS/harness-service</string>");
  expect(plist).toContain("<string>com.example.App&amp;Co</string>");
  expect(plist).toContain(`<key>${BUNDLED_ENV}</key>\n      <string>bundle</string>`);
  expect(plist).toContain(`<integer>${EXIT_TIMEOUT_S}</integer>`);
  expect(plist).not.toMatch(/\/Users\//);
});

test("the daemon under the bundled plist gets launchd's PATH with the tools' folders ahead of what it already had", () => {
  const path = bundledPath("/custom/bin:/usr/bin", "/Users/me").split(":");
  expect(path[0]).toBe("/Users/me/.local/bin");
  expect(path).toContain("/custom/bin");
  expect(path.filter((p) => p === "/usr/bin")).toHaveLength(1);
});

/** A fake launchd: `print` finds the job while it's loaded, bootstrap loads it, bootout unloads it. */
function rig(over: Partial<CliDeps> & { env?: Record<string, string> } = {}) {
  const userHome = tempDir();
  const home = tempDir();
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const state = { loaded: false, pid: 4242, healthy: false, busy: 0, bootstrapCode: 0, raceLoaded: false, healthAfterKickstart: true };
  const exec = async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd.slice(1).join(" "));
    const verb = cmd[1];
    if (verb === "print") return state.loaded ? { code: 0, stdout: `x = {\n\tpid = ${state.pid}\n}`, stderr: "" } : { code: 113, stdout: "", stderr: "not found" };
    if (verb === "bootstrap") {
      if (state.bootstrapCode === 0 || state.raceLoaded) state.loaded = true;
      return { code: state.bootstrapCode, stdout: "", stderr: "boom" };
    }
    if (verb === "bootout") {
      state.loaded = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "kickstart" && state.healthAfterKickstart) state.healthy = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/health")) return state.healthy ? new Response(JSON.stringify({ data: { ok: true, version: "9", pid: state.pid } })) : new Response("", { status: 503 });
    if (u.endsWith("/sessions")) return new Response(JSON.stringify({ data: Array.from({ length: state.busy }, () => ({ busy: true })).concat([{ busy: false }]) }));
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
  const deps: CliDeps = {
    env: { HARNESS_HOME: home, HARNESS_PORT: "4999", ...(over.env ?? {}) },
    exec,
    uid: 501,
    userHome,
    program: ["/bin/bun", "/repo/service/src/daemon.ts"],
    pathDirs: ["/bun/bin"],
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: fetchFn,
    sleep: async () => {},
    healthTimeoutMs: 0,
    appManaged: false,
    ...over,
  };
  const cli = new Cli(deps);
  /** Another CLI on the same machine (same launchd, same home) with different environment variables. */
  const withEnv = (env: Record<string, string>) => new Cli({ ...deps, env: { ...deps.env, ...env } });
  return { cli, withEnv, calls, out, err, state, home, userHome, plist: join(userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`) };
}

test("install writes the plist and token, loads the job and kickstarts it; running it again changes nothing", async () => {
  const r = rig();
  expect(await r.cli.install()).toEqual({ changed: true });
  expect(readFileSync(r.plist, "utf8")).toContain("<string>4999</string>");
  expect(existsSync(join(r.home, "token"))).toBe(true);
  expect(r.calls).toEqual([`print gui/501/${LAUNCHD_LABEL}`, `bootstrap gui/501 ${r.plist}`, `kickstart gui/501/${LAUNCHD_LABEL}`]);
  r.calls.length = 0;
  expect(await r.cli.install()).toEqual({ changed: false });
  expect(r.calls).toEqual([`print gui/501/${LAUNCHD_LABEL}`]);
});

test("a changed plist reloads a loaded job: bootout, then bootstrap, with the new plist on disk", async () => {
  const r = rig();
  await r.cli.install();
  r.calls.length = 0;
  expect(await r.withEnv({ HARNESS_PORT: "5000" }).install()).toEqual({ changed: true });
  const verbs = r.calls.map((c) => c.split(" ")[0]);
  expect(verbs.indexOf("bootout")).toBeGreaterThanOrEqual(0);
  expect(verbs.indexOf("bootout")).toBeLessThan(verbs.indexOf("bootstrap"));
  expect(readFileSync(r.plist, "utf8")).toContain("<string>5000</string>");
});

test("a bootstrap that fails and leaves the job unloaded is an error with launchctl's words", async () => {
  const r = rig();
  r.state.bootstrapCode = 5;
  await expect(r.cli.install()).rejects.toThrow(/launchctl bootstrap failed: boom/);
});

test("a bootstrap that fails because KeepAlive already loaded the job is fine", async () => {
  const r = rig();
  r.state.bootstrapCode = 37;
  r.state.raceLoaded = true;
  await expect(r.cli.install()).resolves.toEqual({ changed: true });
});

test("uninstall unloads the job and removes the plist", async () => {
  const r = rig();
  await r.cli.install();
  await r.cli.uninstall();
  expect(existsSync(r.plist)).toBe(false);
  expect(r.state.loaded).toBe(false);
});

test("an app-managed service never writes a plist of its own: install and ensure refuse, start only kickstarts a loaded job", async () => {
  const r = rig({ appManaged: true });
  await expect(r.cli.install()).rejects.toThrow(/Harness\.app runs this service/);
  await expect(r.cli.ensure()).rejects.toThrow(/Harness\.app runs this service/);
  await expect(r.cli.start()).rejects.toThrow(/Harness\.app runs this service/);
  r.state.loaded = true;
  await r.cli.start();
  expect(r.calls.at(-1)).toBe(`kickstart gui/501/${LAUNCHD_LABEL}`);
  r.calls.length = 0;
  await r.cli.restart();
  expect(r.calls.at(-1)).toBe(`kickstart -k gui/501/${LAUNCHD_LABEL}`);
  expect(existsSync(r.plist)).toBe(false);
});

test("restart kickstarts with -k when the plist is current, and reinstalls when it has changed", async () => {
  const r = rig();
  await r.cli.install();
  r.calls.length = 0;
  await r.cli.restart();
  expect(r.calls.at(-1)).toBe(`kickstart -k gui/501/${LAUNCHD_LABEL}`);
});

test("status reports whether it's installed, loaded and healthy, with the pid from /health", async () => {
  const r = rig();
  expect(await r.cli.status()).toMatchObject({ installed: false, loaded: false, healthy: false, pid: null, url: "http://127.0.0.1:4999" });
  await r.cli.install();
  expect(await r.cli.status()).toMatchObject({ installed: true, loaded: true, healthy: true, pid: 4242, version: "9" });
});

test("the status command exits 0 only when the service answers, and prints a line or JSON", async () => {
  const r = rig();
  expect(await r.cli.run(["service", "status"])).toBe(3);
  expect(r.out.at(-1)).toContain("not installed");
  await r.cli.install();
  expect(await r.cli.run(["service", "status"])).toBe(0);
  expect(r.out.at(-1)).toContain("running pid 4242");
  expect(await r.cli.run(["service", "status", "--json"])).toBe(0);
  expect(JSON.parse(r.out.at(-1)!)).toMatchObject({ healthy: true });
});

test("ensure installs, waits for health and returns the url; it fails with where to look when the service never answers", async () => {
  const ok = rig();
  expect(await ok.cli.ensure()).toMatchObject({ url: "http://127.0.0.1:4999", pid: 4242, home: ok.home });
  const never = rig();
  never.state.healthAfterKickstart = false;
  await expect(never.cli.ensure()).rejects.toThrow(/did not become healthy at http:\/\/127.0.0.1:4999 \(see .*service\.log\)/);
});

test("ensure leaves a running service alone when its plist changed but agents are mid-run, unless forced", async () => {
  const r = rig();
  await r.cli.ensure();
  // Another build writes a different plist for the same label.
  const other = r.withEnv({ HARNESS_PORT: "5111" });
  r.state.busy = 2;
  const deferred = await other.ensure();
  expect(deferred.deferred).toEqual({ busy: 2 });
  expect(readFileSync(r.plist, "utf8")).toContain("<string>4999</string>");
  const forced = await other.ensure({ force: true });
  expect(forced.deferred).toBeUndefined();
  expect(readFileSync(r.plist, "utf8")).toContain("<string>5111</string>");
});

test("busyAgents counts busy sessions and is 0 without a token or when the service can't be asked", async () => {
  const r = rig();
  expect(await r.cli.busyAgents()).toBe(0);
  ensureToken(ensureHome(r.home));
  r.state.busy = 3;
  expect(await r.cli.busyAgents()).toBe(3);
  const broken = rig({ fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
  ensureToken(ensureHome(broken.home));
  expect(await broken.cli.busyAgents()).toBe(0);
});

test("an unknown command prints the usage and exits 2; a failure exits 1 with its message, or as JSON", async () => {
  const r = rig();
  expect(await r.cli.run(["bogus"])).toBe(2);
  expect(r.err.at(-1)).toContain("usage:");
  expect(await r.cli.run(["new", "onlyadir"])).toBe(2);
  expect(await r.cli.run(["listen"])).toBe(2);
  const noToken = rig();
  expect(await noToken.cli.run(["tickets"])).toBe(1);
  expect(noToken.err.at(-1)).toContain("No token at");
  expect(await noToken.cli.run(["tickets", "--json"])).toBe(1);
  expect(JSON.parse(noToken.out.at(-1)!).error).toContain("No token at");
});
