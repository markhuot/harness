// Config tools end to end: a work run configures watchers/mappings/projects/settings through
// tools, and every mutation waits for a human (approval card → allow once → the same call runs).

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, TranscriptEntry } from "@harness/shared";
import { DummyDriver } from "../drivers/dummy";
import { executeTool, type RunRequest } from "../drivers/types";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { toolsForRun } from "../tools/index";
import type { ToolResult } from "../tools/types";
import { APPROVAL_PENDING_MESSAGE } from "./orchestrator";
import { WatcherRunner } from "./watchers";

function setup(opts: { mode?: "auto" | "ask" | "read_only" } = {}) {
  const driver = new DummyDriver({ delayMs: 0 });
  const h = makeOrchestrator({ drivers: [driver], tools: (kind, d) => toolsForRun(kind, d) });
  h.store.settings.set({ defaultDriver: "dummy", ...(opts.mode ? { permissionMode: opts.mode } : {}) });
  const dir = join(h.home, "proj");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "PROJ", useWorktrees: false });
  return { ...h, project, dir };
}

/** A FakeDriver whose runs call harness tools from `script`; results are recorded per run. */
function scripted(steps: (req: RunRequest, call: (name: string, input: unknown) => Promise<ToolResult>) => Promise<void>) {
  const driver = new FakeDriver("fake");
  const results: { kind: RunKind; name: string; result: ToolResult }[] = [];
  driver.script = async function* (req) {
    await steps(req, async (name, input) => {
      const result = await executeTool(req.tools, name, input, req.toolContext);
      results.push({ kind: req.kind, name, result });
      return result;
    });
  };
  const h = makeOrchestrator({ driver, tools: (kind, d) => toolsForRun(kind, d) });
  const dir = join(h.home, "proj");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "PROJ", useWorktrees: false });
  return { ...h, project, dir, results };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

const toolResults = (entries: TranscriptEntry[], name: string) =>
  entries.flatMap((e) => (e.content.type === "tool_result" && e.content.name === name ? [e.content] : []));

const watcherCall = {
  name: "create_watcher",
  input: {
    name: "jira-once",
    command: "watch-jira --project=SITE --assigned=unassigned --once",
    prompt: "If a ticket is assigned to me and has next steps, dispatch it to an agent in PROJ.",
    mode: "interval",
    interval_sec: 600,
  },
};
const mappingCall = { name: "create_mapping", input: { pattern: "SITE", project_key: "proj", notes: "Jira SITE board" } };

describe("config tools behind human approval", () => {
  test("a work run creates a watcher and a mapping, each after its own allow-once", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: `set it up /tools ${JSON.stringify([watcherCall, mappingCall])}` });
    await h.orch.idle();

    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.pendingApproval).toMatchObject({ toolName: "create_watcher", input: watcherCall.input, onceOnly: true, source: "policy" });
    expect(cur.pendingApproval!.summary).toBe(`Create watcher "jira-once" (every 600s): watch-jira --project=SITE --assigned=unassigned --once`);
    expect(cur.blockedReason).toBe(`Permission needed: create_watcher — ${cur.pendingApproval!.summary}`);
    expect(h.orch.listWatchers()).toEqual([]);
    const denied = toolResults(h.store.transcript.list(t.sessionId), "create_watcher");
    expect(denied.map((r) => [r.isError, r.output[0]])).toEqual([[true, { type: "text", text: APPROVAL_PENDING_MESSAGE }]]);

    // Config calls can't be allowed for the rest of the ticket
    await expect(h.orch.answerApproval(t.key, { decision: "allow_tool" })).rejects.toMatchObject({ status: 400 });
    expect(h.orch.ticketDetail(t.key).ticket.allowedTools).toEqual([]);

    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    const watchers = h.orch.listWatchers();
    expect(watchers.map((w) => [w.name, w.command, w.args, w.mode, w.intervalSec])).toEqual([
      ["jira-once", watcherCall.input.command, [], "interval", 600],
    ]);
    // The mapping is its own approval; the watcher's grant was used up
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.pendingApproval).toMatchObject({ toolName: "create_mapping", summary: "Hint that SITE keys belong in project proj" });
    expect(h.orch.listMappings()).toEqual([]);
    expect(h.store.tickets.listGrants(t.id)).toEqual([]);

    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(h.orch.listMappings().map((m) => [m.pattern, m.projectId, m.notes])).toEqual([["SITE", h.project.id, "Jira SITE board"]]);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(h.orch.listWatchers()).toHaveLength(1); // the approved call ran exactly once
    expect(h.orch.summaries(t.key).filter((s) => s.author === "human").map((s) => s.body)).toEqual([
      `Allowed once: create_watcher (Create watcher "jira-once" (every 600s): watch-jira --project=SITE --assigned=unassigned --once)`,
      "Allowed once: create_mapping (Hint that SITE keys belong in project proj)",
    ]);
  });

  test("a grant covers only the approved input: a changed retry asks again", async () => {
    const h = scripted(async (req, call) => {
      const n = h.results.length;
      if (req.kind !== "work") return;
      await call("create_watcher", { name: "w", command: n === 0 ? "/bin/echo" : "/bin/sh" });
    });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(h.orch.listWatchers()).toEqual([]);
    expect(h.orch.ticketDetail(t.key).ticket.pendingApproval).toMatchObject({ toolName: "create_watcher", input: { command: "/bin/sh" } });
  });

  test("gated grants aren't handed to the driver, and allowedTools never unlocks a gated tool", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind === "work") await call("delete_mapping", { id: "nope" });
    });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    // Unknown mapping: rejected before any human is asked
    expect(text(h.results[0]!.result)).toBe("Unknown mapping: nope. Use list_mappings.");
    expect(h.orch.ticketDetail(t.key).ticket.pendingApproval).toBeNull();

    const m = h.orch.createMapping({ pattern: "FOO", projectId: h.project.id });
    h.store.tickets.update(t.id, { allowedTools: ["delete_mapping", "WebFetch"] });
    h.driver.script = async function* (req) {
      if (req.kind === "work") h.results.push({ kind: req.kind, name: "delete_mapping", result: await executeTool(req.tools, "delete_mapping", { id: m.id }, req.toolContext) });
    };
    await h.orch.humanReview(t.key, { decision: "request_changes", notes: "delete FOO" });
    await h.orch.idle();
    expect(h.orch.listMappings()).toHaveLength(1);
    expect(h.orch.ticketDetail(t.key).ticket.pendingApproval).toMatchObject({ toolName: "delete_mapping", onceOnly: true });

    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(h.orch.listMappings()).toEqual([]);
    const retry = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(retry.grants).toEqual({ tools: ["WebFetch"], once: [] });
  });

  test("read-only tickets are denied outright: no approval card, nothing changes", async () => {
    const h = setup({ mode: "read_only" });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: `x /tools ${JSON.stringify([watcherCall])}` });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.pendingApproval).toBeNull();
    expect(cur.status).not.toBe("blocked");
    expect(h.orch.listWatchers()).toEqual([]);
    const [r] = toolResults(h.store.transcript.list(t.sessionId), "create_watcher");
    expect(r!.isError).toBe(true);
    expect(r!.output[0]).toMatchObject({ text: expect.stringContaining("read-only mode") });
  });

  test("validation errors come back as tool errors before a human is asked", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind !== "work") return;
      await call("create_watcher", { name: "w", command: "/bin/echo", driver: "nope" });
      await call("create_mapping", { pattern: "FOO", project_key: "MISSING" });
      await call("create_mapping", { pattern: "/(/", project_key: "PROJ" });
      await call("create_project", { path: "/definitely/not/here" });
      await call("update_settings", { max_concurrent_runs: 0 });
      await call("update_settings", { listen: { mode: "custom" } });
      await call("update_watcher", { watcher: "ghost", enabled: false });
    });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    expect(h.results.map((r) => [r.name, r.result.isError, text(r.result)])).toEqual([
      ["create_watcher", true, "Unknown driver: nope"],
      ["create_mapping", true, "Unknown project: MISSING. Use list_projects for the keys."],
      ["create_mapping", true, expect.stringMatching(/^Invalid regex:/)],
      ["create_project", true, "Not a directory: /definitely/not/here"],
      ["update_settings", true, 'Invalid input for update_settings: "max_concurrent_runs" must be >= 1.'],
      ["update_settings", true, "listen.host is required for custom mode"],
      ["update_watcher", true, "Unknown watcher: ghost. Use list_watchers."],
    ]);
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.pendingApproval).toBeNull();
  });

  test("the API key never reaches a model: get_settings hides it and update_settings can't set it", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind !== "work") return;
      await call("get_settings", {});
      await call("update_settings", { anthropicApiKey: "sk-from-model", anthropic_api_key: "sk-from-model" });
      await expect(req.toolContext.ops.updateSettings(req.toolContext, { anthropicApiKey: "sk-from-model" })).rejects.toThrow(
        "anthropicApiKey can't be changed with a tool: ask the human to enter it in Settings.",
      );
    });
    h.orch.updateSettings({ anthropicApiKey: "sk-secret-123" });
    await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    const [get, update] = h.results;
    expect(text(get!.result)).not.toContain("sk-secret");
    expect(JSON.parse(text(get!.result))).toMatchObject({ anthropicApiKeySet: true, defaultDriver: "fake" });
    expect([update!.result.isError, text(update!.result)]).toEqual([true, "Nothing to change: pass at least one setting."]);
    expect(h.orch.settings().anthropicApiKey).toBe("sk-secret-123");
  });

  test("update_settings applies the same validation as PATCH /settings once approved", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind === "work") await call("update_settings", { permission_mode: "ask", max_concurrent_runs: 2 });
    });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    expect(h.orch.settings().permissionMode).toBe("auto");
    expect(h.orch.ticketDetail(t.key).ticket.pendingApproval!.summary).toBe("Change settings: maxConcurrentRuns=2, permissionMode=ask");
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect([h.orch.settings().permissionMode, h.orch.settings().maxConcurrentRuns]).toEqual(["ask", 2]);
  });

  test("mutating ops refuse runs without a human in the loop, whatever tool reaches them", async () => {
    const errors: string[] = [];
    const h = scripted(async (req) => {
      if (req.kind !== "plan") return;
      const ctx = req.toolContext;
      for (const op of [
        () => ctx.ops.createWatcher(ctx, { name: "w", command: "/bin/echo" }),
        () => ctx.ops.updateSettings(ctx, { maxConcurrentRuns: 2 }),
        () => ctx.ops.deleteTicket(ctx, "PROJ-9"),
      ]) {
        await op().catch((e: Error) => errors.push(e.message));
      }
    });
    await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    expect(errors).toEqual(Array(3).fill("Configuration can't be changed during a plan run."));
    expect(h.orch.listWatchers()).toEqual([]);
  });

  test("delete_ticket refuses the agent's own ticket and its ancestors; others go to a human", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind !== "work") return;
      const own = req.toolContext.ticket!;
      await call("delete_ticket", { key: own.key });
      await call("delete_ticket", { key: "PROJ-1" }); // the parent
      await call("delete_project", { project_key: "PROJ" });
      await call("delete_ticket", { key: "PROJ-3" }); // an unrelated ticket
    });
    const parent = await h.orch.createTicket({ projectId: h.project.id, prompt: "parent", start: false });
    const child = await h.orch.createTicket({ projectId: h.project.id, prompt: "child", start: false });
    const other = await h.orch.createTicket({ projectId: h.project.id, prompt: "other", start: false });
    expect([parent.key, child.key, other.key]).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    h.store.db.query("UPDATE tickets SET parent_id = $p WHERE id = $id").run({ p: parent.id, id: child.id });
    await h.orch.startTicket(child.key);
    await h.orch.idle();
    expect(h.results.map((r) => text(r.result))).toEqual([
      "You can't delete your own ticket (PROJ-2).",
      "You can't delete PROJ-1: it is an ancestor of your ticket PROJ-2.",
      "You can't delete PROJ: your ticket PROJ-2 is in it.",
      APPROVAL_PENDING_MESSAGE,
    ]);
    expect(h.orch.ticketDetail(child.key).ticket.pendingApproval).toMatchObject({ toolName: "delete_ticket", summary: "Delete ticket PROJ-3" });
    expect(h.orch.listTickets().map((t) => t.key).sort()).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });

  test("list_watchers shows which env vars are set, never their values; update_watcher merges env", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind !== "work") return;
      await call("list_watchers", {});
      await call("update_watcher", { watcher: "jira", env: { EXTRA: "1", JIRA_TOKEN: "" } });
    });
    const w = h.orch.createWatcher({ name: "jira", command: "/bin/echo", env: { JIRA_TOKEN: "tok-secret", SITE: "acme" } });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    const listed = text(h.results[0]!.result);
    expect(listed).not.toContain("tok-secret");
    expect(JSON.parse(listed)[0]).toMatchObject({ id: w.id, env: { JIRA_TOKEN: "(set)", SITE: "(set)" }, command_line: "/bin/echo" });
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(h.store.watchers.get(w.id)!.env).toEqual({ SITE: "acme", EXTRA: "1" });
  });

  test("prompt is passed straight through to the orchestrator on create and update", async () => {
    const h = scripted(async (req, call) => {
      if (req.kind !== "work") return;
      await call("create_watcher", { name: "status", command: "curl -s https://status.test/api", prompt: "Dispatch outages to PROJ." });
      await call("update_watcher", { watcher: "status", prompt: "Only dispatch major outages." });
    });
    const bodies: { op: string; body: unknown }[] = [];
    const create = h.orch.createWatcher.bind(h.orch);
    const update = h.orch.updateWatcher.bind(h.orch);
    h.orch.createWatcher = (body) => (bodies.push({ op: "create", body }), create(body));
    h.orch.updateWatcher = (id, body) => (bodies.push({ op: "update", body }), update(id, body));
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(bodies).toEqual([
      { op: "create", body: { name: "status", command: "curl -s https://status.test/api", prompt: "Dispatch outages to PROJ." } },
      { op: "update", body: { prompt: "Only dispatch major outages." } },
    ]);
    // The card spells out a prompt change
    expect(h.orch.summaries(t.key).filter((s) => s.author === "human").map((s) => s.body)).toEqual([
      'Allowed once: create_watcher (Create watcher "status" (loop): curl -s https://status.test/api)',
      'Allowed once: update_watcher (Update watcher "status": prompt=Only dispatch major outages.)',
    ]);
  });

  test("a watcher created through the tools runs and its output reaches the Inbox", async () => {
    const driver = new FakeDriver("fake");
    const h = makeOrchestrator({
      driver,
      tools: (kind, d) => toolsForRun(kind, d),
      watchers: (handlers) => new WatcherRunner({ ...handlers, timing: { batchIdleMs: 5, batchMaxMs: 20, minIntervalMs: 10 } }),
    });
    const dir = join(h.home, "site");
    mkdirSync(dir);
    const project = h.orch.createProject({ path: dir, key: "SITE", useWorktrees: false });
    // Stands in for a tool the user has installed. Its output is one JSON line with a key, which
    // both the item-based and the output-based (HARNESS-22) watcher models send to triage.
    const tool = join(h.home, "watch-fake");
    writeFileSync(tool, `#!/bin/sh\necho '{"key":"ACME-7","summary":"Fix the footer"}'\n`);
    chmodSync(tool, 0o755);
    const input = { name: "fake", command: tool, args: ["--once"], mode: "interval", interval_sec: 600, prompt: "File footer bugs in SITE." };
    let done = false;
    const worker = driver.run.bind(driver);
    driver.run = async function* (req) {
      if (req.kind !== "work") return yield* worker(req);
      if (!done) done = !(await executeTool(req.tools, "create_watcher", input, req.toolContext)).isError;
    };
    const t = await h.orch.createTicket({ projectId: project.id, prompt: "add the fake watcher" });
    await h.orch.idle();
    expect(h.orch.listWatchers()).toEqual([]);
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    const deadline = Date.now() + 10_000;
    while (h.orch.listSessions("triage").length === 0 && Date.now() < deadline) await Bun.sleep(20);
    await h.orch.idle();
    expect(h.orch.listSessions("triage")).toHaveLength(1);
    expect(h.orch.listWatchers()[0]!.lastError).toBeNull();
    await h.orch.stop();
  });

  // HARNESS-22 adds watcher.prompt (validation, storage, migration). Until it lands the orchestrator
  // drops the field, so this runs only once storage keeps it.
  const storesPrompt = (() => {
    const probe = makeOrchestrator();
    const w = probe.orch.createWatcher({ name: "probe", command: "/bin/echo", prompt: "p" } as Parameters<typeof probe.orch.createWatcher>[0]);
    return (w as { prompt?: string }).prompt === "p";
  })();

  test.if(storesPrompt)("prompt round-trips through storage and list_watchers", async () => {
    const out: string[] = [];
    let next = 0;
    const h = scripted(async (req) => {
      if (req.kind !== "work") return;
      const calls = [
        ["create_watcher", { name: "status", command: "curl -s https://status.test/api", prompt: "  Dispatch outages to PROJ.  " }],
        ["update_watcher", { watcher: "status", prompt: "Only major outages." }],
        ["list_watchers", {}],
      ] as const;
      for (; next < calls.length; next++) {
        const r = await executeTool(req.tools, calls[next]![0], calls[next]![1], req.toolContext);
        out.push(text(r));
        if (r.isError) return;
      }
    });
    const prompt = () => (h.orch.listWatchers()[0] as { prompt?: string }).prompt;
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "go" });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(prompt()).toBe("Dispatch outages to PROJ.");
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    expect(prompt()).toBe("Only major outages.");
    expect(JSON.parse(out.at(-1)!)[0]).toMatchObject({ prompt: "Only major outages.", command_line: "curl -s https://status.test/api" });
  });
});
