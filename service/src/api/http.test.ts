import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, type HarnessEvent } from "@harness/shared";
import { onTempCleanup } from "@harness/shared/testing";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { FakeDriver, stubBrowser, tempHome } from "../testing/fakes";
import { mp4, png } from "../testing/media";
import { fakeContext, fakeSession } from "../tools/fakes";
import { git as runGit } from "../orchestrator/worktree";
import { parseRange, serveFile } from "./http";

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
  onTempCleanup(() => socket.close());
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
    await expect(client.createTicket({ projectId: p.id, prompt: "x", useWorktree: "yes" as any })).rejects.toMatchObject({ status: 400 });
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

      // autoComplete is on by default: the approval itself starts the complete run.
      expect(p.autoComplete).toBe(true);
      await client.humanReview(t.key, { decision: "approve" });
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
    // A message moves nothing: a side question leaves the ticket blocked...
    const chatted = await client.sendMessage(t.key, "which colors are there?");
    expect(chatted.status).toBe("blocked");
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("blocked");
    // ...and the answer to its question lets the agent unblock it and finish the work.
    const replied = await client.sendMessage(t.key, "blue [dummy:unblock]");
    expect(replied.status).toBe("blocked");
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("review");
    // move sends a review ticket back to in progress first; the old chat flag is ignored.
    const moved = await client.request<any>("POST", `/tickets/${t.key}/messages`, { text: "darker", move: true });
    expect(moved.status).toBe("in_progress");
    await h.orchestrator.idle();
    const stays = await client.request<any>("POST", `/tickets/${t.key}/messages`, { text: "why?", chat: false });
    expect(stays.status).toBe("review");
    await h.orchestrator.idle();

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

  test("start a planned ticket over REST; 409 once it's past planning, 404 for an unknown key", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "Write the landing page", start: false });
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("planning");
    const started = await client.startTicket(t.key);
    expect(started.status).toBe("in_progress");
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("review");
    await expect(client.startTicket(t.key)).rejects.toMatchObject({ status: 409 });
    await expect(client.startTicket("NOPE-1")).rejects.toMatchObject({ status: 404 });
  });

  test("re-open a done ticket over REST: 409 before done, 400 without notes", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "x" });
    await h.orchestrator.idle();
    await expect(client.reopenTicket(t.key, { notes: "more" })).rejects.toMatchObject({ status: 409 });
    await client.completeTicket(t.key, { skipAgent: true });
    await expect(client.reopenTicket(t.key, { notes: "" })).rejects.toMatchObject({ status: 400 });
    const reopened = await client.reopenTicket(t.key, { notes: "more" });
    expect(reopened.status).toBe("in_progress");
    await h.orchestrator.idle();
    expect((await client.getTicket(t.key)).ticket.status).toBe("review");
  });

  test("triage via /watchers/inject dispatches to the prompt's project, linked to the external key", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir });
    const s = await client.injectOutput("jira", { key: "FOO-7", summary: "Fix search", url: "https://jira/FOO-7", updated: "t1" }, `Dispatch bugs to ${p.key}. [dummy:project ${p.key}]`);
    expect(s!.key).toBe("TRIAGE-1");
    await h.orchestrator.idle();
    const triaged = await client.getSession(s!.id);
    expect(triaged.triageStatus).toBe("dispatched");
    const ticket = (await client.getTicket(`${p.key}-1`)).ticket;
    expect(ticket.projectId).toBe(p.id);
    expect(ticket.externalRef).toMatchObject({ source: "jira", key: "FOO-7" });
    // The remote ID doesn't open the ticket: the 404 points to the tickets linked to it.
    const remote = await client.getTicket("foo-7").catch((e) => e);
    expect(remote).toMatchObject({ status: 404 });
    expect(remote.message).toContain("FOO-7 is a remote ID");
    expect(remote.data).toEqual({
      requested: "FOO-7",
      relatedTickets: [{ key: ticket.key, title: ticket.title, status: ticket.status, projectId: p.id, externalKey: "FOO-7" }],
    });
    // A key nothing carries is a plain 404.
    const unknown = await client.getTicket("NOPE-1").catch((e) => e);
    expect(unknown).toMatchObject({ status: 404 });
    expect(unknown.data).toBeUndefined();
    // The same text again is a duplicate, whether sent as an object or as its JSON text.
    expect(await client.injectOutput("jira", '{"key":"FOO-7","summary":"Fix search","url":"https://jira/FOO-7","updated":"t1"}')).toBeNull();
    expect((await client.listSessions("triage")).length).toBe(1);

    const declined = await client.injectOutput("jira", "ZED-1: nobody's");
    await h.orchestrator.idle();
    expect((await client.getSession(declined!.id)).triageStatus).toBe("declined");
  });

  test("/watchers/inject takes { source, text, prompt } and still accepts a legacy item", async () => {
    const { client, h } = await boot();
    const s = await client.injectOutput("events", '{"event":"assigned","to":"mark"}', "Dispatch what is assigned to me");
    expect(s!.title).toBe('{"event":"assigned","to":"mark"}');
    const first = (await client.transcript(s!.id)).find((e) => e.role === "user")!;
    const prompt = (first.content as { text: string }).text;
    expect(prompt).toContain('{"event":"assigned","to":"mark"}');
    expect(prompt).toContain("Dispatch what is assigned to me");
    const legacy = await client.request<{ title: string } | null>("POST", "/watchers/inject", { source: "jira", item: { key: "OLD-1", summary: "legacy" } });
    expect(legacy!.title).toBe('{"key":"OLD-1","summary":"legacy"}');
    await expect(client.request("POST", "/watchers/inject", { source: "jira" })).rejects.toMatchObject({ status: 400 });
    await expect(client.request("POST", "/watchers/inject", { source: "jira", text: "x", prompt: 3 })).rejects.toMatchObject({ status: 400 });
    await h.orchestrator.idle();
  });

  test("watchers CRUD without starting processes", async () => {
    const { client } = await boot();
    const w = await client.createWatcher({ name: "jira", command: "node", args: ["watch.js"], enabled: false });
    expect(w.mode).toBe("loop");
    expect(w.prompt).toBe("");
    const u = await client.updateWatcher(w.id, { mode: "interval", intervalSec: 60, prompt: "  Only mine  " });
    expect([u.mode, u.intervalSec, u.prompt]).toEqual(["interval", 60, "Only mine"]);
    const shell = await client.updateWatcher(w.id, { command: "while true; do curl -s x; sleep 60; done", args: [] });
    expect([shell.command, shell.args, shell.prompt]).toEqual(["while true; do curl -s x; sleep 60; done", [], "Only mine"]);
    await expect(client.updateWatcher(w.id, { prompt: 5 as unknown as string })).rejects.toMatchObject({ status: 400 });
    await expect(client.createWatcher({ name: "", command: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(client.runWatcher(w.id)).rejects.toMatchObject({ status: 400 }); // watchers disabled in this harness
    await client.deleteWatcher(w.id);
    expect(await client.listWatchers()).toEqual([]);
  });

  test("settings never expose the API key; PATCH merges", async () => {
    const { client, h } = await boot();
    const before = await client.getSettings();
    expect(before).toMatchObject({ defaultDriver: "dummy", maxConcurrentRuns: 4, permissionMode: "auto", classifier: "claude-cli", defaultModels: {}, reviewModels: {}, anthropicApiKeySet: false });
    const after = await client.updateSettings({ anthropicApiKey: "sk-secret", maxConcurrentRuns: 2 });
    expect(after.anthropicApiKeySet).toBe(true);
    expect(JSON.stringify(after)).not.toContain("sk-secret");
    expect(JSON.stringify(await client.getSettings())).not.toContain("sk-secret");
    expect(after.defaultDriver).toBe("dummy");
    expect(h.orchestrator.settings().anthropicApiKey).toBe("sk-secret");
    await expect(client.updateSettings({ defaultDriver: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  test("GET /prompts lists every prompt; PATCH /settings { prompts } overrides, refuses typos, and resets", async () => {
    const { client } = await boot();
    const before = await client.listPrompts();
    const work = before.find((p) => p.id === "system.work")!;
    expect(work).toMatchObject({ group: "system", override: null, overrideError: null, variables: [{ name: "branch" }, { name: "skipAgentReview" }, { name: "canSkipReview" }] });
    expect(work.builtin).toContain("{{#if branch}}");
    expect((await client.getSettings()).prompts?.["system.work"]).toBeNull();

    await expect(client.updateSettings({ prompts: { "system.work": "On {{brnch}}" } })).rejects.toMatchObject({
      status: 400,
      message: "prompts.system.work: Unknown variable {{brnch}}: the variables are {{branch}}, {{skipAgentReview}}, {{canSkipReview}}",
    });
    await expect(client.updateSettings({ prompts: { "system.nope": "x" } as never })).rejects.toMatchObject({ status: 400 });

    const after = await client.updateSettings({ prompts: { "system.work": "On {{branch}}" } });
    expect(after.prompts?.["system.work"]).toBe("On {{branch}}");
    expect((await client.listPrompts()).find((p) => p.id === "system.work")!.override).toBe("On {{branch}}");
    // echoing the whole settings object back is fine
    await client.updateSettings({ ...after, maxConcurrentRuns: 3 });
    expect((await client.updateSettings({ prompts: { "system.work": null } })).prompts?.["system.work"]).toBeNull();
  });

  test("drivers list and login", async () => {
    const { client } = await boot();
    const drivers = await client.listDrivers();
    expect(drivers.map((d) => d.id).sort()).toEqual(["dummy", "fake"]);
    await expect(client.loginDriver("fake")).rejects.toMatchObject({ status: 400 });
    await expect(client.loginDriver("missing")).rejects.toMatchObject({ status: 404 });
  });

  test("GET /drivers/:id/models: cached, ?refresh=1 re-queries, failures are data, unknown driver 404", async () => {
    const { client, fake } = await boot();
    const dummy = await client.listModels("dummy");
    expect(dummy).toMatchObject({ driverId: "dummy", error: null });
    expect(dummy.models.map((m) => m.id)).toEqual(["dummy-fast", "dummy-slow"]);
    await client.listModels("fake");
    fake.models = [{ id: "changed", name: "Changed" }];
    expect((await client.listModels("fake")).models[0]!.id).toBe("fake-model");
    expect((await client.listModels("fake", { refresh: true })).models[0]!.id).toBe("changed");
    expect(fake.listModelsCalls).toBe(2);
    fake.models = async () => {
      throw new Error("login expired");
    };
    const failed = await client.listModels("fake", { refresh: true });
    expect(failed).toMatchObject({ driverId: "fake", models: [], error: "login expired" });
    // the drivers list is unaffected by a failing model lookup
    expect((await client.listDrivers()).map((d) => d.id).sort()).toEqual(["dummy", "fake"]);
    await expect(client.listModels("missing")).rejects.toMatchObject({ status: 404 });
  });

  test("model selection over HTTP: create/patch ticket model, project + settings defaults reach the run", async () => {
    const { client, dir, h, fake } = await boot();
    const p = await client.createProject({ path: dir, defaultModels: { fake: "proj-model" } });
    expect(p.defaultModels).toEqual({ fake: "proj-model" });
    const t = await client.createTicket({ projectId: p.id, prompt: "x", driver: "fake", model: "ticket-model" });
    expect(t.model).toBe("ticket-model");
    await h.orchestrator.idle();
    expect(fake.calls[0]!.model).toBe("ticket-model");
    const patched = await client.updateTicket(t.key, { model: null });
    expect(patched.model).toBeNull();
    await client.sendMessage(t.key, "more");
    await h.orchestrator.idle();
    expect(fake.calls.at(-1)!.model).toBe("proj-model");
    await expect(client.updateTicket(t.key, { model: 42 as unknown as string })).rejects.toMatchObject({ status: 400 });
    const s = await client.updateSettings({ defaultModels: { dummy: "dummy-slow" } });
    expect(s.defaultModels).toEqual({ dummy: "dummy-slow" });
    await expect(client.updateSettings({ defaultModels: { nope: "x" } })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateProject(p.id, { defaultModels: { nope: "x" } })).rejects.toMatchObject({ status: 400 });
  });

  test("project color over HTTP: presets and hex are normalized, junk is refused, empty clears", async () => {
    const { client, dir } = await boot();
    const p = await client.createProject({ path: dir, color: "Blue" });
    expect(p.color).toBe("blue");
    expect((await client.updateProject(p.id, { color: "#ABC" })).color).toBe("#aabbcc");
    expect((await client.updateProject(p.id, { name: "renamed" })).color).toBe("#aabbcc");
    await expect(client.updateProject(p.id, { color: "chartreuse" })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateProject(p.id, { color: "#12345" })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateProject(p.id, { color: 7 as unknown as string })).rejects.toMatchObject({ status: 400 });
    expect((await client.listProjects()).find((x) => x.id === p.id)!.color).toBe("#aabbcc");
    expect((await client.updateProject(p.id, { color: "" })).color).toBeNull();
    await expect(client.createProject({ path: dir, key: "OTHER", color: "nope" })).rejects.toMatchObject({ status: 400 });
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

  test("a plain task ticket that makes a child with the real dummy driver conducts it to done", async () => {
    const { client, dir, h } = await boot();
    const p = await client.createProject({ path: dir, requireHumanReview: true });
    const t = await client.createTicket({ projectId: p.id, prompt: "Audit the PRs /child Rebase the PR" });
    await h.orchestrator.idle(30_000);
    const d = await client.getTicket(t.key);
    expect(d.ticket.kind).toBe("task");
    expect(d.ticket.childCount).toBe(1);
    expect(d.children.map((x) => [x.title, x.status, x.humanReview])).toEqual([["Rebase the PR", "done", "approved"]]);
    expect(d.ticket.status).toBe("review");
    // The child's move to review re-invoked the parent, which approved and completed it.
    expect(d.runs.some((r) => r.kind === "work" && r.prompt.startsWith("Child ticket updates:") && r.prompt.includes("in_progress → review"))).toBe(true);
    // Every run on the parent was a work run: its kind picked the prompt, the children made it conduct.
    expect(new Set(d.runs.map((r) => r.kind))).toEqual(new Set(["work", "review"]));
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

describe("drafts over http", () => {
  test("POST /tickets draft, PATCH a draft-only field, POST /tickets/:key/submit; the socket sees each step", async () => {
    const { client, dir } = await boot();
    const p = await client.createProject({ path: dir });
    const other = join(dir, "..", "other");
    mkdirSync(other, { recursive: true });
    const q = await client.createProject({ path: other, key: "OTHER" });
    const { events, ready } = collect(client);
    await ready;
    const d = await client.createTicket({ projectId: p.id, prompt: "", draft: true });
    expect([d.draft, d.status, d.title, d.busy]).toEqual([true, "planning", "Untitled draft", false]);
    expect((await client.listTickets()).map((t) => [t.key, t.draft])).toEqual([[d.key, true]]);
    await expect(client.submitTicket(d.key, { start: true })).rejects.toMatchObject({ status: 400 });
    await client.updateTicket(d.key, { description: "Make the header blue" });
    await expect(client.request("POST", `/tickets/${d.key}/submit`, { start: "yes" })).rejects.toMatchObject({ status: 400 });
    // Moving projects re-keys it; the old key keeps resolving (resolvedFrom), as after a project rename.
    const moved = await client.updateTicket(d.key, { projectId: q.id });
    expect(moved.key).toBe("OTHER-1");
    const detail = await client.getTicket(d.key);
    expect([detail.ticket.id, detail.ticket.key, detail.resolvedFrom]).toEqual([d.id, "OTHER-1", d.key]);
    await until(() => events.some((e) => e.kind === "ticket.upserted" && e.ticket.id === d.id && e.ticket.key === "OTHER-1"));
    const launched = await client.submitTicket(d.key, { start: true });
    expect([launched.key, launched.draft]).toEqual(["OTHER-1", false]);
    await expect(client.submitTicket(launched.key, { start: true })).rejects.toMatchObject({ status: 409 });
    await expect(client.updateTicket(launched.key, { kind: "conductor" })).rejects.toMatchObject({ status: 409 });
    await until(() => events.some((e) => e.kind === "run.upserted" && e.run.sessionId === d.sessionId));
    await until(() => events.some((e) => e.kind === "ticket.upserted" && e.ticket.id === d.id && e.ticket.draft === false));
  });
});

describe("ticket paging + search over http", () => {
  async function seedBoard() {
    const env = await boot();
    const { client, dir } = env;
    const p = await client.createProject({ path: dir, key: "PG" });
    const make = async (title: string, status?: "done" | "review") => {
      const t = await client.createTicket({ projectId: p.id, prompt: title, title, start: false });
      if (status) await client.updateTicket(t.key, { status });
      await Bun.sleep(2); // distinct completion timestamps
      return (await client.getTicket(t.key)).ticket;
    };
    const planning = await make("login planning");
    const review = await make("review me", "review");
    const done1 = await make("login done first", "done");
    const done2 = await make("done second", "done");
    const done3 = await make("login done third", "done");
    return { ...env, p, planning, review, done1, done2, done3 };
  }

  test("GET /tickets keeps returning everything; ?status= filters; unknown status is a 400", async () => {
    const { client, p, planning, review } = await seedBoard();
    expect(await client.listTickets()).toHaveLength(5);
    expect(await client.listTickets(p.id)).toHaveLength(5);
    const open = await client.listTickets(p.id, { status: ["planning", "in_progress", "blocked", "review"] });
    expect(open.map((t) => t.key).sort()).toEqual([planning.key, review.key].sort());
    expect(await client.listTickets(undefined, { status: [] })).toHaveLength(5); // empty filter = no filter
    await expect(client.request("GET", "/tickets?status=planning,nope")).rejects.toMatchObject({ status: 400 });
  });

  test("moving a ticket into done over REST sets completedAt; moving it out clears it", async () => {
    const { client, done1 } = await seedBoard();
    expect(done1.completedAt).toBeGreaterThan(0);
    const back = await client.updateTicket(done1.key, { status: "review" });
    expect(back.completedAt).toBeNull();
  });

  test("GET /tickets/page pages done newest-completion first with q, limit and cursor; bad input is a 400", async () => {
    const { client, p, done1, done2, done3 } = await seedBoard();
    const first = await client.ticketPage({ status: "done", projectId: p.id, limit: 2 });
    expect(first.tickets.map((t) => t.key)).toEqual([done3.key, done2.key]);
    expect(first.total).toBe(3);
    const second = await client.ticketPage({ status: "done", projectId: p.id, limit: 2, cursor: first.nextCursor });
    expect(second.tickets.map((t) => t.key)).toEqual([done1.key]);
    expect(second.nextCursor).toBeNull();
    const filtered = await client.ticketPage({ status: "done", q: "login" });
    expect(filtered.tickets.map((t) => t.key)).toEqual([done3.key, done1.key]);
    expect(filtered.total).toBe(2);
    expect((await client.request<any>("GET", "/tickets/page?status=done&limit=0")).tickets).toHaveLength(1);
    await expect(client.request("GET", "/tickets/page")).rejects.toMatchObject({ status: 400 });
    await expect(client.request("GET", "/tickets/page?status=done,review")).rejects.toMatchObject({ status: 400 });
    await expect(client.request("GET", "/tickets/page?status=done&q=%20")).rejects.toMatchObject({ status: 400 });
    await expect(client.ticketPage({ status: "done", cursor: "garbage" })).rejects.toMatchObject({ status: 400 });
  });

  test("GET /tickets/search searches every status, pages, and rejects an empty q", async () => {
    const { client, p, planning, done1, done3 } = await seedBoard();
    const res = await client.searchTickets({ q: "login" });
    expect(res.tickets.map((t) => t.key)).toEqual([done3.key, done1.key, planning.key]);
    expect(res.total).toBe(3);
    const page1 = await client.searchTickets({ q: "login", projectId: p.id, limit: 2 });
    const page2 = await client.searchTickets({ q: "login", projectId: p.id, limit: 2, cursor: page1.nextCursor });
    expect([...page1.tickets, ...page2.tickets].map((t) => t.key)).toEqual(res.tickets.map((t) => t.key));
    expect((await client.searchTickets({ q: planning.key.toLowerCase() })).tickets[0]!.key).toBe(planning.key);
    expect((await client.searchTickets({ q: `"login (done` })).tickets.map((t) => t.key)).toEqual([done3.key, done1.key]);
    await expect(client.searchTickets({ q: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(client.request("GET", "/tickets/search")).rejects.toMatchObject({ status: 400 });
    // /tickets/:key still works alongside the new routes.
    expect((await client.getTicket(planning.key)).ticket.id).toBe(planning.id);
  });

  test("file autocomplete: /projects/:id/files and /tickets/:key/files", async () => {
    const { client, dir } = await boot();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "x");
    const p = await client.createProject({ path: dir });
    expect(await client.projectFiles(p.id, "app")).toEqual([{ path: "src/app.ts", kind: "file" }]);
    expect(await client.projectFiles(p.id, "", 1)).toEqual([{ path: "src/", kind: "dir" }]);
    const t = await client.createTicket({ projectId: p.id, prompt: "x", start: false });
    expect(await client.ticketFiles(t.key, "sr")).toEqual([
      { path: "src/", kind: "dir" },
      { path: "src/app.ts", kind: "file" },
    ]);
    await expect(client.projectFiles("nope", "a")).rejects.toMatchObject({ status: 404 });
    await expect(client.ticketFiles("NOPE-9", "a")).rejects.toMatchObject({ status: 404 });
  });

  test("file viewer: /file and /file/diff for projects and tickets, and the browser's /files flags", async () => {
    const { client, dir } = await boot();
    const git = async (...args: string[]) => {
      const r = await runGit(args, dir);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(dir, "src", "app.ts"), "one\n");
    await git("init", "-q");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    writeFileSync(join(dir, "src", "app.ts"), "two\n");
    writeFileSync(join(dir, ".env"), "S=1\n");
    writeFileSync(join(dir, "node_modules", "foo", "index.js"), "module.exports = 1;\n");
    const p = await client.createProject({ path: dir });
    const t = await client.createTicket({ projectId: p.id, prompt: "x", start: false });

    const view = await client.projectFile(p.id, "src/app.ts");
    expect(view).toMatchObject({ path: "src/app.ts", root: dir, size: 4, contents: "two\n", binary: false, tooLarge: false });
    expect(view.git).toMatchObject({ repo: true, tracked: true, dirty: true, untracked: false });
    // The ticket has no worktree yet, so it reads from the project folder; absolute paths inside it work.
    expect((await client.ticketFile(t.key, join(dir, ".env"))).contents).toBe("S=1\n");
    expect((await client.ticketFile(t.key, ".env")).git.ignored).toBe(true);

    const diff = await client.projectFileDiff(p.id, "src/app.ts");
    expect(diff).toMatchObject({ path: "src/app.ts", oldContents: "one\n", newContents: "two\n", tooLarge: false });
    expect(diff.patch).toContain("-one\n+two\n");
    expect((await client.ticketFileDiff(t.key, ".gitignore")).patch).toBe("");

    await expect(client.projectFile(p.id, "../secret")).rejects.toMatchObject({ status: 400 });
    await expect(client.projectFile(p.id, "src")).rejects.toMatchObject({ status: 400 });
    await expect(client.projectFile(p.id, "")).rejects.toMatchObject({ status: 400 });
    await expect(client.ticketFile(t.key, "nope.ts")).rejects.toMatchObject({ status: 404 });
    await expect(client.projectFile("nope", "a")).rejects.toMatchObject({ status: 404 });
    await expect(client.ticketFileDiff("NOPE-9", "a")).rejects.toMatchObject({ status: 404 });

    // The autocomplete doesn't reach into node_modules; the file browser's search does.
    expect(await client.projectFiles(p.id, "foo/ind")).toEqual([]);
    expect(await client.projectFiles(p.id, "foo/ind", { ignored: true })).toEqual([{ path: "node_modules/foo/index.js", kind: "file", ignored: true }]);
    expect(await client.ticketFiles(t.key, ".env", { ignored: true, kind: "file" })).toEqual([{ path: ".env", kind: "file", ignored: true }]);
    expect(await client.ticketFiles(t.key, "src/app", { ignored: true, kind: "file" })).toEqual([{ path: "src/app.ts", kind: "file" }]);
    expect(await client.ticketFiles(t.key, "src", { kind: "file" })).toEqual([{ path: "src/app.ts", kind: "file" }]);
    expect(await client.ticketFiles(t.key, "src", 1)).toEqual([{ path: "src/", kind: "dir" }]);
    await expect(client.request("GET", `/projects/${p.id}/files?q=a&kind=folder`)).rejects.toMatchObject({ status: 400 });

    // A project outside git has files but no diff.
    const plain = join(dir, "..", "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.txt"), "a");
    const q = await client.createProject({ path: plain });
    expect((await client.projectFile(q.id, "a.txt")).git.repo).toBe(false);
    await expect(client.projectFileDiff(q.id, "a.txt")).rejects.toMatchObject({ status: 409 });
  });

  test("branch picker: /projects/:id/branches filters by q and caps by limit; base branches round-trip", async () => {
    const { client, dir } = await boot();
    const git = async (...args: string[]) => {
      const r = await runGit(args, dir);
      if (r.code !== 0) throw new Error(r.stderr);
    };
    await git("init", "-q", "-b", "main");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    await git("branch", "medl-1223-ai-app");
    const p = await client.createProject({ path: dir, baseBranch: "develop" });
    expect(p.baseBranch).toBe("develop");
    const all = await client.projectBranches(p.id);
    expect(all.map((b) => b.name).sort()).toEqual(["main", "medl-1223-ai-app"]);
    expect(all.find((b) => b.name === "main")!.checkedOutAt).not.toBeNull();
    expect(typeof all[0]!.lastCommitAt).toBe("number");
    expect((await client.projectBranches(p.id, "ai-APP")).map((b) => b.name)).toEqual(["medl-1223-ai-app"]);
    expect(await client.projectBranches(p.id, "", 1)).toHaveLength(1);
    await expect(client.projectBranches("nope")).rejects.toMatchObject({ status: 404 });
    // Ticket fields over REST: chosen branch and base override; the settings default is public.
    const t = await client.createTicket({ projectId: p.id, prompt: "x", start: false, branch: "medl-1223-ai-app", baseBranch: "release" });
    expect([t.requestedBranch, t.baseBranch, t.branch]).toEqual(["medl-1223-ai-app", "release", null]);
    expect((await client.updateTicket(t.key, { baseBranch: "" })).baseBranch).toBeNull();
    expect((await client.getSettings()).baseBranch).toBe("main");
    await expect(client.updateSettings({ baseBranch: "x..y" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /attachments/:id", () => {
  async function withAttachments() {
    const b = await boot();
    const video = Buffer.concat([mp4(), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))]);
    writeFileSync(join(b.dir, "after.png"), png(40, 30));
    writeFileSync(join(b.dir, "flow.mp4"), video);
    const p = await b.client.createProject({ path: b.dir });
    const t = await b.client.createTicket({ projectId: p.id, prompt: "x", start: false });
    const { events, ready } = collect(b.client);
    await ready;
    const ctx = fakeContext({ ticket: t, cwd: b.dir, session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: b.h.orchestrator.ops });
    await b.h.orchestrator.ops.postSummary(ctx, "shots", ["after.png", "flow.mp4"]);
    await until(() => events.some((e) => e.kind === "summary.added"));
    const [summary] = await b.client.listSummaries(t.key);
    return { ...b, t, video, events, summary: summary! };
  }

  test("summaries over REST and summary.added carry the attachments", async () => {
    const { summary, events } = await withAttachments();
    expect(summary.attachments.map((a) => [a.name, a.kind, a.mimeType, a.width, a.height])).toEqual([
      ["after.png", "image", "image/png", 40, 30],
      ["flow.mp4", "video", "video/mp4", undefined, undefined],
    ]);
    const added = events.find((e) => e.kind === "summary.added");
    expect(added).toMatchObject({ summary: { attachments: summary.attachments } });
  });

  test("header token or query token; a bad token is 401 and an unknown id 404", async () => {
    const { h, client, summary } = await withAttachments();
    const [image] = summary.attachments;
    const viaHeader = await fetch(`${h.url}/attachments/${image!.id}`, { headers: { authorization: `Bearer ${h.token}` } });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.headers.get("content-type")).toBe("image/png");
    expect(viaHeader.headers.get("content-length")).toBe(String(image!.size));
    expect(viaHeader.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(await viaHeader.arrayBuffer())).toEqual(png(40, 30));

    const viaQuery = await fetch(client.attachmentUrl(image!.id));
    expect(viaQuery.status).toBe(200);
    expect(Buffer.from(await viaQuery.arrayBuffer())).toEqual(png(40, 30));

    expect((await fetch(`${h.url}/attachments/${image!.id}?token=${"x".repeat(64)}`)).status).toBe(401);
    expect((await fetch(`${h.url}/attachments/${image!.id}`)).status).toBe(401);
    expect((await fetch(client.attachmentUrl("nope"))).status).toBe(404);
  });

  test("the query token works on no other route", async () => {
    const { h, t } = await withAttachments();
    for (const path of ["/projects", `/tickets/${t.key}/summaries`, "/settings"]) {
      expect((await fetch(`${h.url}${path}?token=${encodeURIComponent(h.token)}`)).status).toBe(401);
    }
  });

  test("Range requests get 206 with exactly the asked-for bytes", async () => {
    const { client, summary, video } = await withAttachments();
    const url = client.attachmentUrl(summary.attachments[1]!.id);
    const mid = await fetch(url, { headers: { range: "bytes=100-199" } });
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 100-199/${video.length}`);
    expect(mid.headers.get("content-length")).toBe("100");
    expect(mid.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await mid.arrayBuffer())).toEqual(video.subarray(100, 200));

    const open = await fetch(url, { headers: { range: `bytes=${video.length - 10}-` } });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer())).toEqual(video.subarray(video.length - 10));

    const suffix = await fetch(url, { headers: { range: "bytes=-5" } });
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(video.subarray(video.length - 5));

    const past = await fetch(url, { headers: { range: `bytes=${video.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${video.length}`);
  });

  test("the file is gone once its ticket is deleted", async () => {
    const { client, t, summary, h } = await withAttachments();
    await client.deleteTicket(t.key);
    for (const a of summary.attachments) expect((await fetch(client.attachmentUrl(a.id))).status).toBe(404);
    expect(readdirSync(h.paths.attachmentsDir)).toEqual([]);
  });
});

/** This machine's first non-loopback IPv4 address, where Bun's sendfile bug shows (loopback hides it). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

/**
 * The raw bytes a server sends back for `GET path`: up to the end of a well-formed response's
 * content-length body, or whatever arrived when the server closes or goes quiet (a garbled one).
 */
function rawGet(host: string, port: number, path: string, headers = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const done = () => {
      clearTimeout(quiet);
      sock.destroy();
      resolve(got);
    };
    let quiet = setTimeout(done, 1000);
    const sock = connect(port, host, () => sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headers}\r\n`));
    sock.on("data", (d) => {
      got = Buffer.concat([got, d]);
      clearTimeout(quiet);
      quiet = setTimeout(done, 1000);
      const split = got.indexOf("\r\n\r\n");
      const length = split < 0 ? null : /\r\ncontent-length: *(\d+)/i.exec(got.subarray(0, split).toString());
      if (length && got.length - split - 4 >= Number(length[1])) done();
    });
    sock.on("end", done);
    sock.on("error", reject);
  });
}

describe("serveFile over a non-loopback socket", () => {
  test.skipIf(!lanAddress)("the status line and headers come before the file", async () => {
    const dir = tempHome("harness-servefile-");
    const body = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 7) % 256));
    const path = join(dir, "shot.png");
    writeFileSync(path, body);
    const server = Bun.serve({ hostname: lanAddress, port: 0, fetch: (req) => serveFile(req, path, "image/png") });
    try {
      // The old Bun.file body garbled nearly every response here, so a few rounds are plenty.
      for (let i = 0; i < 4; i++) {
        const whole = await rawGet(lanAddress!, server.port!, "/");
        expect(whole.subarray(0, 15).toString()).toBe("HTTP/1.1 200 OK");
        expect(whole.subarray(whole.indexOf("\r\n\r\n") + 4)).toEqual(body);

        const part = await rawGet(lanAddress!, server.port!, "/", "Range: bytes=1000-1999\r\n");
        expect(part.subarray(0, 12).toString()).toBe("HTTP/1.1 206");
        expect(part.subarray(part.indexOf("\r\n\r\n") + 4)).toEqual(body.subarray(1000, 2000));
      }
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

describe("parseRange", () => {
  test("clamps the end, handles suffix and open ranges, and ignores what it can't serve", () => {
    expect(parseRange("bytes=0-99", 50)).toEqual({ start: 0, end: 49 });
    expect(parseRange("bytes=-100", 50)).toEqual({ start: 0, end: 49 });
    expect(parseRange("bytes=10-", 50)).toEqual({ start: 10, end: 49 });
    expect(parseRange("bytes=20-10", 50)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 50)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 50)).toBeNull();
    expect(parseRange("items=0-1", 50)).toBeNull();
    expect(parseRange(null, 50)).toBeNull();
  });
});
