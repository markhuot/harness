// claude-code driver: wraps the `claude` CLI in print mode with stream-json output.
// Harness tools reach the CLI through the run's MCP endpoint (--mcp-config).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverInfo, ModelInfo, PermissionMode, Settings, SubagentStatus, ToolResultContent } from "@harness/shared";
import { queryClaudeModels } from "./claude-code-models";
import type { Driver, DriverEvent, RunGrants, RunRequest } from "./types";

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
// AI_AGENT names the parent agent (claude-code_<version>_agent).
const NESTING_VARS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "AI_AGENT"]);
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

/**
 * Harness permission mode → CLI --permission-mode (verified against claude 2.1.283):
 *  - auto → "auto": Claude Code's classifier. Its denials go straight back to the model as an
 *    is_error tool_result ("…denied by the Claude Code auto mode classifier. Reason: […]");
 *    the permission prompt tool is NOT consulted for them. Not available for every model
 *    (haiku): the CLI then silently runs in "default" (see the downgrade notice).
 *  - ask → "acceptEdits": edits in the workdir run; everything else → permission prompt tool.
 *  - read_only → "dontAsk": reads and read-only Bash run, anything else is denied without a
 *    prompt. ("plan" would allow reads too, but writes a plan file under ~/.claude/plans and
 *    asks to ExitPlanMode through the prompt tool.)
 */
export const CLI_PERMISSION_MODES: Record<PermissionMode, string> = { auto: "auto", ask: "acceptEdits", read_only: "dontAsk" };

/** The --permission-mode a run gets: plan runs always "plan", chat runs "dontAsk", else the mapped harness mode. */
export function cliPermissionMode(req: Pick<RunRequest, "kind" | "permissionMode">, settings: Pick<Settings, "permissionMode">): string {
  if (req.kind === "plan") return "plan";
  if (req.kind === "chat") return CLI_PERMISSION_MODES.read_only;
  return CLI_PERMISSION_MODES[req.permissionMode ?? settings.permissionMode] ?? "acceptEdits";
}

// ---------------------------------------------------------------------------
// Human grants → --allowedTools rules (verified against claude 2.1.283, DESIGN.md "Permissions")
// ---------------------------------------------------------------------------

/** A tool name that is safe as a bare rule: no rule syntax, no list separators. */
const BARE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * "Always allow <Tool>" → the bare rule `<Tool>`. null for anything that isn't a plain tool
 * name, so a stored name can never smuggle in a pattern (`Bash(*)`) or a second rule (`Bash Edit`).
 * Note: in auto mode the CLI drops allow rules it considers arbitrary code execution (bare
 * `Bash`, `Bash(npx:*)`, ...) before its classifier runs; they still apply in ask mode.
 */
export function cliToolRule(name: string): string | null {
  return BARE_TOOL_NAME.test(name) ? name : null;
}

/** Shapes a Bash allow rule cannot express as the exact command (measured, see DESIGN.md). */
const INEXPRESSIBLE_BASH = [
  /\*/, // an unescaped * makes the rule a wildcard; an escaped one (\*) didn't match either
  /(^|[^|])\|(?!\|)/, // pipelines are checked per segment, so the whole-command rule never matches
  /[<>]/, // redirections (incl. 2>/dev/null) aren't matched by the exact rule
  /\$\(/, // $(…) command substitution isn't either
  /[\r\n\0]/, // multi-line commands: untested, not risked
  /\\$/, // a trailing backslash would sit right before the rule's closing parenthesis
];

/**
 * A one-time grant → an exact `Bash(<command>)` rule, or null when the CLI can't express exactly
 * that call (other tools, or a command shape the rule syntax doesn't match exactly). Rule
 * content escapes `\` `(` `)` with a backslash (the CLI unescapes `\(` `\)` then `\\`). Only
 * the command is matched: Bash's description/timeout aren't part of a rule.
 */
export function cliExactRule(toolName: string, input: unknown): string | null {
  if (toolName !== "Bash" || !input || typeof input !== "object") return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim() || command !== command.trim()) return null;
  if (INEXPRESSIBLE_BASH.some((re) => re.test(command))) return null;
  return `Bash(${command.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

export interface GrantPlan {
  /** --permission-mode for the run (auto may become acceptEdits, see below) */
  permissionMode: string;
  /** Rules appended to --allowedTools after the harness server entry */
  rules: string[];
  /** One-time grants passed as exact rules (reported as grant_applied) */
  applied: RunGrants["once"];
  /** One-time grants left to the permission prompt tool */
  prompted: RunGrants["once"];
}

/**
 * How a run's human grants reach the CLI. Tool grants become bare rules and one-time grants
 * exact rules. A one-time grant the rule syntax can't express (or whose rule was already tried)
 * is left to the permission prompt tool, which allows exactly that call once; auto mode would
 * send it to the classifier instead (the prompt tool is never asked about its denials), so such
 * a run is downgraded to acceptEdits.
 */
export function planGrants(
  req: Pick<RunRequest, "kind" | "permissionMode" | "grants"> & { tools?: Pick<RunRequest["tools"][number], "name">[] },
  settings: Pick<Settings, "permissionMode">,
): GrantPlan {
  const base = cliPermissionMode(req, settings);
  const plan: GrantPlan = { permissionMode: base, rules: [], applied: [], prompted: [] };
  // Plan and read-only runs never take grants (the orchestrator doesn't send them either).
  if (!req.grants || base === "plan" || base === "dontAsk") return plan;
  for (const name of req.grants.tools) {
    const rule = cliToolRule(name);
    if (rule && !plan.rules.includes(rule)) plan.rules.push(rule);
  }
  for (const g of req.grants.once) {
    const rule = g.viaPrompt ? null : cliExactRule(g.toolName, g.input);
    if (rule) {
      if (!plan.rules.includes(rule)) plan.rules.push(rule);
      plan.applied.push(g);
    } else plan.prompted.push(g);
  }
  const hasPromptTool = !req.tools || req.tools.some((t) => t.name === "permission_prompt");
  if (plan.prompted.length && base === "auto" && hasPromptTool) plan.permissionMode = "acceptEdits";
  return plan;
}

const CLASSIFIER_DENIAL = /denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*([^\n]*?)(?:\.\s+If you|\n|$))?/i;

export function buildClaudeArgs(
  req: Pick<RunRequest, "kind" | "systemPrompt" | "mcp"> & {
    model?: string | null;
    permissionMode?: PermissionMode;
    grants?: RunGrants;
    tools?: Pick<RunRequest["tools"][number], "name">[];
  },
  settings: Settings,
  resumeSessionId: string | null,
): string[] {
  // alwaysLoad: opt the harness server out of Claude Code's tool deferral, so its tools are in
  // the prompt from the first turn instead of being discovered through ToolSearch.
  const mcpConfig = { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: req.mcp.url, headers: req.mcp.headers, alwaysLoad: true } } };
  const { permissionMode, rules } = planGrants(req, settings);
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
    // Human grants follow as separate entries: one argv entry per rule, so a rule's spaces
    // stay inside it (the flag is variadic; the next --flag ends the list).
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    ...rules,
    "--permission-mode",
    permissionMode,
  ];
  // Anything the permission mode doesn't auto-allow is asked of the harness (and so a human)
  // instead of being denied silently. Only when the run actually serves the tool: the CLI
  // fails a prompt that names a tool it can't find. Read-only runs never ask: dontAsk denies.
  if (permissionMode !== "dontAsk" && (!req.tools || req.tools.some((t) => t.name === "permission_prompt"))) {
    args.push("--permission-prompt-tool", PERMISSION_PROMPT_TOOL);
  }
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  // A resumed conversation continues under whatever --model this run asks for.
  if (req.model) args.push("--model", req.model);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

function summarizeInput(input: unknown, max = 160): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = ["command", "file_path", "path", "url", "pattern"].find((k) => typeof o[k] === "string" && o[k]);
  const text = (pick ? String(o[pick]) : JSON.stringify(input ?? null)).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/** Claude Code's sub-agent tools: "Agent" (2.1+) and "Task" (older CLIs). */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** The Agent tool's result when it started the sub-agent in the background (the default in 2.1). */
const ASYNC_LAUNCH = /^\s*Async agent launched/i;

/** task_notification / task_updated status → SubagentStatus (running for anything unfinished). */
function taskStatus(status: unknown): SubagentStatus | null {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
      return "stopped";
    default:
      return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Stateful translator from `claude -p --output-format stream-json` lines to DriverEvents.
 *
 * Sub-agents (verified against claude 2.1.283, DESIGN.md "Sub-agents"): an Agent (or Task) tool
 * call starts one, reported as a "subagent" event keyed by the call id. Its own messages carry
 * that id as parent_tool_use_id and become events with `subagentId`. Its outcome is the tool
 * result, unless the result only says it was launched in the background; then the CLI's
 * task_notification (or task_updated, by task id) reports it later. Sub-agents' streaming deltas
 * are dropped (their full blocks still arrive), and their classifier denials are logged in their
 * transcript but never become the run's pending approval: the sub-agent reports back to the agent.
 * Anything else carrying parent_tool_use_id (tool_progress heartbeats of a long Bash call,
 * sub-agent stream events) is dropped.
 */
export class StreamJsonParser {
  sessionId: string | null = null;
  result: ClaudeResultInfo | null = null;
  sawInit = false;
  /** permissionMode the CLI reported in its init event */
  initPermissionMode: string | null = null;
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, unknown>();
  /** Sub-agents reported so far (their tool call ids) */
  private subagents = new Set<string>();
  /** CLI task id → the tool call id of the sub-agent it runs */
  private tasks = new Map<string, string>();

  /**
   * @param baseline the resumed session and its cumulative cost before this run (from state)
   * @param permission the --permission-mode asked for and the harness mode it came from, to
   *   report a downgrade (auto isn't available for every model) and log classifier denials
   */
  constructor(
    private readonly baseline: { sessionId: string; costUsd: number } | null = null,
    private readonly permission: { requested: string; mode: PermissionMode } | null = null,
  ) {}

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
    const parentId = typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id ? msg.parent_tool_use_id : null;
    // parent_tool_use_id means "inside that tool call". Only conversation messages (assistant /
    // user) under it are a sub-agent's output; the rest is the tool's own progress, e.g. the
    // tool_progress heartbeat a long-running Bash call sends every 30s (claude 2.1.283).
    if (parentId && msg.type !== "assistant" && msg.type !== "user") return [];
    const subagentId = parentId;
    if (subagentId && !this.subagents.has(subagentId)) {
      // A known call that isn't an agent tool never runs a sub-agent.
      const known = this.toolNames.get(subagentId);
      if (known !== undefined && !AGENT_TOOLS.has(known)) return [];
      // Output from a sub-agent this run didn't see start (e.g. one continued from an earlier run).
      this.subagents.add(subagentId);
      events.push({ type: "subagent", subagent: { id: subagentId, description: "Sub-agent" } });
    }
    const from = subagentId ? { subagentId } : {};

    switch (msg.type) {
      case "system":
        if (msg.subtype === "task_started" && typeof msg.tool_use_id === "string") {
          const callId = msg.tool_use_id;
          // Background Bash commands are tasks too; only agents are sub-agents.
          if (!this.subagents.has(callId) && msg.task_type !== "local_agent") break;
          if (typeof msg.task_id === "string") this.tasks.set(msg.task_id, callId);
          this.subagents.add(callId);
          events.push({
            type: "subagent",
            subagent: { id: callId, description: str(msg.description), agentType: str(msg.subagent_type), prompt: str(msg.prompt) },
          });
        } else if (msg.subtype === "task_notification" || msg.subtype === "task_updated") {
          const callId = str(msg.tool_use_id) ?? (typeof msg.task_id === "string" ? this.tasks.get(msg.task_id) : undefined);
          const status = taskStatus(msg.subtype === "task_updated" ? msg.patch?.status : msg.status);
          if (!callId || !this.subagents.has(callId) || !status) break;
          events.push({ type: "subagent", subagent: { id: callId, status, ...(typeof msg.summary === "string" ? { result: msg.summary } : {}) } });
        } else if (msg.subtype === "init") {
          this.sawInit = true;
          noteSession(msg.session_id);
          if (typeof msg.permissionMode === "string") this.initPermissionMode = msg.permissionMode;
          const requested = this.permission?.requested;
          if (requested && typeof msg.permissionMode === "string" && msg.permissionMode !== requested) {
            const model = typeof msg.model === "string" && msg.model ? msg.model : "this model";
            events.push({
              type: "status",
              text:
                requested === "auto"
                  ? `Auto mode isn't available for ${model}; unapproved actions will ask you instead.`
                  : `Claude Code is running in ${msg.permissionMode} mode instead of ${requested}.`,
            });
          }
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
            events.push({ type: "text", text: block.text, ...from });
          } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            events.push({ type: "thinking", text: block.thinking, ...from });
          } else if (block?.type === "tool_use") {
            const name = displayToolName(String(block.name));
            const callId = String(block.id);
            const input = block.input ?? {};
            this.toolNames.set(callId, name);
            this.toolInputs.set(callId, input);
            events.push({ type: "tool_call", callId, name, input, ...from });
            if (AGENT_TOOLS.has(name) && !this.subagents.has(callId)) {
              this.subagents.add(callId);
              events.push({
                type: "subagent",
                subagent: {
                  id: callId,
                  parentId: subagentId,
                  description: str(input.description) ?? "",
                  agentType: str(input.subagent_type) ?? null,
                  prompt: str(input.prompt) ?? "",
                  status: "running",
                },
              });
            }
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
          const content = toolResultContent(block.content);
          const name = this.toolNames.get(callId) ?? "unknown";
          events.push({ type: "tool_result", callId, name, result: { content, ...(block.is_error ? { isError: true } : {}) }, ...from });
          const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          if (this.subagents.has(callId) && !ASYNC_LAUNCH.test(text)) {
            events.push({ type: "subagent", subagent: { id: callId, status: block.is_error ? "failed" : "succeeded", result: text } });
          }
          if (block.is_error) {
            const denied = CLASSIFIER_DENIAL.exec(text);
            if (denied) {
              const reason = denied[1]?.trim().replace(/\.$/, "") || "denied by Claude Code's auto mode classifier";
              events.push({
                type: "permission",
                log: {
                  tool: name,
                  summary: summarizeInput(this.toolInputs.get(callId)),
                  decision: "deny",
                  reason,
                  source: "classifier",
                  backend: "claude-code",
                  mode: this.permission?.mode ?? "auto",
                },
                ...from,
              });
              if (!subagentId) events.push({ type: "permission_denied", callId, toolName: name, input: this.toolInputs.get(callId) ?? {}, reason });
            }
          }
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
    const grants = planGrants(req, this.opts.settings());
    // The exact rules go to every CLI invocation of this run; the grants are used up by it.
    for (const g of grants.applied) yield { type: "grant_applied", toolName: g.toolName, input: g.input };
    if (grants.prompted.length && grants.permissionMode !== cliPermissionMode(req, this.opts.settings())) {
      const what = grants.prompted.map((g) => `${g.toolName} (${summarizeInput(g.input, 80)})`).join(", ");
      yield {
        type: "status",
        text: `Claude Code can't pre-approve ${what} as an exact rule, so this turn runs in ask mode: Claude Code asks the harness, which allows the approved call once.`,
      };
    }
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
    const parser = new StreamJsonParser(resume ? { sessionId: resume, costUsd: typeof priorCost === "number" ? priorCost : 0 } : null, {
      requested: planGrants(req, settings).permissionMode,
      mode: req.permissionMode ?? settings.permissionMode,
    });
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
