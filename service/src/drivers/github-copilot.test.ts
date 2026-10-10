import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { DEFAULT_SETTINGS } from "../orchestrator/settings";
import { fakeContext } from "../tools/fakes";
import {
  buildCopilotArgs,
  copilotAccount,
  copilotEnv,
  copilotExactRule,
  estimateCopilotTokens,
  parseCopilotQuota,
  readCopilotCalls,
  CopilotJsonParser,
  copilotPrompt,
  GitHubCopilotDriver,
  parseCopilotModels,
  planCopilotPermissions,
} from "./github-copilot";
import { ModelListError, type DriverEvent, type RunRequest } from "./types";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const FAKE = join(FIXTURES, "fake-copilot.ts");
const fixture = (name: string) => readFileSync(join(FIXTURES, "copilot", name), "utf8");
const lines = (name: string) => fixture(name).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const settings: Settings = { ...DEFAULT_SETTINGS, permissionMode: "ask" };

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run_1",
    kind: "work",
    prompt: "Do the work",
    systemPrompt: "You are in a harness.",
    cwd: tempDir("harness-copilot-"),
    model: null,
    state: null,
    tools: [],
    toolContext: fakeContext(),
    mcp: { url: "http://127.0.0.1:7717/mcp/tok", headers: { authorization: "Bearer abc" } },
    signal: new AbortController().signal,
    ...over,
  };
}

function parseAll(name: string, mode: "auto" | "ask" | "read_only" = "ask") {
  const parser = new CopilotJsonParser(mode);
  return { parser, events: lines(name).flatMap((m) => parser.handle(m)) };
}

describe("CopilotJsonParser (recorded copilot 1.0.91 output)", () => {
  test("maps harness MCP tools back to their own names and keeps their result", () => {
    const { parser, events } = parseAll("mcp-run.jsonl");
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ name: "secret_word", input: {} });
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "secret_word", result: { content: [{ type: "text", text: "pineapple" }] } });
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(parser.result).toEqual({ exitCode: 0, premiumRequests: 0.33 });
    expect(parser.sessionId).toBe("22222222-2222-4333-8444-555555555555");
  });

  test("reports a denied shell call as a pending approval", () => {
    const { events } = parseAll("denied-run.jsonl");
    const result = events.find((e) => e.type === "tool_result") as Extract<DriverEvent, { type: "tool_result" }>;
    expect(result.name).toBe("bash");
    expect(result.result.isError).toBe(true);
    expect((result.result.content[0] as { text: string }).text).toContain("Permission denied");
    const denied = events.find((e) => e.type === "permission_denied");
    expect(denied).toMatchObject({ toolName: "bash", input: { command: expect.stringContaining("touch zz.txt") } });
    expect(events.find((e) => e.type === "permission")).toMatchObject({ log: { decision: "deny", backend: "github-copilot", mode: "ask" } });
  });

  test("drops repeated reasoning", () => {
    const p = new CopilotJsonParser();
    const a = p.handle({ type: "assistant.reasoning", data: { reasoningId: "1", content: "hmm" } });
    const b = p.handle({ type: "assistant.reasoning", data: { reasoningId: "opaque", content: "hmm" } });
    expect(a).toEqual([{ type: "thinking", text: "hmm" }]);
    expect(b).toEqual([]);
  });

  test("collects error events", () => {
    const p = new CopilotJsonParser();
    p.handle({ type: "session.error", data: { message: "rate limited" } });
    expect(p.errors).toEqual(["rate limited"]);
  });
});

describe("models", () => {
  test("reads the model list from `copilot help config`, with auto first", () => {
    const models = parseCopilotModels(fixture("help-config.txt"));
    expect(models[0]).toEqual({ id: "auto", name: "Auto", description: "Copilot picks the model", default: true });
    expect(models.map((m) => m.id)).toContain("claude-haiku-4.5");
    expect(models.filter((m) => m.default)).toHaveLength(1);
  });

  test("throws without a model section", () => {
    expect(() => parseCopilotModels("nothing here")).toThrow();
  });

  test("listModels runs the CLI and falls back when it's missing", async () => {
    const driver = new GitHubCopilotDriver({ settings: () => settings, bin: FAKE, env: { PATH: process.env.PATH, FAKE_COPILOT_HELP: join(FIXTURES, "copilot", "help-config.txt") } });
    expect((await driver.listModels()).length).toBeGreaterThan(3);
    const missing = new GitHubCopilotDriver({ settings: () => settings, bin: "/nope/copilot", env: {} });
    const err = await missing.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ModelListError);
    expect((err as ModelListError).fallback.length).toBeGreaterThan(0);
  });
});

describe("permissions", () => {
  test("auto allows everything, read-only and plan runs deny shell and writes", () => {
    expect(planCopilotPermissions({ kind: "work", permissionMode: "auto" }, settings).args).toEqual(["--allow-tool", "harness", "--allow-all"]);
    const ro = ["--allow-tool", "harness", "--deny-tool", "write", "--deny-tool", "shell"];
    expect(planCopilotPermissions({ kind: "work", permissionMode: "read_only" }, settings).args).toEqual(ro);
    expect(planCopilotPermissions({ kind: "plan", permissionMode: "auto" }, settings).args).toEqual(ro);
  });

  test("ask allows writes plus the ticket's grants", () => {
    const plan = planCopilotPermissions(
      {
        kind: "work",
        permissionMode: "ask",
        grants: {
          tools: ["bash", "Bash", "web_fetch"],
          once: [
            { toolName: "bash", input: { command: "touch zz.txt" } },
            { toolName: "bash", input: { command: "a | b" } },
          ],
        },
      },
      settings,
    );
    expect(plan.args).toEqual(["--allow-tool", "harness", "--allow-tool", "write", "--allow-tool", "shell", "--allow-tool", "shell(touch zz.txt)"]);
    expect(plan.applied).toHaveLength(1);
    expect(plan.unexpressed).toHaveLength(1);
  });

  test("exact rules only for simple shell commands", () => {
    expect(copilotExactRule("bash", { command: "git status" })).toBe("shell(git status)");
    for (const command of ["a; b", "a && b", "echo $(x)", "rm *", "x > y", "git:*", "f(x)", " lead"]) {
      expect(copilotExactRule("bash", { command })).toBeNull();
    }
    expect(copilotExactRule("edit", { command: "x" })).toBeNull();
  });
});

describe("args and environment", () => {
  test("builds a JSONL prompt-mode run with the harness MCP server and the session id", () => {
    const req = request({ model: "claude-haiku-4.5" });
    const args = buildCopilotArgs(req, settings, "sess-1");
    expect(args.slice(0, 2)).toEqual(["-p", copilotPrompt(req)]);
    expect(args[1]).toContain("<harness_instructions>\nYou are in a harness.");
    expect(copilotPrompt({ ...req, prompt: "Go", runContext: "## This run: work" })).toBe(
      "<harness_instructions>\nYou are in a harness.\n</harness_instructions>\n\n<harness_run>\n## This run: work\n</harness_run>\n\nGo",
    );
    expect(args).toContain("--no-ask-user");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4.5");
    const mcp = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]!);
    expect(mcp.mcpServers.harness).toEqual({ type: "http", url: req.mcp.url, headers: req.mcp.headers, tools: ["*"] });
  });

  test("never passes COPILOT_ALLOW_ALL through", () => {
    expect(copilotEnv({ COPILOT_ALLOW_ALL: "true", A: "1", B: undefined })).toEqual({ A: "1" });
  });

  test("the token from Settings becomes COPILOT_GITHUB_TOKEN, over any inherited one", () => {
    expect(copilotEnv({ COPILOT_GITHUB_TOKEN: "old", GH_TOKEN: "gh" }, { copilotGithubToken: "github_pat_x" })).toEqual({ COPILOT_GITHUB_TOKEN: "github_pat_x", GH_TOKEN: "gh" });
    expect(copilotAccount({}, { copilotGithubToken: "t" })).toEqual({ source: "settings", detail: "Token from Settings" });
  });

  test("account comes from a token variable or the CLI's config.json", () => {
    expect(copilotAccount({ GH_TOKEN: "x" })).toEqual({ source: "env", detail: "Token from GH_TOKEN" });
    const home = tempDir("harness-copilot-home-");
    expect(copilotAccount({ COPILOT_HOME: home })).toBeNull();
    writeFileSync(join(home, "config.json"), `// managed\n{ "lastLoggedInUser": { "host": "https://github.com", "login": "octocat" } }`);
    expect(copilotAccount({ COPILOT_HOME: home })).toEqual({ source: "login", detail: "octocat" });
  });
});

describe("GitHubCopilotDriver.run (fake CLI)", () => {
  function setup(script: unknown[]) {
    const dir = tempDir("harness-copilot-run-");
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, "script.jsonl");
    writeFileSync(scriptPath, script.map((s) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n") + "\n");
    const record = join(dir, "record.jsonl");
    const driver = new GitHubCopilotDriver({ settings: () => settings, bin: FAKE, env: { PATH: process.env.PATH, FAKE_COPILOT_SCRIPT: scriptPath, FAKE_COPILOT_RECORD: record } });
    const invocations = () => readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
    return { driver, invocations };
  }

  async function collect(it: AsyncIterable<DriverEvent>) {
    const events: DriverEvent[] = [];
    let error: unknown = null;
    try {
      for await (const e of it) events.push(e);
    } catch (err) {
      error = err;
    }
    return { events, error };
  }

  test("starts a new session, then resumes it", async () => {
    const { driver, invocations } = setup(fixture("mcp-run.jsonl").split("\n").filter(Boolean));
    const first = await collect(driver.run(request()));
    expect(first.error).toBeNull();
    const state = first.events.find((e) => e.type === "state") as { state: { sessionId: string } };
    expect(state.state.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.events.some((e) => e.type === "tool_result")).toBe(true);
    expect(first.events.at(-1)).toEqual({ type: "usage" });

    const second = await collect(driver.run(request({ state: state.state })));
    expect(second.error).toBeNull();
    expect(second.events.some((e) => e.type === "state")).toBe(false);
    const [a, b] = invocations();
    expect(a!.argv[a!.argv.indexOf("--session-id") + 1]).toBe(state.state.sessionId);
    expect(b!.argv[b!.argv.indexOf("--session-id") + 1]).toBe(state.state.sessionId);
  });

  test("a CLI failure becomes the run's error", async () => {
    const { driver } = setup([{ __stderr: 'Error: Model "nope" from --model flag is not available.\n' }, { __exit: 1 }]);
    const { events, error } = await collect(driver.run(request({ model: "nope" })));
    expect(error).toBeInstanceOf(Error);
    expect(events.at(-1)).toEqual({ type: "error", message: 'Error: Model "nope" from --model flag is not available.' });
  });

  test("a sign-in failure says how to fix it and signs the driver out until a run gets through", async () => {
    const { driver } = setup([{ __stderr: "Error: No authentication information found.\n\nCopilot can be authenticated...\n" }, { __exit: 1 }]);
    const { events } = await collect(driver.run(request()));
    expect((events.at(-1) as { message: string }).message).toContain("Log in again in Settings");
    expect(await driver.info()).toMatchObject({ authenticated: false, detail: expect.stringContaining("couldn't sign in") });
  });

  test("runs pass the stored token to the CLI", async () => {
    const dir = tempDir("harness-copilot-env-");
    const script = join(dir, "s.jsonl");
    writeFileSync(script, JSON.stringify({ type: "result", sessionId: "s", exitCode: 0, usage: {} }) + "\n");
    const out = join(dir, "env.txt");
    const bin = join(dir, "copilot");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$COPILOT_GITHUB_TOKEN" > ${out}\nexec bun ${FAKE} "$@"\n`, { mode: 0o755 });
    const driver = new GitHubCopilotDriver({ settings: () => ({ ...settings, copilotGithubToken: "github_pat_run" }), bin, env: { PATH: process.env.PATH, FAKE_COPILOT_SCRIPT: script } });
    const { error } = await collect(driver.run(request()));
    expect(error).toBeNull();
    expect(readFileSync(out, "utf8")).toBe("github_pat_run");
  });

  test("abort stops the CLI", async () => {
    const { driver } = setup([{ __sleep: 10_000 }]);
    const ac = new AbortController();
    const done = collect(driver.run(request({ signal: ac.signal })));
    setTimeout(() => ac.abort(), 200);
    const { error } = await done;
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("info and login", () => {
  test("reports a missing CLI and a signed-out one", async () => {
    expect(await new GitHubCopilotDriver({ settings: () => settings, bin: "/nope", env: {} }).info()).toMatchObject({ available: false, authenticated: false });
    const home = tempDir("harness-copilot-home-");
    expect(await new GitHubCopilotDriver({ settings: () => settings, bin: FAKE, env: { COPILOT_HOME: home } }).info()).toMatchObject({ available: true, authenticated: false });
    expect(await new GitHubCopilotDriver({ settings: () => settings, bin: FAKE, env: { COPILOT_GITHUB_TOKEN: "t" } }).info()).toMatchObject({ authenticated: true });
  });

  test("login returns the device URL and code", async () => {
    const driver = new GitHubCopilotDriver({
      settings: () => settings,
      bin: FAKE,
      env: { PATH: process.env.PATH, FAKE_COPILOT_LOGIN: "To authenticate, visit https://github.com/login/device and enter code AB12-CD34\n" },
    });
    const res = await driver.login();
    expect(res.url).toBe("https://github.com/login/device");
    expect(res.message).toContain("AB12-CD34");
  });
});

const usageRecord = (id: string, u: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }, extra: object = {}) =>
  JSON.stringify({ type: "session.usage_record", id: `evt-${id}`, data: { usage: { model: "claude-opus-5.5", ...u, apiCallId: id } }, ...extra });

describe("model calls from the session's events.jsonl (copilot 1.0.94)", () => {
  const events = (lines: string[]) => {
    const dir = tempDir("harness-copilot-events-");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };

  test("a usage record's inputTokens counts the cache too, so the uncached share is what's left", () => {
    const file = events([
      usageRecord("m1", { inputTokens: 38_828, cacheReadTokens: 0, cacheWriteTokens: 38_824, outputTokens: 460 }),
      usageRecord("m2", { inputTokens: 40_000, cacheReadTokens: 38_824, cacheWriteTokens: 1_100, outputTokens: 80 }),
    ]);
    expect(readCopilotCalls(file)).toEqual([
      { id: "m1", call: { input: 4, cacheRead: 0, cacheWrite: 38_824, output: 460 } },
      { id: "m2", call: { input: 76, cacheRead: 38_824, cacheWrite: 1_100, output: 80 } },
    ]);
  });

  test("a sub-agent's calls, other events and a half-written line are left out", () => {
    const file = events([
      JSON.stringify({ type: "assistant.turn_end", data: {} }),
      usageRecord("sub", { inputTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 90_000, outputTokens: 1 }, { agentId: "agent-1" }),
      usageRecord("own", { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }),
      '{"type":"session.usage_record","data":{"usa',
    ]);
    expect(readCopilotCalls(file).map((c) => c.id)).toEqual(["own"]);
  });

  test("a missing file has no calls and no estimate", () => {
    expect(readCopilotCalls("/nonexistent/events.jsonl")).toEqual([]);
    expect(estimateCopilotTokens("/nonexistent/events.jsonl")).toBeNull();
  });

  test("the estimate counts the conversation's words at 0.75 words per token, sub-agents excluded", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const file = events([
      JSON.stringify({ type: "user.message", data: { content: words(300) } }),
      JSON.stringify({ type: "assistant.message", data: { content: words(150), toolRequests: [{ name: "bash", arguments: { command: "ls -la" } }] } }),
      JSON.stringify({ type: "tool.execution_complete", data: { result: { content: words(50) } } }),
      JSON.stringify({ type: "assistant.message", agentId: "a", data: { content: words(10_000) } }),
    ]);
    // 300 + 150 + (bash, ls, -la → name and arguments: "bash" "ls -la" = 3 words) + 50 = 503 words.
    expect(estimateCopilotTokens(file)).toBe(Math.round(503 / 0.75));
  });
});

describe("GitHubCopilotDriver.run: reporting calls", () => {
  /** A stand-in CLI that appends usage records to the session's events.jsonl, like the real one. */
  function run(lines: (sessionId: string) => string[], preexisting: string[] = []) {
    const dir = tempDir("harness-copilot-calls-");
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const bin = join(dir, "copilot");
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const id = argv[argv.indexOf("--session-id") + 1];
const file = path.join(process.env.COPILOT_HOME, "session-state", id, "events.jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
const lines = JSON.parse(process.env.LINES);
for (const l of lines) fs.appendFileSync(file, l + "\\n");
console.log(JSON.stringify({ type: "assistant.turn_end", data: {} }));
console.log(JSON.stringify({ type: "result", sessionId: id, exitCode: 0, usage: {} }));
`,
    );
    chmodSync(bin, 0o755);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    if (preexisting.length) {
      mkdirSync(join(home, "session-state", sessionId), { recursive: true });
      writeFileSync(join(home, "session-state", sessionId, "events.jsonl"), preexisting.join("\n") + "\n");
    }
    const driver = new GitHubCopilotDriver({ settings: () => settings, bin, env: { PATH: process.env.PATH, COPILOT_HOME: home, LINES: JSON.stringify(lines(sessionId)) } });
    return (async () => {
      const out: DriverEvent[] = [];
      for await (const e of driver.run(request({ state: { sessionId } }))) out.push(e);
      return out;
    })();
  }

  test("reports the calls this run added, not the ones already in the log", async () => {
    const old = usageRecord("old", { inputTokens: 90_000, cacheReadTokens: 80_000, cacheWriteTokens: 10_000, outputTokens: 5 });
    const events = await run(
      () => [usageRecord("new1", { inputTokens: 91_000, cacheReadTokens: 90_000, cacheWriteTokens: 900, outputTokens: 20 }), usageRecord("new2", { inputTokens: 92_000, cacheReadTokens: 91_000, cacheWriteTokens: 800, outputTokens: 30 })],
      [old],
    );
    expect(events.filter((e) => e.type === "call")).toEqual([
      { type: "call", call: { input: 100, cacheRead: 90_000, cacheWrite: 900, output: 20 } },
      { type: "call", call: { input: 200, cacheRead: 91_000, cacheWrite: 800, output: 30 } },
    ]);
  });

  test("with no usage records (an older CLI) it falls back to an estimate marked as one", async () => {
    const words = Array.from({ length: 750 }, (_, i) => `w${i}`).join(" ");
    const events = await run(() => [JSON.stringify({ type: "user.message", data: { content: words } })]);
    expect(events.filter((e) => e.type === "call")).toEqual([{ type: "call", call: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true } }]);
  });
});

describe("plan usage", () => {
  test("a metered account's premium requests: percent used, reset date and the month's length", () => {
    const w = parseCopilotQuota({
      quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 300, percent_remaining: 82.5 } },
    });
    expect(w).toEqual({ id: "monthly", label: "Premium requests", usedPercent: 17.5, resetsAt: Date.UTC(2026, 10, 1), windowSeconds: 31 * 86400 });
  });

  test("an account with nothing to run out of has no window (unlimited, or billed by tokens with no entitlement)", () => {
    expect(parseCopilotQuota({ quota_reset_date: "2026-11-01", quota_snapshots: { premium_interactions: { unlimited: true, entitlement: 0, percent_remaining: 100 } } })).toBeNull();
    expect(parseCopilotQuota({ quota_reset_date: "2026-11-01", quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 0, percent_remaining: 100 } } })).toBeNull();
    expect(parseCopilotQuota({ quota_snapshots: {} })).toBeNull();
  });

  test("the driver reads it with the stored token, and 401 asks to sign in", async () => {
    const seen: string[] = [];
    const answer = (status: number, body: unknown) =>
      new GitHubCopilotDriver({
        settings: () => ({ ...settings, copilotGithubToken: "ghp_stored" }),
        fetch: (async (_u: string, init: RequestInit) => {
          seen.push(new Headers(init.headers).get("authorization")!);
          return new Response(JSON.stringify(body), { status });
        }) as never,
      });
    const ok = await answer(200, { quota_reset_date: "2026-11-01", quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 50 } } }).planUsage();
    expect(ok![0]!.usedPercent).toBe(50);
    expect(seen).toEqual(["token ghp_stored"]);
    await expect(answer(401, {}).planUsage()).rejects.toThrow("Sign in to GitHub Copilot");
  });
});
