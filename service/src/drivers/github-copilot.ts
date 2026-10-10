// github-copilot driver: wraps the GitHub Copilot CLI (`copilot`) in prompt mode with JSONL output.
// Harness tools reach the CLI through the run's MCP endpoint (--additional-mcp-config).
//
// Verified against copilot 1.0.91:
//  - `copilot -p <prompt> --output-format json` prints one JSON event per line and exits after
//    the turn. Events are { type, data, id, timestamp, ephemeral? }; the last line is
//    { type: "result", sessionId, exitCode, usage: { premiumRequests, ... } }.
//  - `--session-id <uuid>` creates a session with that id, or resumes it if it exists. Sessions
//    live in $COPILOT_HOME/session-state, not per working directory, so a moved workdir resumes.
//  - MCP tools are named `<server>-<tool>` and carry mcpServerName / mcpToolName.
//  - A tool the permission rules don't allow fails with error.code "denied" (nobody can answer the
//    prompt in -p mode), and the model sees the denial.
//  - Errors before the session starts (unknown model, no auth) go to stderr with exit code 1.
//  - There's no system-prompt flag and no stdin input in -p mode: the harness system prompt goes in
//    front of the prompt, and mid-run messages are queued as the next run instead (no steering).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverInfo, ModelInfo, PermissionMode, PlanWindow, Settings, ToolResultContent } from "@harness/shared";
import { descendantPids, signalAll } from "../process-tree";
import { ModelListError, PlanUsageError, withRunContext, type Driver, type DriverEvent, type RunGrants, type RunRequest } from "./types";

export const COPILOT_MCP_SERVER = "harness";
const MCP_PREFIX = `${COPILOT_MCP_SERVER}-`;

export interface CopilotState {
  sessionId: string;
}

export interface GitHubCopilotDriverOptions {
  /** Plan usage's HTTP client (tests) */
  fetch?: typeof fetch;
  /** The GitHub token for plan usage when Settings has none (default: `gh auth token`) */
  ghToken?: () => Promise<string | null>;
  settings: () => Settings;
  /** Explicit binary (tests); otherwise HARNESS_COPILOT_BIN, `which copilot`, common install paths */
  bin?: string;
  /** Base environment for the child (default process.env) */
  env?: Record<string, string | undefined>;
  /** How long login() waits for the CLI to print its device code */
  loginUrlTimeoutMs?: number;
}

/** Used when `copilot help config` can't be read. */
export const COPILOT_FALLBACK_MODELS: ModelInfo[] = [
  { id: "auto", name: "Auto", description: "Copilot picks the model", default: true },
  { id: "claude-sonnet-5", name: "claude-sonnet-5" },
  { id: "claude-opus-5.5", name: "claude-opus-5.5" },
  { id: "claude-haiku-4.5", name: "claude-haiku-4.5" },
];

/** Resolve the copilot binary: HARNESS_COPILOT_BIN, then PATH, then the usual install folders. */
export function resolveCopilotBin(env: Record<string, string | undefined> = process.env): string {
  if (env.HARNESS_COPILOT_BIN) return env.HARNESS_COPILOT_BIN;
  const onPath = Bun.which("copilot", env.PATH ? { PATH: env.PATH } : undefined);
  if (onPath) return onPath;
  const home = env.HOME || homedir();
  const candidates = [join(home, ".bun", "bin", "copilot"), "/opt/homebrew/bin/copilot", "/usr/local/bin/copilot", join(home, ".local", "bin", "copilot")];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * The monthly premium-request quota from GET /copilot_internal/user (undocumented). An account
 * with no quota to run out of (unlimited, or billed by tokens with no entitlement) has no window:
 * null. `now` finds the start of the month the quota resets at the end of.
 */
export function parseCopilotQuota(body: unknown): PlanWindow | null {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const q = o.quota_snapshots?.premium_interactions;
  if (!q || q.unlimited === true || typeof q.percent_remaining !== "number" || !(typeof q.entitlement === "number" && q.entitlement > 0)) return null;
  const reset = typeof o.quota_reset_date_utc === "string" ? Date.parse(o.quota_reset_date_utc) : typeof o.quota_reset_date === "string" ? Date.parse(`${o.quota_reset_date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(reset)) return null;
  const end = new Date(reset);
  const start = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, end.getUTCDate());
  return { id: "monthly", label: "Premium requests", usedPercent: Math.max(0, 100 - q.percent_remaining), resetsAt: reset, windowSeconds: Math.round((reset - start) / 1000) };
}

/** Copilot's config folder: $COPILOT_HOME, else ~/.copilot. */
export function copilotHome(env: Record<string, string | undefined>): string {
  return env.COPILOT_HOME || join(env.HOME || homedir(), ".copilot");
}

/** A session's event log: $COPILOT_HOME/session-state/<id>/events.jsonl. */
export function copilotEventsFile(env: Record<string, string | undefined>, sessionId: string): string {
  return join(copilotHome(env), "session-state", sessionId, "events.jsonl");
}

type CopilotCall = { input: number; cacheRead: number; cacheWrite: number; output: number };

/**
 * The model calls the CLI recorded for the session's own agent (verified against copilot 1.0.94):
 * each is a `session.usage_record` line in events.jsonl, which the CLI writes to disk but doesn't
 * print in `--output-format json`. `inputTokens` counts everything sent, cache included. A
 * sub-agent's calls carry an agentId and aren't the conversation. Returns [] when the file or the
 * records aren't there (an older CLI).
 */
export function readCopilotCalls(file: string): { id: string; call: CopilotCall }[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: { id: string; call: CopilotCall }[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"session.usage_record"')) continue;
    try {
      const rec = JSON.parse(line);
      const u = rec?.data?.usage;
      if (rec.type !== "session.usage_record" || rec.agentId || !u || typeof u.inputTokens !== "number") continue;
      const cacheRead = typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : 0;
      const cacheWrite = typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : 0;
      const id = String(u.apiCallId ?? u.accounting?.usageId ?? rec.id);
      out.push({ id, call: { input: Math.max(0, u.inputTokens - cacheRead - cacheWrite), cacheRead, cacheWrite, output: typeof u.outputTokens === "number" ? u.outputTokens : 0 } });
    } catch {
      /* a line that's still being written */
    }
  }
  return out;
}

/**
 * The conversation's size counted from its words, for a CLI whose log has no usage records: the
 * words of the messages, reasoning, tool calls and results in events.jsonl at about 0.75 words per
 * token. It leaves out the CLI's own system prompt and tool schemas, so it reads low. null when
 * there's no log.
 */
export function estimateCopilotTokens(file: string): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const countWords = (v: unknown): number => {
    if (typeof v === "string") return v.split(/\s+/).filter(Boolean).length;
    if (Array.isArray(v)) return v.reduce((n: number, x) => n + countWords(x), 0);
    if (v && typeof v === "object") return Object.values(v).reduce((n: number, x) => n + countWords(x), 0);
    return 0;
  };
  let words = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      const d = rec?.data;
      if (rec.agentId || !d) continue;
      if (rec.type === "user.message" || rec.type === "assistant.message") words += countWords(d.content) + countWords(d.toolRequests) + countWords(d.reasoningText);
      else if (rec.type === "tool.execution_complete") words += countWords(d.result);
    } catch {
      /* skip */
    }
  }
  return words ? Math.round(words / 0.75) : null;
}

/** The token env vars the CLI reads, in its order of precedence. */
const TOKEN_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * The environment for the CLI. COPILOT_ALLOW_ALL is dropped so the run's permission mode decides
 * what's allowed, not whatever the service happened to inherit. The token from Settings
 * (copilotGithubToken) goes in as COPILOT_GITHUB_TOKEN, which the CLI prefers over GH_TOKEN,
 * GITHUB_TOKEN and its stored login: a service started by launchd can't always read the login the
 * CLI keeps in the Keychain.
 */
export function copilotEnv(env: Record<string, string | undefined>, settings: Pick<Settings, "copilotGithubToken"> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "COPILOT_ALLOW_ALL") continue;
    out[k] = v;
  }
  if (settings.copilotGithubToken) out.COPILOT_GITHUB_TOKEN = settings.copilotGithubToken;
  return out;
}

/** Strip // line comments from the CLI's config.json (it starts with a comment header). */
function parseJsonc(text: string): any {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

/** Who the CLI is signed in as: an env token, or the users in $COPILOT_HOME/config.json. */
export function copilotAccount(env: Record<string, string | undefined>, settings: Pick<Settings, "copilotGithubToken"> = {}): { source: "settings" | "env" | "login"; detail: string } | null {
  if (settings.copilotGithubToken) return { source: "settings", detail: "Token from Settings" };
  const tokenVar = TOKEN_VARS.find((k) => env[k]);
  if (tokenVar) return { source: "env", detail: `Token from ${tokenVar}` };
  try {
    const config = parseJsonc(readFileSync(join(copilotHome(env), "config.json"), "utf8"));
    const user = config?.lastLoggedInUser ?? (Array.isArray(config?.loggedInUsers) ? config.loggedInUsers[0] : null);
    if (user?.login) {
      const host = typeof user.host === "string" && user.host !== "https://github.com" ? ` · ${user.host.replace(/^https?:\/\//, "")}` : "";
      return { source: "login", detail: `${user.login}${host}` };
    }
  } catch {}
  return null;
}

/**
 * The models `copilot help config` lists under `model`, a bulleted list of quoted ids. "auto"
 * (Copilot picks) comes first and is the default: it's what runs without --model unless the
 * user's settings.json chose one.
 */
export function parseCopilotModels(helpConfig: string): ModelInfo[] {
  const lines = helpConfig.split("\n");
  const start = lines.findIndex((l) => /^\s*`model`:/.test(l));
  if (start === -1) throw new Error("copilot help config lists no models");
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (!m) break;
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
  }
  if (!ids.length) throw new Error("copilot help config lists no models");
  return [{ id: "auto", name: "Auto", description: "Copilot picks the model", default: true }, ...ids.filter((id) => id !== "auto").map((id) => ({ id, name: id }))];
}

// ---------------------------------------------------------------------------
// Permissions (DESIGN.md "Permissions")
// ---------------------------------------------------------------------------

/** Copilot tool names → the permission kind that governs them. */
const TOOL_KINDS: Record<string, string> = { bash: "shell", shell: "shell", edit: "write", create: "write", str_replace: "write", write: "write" };

/** "Always allow <Tool>" → a Copilot rule kind (`shell`, `write`), or null for anything else. */
export function copilotToolRule(name: string): string | null {
  return TOOL_KINDS[name.toLowerCase()] ?? null;
}

/** Shapes a `shell(<command>)` rule can't express as exactly that command. */
const INEXPRESSIBLE_SHELL = [/[*;&|<>`]/, /\$\(/, /:\*?$/, /[()\\]/, /[\r\n\0]/];

/**
 * A one-time grant → `shell(<command>)`, or null. Copilot matches a compound command (`a ; b`)
 * against each part and denies it as a whole, so only simple commands without rule syntax
 * (`:*`, parentheses) are passed.
 */
export function copilotExactRule(toolName: string, input: unknown): string | null {
  if (copilotToolRule(toolName) !== "shell" || !input || typeof input !== "object") return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim() || command !== command.trim()) return null;
  if (INEXPRESSIBLE_SHELL.some((re) => re.test(command))) return null;
  return `shell(${command})`;
}

export interface CopilotPermissionPlan {
  /** Permission flags for the CLI */
  args: string[];
  /** One-time grants passed as exact rules (reported as grant_applied) */
  applied: RunGrants["once"];
  /** One-time grants the CLI can't express; the agent will be denied again */
  unexpressed: RunGrants["once"];
}

/**
 * Harness permission mode → CLI flags. The harness MCP server is always allowed.
 *  - auto → --allow-all (Copilot has no classifier of its own). --allow-all-tools alone still
 *    verifies paths and URLs, so prompt mode denies any command touching a path outside the
 *    cwd (/tmp, /Applications) with nobody to ask.
 *  - ask → writes in the workdir and read-only shell run; anything else is denied, reported as
 *    permission_denied, and becomes a pending approval. Human grants become allow rules.
 *  - read_only (and plan runs) → shell and writes denied outright.
 */
export function planCopilotPermissions(
  req: Pick<RunRequest, "kind" | "permissionMode" | "grants">,
  settings: Pick<Settings, "permissionMode">,
): CopilotPermissionPlan {
  const mode: PermissionMode = req.kind === "plan" ? "read_only" : (req.permissionMode ?? settings.permissionMode);
  const plan: CopilotPermissionPlan = { args: ["--allow-tool", COPILOT_MCP_SERVER], applied: [], unexpressed: [] };
  if (mode === "read_only") {
    plan.args.push("--deny-tool", "write", "--deny-tool", "shell");
    return plan;
  }
  if (mode === "auto") {
    plan.args.push("--allow-all");
    return plan;
  }
  plan.args.push("--allow-tool", "write");
  const rules = new Set<string>();
  for (const name of req.grants?.tools ?? []) {
    const rule = copilotToolRule(name);
    if (rule) rules.add(rule);
  }
  for (const g of req.grants?.once ?? []) {
    const rule = copilotExactRule(g.toolName, g.input);
    if (rule) {
      rules.add(rule);
      plan.applied.push(g);
    } else plan.unexpressed.push(g);
  }
  for (const r of rules) plan.args.push("--allow-tool", r);
  return plan;
}

/**
 * The prompt as the CLI gets it. There's no --append-system-prompt, so the harness instructions
 * go in front of the user's message on every run, then the run context. Both come after the
 * conversation's history, so they never invalidate its prompt cache.
 */
export function copilotPrompt(req: Pick<RunRequest, "prompt" | "systemPrompt" | "runContext">): string {
  const prompt = withRunContext(req);
  if (!req.systemPrompt) return prompt;
  return `<harness_instructions>\n${req.systemPrompt}\n</harness_instructions>\n\n${prompt}`;
}

export function buildCopilotArgs(
  req: Pick<RunRequest, "kind" | "prompt" | "systemPrompt" | "runContext" | "mcp" | "model" | "permissionMode" | "grants">,
  settings: Settings,
  sessionId: string,
): string[] {
  const mcpConfig = { mcpServers: { [COPILOT_MCP_SERVER]: { type: "http", url: req.mcp.url, headers: req.mcp.headers, tools: ["*"] } } };
  const args = [
    "-p",
    copilotPrompt(req),
    "--output-format",
    "json",
    "--stream",
    "on",
    "--session-id",
    sessionId,
    "--additional-mcp-config",
    JSON.stringify(mcpConfig),
    // Nobody can answer ask_user in prompt mode; the agent should block instead.
    "--no-ask-user",
    ...planCopilotPermissions(req, settings).args,
  ];
  if (req.model) args.push("--model", req.model);
  return args;
}

function summarizeInput(input: unknown, max = 160): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = ["command", "path", "file_path", "url", "pattern"].find((k) => typeof o[k] === "string" && o[k]);
  const text = (pick ? String(o[pick]) : JSON.stringify(input ?? null)).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolResultContent(result: any): ToolResultContent[] {
  if (Array.isArray(result?.contents)) {
    const out: ToolResultContent[] = [];
    for (const c of result.contents) {
      if (c?.type === "text" && typeof c.text === "string") out.push({ type: "text", text: c.text });
      else if (c?.type === "image" && typeof c.data === "string") out.push({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" });
    }
    if (out.length) return out;
  }
  if (typeof result?.content === "string") return [{ type: "text", text: result.content }];
  return result == null ? [] : [{ type: "text", text: JSON.stringify(result) }];
}

export function displayToolName(data: { toolName?: unknown; mcpServerName?: unknown; mcpToolName?: unknown }): string {
  if (data.mcpServerName === COPILOT_MCP_SERVER && typeof data.mcpToolName === "string") return data.mcpToolName;
  const name = String(data.toolName ?? "unknown");
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Stateful translator from `copilot -p --output-format json` lines to DriverEvents. */
export class CopilotJsonParser {
  sessionId: string | null = null;
  /** The final { type: "result" } line, once seen */
  result: { exitCode: number; premiumRequests?: number } | null = null;
  /** Errors the CLI reported as events */
  errors: string[] = [];
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, unknown>();
  private thoughts = new Set<string>();

  constructor(private readonly mode: PermissionMode = "ask") {}

  handle(msg: any): DriverEvent[] {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return [];
    const data = msg.data ?? {};
    const events: DriverEvent[] = [];
    switch (msg.type) {
      case "assistant.message_delta":
        if (typeof data.deltaContent === "string" && data.deltaContent) events.push({ type: "text_delta", text: data.deltaContent });
        break;
      case "assistant.message":
        if (typeof data.content === "string" && data.content.trim()) events.push({ type: "text", text: data.content });
        break;
      case "assistant.reasoning": {
        // The CLI can report the same reasoning twice (once more under an opaque id).
        const text = typeof data.content === "string" ? data.content : "";
        if (text.trim() && !this.thoughts.has(text)) {
          this.thoughts.add(text);
          events.push({ type: "thinking", text });
        }
        break;
      }
      case "tool.execution_start": {
        const callId = String(data.toolCallId);
        const name = displayToolName(data);
        const input = data.arguments ?? {};
        this.toolNames.set(callId, name);
        this.toolInputs.set(callId, input);
        events.push({ type: "tool_call", callId, name, input });
        break;
      }
      case "tool.execution_complete": {
        const callId = String(data.toolCallId);
        const name = this.toolNames.get(callId) ?? displayToolName(data);
        const errorText = typeof data.error?.message === "string" ? data.error.message : null;
        const content = data.success === false && errorText ? [{ type: "text" as const, text: errorText }] : toolResultContent(data.result);
        events.push({ type: "tool_result", callId, name, result: { content, ...(data.success === false ? { isError: true } : {}) } });
        if (data.error?.code === "denied") {
          const input = this.toolInputs.get(callId) ?? {};
          const reason = "not allowed by the ticket's permission mode";
          events.push({
            type: "permission",
            log: { tool: name, summary: summarizeInput(input), decision: "deny", reason, source: "policy", backend: "github-copilot", mode: this.mode },
          });
          events.push({ type: "permission_denied", callId, toolName: name, input, reason });
        }
        break;
      }
      case "result": {
        if (typeof msg.sessionId === "string") this.sessionId = msg.sessionId;
        const premium = typeof msg.usage?.premiumRequests === "number" ? msg.usage.premiumRequests : undefined;
        this.result = { exitCode: typeof msg.exitCode === "number" ? msg.exitCode : 0, premiumRequests: premium };
        // Copilot bills premium requests, not tokens or dollars, so there's nothing to add up here.
        events.push({ type: "usage" });
        break;
      }
      default:
        if (/(^|\.)error$/.test(msg.type) && typeof data.message === "string") this.errors.push(data.message);
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

const AUTH_FAILURE = /No authentication information found|not authenticated|401|Bad credentials|token (is )?(invalid|expired)/i;

export class GitHubCopilotDriver implements Driver {
  readonly id = "github-copilot";
  readonly name = "GitHub Copilot";
  readonly description = "Runs the GitHub Copilot CLI with your Copilot subscription. Harness tools are provided over MCP.";
  readonly hasBuiltinTools = true;
  readonly subagentTool = "Copilot's `task` tool with the `explore` agent type";
  readonly supportsSteering = false;
  readonly sessionActions = { compact: false, newSession: true };

  /**
   * The last run that couldn't sign in, and the stored token it ran with. info() reports the driver
   * signed out while it stands (the CLI's config.json still names the user when its token is dead).
   * A run that gets through, a finished login or a different token clears it.
   */
  private authFailure: { message: string; token: string | null } | null = null;

  constructor(private readonly opts: GitHubCopilotDriverOptions) {}

  /** The month's premium-request quota, when this account has one to run out of. */
  async planUsage(): Promise<PlanWindow[] | null> {
    const token = this.opts.settings().copilotGithubToken || (await (this.opts.ghToken ?? ghAuthToken)());
    if (!token) throw new PlanUsageError("Sign in to GitHub Copilot to see plan usage");
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)("https://api.github.com/copilot_internal/user", {
        headers: { Authorization: `token ${token}`, Accept: "application/json", "User-Agent": "harness" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new PlanUsageError(`Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new PlanUsageError("Sign in to GitHub Copilot to see plan usage");
    if (res.status === 429 || res.status >= 500) throw new PlanUsageError(`GitHub answered ${res.status}`, true);
    if (!res.ok) throw new PlanUsageError(`GitHub answered ${res.status}`);
    const window = parseCopilotQuota(await res.json());
    return window ? [window] : null;
  }

  private cliEnv(): Record<string, string> {
    return copilotEnv(this.env, this.opts.settings());
  }

  private get env(): Record<string, string | undefined> {
    return this.opts.env ?? process.env;
  }

  bin(): string {
    return this.opts.bin ?? resolveCopilotBin(this.env);
  }

  async info(): Promise<DriverInfo> {
    const base = { id: this.id, name: this.name, description: this.description, supportsLogin: true };
    const bin = this.bin();
    if (!existsSync(bin)) {
      return { ...base, available: false, authenticated: false, detail: `copilot CLI not found (looked for ${bin}; install @github/copilot or set HARNESS_COPILOT_BIN)` };
    }
    const token = this.opts.settings().copilotGithubToken || null;
    const failed = this.authFailure && this.authFailure.token === token ? this.authFailure.message : null;
    if (failed) return { ...base, available: true, authenticated: false, detail: failed };
    const account = copilotAccount(this.env, { copilotGithubToken: token });
    if (!account) return { ...base, available: true, authenticated: false, detail: "Not logged in. Log in with your GitHub account, or add a GitHub token in Settings → Drivers → GitHub Copilot." };
    return { ...base, available: true, authenticated: true, detail: account.detail };
  }

  /** The models the CLI documents in `copilot help config` (no tokens spent). */
  async listModels(): Promise<ModelInfo[]> {
    const bin = this.bin();
    if (!existsSync(bin)) throw new ModelListError(`copilot CLI not found at ${bin}`, COPILOT_FALLBACK_MODELS);
    try {
      const proc = Bun.spawn([bin, "help", "config"], { stdout: "pipe", stderr: "pipe", env: this.cliEnv() });
      const timer = setTimeout(() => proc.kill(), 15_000);
      const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      return parseCopilotModels(out);
    } catch (err) {
      throw new ModelListError(err instanceof Error ? err.message : String(err), COPILOT_FALLBACK_MODELS);
    }
  }

  /**
   * `copilot login --device-code`: returns the device URL with the code in the message. The CLI
   * keeps waiting in the background and stores the token once the human authorizes it.
   */
  async login(): Promise<{ url: string | null; message: string }> {
    const bin = this.bin();
    if (!existsSync(bin)) return { url: null, message: `copilot CLI not found at ${bin}` };
    const proc = Bun.spawn([bin, "login", "--device-code"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: copilotEnv(this.env) });
    let resolve!: (v: { url: string; code: string } | null) => void;
    const found = new Promise<{ url: string; code: string } | null>((r) => (resolve = r));
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const url = buf.match(/https:\/\/[^\s"'<>]+/)?.[0];
        const code = buf.match(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
        if (url && code) resolve({ url, code });
        if (buf.length > 64_000) buf = buf.slice(-8_000);
      }
    };
    void scan(proc.stdout).catch(() => {});
    void scan(proc.stderr).catch(() => {});
    void proc.exited.then((code) => {
      if (code === 0) this.authFailure = null;
      resolve(null);
    });
    const timer = setTimeout(() => resolve(null), this.opts.loginUrlTimeoutMs ?? 20_000);
    const hit = await found;
    clearTimeout(timer);
    return hit
      ? { url: hit.url, message: `Enter the code ${hit.code} on GitHub to finish logging in to Copilot. The harness picks up the login automatically.` }
      : { url: null, message: "copilot login did not print a device code. Run `copilot login` in a terminal." };
  }

  async *run(req: RunRequest): AsyncGenerator<DriverEvent> {
    try {
      yield* this.attempt(req);
    } finally {
      req.input?.close();
    }
  }

  /** A failed run's error. A sign-in failure is remembered for info() and says what fixes it. */
  private runFailure(why: string, settings: Settings): string {
    if (!AUTH_FAILURE.test(why)) return why;
    const token = settings.copilotGithubToken || null;
    const cause = why.trim().replace(/\.$/, "");
    const message = token
      ? `GitHub Copilot couldn't sign in with the token from Settings (${cause}). Make a new fine-grained token with the Copilot Requests permission and paste it in Settings → Drivers → GitHub Copilot.`
      : `GitHub Copilot couldn't sign in from the harness service (${cause}). Log in again in Settings → Drivers → GitHub Copilot, or add a GitHub token there.`;
    this.authFailure = { message, token };
    return message;
  }

  private async *attempt(req: RunRequest): AsyncGenerator<DriverEvent> {
    if (req.signal.aborted) throw abortError();
    const settings = this.opts.settings();
    const prior = (req.state as Partial<CopilotState> | null)?.sessionId;
    // --session-id resumes the session when it exists and starts one with this id when it doesn't.
    const sessionId = typeof prior === "string" && prior ? prior : crypto.randomUUID();
    if (sessionId !== prior) yield { type: "state", state: { sessionId } satisfies CopilotState };

    const perms = planCopilotPermissions(req, settings);
    for (const g of perms.applied) yield { type: "grant_applied", toolName: g.toolName, input: g.input };
    if (perms.unexpressed.length) {
      const what = perms.unexpressed.map((g) => `${g.toolName} (${summarizeInput(g.input, 80)})`).join(", ");
      yield { type: "status", text: `Copilot can't pre-approve ${what} as an exact rule, so it may be denied again. Allow the tool on the ticket instead.` };
    }

    const mode: PermissionMode = req.kind === "plan" ? "read_only" : (req.permissionMode ?? settings.permissionMode);
    const proc = Bun.spawn([this.bin(), ...buildCopilotArgs(req, settings, sessionId)], {
      cwd: req.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: copilotEnv(this.env, settings),
    });
    const stopTree = () => {
      const pids = [proc.pid, ...descendantPids(proc.pid)];
      signalAll(pids, "SIGTERM");
      setTimeout(() => signalAll(pids, "SIGKILL"), 3000).unref?.();
    };
    req.signal.addEventListener("abort", stopTree, { once: true });

    let stderr = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderr += decoder.decode(chunk, { stream: true });
        if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      }
    })().catch(() => {});

    const parser = new CopilotJsonParser(mode);
    // The CLI logs each model call's tokens to the session's events.jsonl, not to stdout: report
    // the ones this run added after each turn and once more at the end.
    const eventsFile = copilotEventsFile(this.env, sessionId);
    const seenCalls = new Set(readCopilotCalls(eventsFile).map((c) => c.id));
    let reported = 0;
    const newCalls = (): DriverEvent[] => {
      const fresh = readCopilotCalls(eventsFile).filter((c) => !seenCalls.has(c.id));
      for (const c of fresh) seenCalls.add(c.id);
      reported += fresh.length;
      return fresh.map((c) => ({ type: "call" as const, call: c.call }));
    };
    try {
      for await (const line of readLines(proc.stdout)) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parser.handle(msg)) yield ev;
        if (msg?.type === "assistant.turn_end") for (const ev of newCalls()) yield ev;
      }
      for (const ev of newCalls()) yield ev;
      if (!reported && parser.result) {
        const tokens = estimateCopilotTokens(eventsFile);
        if (tokens) yield { type: "call", call: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true } };
      }
      const exitCode = await proc.exited;
      await stderrDone;
      if (req.signal.aborted) throw abortError();
      const failed = exitCode !== 0 || (parser.result !== null && parser.result.exitCode !== 0);
      if (failed || (!parser.result && parser.errors.length)) {
        const tail = stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" ");
        const why = parser.errors.at(-1) || tail || `copilot exited with code ${exitCode}`;
        const message = this.runFailure(why, settings);
        yield { type: "error", message };
        throw new Error(message);
      }
      this.authFailure = null;
    } finally {
      req.signal.removeEventListener("abort", stopTree);
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }
  }
}

async function ghAuthToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return out || null;
  } catch {
    return null;
  }
}
