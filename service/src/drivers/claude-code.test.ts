import { toolsForRun } from "../tools/index";
import { describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunKind, Settings } from "@harness/shared";
import { fakeContext } from "../tools/fakes";
import { buildClaudeArgs, carrySession, claudeProjectDir, ClaudeCodeDriver, cleanClaudeEnv, StreamJsonParser } from "./claude-code";
import type { DriverEvent, RunRequest } from "./types";
import { tempDir } from "@harness/shared/testing";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude.ts");

const tmp = () => tempDir("harness-cc-");

const baseSettings: Settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "ask",
  classifier: "off",
  defaultModels: {},
  reviewModels: {},
  anthropicApiKey: null,
};

function request(over: Partial<RunRequest> = {}): RunRequest {
  const signal = over.signal ?? new AbortController().signal;
  return {
    runId: "run_1",
    kind: "work",
    prompt: "Do the work please",
    systemPrompt: "You are in a harness.",
    cwd: tmp(),
    model: null,
    state: null,
    tools: [],
    toolContext: fakeContext(),
    mcp: { url: "http://127.0.0.1:7717/mcp/tok123", headers: { authorization: "Bearer abc" } },
    signal,
    ...over,
  };
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

interface Setup {
  dir: string;
  record: string;
  driver: ClaudeCodeDriver;
  invocations(): { argv: string[]; stdin: string; cwd: string; env: Record<string, string> }[];
  /** The fake's __mark lines: whether stdin was closed at that point of the script */
  marks(): { label: string; stdinClosed: boolean }[];
}

function setup(
  opts: { script?: unknown[]; env?: Record<string, string>; settings?: Partial<Settings>; bin?: string; loginUrlTimeoutMs?: number; backgroundWaitMs?: number } = {},
): Setup {
  const dir = tmp();
  const record = join(dir, "record.ndjson");
  const scriptPath = join(dir, "script.ndjson");
  writeFileSync(scriptPath, (opts.script ?? []).map(line).join("\n") + "\n");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Never touch the real ~/.claude (carrySession reads and writes the session store).
    CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
    FAKE_CLAUDE_RECORD: record,
    FAKE_CLAUDE_SCRIPT: scriptPath,
    ...opts.env,
  };
  const driver = new ClaudeCodeDriver({
    settings: () => ({ ...baseSettings, ...opts.settings }),
    bin: opts.bin ?? FAKE,
    env,
    loginUrlTimeoutMs: opts.loginUrlTimeoutMs,
    backgroundWaitMs: opts.backgroundWaitMs,
  });
  const ndjson = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return {
    dir,
    record,
    driver,
    invocations: () => ndjson(record),
    marks: () => ndjson(record + ".marks"),
  };
}

async function collect(it: AsyncIterable<DriverEvent>): Promise<{ events: DriverEvent[]; error: unknown }> {
  const events: DriverEvent[] = [];
  try {
    for await (const ev of it) events.push(ev);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

const init = (sessionId = "sess-1") => ({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "mcp__harness__post_summary"] });
const success = (extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "All done",
  session_id: "sess-1",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 42 },
  ...extra,
});

// ---------------------------------------------------------------------------

describe("buildClaudeArgs", () => {
  const req = { kind: "work" as RunKind, systemPrompt: "SYS", mcp: { url: "http://h/mcp/t", headers: { authorization: "Bearer x" } } };

  test("work run: settings permission mode (ask → acceptEdits), mcp config, allowed tools, system prompt, no model/resume", () => {
    const args = buildClaudeArgs(req, { ...baseSettings, permissionMode: "ask" }, null);
    expect(args.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(argValue(args, "--permission-mode")).toBe("acceptEdits");
    expect(argValue(args, "--allowedTools")).toBe("mcp__harness");
    expect(argValue(args, "--append-system-prompt")).toBe("SYS");
    expect(JSON.parse(argValue(args, "--mcp-config")!)).toEqual({
      mcpServers: { harness: { type: "http", url: "http://h/mcp/t", headers: { authorization: "Bearer x" }, alwaysLoad: true } },
    });
    expect(argValue(args, "--permission-prompt-tool")).toBe("mcp__harness__permission_prompt");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--resume");
  });

  test("plan run forces plan mode regardless of settings", () => {
    const args = buildClaudeArgs({ ...req, kind: "plan", permissionMode: "auto" }, { ...baseSettings, permissionMode: "auto" }, null);
    expect(argValue(args, "--permission-mode")).toBe("plan");
  });

  test("model and resume are passed only when set", () => {
    const args = buildClaudeArgs({ ...req, model: "haiku" }, baseSettings, "abc-123");
    expect(argValue(args, "--model")).toBe("haiku");
    expect(argValue(args, "--resume")).toBe("abc-123");
  });

  test("--permission-prompt-tool only when the run serves permission_prompt", () => {
    const withTool = buildClaudeArgs({ ...req, tools: [{ name: "post_summary" }, { name: "permission_prompt" }] }, baseSettings, null);
    const withoutTool = buildClaudeArgs({ ...req, tools: [{ name: "post_summary" }] }, baseSettings, null);
    expect(argValue(withTool, "--permission-prompt-tool")).toBe("mcp__harness__permission_prompt");
    expect(withoutTool).not.toContain("--permission-prompt-tool");
  });

  test("empty system prompt is omitted", () => {
    expect(buildClaudeArgs({ ...req, systemPrompt: "" }, baseSettings, null)).not.toContain("--append-system-prompt");
  });
});

describe("cleanClaudeEnv", () => {
  test("strips nesting vars, keeps user config and unrelated vars", () => {
    const env = cleanClaudeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s",
      CLAUDE_PID: "12",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      HARNESS_MARKER: "m",
      UNDEF: undefined,
    });
    expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok", HARNESS_MARKER: "m" });
  });
});

describe("StreamJsonParser", () => {
  test("maps every message type", () => {
    const p = new StreamJsonParser();
    const all = [
      init("s-9"),
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "thinking", thinking: "" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__harness__post_summary", input: { summary: "x" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } }] } },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Summary posted." }] },
            { type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true },
            { type: "tool_result", tool_use_id: "tu3", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
          ],
        },
      },
      success({ session_id: "s-9" }),
    ].flatMap((m) => p.handle(m));

    expect(all).toEqual([
      { type: "state", state: { sessionId: "s-9", costUsd: 0 } },
      { type: "text_delta", text: "Hel" },
      { type: "thinking", text: "hmm" },
      { type: "text", text: "Hello" },
      { type: "tool_call", callId: "tu1", name: "post_summary", input: { summary: "x" } },
      { type: "tool_call", callId: "tu2", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", callId: "tu1", name: "post_summary", result: { content: [{ type: "text", text: "Summary posted." }] } },
      { type: "tool_result", callId: "tu2", name: "Bash", result: { content: [{ type: "text", text: "boom" }], isError: true } },
      { type: "tool_result", callId: "tu3", name: "unknown", result: { content: [{ type: "image", data: "AAA", mimeType: "image/png" }] } },
      { type: "usage", inputTokens: 1110, outputTokens: 42, costUsd: 0.0123 },
      { type: "state", state: { sessionId: "s-9", costUsd: 0.0123 } },
    ]);
    expect(p.result).toEqual({ isError: false, message: "All done", errors: [] });
  });

  describe("sub-agents", () => {
    const agentCall = (id: string, input: Record<string, unknown>, parent?: string) => ({
      type: "assistant",
      ...(parent ? { parent_tool_use_id: parent } : {}),
      message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
    });
    const result = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "user",
      ...extra,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], ...(extra.is_error ? { is_error: true } : {}) }] },
    });
    const subagentEvents = (evs: DriverEvent[]) => evs.filter((e) => e.type === "subagent").map((e) => (e as Extract<DriverEvent, { type: "subagent" }>).subagent);

    // The shape claude 2.1.283 streams for a background Agent call (recorded, trimmed).
    test("a background agent: started by the tool call, its messages tagged, finished by task_notification", () => {
      const p = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
      p.handle(init("s-1"));
      const started = p.handle(agentCall("toolu_A", { description: "Count files", subagent_type: "general-purpose", prompt: "Run ls" }));
      expect(started).toEqual([
        { type: "tool_call", callId: "toolu_A", name: "Agent", input: { description: "Count files", subagent_type: "general-purpose", prompt: "Run ls" } },
        { type: "subagent", subagent: { id: "toolu_A", parentId: null, description: "Count files", agentType: "general-purpose", prompt: "Run ls", status: "running" } },
      ]);
      const rest = [
        { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_A", description: "Count files", subagent_type: "general-purpose", task_type: "local_agent", prompt: "Run ls" },
        result("toolu_A", "Async agent launched successfully.\nagentId: t1"),
        { type: "stream_event", parent_tool_use_id: "toolu_A", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub" } } },
        { type: "assistant", parent_tool_use_id: "toolu_A", message: { content: [{ type: "tool_use", id: "toolu_B", name: "Bash", input: { command: "ls /tmp" } }] } },
        result("toolu_B", "Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [nope]. If you have other tasks", { parent_tool_use_id: "toolu_A", is_error: true }),
        { type: "assistant", parent_tool_use_id: "toolu_A", message: { content: [{ type: "text", text: "I couldn't run it." }] } },
        { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_A", status: "completed", summary: "I couldn't run it." },
      ].flatMap((m) => p.handle(m));

      // No streaming deltas for sub-agents, and the launch notice isn't an outcome.
      expect(rest.some((e) => e.type === "text_delta")).toBe(false);
      expect(rest.filter((e) => e.type !== "subagent" && e.type !== "permission" && e.type !== "tool_result").map((e) => [e.type, "subagentId" in e ? e.subagentId : null])).toEqual([
        ["tool_call", "toolu_A"],
        ["text", "toolu_A"],
      ]);
      const results = rest.filter((e) => e.type === "tool_result") as Extract<DriverEvent, { type: "tool_result" }>[];
      expect(results.map((r) => [r.callId, r.subagentId ?? null])).toEqual([
        ["toolu_A", null],
        ["toolu_B", "toolu_A"],
      ]);
      // The sub-agent's classifier denial is logged in its transcript, not turned into the run's approval.
      const perm = rest.find((e) => e.type === "permission") as Extract<DriverEvent, { type: "permission" }>;
      expect(perm.subagentId).toBe("toolu_A");
      expect(perm.log.reason).toBe("[nope]");
      expect(rest.some((e) => e.type === "permission_denied")).toBe(false);
      expect(subagentEvents(rest)).toEqual([
        { id: "toolu_A", description: "Count files", agentType: "general-purpose", prompt: "Run ls" },
        { id: "toolu_A", status: "succeeded", result: "I couldn't run it." },
      ]);
    });

    test("a foreground agent (Task on older CLIs) finishes with its tool result; an error result fails it", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "t_ok", name: "Task", input: { description: "Look", prompt: "Look around" } }] } });
      p.handle(agentCall("t_bad", { description: "Break", prompt: "Break things" }));
      const evs = [result("t_ok", "Found 3 files."), result("t_bad", "Agent crashed", { is_error: true })].flatMap((m) => p.handle(m));
      expect(subagentEvents(evs)).toEqual([
        { id: "t_ok", status: "succeeded", result: "Found 3 files." },
        { id: "t_bad", status: "failed", result: "Agent crashed" },
      ]);
    });

    test("an agent started by a sub-agent names its parent", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      p.handle(agentCall("outer", { description: "Outer", prompt: "o" }));
      const nested = subagentEvents(p.handle(agentCall("inner", { description: "Inner", prompt: "i" }, "outer")));
      expect(nested).toEqual([{ id: "inner", parentId: "outer", description: "Inner", agentType: null, prompt: "i", status: "running" }]);
    });

    test("background Bash tasks aren't sub-agents; task_updated finishes an agent by its task id", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      const bash = [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "sleep 9", run_in_background: true } }] } },
        { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "bash1", description: "sleep 9", task_type: "local_bash" },
        { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "bash1", status: "completed", summary: "done" },
      ].flatMap((m) => p.handle(m));
      expect(subagentEvents(bash)).toEqual([]);

      p.handle(agentCall("ag", { description: "Long job", prompt: "p" }));
      p.handle({ type: "system", subtype: "task_started", task_id: "t9", tool_use_id: "ag", task_type: "local_agent" });
      const progress = p.handle({ type: "system", subtype: "task_updated", task_id: "t9", patch: { status: "running" } });
      expect(subagentEvents(progress)).toEqual([]);
      expect(subagentEvents(p.handle({ type: "system", subtype: "task_updated", task_id: "t9", patch: { status: "killed" } }))).toEqual([{ id: "ag", status: "stopped" }]);
    });

    // MEDL-1229: two long composer commands showed up as empty "Sub-agent" rows.
    test("a long Bash call's tool_progress heartbeat (and its task events) is not a sub-agent", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      const evs = [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "composer show -a craftcms/cms" } }] } },
        { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "bash1", description: "Show Craft requirements", is_backgrounded: false, task_type: "local_bash" },
        // Recorded from claude 2.1.283 after 30s of a foreground Bash call.
        { type: "tool_progress", tool_use_id: "bash1-heartbeat-0", tool_name: "Bash", parent_tool_use_id: "bash1", elapsed_time_seconds: 30, heartbeat: true },
        // Nothing but a sub-agent's conversation counts under a parent id, even for a known call.
        { type: "user", parent_tool_use_id: "bash1", message: { content: [{ type: "text", text: "not an agent" }] } },
        result("bash1", "php ^8.2"),
        { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "bash1", status: "completed", summary: "Show Craft requirements" },
      ].flatMap((m) => p.handle(m));
      expect(subagentEvents(evs)).toEqual([]);
      expect(evs.some((e) => "subagentId" in e && e.subagentId)).toBe(false);
      expect(evs.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    });

    test("an agent's own tool_progress and stream events are dropped, its messages kept", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      p.handle(agentCall("ag", { description: "Scan", prompt: "p" }));
      expect(p.handle({ type: "tool_progress", tool_use_id: "ag-heartbeat-0", tool_name: "Agent", parent_tool_use_id: "ag", elapsed_time_seconds: 30 })).toEqual([]);
      expect(p.handle({ type: "assistant", parent_tool_use_id: "ag", message: { content: [{ type: "text", text: "working" }] } })).toEqual([{ type: "text", text: "working", subagentId: "ag" }]);
    });

    test("output from a sub-agent the run didn't see start still gets a sub-agent", () => {
      const p = new StreamJsonParser();
      p.handle(init("s-1"));
      const evs = p.handle({ type: "assistant", parent_tool_use_id: "old", message: { content: [{ type: "text", text: "picking up" }] } });
      expect(evs).toEqual([
        { type: "subagent", subagent: { id: "old", description: "Sub-agent" } },
        { type: "text", text: "picking up", subagentId: "old" },
      ]);
      expect(p.handle({ type: "assistant", parent_tool_use_id: "old", message: { content: [{ type: "text", text: "again" }] } })).toEqual([{ type: "text", text: "again", subagentId: "old" }]);
    });
  });

  test("result state carries the session id seen last", () => {
    const p = new StreamJsonParser();
    expect(p.handle(init("a"))).toEqual([{ type: "state", state: { sessionId: "a", costUsd: 0 } }]);
    const states = p.handle(success({ session_id: "b" })).filter((e) => e.type === "state");
    expect(states.at(-1)).toEqual({ type: "state", state: { sessionId: "b", costUsd: 0.0123 } });
  });

  test("resumed session: cumulative total_cost_usd is reported as this run's delta", () => {
    const p = new StreamJsonParser({ sessionId: "a", costUsd: 0.05 });
    expect(p.handle(init("a"))).toEqual([{ type: "state", state: { sessionId: "a", costUsd: 0.05 } }]);
    const evs = p.handle(success({ session_id: "a", total_cost_usd: 0.08 }));
    expect((evs.find((e) => e.type === "usage") as { costUsd: number }).costUsd).toBeCloseTo(0.03, 10);
    expect(evs.at(-1)).toEqual({ type: "state", state: { sessionId: "a", costUsd: 0.08 } });
  });

  test("baseline does not apply to a different (forked/fresh) session", () => {
    const p = new StreamJsonParser({ sessionId: "a", costUsd: 0.05 });
    p.handle(init("z"));
    const usage = p.handle(success({ session_id: "z", total_cost_usd: 0.08 })).find((e) => e.type === "usage") as { costUsd: number };
    expect(usage.costUsd).toBe(0.08);
  });

  test("error subtype without is_error still counts as an error; message falls back to errors then subtype", () => {
    const p = new StreamJsonParser();
    p.handle({ type: "result", subtype: "error_max_turns", errors: ["too many turns"], usage: {} });
    expect(p.result).toEqual({ isError: true, message: "too many turns", errors: ["too many turns"] });
    const p2 = new StreamJsonParser();
    p2.handle({ type: "result", subtype: "error_during_execution", is_error: true, usage: {} });
    expect(p2.result?.message).toBe("claude ended with error_during_execution");
  });
});

// ---------------------------------------------------------------------------

// Shapes recorded from claude 2.1.284 (trimmed).
const bashCall = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, ...extra } }] },
});
const toolResult = (id: string, text: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const taskStarted = (taskId: string, callId: string, description: string, taskType = "local_bash") => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: callId,
  description,
  task_type: taskType,
});
const taskDone = (taskId: string, callId: string, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: callId, status });
const BG = (taskId: string) => `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x/tasks/${taskId}.output.`;
const TIMED_OUT = (taskId: string) =>
  `Command did not complete within its 120s timeout and was moved to the background (ID: ${taskId}). Output is being written to: /tmp/x/tasks/${taskId}.output. You will be notified when it completes.`;

describe("StreamJsonParser background tasks", () => {
  test("a background command runs until its notification; a foreground one ends with its result", () => {
    const p = new StreamJsonParser();
    p.handle(init());
    [bashCall("c1", "bun test", { run_in_background: true }), taskStarted("b1", "c1", "Run tests"), toolResult("c1", BG("b1"))].forEach((m) => p.handle(m));
    [bashCall("c2", "composer show"), taskStarted("b2", "c2", "Show deps"), toolResult("c2", "php ^8.2")].forEach((m) => p.handle(m));
    expect([...p.runningTasks.values()]).toEqual(["Run tests"]);
    p.handle(taskDone("b1", "c1"));
    expect(p.runningTasks.size).toBe(0);
  });

  // HARNESS-81: the suite hit Bash's 120s timeout, was moved to the background, and was killed.
  test("a command moved to the background by its timeout keeps running", () => {
    const p = new StreamJsonParser();
    p.handle(init());
    [bashCall("c1", "bun test"), taskStarted("b1", "c1", "Run suites"), toolResult("c1", TIMED_OUT("b1"))].forEach((m) => p.handle(m));
    expect([...p.runningTasks.keys()]).toEqual(["b1"]);
    p.handle({ type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "running" } });
    expect(p.runningTasks.size).toBe(1);
    p.handle({ type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "killed" } });
    expect(p.runningTasks.size).toBe(0);
  });

  test("a Monitor and an async agent keep running past their tool results", () => {
    const p = new StreamJsonParser();
    p.handle(init());
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: "until …; done" } }] } });
    p.handle(taskStarted("bm", "m1", "Wait for flag"));
    p.handle(toolResult("m1", "Monitor started (task bm, expires in 5m unless the source ends first)."));
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Mac UI", prompt: "p" } }] } });
    p.handle(taskStarted("ta", "a1", "Mac UI", "local_agent"));
    p.handle(toolResult("a1", "Async agent launched successfully. agentId: ta"));
    expect([...p.runningTasks.values()]).toEqual(["Wait for flag", "Mac UI"]);
  });

  test("only a top-level finishing tool marks the run finished", () => {
    const p = new StreamJsonParser();
    p.handle(init());
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "d", prompt: "p" } }] } });
    p.handle({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "x", name: "mcp__harness__submit_for_review", input: {} }] } });
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "y", name: "mcp__harness__post_summary", input: {} }] } });
    expect(p.finished).toBe(false);
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "z", name: "mcp__harness__block", input: { question: "?" } }] } });
    expect(p.finished).toBe(true);
  });

  test("a second turn in the same process is charged only its own cost", () => {
    const p = new StreamJsonParser({ sessionId: "sess-1", costUsd: 1 }, { requested: "auto", mode: "auto" });
    const first = [{ ...init(), permissionMode: "default" }, success({ total_cost_usd: 1.5 })].flatMap((m) => p.handle(m));
    const second = [{ ...init(), permissionMode: "default" }, success({ total_cost_usd: 1.75 })].flatMap((m) => p.handle(m));
    const cost = (evs: DriverEvent[]) => (evs.find((e) => e.type === "usage") as { costUsd: number }).costUsd;
    expect(cost(first)).toBeCloseTo(0.5, 10);
    expect(cost(second)).toBeCloseTo(0.25, 10);
    // The mode downgrade is reported on the first turn only.
    expect(first.filter((e) => e.type === "status")).toHaveLength(1);
    expect(second.filter((e) => e.type === "status")).toHaveLength(0);
  });
});

describe("ClaudeCodeDriver.run (fake binary)", () => {
  test("spawns with argv, stdin prompt, cwd and a cleaned env; streams parsed events", async () => {
    const s = setup({
      script: [
        init("sess-1"),
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } },
        { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } },
        "not json at all",
        success(),
      ],
      env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_BEDROCK: "0", HARNESS_MARKER: "yes" },
      settings: { permissionMode: "auto" },
    });
    const req = request({ prompt: "Line one\nLine \"two\"", model: "sonnet", tools: toolsForRun("work", s.driver) });
    const { events, error } = await collect(s.driver.run(req));
    expect(error).toBeNull();
    expect(events).toEqual([
      { type: "state", state: { sessionId: "sess-1", costUsd: 0 } },
      { type: "text_delta", text: "Hi" },
      { type: "text", text: "Hi there" },
      { type: "usage", inputTokens: 1110, outputTokens: 42, costUsd: 0.0123 },
      { type: "state", state: { sessionId: "sess-1", costUsd: 0.0123 } },
    ]);
    const [inv] = s.invocations();
    expect(inv!.stdin).toBe("Line one\nLine \"two\"");
    // macOS tmp dirs resolve through /private
    expect(inv!.cwd.replace(/^\/private/, "")).toBe(req.cwd.replace(/^\/private/, ""));
    expect(inv!.argv).toEqual(buildClaudeArgs(req, { ...baseSettings, permissionMode: "auto" }, null));
    expect(argValue(inv!.argv, "--model")).toBe("sonnet");
    expect(argValue(inv!.argv, "--permission-prompt-tool")).toBe("mcp__harness__permission_prompt");
    expect(inv!.env.CLAUDECODE).toBeUndefined();
    expect(inv!.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(inv!.env.CLAUDE_CODE_USE_BEDROCK).toBe("0");
    expect(inv!.env.HARNESS_MARKER).toBe("yes");
    // The first turn waits for claude.ai connectors instead of starting without their tools.
    expect(inv!.env.MCP_CONNECTION_NONBLOCKING).toBe("0");
  });

  test("a user's own MCP_CONNECTION_NONBLOCKING reaches the run unchanged", async () => {
    const s = setup({ script: [init("sess-1"), success()], env: { MCP_CONNECTION_NONBLOCKING: "1" } });
    const { error } = await collect(s.driver.run(request({ tools: toolsForRun("work", s.driver) })));
    expect(error).toBeNull();
    expect(s.invocations()[0]!.env.MCP_CONNECTION_NONBLOCKING).toBe("1");
  });

  test("error result yields an error event and throws", async () => {
    const s = setup({ script: [init(), { type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded", usage: {} }] });
    const { events, error } = await collect(s.driver.run(request()));
    expect(events.at(-1)).toEqual({ type: "error", message: "API Error: 529 overloaded" });
    expect((error as Error).message).toBe("API Error: 529 overloaded");
  });

  test("non-zero exit without a result reports the stderr tail (minus cert warnings)", async () => {
    const s = setup({ script: [{ __stderr: "warn: ignoring extra certs from x" }, { __stderr: "Error: invalid --mcp-config" }, { __exit: 3 }] });
    const { events, error } = await collect(s.driver.run(request()));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toBe("claude exited with code 3: Error: invalid --mcp-config");
    expect((error as Error).message).toBe(err.message);
  });

  test("resumes with the stored session id", async () => {
    const s = setup({ script: [{ __echo_session: true }, success({ session_id: "old-sess" })] });
    const { events, error } = await collect(s.driver.run(request({ state: { sessionId: "old-sess", costUsd: 0.01 } })));
    expect(error).toBeNull();
    expect(argValue(s.invocations()[0]!.argv, "--resume")).toBe("old-sess");
    expect(events[0]).toEqual({ type: "state", state: { sessionId: "old-sess", costUsd: 0.01 } });
    expect((events.find((e) => e.type === "usage") as { costUsd: number }).costUsd).toBeCloseTo(0.0023, 10);
  });

  test("a session started in another workdir is copied under the new one before --resume (update_branch moved the ticket)", async () => {
    const s = setup({ script: [{ __echo_session: true }, success({ session_id: "sess-1" })] });
    const config = join(s.dir, "claude-config");
    const oldDir = claudeProjectDir(config, "/Users/me/.harness/worktrees/MEDL-1");
    mkdirSync(join(oldDir, "sess-1", "subagents"), { recursive: true });
    writeFileSync(join(oldDir, "sess-1.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(oldDir, "sess-1", "subagents", "a.jsonl"), "{}\n");
    const cwd = tmp();
    const { error } = await collect(s.driver.run(request({ cwd, state: { sessionId: "sess-1" } })));
    expect(error).toBeNull();
    expect(argValue(s.invocations()[0]!.argv, "--resume")).toBe("sess-1");
    const newDir = claudeProjectDir(config, realpathSync(cwd));
    expect(readFileSync(join(newDir, "sess-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect(existsSync(join(newDir, "sess-1", "subagents", "a.jsonl"))).toBe(true);
    // Copied, not moved.
    expect(existsSync(join(oldDir, "sess-1.jsonl"))).toBe(true);
  });

  test("carrySession: nothing to copy when the session is already under the workdir or can't be found", () => {
    const config = join(tmp(), "cfg");
    const cwd = tmp();
    expect(carrySession(config, "nope", cwd)).toBe(false); // no projects folder at all
    const here = claudeProjectDir(config, realpathSync(cwd));
    mkdirSync(here, { recursive: true });
    writeFileSync(join(here, "s2.jsonl"), "x");
    expect(carrySession(config, "s2", cwd)).toBe(true);
    expect(readdirSync(join(config, "projects"))).toEqual([basename(here)]);
    expect(carrySession(config, "missing", cwd)).toBe(false);
    // Session ids are file names: anything path-like is refused.
    expect(carrySession(config, "../s2", cwd)).toBe(false);
  });

  test("a missing session is retried once without --resume, leaking nothing from the failed attempt", async () => {
    const s = setup({ script: [{ __echo_session: true }, success({ session_id: "new-session" })], env: { FAKE_CLAUDE_MISSING_SESSION: "gone" } });
    const { events, error } = await collect(s.driver.run(request({ state: { sessionId: "gone", costUsd: 5 } })));
    expect(error).toBeNull();
    const invs = s.invocations();
    expect(invs).toHaveLength(2);
    expect(argValue(invs[0]!.argv, "--resume")).toBe("gone");
    expect(invs[1]!.argv).not.toContain("--resume");
    expect(invs[1]!.stdin).toBe("Do the work please");
    // no usage/error events from the failed attempt
    expect(events).toEqual([
      { type: "state", state: { sessionId: "new-session", costUsd: 0 } },
      { type: "usage", inputTokens: 1110, outputTokens: 42, costUsd: 0.0123 },
      { type: "state", state: { sessionId: "new-session", costUsd: 0.0123 } },
    ]);
  });

  test("abort kills the child and rejects with AbortError promptly", async () => {
    const s = setup({ script: [init(), { __sleep: 10_000 }, success()] });
    const ac = new AbortController();
    const started = Date.now();
    const events: DriverEvent[] = [];
    let error: unknown = null;
    try {
      for await (const ev of s.driver.run(request({ signal: ac.signal }))) {
        events.push(ev);
        ac.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect((error as Error).name).toBe("AbortError");
    expect(events).toEqual([{ type: "state", state: { sessionId: "sess-1", costUsd: 0 } }]);
  });

  test("already-aborted signal never spawns", async () => {
    const s = setup({ script: [init(), success()] });
    const ac = new AbortController();
    ac.abort();
    const { error } = await collect(s.driver.run(request({ signal: ac.signal })));
    expect((error as Error).name).toBe("AbortError");
    expect(s.invocations()).toHaveLength(0);
  });

  test("the prompt goes in as a stream-json user message", async () => {
    const s = setup({ script: [init(), success()] });
    await collect(s.driver.run(request({ prompt: "Hi" })));
    const argv = s.invocations()[0]!.argv;
    expect(argValue(argv, "--input-format")).toBe("stream-json");
    expect(s.invocations()[0]!.stdin).toBe("Hi");
  });

  // HARNESS-81: the agent moved its test run to the background and ended the turn to wait for
  // it; closing stdin at that result made the CLI kill the run and the ticket went to review.
  test("a turn that ends with a background task keeps the CLI alive until the task's turn finishes", async () => {
    const s = setup({
      script: [
        init(),
        bashCall("c1", "bun test"),
        taskStarted("b1", "c1", "Run suites"),
        toolResult("c1", TIMED_OUT("b1")),
        { type: "assistant", message: { content: [{ type: "text", text: "I'll be notified when the background test run completes." }] } },
        success({ result: "I'll be notified when the background test run completes.", total_cost_usd: 0.01 }),
        { __sleep: 200 },
        { __mark: "after first turn" },
        taskDone("b1", "c1"),
        init(),
        { type: "assistant", message: { content: [{ type: "text", text: "All suites pass." }] } },
        success({ result: "All suites pass.", total_cost_usd: 0.03 }),
      ],
    });
    const { events, error } = await collect(s.driver.run(request()));
    expect(error).toBeNull(); // the fake exits 7 if stdin is never closed
    expect(s.marks()).toEqual([{ label: "after first turn", stdinClosed: false }]);
    expect(events.filter((e) => e.type === "status")).toEqual([
      { type: "status", text: "Waiting for a background task to finish (Run suites), up to 30 min." },
    ]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual([
      "I'll be notified when the background test run completes.",
      "All suites pass.",
    ]);
    const costs = events.filter((e) => e.type === "usage").map((e) => (e as { costUsd: number }).costUsd);
    expect(costs[0]).toBeCloseTo(0.01, 10);
    expect(costs[1]).toBeCloseTo(0.02, 10);
  });

  test("a turn that submitted ends even with a background dev server still running", async () => {
    const s = setup({
      script: [
        init(),
        bashCall("c1", "bun run dev", { run_in_background: true }),
        taskStarted("b1", "c1", "Start dev server"),
        toolResult("c1", BG("b1")),
        { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "mcp__harness__submit_for_review", input: { summary: "Done" } }] } },
        success(),
        { __until_stdin_closed: true },
        { __mark: "after result" },
        taskDone("b1", "c1", "stopped"),
      ],
    });
    const { events, error } = await collect(s.driver.run(request()));
    expect(error).toBeNull();
    expect(s.marks()).toEqual([{ label: "after result", stdinClosed: true }]);
    expect(events.some((e) => e.type === "status")).toBe(false);
  });

  test("an error result ends the turn even with a background task running", async () => {
    const s = setup({
      script: [init(), bashCall("c1", "sleep 99", { run_in_background: true }), taskStarted("b1", "c1", "Sleep"), toolResult("c1", BG("b1")), success({ is_error: true, result: "API Error: 529" }), { __until_stdin_closed: true }, { __mark: "after" }],
    });
    const { error } = await collect(s.driver.run(request()));
    expect((error as Error).message).toBe("API Error: 529");
    expect(s.marks()).toEqual([{ label: "after", stdinClosed: true }]);
  });

  test("a background task that never finishes ends the turn after the wait limit", async () => {
    const s = setup({
      backgroundWaitMs: 300,
      script: [
        init(),
        bashCall("c1", "tail -f log", { run_in_background: true }),
        taskStarted("b1", "c1", "Follow log"),
        toolResult("c1", BG("b1")),
        success(),
        { __sleep: 100 },
        { __mark: "before limit" },
        { __until_stdin_closed: true },
        { __mark: "after limit" },
        taskDone("b1", "c1", "stopped"),
      ],
    });
    const started = Date.now();
    const { events, error } = await collect(s.driver.run(request()));
    expect(error).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.marks()).toEqual([
      { label: "before limit", stdinClosed: false },
      { label: "after limit", stdinClosed: true },
    ]);
    expect(events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text)).toEqual([
      "Waiting for a background task to finish (Follow log), up to 1s.",
      "Background tasks were still running after 1s, so the turn ended and they were stopped.",
    ]);
  });
});

describe("ClaudeCodeDriver.info / login", () => {
  test("logged in: detail is email · org (subscription)", async () => {
    const s = setup({ env: { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, email: "mark@example.com", orgName: "Happy Cog", subscriptionType: "team" }) } });
    const info = await s.driver.info();
    expect(info).toMatchObject({ id: "claude-code", available: true, authenticated: true, supportsLogin: true, detail: "mark@example.com · Happy Cog (team)" });
    expect(s.invocations()[0]!.argv).toEqual(["auth", "status", "--json"]);
  });

  test("logged out", async () => {
    const s = setup({ env: { FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: false }) } });
    expect(await s.driver.info()).toMatchObject({ available: true, authenticated: false });
  });

  test("missing binary → unavailable", async () => {
    const s = setup({ bin: "/nonexistent/claude" });
    expect(await s.driver.info()).toMatchObject({ available: false, authenticated: false });
  });

  test("login returns the printed URL while the CLI keeps running", async () => {
    const s = setup({ env: { FAKE_CLAUDE_LOGIN_URL: "https://claude.ai/oauth/authorize?code=true&state=xyz", FAKE_CLAUDE_LOGIN_SLEEP: "3000" } });
    const started = Date.now();
    const res = await s.driver.login();
    expect(res.url).toBe("https://claude.ai/oauth/authorize?code=true&state=xyz");
    expect(Date.now() - started).toBeLessThan(2500); // didn't wait for the child to exit
    expect(s.invocations()[0]!.argv).toEqual(["auth", "login", "--claudeai"]);
  });

  test("login without a URL returns null", async () => {
    const s = setup({ env: { FAKE_CLAUDE_LOGIN_SLEEP: "2000" }, loginUrlTimeoutMs: 300 });
    const started = Date.now();
    const res = await s.driver.login();
    expect(res.url).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
