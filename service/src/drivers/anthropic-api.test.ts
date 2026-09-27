import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { RunKind, Settings } from "@harness/shared";
import { fakeBrowser, fakeContext, fakeOps } from "../tools/fakes";
import { toolsForRun } from "../tools/index";
import type { ToolDefinition } from "../tools/types";
import { AnthropicApiDriver, DEFAULT_ANTHROPIC_MODEL, MAX_ITERATIONS, type MessageStreamLike, type MessagesClientLike } from "./anthropic-api";
import type { DriverEvent, RunRequest } from "./types";

const baseSettings: Settings = {
  defaultDriver: "anthropic-api",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "off",
  defaultModels: {},
  reviewModels: {},
  anthropicApiKey: "sk-settings",
};

type Block = Anthropic.ContentBlock;
interface Turn {
  content: Block[];
  stop_reason: Anthropic.Message["stop_reason"];
  usage?: Partial<Anthropic.Usage>;
  /** throw this from the stream instead of producing a message */
  error?: unknown;
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input }) as Block;
const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: "sig" }) as Block;

/** Fake client: replays turns in order (last one repeats), records params (deep-cloned) and signals. */
function fakeClient(turns: Turn[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const keys: string[] = [];
  let i = 0;
  const client: MessagesClientLike = {
    messages: {
      stream(params, options) {
        requests.push(structuredClone(params));
        signals.push(options?.signal);
        const turn = turns[Math.min(i++, turns.length - 1)]!;
        const stream: MessageStreamLike = {
          async *[Symbol.asyncIterator]() {
            if (turn.error) throw turn.error;
            for (const [index, block] of turn.content.entries()) {
              if (block.type === "text") {
                for (const piece of block.text.match(/.{1,3}/gs) ?? []) {
                  yield { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } } as Anthropic.MessageStreamEvent;
                }
              }
            }
          },
          async finalMessage() {
            return {
              id: `msg_${i}`,
              type: "message",
              role: "assistant",
              model: params.model,
              content: turn.content,
              stop_reason: turn.stop_reason,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...turn.usage },
            } as unknown as Anthropic.Message;
          },
        };
        return stream;
      },
    },
  };
  return {
    requests,
    signals,
    keys,
    createClient: (key: string) => {
      keys.push(key);
      return client;
    },
  };
}

function makeReq(kind: RunKind, prompt: string, opts: { state?: unknown; tools?: ToolDefinition[]; signal?: AbortSignal; model?: string | null } = {}) {
  const ops = fakeOps();
  const browser = fakeBrowser();
  const signal = opts.signal ?? new AbortController().signal;
  const ctx = fakeContext({ runKind: kind, ops, browser, signal });
  const req: RunRequest = {
    runId: "run_1",
    kind,
    prompt,
    systemPrompt: "You are a harness agent.",
    cwd: ctx.cwd,
    model: opts.model ?? null,
    state: opts.state ?? null,
    tools: opts.tools ?? toolsForRun(kind, { hasBuiltinTools: false }),
    toolContext: ctx,
    mcp: { url: "http://x", headers: {} },
    signal,
  };
  return { req, ops, browser };
}

async function collect(driver: AnthropicApiDriver, req: RunRequest) {
  const events: DriverEvent[] = [];
  try {
    for await (const ev of driver.run(req)) events.push(ev);
    return { events, error: null as unknown };
  } catch (error) {
    return { events, error };
  }
}

function driverWith(turns: Turn[], settings: Partial<Settings> = {}, env: Record<string, string | undefined> = {}) {
  const fake = fakeClient(turns);
  const driver = new AnthropicApiDriver({ settings: () => ({ ...baseSettings, ...settings }), createClient: fake.createClient, env });
  return { driver, fake };
}

const lastState = (events: DriverEvent[]) => ([...events].reverse().find((e) => e.type === "state") as any)?.state;

describe("anthropic-api driver", () => {
  test("no API key: info unauthenticated; run yields error and throws without calling the API", async () => {
    const { driver, fake } = driverWith([{ content: [text("hi")], stop_reason: "end_turn" }], { anthropicApiKey: null });
    const info = await driver.info();
    expect(info.authenticated).toBe(false);
    expect(info.available).toBe(true);
    const { events, error } = await collect(driver, makeReq("work", "hi").req);
    expect(error).toBeInstanceOf(Error);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("API key") }]);
    expect(fake.requests.length).toBe(0);
  });

  test("key from settings is preferred over ANTHROPIC_API_KEY; env is the fallback", async () => {
    const a = driverWith([{ content: [text("ok")], stop_reason: "end_turn" }], {}, { ANTHROPIC_API_KEY: "sk-env" });
    await collect(a.driver, makeReq("work", "x").req);
    expect(a.fake.keys).toEqual(["sk-settings"]);
    expect((await a.driver.info()).detail).toContain("settings");

    const b = driverWith([{ content: [text("ok")], stop_reason: "end_turn" }], { anthropicApiKey: null }, { ANTHROPIC_API_KEY: "sk-env" });
    await collect(b.driver, makeReq("work", "x").req);
    expect(b.fake.keys).toEqual(["sk-env"]);
    const info = await b.driver.info();
    expect(info.authenticated).toBe(true);
    expect(info.detail).toContain("ANTHROPIC_API_KEY");
  });

  test("request carries model, system prompt, max_tokens, tools with input_schema, and the prompt", async () => {
    const { driver, fake } = driverWith([{ content: [text("ok")], stop_reason: "end_turn" }]);
    const { req } = makeReq("review", "Review it", { model: "claude-test-model" });
    await collect(driver, req);
    const p = fake.requests[0]!;
    expect(p.model).toBe("claude-test-model");
    expect(p.system).toBe("You are a harness agent.");
    expect(p.max_tokens).toBeGreaterThan(1000);
    expect(p.tools!.map((t: any) => t.name)).toEqual(req.tools.map((t) => t.name));
    const rd = p.tools!.find((t: any) => t.name === "review_decision") as Anthropic.Tool;
    expect(rd.input_schema).toEqual(req.tools.find((t) => t.name === "review_decision")!.inputSchema as any);
    expect(p.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Review it" }] }]);
    expect(fake.signals[0]).toBe(req.signal);
  });

  test("streams text_delta then emits the full text block", async () => {
    const { driver } = driverWith([{ content: [text("Hello there, world")], stop_reason: "end_turn" }]);
    const { events, error } = await collect(driver, makeReq("work", "x").req);
    expect(error).toBeNull();
    const idx = events.findIndex((e) => e.type === "text");
    const deltas = events.slice(0, idx).filter((e) => e.type === "text_delta").map((e: any) => e.text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Hello there, world");
    expect(events[idx]).toEqual({ type: "text", text: "Hello there, world" });
  });

  test("tool loop: executes tools, returns all results in one user message, continues to end_turn", async () => {
    const { driver, fake } = driverWith([
      {
        content: [
          text("Working."),
          toolUse("tu_1", "post_summary", { summary: "halfway" }),
          toolUse("tu_2", "post_summary", {}), // invalid: missing summary
          toolUse("tu_3", "nope_tool", {}),
          toolUse("tu_4", "browser_screenshot", {}),
        ],
        stop_reason: "tool_use",
      },
      { content: [text("Done.")], stop_reason: "end_turn" },
    ]);
    const { req, ops } = makeReq("work", "go");
    const { events, error } = await collect(driver, req);
    expect(error).toBeNull();
    expect(ops.calls).toEqual([{ method: "postSummary", args: ["halfway"] }]);
    expect(fake.requests.length).toBe(2);

    const second = fake.requests[1]!.messages;
    expect(second.length).toBe(3);
    expect(second[1]!.role).toBe("assistant");
    const results = second[2]!;
    expect(results.role).toBe("user");
    const blocks = results.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => [b.tool_use_id, b.is_error ?? false])).toEqual([
      ["tu_1", false],
      ["tu_2", true],
      ["tu_3", true],
      ["tu_4", false],
    ]);
    expect(JSON.stringify(blocks[2]!.content)).toContain("Unknown tool");
    expect((blocks[3]!.content as any[])[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });

    const kinds = events.filter((e) => e.type === "tool_call" || e.type === "tool_result").map((e: any) => `${e.type}:${e.callId}`);
    expect(kinds).toEqual(["tool_call:tu_1", "tool_result:tu_1", "tool_call:tu_2", "tool_result:tu_2", "tool_call:tu_3", "tool_result:tu_3", "tool_call:tu_4", "tool_result:tu_4"]);
    expect(events.filter((e) => e.type === "text").map((e: any) => e.text)).toEqual(["Working.", "Done."]);
  });

  test("usage is summed across iterations, including cache tokens", async () => {
    const { driver } = driverWith([
      { content: [toolUse("a", "post_summary", { summary: "s" })], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 50 } },
      { content: [text("ok")], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 20 } },
    ]);
    const { events } = await collect(driver, makeReq("work", "x").req);
    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toEqual([{ type: "usage", inputTokens: 173, outputTokens: 9 }]);
  });

  test("state holds the full history, and resuming appends the new prompt after it", async () => {
    const first = driverWith([
      { content: [toolUse("a", "post_summary", { summary: "s" })], stop_reason: "tool_use" },
      { content: [text("first answer")], stop_reason: "end_turn" },
    ]);
    const r1 = await collect(first.driver, makeReq("work", "one").req);
    const state = lastState(r1.events);
    expect(state.messages.length).toBe(4); // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(state.messages[3].content[0].text).toBe("first answer");

    const second = driverWith([{ content: [text("second")], stop_reason: "end_turn" }]);
    await collect(second.driver, makeReq("work", "two", { state }).req);
    const msgs = second.fake.requests[0]!.messages;
    expect(msgs.slice(0, 4)).toEqual(state.messages);
    expect(msgs[4]).toEqual({ role: "user", content: [{ type: "text", text: "two" }] });
    // the stored state object was not mutated by the second run
    expect(state.messages.length).toBe(4);
  });

  test("a dangling tool_use in stored state is answered with an error result before the new prompt", async () => {
    const state = {
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_x", name: "bash", input: { command: "sleep 100" } }] },
      ],
    };
    const { driver, fake } = driverWith([{ content: [text("ok")], stop_reason: "end_turn" }]);
    await collect(driver, makeReq("work", "resume", { state }).req);
    const last = fake.requests[0]!.messages[2]!;
    const content = last.content as any[];
    expect(last.role).toBe("user");
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_x", is_error: true });
    expect(content[1]).toEqual({ type: "text", text: "resume" });
  });

  test(`stops after ${MAX_ITERATIONS} iterations with an error`, async () => {
    const { driver, fake } = driverWith([{ content: [toolUse("loop", "post_summary", { summary: "again" })], stop_reason: "tool_use" }]);
    const { events, error } = await collect(driver, makeReq("work", "x").req);
    expect(error).toBeInstanceOf(Error);
    expect(fake.requests.length).toBe(MAX_ITERATIONS);
    expect(events.at(-1)).toEqual({ type: "error", message: expect.stringContaining(String(MAX_ITERATIONS)) });
  });

  test("API errors become an error event and a throw", async () => {
    const apiErr = new Anthropic.APIError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers());
    const { driver } = driverWith([{ content: [], stop_reason: "end_turn", error: apiErr }]);
    const { events, error } = await collect(driver, makeReq("work", "x").req);
    expect(error).toBe(apiErr);
    const err = events.find((e) => e.type === "error") as any;
    expect(err.message).toContain("529");
  });

  test("abort during a tool call rejects with AbortError and sends no further requests", async () => {
    const ac = new AbortController();
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow",
      group: "harness",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        ac.abort();
        return { content: [{ type: "text", text: "done" }] };
      },
    };
    const { driver, fake } = driverWith([{ content: [toolUse("s1", "slow", {}), toolUse("s2", "slow", {})], stop_reason: "tool_use" }]);
    const { events, error } = await collect(driver, makeReq("work", "x", { tools: [slow], signal: ac.signal }).req);
    expect((error as Error).name).toBe("AbortError");
    expect(fake.requests.length).toBe(1);
    // second tool never started
    expect(events.filter((e) => e.type === "tool_call").length).toBe(1);
    // the state saved on abort ends with the dangling assistant tool_use turn, which the next run repairs
    expect(lastState(events).messages.at(-1).role).toBe("assistant");
  });

  test("abort thrown by the SDK stream surfaces as AbortError without an error event", async () => {
    const ac = new AbortController();
    ac.abort();
    const { driver, fake } = driverWith([{ content: [], stop_reason: "end_turn", error: new Anthropic.APIUserAbortError() }]);
    const { events, error } = await collect(driver, makeReq("work", "x", { signal: ac.signal }).req);
    expect((error as Error).name).toBe("AbortError");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  test("thinking blocks are emitted; empty ones are skipped", async () => {
    const { driver } = driverWith([{ content: [thinking(""), thinking("Let me consider."), text("Answer")], stop_reason: "end_turn" }]);
    const { events } = await collect(driver, makeReq("work", "x").req);
    expect(events.filter((e) => e.type === "thinking")).toEqual([{ type: "thinking", text: "Let me consider." }]);
  });

  test("refusal ends the run with an error", async () => {
    const { driver } = driverWith([{ content: [], stop_reason: "refusal" }]);
    const { events, error } = await collect(driver, makeReq("work", "x").req);
    expect(error).toBeInstanceOf(Error);
    expect(events.some((e) => e.type === "error" && /refus/.test(e.message))).toBe(true);
    // the stored history stays valid: no empty assistant turn
    expect(lastState(events).messages.map((m: any) => m.role)).toEqual(["user"]);
  });

  test("pause_turn re-sends to continue", async () => {
    const { driver, fake } = driverWith([
      { content: [text("part")], stop_reason: "pause_turn" },
      { content: [text("rest")], stop_reason: "end_turn" },
    ]);
    const { error } = await collect(driver, makeReq("work", "x").req);
    expect(error).toBeNull();
    expect(fake.requests.length).toBe(2);
    expect(fake.requests[1]!.messages.at(-1)!.role).toBe("assistant");
  });
});

describe("anthropic-api models", () => {
  /** A models.list() like the SDK's: an async iterable that walks pages lazily. */
  function pagedModels(pages: { id: string; display_name: string }[][]) {
    const seen = { pagesFetched: 0, params: [] as unknown[], keys: [] as string[] };
    const createClient = (key: string): MessagesClientLike => {
      seen.keys.push(key);
      return {
        messages: { stream: () => { throw new Error("not used"); } },
        models: {
          list(params) {
            seen.params.push(params);
            return (async function* () {
              for (const page of pages) {
                seen.pagesFetched++;
                yield* page;
              }
            })();
          },
        },
      };
    };
    return { seen, createClient };
  }

  test("lists every page, de-duplicates, marks the driver default", async () => {
    const { seen, createClient } = pagedModels([
      [{ id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: DEFAULT_ANTHROPIC_MODEL, display_name: "Claude Sonnet 5" }],
      [{ id: "claude-haiku-4-5", display_name: "" }, { id: "claude-opus-5", display_name: "dup" }],
    ]);
    const driver = new AnthropicApiDriver({ settings: () => ({ ...baseSettings, anthropicApiKey: "sk-set" }), createClient, env: {} });
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: "claude-opus-5", name: "Claude Opus 5" },
      { id: DEFAULT_ANTHROPIC_MODEL, name: "Claude Sonnet 5", default: true },
      { id: "claude-haiku-4-5", name: "claude-haiku-4-5" },
    ]);
    expect(seen.pagesFetched).toBe(2);
    expect(seen.keys).toEqual(["sk-set"]);
  });

  test("no API key → throws (the catalog turns it into [] + error)", async () => {
    const { seen, createClient } = pagedModels([[]]);
    const driver = new AnthropicApiDriver({ settings: () => ({ ...baseSettings, anthropicApiKey: null }), createClient, env: {} });
    await expect(driver.listModels()).rejects.toThrow(/No Anthropic API key/);
    expect(seen.keys).toEqual([]);
  });

  test("API errors propagate from listing", async () => {
    const driver = new AnthropicApiDriver({
      settings: () => ({ ...baseSettings, anthropicApiKey: "sk" }),
      createClient: () => ({
        messages: { stream: () => { throw new Error("not used"); } },
        models: {
          list: () =>
            (async function* () {
              throw new Error("401 invalid x-api-key");
            })(),
        },
      }),
      env: {},
    });
    await expect(driver.listModels()).rejects.toThrow("401 invalid x-api-key");
  });

  test("runs use req.model, else the driver default", async () => {
    const a = driverWith([{ content: [text("ok")], stop_reason: "end_turn" }], { anthropicApiKey: "sk" });
    await collect(a.driver, makeReq("work", "x", { model: "claude-opus-5" }).req);
    await collect(a.driver, makeReq("work", "y").req);
    expect(a.fake.requests.map((r) => r.model)).toEqual(["claude-opus-5", DEFAULT_ANTHROPIC_MODEL]);
  });

  test("info shows the settings default model", async () => {
    const d = driverWith([], { anthropicApiKey: "sk", defaultModels: { "anthropic-api": "claude-opus-5" } });
    expect((await d.driver.info()).detail).toStartWith("claude-opus-5 ·");
  });
});
