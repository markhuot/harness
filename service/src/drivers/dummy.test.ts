import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunKind } from "@harness/shared";
import { fakeBrowser, fakeContext, fakeOps } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
import type { ToolContext, ToolDefinition } from "../tools/types";
import { DummyDriver } from "./dummy";
import type { DriverEvent, RunRequest } from "./types";

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

  test("/block calls block with the question and does not submit", async () => {
    const { req, ops } = makeReq("work", "Please /block Which database should I use?");
    await collect(driver, req);
    expect(ops.calls).toEqual([{ method: "block", args: ["Which database should I use?"] }]);
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
    const dir = mkdtempSync(join(tmpdir(), "dummy-bash-"));
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
      ["listTickets", "children"],
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
      ["listTickets", "children"],
      ["completeTicket", b!.key],
    ]);

    // all done → submit_for_review
    Object.assign(b!, { status: "done" });
    ops.calls.length = 0;
    await collect(driver, makeReq("conductor", "updates", { state: state2, ctx: { ops } }).req);
    expect(ops.calls.map((c) => c.method)).toEqual(["listTickets", "submitForReview"]);
  });

  const triagePrompt = (extra: string, suggestion = "WEB") =>
    `New work item from watcher "jira".\nKey: FOO-12\nTitle: Fix the login button ${extra}\nURL: https://jira/FOO-12\nSuggested project: ${suggestion}\n\nMore text`;

  test("triage dispatches with parsed key/title and start true", async () => {
    const { req, ops } = makeReq("triage", triagePrompt(""));
    await collect(driver, req);
    expect(ops.calls.length).toBe(1);
    const input = ops.calls[0]!.args[0] as any;
    expect(ops.calls[0]!.method).toBe("dispatchTicket");
    expect(input.projectKey).toBe("WEB");
    expect(input.key).toBe("FOO-12");
    expect(input.title).toBe("Fix the login button");
    expect(input.start).toBe(true);
    expect(input.conductor).toBeUndefined();
  });

  test("triage [big] dispatches a conductor", async () => {
    const { req, ops } = makeReq("triage", triagePrompt("[big]"));
    await collect(driver, req);
    expect((ops.calls[0]!.args[0] as any).conductor).toBe(true);
  });

  test("triage [unscoped] declines even with a suggestion", async () => {
    const { req, ops } = makeReq("triage", triagePrompt("[unscoped]"));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
  });

  test("triage with 'Suggested project: none' declines", async () => {
    const { req, ops } = makeReq("triage", triagePrompt("", "none"));
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
  });

  test("triage without any suggestion line declines", async () => {
    const { req, ops } = makeReq("triage", "Key: FOO-1\nTitle: x");
    await collect(driver, req);
    expect(ops.calls.map((c) => c.method)).toEqual(["declineWork"]);
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
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["Bash", { command: "git init" }]);
    expect(texts(events)).toContain("Approved Bash");
    expect(calls(events).map((c) => c.name)).toEqual(["permission_prompt", "submit_for_review"]);
  });

  test("denied: the run stops without submitting", async () => {
    const { req, ops } = approveReq("/approve WebFetch", async () => ({ behavior: "deny", message: "Waiting for the human." }));
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(calls(events).map((c) => c.name)).toEqual(["permission_prompt"]);
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["WebFetch", {}]);
    expect(ops.calls.some((c) => c.method === "submitForReview")).toBe(false);
    expect(texts(events)).not.toContain("Approved WebFetch");
  });

  test("non-JSON input is passed as a command", async () => {
    const { req, ops } = approveReq("/approve Bash rm -rf build");
    await collect(driver, req);
    expect(ops.calls.find((c) => c.method === "requestApproval")!.args).toEqual(["Bash", { command: "rm -rf build" }]);
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
