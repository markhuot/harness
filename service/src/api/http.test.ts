import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type HarnessEvent } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { FakeDriver, stubBrowser, tempHome } from "../testing/fakes";

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot() {
  const home = tempHome("harness-e2e-");
  const fake = new FakeDriver("fake");
  const browser = stubBrowser();
  harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 }), fake], browser, watchers: null, log: () => {} });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  await client.updateSettings({ defaultDriver: "dummy" });
  const dir = join(home, "work", "nytimes");
  mkdirSync(dir, { recursive: true });
  return { h: harness, client, fake, browser, dir, home };
}

function collect(client: HarnessClient) {
  const events: HarnessEvent[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));
  const socket = client.connect({ onEvent: (e) => events.push(e), onStatus: (up) => up && connected() });
  return { events, socket, ready };
}

async function until(fn: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("http api", () => {
  test("auth: /health is public, everything else needs the bearer token; token file is 0600", async () => {
    const { h, client } = await boot();
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(process.pid);
    const noAuth = await fetch(`${h.url}/projects`);
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ error: "Unauthorized" });
    const bad = new HarnessClient({ baseUrl: h.url, token: "x".repeat(64) });
    await expect(bad.listProjects()).rejects.toMatchObject({ status: 401 });
    const ws = await fetch(`${h.url}/ws?token=nope`);
    expect(ws.status).toBe(401);
    expect(statSync(h.paths.tokenPath).mode & 0o777).toBe(0o600);
    await expect(client.request("GET", "/nope")).rejects.toMatchObject({ status: 404 });
    await expect(client.request("PUT", "/projects")).rejects.toMatchObject({ status: 405 });
  });

  test("errors map to status codes", async () => {
    const { client, dir } = await boot();
    await expect(client.getTicket("NOPE-1")).rejects.toMatchObject({ status: 404 });
    await expect(client.createProject({ path: join(dir, "missing") })).rejects.toMatchObject({ status: 400 });
    const p = await client.createProject({ path: dir });
    await client.createTicket({ projectId: p.id, prompt: "x", key: "EXT-1", start: false });
    const dup = await client.createTicket({ projectId: p.id, prompt: "x", key: "EXT-1" }).catch((e) => e);
    expect(dup).toBeInstanceOf(HarnessApiError);
    expect(dup.status).toBe(409);
    await expect(client.request("POST", "/tickets", "not json" as any)).rejects.toMatchObject({ status: 400 });
    await expect(client.humanReview("EXT-1", { decision: "maybe" as any })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateSettings({ maxConcurrentRuns: 0 })).rejects.toMatchObject({ status: 400 });
  });

  test("full lifecycle over REST with live WS events (ticket.upserted + transcript.delta)", async () => {
    const { client, dir, h } = await boot();
    const { events, socket, ready } = collect(client);
    await ready;
    try {
      const p = await client.createProject({ path: dir });
      expect(p.key).toBe("NYTIMES");
      const p2 = await client.createProject({ path: dir, name: "again" });
      expect(p2.key).toBe("NYTIMES2");

      const t = await client.createTicket({ projectId: p.id, prompt: "Make the header blue" });
      expect(t.key).toBe("NYTIMES-1");
      expect(t.status).toBe("in_progress");
      await h.orchestrator.idle();

      await until(() => events.some((e) => e.kind === "ticket.upserted" && e.ticket.key === t.key && e.ticket.status === "review" && !e.ticket.busy));
      expect(events.some((e) => e.kind === "project.upserted")).toBe(true);
      const deltas = events.filter((e) => e.kind === "transcript.delta" && e.sessionId === t.sessionId);
      expect(deltas.length).toBeGreaterThan(3);
      expect(deltas.map((d) => (d as any).text).join("")).toContain("Hello from the dummy driver!");
      expect(events.some((e) => e.kind === "transcript.appended" && e.entry.sessionId === t.sessionId)).toBe(true);

      let detail = await client.getTicket(t.key);
      expect(detail.ticket.status).toBe("review");
      expect(detail.ticket.agentReview).toBe("approved");
      expect(detail.runs.map((r) => r.kind)).toEqual(["work", "review"]);
      expect(detail.session.key).toBe("NYTIMES-1");

      const transcript = await client.transcript(t.sessionId);
      const seqs = transcript.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(transcript.some((e) => e.content.type === "tool_call" && e.content.name === "submit_for_review")).toBe(true);
      const tail = await client.transcript(t.sessionId, seqs.at(-3)!);
      expect(tail.map((e) => e.seq)).toEqual(seqs.slice(-2));

      await client.humanReview(t.key, { decision: "approve" });
      await client.completeTicket(t.key);
      await h.orchestrator.idle();
      detail = await client.getTicket(t.key);
      expect(detail.ticket.status).toBe("done");
      expect((await client.listSummaries(t.key)).some((s) => s.body === "Completed.")).toBe(true);

      const sessions = await client.listSessions("ticket");
      expect(sessions.map((s) => s.key)).toContain("NYTIMES-1");
      expect(await client.listTickets(p2.id)).toEqual([]);
      expect((await client.listTickets(p.id)).map((x) => x.key)).toEqual(["NYTIMES-1"]);
    } finally {
      socket.close();
    }
  });

  test("block, reply, cancel and patch over REST", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "please /block Which color?" });
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.blockedReason).toBe("Which color?");
    const replied = await client.sendMessage(t.key, "blue");
    expect(replied.status).toBe("in_progress");
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("review");

    const f = await client.createTicket({ projectId: p.id, prompt: "long /hold", driver: "fake" });
    await Bun.sleep(10);
    const cancelled = await client.cancelTicket(f.key);
    expect(cancelled.busy).toBe(false);
    expect((await client.getTicket(f.key)).runs.map((r) => r.status)).toEqual(["cancelled"]);

    const patched = await client.updateTicket(f.key, { title: "Renamed", position: 42 });
    expect([patched.title, patched.position]).toEqual(["Renamed", 42]);
    const rerun = await client.request<any>("POST", `/tickets/${t.key}/agent-review`);
    expect(rerun.key).toBe(t.key);
    await h.orchestrator.idle();
    await client.deleteTicket(f.key);
    await expect(client.getTicket(f.key)).rejects.toMatchObject({ status: 404 });
  });

  test("triage via /watchers/inject dispatches with the external key; mappings CRUD", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir });
    const m = await client.createMapping({ pattern: "FOO", projectId: p.id, notes: "foo team" });
    expect((await client.listMappings()).map((x) => x.id)).toEqual([m.id]);
    const s = await client.injectWorkItem("jira", { key: "FOO-7", summary: "Fix search", url: "https://jira/FOO-7", updated: "t1" });
    expect(s!.key).toBe("TRIAGE-1");
    await h.orchestrator.idle();
    const triaged = await client.getSession(s!.id);
    expect(triaged.triageStatus).toBe("dispatched");
    const ticket = (await client.getTicket("FOO-7")).ticket;
    expect(ticket.projectId).toBe(p.id);
    expect(ticket.externalRef?.source).toBe("jira");
    expect(await client.injectWorkItem("jira", { key: "FOO-7", summary: "Fix search", updated: "t1" })).toBeNull();
    expect((await client.listSessions("triage")).length).toBe(1);

    const declined = await client.injectWorkItem("jira", { key: "ZED-1", summary: "nobody's" });
    await h.orchestrator.idle();
    expect((await client.getSession(declined!.id)).triageStatus).toBe("declined");
    await client.deleteMapping(m.id);
    expect(await client.listMappings()).toEqual([]);
  });

  test("watchers CRUD without starting processes", async () => {
    const { client } = await boot();
    const w = await client.createWatcher({ name: "jira", command: "node", args: ["watch.js"], enabled: false });
    expect(w.mode).toBe("loop");
    const u = await client.updateWatcher(w.id, { mode: "interval", intervalSec: 60 });
    expect([u.mode, u.intervalSec]).toEqual(["interval", 60]);
    await expect(client.createWatcher({ name: "", command: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(client.runWatcher(w.id)).rejects.toMatchObject({ status: 400 }); // watchers disabled in this harness
    await client.deleteWatcher(w.id);
    expect(await client.listWatchers()).toEqual([]);
  });

  test("settings never expose the API key; PATCH merges", async () => {
    const { client, h } = await boot();
    const before = await client.getSettings();
    expect(before).toMatchObject({ defaultDriver: "dummy", maxConcurrentRuns: 4, claudePermissionMode: "acceptEdits", anthropicModel: "claude-sonnet-5", anthropicApiKeySet: false });
    const after = await client.updateSettings({ anthropicApiKey: "sk-secret", maxConcurrentRuns: 2 });
    expect(after.anthropicApiKeySet).toBe(true);
    expect(JSON.stringify(after)).not.toContain("sk-secret");
    expect(JSON.stringify(await client.getSettings())).not.toContain("sk-secret");
    expect(after.defaultDriver).toBe("dummy");
    expect(h.orchestrator.settings().anthropicApiKey).toBe("sk-secret");
    await expect(client.updateSettings({ defaultDriver: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  test("drivers list and login", async () => {
    const { client } = await boot();
    const drivers = await client.listDrivers();
    expect(drivers.map((d) => d.id).sort()).toEqual(["dummy", "fake"]);
    await expect(client.loginDriver("fake")).rejects.toMatchObject({ status: 400 });
    await expect(client.loginDriver("missing")).rejects.toMatchObject({ status: 404 });
  });

  test("MCP endpoint serves the run's tools only while the run is active", async () => {
    const { client, dir, h, fake } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "x /hold", driver: "fake" });
    await until(() => fake.calls.length === 1);
    const mcpUrl = fake.calls[0]!.mcpUrl;
    expect(mcpUrl.startsWith(`${h.url}/mcp/`)).toBe(true);
    const rpc = (body: unknown) => fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    const list = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    const names = list.result.tools.map((x: any) => x.name);
    expect(names).toContain("submit_for_review");
    expect(names).not.toContain("review_decision");
    // Calling a tool over MCP drives the orchestrator
    const call = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "post_summary", arguments: { summary: "via mcp" } } })).json();
    expect(call.result.isError).toBe(false);
    expect((await client.listSummaries(t.key)).map((s) => s.body)).toContain("via mcp");
    fake.release();
    await h.orchestrator.idle();
    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(404);
  });

  test("browser frames go only to subscribed sockets; input is forwarded; unsubscribe on close", async () => {
    const { client, dir, browser } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "x", start: false, driver: "fake" });
    const a = collect(client);
    const b = collect(client);
    await Promise.all([a.ready, b.ready]);
    a.socket.subscribeBrowser(t.sessionId);
    await until(() => [...browser.subs.keys()].some((k) => k.startsWith(t.sessionId + "|")));
    const sub = [...browser.subs.entries()].find(([k]) => k.startsWith(t.sessionId + "|"))![1];
    sub.onFrame({ sessionId: t.sessionId, data: "AAAA", width: 10, height: 20 });
    await until(() => a.events.some((e) => e.kind === "browser.frame"));
    const frame = a.events.find((e) => e.kind === "browser.frame") as any;
    expect([frame.sessionId, frame.data, frame.width, frame.height]).toEqual([t.sessionId, "AAAA", 10, 20]);

    const inputs: unknown[] = [];
    browser.input = async (sid, input) => void inputs.push([sid, input]);
    a.socket.send({ type: "browser.input", sessionId: t.sessionId, input: { type: "reload" } });
    await until(() => inputs.length === 1);
    expect(inputs[0]).toEqual([t.sessionId, { type: "reload" }]);

    const state = await client.browserNavigate(t.sessionId, "https://example.com");
    expect(state.url).toBe("https://example.com");
    expect((await client.browserState(t.sessionId))!.url).toBe("https://example.com");
    await until(() => a.events.some((e) => e.kind === "browser.state"));
    await Bun.sleep(20);
    expect(b.events.some((e) => e.kind === "browser.frame" || e.kind === "browser.state")).toBe(false);

    a.socket.close();
    b.socket.close();
    await until(() => browser.subs.size === 0);
  });

  test("conductor with the real dummy driver + tools drives its children to done", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir, requireHumanReview: true });
    const c = await client.createTicket({ projectId: p.id, prompt: "Ship it\n- Build the API\n- Build the UI", kind: "conductor" });
    await h.orchestrator.idle(30_000);
    const d = await client.getTicket(c.key);
    expect(d.children.map((x) => [x.title, x.status])).toEqual([
      ["Build the API", "done"],
      ["Build the UI", "done"],
    ]);
    expect(d.ticket.status).toBe("review");
    expect(d.ticket.agentReview).toBe("approved");
  }, 40_000);

  test("CORS: preflight 204 on any route; ACAO echoed only for file://, null and localhost origins", async () => {
    const { h } = await boot();
    for (const origin of ["null", "file://", "http://localhost:5173", "https://127.0.0.1:9"]) {
      const pre = await fetch(`${h.url}/tickets/FOO-1/approval`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(origin);
      expect(pre.headers.get("access-control-allow-methods")).toBe("GET,POST,PATCH,DELETE,OPTIONS");
      expect(pre.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    }
    const evil = await fetch(`${h.url}/projects`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(204);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const lookalike = await fetch(`${h.url}/health`, { headers: { origin: "http://localhost.evil.com" } });
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();

    const auth = { authorization: `Bearer ${h.token}` };
    const okRes = await fetch(`${h.url}/projects`, { headers: { ...auth, origin: "null" } });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("access-control-allow-origin")).toBe("null");
    const denied = await fetch(`${h.url}/projects`, { headers: { origin: "file://" } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("file://");
    expect((await fetch(`${h.url}/health`)).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("POST /tickets/:key/approval answers a pending approval; 409 without one", async () => {
    const { client, dir, h, fake } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: 'x /tool Bash {"command":"npm test"}', driver: "fake" });
    await h.orchestrator.idle();
    const blocked = (await client.getTicket(t.key)).ticket;
    expect(blocked.pendingApproval?.toolName).toBe("Bash");
    const res = await client.answerApproval(t.key, { decision: "allow_tool" });
    expect([res.status, res.pendingApproval, res.allowedTools]).toEqual(["in_progress", null, ["Bash"]]);
    await h.orchestrator.idle();
    expect(fake.approvals.map((a) => a.behavior)).toEqual(["deny", "allow"]);
    await expect(client.answerApproval(t.key, { decision: "deny" })).rejects.toMatchObject({ status: 409 });
    await expect(client.request("POST", `/tickets/${t.key}/approval`, { decision: "maybe" })).rejects.toMatchObject({ status: 409 });
  });
});
