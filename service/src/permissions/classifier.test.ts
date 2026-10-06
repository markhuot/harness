import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicApiClassifier, buildClassifierPrompt, ClaudeCliClassifier, parseDecision, type ClassifierRequest, type MessagesCreateLike } from "./classifier";
import { BUILTIN_RULES, type AutoModeRules } from "./rules";
import { tempDir } from "@harness/shared/testing";

const rules: AutoModeRules = {
  source: "claude-cli",
  fetchedAt: 1,
  environment: ["**Trusted repo**: ENV-RULE-1"],
  allow: ["Local Operations: ALLOW-RULE-1"],
  soft_deny: ["Scope Escalation: SOFT-RULE-1", "Irreversible Local Destruction: SOFT-RULE-2"],
  hard_deny: ["Data Exfiltration: HARD-RULE-1"],
};

const req = (over: Partial<ClassifierRequest> = {}): ClassifierRequest => ({
  tool: "bash",
  input: { command: "git init" },
  cwd: "/work/proj",
  runKind: "work",
  ticket: { key: "WEB-7", title: "Set up the repo", spec: "Initialise git and add a README." },
  transcript: ["[human] set this project up", "[tool_call bash] ls"],
  ...over,
});

describe("buildClassifierPrompt", () => {
  test("puts every rule section in the system prompt and the call + intent context in the user turn", () => {
    const { system, user } = buildClassifierPrompt(rules, req());
    for (const r of ["ENV-RULE-1", "ALLOW-RULE-1", "SOFT-RULE-1", "SOFT-RULE-2", "HARD-RULE-1"]) expect(system).toContain(r);
    // soft rules map to soft_deny, hard rules to hard_deny
    expect(system.indexOf("SOFT-RULE-1")).toBeGreaterThan(system.indexOf("(→ soft_deny)"));
    expect(system.indexOf("HARD-RULE-1")).toBeGreaterThan(system.indexOf("(→ hard_deny)"));
    expect(user).toContain("Working directory: /work/proj");
    expect(user).toContain("Ticket: WEB-7 — Set up the repo");
    expect(user).toContain("Initialise git and add a README.");
    expect(user).toContain("[human] set this project up");
    expect(user).toMatch(/tool: bash\ninput:\n\{\n {2}"command": "git init"\n\}$/);
  });

  test("clips a huge spec and tool input so one call can't blow up the prompt", () => {
    const { user } = buildClassifierPrompt(rules, req({ ticket: { key: "A-1", title: "t", spec: "b".repeat(50_000) }, input: { content: "c".repeat(50_000) } }));
    expect(user.length).toBeLessThan(15_000);
    expect(user).toContain("more chars]");
  });

  test("the built-in fallback has every section", () => {
    const { system } = buildClassifierPrompt(BUILTIN_RULES, req());
    for (const r of [...BUILTIN_RULES.environment, ...BUILTIN_RULES.soft_deny, ...BUILTIN_RULES.hard_deny]) expect(system).toContain(r.slice(0, 40));
  });

  test("a call through call_tool is judged as the tool it runs", () => {
    const { user } = buildClassifierPrompt(rules, req({ tool: "mcp__harness__call_tool", input: { name: "browser_open", input: { url: "https://x.test" } } }));
    expect(user).toMatch(/tool: mcp__harness__browser_open\ninput:\n\{\n {2}"url": "https:\/\/x.test"\n\}$/);
    expect(user).not.toContain("call_tool");
  });
});

describe("parseDecision", () => {
  test("accepts objects and JSON text wrapped in prose", () => {
    expect(parseDecision({ decision: "allow", reason: " ok " })).toEqual({ decision: "allow", reason: "ok" });
    expect(parseDecision('Sure:\n```json\n{"decision":"soft_deny","reason":"outside scope"}\n```')).toEqual({ decision: "soft_deny", reason: "outside scope" });
  });

  test("rejects unknown decisions and non-JSON instead of guessing", () => {
    expect(() => parseDecision({ decision: "maybe", reason: "x" })).toThrow(/invalid decision/);
    expect(() => parseDecision("I think it's fine")).toThrow(/no JSON/);
    expect(() => parseDecision(null)).toThrow();
  });
});

function fakeClaude(output: string, exitCode = 0) {
  const dir = tempDir("fake-classifier-");
  const record = join(dir, "record.json");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const sp = argv[argv.indexOf("--system-prompt-file") + 1];
const system = sp ? await Bun.file(sp).text() : null;
await Bun.write(${JSON.stringify(record)}, JSON.stringify({ argv, stdin, cwd: process.cwd(), system, spFile: sp }));
process.stdout.write(${JSON.stringify(output)});
process.exit(${exitCode});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, read: () => JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; stdin: string; cwd: string; system: string; spFile: string } };
}

describe("ClaudeCliClassifier (fake claude)", () => {
  test("runs claude -p with a JSON schema, no tools, the rules as the system prompt, in the workdir", async () => {
    const cwd = tempDir("cls-cwd-");
    const f = fakeClaude("warning: extra certs\n" + JSON.stringify({ type: "result", is_error: false, structured_output: { decision: "allow", reason: "routine" } }));
    const c = new ClaudeCliClassifier({ bin: () => f.bin, env: () => ({ PATH: process.env.PATH! }), rules: async () => rules });
    expect(await c.classify(req({ cwd }), new AbortController().signal)).toEqual({ decision: "allow", reason: "routine" });
    const inv = f.read();
    const arg = (flag: string) => inv.argv[inv.argv.indexOf(flag) + 1];
    expect(inv.argv[0]).toBe("-p");
    expect(arg("--model")).toBe("sonnet");
    expect(arg("--output-format")).toBe("json");
    expect(JSON.parse(arg("--json-schema")!).properties.decision.enum).toEqual(["allow", "soft_deny", "hard_deny"]);
    expect(arg("--tools")).toBe("");
    expect(arg("--permission-mode")).toBe("dontAsk");
    expect(inv.argv).toContain("--no-session-persistence");
    expect(inv.argv).toContain("--strict-mcp-config");
    expect(inv.system).toContain("SOFT-RULE-2");
    expect(inv.stdin).toContain('"command": "git init"');
    expect(inv.cwd.replace(/^\/private/, "")).toBe(cwd.replace(/^\/private/, ""));
    expect(existsSync(inv.spFile)).toBe(false); // temp prompt file cleaned up
  });

  test("falls back to the result text when structured_output is missing", async () => {
    const f = fakeClaude(JSON.stringify({ type: "result", is_error: false, result: '{"decision":"hard_deny","reason":"exfil"}' }));
    const c = new ClaudeCliClassifier({ bin: () => f.bin, env: () => ({ PATH: process.env.PATH! }), rules: async () => rules });
    expect(await c.classify(req({ cwd: tmpdir() }), new AbortController().signal)).toEqual({ decision: "hard_deny", reason: "exfil" });
  });

  test("CLI errors and garbage become thrown errors (the gate then asks a human)", async () => {
    const env = () => ({ PATH: process.env.PATH! });
    const err = fakeClaude(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }), 1);
    await expect(new ClaudeCliClassifier({ bin: () => err.bin, env, rules: async () => rules }).classify(req({ cwd: tmpdir() }), new AbortController().signal)).rejects.toThrow(/Not logged in/);
    const junk = fakeClaude("nothing useful", 2);
    await expect(new ClaudeCliClassifier({ bin: () => junk.bin, env, rules: async () => rules }).classify(req({ cwd: tmpdir() }), new AbortController().signal)).rejects.toThrow(/exited with 2/);
  });
});

describe("AnthropicApiClassifier", () => {
  test("forces the decide tool, caches the rules, and parses its input", async () => {
    const seen: any[] = [];
    const client: MessagesCreateLike = {
      messages: {
        async create(params) {
          seen.push(params);
          return { content: [{ type: "tool_use", id: "t", name: "decide", input: { decision: "soft_deny", reason: "new dependency" } }] } as any;
        },
      },
    };
    const c = new AnthropicApiClassifier({ apiKey: () => "sk", model: () => "claude-x", rules: async () => rules, createClient: () => client });
    expect(await c.classify(req(), new AbortController().signal)).toEqual({ decision: "soft_deny", reason: "new dependency" });
    expect(seen[0].model).toBe("claude-x");
    expect(seen[0].tool_choice).toEqual({ type: "tool", name: "decide" });
    expect(seen[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(seen[0].system[0].text).toContain("HARD-RULE-1");
  });

  test("throws without an API key", async () => {
    const c = new AnthropicApiClassifier({ apiKey: () => null, model: () => "m", rules: async () => rules });
    await expect(c.classify(req(), new AbortController().signal)).rejects.toThrow(/API key/);
  });
});
