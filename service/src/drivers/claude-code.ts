// claude-code driver: wraps the `claude` CLI in print mode with stream-json output.
// Harness tools reach the CLI through the run's MCP endpoint (--mcp-config).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverInfo, ModelInfo, Settings, ToolResultContent } from "@harness/shared";
import { queryClaudeModels } from "./claude-code-models";
import type { Driver, DriverEvent, RunRequest } from "./types";

export const MCP_SERVER_NAME = "harness";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export interface ClaudeCodeState {
  sessionId: string;
  /**
   * The CLI's total_cost_usd for the session so far. On --resume the CLI reports the
   * session's cumulative cost, so the per-run usage cost is the difference.
   */
  costUsd?: number;
}

export interface ClaudeCodeDriverOptions {
  settings: () => Settings;
  /** Explicit binary (tests); otherwise HARNESS_CLAUDE_BIN, `which claude`, ~/.local/bin/claude */
  bin?: string;
  /** Base environment for the child (default process.env) */
  env?: Record<string, string | undefined>;
  /** How long login() waits for the CLI to print its URL */
  loginUrlTimeoutMs?: number;
}

/** Resolve the claude binary: HARNESS_CLAUDE_BIN, then PATH, then ~/.local/bin/claude. */
export function resolveClaudeBin(env: Record<string, string | undefined> = process.env): string {
  if (env.HARNESS_CLAUDE_BIN) return env.HARNESS_CLAUDE_BIN;
  const onPath = Bun.which("claude", env.PATH ? { PATH: env.PATH } : undefined);
  if (onPath) return onPath;
  return join(homedir(), ".local", "bin", "claude");
}

// Variables Claude Code sets for its own children. Passing them on makes the child
// believe it is nested inside another session (and talk to the parent's sockets).
const NESTING_VARS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION"]);
// CLAUDE_CODE_* variables that are genuine user configuration and should pass through.
const USER_CONFIG = /^CLAUDE_CODE_(USE_|OAUTH_TOKEN|MAX_|DISABLE_|ENABLE_|SKIP_|API_KEY_HELPER|SUBAGENT_MODEL)/;

export function cleanClaudeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (NESTING_VARS.has(k)) continue;
    if (k.startsWith("CLAUDE_CODE_") && !USER_CONFIG.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function displayToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Build the CLI argv (without the binary). The prompt is written to stdin. */
export const PERMISSION_PROMPT_TOOL = `${MCP_PREFIX}permission_prompt`;

export function buildClaudeArgs(
  req: Pick<RunRequest, "kind" | "systemPrompt" | "mcp"> & { model?: string | null; tools?: Pick<RunRequest["tools"][number], "name">[] },
  settings: Settings,
  resumeSessionId: string | null,
): string[] {
  // alwaysLoad: opt the harness server out of Claude Code's tool deferral, so its tools are in
  // the prompt from the first turn instead of being discovered through ToolSearch.
  const mcpConfig = { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: req.mcp.url, headers: req.mcp.headers, alwaysLoad: true } } };
  const permissionMode = req.kind === "plan" ? "plan" : settings.claudePermissionMode;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    // Server-level rule: allow every tool of the harness MCP server without prompting
    // (matters for acceptEdits / dontAsk / plan; bypassPermissions allows them anyway).
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-mode",
    permissionMode,
  ];
  // Anything the permission mode doesn't auto-allow is asked of the harness (and so a human)
  // instead of being denied silently. Only when the run actually serves the tool: the CLI
  // fails a prompt that names a tool it can't find.
  if (!req.tools || req.tools.some((t) => t.name === "permission_prompt")) {
    args.push("--permission-prompt-tool", PERMISSION_PROMPT_TOOL);
  }
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  // A resumed conversation continues under whatever --model this run asks for.
  if (req.model) args.push("--model", req.model);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

function toolResultContent(content: unknown): ToolResultContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: JSON.stringify(content) }];
  const out: ToolResultContent[] = [];
  for (const block of content as any[]) {
    if (block?.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if (block?.type === "image" && block.source?.type === "base64") {
      out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type ?? "image/png" });
    } else if (block?.type === "image" && typeof block.data === "string") {
      out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
    } else if (block != null) out.push({ type: "text", text: typeof block === "string" ? block : JSON.stringify(block) });
  }
  return out;
}

export interface ClaudeResultInfo {
  isError: boolean;
  message: string;
  errors: string[];
}

/**
 * Stateful translator from `claude -p --output-format stream-json` lines to DriverEvents.
 * Messages from subagents (parent_tool_use_id set) are skipped; the Task tool call
 * and its final result still show up at the top level.
 */
export class StreamJsonParser {
  sessionId: string | null = null;
  result: ClaudeResultInfo | null = null;
  sawInit = false;
  private toolNames = new Map<string, string>();

  /** @param baseline the resumed session and its cumulative cost before this run (from state) */
  constructor(private readonly baseline: { sessionId: string; costUsd: number } | null = null) {}

  /** Prior cumulative cost of the current session (0 unless it is the resumed one). */
  private priorCost(): number {
    return this.baseline && this.baseline.sessionId === this.sessionId ? this.baseline.costUsd : 0;
  }

  handle(msg: any): DriverEvent[] {
    if (!msg || typeof msg !== "object") return [];
    const events: DriverEvent[] = [];
    const noteSession = (id: unknown) => {
      if (typeof id === "string" && id && id !== this.sessionId) {
        this.sessionId = id;
        events.push({ type: "state", state: { sessionId: id, costUsd: this.priorCost() } satisfies ClaudeCodeState });
      }
    };
    if (msg.parent_tool_use_id) return [];

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sawInit = true;
          noteSession(msg.session_id);
        }
        break;
      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          events.push({ type: "text_delta", text: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            events.push({ type: "text", text: block.text });
          } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            events.push({ type: "thinking", text: block.thinking });
          } else if (block?.type === "tool_use") {
            const name = displayToolName(String(block.name));
            this.toolNames.set(block.id, name);
            events.push({ type: "tool_call", callId: String(block.id), name, input: block.input ?? {} });
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          const callId = String(block.tool_use_id);
          events.push({
            type: "tool_result",
            callId,
            name: this.toolNames.get(callId) ?? "unknown",
            result: { content: toolResultContent(block.content), ...(block.is_error ? { isError: true } : {}) },
          });
        }
        break;
      }
      case "result": {
        noteSession(msg.session_id);
        const total = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
        // total_cost_usd is cumulative across --resume; report this run's share.
        const prior = this.priorCost();
        const cost = total === undefined ? undefined : total >= prior ? total - prior : total;
        const usage = msg.usage ?? {};
        const input = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
          .filter((n): n is number => typeof n === "number")
          .reduce((a, b) => a + b, 0);
        events.push({
          type: "usage",
          inputTokens: input,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
          costUsd: cost,
        });
        if (total !== undefined && this.sessionId) {
          events.push({ type: "state", state: { sessionId: this.sessionId, costUsd: total } satisfies ClaudeCodeState });
        }
        const errors: string[] = Array.isArray(msg.errors) ? msg.errors.map(String) : [];
        const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
        const message =
          (typeof msg.result === "string" && msg.result.trim()) || errors.join("; ") || (isError ? `claude ended with ${msg.subtype ?? "an error"}` : "");
        this.result = { isError, message, errors };
        break;
      }
    }
    return events;
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf.trim();
}

function abortError(): Error {
  const err = new Error("Run aborted");
  err.name = "AbortError";
  return err;
}

const NO_CONVERSATION = /No conversation found/i;

export class ClaudeCodeDriver implements Driver {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly description = "Runs the claude CLI with your Claude login (team plan). Harness tools are provided over MCP.";
  readonly hasBuiltinTools = true;
  readonly usesPermissionPromptTool = true;

  constructor(private readonly opts: ClaudeCodeDriverOptions) {}

  private get env(): Record<string, string | undefined> {
    return this.opts.env ?? process.env;
  }

  bin(): string {
    return this.opts.bin ?? resolveClaudeBin(this.env);
  }

  async info(): Promise<DriverInfo> {
    const base = { id: this.id, name: this.name, description: this.description, supportsLogin: true };
    const bin = this.bin();
    if (!existsSync(bin)) {
      return { ...base, available: false, authenticated: false, detail: `claude CLI not found (looked for ${bin}; set HARNESS_CLAUDE_BIN)` };
    }
    try {
      const proc = Bun.spawn([bin, "auth", "status", "--json"], { stdout: "pipe", stderr: "pipe", env: cleanClaudeEnv(this.env) });
      const timer = setTimeout(() => proc.kill(), 15_000);
      const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      // The CLI may print warnings before the JSON document.
      const start = out.indexOf("{");
      const status = start === -1 ? null : JSON.parse(out.slice(start));
      if (!status?.loggedIn) {
        return { ...base, available: true, authenticated: false, detail: "Not logged in. Log in to use your Claude plan." };
      }
      const who = [status.email, status.orgName].filter(Boolean).join(" · ");
      const detail = `${who || status.authMethod || "Logged in"}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`;
      return { ...base, available: true, authenticated: true, detail };
    } catch (err) {
      return { ...base, available: true, authenticated: false, detail: `Could not read claude auth status: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** The models the CLI offers this account (org availableModels applied), via `initialize`. */
  async listModels(): Promise<ModelInfo[]> {
    return queryClaudeModels({ bin: this.bin(), env: cleanClaudeEnv(this.env) });
  }

  async login(): Promise<{ url: string | null; message: string }> {
    const bin = this.bin();
    if (!existsSync(bin)) return { url: null, message: `claude CLI not found at ${bin}` };
    const proc = Bun.spawn([bin, "auth", "login", "--claudeai"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cleanClaudeEnv(this.env) });
    const timeoutMs = this.opts.loginUrlTimeoutMs ?? 20_000;
    let resolveUrl!: (u: string | null) => void;
    const found = new Promise<string | null>((r) => (resolveUrl = r));
    // Keep draining both streams so the CLI never blocks on a full pipe; it finishes
    // the login in the background once the human completes it in the browser.
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const m = buf.match(/https:\/\/[^\s"'<>]+/);
        if (m) resolveUrl(m[0]);
        if (buf.length > 64_000) buf = buf.slice(-8_000);
      }
    };
    void scan(proc.stdout).catch(() => {});
    void scan(proc.stderr).catch(() => {});
    void proc.exited.then(() => resolveUrl(null));
    const timer = setTimeout(() => resolveUrl(null), timeoutMs);
    const url = await found;
    clearTimeout(timer);
    return url
      ? { url, message: "Open the URL to finish logging in to Claude. The harness picks up the login automatically." }
      : { url: null, message: "claude auth login did not print a login URL. Run `claude auth login --claudeai` in a terminal." };
  }

  async *run(req: RunRequest): AsyncGenerator<DriverEvent> {
    const state = req.state as Partial<ClaudeCodeState> | null;
    const resume = typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : null;
    const first = yield* this.attempt(req, resume);
    if (first === "retry-fresh") {
      // Sessions are stored per working directory; after a worktree switch (or cleanup)
      // the old session can't be resumed. Start a new conversation instead.
      const second = yield* this.attempt(req, null);
      if (second === "retry-fresh") throw new Error("claude could not start a conversation");
    }
  }

  /** One CLI invocation. Returns "retry-fresh" when --resume failed before anything happened. */
  private async *attempt(req: RunRequest, resume: string | null): AsyncGenerator<DriverEvent, "done" | "retry-fresh"> {
    if (req.signal.aborted) throw abortError();
    const settings = this.opts.settings();
    const args = buildClaudeArgs(req, settings, resume);
    const proc = Bun.spawn([this.bin(), ...args], {
      cwd: req.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: cleanClaudeEnv(this.env),
    });
    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderr += decoder.decode(chunk, { stream: true });
        if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      }
    })().catch(() => {});

    try {
      proc.stdin.write(req.prompt);
      await proc.stdin.end();
    } catch {
      /* child died early; reported below */
    }

    const priorCost = (req.state as Partial<ClaudeCodeState> | null)?.costUsd;
    const parser = new StreamJsonParser(resume ? { sessionId: resume, costUsd: typeof priorCost === "number" ? priorCost : 0 } : null);
    const buffered: DriverEvent[] = [];
    try {
      for await (const line of readLines(proc.stdout)) {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        const events = parser.handle(msg);
        // Hold events back until the session has started so a failed --resume can be
        // retried without having emitted anything.
        if (resume && !parser.sawInit) buffered.push(...events);
        else {
          for (const ev of buffered.splice(0)) yield ev;
          for (const ev of events) yield ev;
        }
      }
      const exitCode = await proc.exited;
      await stderrDone;
      if (req.signal.aborted) throw abortError();

      const resumeFailed = resume && !parser.sawInit && (NO_CONVERSATION.test(stderr) || parser.result?.errors.some((e) => NO_CONVERSATION.test(e)));
      if (resumeFailed) return "retry-fresh";
      for (const ev of buffered.splice(0)) yield ev;

      if (parser.result?.isError) {
        const message = parser.result.message || `claude exited with code ${exitCode}`;
        yield { type: "error", message };
        throw new Error(message);
      }
      if (!parser.result && exitCode !== 0) {
        const tail = stderr.trim().split("\n").filter((l) => !/extra certs/i.test(l)).slice(-5).join("\n");
        const message = `claude exited with code ${exitCode}${tail ? `: ${tail}` : ""}`;
        yield { type: "error", message };
        throw new Error(message);
      }
      return "done";
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }
  }
}
