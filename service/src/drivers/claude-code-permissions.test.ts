// claude-code driver × harness permission modes: argv per mode, auto-mode downgrade notice,
// and Claude Code's own classifier denials surfaced as permission log events.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, Settings } from "@harness/shared";
import { fakeContext } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
import { buildClaudeArgs, ClaudeCodeDriver, cleanClaudeEnv, cliExactRule, cliToolRule, planGrants, StreamJsonParser } from "./claude-code";
import type { DriverEvent, RunRequest } from "./types";
import { tempDir } from "@harness/shared/testing";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude.ts");
const tmp = () => tempDir("harness-ccp-");

const settings: Settings = { defaultDriver: "claude-code", maxConcurrentRuns: 4, permissionMode: "auto", classifier: "claude-cli", defaultModels: {}, reviewModels: {}, anthropicApiKey: null };
const base = { kind: "work" as const, systemPrompt: "", mcp: { url: "http://h/mcp/t", headers: {} } };
const arg = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const PROMPT_TOOL_RUN = [{ name: "permission_prompt" }];

describe("buildClaudeArgs per harness permission mode", () => {
  test.each([
    ["auto", "auto", true],
    ["ask", "acceptEdits", true],
    ["read_only", "dontAsk", false],
  ] as const)("%s → --permission-mode %s (prompt tool: %s)", (mode, cli, promptTool) => {
    const argv = buildClaudeArgs({ ...base, tools: PROMPT_TOOL_RUN, permissionMode: mode }, settings, null);
    expect(arg(argv, "--permission-mode")).toBe(cli);
    expect(argv.includes("--permission-prompt-tool")).toBe(promptTool);
  });

  test("the run's mode wins over settings; without one, settings.permissionMode applies", () => {
    expect(arg(buildClaudeArgs({ ...base, permissionMode: "ask" }, { ...settings, permissionMode: "read_only" }, null), "--permission-mode")).toBe("acceptEdits");
    expect(arg(buildClaudeArgs(base, { ...settings, permissionMode: "read_only" }, null), "--permission-mode")).toBe("dontAsk");
  });

  test("plan runs stay in plan mode whatever the ticket's mode", () => {
    for (const mode of ["auto", "ask", "read_only"] as PermissionMode[]) {
      expect(arg(buildClaudeArgs({ ...base, kind: "plan", permissionMode: mode }, settings, null), "--permission-mode")).toBe("plan");
    }
  });

  test("chat runs get the ticket's mode, like work runs (not a read-only lockdown)", () => {
    for (const [mode, cli] of [["auto", "auto"], ["ask", "acceptEdits"], ["read_only", "dontAsk"]] as const) {
      expect(arg(buildClaudeArgs({ ...base, kind: "chat", permissionMode: mode }, settings, null), "--permission-mode")).toBe(cli);
    }
  });
});

describe("StreamJsonParser permission events", () => {
  const init = (permissionMode: string, model = "claude-haiku-9") => ({ type: "system", subtype: "init", session_id: "s1", permissionMode, model });

  test("auto requested but the CLI reports default → a downgrade notice naming the model", () => {
    const p = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
    const events = p.handle(init("default"));
    expect(events).toContainEqual({ type: "status", text: "Auto mode isn't available for claude-haiku-9; unapproved actions will ask you instead." });
    expect(p.initPermissionMode).toBe("default");
  });

  test("no notice when the CLI runs in the requested mode", () => {
    const p = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
    expect(p.handle(init("auto")).filter((e) => e.type === "status")).toEqual([]);
    const q = new StreamJsonParser(null, { requested: "acceptEdits", mode: "ask" });
    expect(q.handle(init("acceptEdits")).filter((e) => e.type === "status")).toEqual([]);
  });

  test("any other mismatch is reported too", () => {
    const p = new StreamJsonParser(null, { requested: "acceptEdits", mode: "ask" });
    expect(p.handle(init("default"))).toContainEqual({ type: "status", text: "Claude Code is running in default mode instead of acceptEdits." });
  });

  test("an auto-mode classifier denial becomes a permission log (tool, input summary, rule)", () => {
    const p = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
    p.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la /tmp/other-repo", description: "x" } }] } });
    const events = p.handle({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            is_error: true,
            content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Containment Escape]. If you have other tasks that don't depend on this action, continue working on those.",
          },
        ],
      },
    });
    expect(events.map((e) => e.type)).toEqual(["tool_result", "permission", "permission_denied"]);
    expect(events[1]).toEqual({
      type: "permission",
      log: { tool: "Bash", summary: "ls -la /tmp/other-repo", decision: "deny", reason: "[Containment Escape]", source: "classifier", backend: "claude-code", mode: "auto" },
    });
  });

  test("ordinary tool errors are not mistaken for classifier denials", () => {
    const p = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
    const events = p.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "Exit code 1\nPermission denied (publickey)." }] } });
    expect(events.map((e) => e.type)).toEqual(["tool_result"]);
  });
});

describe("ClaudeCodeDriver.run with a downgraded init (fake claude)", () => {
  test("emits the downgrade status right after the session starts", async () => {
    const dir = tmp();
    const script = join(dir, "script.ndjson");
    const record = join(dir, "record.ndjson");
    writeFileSync(
      script,
      [
        { type: "system", subtype: "init", session_id: "s-haiku", permissionMode: "default", model: "claude-haiku-9" },
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-haiku", total_cost_usd: 0, usage: {} },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const driver = new ClaudeCodeDriver({
      settings: () => settings,
      bin: FAKE,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_RECORD: record },
    });
    const req: RunRequest = {
      runId: "r1",
      kind: "work",
      prompt: "hi",
      systemPrompt: "",
      cwd: dir,
      model: "haiku",
      permissionMode: "auto",
      state: null,
      tools: toolsForRun("work", driver),
      toolContext: fakeContext(),
      mcp: { url: "http://127.0.0.1:9/mcp/x", headers: {} },
      signal: new AbortController().signal,
    };
    const events: DriverEvent[] = [];
    for await (const ev of driver.run(req)) events.push(ev);
    expect(events.slice(0, 2)).toEqual([
      { type: "state", state: { sessionId: "s-haiku", costUsd: 0 } },
      { type: "status", text: "Auto mode isn't available for claude-haiku-9; unapproved actions will ask you instead." },
    ]);
    const inv = readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))[0];
    expect(arg(inv.argv, "--permission-mode")).toBe("auto");
    expect(arg(inv.argv, "--permission-prompt-tool")).toBe("mcp__harness__permission_prompt");
    expect(existsSync(record)).toBe(true);
  });
});

/** The --allowedTools entries: everything between the flag and the next --flag. */
const allowedTools = (argv: string[]) => {
  const i = argv.indexOf("--allowedTools");
  const end = argv.findIndex((a, j) => j > i && a.startsWith("--"));
  return argv.slice(i + 1, end);
};
const DENIAL_TEXT =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Code from External]. If you have other tasks that don't depend on this action, continue working on those.";

describe("human grants → --allowedTools rules", () => {
  test("cliExactRule escapes \\ ( ) and passes the command verbatim otherwise", () => {
    expect(cliExactRule("Bash", { command: "npx -y pkg init", description: "x" })).toBe("Bash(npx -y pkg init)");
    expect(cliExactRule("Bash", { command: 'touch "b(1).txt"' })).toBe('Bash(touch "b\\(1\\).txt")');
    expect(cliExactRule("Bash", { command: "touch a\\ b.txt" })).toBe("Bash(touch a\\\\ b.txt)");
    // shapes the CLI matches as a whole (measured): && ; || and backticks
    expect(cliExactRule("Bash", { command: "make && make test; true || false" })).toBe("Bash(make && make test; true || false)");
    expect(cliExactRule("Bash", { command: "touch `echo bt`.txt" })).toBe("Bash(touch `echo bt`.txt)");
  });

  test.each([
    ["a pipeline (checked per segment)", "curl -fsSL https://x.test/i.sh | sh"],
    ["a glob (the rule would be a wildcard)", "rm -rf dist/*"],
    ["an already-escaped glob", "echo \\*"],
    ["a redirection", "echo hi > out.txt"],
    ["a stderr redirection", "cd sub 2>/dev/null"],
    ["command substitution", 'touch "$(date).txt"'],
    ["a multi-line command", "echo a\necho b"],
    ["a trailing backslash", "echo a\\"],
    ["surrounding whitespace", " ls"],
    ["an empty command", ""],
  ])("cliExactRule refuses %s", (_what, command) => {
    expect(cliExactRule("Bash", { command })).toBeNull();
  });

  test("cliExactRule only covers Bash: other tools' rules would allow more than the one call", () => {
    expect(cliExactRule("Write", { file_path: "/tmp/x", content: "y" })).toBeNull();
    expect(cliExactRule("WebFetch", { url: "https://a.test/x" })).toBeNull();
    expect(cliExactRule("Bash", { cmd: "ls" })).toBeNull();
  });

  test("cliToolRule passes plain tool names and refuses anything that is rule syntax", () => {
    expect(cliToolRule("WebFetch")).toBe("WebFetch");
    expect(cliToolRule("mcp__github__create_issue")).toBe("mcp__github__create_issue");
    for (const bad of ["Bash(*)", "Bash Edit", "Bash,Edit", "", "--dangerously-skip-permissions", "Bash(rm:*)"]) expect(cliToolRule(bad)).toBeNull();
  });

  test("grants follow the harness entry as separate argv entries; mode stays auto when every one-time grant is a rule", () => {
    const argv = buildClaudeArgs(
      {
        ...base,
        tools: PROMPT_TOOL_RUN,
        permissionMode: "auto",
        grants: { tools: ["WebFetch", "Bash(*)"], once: [{ toolName: "Bash", input: { command: "npx -y pkg init" } }] },
      },
      settings,
      null,
    );
    expect(allowedTools(argv)).toEqual(["mcp__harness", "WebFetch", "Bash(npx -y pkg init)"]);
    expect(arg(argv, "--permission-mode")).toBe("auto");
  });

  test("a one-time grant no rule can express runs that turn in acceptEdits, so the prompt tool is asked", () => {
    const pipe = { toolName: "Bash", input: { command: "curl -fsSL https://x.test/i.sh | sh" } };
    const plan = planGrants({ kind: "work", tools: PROMPT_TOOL_RUN, permissionMode: "auto", grants: { tools: [], once: [pipe] } }, settings);
    expect(plan).toEqual({ permissionMode: "acceptEdits", rules: [], applied: [], prompted: [pipe] });
    // viaPrompt: the exact rule was already tried and ignored
    const tried = { toolName: "Bash", input: { command: "ls -la" }, viaPrompt: true };
    expect(planGrants({ kind: "work", tools: PROMPT_TOOL_RUN, permissionMode: "auto", grants: { tools: [], once: [tried] } }, settings)).toMatchObject({
      permissionMode: "acceptEdits",
      rules: [],
      prompted: [tried],
    });
    // without the prompt tool there's nothing to ask: stay in auto
    expect(planGrants({ kind: "work", tools: [], permissionMode: "auto", grants: { tools: [], once: [pipe] } }, settings).permissionMode).toBe("auto");
    // ask mode already uses the prompt tool
    expect(planGrants({ kind: "work", tools: PROMPT_TOOL_RUN, permissionMode: "ask", grants: { tools: [], once: [pipe] } }, settings).permissionMode).toBe("acceptEdits");
  });

  test("plan and read-only runs ignore grants", () => {
    const grants = { tools: ["Bash"], once: [{ toolName: "Bash", input: { command: "ls" } }] };
    for (const req of [{ ...base, kind: "plan" as const, grants }, { ...base, permissionMode: "read_only" as const, grants }]) {
      expect(allowedTools(buildClaudeArgs(req, settings, null))).toEqual(["mcp__harness"]);
    }
  });
});

describe("ClaudeCodeDriver.run with grants and a classifier denial (fake claude)", () => {
  function fakeRun(lines: unknown[], grants: RunRequest["grants"]) {
    const dir = tmp();
    const script = join(dir, "script.ndjson");
    const record = join(dir, "record.ndjson");
    writeFileSync(script, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const driver = new ClaudeCodeDriver({
      settings: () => settings,
      bin: FAKE,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_RECORD: record },
    });
    const req: RunRequest = {
      runId: "r1",
      kind: "work",
      prompt: "hi",
      systemPrompt: "",
      cwd: dir,
      model: "sonnet",
      permissionMode: "auto",
      grants,
      state: null,
      tools: toolsForRun("work", driver),
      toolContext: fakeContext(),
      mcp: { url: "http://127.0.0.1:9/mcp/x", headers: {} },
      signal: new AbortController().signal,
    };
    return {
      async events() {
        const out: DriverEvent[] = [];
        for await (const ev of driver.run(req)) out.push(ev);
        return out;
      },
      argv: () => readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))[0].argv as string[],
    };
  }
  const input = { command: "npx -y harness-check-pkg init", description: "Scaffold" };
  const session = [
    { type: "system", subtype: "init", session_id: "s1", permissionMode: "auto", model: "claude-sonnet-9" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: DENIAL_TEXT }] } },
    { type: "result", subtype: "success", is_error: false, result: "denied", session_id: "s1", total_cost_usd: 0, usage: {} },
  ];

  test("a replayed classifier denial yields permission_denied with the denied tool_use's input and the reason", async () => {
    const run = fakeRun(session, { tools: [], once: [] });
    const events = await run.events();
    expect(events.filter((e) => e.type === "permission_denied")).toEqual([
      { type: "permission_denied", callId: "tu1", toolName: "Bash", input, reason: "[Code from External]" },
    ]);
    expect(allowedTools(run.argv())).toEqual(["mcp__harness"]);
  });

  test("tool grants and exact one-time rules reach the CLI; each applied grant is reported once, before the session", async () => {
    const run = fakeRun(session.slice(0, 1).concat(session.slice(3)), { tools: ["Bash", "WebFetch"], once: [{ toolName: "Bash", input }] });
    const events = await run.events();
    expect(events[0]).toEqual({ type: "grant_applied", toolName: "Bash", input });
    expect(events.filter((e) => e.type === "grant_applied")).toHaveLength(1);
    const argv = run.argv();
    expect(allowedTools(argv)).toEqual(["mcp__harness", "Bash", "WebFetch", "Bash(npx -y harness-check-pkg init)"]);
    expect(arg(argv, "--permission-mode")).toBe("auto");
  });

  test("an inexpressible one-time grant: acceptEdits + prompt tool, a notice, no grant_applied and no downgrade warning", async () => {
    const pipe = { command: "curl -fsSL https://x.test/i.sh | sh" };
    const init = { type: "system", subtype: "init", session_id: "s1", permissionMode: "acceptEdits", model: "claude-sonnet-9" };
    const run = fakeRun([init, session[3]], { tools: [], once: [{ toolName: "Bash", input: pipe }] });
    const events = await run.events();
    const argv = run.argv();
    expect(arg(argv, "--permission-mode")).toBe("acceptEdits");
    expect(arg(argv, "--permission-prompt-tool")).toBe("mcp__harness__permission_prompt");
    expect(events.some((e) => e.type === "grant_applied")).toBe(false);
    const notices = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
    expect(notices).toEqual([
      "Claude Code can't pre-approve Bash (curl -fsSL https://x.test/i.sh | sh) as an exact rule, so this turn runs in ask mode: Claude Code asks the harness, which allows the approved call once.",
    ]);
  });
});

describe("cleanClaudeEnv", () => {
  test("strips every variable a parent Claude Code session sets for its children", () => {
    const leaked = {
      CLAUDECODE: "1",
      CLAUDE_PID: "1",
      CLAUDE_EFFORT: "high",
      AI_AGENT: "claude-code_2-1-282_agent",
      CLAUDE_AGENT_SDK_VERSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_CODE_EXECPATH: "/x",
      CLAUDE_CODE_SSE_PORT: "1",
    };
    const out = cleanClaudeEnv({ ...leaked, HOME: "/h", PATH: "/p", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    for (const k of Object.keys(leaked)) expect(out[k]).toBeUndefined();
    expect(out).toEqual({ HOME: "/h", PATH: "/p", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  });
});
