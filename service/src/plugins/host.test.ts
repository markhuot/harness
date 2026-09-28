import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { HarnessClient, type PluginInfo, type PluginTab } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { stubBrowser, tempHome } from "../testing/fakes";
import { execFile, parseManifest, safeJoin } from "./host";

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

function writePlugin(root: string, dir: string, manifest: object | string, files: Record<string, string> = {}) {
  const p = join(root, dir);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(p, f, ".."), { recursive: true });
    writeFileSync(join(p, f), body);
  }
  return p;
}

const echoServer = (tag: string) => `
export default {
  routes(router, ctx) {
    router.get("/hello", ({ query }) => ({ tag: ${JSON.stringify(tag)}, name: query.get("name"), id: ctx.id }));
    router.get("/items/:itemId", ({ params }) => ({ itemId: params.itemId }));
    router.post("/echo", async ({ body }) => ({ got: await body() }));
    router.get("/teapot", () => { throw Object.assign(new Error("short and stout"), { status: 418 }); });
    router.get("/boom", () => { throw new Error("kaboom"); });
    router.get("/raw", () => new Response("plain", { headers: { "content-type": "text/plain" } }));
    router.get("/ticket", ({ query }, c) => {
      const t = c.getTicket(query.get("key"));
      return t ? { key: t.ticket.key, project: t.project.key, workdir: c.ticketWorkdir(t.ticket.key) } : null;
    });
    router.get("/events", () => globalThis.__pluginEvents ?? []);
  },
  onTicketEvent(e) {
    (globalThis.__pluginEvents ??= []).push(e.kind + ":" + (e.ticket?.key ?? e.id));
  },
};`;

async function boot(setup: (builtin: string, user: string) => void, opts: { hostname?: string } = {}) {
  const home = tempHome("harness-plugins-");
  const builtin = join(home, "builtin-plugins");
  const user = join(home, "plugins");
  mkdirSync(builtin, { recursive: true });
  mkdirSync(user, { recursive: true });
  setup(builtin, user);
  const logs: string[] = [];
  harness = await createHarness({
    home,
    port: 0,
    hostname: opts.hostname,
    drivers: [new DummyDriver({ delayMs: 0 })],
    browser: stubBrowser(),
    watchers: null,
    log: (m) => logs.push(m),
    pluginDirs: [
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
    ],
  });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  await client.updateSettings({ defaultDriver: "dummy" });
  return { h: harness, client, home, logs };
}

const git = async (cwd: string, ...args: string[]) => {
  const r = await execFile("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("manifest + path helpers", () => {
  test("parseManifest validates ids, tabs and when", () => {
    const m = parseManifest({ id: "git", name: "Git", version: "1.0.0", description: "d", ui: "dist/", tabs: [{ id: "changes", title: "Changes", when: "workdir" }] });
    expect(m.tabs[0]).toEqual({ id: "changes", title: "Changes", icon: undefined, when: "workdir" });
    expect(parseManifest({ id: "x", ui: "d", tabs: [{ id: "t", title: "T" }] }).tabs[0]!.when).toBe("always");
    expect(() => parseManifest({ id: "Bad Id" })).toThrow(/id/);
    expect(() => parseManifest({ id: "x", tabs: [{ id: "t", title: "T" }] })).toThrow(/ui/);
    expect(() => parseManifest({ id: "x", ui: "d", tabs: [{ id: "t", title: "T", when: "sometimes" }] })).toThrow(/when/);
    expect(() => parseManifest({ id: "x", ui: "d", tabs: [{ id: "t", title: "T" }, { id: "t", title: "U" }] })).toThrow(/duplicate/);
    expect(() => parseManifest({ id: "x", ui: "d", tabs: [{ id: "t" }] })).toThrow(/title/);
  });

  test("safeJoin refuses traversal, absolute paths, NUL and symlinks that escape", () => {
    const root = join(tempHome("harness-safejoin-"), "ui");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "a.js"), "");
    writeFileSync(join(root, "..", "secret.txt"), "s");
    symlinkSync(join(root, "..", "secret.txt"), join(root, "link.txt"));
    expect(safeJoin(root, "sub/a.js")).toBe(join(root, "sub", "a.js"));
    expect(safeJoin(root, "sub//a.js")).toBe(join(root, "sub", "a.js"));
    expect(safeJoin(root, "../secret.txt")).toBeNull();
    expect(safeJoin(root, "sub/../../secret.txt")).toBeNull();
    expect(safeJoin(root, "sub\\..\\..\\secret.txt")).toBeNull();
    expect(safeJoin(root, "a\0b")).toBeNull();
    expect(safeJoin(root, "link.txt")).toBeNull();
    // A leading slash is treated as relative to the root, never the filesystem root.
    expect(safeJoin(root, "/etc/passwd")).toBe(join(root, "etc", "passwd"));
  });

  test("execFile: exit codes, env, stdin, truncation, timeout, missing binary", async () => {
    expect(await execFile("sh", ["-c", "echo $FOO; exit 3"], { env: { FOO: "bar" } })).toMatchObject({ code: 3, stdout: "bar\n", truncated: false });
    expect((await execFile("cat", [], { stdin: "piped" })).stdout).toBe("piped");
    const big = await execFile("sh", ["-c", "yes x | head -c 100000"], { maxBytes: 1000 });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBe(1000);
    const slow = await execFile("sleep", ["5"], { timeoutMs: 50 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).not.toBe(0);
    expect((await execFile("definitely-not-a-binary-xyz", [])).code).toBe(-1);
  });
});

describe("plugin host over HTTP", () => {
  test("discovery: builtin + user dirs, user overrides builtin with the same id, bad plugins are isolated", async () => {
    const { h, client, logs } = await boot((builtin, user) => {
      writePlugin(builtin, "alpha", { id: "alpha", name: "Alpha", version: "1.0.0", description: "a", server: "server.js" }, { "server.js": echoServer("builtin-alpha") });
      writePlugin(builtin, "beta", { id: "beta", name: "Beta builtin", version: "1.0.0", description: "", server: "server.js" }, { "server.js": echoServer("builtin-beta") });
      writePlugin(user, "beta-fork", { id: "beta", name: "Beta user", version: "2.0.0", description: "", server: "server.js" }, { "server.js": echoServer("user-beta") });
      writePlugin(user, "broken-json", "{ nope");
      writePlugin(user, "throws", { id: "throws", server: "server.js", ui: "ui", tabs: [{ id: "t", title: "T" }] }, { "server.js": `throw new Error("import exploded");`, "ui/index.html": "x" });
      writePlugin(user, "nodefault", { id: "nodefault", server: "server.js" }, { "server.js": `export const x = 1;` });
      writePlugin(user, "missing", { id: "missing", server: "nope.js" });
      writePlugin(user, "routes-throw", { id: "routes-throw", server: "server.js" }, { "server.js": `export default { routes() { throw new Error("bad routes"); } };` });
      mkdirSync(join(user, "not-a-plugin")); // no plugin.json → skipped
      writeFileSync(join(user, "stray-file"), "");
    });
    const list = await client.listPlugins();
    const byId = Object.fromEntries(list.map((p) => [p.id, p])) as Record<string, PluginInfo>;
    expect(Object.keys(byId).sort()).toEqual(["alpha", "beta", "broken-json", "missing", "nodefault", "routes-throw", "throws"]);
    expect(byId.alpha).toMatchObject({ name: "Alpha", source: "builtin", hasServer: true, error: null });
    expect(byId.beta).toMatchObject({ name: "Beta user", version: "2.0.0", source: "user", error: null });
    expect(byId["broken-json"]!.error).toMatch(/JSON|Unexpected|parse/i);
    expect(byId.throws!.error).toContain("import exploded");
    expect(byId.nodefault!.error).toMatch(/default-export/);
    expect(byId.missing!.error).toMatch(/not found/);
    expect(byId["routes-throw"]!.error).toContain("bad routes");
    expect(logs.some((l) => l.includes("throws failed to load"))).toBe(true);

    // The healthy plugins still serve; the override wins; broken ones answer 503.
    expect(await client.request<any>("GET", "/plugins/beta/api/hello?name=x")).toEqual({ tag: "user-beta", name: "x", id: "beta" });
    expect(await client.request<any>("GET", "/plugins/alpha/api/hello")).toMatchObject({ tag: "builtin-alpha" });
    await expect(client.request<any>("GET", "/plugins/throws/api/hello")).rejects.toMatchObject({ status: 503 });
    await expect(client.request<any>("GET", "/plugins/ghost/api/hello")).rejects.toMatchObject({ status: 404 });
    // …and the rest of the service is untouched.
    expect((await client.health()).ok).toBe(true);
    // Tabs from a failed plugin are never offered.
    const project = await client.createProject({ path: h.paths.home, key: "P" });
    const t = await client.createTicket({ projectId: project.id, prompt: "hi", start: false });
    expect(await client.ticketTabs(t.key)).toEqual([]);
  });

  test("routes: auth required, params, query, JSON bodies, errors, raw responses, 404/405", async () => {
    const { h, client } = await boot((builtin) => {
      writePlugin(builtin, "alpha", { id: "alpha", server: "server.js" }, { "server.js": echoServer("a") });
    });
    const noAuth = await fetch(`${h.url}/plugins/alpha/api/hello`);
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(`${h.url}/plugins/alpha/api/hello`, { headers: { authorization: "Bearer nope" } });
    expect(badAuth.status).toBe(401);
    expect(await client.request<any>("GET", "/plugins/alpha/api/items/a%20b")).toEqual({ itemId: "a b" });
    expect(await client.request<any>("POST", "/plugins/alpha/api/echo", { n: 1 })).toEqual({ got: { n: 1 } });
    expect(await client.request<any>("GET", "/plugins/alpha/api/hello/")).toMatchObject({ tag: "a" });
    await expect(client.request<any>("GET", "/plugins/alpha/api/teapot")).rejects.toMatchObject({ status: 418, message: "short and stout" });
    await expect(client.request<any>("GET", "/plugins/alpha/api/boom")).rejects.toMatchObject({ status: 500, message: "kaboom" });
    await expect(client.request<any>("GET", "/plugins/alpha/api/nope")).rejects.toMatchObject({ status: 404 });
    await expect(client.request<any>("DELETE", "/plugins/alpha/api/hello")).rejects.toMatchObject({ status: 405 });
    const bad = await fetch(`${h.url}/plugins/alpha/api/echo`, { method: "POST", headers: { authorization: `Bearer ${h.token}` }, body: "{nope" });
    expect(bad.status).toBe(400);
    const raw = await fetch(`${h.url}/plugins/alpha/api/raw`, { headers: { authorization: `Bearer ${h.token}` } });
    expect(await raw.text()).toBe("plain");
    // CORS still applies to plugin routes (renderer is file://).
    const cors = await fetch(`${h.url}/plugins/alpha/api/hello`, { headers: { authorization: `Bearer ${h.token}`, origin: "file://" } });
    expect(cors.headers.get("access-control-allow-origin")).toBe("file://");
  });

  test("context: getTicket / ticketWorkdir, and onTicketEvent sees ticket changes", async () => {
    const { h, client } = await boot((builtin) => {
      writePlugin(builtin, "alpha", { id: "alpha", server: "server.js" }, { "server.js": echoServer("a") });
    });
    (globalThis as { __pluginEvents?: string[] }).__pluginEvents = [];
    const dir = join(h.paths.home, "proj");
    mkdirSync(dir);
    const project = await client.createProject({ path: dir, key: "CTX" });
    const t = await client.createTicket({ projectId: project.id, prompt: "hi", start: false });
    expect(await client.request<any>("GET", `/plugins/alpha/api/ticket?key=${t.key}`)).toEqual({ key: t.key, project: "CTX", workdir: null });
    h.store.tickets.update(t.id, { workdir: dir });
    expect(await client.request<any>("GET", `/plugins/alpha/api/ticket?key=${t.key}`)).toEqual({ key: t.key, project: "CTX", workdir: dir });
    h.store.tickets.update(t.id, { workdir: join(dir, "gone") });
    expect(await client.request<any>("GET", `/plugins/alpha/api/ticket?key=${t.key}`)).toMatchObject({ workdir: null });
    expect(await client.request<any>("GET", `/plugins/alpha/api/ticket?key=NOPE-1`)).toBeNull();
    await client.deleteTicket(t.key);
    const events = await client.request<string[]>("GET", "/plugins/alpha/api/events");
    expect(events).toContain(`ticket.upserted:${t.key}`);
    expect(events).toContain(`ticket.deleted:${t.id}`);
  });

  test("a throwing onTicketEvent is logged and does not break the service", async () => {
    const { client, logs, h } = await boot((builtin) => {
      writePlugin(builtin, "angry", { id: "angry", server: "server.js" }, { "server.js": `export default { onTicketEvent() { throw new Error("nope"); } };` });
      writePlugin(builtin, "angry-async", { id: "angry-async", server: "server.js" }, { "server.js": `export default { async onTicketEvent() { throw new Error("async nope"); } };` });
    });
    const project = await client.createProject({ path: h.paths.home, key: "ANG" });
    const t = await client.createTicket({ projectId: project.id, prompt: "hi", start: false });
    expect(t.key).toBe("ANG-1");
    await Bun.sleep(10);
    expect(logs.some((l) => l.includes("[plugin:angry] onTicketEvent failed"))).toBe(true);
    expect(logs.some((l) => l.includes("async nope"))).toBe(true);
  });

  test("static UI: served without auth, index.html default, content types, traversal refused", async () => {
    const { h } = await boot((builtin) => {
      const p = writePlugin(builtin, "viewer", { id: "viewer", ui: "dist", tabs: [{ id: "main", title: "Main" }] }, {
        "dist/index.html": "<!doctype html><p>hi</p>",
        "dist/assets/app.js": "console.log(1)",
        "secret.txt": "top secret",
      });
      symlinkSync(join(p, "secret.txt"), join(p, "dist", "leak.txt"));
    });
    const get = (path: string) => fetch(h.url + path, { redirect: "manual" });
    const index = await get("/plugins/viewer/ui/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<p>hi</p>");
    expect((await get("/plugins/viewer/ui/index.html?tab=main")).status).toBe(200);
    const js = await get("/plugins/viewer/ui/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    const redirect = await get("/plugins/viewer/ui?tab=main");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/plugins/viewer/ui/?tab=main");
    for (const evil of ["/plugins/viewer/ui/..%2fsecret.txt", "/plugins/viewer/ui/assets%2f..%2f..%2fsecret.txt", "/plugins/viewer/ui/%2e%2e/secret.txt", "/plugins/viewer/ui/leak.txt", "/plugins/viewer/ui/..%5csecret.txt"]) {
      const r = await get(evil);
      // %2e%2e is normalized by the URL parser to a path outside /ui/, which then needs auth (401).
      expect([401, 403, 404]).toContain(r.status);
      expect(await r.text()).not.toContain("top secret");
    }
    expect((await get("/plugins/viewer/ui/missing.js")).status).toBe(404);
    expect((await get("/plugins/viewer/ui/assets")).status).toBe(404); // a directory
    expect((await get("/plugins/ghost/ui/")).status).toBe(404);
    expect((await fetch(h.url + "/plugins/viewer/ui/", { method: "POST" })).status).toBe(405);
    // The API side of the same plugin still needs the token.
    expect((await get("/plugins/viewer/api/x")).status).toBe(401);
  });

  // A phone reaches the service over the LAN or Tailscale, never loopback. Bun streams a file
  // body there without its status line or headers, so this only fails off loopback.
  const lanIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  test.skipIf(!lanIp)("static UI: a well-formed HTTP response on a non-loopback address", async () => {
    const { h } = await boot(
      (builtin) => writePlugin(builtin, "viewer", { id: "viewer", ui: "dist", tabs: [{ id: "main", title: "Main" }] }, { "dist/index.html": "<!doctype html><p>hi</p>" }),
      { hostname: lanIp },
    );
    const status = await h.network.status();
    const bound = status.bound.find((b) => b.address === lanIp);
    expect(bound).toBeDefined();
    const res = await fetch(`${bound!.url}/plugins/viewer/ui/index.html?tab=main`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<!doctype html><p>hi</p>");
  });

  test("build: a missing or stale UI is built on load; UI requests wait for the build; failures surface", async () => {
    const buildScript = `
      import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
      await Bun.sleep(150);
      mkdirSync("dist", { recursive: true });
      writeFileSync("dist/index.html", "built from " + readFileSync("src.txt", "utf8"));`;
    let builtin = "";
    const { h, logs } = await boot((b) => {
      builtin = b;
      writePlugin(b, "builder", { id: "builder", ui: "dist", build: "build.ts", tabs: [{ id: "t", title: "T" }] }, { "build.ts": buildScript, "src.txt": "v1" });
      writePlugin(b, "fresh", { id: "fresh", ui: "dist", build: "build.ts" }, { "build.ts": "process.exit(9)", "dist/index.html": "prebuilt" });
      writePlugin(b, "failing", { id: "failing", ui: "dist", build: "build.ts" }, { "build.ts": "console.error('syntax oops'); process.exit(2)" });
    });
    // Load did not block on the build; the UI request waits for it.
    const res = await fetch(`${h.url}/plugins/builder/ui/`);
    expect(await res.text()).toBe("built from v1");
    expect((await fetch(`${h.url}/plugins/fresh/ui/`).then((r) => r.text()))).toBe("prebuilt"); // up to date: build not run
    await h.plugins.ready();
    const list = await new HarnessClient({ baseUrl: h.url, token: h.token }).listPlugins();
    expect(list.find((p) => p.id === "failing")!.error).toContain("syntax oops");
    expect(list.find((p) => p.id === "fresh")!.error).toBeNull();
    expect(logs.some((l) => l.includes("built builder UI"))).toBe(true);
    // needsBuild: sources newer than the bundle trigger a rebuild; tests and node_modules don't.
    const { needsBuild } = await import("./host");
    const dir = join(builtin, "builder");
    expect(needsBuild(dir, join(dir, "dist"))).toBe(false);
    const future = new Date(Date.now() + 5000);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x.js"), "");
    writeFileSync(join(dir, "a.test.ts"), "");
    const { utimesSync } = await import("node:fs");
    utimesSync(join(dir, "node_modules", "x.js"), future, future);
    utimesSync(join(dir, "a.test.ts"), future, future);
    expect(needsBuild(dir, join(dir, "dist"))).toBe(false);
    utimesSync(join(dir, "src.txt"), future, future);
    expect(needsBuild(dir, join(dir, "dist"))).toBe(true);
  });

  test("ticket tabs: when = always | workdir | worktree, evaluated per ticket", async () => {
    const { h, client } = await boot((builtin, user) => {
      writePlugin(builtin, "tabs", {
        id: "tabs",
        ui: "dist",
        tabs: [
          { id: "every", title: "Every", icon: "zap" },
          { id: "repo", title: "Repo", when: "workdir" },
          { id: "tree", title: "Tree", when: "worktree" },
        ],
      }, { "dist/index.html": "" });
      writePlugin(user, "another", { id: "another", ui: "ui", tabs: [{ id: "x", title: "X" }] }, { "ui/index.html": "" });
    });
    const ids = (tabs: PluginTab[]) => tabs.map((t) => `${t.pluginId}:${t.id}`);
    const plain = join(h.paths.home, "plain");
    const repo = join(h.paths.home, "repo");
    mkdirSync(plain);
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "init");

    const project = await client.createProject({ path: repo, key: "TAB" });
    const t = await client.createTicket({ projectId: project.id, prompt: "hi", start: false });
    const tabs = await client.ticketTabs(t.key);
    expect(tabs[0]).toEqual({ pluginId: "another", id: "x", title: "X", icon: null, when: "always" });
    expect(ids(tabs)).toEqual(["another:x", "tabs:every"]); // no workdir yet

    h.store.tickets.update(t.id, { workdir: plain });
    expect(ids(await client.ticketTabs(t.key))).toEqual(["another:x", "tabs:every"]); // not a git repo

    h.store.tickets.update(t.id, { workdir: repo });
    expect(ids(await client.ticketTabs(t.key))).toEqual(["another:x", "tabs:every", "tabs:repo"]);

    const wt = join(h.paths.worktreesDir, t.key);
    await git(repo, "worktree", "add", "-q", wt, "-b", "harness/tab-1");
    h.store.tickets.update(t.id, { workdir: wt, branch: "harness/tab-1" });
    expect(ids(await client.ticketTabs(t.key))).toEqual(["another:x", "tabs:every", "tabs:repo", "tabs:tree"]);

    h.store.tickets.update(t.id, { workdir: join(h.paths.home, "deleted-worktree") });
    expect(ids(await client.ticketTabs(t.key))).toEqual(["another:x", "tabs:every"]);

    await expect(client.ticketTabs("NOPE-9")).rejects.toMatchObject({ status: 404 });
    await expect(client.request<any>("GET", `/tickets/${t.key}/tabs`, undefined)).resolves.toBeArray();
    const unauth = await fetch(`${h.url}/tickets/${t.key}/tabs`);
    expect(unauth.status).toBe(401);
  });

  test("showTab keeps a tab whose `when` fails; it isn't asked when `when` holds, and a throw hides the tab", async () => {
    const { h, client, logs } = await boot((builtin) => {
      writePlugin(builtin, "keep", { id: "keep", ui: "dist", server: "server.js", tabs: [{ id: "kept", title: "Kept", when: "workdir" }, { id: "dropped", title: "Dropped", when: "worktree" }, { id: "boom", title: "Boom", when: "worktree" }] }, {
        "dist/index.html": "",
        "server.js": `export default {
          showTab(tab, ctx) {
            (globalThis.__showTab ??= []).push(tab.id + ":" + tab.ticket.key + ":" + (tab.project?.key ?? "none") + ":" + ctx.id);
            if (tab.id === "boom") throw new Error("showTab exploded");
            return tab.id === "kept" && tab.ticket.title.includes("keep");
          },
        };`,
      });
    });
    const asked = () => ((globalThis as { __showTab?: string[] }).__showTab ??= []);
    asked().length = 0;
    const repo = join(h.paths.home, "repo");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    const project = await client.createProject({ path: repo, key: "KEEP" });
    const t = await client.createTicket({ projectId: project.id, prompt: "please keep this", start: false });
    const ids = (tabs: PluginTab[]) => tabs.map((x) => x.id);

    // No workdir: `when` fails for every tab, showTab decides.
    expect(ids(await client.ticketTabs(t.key))).toEqual(["kept"]);
    expect(asked()).toEqual([`kept:${t.key}:KEEP:keep`, `dropped:${t.key}:KEEP:keep`, `boom:${t.key}:KEEP:keep`]);
    expect(logs.some((l) => l.includes("[plugin:keep] showTab failed") && l.includes("showTab exploded"))).toBe(true);

    // `when: workdir` holds: the tab shows without asking the plugin.
    asked().length = 0;
    h.store.tickets.update(t.id, { workdir: repo });
    expect(ids(await client.ticketTabs(t.key))).toEqual(["kept"]);
    expect(asked()).toEqual([`dropped:${t.key}:KEEP:keep`, `boom:${t.key}:KEEP:keep`]);

    // A false answer hides it.
    const other = await client.createTicket({ projectId: project.id, prompt: "nothing special", start: false });
    expect(ids(await client.ticketTabs(other.key))).toEqual([]);
  });

  test("the repo's built-in plugins load cleanly by default", async () => {
    const home = tempHome("harness-plugins-default-");
    harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    const git = (await client.listPlugins()).find((p) => p.id === "git");
    expect(git).toMatchObject({ source: "builtin", hasServer: true, hasUi: true, error: null });
    expect(git!.tabs).toEqual([{ pluginId: "git", id: "changes", title: "Changes", icon: "branch", when: "workdir" }]);
  });
});
