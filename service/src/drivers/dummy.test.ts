import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { outputTitle, type Project, type RunKind } from "@harness/shared";
import { triagePrompt as buildTriagePrompt } from "../orchestrator/prompts";
import { fakeBrowser, fakeContext, fakeOps } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
import type { ToolContext, ToolDefinition } from "../tools/types";
import { DummyDriver } from "./dummy";
import type { DriverEvent, RunRequest } from "./types";
import { tempDir } from "@harness/shared/testing";

function makeReq(kind: RunKind, prompt: string, opts: { state?: unknown; tools?: ToolDefinition[]; ctx?: Partial<ToolContext>; signal?: AbortSignal; model?: string | null } = {}) {
  const ops = fakeOps();
  const browser = fakeBrowser();
  const signal = opts.signal ?? new AbortController().signal;
  const ctx = fakeContext({ runKind: kind, ops, browser, signal, ...opts.ctx });
  const req: RunRequest = {
    runId: "run_1",
    kind,
    prompt,
    systemPrompt: "sys",
    cwd: ctx.cwd,
    model: opts.model ?? null,
    state: opts.state ?? null,
    tools: opts.tools ?? toolsForRun(kind, { hasBuiltinTools: false }),
    toolContext: ctx,
    mcp: { url: "http://x", headers: {} },
    signal,
  };
  return { req, ops: ctx.ops as ReturnType<typeof fakeOps>, browser: ctx.browser as ReturnType<typeof fakeBrowser> };
}

async function collect(driver: DummyDriver, req: RunRequest): Promise<{ events: DriverEvent[]; error: unknown }> {
  const events: DriverEvent[] = [];
  try {
    for await (const ev of driver.run(req)) events.push(ev);
    return { events, error: null };
  } catch (err) {
    return { events, error: err };
  }
}

const driver = new DummyDriver({ delayMs: 0 });
const calls = (events: DriverEvent[]) => events.filter((e): e is Extract<DriverEvent, { type: "tool_call" }> => e.type === "tool_call");
const results = (events: DriverEvent[]) => events.filter((e): e is Extract<DriverEvent, { type: "tool_result" }> => e.type === "tool_result");
const texts = (events: DriverEvent[]) => events.filter((e): e is Extract<DriverEvent, { type: "text" }> => e.type === "text").map((e) => e.text);
const lastState = (events: DriverEvent[]) => [...events].reverse().find((e) => e.type === "state") as { state: any } | undefined;

describe("dummy driver", () => {
  test("info reports available and authenticated, no builtin tools", async () => {
    const info = await driver.info();
    expect(info.available).toBe(true);
    expect(info.authenticated).toBe(true);
    expect(info.supportsLogin).toBe(false);
    expect(driver.hasBuiltinTools).toBe(false);
  });

  test("plan: text with first line and numbered steps, then update_plan with the same plan", async () => {
    const { req, ops } = makeReq("plan", "\n  Add dark mode\nmore detail here");
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    const [text] = texts(events);
    expect(text!.startsWith("Here's a plan for: Add dark mode")).toBe(true);
    expect(text).toMatch(/\n1\. /);
    expect(ops.calls).toEqual([{ method: "updatePlan", args: [text, undefined] }]);
    expect(calls(events).map((c) => c.name)).toEqual(["update_plan"]);
  });

  test("text_delta fragments concatenate to the text block", async () => {
    const { req } = makeReq("work", "say   something\nnice");
    const { events } = await collect(driver, req);
    const firstText = events.findIndex((e) => e.type === "text");
    const deltas = events.slice(0, firstText).filter((e) => e.type === "text_delta").map((e: any) => e.text);
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join("")).toBe(texts(events)[0]!);
  });

  test("work default: greeting, post_summary then submit_for_review, state last", async () => {
    const { req, ops } = makeReq("work", "fix the bug");
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(texts(events)[0]).toBe('Hello from the dummy driver! You said: "fix the bug"');
    expect(ops.calls.map((c) => c.method)).toEqual(["postSummary", "submitForReview"]);
    expect(events[events.length - 1]).toEqual({ type: "state", state: { turns: 1 } });
    // every tool_call is followed by a tool_result with the same callId
    const cs = calls(events);
    const rs = results(events);
    expect(rs.map((r) => r.callId)).toEqual(cs.map((c) => c.callId));
    expect(new Set(cs.map((c) => c.callId)).size).toBe(cs.length);
  });

  test("state.turns increments from prior state", async () => {
    const { req } = makeReq("work", "again", { state: { turns: 4 } });
    const { events } = await collect(driver, req);
    expect(lastState(events)!.state.turns).toBe(5);
  });

  test("/agents 3: two top-level sub-agents, the third nested in the second, each with tagged output", async () => {
    const { req, ops } = makeReq("work", "/agents 3");
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    const reports = events.filter((e) => e.type === "subagent").map((e) => (e as Extract<DriverEvent, { type: "subagent" }>).subagent);
    const id = (n: number) => `dummy_agent_run_1_${n}`;
    expect(reports.map((r) => [r.id, r.status, r.parentId ?? null])).toEqual([
      [id(1), "running", null],
      [id(1), "succeeded", null],
      [id(2), "running", null],
      [id(3), "running", id(2)],
      [id(3), "succeeded", null],
      [id(2), "succeeded", null],
    ]);
    // The nested agent's Agent call belongs to its parent's transcript; its own output to its own.
    const agentCalls = calls(events).filter((c) => c.name === "Agent");
    expect(agentCalls.map((c) => [c.callId, c.subagentId ?? null])).toEqual([
      [id(1), null],
      [id(2), null],
      [id(3), id(2)],
    ]);
    expect(texts(events).filter((_, i, all) => all[i]!.startsWith("Sub-task"))).toEqual(["Sub-task 1 is done.", "Sub-task 3 is done.", "Sub-task 2 is done."]);
    const tagged = events.filter((e) => "subagentId" in e && e.subagentId === id(3)).map((e) => e.type);
    expect(tagged).toEqual(["text", "tool_call", "tool_result", "text"]);
    expect(ops.calls.map((c) => c.method)).toEqual(["submitForReview"]);
  });

  test("/agents without a count runs two; the count is capped at five", async () => {
    const count = async (prompt: string) => {
      const { events } = await collect(driver, makeReq("work", prompt).req);
      return new Set(events.filter((e) => e.type === "subagent").map((e) => (e as Extract<DriverEvent, { type: "subagent" }>).subagent.id)).size;
    };
    expect(await count("/agents")).toBe(2);
    expect(await count("/agents 99")).toBe(5);
  });

  test("/block calls block with the question and does not submit", async () => {
    const { req, ops } = makeReq("work", "Please /block Which database should I use?");
    await collect(driver, req);
    expect(ops.calls).toEqual([{ method: "block", args: ["Which database should I use?"] }]);
  });

  test("chat echoes the human's words; [dummy:unblock] then [dummy:submit] or [dummy:block] move the ticket", async () => {
    const note = "\n\n[Harness note: this ticket is blocked on: Which DB?. If this message resolves that, call unblock before you continue the work; if it doesn't, answer and leave the ticket blocked.]";
    const quiet = makeReq("chat", `what are the options?${note}`);
    const q = await collect(driver, quiet.req);
    expect(q.events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(['(dummy chat) You said: "what are the options?"']);
    expect(quiet.ops.calls).toEqual([]);

    const done = makeReq("chat", `Postgres [dummy:unblock] [dummy:submit]${note}`);
    await collect(driver, done.req);
    expect(done.ops.calls.map((c) => c.method)).toEqual(["unblock", "submitForReview"]);

    const again = makeReq("chat", "Postgres [dummy:unblock] [dummy:block]");
    await collect(driver, again.req);
    expect(again.ops.calls.map((c) => c.method)).toEqual(["unblock", "block"]);
  });

  test("/fail yields an error event and throws", async () => {
    const { req, ops } = makeReq("work", "/fail kaboom now");
    const { events, error } = await collect(driver, req);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("kaboom now");
    expect(events.at(-1)).toEqual({ type: "error", message: "kaboom now" });
    expect(ops.calls).toEqual([]);
    expect(events.some((e) => e.type === "state")).toBe(false);
  });

  test("/browse opens the url and reads content in the session tab", async () => {
    const { req, browser, ops } = makeReq("work", "/browse https://example.com/x");
    const { events } = await collect(driver, req);
    expect(calls(events).map((c) => c.name)).toEqual(["browser_open", "browser_content"]);
    expect(browser.calls[0]).toEqual({ method: "open", args: ["s_1", "https://example.com/x"] });
    expect(browser.calls.some((c) => c.method === "content")).toBe(true);
    expect(texts(events).at(-1)).toContain("Example page text");
    expect(ops.calls).toEqual([]);
  });

  test("/bash runs the native bash tool in cwd when present", async () => {
    const dir = tempDir("dummy-bash-");
    const { req } = makeReq("work", "/bash echo hi-$((2+3)) && pwd", { ctx: { cwd: dir } });
    const { events } = await collect(driver, req);
    const r = results(events).find((x) => x.name === "bash")!;
    expect(r.result.isError).toBeFalsy();
    const out = (r.result.content[0] as any).text as string;
    expect(out).toContain("hi-5");
    expect(out).toContain(dir.split("/").pop()!);
    expect(texts(events).at(-1)).toContain("hi-5");
  });

  test("/bash without a bash tool (builtin-tools driver list) makes no tool call", async () => {
    const tools = toolsForRun("work", { hasBuiltinTools: true });
    expect(tools.some((t) => t.name === "bash")).toBe(false);
    const { req, ops } = makeReq("work", "/bash ls", { tools });
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(calls(events)).toEqual([]);
    expect(ops.calls).toEqual([]);
    expect(texts(events).at(-1)).toMatch(/not available/);
  });

  test("review approves by default", async () => {
    const { req, ops } = makeReq("review", "Review TEST-1");
    await collect(driver, req);
    expect(ops.calls.length).toBe(1);
    expect(ops.calls[0]!.method).toBe("reviewDecision");
    expect(ops.calls[0]!.args[0]).toBe("approve");
  });

  test("review requests changes on [dummy:reject]", async () => {
    const { req, ops } = makeReq("review", "Review TEST-1 [dummy:reject]");
    await collect(driver, req);
    expect(ops.calls[0]!.args[0]).toBe("request_changes");
    expect(String(ops.calls[0]!.args[1]).length).toBeGreaterThan(0);
  });

  test("complete posts 'Completed.'", async () => {
    const { req, ops } = makeReq("complete", "Finalize");
    const { events } = await collect(driver, req);
    expect(texts(events).length).toBe(1);
    expect(ops.calls).toEqual([{ method: "postSummary", args: ["Completed."] }]);
  });

  test("conductor first run without bullets: two children, second depends on first", async () => {
    const { req, ops } = makeReq("conductor", "Build the whole site");
    const { events } = await collect(driver, req);
    const creates = ops.calls.filter((c) => c.method === "createTicket").map((c) => c.args[0] as any);
    expect(creates.length).toBe(2);
    expect(creates[0].dependsOn).toBeUndefined();
    expect(creates[1].dependsOn).toEqual([ops.children[0]!.key]);
    expect(lastState(events)!.state.children).toEqual(ops.children.map((c) => c.key));
  });

  test("conductor first run with bullets: one independent child per bullet", async () => {
    const { req, ops } = makeReq("conductor", "Goal:\n- Header\n  - Footer\n* not a dash bullet\n- Sidebar");
    await collect(driver, req);
    const creates = ops.calls.filter((c) => c.method === "createTicket").map((c) => c.args[0] as any);
    expect(creates.map((c) => c.title)).toEqual(["Header", "Footer", "Sidebar"]);
    expect(creates.every((c) => c.dependsOn === undefined)).toBe(true);
  });

  test("conductor later runs: approve+complete reviewed children, submit only when all done", async () => {
    const first = makeReq("conductor", "Build it");
    const r1 = await collect(driver, first.req);
    const state1 = lastState(r1.events)!.state;
    const ops = first.ops;
    const [a, b] = ops.children;

    // a: in review, agent approved, human pending → review_ticket + complete_ticket
    // b: still in progress → untouched
    Object.assign(a!, { status: "review", agentReview: "approved", humanReview: "pending" });
    Object.assign(b!, { status: "in_progress" });
    ops.calls.length = 0;
    const second = makeReq("conductor", "Child ticket updates", { state: state1, ctx: { ops } });
    const r2 = await collect(driver, second.req);
    expect(ops.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["listTickets", { scope: "children", projectKey: undefined, statuses: undefined, limit: 200 }],
      ["reviewTicket", a!.key],
      ["completeTicket", a!.key],
    ]);
    expect(ops.calls[1]!.args[1]).toBe("approve");
    const state2 = lastState(r2.events)!.state;
    expect(state2.turns).toBe(2);
    expect(state2.children).toEqual(state1.children);

    // b: both reviews approved → complete only; a done. Not all done yet.
    Object.assign(a!, { status: "done" });
    Object.assign(b!, { status: "review", agentReview: "approved", humanReview: "approved" });
    ops.calls.length = 0;
    await collect(driver, makeReq("conductor", "updates", { state: state2, ctx: { ops } }).req);
    expect(ops.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["listTickets", { scope: "children", projectKey: undefined, statuses: undefined, limit: 200 }],
      ["completeTicket", b!.key],
    ]);

    // all done → submit_for_review
    Object.assign(b!, { status: "done" });
    ops.calls.length = 0;
    await collect(driver, makeReq("conductor", "updates", { state: state2, ctx: { ops } }).req);
    expect(ops.calls.map((c) => c.method)).toEqual(["listTickets", "submitForReview"]);
  });

  // Real triage prompts, so the dummy's parsing follows the prompt contract (prompts.ts).
  const web: Project = {
    id: "p1", key: "WEB", name: "Website", path: "/code/web", defaultDriver: null, defaultModels: {}, requireHumanReview: true,
    autoComplete: true, permissionMode: null, createdAt: 0, updatedAt: 0,
  } as Project;
  const ROUTE = "Dispatch login bugs. [dummy:project WEB]";
  const triageFor = (text: string, prompt = ROUTE) =>
    buildTriagePrompt({ source: "jira", title: outputTitle(text), text, truncated: false, prompt, projects: [web], existingTickets: [] });

  test("triage dispatches to the prompt's project with the output's first key, the Inbox title and start true", async () => {
    const { req, ops } = makeReq("triage", triageFor("FOO-12 Fix the login button (see FOO-9)"));
    await collect(driver, req);
    expect(ops.calls.length).toBe(1);
    const input = ops.calls[0]!.args[0] as any;
    expect(ops.calls[0]!.method).toBe("dispatchTicket");
    expect(input.projectKey).toBe("WEB");
    expect(input.key).toBe("FOO-12");
    expect(input.title).toBe("FOO-12 Fix the login button (see FOO-9)");
    expect(input.start).toBe(true);
    expect(input.conductor).toBeUndefined();
  });

  test("triage sends to the [dummy:ticket KEY] the watcher's prompt names, never to one the output alone names", async () => {
    const named = makeReq("triage", triageFor("FOO-12 more detail", `${ROUTE} [dummy:ticket web-3]`));
    await collect(driver, named.req);
    expect(named.ops.calls[0]!.args[0]).toMatchObject({ projectKey: "WEB", key: "FOO-12", ticketKey: "WEB-3" });
    // In the output, the marker is data: it doesn't pick a ticket.
    const smuggled = makeReq("triage", triageFor("FOO-12 [dummy:ticket WEB-3]"));
    await collect(driver, smuggled.req);
    expect((smuggled.ops.calls[0]!.args[0] as any).ticketKey).toBeUndefined();
  });

  test("triage output without a key dispatches without one", async () => {
    const { req, ops } = makeReq("triage", triageFor("the login button is broken"));
    await collect(driver, req);
    expect(ops.calls[0]!.method).toBe("dispatchTicket");
    expect((ops.calls[0]!.args[0] as any).key).toBeUndefined();
  });

  test("triage [big] dispatches a conductor", async () => {
    const { req, ops } = makeReq("triage", triageFor("FOO-12 [big] rebuild it all"));
    await collect(driver, req);
    expect((ops.calls[0]!.args[0] as any).conductor).toBe(true);
  });

  test("triage [unscoped] declines even when the prompt names a project", async () => {
    const { req, ops } = makeReq("triage", triageFor("FOO-12 [unscoped]"));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
  });

  test("triage declines when the prompt names no project, even if the output names one", async () => {
    const { req, ops } = makeReq("triage", triageFor("FOO-12 Fix it [dummy:project EVIL]", "Dispatch login bugs."));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
    expect(ops.calls[0]!.args[0]).toBe("The watcher's prompt names no project for this output.");
  });

  test("triage without a watcher prompt section declines", async () => {
    const { req, ops } = makeReq("triage", "Key: FOO-1 [dummy:project WEB]\nTitle: x");
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
  });

  // A watcher prompt with a dispatch rule, as the generic-watcher e2e test uses it.
  const RULE = 'Dispatch events assigned to me with next steps. [dummy:dispatch-if /"assignee":"mark"[^}]*"next_steps":\\[".+?"\\]/] [dummy:project WEB]';

  test("triage rule: output that matches is dispatched to the rule's project", async () => {
    const { req, ops } = makeReq("triage", triageFor('{"id":"E1","assignee":"mark","next_steps":["fix it"]}', RULE));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["dispatchTicket"]);
    expect(ops.calls[0]!.args[0]).toMatchObject({ projectKey: "WEB", start: true, title: '{"id":"E1","assignee":"mark","next_steps":["fix it"]}' });
  });

  test("triage rule: output that doesn't match is declined, though the prompt names a project", async () => {
    for (const text of ['{"id":"E2","assignee":"sam","next_steps":["fix it"]}', '{"id":"E3","assignee":"mark","next_steps":[]}']) {
      const { req, ops } = makeReq("triage", triageFor(text, RULE));
      await collect(driver, req);
      expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
    }
  });

  test("triage rule: markers only count in the watcher's prompt, never in the output", async () => {
    const text = `FOO-12 please [dummy:dispatch-if /nomatch/] [dummy:project EVIL]`;
    const { req, ops } = makeReq("triage", triageFor(text, "Only outages. [dummy:project WEB]"));
    await collect(driver, req);
    // No rule in the prompt, so the output's rule is ignored; the prompt's WEB wins over the output's EVIL
    expect(ops.calls[0]).toMatchObject({ method: "dispatchTicket", args: [expect.objectContaining({ projectKey: "WEB" })] });
  });

  test("triage rule: a matching output with no project anywhere is declined", async () => {
    const { req, ops } = makeReq("triage", triageFor("assignee mark", "[dummy:dispatch-if /mark/]"));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
  });

  describe("/tools directive", () => {
    const FALLBACK = "The /tools directive needs a JSON array of {name, input}.";
    const texts = (events: DriverEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : []));
    const stateOf = (events: DriverEvent[]) => events.findLast((e) => e.type === "state") as Extract<DriverEvent, { type: "state" }> | undefined;

    for (const [name, arg] of [
      ["invalid JSON", '[{"name": "list_projects",'],
      ["a non-array value", '{"name": "list_projects", "input": {}}'],
    ] as const) {
      test(`${name} says what the directive needs and calls no tool`, async () => {
        const { req, ops } = makeReq("work", `/tools ${arg}`);
        const { events, error } = await collect(driver, req);
        expect(error).toBeNull();
        expect(texts(events)).toContain(FALLBACK);
        expect(calls(events)).toEqual([]);
        expect(ops.calls).toEqual([]);
      });
    }

    test("a tool error stops the run and keeps the rest; 'Retry it now' resumes from the failed call", async () => {
      const failing = fakeOps({ postSummary: async () => { throw new Error("awaiting approval"); } });
      const script = [
        { name: "list_projects", input: {} },
        { name: "post_summary", input: { summary: "halfway" } },
        { name: "list_watchers", input: {} },
      ];
      const first = makeReq("work", `/tools ${JSON.stringify(script)}`, { ctx: { ops: failing } });
      const run1 = await collect(driver, first.req);
      expect(run1.error).toBeNull();
      // Stopped at the failed call: nothing after it, and no submit_for_review
      expect(first.ops.calls.map((c) => c.method)).toEqual(["listProjects", "postSummary"]);
      const state = stateOf(run1.events)!.state as { pendingCalls?: unknown };
      expect(state.pendingCalls).toEqual(script.slice(1));

      const retry = makeReq("work", "The human approved your request. Retry it now and continue.", { state });
      await collect(driver, retry.req);
      expect(retry.ops.calls.map((c) => c.method)).toEqual(["postSummary", "listWatchers", "submitForReview"]);
    });
  });

  describe("timing", () => {
    const saved = process.env.HARNESS_DUMMY_DELAY_MS;
    afterEach(() => {
      if (saved === undefined) delete process.env.HARNESS_DUMMY_DELAY_MS;
      else process.env.HARNESS_DUMMY_DELAY_MS = saved;
    });

    test("delayMs is honoured per word", async () => {
      const { req } = makeReq("complete", "x");
      const t0 = performance.now();
      await collect(new DummyDriver({ delayMs: 20 }), req); // "Finalizing the ticket." = 3 words
      expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    });

    test("HARNESS_DUMMY_DELAY_MS=0 makes it fast; default is slower", async () => {
      process.env.HARNESS_DUMMY_DELAY_MS = "0";
      const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
      let t0 = performance.now();
      await collect(new DummyDriver(), makeReq("work", words).req);
      expect(performance.now() - t0).toBeLessThan(200);
      delete process.env.HARNESS_DUMMY_DELAY_MS;
      t0 = performance.now();
      await collect(new DummyDriver(), makeReq("work", words).req); // ≥ 46 words × 15ms
      expect(performance.now() - t0).toBeGreaterThanOrEqual(500);
    });

    test("abort mid-stream stops promptly with AbortError and no tool calls", async () => {
      const ac = new AbortController();
      const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
      const { req, ops } = makeReq("work", words, { signal: ac.signal });
      setTimeout(() => ac.abort(), 60);
      const t0 = performance.now();
      const { events, error } = await collect(new DummyDriver({ delayMs: 20 }), req);
      expect(performance.now() - t0).toBeLessThan(400);
      expect((error as Error).name).toBe("AbortError");
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(events.some((e) => e.type === "text" || e.type === "state")).toBe(false);
      expect(ops.calls).toEqual([]);
    });
  });
});

describe("dummy /approve directive", () => {
  const approveReq = (prompt: string, requestApproval?: (...a: any[]) => any) => {
    const ops = fakeOps(requestApproval ? { requestApproval } : {});
    return makeReq("work", prompt, { tools: toolsForRun("work", driver), ctx: { ops } });
  };

  test("the dummy driver is offered permission_prompt", () => {
    expect(toolsForRun("work", driver).map((t) => t.name)).toContain("permission_prompt");
  });

  test("allowed: asks through permission_prompt with the parsed JSON input, then submits", async () => {
    const { req, ops } = approveReq('/approve Bash {"command":"git init"}');
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(calls(events)[0]).toMatchObject({ name: "permission_prompt", input: { tool_name: "Bash", input: { command: "git init" } } });
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["Bash", { command: "git init" }, { viaPromptTool: true }]);
    expect(texts(events)).toContain("Approved Bash");
    expect(calls(events).map((c) => c.name)).toEqual(["permission_prompt", "submit_for_review"]);
  });

  test("denied: the run stops without submitting", async () => {
    const { req, ops } = approveReq("/approve WebFetch", async () => ({ behavior: "deny", message: "Waiting for the human." }));
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(calls(events).map((c) => c.name)).toEqual(["permission_prompt"]);
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["WebFetch", {}, { viaPromptTool: true }]);
    expect(ops.calls.some((c) => c.method === "submitForReview")).toBe(false);
    expect(texts(events)).not.toContain("Approved WebFetch");
  });

  test("non-JSON input is passed as a command", async () => {
    const { req, ops } = approveReq("/approve Bash rm -rf build");
    await collect(driver, req);
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["Bash", { command: "rm -rf build" }, { viaPromptTool: true }]);
  });

  test("without permission_prompt in the tool list it stops instead of submitting", async () => {
    const { req, ops } = makeReq("work", "/approve Bash {}", { tools: toolsForRun("work", { hasBuiltinTools: false }) });
    const { events } = await collect(driver, req);
    expect(results(events)[0]!.result.isError).toBe(true);
    expect(ops.calls.some((c) => c.method === "submitForReview")).toBe(false);
  });
});

describe("dummy models", () => {
  test("lists dummy-fast (default) and dummy-slow", async () => {
    const models = await driver.listModels();
    expect(models.map((m) => [m.id, !!m.default])).toEqual([
      ["dummy-fast", true],
      ["dummy-slow", false],
    ]);
  });

  test("dummy-slow streams slower than dummy-fast / the default", () => {
    const d = new DummyDriver({ delayMs: 20 });
    expect(d.delayFor(null)).toBe(20);
    expect(d.delayFor("dummy-fast")).toBe(20);
    expect(d.delayFor("dummy-slow")).toBe(200);
    expect(new DummyDriver({ delayMs: 0 }).delayFor("dummy-slow")).toBe(50); // still visibly slow in tests
  });

  test("dummy-slow actually takes longer end to end", async () => {
    const d = new DummyDriver({ delayMs: 5 });
    const timed = async (model: string | null) => {
      const started = Date.now();
      await collect(d, makeReq("complete", "x", { model }).req); // 3 words
      return Date.now() - started;
    };
    expect(await timed("dummy-slow")).toBeGreaterThanOrEqual(140);
    expect(await timed(null)).toBeLessThan(140);
  });

  test("an unknown model fails the run before any output; the model is recorded in state", async () => {
    const bad = await collect(driver, makeReq("work", "hi", { model: "gpt-9" }).req);
    expect(bad.events).toEqual([{ type: "error", message: expect.stringContaining("Unknown dummy model: gpt-9") }]);
    expect((bad.error as Error).message).toContain("gpt-9");
    const ok = await collect(driver, makeReq("complete", "x", { model: "dummy-slow" }).req);
    expect(lastState(ok.events)!.state.model).toBe("dummy-slow");
  });
});
