// claude-code driver × harness permission modes: argv per mode, auto-mode downgrade notice,
// and Claude Code's own classifier denials surfaced as permission log events.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, Settings } from "@harness/shared";
import { fakeContext } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
import { buildClaudeArgs, ClaudeCodeDriver, cleanClaudeEnv, StreamJsonParser } from "./claude-code";
import type { DriverEvent, RunRequest } from "./types";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-ccp-"));
  dirs.push(d);
  return d;
};

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
    expect(events[0]!.type).toBe("tool_result");
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
