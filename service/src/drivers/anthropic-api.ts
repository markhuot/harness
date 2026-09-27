// anthropic-api driver: direct Messages API with an API key and a native tool loop.
// Message history is the driver state, so later runs continue the same conversation.

import Anthropic from "@anthropic-ai/sdk";
import type { DriverInfo, Settings } from "@harness/shared";
import type { ToolDefinition, ToolResult } from "../tools/types";
import { executeTool, type Driver, type DriverEvent, type RunRequest } from "./types";

export const MAX_ITERATIONS = 50;
const MAX_TOKENS = 32_000;

export interface AnthropicApiState {
  messages: Anthropic.MessageParam[];
}

/** The slice of MessageStream the driver uses (lets tests inject a fake). */
export interface MessageStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** The slice of the Anthropic client the driver uses. */
export interface MessagesClientLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): MessageStreamLike;
  };
}

export interface AnthropicApiDriverOptions {
  settings: () => Settings;
  /** Build a client for an API key (tests inject a fake). Default: new Anthropic({ apiKey }). */
  createClient?: (apiKey: string) => MessagesClientLike;
  /** Environment used for the ANTHROPIC_API_KEY fallback (default process.env). */
  env?: Record<string, string | undefined>;
}

function abortError(): Error {
  const err = new Error("Run aborted");
  err.name = "AbortError";
  return err;
}

export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function toToolResultBlock(toolUseId: string, result: ToolResult): Anthropic.ToolResultBlockParam {
  const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = result.content.map((c) =>
    c.type === "image"
      ? {
          type: "image",
          source: { type: "base64", media_type: c.mimeType as Anthropic.Base64ImageSource["media_type"], data: c.data },
        }
      : { type: "text", text: c.text || "(empty)" },
  );
  const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: toolUseId, content };
  if (result.isError) block.is_error = true;
  return block;
}

/**
 * Tool calls left unanswered by an interrupted run (abort mid-tool) would make the
 * next request invalid; answer them with an error result ahead of the new prompt.
 */
function danglingToolResults(messages: Anthropic.MessageParam[]): Anthropic.ToolResultBlockParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return last.content
    .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
    .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "The run was interrupted before this tool finished.", is_error: true }));
}

function readState(state: unknown): Anthropic.MessageParam[] {
  const messages = (state as Partial<AnthropicApiState> | null)?.messages;
  return Array.isArray(messages) ? structuredClone(messages) : [];
}

export class AnthropicApiDriver implements Driver {
  readonly id = "anthropic-api";
  readonly name = "Anthropic API";
  readonly description = "Calls the Claude Messages API directly with an API key, using the harness's own file and shell tools.";
  readonly hasBuiltinTools = false;

  constructor(private readonly opts: AnthropicApiDriverOptions) {}

  private apiKey(): { key: string; source: "settings" | "env" } | null {
    const fromSettings = this.opts.settings().anthropicApiKey;
    if (fromSettings) return { key: fromSettings, source: "settings" };
    const fromEnv = (this.opts.env ?? process.env).ANTHROPIC_API_KEY;
    if (fromEnv) return { key: fromEnv, source: "env" };
    return null;
  }

  private client(apiKey: string): MessagesClientLike {
    if (this.opts.createClient) return this.opts.createClient(apiKey);
    return new Anthropic({ apiKey }) as unknown as MessagesClientLike;
  }

  async info(): Promise<DriverInfo> {
    const key = this.apiKey();
    const model = this.opts.settings().anthropicModel;
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      available: true,
      authenticated: key !== null,
      detail: key
        ? `${model} · API key from ${key.source === "settings" ? "settings" : "ANTHROPIC_API_KEY"}`
        : "No API key. Add one in Settings or set ANTHROPIC_API_KEY.",
      supportsLogin: false,
    };
  }

  async *run(req: RunRequest): AsyncGenerator<DriverEvent> {
    const key = this.apiKey();
    if (!key) {
      const message = "No Anthropic API key configured. Add one in Settings or set ANTHROPIC_API_KEY.";
      yield { type: "error", message };
      throw new Error(message);
    }
    const settings = this.opts.settings();
    const client = this.client(key.key);
    const tools = toAnthropicTools(req.tools);

    const messages = readState(req.state);
    const pending = danglingToolResults(messages);
    messages.push({ role: "user", content: [...pending, { type: "text", text: req.prompt }] });

    let inputTokens = 0;
    let outputTokens = 0;
    const usage = (): DriverEvent => ({ type: "usage", inputTokens, outputTokens });

    for (let iteration = 0; ; iteration++) {
      if (req.signal.aborted) throw abortError();
      if (iteration >= MAX_ITERATIONS) {
        yield usage();
        const message = `Stopped after ${MAX_ITERATIONS} model turns without finishing.`;
        yield { type: "error", message };
        throw new Error(message);
      }

      const params: Anthropic.MessageStreamParams = {
        model: settings.anthropicModel,
        max_tokens: MAX_TOKENS,
        messages,
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        ...(tools.length ? { tools } : {}),
      };
      // Automatic prompt caching of the growing conversation prefix.
      (params as { cache_control?: unknown }).cache_control = { type: "ephemeral" };

      let message: Anthropic.Message;
      try {
        const stream = client.messages.stream(params, { signal: req.signal });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        if (req.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw abortError();
        yield usage();
        const text = err instanceof Anthropic.APIError ? `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}` : err instanceof Error ? err.message : String(err);
        yield { type: "error", message: text };
        throw err instanceof Error ? err : new Error(text);
      }

      const u = message.usage;
      inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      outputTokens += u.output_tokens ?? 0;

      // An empty assistant turn (e.g. a refusal before any output) would make the stored
      // history invalid for the next request.
      if (message.content.length > 0) messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });

      const toolUses: Anthropic.ToolUseBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) yield { type: "text", text: block.text };
        else if (block.type === "thinking" && block.thinking.trim()) yield { type: "thinking", text: block.thinking };
        else if (block.type === "tool_use") toolUses.push(block);
      }

      if (message.stop_reason === "refusal") {
        yield { type: "state", state: { messages } satisfies AnthropicApiState };
        yield usage();
        const text = "The model declined to continue (refusal).";
        yield { type: "error", message: text };
        throw new Error(text);
      }
      if (message.stop_reason === "pause_turn") {
        yield { type: "state", state: { messages } satisfies AnthropicApiState };
        continue;
      }
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        // end_turn / stop_sequence / max_tokens without pending tool calls: the turn is over.
        yield { type: "state", state: { messages } satisfies AnthropicApiState };
        yield usage();
        return;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (req.signal.aborted) {
          yield { type: "state", state: { messages } satisfies AnthropicApiState };
          throw abortError();
        }
        yield { type: "tool_call", callId: use.id, name: use.name, input: use.input };
        const result = await executeTool(req.tools, use.name, use.input, req.toolContext);
        yield { type: "tool_result", callId: use.id, name: use.name, result };
        results.push(toToolResultBlock(use.id, result));
      }
      messages.push({ role: "user", content: results });
      yield { type: "state", state: { messages } satisfies AnthropicApiState };
    }
  }
}
