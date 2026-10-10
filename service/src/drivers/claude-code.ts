// claude-code driver: wraps the `claude` CLI in print mode with stream-json input and output.
// Harness tools reach the CLI through the run's MCP endpoint (--mcp-config).

import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandMatch, DriverInfo, ModelInfo, PermissionMode, PlanWindow, Settings, SubagentKind, SubagentStatus, ToolResultContent } from "@harness/shared";
import { descendantPids, signalAll } from "../process-tree";
import { parseClaudeCommands, queryClaudeInitialize, queryClaudeModels } from "./claude-code-models";
import { PlanUsageError, withRunContext, type Driver, type DriverEvent, type RunGrants, type RunImage, type RunRequest } from "./types";

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
  /**
   * How long a turn that ended with background tasks still running waits for them. Unset waits
   * as long as they run (a monitor or an import can take days); a human can stop the run.
   */
  backgroundWaitMs?: number;
  /**
   * How long the CLI gets to exit once the harness closed its stdin (default 15s). Claude Code
   * stays up while a background task it started runs (a Monitor's `tail -f`, say), which held a
   * submitted run open with its agent review waiting (HARNESS-204). After this the CLI and every
   * process under it are stopped.
   */
  exitGraceMs?: number;
  /** Plan usage's HTTP client (tests) */
  fetch?: typeof fetch;
  /** Plan usage's login tokens, in place of the Keychain and credentials file (tests) */
  loginTokens?: () => Promise<string[]>;
}

const DEFAULT_EXIT_GRACE_MS = 15_000;

/**
 * Harness tools that finish a run. A turn that called one ends even if background tasks are
 * still running (a dev server started to check the UI never finishes on its own).
 */
const FINISHING_TOOLS = new Set(["submit_for_review", "block", "review_decision", "dispatch_ticket", "decline_work"]);

function formatWait(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
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

/**
 * The environment for an agent run: claudeCliEnv plus MCP_CONNECTION_NONBLOCKING=0, unless the
 * user set it. With stream-json input the CLI starts the first turn while claude.ai connectors
 * (hc-jira, Rovo, ...) are still "pending", so a triage agent that answers in one turn never sees
 * their tools and reports the MCP as unavailable, or as needing auth, since a plugin's duplicate
 * of a connector is listed as unauthenticated until the connector list arrives. "0" holds the
 * first turn until the connectors connect (up to MCP_CONNECT_TIMEOUT_MS; about a second).
 */
export function claudeRunEnv(env: Record<string, string | undefined>, settings: Pick<Settings, "claudeOauthToken">): Record<string, string> {
  return { MCP_CONNECTION_NONBLOCKING: "0", ...claudeCliEnv(env, settings) };
}

/**
 * cleanClaudeEnv plus the long-lived token from Settings (claudeOauthToken, made with `claude
 * setup-token`) as CLAUDE_CODE_OAUTH_TOKEN. Without one the CLI uses the login it keeps in the
 * Keychain, which a service started by launchd can't always read: it then falls back to
 * ~/.claude/.credentials.json, whose refresh token a terminal session may already have used up,
 * and every run fails to sign in (HARNESS-230).
 */
export function claudeCliEnv(env: Record<string, string | undefined>, settings: Pick<Settings, "claudeOauthToken">): Record<string, string> {
  const out = cleanClaudeEnv(env);
  if (settings.claudeOauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeOauthToken;
  return out;
}

// What the CLI reports when a run couldn't sign in, as opposed to a model or tool error:
// "Failed to authenticate: OAuth session expired and could not be refreshed",
// "Failed to authenticate. API Error: 401 OAuth access token is invalid.", "Invalid API key · Please run /login".
const AUTH_FAILURE = /Failed to authenticate|OAuth (session expired|refresh token is no longer valid|access token is invalid|token has expired)|Invalid API key|run \/login|Not logged in/i;

export function isClaudeAuthFailure(message: string): boolean {
  return AUTH_FAILURE.test(message);
}

/** A run's error (and the driver's status) once the CLI couldn't sign in, with what fixes it. */
export function claudeAuthFailureMessage(cliMessage: string, tokenSet: boolean): string {
  const why = cliMessage.trim().replace(/\.$/, "");
  return tokenSet
    ? `Claude Code couldn't sign in with the long-lived token from Settings (${why}). Make a new one with \`claude setup-token\` and paste it in Settings → Drivers → Claude Code.`
    : `Claude Code couldn't sign in from the harness service (${why}). The service can't always use the Claude login in your Keychain: run \`claude setup-token\` in a terminal and paste the token in Settings → Drivers → Claude Code, or log in again there.`;
}

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

/** Where Claude Code keeps a working directory's sessions: its path with every non-alphanumeric character as "-". */
export function claudeProjectDir(configDir: string, cwd: string): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Claude Code resumes a session only from the working directory it was started in: its
 * transcript lives under projects/<that directory>. When the ticket's workdir changed (update_branch
 * moved it into another worktree), copy the session's transcript (and its folder of sub-agent
 * transcripts, if any) into the new directory's project folder so --resume keeps the
 * conversation. Copies, never moves: the original stays where it was. Returns whether the
 * session is now under `cwd`'s project folder. When it can't be found, the driver's fresh-start
 * retry takes over.
 */
export function carrySession(configDir: string, sessionId: string, cwd: string): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false;
  let real = cwd;
  try {
    real = realpathSync(cwd); // the CLI files sessions under its resolved cwd (/private/var, not /var)
  } catch {}
  const target = claudeProjectDir(configDir, real);
  const file = `${sessionId}.jsonl`;
  if (existsSync(join(target, file))) return true;
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  const source = dirs.map((d) => join(projects, d)).find((d) => d !== target && existsSync(join(d, file)));
  if (!source) return false;
  mkdirSync(target, { recursive: true });
  cpSync(join(source, file), join(target, file));
  if (existsSync(join(source, sessionId))) cpSync(join(source, sessionId), join(target, sessionId), { recursive: true });
  return true;
}

export function displayToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/**
 * A user message's content: the prompt (or a steered message) alone, or with its attached images
 * as image blocks after it (DESIGN.md "Prompt attachments"), the shape the Messages API takes.
 */
export function userContent(prompt: string, images: RunImage[] | undefined): string | unknown[] {
  if (!images?.length) return prompt;
  return [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))];
}

/** Build the CLI argv (without the binary). The prompt is written to stdin as a stream-json user message. */
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

/** The --permission-mode a run gets: plan runs always "plan", else the mapped harness mode. */
export function cliPermissionMode(req: Pick<RunRequest, "kind" | "permissionMode">, settings: Pick<Settings, "permissionMode">): string {
  if (req.kind === "plan") return "plan";
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
    // stream-json input keeps the CLI alive while stdin is open, so a background task's
    // completion starts another turn instead of the task being killed when the turn ends.
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // The CLI echoes each stdin message (with our uuid) when its agent takes it in: mid-turn at
    // the next tool boundary, or as the start of a new turn. That's how steering knows a
    // message was delivered (DESIGN.md "Steering").
    "--replay-user-messages",
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

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const WINDOWS: { key: string; id: PlanWindow["id"]; label: string; seconds: number }[] = [
  { key: "five_hour", id: "five_hour", label: "5-hour", seconds: 5 * 3600 },
  { key: "seven_day", id: "seven_day", label: "Weekly", seconds: 7 * 86400 },
  { key: "seven_day_opus", id: "seven_day_opus", label: "Weekly · Opus", seconds: 7 * 86400 },
  { key: "seven_day_sonnet", id: "seven_day_sonnet", label: "Weekly · Sonnet", seconds: 7 * 86400 },
];

/** The usage endpoint's windows (`{ five_hour: { utilization: 0–100, resets_at } | null, … }`); the ones the account has. */
export function parseClaudeUsage(body: unknown): PlanWindow[] {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const out: PlanWindow[] = [];
  for (const w of WINDOWS) {
    const v = o[w.key];
    const used = typeof v?.utilization === "number" ? v.utilization : null;
    const resetsAt = typeof v?.resets_at === "string" ? Date.parse(v.resets_at) : NaN;
    if (used === null || !Number.isFinite(resetsAt)) continue;
    out.push({ id: w.id, label: w.label, usedPercent: used, resetsAt, windowSeconds: w.seconds });
  }
  if (!out.length) throw new PlanUsageError("Claude's usage endpoint reported no windows for this account");
  return out;
}

/** The access tokens of the login the CLI keeps: the macOS Keychain item, then ~/.claude/.credentials.json. */
async function claudeLoginTokens(env: Record<string, string | undefined>): Promise<string[]> {
  const out: string[] = [];
  const take = (text: string) => {
    try {
      const t = JSON.parse(text)?.claudeAiOauth?.accessToken;
      if (typeof t === "string" && t) out.push(t);
    } catch {
      /* not the credentials JSON */
    }
  };
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), 10_000);
      take(await new Response(proc.stdout).text());
      clearTimeout(timer);
    } catch {
      /* no keychain item */
    }
  }
  try {
    const file = Bun.file(join(claudeConfigDir(env), ".credentials.json"));
    if (await file.exists()) take(await file.text());
  } catch {
    /* unreadable */
  }
  return out;
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
/**
 * A result for a call that keeps running in the background (claude 2.1.284): Bash's "Command
 * running in background with ID: …" or "…was moved to the background (ID: …)", and Monitor's
 * "Monitor started (task …".
 */
const IN_BACKGROUND = /^\s*(Command (running in background|did not complete .* moved to the background)|Monitor started)/i;
/** Where a background task's output goes, from its tool result ("Output is being written to: …") */
const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/;
/** The task id in a Monitor's result ("Monitor started (task bm, …") */
const MONITOR_TASK = /Monitor started \(task ([\w-]+)/i;
/** The tools whose calls can keep running in the background as tasks (DESIGN.md "Background tasks") */
const TASK_TOOLS: Record<string, SubagentKind> = { Bash: "bash", Monitor: "monitor" };

/**
 * The file the CLI writes a task's output to when it doesn't say (a Monitor's result names only
 * its task): `<tmp>/claude-<uid>/<cwd>/<session>/tasks/<task>.output`, claude 2.1.286.
 */
/** `cwd` resolved the way the CLI sees it (/private/var, not /var), or as given when it can't be. */
function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function claudeTaskOutputPath(cwd: string, sessionId: string, taskId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(process.env.CLAUDE_CODE_TMPDIR || "/tmp", `claude-${uid}`, slug, sessionId, "tasks", `${taskId}.output`);
}

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
 *
 * One CLI process can run several turns: while stdin stays open, a background task's
 * completion starts a new turn, which sends another init and ends in another result. The
 * parser tracks the background tasks still running and whether the agent called a finishing
 * tool, so the driver knows when to close stdin.
 */
export class StreamJsonParser {
  sessionId: string | null = null;
  /** The latest turn's result */
  result: ClaudeResultInfo | null = null;
  sawInit = false;
  /** permissionMode the CLI reported in its init event */
  initPermissionMode: string | null = null;
  /** Background tasks (Bash and agents) started and not yet finished: CLI task id → description */
  readonly runningTasks = new Map<string, string>();
  /** The agent called a tool that finishes the run (FINISHING_TOOLS) */
  finished = false;
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, unknown>();
  /** Sub-agents reported so far (their tool call ids) */
  private subagents = new Set<string>();
  /** Sub-agent → the model reported for it last */
  private subagentModels = new Map<string, string>();
  /** CLI task id → the tool call id of the sub-agent it runs */
  private tasks = new Map<string, string>();
  /** Tool call id → the CLI task running it (any task type) */
  private taskCalls = new Map<string, string>();
  /** CLI task id → the tool call it runs (any task type; task_updated names only the task) */
  private callOfTask = new Map<string, string>();
  /** Background tasks (Bash, Monitor) reported so far (their tool call ids) */
  private bgTasks = new Set<string>();
  /** Tool call id → the description its task_started gave */
  private taskDescriptions = new Map<string, string>();
  /** The CLI's tasks folder for this session, from the first output path a result named */
  private tasksDir: string | null = null;

  /**
   * @param baseline the resumed session and its cumulative cost before this run (from state)
   * @param permission the --permission-mode asked for and the harness mode it came from, to
   *   report a downgrade (auto isn't available for every model) and log classifier denials
   */
  constructor(
    private readonly baseline: { sessionId: string; costUsd: number } | null = null,
    private readonly permission: { requested: string; mode: PermissionMode } | null = null,
    /** The CLI's (resolved) working directory, to find a Monitor's output file */
    private readonly cwd: string | null = null,
  ) {
    this.costBase = baseline;
  }

  /** Message ids whose usage was reported already */
  private callIds = new Set<string>();
  /** The session's cumulative cost at the last result (starts as the resumed session's). */
  private costBase: { sessionId: string; costUsd: number } | null;

  /** Prior cumulative cost of the current session (0 unless it is resumed or ran a turn already). */
  private priorCost(): number {
    return this.costBase && this.costBase.sessionId === this.sessionId ? this.costBase.costUsd : 0;
  }

  /** Report a Bash or Monitor call as a background task (once; later calls add its output path). */
  private reportTask(callId: string, events: DriverEvent[], outputPath?: string) {
    const kind = TASK_TOOLS[this.toolNames.get(callId) ?? ""];
    if (!kind) return;
    if (this.bgTasks.has(callId)) {
      if (outputPath) events.push({ type: "subagent", subagent: { id: callId, outputPath } });
      return;
    }
    this.bgTasks.add(callId);
    const input = (this.toolInputs.get(callId) ?? {}) as Record<string, unknown>;
    const command = str(input.command) ?? null;
    events.push({
      type: "subagent",
      subagent: {
        id: callId,
        kind,
        description: str(input.description) || this.taskDescriptions.get(callId) || command || "",
        command,
        status: "running",
        ...(outputPath ? { outputPath } : {}),
      },
    });
  }

  /** A task's output file when its result didn't name it: next to the others, else the CLI's layout. */
  private outputPathFor(taskId: string): string | undefined {
    if (this.tasksDir) return join(this.tasksDir, `${taskId}.output`);
    if (this.cwd && this.sessionId) return claudeTaskOutputPath(this.cwd, this.sessionId, taskId);
    return undefined;
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
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        if (info && typeof info === "object") {
          const windows: { id: "five_hour" | "seven_day"; used: number | null; resetsAt: number }[] = [];
          for (const id of ["five_hour", "seven_day"] as const) {
            const w = info.unifiedWindows?.[id];
            if (w && typeof w.resetsAt === "number") windows.push({ id, used: typeof w.utilization === "number" ? w.utilization : null, resetsAt: w.resetsAt * 1000 });
          }
          if (!windows.length && (info.rateLimitType === "five_hour" || info.rateLimitType === "seven_day") && typeof info.resetsAt === "number") {
            windows.push({ id: info.rateLimitType, used: null, resetsAt: info.resetsAt * 1000 });
          }
          events.push({ type: "rate_limit", status: str(info.status) ?? "allowed", windows });
        }
        break;
      }
      case "system":
        if (msg.subtype === "compact_boundary") {
          const m = msg.compact_metadata;
          events.push({ type: "compacted", before: typeof m?.pre_tokens === "number" ? m.pre_tokens : undefined, after: typeof m?.post_tokens === "number" ? m.post_tokens : undefined });
        }
        if (msg.subtype === "task_started" && typeof msg.task_id === "string") {
          this.runningTasks.set(msg.task_id, str(msg.description) ?? msg.task_id);
          if (typeof msg.tool_use_id === "string") {
            this.taskCalls.set(msg.tool_use_id, msg.task_id);
            this.callOfTask.set(msg.task_id, msg.tool_use_id);
          }
        } else if (msg.subtype === "task_notification" || (msg.subtype === "task_updated" && taskStatus(msg.patch?.status))) {
          if (typeof msg.task_id === "string") this.runningTasks.delete(msg.task_id);
        }
        if (msg.subtype === "task_started" && typeof msg.tool_use_id === "string" && TASK_TOOLS[this.toolNames.get(msg.tool_use_id) ?? ""]) {
          // A Bash or Monitor call: a background task once it's known to be in the background
          // (task_started says so, or its result does). A long foreground call is a task to the
          // CLI too, but the transcript already shows it.
          const callId = msg.tool_use_id;
          if (typeof msg.description === "string") this.taskDescriptions.set(callId, msg.description);
          if (msg.is_backgrounded === true) this.reportTask(callId, events);
        } else if (msg.subtype === "task_started" && typeof msg.tool_use_id === "string") {
          const callId = msg.tool_use_id;
          // Only agents are sub-agents.
          if (!this.subagents.has(callId) && msg.task_type !== "local_agent") break;
          if (typeof msg.task_id === "string") this.tasks.set(msg.task_id, callId);
          this.subagents.add(callId);
          events.push({
            type: "subagent",
            subagent: { id: callId, description: str(msg.description), agentType: str(msg.subagent_type), prompt: str(msg.prompt) },
          });
        } else if (msg.subtype === "task_notification" || msg.subtype === "task_updated") {
          const callId = str(msg.tool_use_id) ?? (typeof msg.task_id === "string" ? (this.tasks.get(msg.task_id) ?? this.callOfTask.get(msg.task_id)) : undefined);
          const status = taskStatus(msg.subtype === "task_updated" ? msg.patch?.status : msg.status);
          if (callId && this.bgTasks.has(callId)) {
            const outputPath = str(msg.output_file) || undefined;
            if (!status && !outputPath) break;
            events.push({
              type: "subagent",
              subagent: {
                id: callId,
                ...(status ? { status } : {}),
                ...(outputPath ? { outputPath } : {}),
                ...(status && typeof msg.summary === "string" && msg.summary ? { result: msg.summary } : {}),
              },
            });
            break;
          }
          if (!callId || !this.subagents.has(callId) || !status) break;
          events.push({ type: "subagent", subagent: { id: callId, status, ...(typeof msg.summary === "string" ? { result: msg.summary } : {}) } });
        } else if (msg.subtype === "init") {
          // Every turn of the process starts with an init; report a mode downgrade once.
          const firstInit = !this.sawInit;
          this.sawInit = true;
          noteSession(msg.session_id);
          if (typeof msg.permissionMode === "string") this.initPermissionMode = msg.permissionMode;
          const requested = this.permission?.requested;
          if (firstInit && requested && typeof msg.permissionMode === "string" && msg.permissionMode !== requested) {
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
        // One model call's usage (the message's content blocks arrive as separate events, each
        // repeating it): the gauge counts the session's own agent only, once per message.
        const messageId = str(msg.message?.id);
        const u = msg.message?.usage;
        if (!subagentId && messageId && u && typeof u === "object" && !this.callIds.has(messageId) && str(msg.message?.model) !== "<synthetic>") {
          this.callIds.add(messageId);
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          events.push({ type: "call", call: { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) } });
        }
        // A sub-agent's replies name the model that wrote them; the CLI's own messages (an API
        // error, an interrupt) say "<synthetic>".
        const model = str(msg.message?.model);
        if (subagentId && model && model !== "<synthetic>" && this.subagentModels.get(subagentId) !== model) {
          this.subagentModels.set(subagentId, model);
          events.push({ type: "subagent", subagent: { id: subagentId, model } });
        }
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
            if (!subagentId && FINISHING_TOOLS.has(name)) this.finished = true;
            events.push({ type: "tool_call", callId, name, input, ...from });
            if (AGENT_TOOLS.has(name) && !this.subagents.has(callId)) {
              this.subagents.add(callId);
              // The model the call asked for ("haiku"), until the sub-agent's replies name one.
              const model = str(input.model) || undefined;
              if (model) this.subagentModels.set(callId, model);
              events.push({
                type: "subagent",
                subagent: {
                  id: callId,
                  parentId: subagentId,
                  description: str(input.description) ?? "",
                  agentType: str(input.subagent_type) ?? null,
                  ...(model ? { model } : {}),
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
          // A long foreground call is a task too; its result finishes it unless the call went
          // to the background (run_in_background, a Bash timeout, an async agent).
          const task = this.taskCalls.get(callId);
          if (task && !subagentId && !ASYNC_LAUNCH.test(text) && !IN_BACKGROUND.test(text)) this.runningTasks.delete(task);
          const path = OUTPUT_PATH.exec(text)?.[1];
          if (path) this.tasksDir ??= dirname(path);
          if (!subagentId && !block.is_error && TASK_TOOLS[name] && IN_BACKGROUND.test(text)) {
            const monitorTask = MONITOR_TASK.exec(text)?.[1] ?? task;
            this.reportTask(callId, events, path ?? (TASK_TOOLS[name] === "monitor" && monitorTask ? this.outputPathFor(monitorTask) : undefined));
          }
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
          // The next turn's total includes this one.
          this.costBase = { sessionId: this.sessionId, costUsd: total };
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
  readonly subagentTool = "Claude Code's `Agent` tool (`Task` in older versions) with the `Explore` subagent type";
  readonly usesPermissionPromptTool = true;
  readonly supportsSteering = true;
  readonly sessionActions = { compact: true, newSession: true };

  /**
   * The CLI message of the last run that couldn't sign in, and the stored token it ran with. info()
   * reports the driver signed out while it stands: `claude auth status` still says loggedIn when the
   * refresh token is dead. A run that gets through, a finished login or a different token clears it.
   */
  private authFailure: { cliMessage: string; token: string | null } | null = null;

  constructor(private readonly opts: ClaudeCodeDriverOptions) {}

  private get env(): Record<string, string | undefined> {
    return this.opts.env ?? process.env;
  }

  private token(): string | null {
    return this.opts.settings().claudeOauthToken || null;
  }

  /** The environment for CLI calls: cleaned, with the stored token if there is one. */
  private cliEnv(): Record<string, string> {
    return claudeCliEnv(this.env, { claudeOauthToken: this.token() });
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
      const token = this.token();
      const proc = Bun.spawn([bin, "auth", "status", "--json"], { stdout: "pipe", stderr: "pipe", env: this.cliEnv() });
      const timer = setTimeout(() => proc.kill(), 15_000);
      const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      // The CLI may print warnings before the JSON document.
      const start = out.indexOf("{");
      const status = start === -1 ? null : JSON.parse(out.slice(start));
      if (!status?.loggedIn) {
        return { ...base, available: true, authenticated: false, detail: "Not logged in. Log in to use your Claude plan." };
      }
      const failed = this.authFailure?.token === token ? this.authFailure : null;
      if (failed) return { ...base, available: true, authenticated: false, detail: claudeAuthFailureMessage(failed.cliMessage, !!token) };
      const who = [status.email, status.orgName].filter(Boolean).join(" · ");
      const account = `${who || status.authMethod || "Logged in"}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`;
      // With a token the CLI doesn't know the account (authMethod "oauth_token"), only that it has one.
      const detail = token ? `Long-lived token from Settings${who ? ` · ${account}` : ""}` : account;
      return { ...base, available: true, authenticated: true, detail };
    } catch (err) {
      return { ...base, available: true, authenticated: false, detail: `Could not read claude auth status: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** The models the CLI offers this account (org availableModels applied), via `initialize`. */
  async listModels(): Promise<ModelInfo[]> {
    return queryClaudeModels({ bin: this.bin(), env: this.cliEnv() });
  }

  /**
   * The CLI's slash commands and skills for a session in `cwd` (built-ins, ~/.claude and project
   * skills and commands, plugins), via `initialize`. A prompt that starts with `/name` is expanded
   * by the CLI itself, so the driver sends it as written.
   */
  async listCommands(cwd: string): Promise<CommandMatch[]> {
    return parseClaudeCommands((await queryClaudeInitialize({ bin: this.bin(), env: this.cliEnv(), cwd }))?.commands);
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
    void proc.exited.then((code) => {
      if (code === 0) this.authFailure = null;
      resolveUrl(null);
    });
    const timer = setTimeout(() => resolveUrl(null), timeoutMs);
    const url = await found;
    clearTimeout(timer);
    return url
      ? { url, message: "Open the URL to finish logging in to Claude. The harness picks up the login automatically." }
      : { url: null, message: "claude auth login did not print a login URL. Run `claude auth login --claudeai` in a terminal." };
  }

  /**
   * Compact the saved conversation in place: `claude -p /compact --resume <id>` summarizes it and
   * keeps the same session id, so the saved state stays valid (only its cost moves). Reports the
   * conversation's size before and after from the CLI's compact boundary.
   */
  async *compact(req: RunRequest): AsyncGenerator<DriverEvent> {
    const state = req.state as Partial<ClaudeCodeState> | null;
    const resume = typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : null;
    if (!resume) throw new Error("This ticket has no saved Claude Code session to compact");
    try {
      carrySession(claudeConfigDir(this.env), resume, req.cwd);
    } catch {
      // --resume reports a missing session below.
    }
    const settings = this.opts.settings();
    const args = ["-p", "/compact", "--output-format", "stream-json", "--verbose", "--resume", resume];
    if (req.model) args.push("--model", req.model);
    const proc = Bun.spawn([this.bin(), ...args], { cwd: req.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: claudeRunEnv(this.env, settings) });
    const onAbort = () => {
      const pids = [proc.pid, ...descendantPids(proc.pid)];
      signalAll(pids, "SIGTERM");
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
    const priorCost = typeof state?.costUsd === "number" ? state.costUsd : 0;
    const parser = new StreamJsonParser({ sessionId: resume, costUsd: priorCost }, null, realCwd(req.cwd));
    let compacted = false;
    try {
      for await (const line of readLines(proc.stdout)) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parser.handle(msg)) {
          if (ev.type === "compacted") compacted = true;
          // The compact run's own calls and usage aren't the conversation the gauge shows.
          if (ev.type === "call" || ev.type === "text" || ev.type === "thinking") continue;
          yield ev;
        }
      }
      const exitCode = await proc.exited;
      await stderrDone;
      if (req.signal.aborted) throw abortError();
      if (parser.result?.isError || (!parser.result && exitCode !== 0)) {
        const tail = stderr.trim().split("\n").filter((l) => !/extra certs/i.test(l)).slice(-5).join("\n");
        throw new Error(this.runFailure(parser.result?.message || `claude exited with code ${exitCode}${tail ? `: ${tail}` : ""}`, settings));
      }
      if (!compacted) throw new Error("Claude Code didn't compact the session (no compact boundary reported)");
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }
  }

  /**
   * The account's 5-hour and weekly usage, from the endpoint Claude Code's /usage screen reads
   * (undocumented; it needs the account's OAuth token, so a stored `claude setup-token` token is
   * tried first, then the login the CLI keeps in the Keychain or ~/.claude/.credentials.json).
   */
  async planUsage(): Promise<PlanWindow[] | null> {
    const tokens = [this.token(), ...(await (this.opts.loginTokens ?? (() => claudeLoginTokens(this.env)))())].filter((t): t is string => !!t);
    if (!tokens.length) throw new PlanUsageError("Sign in to Claude Code to see plan usage");
    let lastError: PlanUsageError | null = null;
    for (const token of [...new Set(tokens)]) {
      try {
        const res = await (this.opts.fetch ?? fetch)(CLAUDE_USAGE_URL, {
          headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.294", Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 401 || res.status === 403) {
          lastError = new PlanUsageError("Sign in to Claude Code to see plan usage");
          continue;
        }
        if (res.status === 429 || res.status >= 500) throw new PlanUsageError(`Claude's usage endpoint answered ${res.status}`, true);
        if (!res.ok) throw new PlanUsageError(`Claude's usage endpoint answered ${res.status}`);
        return parseClaudeUsage(await res.json());
      } catch (err) {
        if (err instanceof PlanUsageError) {
          if (err.transient) throw err;
          lastError = err;
          continue;
        }
        throw new PlanUsageError(`Couldn't reach Claude's usage endpoint: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    }
    throw lastError ?? new PlanUsageError("Sign in to Claude Code to see plan usage");
  }

  async *run(req: RunRequest): AsyncGenerator<DriverEvent> {
    const state = req.state as Partial<ClaudeCodeState> | null;
    const resume = typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : null;
    if (resume) {
      try {
        carrySession(claudeConfigDir(this.env), resume, req.cwd);
      } catch {
        // Couldn't copy it: --resume fails and the fresh-start retry below takes over.
      }
    }
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
    try {
      const first = yield* this.attempt(req, resume);
      if (first === "retry-fresh") {
        // Sessions are stored per working directory; carrySession copies one to a new workdir,
        // but when it's gone (cleaned up, or never found) start a new conversation instead.
        const second = yield* this.attempt(req, null);
        if (second === "retry-fresh") throw new Error("claude could not start a conversation");
      }
    } finally {
      req.input?.close();
    }
  }

  /** A failed run's error. A sign-in failure is remembered for info() and says what fixes it. */
  private runFailure(message: string, settings: Settings): string {
    if (!isClaudeAuthFailure(message)) return message;
    const token = settings.claudeOauthToken || null;
    this.authFailure = { cliMessage: message, token };
    return claudeAuthFailureMessage(message, !!token);
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
      env: claudeRunEnv(this.env, settings),
    });
    // The CLI and everything it started: its background shells lead process groups of their own.
    const stopTree = () => {
      const pids = [proc.pid, ...descendantPids(proc.pid)];
      signalAll(pids, "SIGTERM");
      setTimeout(() => signalAll(pids, "SIGKILL"), 3000).unref?.();
    };
    const onAbort = stopTree;
    req.signal.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderr += decoder.decode(chunk, { stream: true });
        if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      }
    })().catch(() => {});

    const priorCost = (req.state as Partial<ClaudeCodeState> | null)?.costUsd;
    const parser = new StreamJsonParser(resume ? { sessionId: resume, costUsd: typeof priorCost === "number" ? priorCost : 0 } : null, {
      requested: planGrants(req, settings).permissionMode,
      mode: req.permissionMode ?? settings.permissionMode,
    }, realCwd(req.cwd));

    // stdin stays open while the turn runs. Closing it lets the CLI exit after the current
    // turn, though a background task can keep it up (claude 2.1.287 waits on a Monitor), so
    // closing also starts the exit grace period.
    const waitMs = this.opts.backgroundWaitMs;
    let stdinOpen = true;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let waitedOut = false;
    const exitGraceMs = this.opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    /** Background tasks still running when the CLI had to be stopped after its run ended */
    let heldOpenBy: string[] | null = null;
    const writeUser = (content: string | unknown[], uuid: string) => {
      try {
        proc.stdin.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content } }) + "\n");
        void Promise.resolve(proc.stdin.flush()).catch(() => {});
      } catch {
        /* child already gone; the message stays undelivered */
      }
    };
    // Human messages sent mid-run go straight to the CLI, which takes them in at its next tool
    // boundary (or starts a new turn with them once the current one ends).
    const writeInput = () => {
      if (stdinOpen && req.input) for (const m of req.input.take()) writeUser(userContent(m.text, m.images), m.id);
    };
    const closeStdin = () => {
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      // The run takes no more messages once the session started and stdin is closing (a failed
      // --resume keeps them for the fresh attempt). Refused messages become a queued run.
      if (!resume || parser.sawInit) req.input?.close();
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch {
        /* child already gone */
      }
      // EOF should end the CLI, but a background task it still runs keeps it up indefinitely.
      exitTimer = setTimeout(() => {
        heldOpenBy = [...parser.runningTasks.values()];
        stopTree();
      }, exitGraceMs);
      exitTimer.unref?.();
    };
    const promptId = crypto.randomUUID();
    let promptTaken = false;
    writeUser(userContent(withRunContext(req), req.images), promptId);
    // Messages written to a previous attempt (a failed --resume) that its CLI never took in.
    for (const m of req.input?.inFlight() ?? []) writeUser(userContent(m.text, m.images), m.id);
    writeInput();
    const unsubscribe = req.input?.onPush(writeInput);
    const buffered: DriverEvent[] = [];
    try {
      for await (const line of readLines(proc.stdout)) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        if (msg?.type === "user" && msg.isReplay === true && typeof msg.uuid === "string") {
          if (msg.uuid === promptId) promptTaken = true;
          req.input?.delivered(msg.uuid);
        }
        const events = parser.handle(msg);
        // Resuming a session whose last process ended with background tasks still running, the
        // CLI first reports them stopped and ends an empty turn (num_turns 0) before it reads the
        // prompt (claude 2.1.286). That result isn't the end of this run's turn: closing stdin
        // there let the prompt's turn run but killed the background work it started (HARNESS-139).
        const orphanTurn = msg?.type === "result" && !promptTaken && msg.num_turns === 0 && !parser.result?.isError;
        if (msg?.type === "result" && stdinOpen && !orphanTurn) {
          // The turn ended. Keep the CLI alive while a human message it hasn't taken in yet is
          // on stdin (it starts the next turn with it), or while the agent's own background
          // tasks run (a test suite it moved to the background, a sub-agent): their completion
          // starts the next turn. A finished run, an error or a turn with nothing left ends it;
          // an unseen message then becomes a queued run. There's no wait limit unless
          // backgroundWaitMs sets one (counted from the latest turn's end).
          const waiting = [...parser.runningTasks.values()];
          if (parser.finished || parser.result?.isError) closeStdin();
          else if (req.input?.pending) {
            if (waitTimer) clearTimeout(waitTimer);
            waitTimer = null;
          } else if (!waiting.length) closeStdin();
          else {
            events.push({
              type: "status",
              text: `Waiting for ${waiting.length === 1 ? "a background task" : `${waiting.length} background tasks`} to finish (${waiting.join("; ")})${waitMs === undefined ? "" : `, up to ${formatWait(waitMs)}`}.`,
            });
            if (waitTimer) clearTimeout(waitTimer);
            waitTimer = null;
            if (waitMs !== undefined) {
              waitTimer = setTimeout(() => {
                waitedOut = true;
                closeStdin();
              }, waitMs);
            }
          }
        }
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
      if (heldOpenBy) {
        const tasks: string[] = heldOpenBy;
        yield {
          type: "status",
          text: `Claude Code was still running ${formatWait(exitGraceMs)} after the run ended${tasks.length ? ` (kept up by ${tasks.join("; ")})` : ""}, so it and its background tasks were stopped.`,
        };
      }

      if (parser.result?.isError) {
        const message = this.runFailure(parser.result.message || `claude exited with code ${exitCode}`, settings);
        yield { type: "error", message };
        throw new Error(message);
      }
      if (!parser.result && exitCode !== 0) {
        const tail = stderr.trim().split("\n").filter((l) => !/extra certs/i.test(l)).slice(-5).join("\n");
        const message = this.runFailure(`claude exited with code ${exitCode}${tail ? `: ${tail}` : ""}`, settings);
        yield { type: "error", message };
        throw new Error(message);
      }
      this.authFailure = null;
      if (waitedOut && waitMs !== undefined) {
        yield { type: "status", text: `Background tasks were still running after ${formatWait(waitMs)}, so the turn ended and they were stopped.` };
      }
      return "done";
    } finally {
      unsubscribe?.();
      closeStdin();
      if (exitTimer) clearTimeout(exitTimer);
      req.signal.removeEventListener("abort", onAbort);
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }
  }
}
