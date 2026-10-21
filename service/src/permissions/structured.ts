// One stateless, tool-less model call that answers with a JSON object, on the same two backends
// the auto-mode classifier uses (claude-cli, anthropic-api). The classifier and the chief-of-staff
// triage both call through here; each validates the value it gets back.

import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StructuredRequest {
  system: string;
  user: string;
  /** JSON schema of the answer */
  schema: object;
  /** The forced tool's name on the API backend */
  toolName: string;
  toolDescription: string;
  model: string;
  /** Working directory of the CLI process */
  cwd: string;
  maxTokens?: number;
}

export interface StructuredResult {
  /** The answer: an object, or text that may hold the JSON (callers parse it) */
  value: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** argv (without the binary) for one call; the system prompt is read from a file. */
export function claudeStructuredArgs(systemPromptFile: string, model: string, schema: object): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    // No tools at all, so the permission mode is moot; dontAsk (not plan) because plan mode
    // injects "you are in plan mode" context that the model then reasons about.
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt-file",
    systemPromptFile,
  ];
}

export interface ClaudeCliOptions {
  bin: () => string;
  env: () => Record<string, string>;
}

export async function claudeCliStructured(opts: ClaudeCliOptions, req: StructuredRequest, signal: AbortSignal): Promise<StructuredResult> {
  const dir = mkdtempSync(join(tmpdir(), "harness-structured-"));
  const file = join(dir, "system.md");
  writeFileSync(file, req.system);
  try {
    const proc = Bun.spawn([opts.bin(), ...claudeStructuredArgs(file, req.model, req.schema)], {
      cwd: req.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env(),
    });
    const kill = () => proc.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    try {
      proc.stdin.write(req.user);
      await proc.stdin.end();
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (signal.aborted) throw new Error("model call timed out");
      const start = out.indexOf("{");
      if (start === -1) throw new Error(`claude exited with ${code}${err.trim() ? `: ${err.trim().split("\n").slice(-2).join(" ")}` : ""}`);
      const result = JSON.parse(out.slice(start)) as { is_error?: boolean; result?: unknown; structured_output?: unknown; subtype?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (result.is_error) throw new Error(`claude error: ${typeof result.result === "string" ? result.result : result.subtype}`);
      return { value: result.structured_output ?? result.result, tokensIn: result.usage?.input_tokens ?? null, tokensOut: result.usage?.output_tokens ?? null };
    } finally {
      signal.removeEventListener("abort", kill);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MessagesCreateLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> };
}

export interface AnthropicApiOptions {
  apiKey: () => string | null;
  createClient?: (apiKey: string) => MessagesCreateLike;
}

export async function anthropicStructured(opts: AnthropicApiOptions, req: StructuredRequest, signal: AbortSignal): Promise<StructuredResult> {
  const key = opts.apiKey();
  if (!key) throw new Error("no Anthropic API key");
  const client = opts.createClient ? opts.createClient(key) : (new Anthropic({ apiKey: key }) as unknown as MessagesCreateLike);
  const message = await client.messages.create(
    {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      // The instructions are identical for every call: cache them.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
      tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: req.toolName },
    },
    { signal },
  );
  const use = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return { value: use ? use.input : (text?.text ?? ""), tokensIn: message.usage?.input_tokens ?? null, tokensOut: message.usage?.output_tokens ?? null };
}
