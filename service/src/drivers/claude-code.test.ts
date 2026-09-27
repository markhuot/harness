import { toolsForRun } from "../tools/index";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunKind, Settings } from "@harness/shared";
import { fakeContext } from "../tools/fakes";
import { buildClaudeArgs, ClaudeCodeDriver, cleanClaudeEnv, StreamJsonParser } from "./claude-code";
import type { DriverEvent, RunRequest } from "./types";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-cc-"));
  dirs.push(d);
  return d;
}

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
}

function setup(opts: { script?: unknown[]; env?: Record<string, string>; settings?: Partial<Settings>; bin?: string; loginUrlTimeoutMs?: number } = {}): Setup {
  const dir = tmp();
  const record = join(dir, "record.ndjson");
  const scriptPath = join(dir, "script.ndjson");
  writeFileSync(scriptPath, (opts.script ?? []).map(line).join("\n") + "\n");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    FAKE_CLAUDE_RECORD: record,
    FAKE_CLAUDE_SCRIPT: scriptPath,
    ...opts.env,
  };
  const driver = new ClaudeCodeDriver({
    settings: () => ({ ...baseSettings, ...opts.settings }),
    bin: opts.bin ?? FAKE,
    env,
    loginUrlTimeoutMs: opts.loginUrlTimeoutMs,
  });
  return {
    dir,
    record,
    driver,
    invocations: () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
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
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
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
  test("maps every message type and skips subagent output", () => {
    const p = new StreamJsonParser();
    const all = [
      init("s-9"),
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "thinking", thinking: "" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__harness__post_summary", input: { summary: "x" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } }] } },
      { type: "assistant", parent_tool_use_id: "task1", message: { content: [{ type: "text", text: "subagent text" }] } },
      { type: "stream_event", parent_tool_use_id: "task1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub" } } },
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
