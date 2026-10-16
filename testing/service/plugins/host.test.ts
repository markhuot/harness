import { afterEach, beforeEach, expect, test } from "bun:test";
import { assertNoTimerLeaks, trackTimers } from "../leaks";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@harness/shared";
import { EventBus } from "../../../service/src/events";
import { needsBuild, parseManifest, PluginHost, type PluginDir } from "../../../service/src/plugins/host";
import { tempDir } from "../../builders/tmp";
import { makeTicket } from "../../builders/ticket";
import { writeFile } from "../files";

beforeEach(trackTimers);
afterEach(assertNoTimerLeaks);

const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

const bad = (raw: unknown, match: RegExp) => expect(() => parseManifest(raw)).toThrow(match);

test("a manifest needs an id of lower-case letters, digits, _ and -, and fills in the rest", () => {
  expect(parseManifest({ id: "hello" })).toEqual({ id: "hello", name: "hello", version: "0.0.0", description: "", server: undefined, ui: undefined, build: undefined, tabs: [] });
  bad(null, /must be an object/);
  bad({}, /"id" must be a non-empty string/);
  bad({ id: "Has Caps" }, /id "Has Caps" must match/);
  bad({ id: "x", name: 5 }, /"name" must be a string/);
});

test("tabs are validated one by one: id, title, when and icon, with no duplicates, and they need a ui", () => {
  const tab = (over: object = {}) => ({ id: "t", title: "T", ...over });
  expect(parseManifest({ id: "p", ui: "dist", tabs: [tab({ when: "worktree", icon: "star" })] }).tabs).toEqual([{ id: "t", title: "T", icon: "star", when: "worktree" }]);
  expect(parseManifest({ id: "p", ui: "dist", tabs: [tab()] }).tabs[0]!.when).toBe("always");
  bad({ id: "p", ui: "d", tabs: "x" }, /"tabs" must be an array/);
  bad({ id: "p", ui: "d", tabs: [5] }, /tabs\[0\] must be an object/);
  bad({ id: "p", ui: "d", tabs: [tab({ id: "Bad" })] }, /tabs\[0\]\.id must match/);
  bad({ id: "p", ui: "d", tabs: [tab(), tab()] }, /duplicate tab id "t"/);
  bad({ id: "p", ui: "d", tabs: [tab({ title: " " })] }, /title must be a non-empty string/);
  bad({ id: "p", ui: "d", tabs: [tab({ when: "never" })] }, /when must be one of always, workdir, worktree/);
  bad({ id: "p", ui: "d", tabs: [tab({ icon: 5 })] }, /icon must be a string/);
  bad({ id: "p", tabs: [tab()] }, /tabs need a "ui" directory/);
  bad({ id: "p", build: "build.ts" }, /"build" needs a "ui" directory/);
});

test("a UI needs building when its index.html is missing or older than any source file, ignoring tests, node_modules and dotfiles", () => {
  const dir = tempDir();
  const ui = join(dir, "dist");
  mkdirSync(ui);
  writeFile(dir, "src/app.ts", "x");
  expect(needsBuild(dir, ui)).toBe(true);
  writeFileSync(join(ui, "index.html"), "<html>");
  const later = new Date(Date.now() + 10_000);
  const earlier = new Date(Date.now() - 10_000);
  utimesSync(join(ui, "index.html"), later, later);
  expect(needsBuild(dir, ui)).toBe(false);
  utimesSync(join(ui, "index.html"), earlier, earlier);
  expect(needsBuild(dir, ui)).toBe(true);
  utimesSync(join(ui, "index.html"), later, later);
  writeFile(dir, "node_modules/dep/index.js", "x");
  writeFile(dir, ".cache/x.ts", "x");
  writeFile(dir, "src/app.test.ts", "x");
  writeFile(dir, "dist/other.js", "x");
  for (const p of ["node_modules/dep/index.js", ".cache/x.ts", "src/app.test.ts", "dist/other.js"]) utimesSync(join(dir, p), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  expect(needsBuild(dir, ui)).toBe(false);
  const newer = new Date(Date.now() + 120_000);
  utimesSync(join(dir, "src/app.ts"), newer, newer);
  expect(needsBuild(dir, ui)).toBe(true);
});

const project = { id: "p", key: "ACME", path: "/p" } as unknown as Project;

/** A host over `dirs`, loaded, with its log captured. */
async function host(dirs: PluginDir[], extra: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}) {
  const logs: string[] = [];
  const h = new PluginHost({ dirs, getTicket: (key) => (key === "ACME-1" ? { ticket: makeTicket({ status: "planning", key }), project } : null), log: (m) => logs.push(m), ...extra });
  hosts.push(h);
  await h.load();
  return { h, logs };
}

function plugin(root: string, id: string, manifest: object, files: Record<string, string> = {}) {
  writeFile(root, `${id}/plugin.json`, JSON.stringify({ id, ...manifest }));
  for (const [name, text] of Object.entries(files)) writeFile(root, `${id}/${name}`, text);
}

const call = (h: PluginHost, id: string, method: string, path: string, body?: unknown) => {
  const url = new URL(`http://x/plugins/${id}/api/${path}`);
  return h.handleApi(id, path, new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), url);
};

test("plugins are found in each folder, a missing folder is fine, and a later folder's plugin replaces an earlier one with the same id", async () => {
  const builtin = tempDir();
  const user = tempDir();
  plugin(builtin, "a", { name: "A builtin", version: "1" });
  plugin(builtin, "b", { name: "B" });
  plugin(user, "a", { name: "A user", version: "2" });
  const { h } = await host([{ path: builtin, source: "builtin" }, { path: join(user, "nope"), source: "user" }, { path: user, source: "user" }]);
  expect(h.list().map((p) => [p.id, p.name, p.source, p.version])).toEqual([["a", "A user", "user", "2"], ["b", "B", "builtin", "0.0.0"]]);
});

test("a plugin with a broken manifest is listed with its error and the others still load", async () => {
  const root = tempDir();
  plugin(root, "good", {});
  writeFile(root, "broken/plugin.json", "{nope");
  writeFile(root, "badid/plugin.json", JSON.stringify({ id: "Bad Id" }));
  writeFile(root, "noplugin/readme.md", "x");
  const { h, logs } = await host([{ path: root, source: "user" }]);
  expect(h.list().map((p) => [p.id, !!p.error])).toEqual([["badid", true], ["broken", true], ["good", false]]);
  expect(h.list().find((p) => p.id === "badid")!.error).toMatch(/must match/);
  expect(logs.some((l) => l.includes("[plugins] good") || l.includes("loaded good"))).toBe(true);
});

test("a plugin's server routes answer under /api with params, query and a JSON body, wrapped as { data }", async () => {
  const root = tempDir();
  plugin(root, "echo", { server: "server.ts" }, {
    "server.ts": `export default { routes(r) {
      r.get("/items/:id", ({ params, query }) => ({ id: params.id, q: query.get("q") }));
      r.post("/items", async ({ body }) => ({ got: await body() }));
      r.get("/nothing", () => undefined);
      r.get("/raw", () => new Response("plain", { status: 201 }));
    } };`,
  });
  const { h } = await host([{ path: root, source: "user" }]);
  expect(await (await call(h, "echo", "GET", "items/a%20b")).json()).toEqual({ data: { id: "a b", q: null } });
  const withQuery = new URL("http://x/plugins/echo/api/items/7?q=hi");
  expect(await (await h.handleApi("echo", "items/7", new Request(withQuery), withQuery)).json()).toEqual({ data: { id: "7", q: "hi" } });
  expect(await (await call(h, "echo", "POST", "items", { a: 1 })).json()).toEqual({ data: { got: { a: 1 } } });
  expect(await (await call(h, "echo", "GET", "nothing")).json()).toEqual({ data: null });
  const raw = await call(h, "echo", "GET", "raw");
  expect([raw.status, await raw.text()]).toEqual([201, "plain"]);
});

test("a route that isn't there is a 404, one with another method a 405, an unknown plugin a 404, and a broken plugin a 503", async () => {
  const root = tempDir();
  plugin(root, "echo", { server: "server.ts" }, { "server.ts": `export default { routes(r) { r.get("/only", () => 1); } };` });
  plugin(root, "failing", { server: "missing.ts" });
  const { h } = await host([{ path: root, source: "user" }]);
  expect((await call(h, "echo", "GET", "other")).status).toBe(404);
  expect((await call(h, "echo", "POST", "only")).status).toBe(405);
  expect((await call(h, "echo", "HEAD", "only")).status).toBe(200);
  expect((await call(h, "nope", "GET", "x")).status).toBe(404);
  const broken = await call(h, "failing", "GET", "x");
  expect(broken.status).toBe(503);
  expect((await broken.json()).error).toContain("server module missing.ts not found");
});

test("a handler's thrown status becomes the response status; other throws are a 500 and are logged; a bad JSON body is a 400 that isn't", async () => {
  const root = tempDir();
  plugin(root, "boom", { server: "server.ts" }, {
    "server.ts": `export default { routes(r) {
      r.get("/teapot", () => { throw Object.assign(new Error("short and stout"), { status: 418 }); });
      r.get("/crash", () => { throw new Error("kaput"); });
      r.post("/json", async ({ body }) => await body());
    } };`,
  });
  const { h, logs } = await host([{ path: root, source: "user" }]);
  const teapot = await call(h, "boom", "GET", "teapot");
  expect([teapot.status, (await teapot.json()).error]).toEqual([418, "short and stout"]);
  const crash = await call(h, "boom", "GET", "crash");
  expect(crash.status).toBe(500);
  expect(logs.some((l) => l.includes("GET /crash failed"))).toBe(true);
  const before = logs.length;
  const badJson = await call(h, "boom", "POST", "json", "{oops");
  expect([badJson.status, (await badJson.json()).error]).toEqual([400, "Invalid JSON body"]);
  expect(logs.length).toBe(before);
});

test("a plugin whose server doesn't export a definition fails to load with that said", async () => {
  const root = tempDir();
  plugin(root, "nodef", { server: "server.ts" }, { "server.ts": "export default 5;" });
  plugin(root, "throws", { server: "server.ts" }, { "server.ts": `export default { routes() { throw new Error("route setup failed"); } };` });
  const { h } = await host([{ path: root, source: "user" }]);
  expect(h.list().find((p) => p.id === "nodef")!.error).toMatch(/must default-export definePlugin/);
  expect(h.list().find((p) => p.id === "throws")!.error).toBe("route setup failed");
});

test("a plugin's UI files are served with their type, index.html for a folder, and nothing outside the UI folder", async () => {
  const root = tempDir();
  plugin(root, "ui", { ui: "dist", tabs: [{ id: "t", title: "T" }] }, { "dist/index.html": "<h1>hi</h1>", "dist/app.js": "console.log(1)", "secret.txt": "no" });
  const { h } = await host([{ path: root, source: "user" }]);
  const index = await h.serveUi("ui", "");
  expect([index.status, await index.text()]).toEqual([200, "<h1>hi</h1>"]);
  expect(index.headers.get("content-type")).toContain("text/html");
  expect(index.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await h.serveUi("ui", "app.js")).headers.get("content-type")).toContain("javascript");
  expect((await h.serveUi("ui", "../secret.txt")).status).toBe(403);
  expect((await h.serveUi("ui", "%2e%2e/secret.txt")).status).toBe(403);
  expect((await h.serveUi("ui", "%E0%A4%A")).status).toBe(400);
  expect((await h.serveUi("ui", "missing.js")).status).toBe(404);
  expect((await h.serveUi("nope", "")).status).toBe(404);
});

test("a manifest whose ui folder is outside the plugin's own is refused", async () => {
  const root = tempDir();
  plugin(root, "escape", { ui: "../elsewhere", tabs: [] });
  const { h } = await host([{ path: root, source: "user" }]);
  expect(h.list()[0]!.error).toMatch(/outside the plugin directory/);
});

test("a ticket's tabs follow each tab's when: always, a worktree that exists, a git repo; and a plugin's showTab can add one", async () => {
  const root = tempDir();
  const tabs = [{ id: "always", title: "A" }, { id: "wt", title: "W", when: "worktree" }, { id: "wd", title: "D", when: "workdir" }];
  plugin(root, "p", { ui: "dist", tabs }, { "dist/index.html": "x" });
  plugin(root, "q", { ui: "dist", server: "server.ts", tabs: [{ id: "custom", title: "C", when: "worktree" }] }, { "dist/index.html": "x", "server.ts": `export default { showTab: ({ id, ticket }) => id === "custom" && ticket.key === "ACME-1" };` });
  const { h } = await host([{ path: root, source: "user" }]);
  const plain = makeTicket({ status: "planning", key: "ACME-1" });
  expect((await h.ticketTabs(plain)).map((t) => `${t.pluginId}:${t.id}`)).toEqual(["p:always", "q:custom"]);
  const dir = tempDir();
  const withTree = makeTicket({ status: "planning", key: "ACME-2", branch: "b", workdir: dir });
  expect((await h.ticketTabs(withTree)).map((t) => `${t.pluginId}:${t.id}`)).toEqual(["p:always", "p:wt", "q:custom"]);
  expect((await h.ticketTabs(makeTicket({ status: "planning", key: "ACME-3", branch: "b", workdir: join(dir, "gone") }))).map((t) => t.id)).toEqual(["always"]);
});

test("ticket events reach each plugin that listens, and one that throws or rejects is logged without stopping the rest", async () => {
  const root = tempDir();
  const events = join(tempDir(), "events.log");
  plugin(root, "a", { server: "server.ts" }, { "server.ts": `import { appendFileSync } from "node:fs"; export default { onTicketEvent: (e) => appendFileSync(${JSON.stringify(events)}, "a:" + e.kind + "\\n") };` });
  plugin(root, "b", { server: "server.ts" }, { "server.ts": `export default { onTicketEvent: () => { throw new Error("sync fail"); } };` });
  plugin(root, "c", { server: "server.ts" }, { "server.ts": `export default { onTicketEvent: async () => { throw new Error("async fail"); } };` });
  const bus = new EventBus();
  const { logs } = await host([{ path: root, source: "user" }], { bus });
  bus.emit({ kind: "ticket.upserted", ticket: makeTicket({ status: "planning" }) });
  bus.emit({ kind: "ticket.deleted", id: "x" } as never);
  bus.emit({ kind: "project.deleted", id: "p" } as never);
  await Promise.resolve();
  await Promise.resolve();
  expect(readFileSync(events, "utf8")).toBe("a:ticket.upserted\na:ticket.deleted\n");
  expect(logs.filter((l) => l.includes("onTicketEvent failed")).length).toBeGreaterThanOrEqual(4);
});
