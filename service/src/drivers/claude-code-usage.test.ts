import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { fakeContext } from "../tools/fakes";
import { ClaudeCodeDriver, parseClaudeUsage, StreamJsonParser } from "./claude-code";
import { PlanUsageError, type DriverEvent, type RunRequest } from "./types";

const settings = (over: Partial<Settings> = {}): Settings => ({ defaultDriver: "claude-code", maxConcurrentRuns: 4, permissionMode: "ask", classifier: "off", defaultModels: {}, reviewModels: {}, anthropicApiKey: null, ...over });

const assistant = (id: string, usage: object, content: object[] = [{ type: "text", text: "hi" }], extra: object = {}) => ({
  type: "assistant",
  message: { id, model: "claude-opus-5-5", content, usage },
  session_id: "s1",
  ...extra,
});
const calls = (events: DriverEvent[]) => events.filter((e): e is Extract<DriverEvent, { type: "call" }> => e.type === "call").map((e) => e.call);

describe("StreamJsonParser: per-call usage", () => {
  test("each model call reports its cache split once, however many content blocks it streams", () => {
    const p = new StreamJsonParser();
    const usage = { input_tokens: 3, cache_creation_input_tokens: 700, cache_read_input_tokens: 40_000, output_tokens: 9 };
    const out = [
      ...p.handle(assistant("msg_1", usage, [{ type: "thinking", thinking: "hmm" }])),
      ...p.handle(assistant("msg_1", usage, [{ type: "text", text: "ok" }])), // same message, second block
      ...p.handle(assistant("msg_2", { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 40_700, output_tokens: 4 })),
    ];
    expect(calls(out)).toEqual([
      { input: 3, cacheWrite: 700, cacheRead: 40_000, output: 9 },
      { input: 2, cacheWrite: 10, cacheRead: 40_700, output: 4 },
    ]);
  });

  test("a sub-agent's calls and the CLI's synthetic messages aren't the conversation", () => {
    const p = new StreamJsonParser();
    const usage = { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 };
    p.handle(assistant("msg_a", usage, [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "d", subagent_type: "Explore", prompt: "p" } }]));
    expect(calls(p.handle(assistant("msg_sub", usage, [{ type: "text", text: "found" }], { parent_tool_use_id: "toolu_agent" })))).toEqual([]);
    const synthetic = { ...assistant("msg_x", usage), message: { id: "msg_x", model: "<synthetic>", content: [{ type: "text", text: "API Error" }], usage } };
    expect(calls(p.handle(synthetic))).toEqual([]);
  });

  test("an assistant message without usage reports no call", () => {
    const p = new StreamJsonParser();
    expect(calls(p.handle({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "x" }] } }))).toEqual([]);
  });
});

describe("StreamJsonParser: rate limits and compaction", () => {
  test("rate_limit_event reports each window's used share and reset, in ms", () => {
    const p = new StreamJsonParser();
    const ev = p.handle({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1791631200,
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791631200 }, seven_day: { utilization: 0.1, resetsAt: 1792101600 } },
      },
    });
    expect(ev).toEqual([
      {
        type: "rate_limit",
        status: "allowed_warning",
        windows: [
          { id: "five_hour", used: 0.08, resetsAt: 1791631200_000 },
          { id: "seven_day", used: 0.1, resetsAt: 1792101600_000 },
        ],
      },
    ]);
  });

  test("a rate_limit_event with no window detail still names the window it's about, without a percentage", () => {
    const p = new StreamJsonParser();
    expect(p.handle({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791631200, rateLimitType: "seven_day" } })).toEqual([
      { type: "rate_limit", status: "rejected", windows: [{ id: "seven_day", used: null, resetsAt: 1791631200_000 }] },
    ]);
  });

  test("compact_boundary reports the conversation's size before and after", () => {
    const p = new StreamJsonParser();
    expect(p.handle({ type: "system", subtype: "compact_boundary", session_id: "s1", compact_metadata: { trigger: "manual", pre_tokens: 35961, post_tokens: 4535 } })).toContainEqual({
      type: "compacted",
      before: 35961,
      after: 4535,
    });
  });
});

describe("parseClaudeUsage", () => {
  test("reads the windows the account has, with their lengths", () => {
    const w = parseClaudeUsage({
      five_hour: { utilization: 8.0, resets_at: "2026-10-10T11:19:59.746288+00:00" },
      seven_day: { utilization: 11, resets_at: "2026-10-15T21:59:59.746312+00:00" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 3.5, resets_at: "2026-10-15T22:00:00+00:00" },
      extra_usage: { utilization: 50 },
    });
    expect(w.map((x) => [x.id, x.label, x.usedPercent, x.windowSeconds])).toEqual([
      ["five_hour", "5-hour", 8, 18_000],
      ["seven_day", "Weekly", 11, 604_800],
      ["seven_day_sonnet", "Weekly · Sonnet", 3.5, 604_800],
    ]);
    expect(w[0]!.resetsAt).toBe(Date.parse("2026-10-10T11:19:59.746288+00:00"));
  });

  test("a body with no usable window is an error, not an empty bar", () => {
    expect(() => parseClaudeUsage({ five_hour: null, seven_day: { utilization: "lots", resets_at: "soon" } })).toThrow(PlanUsageError);
  });
});

describe("ClaudeCodeDriver.planUsage", () => {
  const body = { five_hour: { utilization: 20, resets_at: "2026-10-10T11:00:00+00:00" } };
  const json = (status: number, b: unknown = body) => new Response(JSON.stringify(b), { status });

  function driver(answers: (token: string) => Response | Promise<Response>, over: { stored?: string | null; login?: string[] } = {}) {
    const seen: { token: string; headers: Headers }[] = [];
    const d = new ClaudeCodeDriver({
      settings: () => settings({ claudeOauthToken: over.stored ?? null }),
      fetch: (async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const token = headers.get("authorization")!.replace("Bearer ", "");
        seen.push({ token, headers });
        return answers(token);
      }) as never,
      loginTokens: async () => over.login ?? [],
    });
    return { d, seen };
  }

  test("sends the token and the headers the endpoint needs", async () => {
    const { d, seen } = driver(() => json(200), { login: ["login-token"] });
    const w = await d.planUsage();
    expect(w![0]).toMatchObject({ id: "five_hour", usedPercent: 20 });
    expect(seen[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(seen[0]!.headers.get("user-agent")).toMatch(/^claude-code\//);
  });

  test("tries the stored token first and falls back to the CLI's login when it's refused", async () => {
    const { d, seen } = driver((t) => (t === "stored" ? json(401, {}) : json(200)), { stored: "stored", login: ["login-token"] });
    await d.planUsage();
    expect(seen.map((s) => s.token)).toEqual(["stored", "login-token"]);
  });

  test("with no token anywhere it asks to sign in; when every token is refused it says the same", async () => {
    await expect(driver(() => json(200)).d.planUsage()).rejects.toThrow("Sign in to Claude Code to see plan usage");
    await expect(driver(() => json(401, {}), { login: ["a", "b"] }).d.planUsage()).rejects.toThrow("Sign in to Claude Code to see plan usage");
  });

  test("a 429 or 5xx is transient (the poller backs off); a network failure too", async () => {
    for (const status of [429, 503]) {
      const err = await driver(() => json(status, {}), { login: ["t"] }).d.planUsage().catch((e) => e);
      expect(err).toBeInstanceOf(PlanUsageError);
      expect((err as PlanUsageError).transient).toBe(true);
    }
    const down = await driver(() => Promise.reject(new Error("offline")), { login: ["t"] }).d.planUsage().catch((e) => e);
    expect((down as PlanUsageError).transient).toBe(true);
    expect((down as PlanUsageError).message).toContain("offline");
  });
});

describe("ClaudeCodeDriver.compact", () => {
  /** A stand-in `claude` that records its argv and replays what the real CLI printed for `/compact`. */
  function fakeClaude(lines: object[], exit = 0) {
    const dir = tempDir("harness-compact-");
    const bin = join(dir, "claude");
    const record = join(dir, "argv.json");
    writeFileSync(
      bin,
      `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n` +
        lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join("\n") +
        `\nprocess.exit(${exit});\n`,
    );
    chmodSync(bin, 0o755);
    return { bin, dir, argv: () => JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; cwd: string } };
  }

  const request = (over: Partial<RunRequest> = {}): RunRequest => ({
    runId: "run_c",
    kind: "compact",
    prompt: "/compact",
    systemPrompt: "",
    cwd: tempDir("harness-compact-cwd-"),
    model: "haiku",
    state: { sessionId: "sess-1", costUsd: 1.5 },
    tools: [],
    toolContext: fakeContext(),
    mcp: { url: "", headers: {} },
    signal: new AbortController().signal,
    ...over,
  });
  const run = async (d: ClaudeCodeDriver, req: RunRequest) => {
    const out: DriverEvent[] = [];
    for await (const e of d.compact(req)) out.push(e);
    return out;
  };
  const home = () => {
    const dir = tempDir("harness-compact-home-");
    mkdirSync(dir, { recursive: true });
    return { CLAUDE_CONFIG_DIR: dir };
  };

  test("resumes the saved session with /compact as the prompt and reports the sizes, without reporting the compact run's own text or calls", async () => {
    const f = fakeClaude([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "system", subtype: "compact_boundary", session_id: "sess-1", compact_metadata: { trigger: "manual", pre_tokens: 482_000, post_tokens: 61_000 } },
      assistant("msg_c", { input_tokens: 5, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0, output_tokens: 700 }),
      { type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 1.75, usage: {} },
    ]);
    const d = new ClaudeCodeDriver({ settings: () => settings(), bin: f.bin, env: home() });
    const events = await run(d, request());
    expect(f.argv().argv).toEqual(["-p", "/compact", "--output-format", "stream-json", "--verbose", "--resume", "sess-1", "--model", "haiku"]);
    expect(events).toContainEqual({ type: "compacted", before: 482_000, after: 61_000 });
    expect(events.some((e) => e.type === "call" || e.type === "text")).toBe(false);
    // The session id is unchanged, and the saved cost moves on to the compact's total.
    const states = events.filter((e) => e.type === "state");
    expect(states.at(-1)).toEqual({ type: "state", state: { sessionId: "sess-1", costUsd: 1.75 } });
  });

  test("without a saved session there's nothing to compact", async () => {
    const d = new ClaudeCodeDriver({ settings: () => settings(), bin: fakeClaude([]).bin, env: home() });
    await expect(run(d, request({ state: null }))).rejects.toThrow("no saved Claude Code session");
  });

  test("a CLI that finishes without compacting is an error, not a silent success", async () => {
    const f = fakeClaude([{ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 1.5, usage: {} }]);
    const d = new ClaudeCodeDriver({ settings: () => settings(), bin: f.bin, env: home() });
    await expect(run(d, request())).rejects.toThrow("didn't compact");
  });

  test("a CLI error is the run's error", async () => {
    const f = fakeClaude([{ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID: sess-1", session_id: "sess-1", usage: {} }], 1);
    const d = new ClaudeCodeDriver({ settings: () => settings(), bin: f.bin, env: home() });
    await expect(run(d, request())).rejects.toThrow("No conversation found");
  });
});
