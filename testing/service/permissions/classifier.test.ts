import { expect, test } from "bun:test";
import { AnthropicApiClassifier, buildClassifierPrompt, claudeClassifierArgs, DECISION_SCHEMA, parseDecision, type ClassifierRequest, type MessagesCreateLike } from "../../../service/src/permissions/classifier";
import { BUILTIN_RULES } from "../../../service/src/permissions/rules";

const req = (over: Partial<ClassifierRequest> = {}): ClassifierRequest => ({ tool: "bash", input: { command: "ls" }, cwd: "/work", runKind: "work", ticket: null, transcript: [], ...over });

test("parseDecision accepts an object or JSON wrapped in prose or a fence, and trims the reason", () => {
  expect(parseDecision({ decision: "allow", reason: " fine " })).toEqual({ decision: "allow", reason: "fine" });
  expect(parseDecision('Here you go:\n```json\n{"decision":"soft_deny","reason":"risky"}\n```')).toEqual({ decision: "soft_deny", reason: "risky" });
  expect(parseDecision({ decision: "hard_deny" })).toEqual({ decision: "hard_deny", reason: "(no reason given)" });
  expect(parseDecision({ decision: "allow", reason: "  " }).reason).toBe("(no reason given)");
});

test("parseDecision rejects an answer with no JSON or an unknown decision", () => {
  expect(() => parseDecision("I think it's fine")).toThrow(/no JSON/);
  expect(() => parseDecision({ decision: "maybe" })).toThrow(/invalid decision/);
  expect(() => parseDecision(null)).toThrow(/invalid decision/);
  expect(() => parseDecision("{oops}")).toThrow();
});

test("the prompt carries every rule set, the ticket, the transcript and the call, with long text clipped", () => {
  const { system, user } = buildClassifierPrompt(BUILTIN_RULES, req({ ticket: { key: "A-1", title: "Fix", spec: "x".repeat(5000) }, transcript: ["[human] please", "y".repeat(700)], input: { command: "z".repeat(7000) } }));
  for (const rules of [BUILTIN_RULES.environment, BUILTIN_RULES.allow, BUILTIN_RULES.soft_deny, BUILTIN_RULES.hard_deny]) expect(system).toContain(rules[0]!.split("\n")[0]!);
  expect(user).toContain("Working directory: /work");
  expect(user).toContain("Ticket: A-1 — Fix");
  expect(user).toContain("[1000 more chars]");
  expect(user).toContain("[100 more chars]");
  expect(user).toContain("[human] please");
  expect(user).toMatch(/\[\d+ more chars\]\s*$/);
});

test("with no ticket and no transcript the prompt says so", () => {
  const { user } = buildClassifierPrompt({ ...BUILTIN_RULES, allow: [] }, req());
  expect(user).toContain("Ticket: (none)");
  expect(user).toContain("(empty)");
  expect(buildClassifierPrompt({ ...BUILTIN_RULES, allow: [] }, req()).system).toContain("- (none)");
});

test("the CLI is told to use no tools, never persist the session and to read its system prompt from the file", () => {
  const args = claudeClassifierArgs("/tmp/sys.md", "haiku");
  expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).toContain("--no-session-persistence");
  expect(args.at(-1)).toBe("/tmp/sys.md");
  expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(DECISION_SCHEMA);
});

const apiRig = (content: unknown[]) => {
  const calls: unknown[] = [];
  const client: MessagesCreateLike = {
    messages: {
      async create(params) {
        calls.push(params);
        return { content } as never;
      },
    },
  };
  const classifier = new AnthropicApiClassifier({ apiKey: () => "key", model: () => "m", rules: async () => BUILTIN_RULES, createClient: () => client });
  return { classifier, calls };
};

test("the API backend forces the decide tool, caches the rules and reads the tool call's input", async () => {
  const { classifier, calls } = apiRig([{ type: "tool_use", id: "t", name: "decide", input: { decision: "allow", reason: "routine" } }]);
  expect(await classifier.classify(req(), new AbortController().signal)).toEqual({ decision: "allow", reason: "routine" });
  const params = calls[0] as { tool_choice: unknown; system: { cache_control: unknown }[]; model: string };
  expect(params.tool_choice).toEqual({ type: "tool", name: "decide" });
  expect(params.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  expect(params.model).toBe("m");
});

test("the API backend falls back to JSON in text, and errors without a key or an answer", async () => {
  expect((await apiRig([{ type: "text", text: '{"decision":"hard_deny","reason":"no"}' }]).classifier.classify(req(), new AbortController().signal)).decision).toBe("hard_deny");
  await expect(apiRig([]).classifier.classify(req(), new AbortController().signal)).rejects.toThrow(/no JSON/);
  const noKey = new AnthropicApiClassifier({ apiKey: () => null, model: () => "m", rules: async () => BUILTIN_RULES });
  await expect(noKey.classify(req(), new AbortController().signal)).rejects.toThrow(/no Anthropic API key/);
});
