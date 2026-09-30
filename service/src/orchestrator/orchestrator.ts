// The orchestrator: ticket state machine, run queue/executor, scheduler, conductor
// notifications and triage. Implements HarnessOps for tools.

import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  ApprovalBody,
  CompleteBody,
  PendingApproval,
  PermissionDecisionLog,
  PermissionMode,
  CreateProjectBody,
  CreateTicketBody,
  DriverInfo,
  FileMatch,
  HumanReviewBody,
  ReopenBody,
  Project,
  PublicSettings,
  Run,
  RunKind,
  Session,
  Settings,
  Summary,
  SummaryAttachment,
  SummaryAuthor,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptContent,
  TranscriptRole,
  UpdateTicketBody,
  SubmitTicketBody,
  Watcher,
  WatcherBody,
  WatcherLive,
} from "@harness/shared";
import type { BaseBranchSource, BranchInfo, CompletionAction, PromptEntry } from "@harness/shared";
import {
  checkProjectKey,
  completionOptions,
  isCompletionAction,
  isConductor,
  isTicketKey,
  normalizeProjectColor,
  offeredCompletionActions,
  outputTitle,
  parentLandingBranch,
  PERMISSION_MODES,
  PROJECT_COLORS,
  resolveBaseBranch,
  resolveCompletionAction,
  resolvePermissionMode,
  reviewPassed,
  PROMPT_IDS,
  TICKET_STATUSES,
  watcherDriver,
  watcherModel,
} from "@harness/shared";
import type { Store } from "../store";
import { grantKey, type TicketPatch } from "../store/tickets";
import { cachedPullRequestTarget, insideGitCheckout } from "../store/projects";
import { clampLimit, CursorError, DEFAULT_PAGE_LIMIT, DEFAULT_SEARCH_LIMIT, searchSnippet } from "../store/search";
import type { WatcherInput } from "../store/watchers";
import type { EventBus } from "../events";
import { RunInput, type Driver, type DriverEvent, type RunGrants, type RunRequest } from "../drivers/types";
import type {
  ApprovalMeta,
  BoardListFilter,
  BoardScope,
  BoardTicket,
  BoardTicketDetail,
  CreateTicketInput,
  HarnessOps,
  InboxItem,
  ProjectView,
  UpdateTicketInput,
  ToolContext,
  ToolDefinition,
} from "../tools/types";
import { truncateMiddle } from "../tools/util";
import type { BrowserService } from "../browser/types";
import type { HarnessPaths } from "../config";
import { GATED_TOOL_NAMES, toolsForRun } from "../tools/index";
import { positionForDrop } from "@harness/shared/state";
import * as prompts from "./prompts";
import { PROMPTS, promptTemplateError } from "./prompt-templates";
import { findKeys, toOutput, WatcherRunner, type WatcherOutput } from "./watchers";
import { RunQueue, type QueuedJob } from "./queue";
import {
  branchExists,
  branchForKey,
  checkedOutElsewhere,
  commitsNotIn,
  currentBranch,
  ensureWorktree,
  isGitRepo,
  isInside,
  listBranches,
  switchBranch,
} from "./worktree";
import { attachMentions, searchPaths } from "./files";
import { badRequest, conflict, HarnessError, notFound } from "./errors";
import {
  applySettingsPatch,
  mergeModelMap,
  resolveSettings,
  toPublicSettings,
  validateBranchName,
  validateModelId,
  validateModelMap,
  validateSettingsPatch,
} from "./settings";
import { resolveRunModel } from "./models";
import { attachmentPath, prepareAttachments, removeAttachmentFiles, storeAttachments } from "../attachments";
import { ModelCatalog, type ModelCatalogOptions } from "../drivers/models";
import { PermissionGate, type GateEnv } from "../permissions/gate";
import { AnthropicApiClassifier, ClaudeCliClassifier, type Classifier } from "../permissions/classifier";
import { AutoModeRulesProvider } from "../permissions/rules";
import { cleanClaudeEnv, resolveClaudeBin } from "../drivers/claude-code";
import { DEFAULT_ANTHROPIC_MODEL } from "../drivers/anthropic-api";

export interface ConductorChange {
  key: string;
  title: string;
  from: TicketStatus;
  to: TicketStatus;
  summary?: string;
}

/** Minimal surface of WatcherRunner the orchestrator uses (injectable for tests). */
export interface WatcherSupervisor {
  sync(watchers: Watcher[]): void;
  runNow(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** The watcher's process state, when the supervisor tracks it */
  live?(id: string): WatcherLive | undefined;
}

export interface OrchestratorOptions {
  store: Store;
  bus: EventBus;
  drivers: Driver[];
  browser: BrowserService;
  paths: HarnessPaths;
  /** Tool selection per run (defaults to tools/index toolsForRun) */
  tools?: (kind: RunKind, driver: Driver) => ToolDefinition[];
  /** Base URL of the HTTP server, used to build run-scoped MCP URLs */
  baseUrl?: () => string;
  /** Build the watcher supervisor (defaults to WatcherRunner); null disables watchers */
  watchers?: ((handlers: ConstructorParameters<typeof WatcherRunner>[0]) => WatcherSupervisor) | null;
  log?: (msg: string) => void;
  /** Model-list cache tuning (tests) */
  modelCatalog?: ModelCatalogOptions;
  /**
   * Auto-mode classifier for native-tool drivers. Default: built from settings.classifier
   * (claude-cli / anthropic-api / off). null → none: auto mode asks a human instead.
   */
  classifier?: Classifier | null;
  /** Classifier rules (default: `claude auto-mode config`, cached in HARNESS_HOME) */
  autoModeRules?: AutoModeRulesProvider;
  classifierTimeoutMs?: number;
  /** How often start() re-checks for runs no live job owns (default 60s; 0 disables) */
  reconcileIntervalMs?: number;
}

interface ActiveRun {
  run: Run;
  controller: AbortController;
  cancelled: boolean;
  submitted: boolean;
  decided: boolean;
  lastText: string | null;
  mcpToken: string | null;
  /** The agent called block during this run */
  blocked: boolean;
  /**
   * Calls a permission system inside the driver denied without asking (permission_denied) and
   * the agent didn't then run successfully in the same run
   */
  denials: { toolName: string; input: unknown; reason: string }[];
  /** callId → tool call of this run, to match a later successful call against the denials */
  calls: Map<string, { toolName: string; input: unknown }>;
  /** grantKey()s of the one-time grants the driver pre-approved for this run (grant_applied) */
  appliedGrants: Set<string>;
  /** ids of the one-time grants handed to this run (RunRequest.grants.once) */
  offeredGrants: number[];
  /** The agent recorded a pull request during this run (record_pull_request) */
  pullRequest?: boolean;
  /** Human messages sent while the run is going (steering); null when the run can't take them */
  input: RunInput | null;
  /** The run's working directory, for @-mentions in steered messages */
  cwd: string | null;
}

interface TriageMeta {
  source: string;
  /** The watcher output being triaged */
  text: string;
  truncated?: boolean;
  /** The watcher's prompt at the time ("" → none) */
  prompt?: string;
  /** The watcher that printed it (absent for injected output); its models apply to the triage run */
  watcherId?: string | null;
}

/** One chunk of watcher (or injected) output on its way into triage. */
export interface IngestInput {
  /** Dedupe scope: the watcher id, or inject:<source> */
  sourceId: string;
  /** Watcher name shown to triage and on dispatched tickets */
  source: string;
  output: WatcherOutput;
  prompt: string;
  /** The watcher's own driver (null → settings.watcherDriver, then settings.defaultDriver) */
  driver: string | null;
  /** The watcher's id, so its model applies when the triage run starts (absent for injected output) */
  watcherId?: string | null;
}

const RUNNABLE_WORK: RunKind[] = ["work", "conductor"];
/** Run kinds with a human in the loop for tool-permission prompts */
const APPROVABLE_RUNS: RunKind[] = ["work", "complete", "conductor"];
/**
 * Run kinds whose native tool calls are checked as read_only, whatever the ticket's mode. Chat runs
 * aren't: they get the ticket's own mode, and only never hold an approval card (that would block
 * the ticket, and a chat keeps its status).
 */
const READ_ONLY_RUNS: RunKind[] = ["plan", "triage"];
/** Run kinds that get the board write tools (create_ticket, message_ticket, update_branch, ...) */
const BOARD_WRITE_RUNS: RunKind[] = ["work", "conductor", "chat"];
/** Run kinds that get the (human-gated) config tools */
const CONFIG_RUNS: RunKind[] = ["work", "conductor"];
/** Runs that carry a human's words (the brief, a message, a chat question) and get their @-mentioned files attached. */
const MENTION_RUN_KINDS = new Set<RunKind>(["plan", "work", "conductor", "chat"]);
/**
 * Runs a human message can steer while they're going (DESIGN.md "Steering"): the ones a message
 * would otherwise queue. Review and complete runs never take one (a message moves those tickets).
 */
const STEERABLE_RUN_KINDS = new Set<RunKind>(["plan", "work", "conductor", "chat"]);
/** Transcript note when a message meant for the running agent had to wait for the next run */
export const STEER_FALLBACK_STATUS = "Couldn't reach the running agent; queued for the next run";
export const MAX_AGENT_REJECTIONS = 3;
/** Classifier denials of an already-allowed tool retried without a human, before asking one */
export const MAX_AUTO_RETRIES = 3;
/** get_ticket include_transcript: at most this many entries, each clipped to this many characters */
export const BOARD_TRANSCRIPT_MAX = 50;
export const BOARD_TRANSCRIPT_CHARS = 2000;
/** search_tickets page size when the agent doesn't pass a limit (the HTTP default of 100 floods context) */
export const BOARD_SEARCH_LIMIT = 20;
/** list_inbox default page size */
export const BOARD_INBOX_LIMIT = 20;
export const APPROVAL_PENDING_MESSAGE =
  "A human must approve this tool call. The ticket is now blocked awaiting approval — stop now; you'll be resumed with the answer.";

/** Compact one-line description of a tool input: command / file_path / url / JSON. */
export function summarizeToolInput(input: unknown, max = 120): string {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = ["command", "file_path", "path", "url", "pattern", "query"].find((k) => typeof o[k] === "string" && o[k]);
    text = pick ? String(o[pick]) : JSON.stringify(input);
  } else text = JSON.stringify(input ?? null);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** True when text ends with a question, ignoring trailing emoji, punctuation and closing markdown. */
export function endsWithQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = text.trim().replace(/[\s*_`~)\]}>"'”’.!…\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]+$/u, "");
  return stripped.endsWith("?") || stripped.endsWith("？");
}

/**
 * Higher is stricter. An agent may only raise another ticket's effective mode, and may only
 * create or drive tickets at least as strict as its own (DESIGN.md "Board changes by agents").
 */
const PERMISSION_STRICTNESS: Record<PermissionMode, number> = { auto: 0, ask: 1, read_only: 2 };

/** Validate a permission-mode field from a request body (null / "" → inherit). */
function validPermissionMode(value: unknown): PermissionMode | null {
  if (value === undefined || value === null || value === "") return null;
  if (!(PERMISSION_MODES as readonly unknown[]).includes(value)) throw badRequest(`permissionMode must be one of ${PERMISSION_MODES.join(", ")} or null`);
  return value as PermissionMode;
}

const BASE_SOURCE_LABEL:Record<BaseBranchSource | "checkout", string> = {
  ticket: "set on this ticket",
  parent: "the parent ticket's branch",
  project: "inherited from the project",
  settings: "inherited from Settings",
  checkout: "the main checkout's branch, since the Settings default isn't in this repository",
};

/** Validate a ticket's worktree choice from a request body (null / omitted → the project's). */
function validUseWorktree(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw badRequest("useWorktree must be true, false or null");
  return value;
}

/** Validate an optional boolean from a request body (omitted → undefined). */
function validBoolean(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${name} must be true or false`);
  return value;
}

/** Validate a completion action from a request body (omitted / null → undefined). */
function validCompletionAction(name: string, value: unknown): CompletionAction | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isCompletionAction(value)) throw badRequest(`${name} must be one of merge, pr, custom`);
  return value;
}

/** Validate a project color from a request body: a preset id or "#rrggbb" (null / "" → none). */
function validProjectColor(value: unknown): string | null {
  const color = normalizeProjectColor(value);
  if (color === undefined) throw badRequest(`color must be one of ${PROJECT_COLORS.map((c) => c.id).join(", ")}, a #rrggbb hex, or null`);
  return color;
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** Title from the first meaningful line of a prompt. */
export function deriveTitle(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "Untitled";
  return line.length > 80 ? line.slice(0, 79).trimEnd() + "…" : line;
}

/** A draft's title while nobody set one: from its prompt, or "Untitled draft" while that's blank. */
export function draftTitle(prompt: string): string {
  return prompt.trim() ? deriveTitle(prompt) : UNTITLED_DRAFT;
}

const UNTITLED_DRAFT = "Untitled draft";

export class Orchestrator {
  readonly store: Store;
  readonly bus: EventBus;
  readonly browser: BrowserService;
  readonly paths: HarnessPaths;
  private drivers = new Map<string, Driver>();
  private tools: (kind: RunKind, driver: Driver) => ToolDefinition[];
  private baseUrl: () => string;
  private log: (msg: string) => void;
  private queue: RunQueue;
  private active = new Map<string, ActiveRun>(); // runId → active run
  /**
   * `${ticketId}\0${grantKey}` of calls whose exact CLI rule was passed and the call was still
   * denied: their next one-time grant goes to the driver with viaPrompt (in memory: after a
   * restart the rule is simply tried once more).
   */
  private ruleFailures = new Set<string>();
  /** ticketId → classifier denials retried in a row without a human (MAX_AUTO_RETRIES) */
  private autoRetries = new Map<string, number>();
  private mcpRuns = new Map<string, { tools: ToolDefinition[]; ctx: ToolContext }>();
  private conductorBuffer = new Map<string, ConductorChange[]>();
  private starting = new Set<string>();
  private watcherRunner: WatcherSupervisor | null;
  private stopping = false;
  private reconcileIntervalMs: number;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** Fire-and-forget async work (scheduling, worktree setup) that idle() must wait for */
  private background = new Set<Promise<unknown>>();
  private modelCatalog: ModelCatalog;
  private gate: PermissionGate;
  private autoModeRules: AutoModeRulesProvider;
  private classifierOption: Classifier | null | undefined;
  private classifierCache: { key: string; classifier: Classifier } | null = null;
  /**
   * `${project path}\0${settings base branch}` → the branch checked out in that checkout, for
   * repos without the settings' branch (refreshBaseBranch; see baseBranchFor)
   */
  private baseFallback = new Map<string, string>();
  /** Tickets whose complete run is about to be enqueued (enqueueComplete); they count as completing */
  private startingComplete = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.modelCatalog = new ModelCatalog(opts.modelCatalog);
    this.classifierOption = opts.classifier;
    this.autoModeRules =
      opts.autoModeRules ??
      new AutoModeRulesProvider({
        bin: () => {
          const bin = resolveClaudeBin(process.env);
          return existsSync(bin) ? bin : null;
        },
        env: () => cleanClaudeEnv(process.env),
        cachePath: join(opts.paths.home, "auto-mode-rules.json"),
      });
    this.gate = new PermissionGate({ classifier: () => this.classifier(), timeoutMs: opts.classifierTimeoutMs });
    this.store = opts.store;
    this.bus = opts.bus;
    this.browser = opts.browser;
    this.paths = opts.paths;
    for (const d of opts.drivers) this.drivers.set(d.id, d);
    this.tools = opts.tools ?? ((kind, driver) => toolsForRun(kind, driver));
    this.baseUrl = opts.baseUrl ?? (() => "http://127.0.0.1:0");
    this.log = opts.log ?? ((m) => console.log(`[orchestrator] ${m}`));
    this.queue = new RunQueue({
      limit: () => this.settings().maxConcurrentRuns,
      execute: (job) => this.execute(job),
      onError: (job, err) => {
        this.log(`run ${job.runId} crashed: ${errMsg(err)}`);
        this.failCrashedRun(job.runId, errMsg(err));
      },
    });
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
    const handlers = {
      onOutput: async (w: Watcher, output: WatcherOutput) => {
        await this.ingest({ sourceId: w.id, source: w.name, output, prompt: w.prompt, driver: w.driver, watcherId: w.id });
      },
      onStatus: (id: string, patch: { lastRunAt?: number; lastError?: string | null }) => {
        const w = this.store.watchers.update(id, patch);
        if (w) this.bus.emit({ kind: "watcher.upserted", watcher: this.withLive(w) });
      },
      onLive: (id: string) => {
        const w = this.store.watchers.get(id);
        if (w) this.bus.emit({ kind: "watcher.upserted", watcher: this.withLive(w) });
      },
    };
    this.watcherRunner = opts.watchers === null ? null : opts.watchers ? opts.watchers(handlers) : new WatcherRunner(handlers);
  }

  // =========================================================================
  // Lifecycle of the service
  // =========================================================================

  /** Recover from a previous process and start watchers. */
  start() {
    const stale = this.recoverStaleRuns();
    if (stale) this.log(`marked ${stale} stale run(s) from a previous process as failed; nothing re-enqueued`);
    this.syncWatchers();
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        try {
          const n = this.reconcileRuns();
          if (n) this.log(`marked ${n} orphaned run(s) as failed`);
        } catch (err) {
          this.log(`run reconciliation failed: ${errMsg(err)}`);
        }
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
  }

  /** Runs left queued/running by a previous process become failed ("service restarted"). */
  recoverStaleRuns(): number {
    return this.failOrphanedRuns("service restarted");
  }

  /**
   * Runs the database still has as queued/running that no live job owns become failed. A run
   * ends up like that when recording its end threw (a full disk fails every SQLite write), so
   * the record is repaired once writes work again rather than on the next restart.
   */
  reconcileRuns(): number {
    return this.failOrphanedRuns("the run ended without recording a result");
  }

  private failOrphanedRuns(reason: string): number {
    const orphans = this.store.runs.listUnfinished().filter((r) => !this.active.has(r.id) && !this.queue.has(r.id));
    for (const run of orphans) this.interruptRun(run, reason);
    return orphans.length;
  }

  /** A run that threw out of execute(): record it failed now, or leave it to reconcileRuns. */
  private failCrashedRun(runId: string, message: string) {
    try {
      const run = this.store.runs.get(runId);
      if (run && (run.status === "queued" || run.status === "running")) this.interruptRun(run, message);
    } catch (err) {
      this.log(`couldn't record crashed run ${runId} as failed (${errMsg(err)}); will retry`);
    }
  }

  private interruptRun(run: Run, reason: string) {
    const r = this.store.runs.finish(run.id, "failed", reason);
    this.bus.emit({ kind: "run.upserted", run: r });
    for (const subagent of this.store.subagents.stopRunning(run.id)) this.bus.emit({ kind: "subagent.upserted", subagent });
    this.appendStatus(run.sessionId, run.id, `Run interrupted (${run.kind}): ${reason}`);
    const session = this.store.sessions.get(run.sessionId);
    if (session?.kind === "triage" && session.triageStatus === "triaging") {
      this.store.sessions.update(session.id, { triageStatus: "failed", outcome: `Interrupted: ${reason}` });
    }
    this.touchSession(run.sessionId);
  }

  async stop() {
    this.stopping = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.queue.pause();
    await this.watcherRunner?.stopAll().catch(() => {});
    const actives = [...this.active.values()];
    for (const a of actives) {
      a.cancelled = true;
      a.controller.abort();
    }
    await Promise.race([Promise.all(actives.map((a) => this.queue.whenSessionIdle(a.run.sessionId))), Bun.sleep(5000)]);
  }

  /** Nothing queued, running or starting: restarting the service now interrupts no agent. */
  isIdle(): boolean {
    return (
      this.queue.pendingCount === 0 &&
      this.queue.runningCount === 0 &&
      this.active.size === 0 &&
      this.starting.size === 0 &&
      this.background.size === 0
    );
  }

  /** Resolves when no runs are queued or running (tests). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Microtask-scheduled work (conductor flushes) may enqueue right after a run ends.
    for (;;) {
      await Promise.race([this.queue.idle(), Bun.sleep(Math.max(0, deadline - Date.now()))]);
      await Promise.race([Promise.allSettled([...this.background]), Bun.sleep(Math.max(0, deadline - Date.now()))]);
      await Bun.sleep(1);
      if (this.queue.pendingCount === 0 && this.queue.runningCount === 0 && this.background.size === 0) return;
      if (Date.now() > deadline) throw new Error("orchestrator did not become idle in time");
    }
  }

  // =========================================================================
  // Settings & drivers
  // =========================================================================

  settings(): Settings {
    return resolveSettings(this.store.settings.all());
  }

  publicSettings(): PublicSettings {
    return toPublicSettings(this.settings());
  }

  /** The prompt builders with the user's overrides from settings.prompts. */
  private prompts() {
    return prompts.promptsWith(this.settings().prompts);
  }

  /** GET /prompts: every overridable prompt with its built-in text and the user's override. */
  promptCatalog(): PromptEntry[] {
    const overrides = this.settings().prompts ?? {};
    return PROMPT_IDS.map((id) => {
      const def = PROMPTS[id];
      const override = overrides[id] ?? null;
      return {
        id,
        group: def.group,
        label: def.label,
        description: def.description,
        variables: Object.entries(def.variables).map(([name, description]) => ({ name, description })),
        builtin: def.template,
        override,
        overrideError: override ? promptTemplateError(id, override) : null,
      };
    });
  }

  updateSettings(body: unknown): PublicSettings {
    const current = this.settings();
    const patch = validateSettingsPatch(body, [...this.drivers.keys()], current);
    this.store.settings.set(applySettingsPatch(current, patch));
    if (patch.anthropicApiKey !== undefined) this.modelCatalog.invalidate("anthropic-api");
    const pub = this.publicSettings();
    this.bus.emit({ kind: "settings.updated", settings: pub });
    this.queue.pump();
    return pub;
  }

  driverList(): Driver[] {
    return [...this.drivers.values()];
  }

  async driverInfos(): Promise<DriverInfo[]> {
    return Promise.all(
      this.driverList().map(async (d) => {
        try {
          return await d.info();
        } catch (err) {
          return {
            id: d.id,
            name: d.name,
            description: d.description,
            available: false,
            authenticated: false,
            detail: errMsg(err),
            supportsLogin: !!d.login,
          };
        }
      }),
    );
  }

  async loginDriver(id: string) {
    const d = this.drivers.get(id);
    if (!d) throw notFound(`Unknown driver: ${id}`);
    if (!d.login) throw badRequest(`Driver ${id} does not support login`);
    this.modelCatalog.invalidate(id);
    return d.login();
  }

  /** The driver's models (cached with a TTL; refresh re-queries). Never throws for driver failures. */
  async listModels(id: string, opts: { refresh?: boolean } = {}) {
    const d = this.drivers.get(id);
    if (!d) throw notFound(`Unknown driver: ${id}`);
    return this.modelCatalog.get(d, opts);
  }

  // =========================================================================
  // Projects
  // =========================================================================

  listProjects(): Project[] {
    return this.store.projects.list();
  }

  createProject(body: CreateProjectBody): Project {
    const { input, mode } = this.prepareProject(body);
    const project = this.store.projects.create(input);
    if (mode) this.store.projects.setPermissionMode(project.id, mode);
    const created = this.store.projects.get(project.id)!;
    this.bus.emit({ kind: "project.upserted", project: created });
    return created;
  }

  /** Validate a CreateProjectBody without writing anything. */
  private prepareProject(body: CreateProjectBody) {
    if (!body || typeof body.path !== "string" || !body.path.trim()) throw badRequest("path is required");
    const path = this.projectDir(body.path);
    if (body.defaultDriver && !this.drivers.has(body.defaultDriver)) throw badRequest(`Unknown driver: ${body.defaultDriver}`);
    // An explicit key is taken as given (or refused); a derived one de-duplicates to KEY2, KEY3…
    const key = body.key !== undefined && body.key !== null && String(body.key).trim() !== "" ? this.validProjectKey(String(body.key)) : undefined;
    if (key) {
      if (this.store.projects.getByKey(key)) throw conflict(`Project key ${key} is already used by another project`);
    }
    const input = {
      path,
      name: body.name?.trim() || basename(path),
      key,
      defaultDriver: body.defaultDriver ?? null,
      useWorktrees: body.useWorktrees,
      requireHumanReview: body.requireHumanReview,
      autoComplete: body.autoComplete,
      color: body.color !== undefined ? validProjectColor(body.color) : null,
      baseBranch: validateBranchName("baseBranch", body.baseBranch),
      completionAction: this.validProjectCompletion(path, body.completionAction),
      defaultModels:
        body.defaultModels !== undefined ? mergeModelMap({}, validateModelMap("defaultModels", body.defaultModels, [...this.drivers.keys()])) : {},
    };
    return { input, mode: validPermissionMode(body.permissionMode) };
  }

  /** A project's default completion action, which the project at `path` must offer. */
  private validProjectCompletion(path: string, value: unknown): CompletionAction | undefined {
    const action = validCompletionAction("completionAction", value);
    if (!action) return undefined;
    const isGit = insideGitCheckout(path);
    const offered = offeredCompletionActions({ isGit, pullRequestHost: isGit ? (cachedPullRequestTarget(path)?.host ?? null) : null });
    if (!offered.includes(action)) {
      const why = action === "pr" ? "needs a git remote on a host gh is logged into (gh auth login)" : "needs a git repository";
      throw badRequest(`completionAction "${action}" isn't offered by this project: it ${why}. Offered: ${offered.join(", ")}`);
    }
    return action;
  }

  /** Resolve (and ~-expand) a project directory, which must exist. */
  private projectDir(raw: string): string {
    const path = resolve(raw.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw badRequest(`Not a directory: ${path}`);
    return path;
  }

  private validProjectKey(raw: string): string {
    const { key, error } = checkProjectKey(raw);
    if (error) throw badRequest(`Invalid project key "${key}": ${error}`);
    return key;
  }

  /**
   * Patch a project. Changing `key` renames the project's native tickets OLD-n → NEW-n
   * (sessions and dependencies follow, numbers and nextSeq are kept). Tickets mirrored from an
   * external system keep their keys, and existing branches / worktree directories keep the
   * old name: they're stored on the ticket, so work in progress isn't disturbed.
   */
  updateProject(id: string, body: Partial<CreateProjectBody>): Project {
    const existing = this.store.projects.get(id);
    if (!existing) throw notFound(`Unknown project: ${id}`);
    const { newKey, permissionMode, rest, path, defaultModels } = this.prepareProjectUpdate(existing, body);
    const renamed = this.store.transaction(() => {
      this.store.projects.update(id, { ...rest, name: rest.name?.trim(), path, defaultModels });
      if (permissionMode !== undefined) this.store.projects.setPermissionMode(id, permissionMode);
      return newKey ? this.store.projects.rekey(id, newKey) : null;
    });
    const project = this.store.projects.get(id)!;
    this.bus.emit({ kind: "project.upserted", project });
    if (renamed && renamed.renames.size) {
      const ticketIds = new Set(renamed.depTicketIds);
      for (const [from, to] of renamed.renames) {
        const t = this.store.tickets.getByKey(to);
        if (!t) continue;
        ticketIds.add(t.id);
        const session = this.store.sessions.get(t.sessionId);
        if (session) this.bus.emit({ kind: "session.upserted", session });
        this.appendStatus(t.sessionId, null, `Renamed ${from} → ${to}`);
      }
      for (const tid of ticketIds) {
        const t = this.store.tickets.get(tid);
        if (t) this.bus.emit({ kind: "ticket.upserted", ticket: t });
      }
      // Pending conductor notifications mention children by key.
      for (const buf of this.conductorBuffer.values()) for (const c of buf) c.key = renamed.renames.get(c.key) ?? c.key;
      this.log(`project ${existing.key} → ${project.key}: renamed ${renamed.renames.size} ticket(s)`);
    }
    return project;
  }

  /** Validate a project PATCH without writing anything. */
  private prepareProjectUpdate(existing: Project, body: Partial<CreateProjectBody>) {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    if (body.defaultDriver && !this.drivers.has(body.defaultDriver)) throw badRequest(`Unknown driver: ${body.defaultDriver}`);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) throw badRequest("name cannot be empty");
    const path = body.path !== undefined ? this.projectDir(String(body.path)) : undefined;
    let newKey: string | null = null;
    if (body.key !== undefined) {
      const key = this.validProjectKey(String(body.key));
      if (key !== existing.key) {
        const other = this.store.projects.getByKey(key);
        if (other && other.id !== existing.id) throw conflict(`Project key ${key} is already used by ${other.name}`);
        const collisions = this.store.projects.rekeyConflicts(existing.id, key);
        if (collisions.length) {
          const list = collisions.slice(0, 3).join(", ") + (collisions.length > 3 ? ` and ${collisions.length - 3} more` : "");
          throw conflict(`Can't rename to ${key}: ${list} already exist${collisions.length === 1 ? "s" : ""}`);
        }
        newKey = key;
      }
    }
    const permissionMode = body.permissionMode !== undefined ? validPermissionMode(body.permissionMode) : undefined;
    const { key: _key, defaultModels: modelPatch, permissionMode: _mode, color: rawColor, baseBranch: rawBase, completionAction: rawAction, ...rest } = body;
    const color = rawColor !== undefined ? validProjectColor(rawColor) : undefined;
    const baseBranch = rawBase !== undefined ? validateBranchName("baseBranch", rawBase) : undefined;
    const completionAction = this.validProjectCompletion(path ?? existing.path, rawAction);
    const defaultModels =
      modelPatch !== undefined ? mergeModelMap(existing.defaultModels, validateModelMap("defaultModels", modelPatch, [...this.drivers.keys()])) : undefined;
    return { newKey, permissionMode, rest: { ...rest, color, baseBranch, completionAction }, path, defaultModels };
  }

  async deleteProject(id: string) {
    if (!this.store.projects.get(id)) throw notFound(`Unknown project: ${id}`);
    for (const t of this.store.tickets.list({ projectId: id })) await this.deleteTicket(t.key);
    this.store.projects.delete(id);
    this.bus.emit({ kind: "project.deleted", id });
  }

  // =========================================================================
  // Tickets (human / API surface)
  // =========================================================================

  /** Every ticket (one project's), or only those whose status is in `statuses`. */
  listTickets(projectId?: string, statuses?: TicketStatus[]): Ticket[] {
    return this.store.tickets.list({ ...(projectId ? { projectId } : {}), ...(statuses ? { statuses } : {}) });
  }

  /** One page of a column (GET /tickets/page). See TicketRepo.page. */
  ticketPage(opts: { status: TicketStatus; projectId?: string; q?: string; limit?: number | string | null; cursor?: string | null }): TicketPage {
    if (opts.q !== undefined && !opts.q.trim()) throw badRequest("q must not be empty");
    return this.withCursor(() => this.store.tickets.page({ ...opts, limit: clampLimit(opts.limit, DEFAULT_PAGE_LIMIT) }));
  }

  /** Ticket search across every status (GET /tickets/search). See TicketRepo.search. */
  searchTickets(opts: { q: string; projectId?: string; limit?: number | string | null; cursor?: string | null; drafts?: boolean }): TicketPage {
    if (!opts.q?.trim()) throw badRequest("q is required");
    return this.withCursor(() => this.store.tickets.search({ ...opts, limit: clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT) }));
  }

  private withCursor<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CursorError) throw badRequest(err.message);
      throw err;
    }
  }

  private requireTicket(key: string): Ticket {
    const t = this.store.tickets.getByKey(key);
    if (!t) throw notFound(`Unknown ticket: ${key}`);
    return t;
  }

  /** Drafts have no agent and never run: anything that would act on one is refused (409). */
  private notDraft(t: Ticket, what: string) {
    if (t.draft) throw conflict(`${t.key} is a draft: it can't be ${what} until it's submitted (POST /tickets/${t.key}/submit)`);
  }

  /** The ticket an agent (tool) names, or null: drafts don't exist for agents until they're submitted. */
  private agentLookup(key: string): { ticket: Ticket; alias: string | null } | null {
    const found = this.store.tickets.lookup(key);
    return found && !found.ticket.draft ? found : null;
  }

  ticketDetail(key: string): TicketDetail {
    const found = this.store.tickets.lookup(key);
    if (!found) throw notFound(`Unknown ticket: ${key}`);
    const { ticket } = found;
    return {
      ...(found.alias ? { resolvedFrom: found.alias } : {}),
      ticket,
      session: this.store.sessions.get(ticket.sessionId)!,
      summaries: this.store.summaries.listBySession(ticket.sessionId),
      runs: this.store.runs.listBySession(ticket.sessionId),
      dependents: this.store.tickets.dependents(ticket.key).map((t) => t.key),
      children: this.store.tickets.list({ parentId: ticket.id }),
      parent: ticket.parentId ? this.store.tickets.get(ticket.parentId) : null,
      subagents: this.store.subagents.listBySession(ticket.sessionId),
    };
  }

  /** The @-mention autocomplete for a new session in `projectId`: paths under the project folder. */
  projectFiles(projectId: string, q: string, limit?: number | string | null): Promise<FileMatch[]> {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    return searchPaths(project.path, q, clampLimit(limit, 50));
  }

  /** The branch picker for a new session in `projectId`: local branches, most recent first (BranchInfo). */
  projectBranches(projectId: string, q: string, limit?: number | string | null): Promise<BranchInfo[]> {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    return listBranches(project.path, q, clampLimit(limit, 50));
  }

  /** The @-mention autocomplete for a follow-up: paths where the ticket's next run works (its worktree once it has one). */
  ticketFiles(key: string, q: string, limit?: number | string | null): Promise<FileMatch[]> {
    const found = this.store.tickets.lookup(key);
    if (!found) throw notFound(`Unknown ticket: ${key}`);
    const { ticket } = found;
    const session = this.store.sessions.get(ticket.sessionId);
    const project = this.store.projects.get(ticket.projectId);
    const root = [ticket.workdir, session?.cwd, project?.path].find((d): d is string => !!d && existsSync(d));
    return root ? searchPaths(root, q, clampLimit(limit, 50)) : Promise.resolve([]);
  }

  summaries(key: string): Summary[] {
    return this.store.summaries.listBySession(this.requireTicket(key).sessionId);
  }

  /** Where an attachment's stored copy lives (agents read it from there). */
  attachmentFilePath(a: Pick<SummaryAttachment, "id" | "mimeType">): string {
    return attachmentPath(this.paths.attachmentsDir, a);
  }

  /** A summary attachment and its stored file for GET /attachments/:id, or null when either is gone. */
  attachmentFile(id: string): { attachment: SummaryAttachment; path: string } | null {
    const attachment = this.store.summaries.attachment(id);
    if (!attachment) return null;
    const path = this.attachmentFilePath(attachment);
    return existsSync(path) ? { attachment, path } : null;
  }

  async createTicket(body: CreateTicketBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const project = this.store.projects.get(body.projectId);
    if (!project) throw notFound(`Unknown project: ${body.projectId}`);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const draft = validBoolean("draft", body.draft) ?? false;
    if (!draft && !prompt.trim() && !body.title?.trim()) throw badRequest("prompt is required");
    const kind = body.kind ?? "task";
    if (kind !== "task" && kind !== "conductor") throw badRequest(`Invalid kind: ${kind}`);
    const driver = body.driver ?? project.defaultDriver ?? this.settings().defaultDriver;
    if (!this.drivers.has(driver)) throw badRequest(`Unknown driver: ${driver}`);
    const model = validateModelId("model", body.model);
    const permissionMode = validPermissionMode(body.permissionMode);
    const useWorktree = validUseWorktree(body.useWorktree);
    const baseBranch = validateBranchName("baseBranch", body.baseBranch);
    const requestedBranch = validateBranchName("branch", body.branch);
    const skipAgentReview = validBoolean("skipAgentReview", body.skipAgentReview) ?? false;
    if (requestedBranch && !(useWorktree ?? project.useWorktrees)) {
      throw badRequest(`branch ${requestedBranch} needs a worktree, but this ticket would run in the project checkout (useWorktree is off)`);
    }
    if (requestedBranch && project.isGit === false) throw badRequest(`branch ${requestedBranch} needs a git repository; ${project.path} isn't one`);
    const dependsOn = this.validateDeps(body.dependsOn ?? []);
    let parentId: string | null = null;
    if (body.parentId) {
      const parent = this.store.tickets.get(body.parentId) ?? this.store.tickets.getByKey(body.parentId);
      if (!parent) throw badRequest(`Unknown parent: ${body.parentId}`);
      if (parent.draft) throw badRequest(`${parent.key} is a draft; it can't have children until it's submitted`);
      // A child is its conductor's to review and complete; a draft child would hold it up unseen.
      if (draft) throw badRequest("A draft can't be a child ticket");
      parentId = parent.id;
    }
    let explicitKey: string | null = null;
    if (body.key) {
      explicitKey = body.key.trim().toUpperCase();
      if (!isTicketKey(explicitKey)) throw badRequest(`Invalid ticket key: ${body.key}`);
      if (this.store.tickets.keyExists(explicitKey)) throw conflict(`Ticket ${explicitKey} already exists`);
    }
    // A draft never starts on its own: submit decides (and sets autoStart) when it launches.
    const start = draft ? false : (body.start ?? true);
    const autoStart = draft ? false : (body.autoStart ?? parentId !== null);
    const title = body.title?.trim() || (draft ? draftTitle(prompt) : deriveTitle(prompt));

    const ticket = this.store.transaction(() => {
      const key = explicitKey ?? this.store.projects.takeNextKey(project.id, (k) => this.store.tickets.keyExists(k));
      const session = this.store.sessions.create({ key, kind: "ticket", ticketId: null, driver, cwd: project.path, title });
      const t = this.store.tickets.create({
        key,
        projectId: project.id,
        kind,
        title,
        description: prompt,
        status: "planning",
        sessionId: session.id,
        driver,
        parentId,
        dependsOn,
        autoStart: autoStart || (start && dependsOn.length > 0),
        externalRef: body.externalRef ?? null,
        workdir: null,
        model,
        useWorktree,
        baseBranch,
        requestedBranch,
        skipAgentReview,
        draft,
      });
      this.store.sessions.update(session.id, { ticketId: t.id });
      return permissionMode ? this.store.tickets.update(t.id, { permissionMode })! : t;
    });
    const p2 = this.store.projects.get(project.id);
    if (p2) this.bus.emit({ kind: "project.upserted", project: p2 });
    this.touchSession(ticket.sessionId);
    if (parentId) this.touchTicket(parentId); // its childCount changed
    if (draft) {
      this.appendStatus(ticket.sessionId, null, "Draft saved");
      return this.store.tickets.get(ticket.id)!;
    }
    this.appendStatus(ticket.sessionId, null, "Ticket created");
    await this.launch(ticket, start, prompt);
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * A new (or just submitted) ticket's first step: start work when asked to (or autoStart) and its
   * dependencies are done, wait on them otherwise, or plan first.
   */
  private async launch(ticket: Ticket, start: boolean, prompt: string) {
    const depsDone = this.depsDone(ticket);
    if ((start || ticket.autoStart) && depsDone) {
      await this.begin(ticket, prompt);
    } else if (start || ticket.autoStart) {
      this.appendStatus(ticket.sessionId, null, `Waiting on ${ticket.dependsOn.filter((k) => !this.isDone(k)).join(", ")}`);
    } else {
      this.enqueueRun(ticket.sessionId, "plan", prompt);
    }
  }

  /**
   * Launch a draft (POST /tickets/:key/submit): it stops being a draft and goes the way a ticket
   * created with the same `start` would. Its prompt is its description.
   */
  async submitTicket(key: string, body: SubmitTicketBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const start = validBoolean("start", body.start);
    if (start === undefined) throw badRequest("start must be true or false");
    const ticket = this.requireTicket(key);
    if (!ticket.draft) throw conflict(`${ticket.key} isn't a draft; it was already submitted`);
    const prompt = ticket.description;
    if (!prompt.trim()) throw badRequest("prompt is required");
    const launched = this.store.tickets.update(ticket.id, { draft: false, autoStart: start && ticket.dependsOn.length > 0 })!;
    this.touchSession(launched.sessionId);
    this.appendStatus(launched.sessionId, null, "Ticket created");
    await this.launch(launched, start, prompt);
    return this.store.tickets.get(ticket.id)!;
  }

  private validateDeps(keys: string[]): string[] {
    if (!Array.isArray(keys)) throw badRequest("dependsOn must be an array of ticket keys");
    const out: string[] = [];
    for (const raw of keys) {
      // Old keys (from before a project rename) are stored as the ticket's current key.
      const dep = this.store.tickets.getByKey(String(raw));
      if (!dep) throw badRequest(`Unknown dependency: ${raw}`);
      if (dep.draft) throw badRequest(`${dep.key} is a draft; submit it before other tickets depend on it`);
      const key = dep.key;
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  async updateTicket(key: string, body: UpdateTicketBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    let ticket = this.requireTicket(key);
    for (const field of ["kind", "useWorktree", "projectId"] as const) {
      if (body[field] !== undefined && !ticket.draft) throw conflict(`${ticket.key} isn't a draft: its ${field} is fixed once it has launched`);
    }
    if (ticket.draft && body.status !== undefined && body.status !== ticket.status) {
      throw conflict(`${ticket.key} is a draft; submit it to start work or plan (it can't be moved to ${body.status})`);
    }
    if (body.kind !== undefined && body.kind !== "task" && body.kind !== "conductor") throw badRequest(`Invalid kind: ${body.kind}`);
    const useWorktree = body.useWorktree !== undefined ? validUseWorktree(body.useWorktree) : undefined;
    // Moving a draft to another project: validated here, applied once the rest of the PATCH is.
    let moveTo: Project | null = null;
    if (body.projectId !== undefined && body.projectId !== ticket.projectId) {
      if (typeof body.projectId !== "string" || !body.projectId.trim()) throw badRequest("projectId must be a project id");
      moveTo = this.store.projects.get(body.projectId);
      if (!moveTo) throw notFound(`Unknown project: ${body.projectId}`);
    }
    const projectOf = () => moveTo ?? this.store.projects.get(ticket.projectId);
    const patch: TicketPatch = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.description !== undefined) {
      patch.description = String(body.description);
      // A draft's title follows its prompt until someone names it.
      if (ticket.draft && body.title === undefined && (ticket.title === UNTITLED_DRAFT || ticket.title === draftTitle(ticket.description))) {
        patch.title = draftTitle(patch.description);
      }
    }
    if (body.kind !== undefined && body.kind !== ticket.kind) patch.kind = body.kind;
    if (useWorktree !== undefined) {
      patch.useWorktree = useWorktree;
      // Without a worktree there's no branch to ask for; drop it so the draft stays valid.
      const project = projectOf();
      if (project && !(useWorktree ?? project.useWorktrees) && body.branch === undefined) patch.requestedBranch = null;
    }
    if (body.position !== undefined) {
      if (typeof body.position !== "number" || !Number.isFinite(body.position)) throw badRequest("position must be a number");
      patch.position = body.position;
    }
    if (body.driver !== undefined) {
      if (!this.drivers.has(body.driver)) throw badRequest(`Unknown driver: ${body.driver}`);
      patch.driver = body.driver;
      this.store.sessions.update(ticket.sessionId, { driver: body.driver });
      // Model ids are per driver; a model picked for the old driver means nothing to the new one.
      if (body.driver !== ticket.driver && body.model === undefined) patch.model = null;
    }
    if (body.model !== undefined) patch.model = validateModelId("model", body.model);
    if (body.permissionMode !== undefined) patch.permissionMode = validPermissionMode(body.permissionMode);
    if (body.baseBranch !== undefined) patch.baseBranch = validateBranchName("baseBranch", body.baseBranch);
    if (body.branch !== undefined) {
      const branch = validateBranchName("branch", body.branch);
      // Before work starts, or once the complete run removed the worktree (a re-open recreates it on this branch).
      if (ticket.workdir && existsSync(ticket.workdir)) {
        throw conflict(
          ticket.branch
            ? `${ticket.key} already works in ${ticket.workdir} on branch ${ticket.branch}, so its branch can't be set from here. Its agent moves it with the update_branch tool: send it a message asking for the branch you want.`
            : `${ticket.key} already works in the project checkout at ${ticket.workdir}, not a worktree of its own, so it has no branch to change.`,
        );
      }
      const project = projectOf();
      // A move resets the draft's worktree choice to the new project's.
      const worktree = patch.useWorktree !== undefined ? patch.useWorktree : moveTo ? null : ticket.useWorktree;
      if (branch && project && !(worktree ?? project.useWorktrees)) {
        throw badRequest(`branch ${branch} needs a worktree, but ${ticket.key} runs in the project checkout (useWorktree is off)`);
      }
      if (branch && project?.isGit === false) throw badRequest(`branch ${branch} needs a git repository; ${project.path} isn't one`);
      patch.requestedBranch = branch;
    }
    if (body.dependsOn !== undefined) {
      const deps = this.validateDeps(body.dependsOn);
      if (deps.includes(ticket.key)) throw badRequest("A ticket cannot depend on itself");
      patch.dependsOn = deps;
    }
    const skip = validBoolean("skipAgentReview", body.skipAgentReview);
    if (skip !== undefined && skip !== !!ticket.skipAgentReview) patch.skipAgentReview = skip;
    if (body.status !== undefined && !TICKET_STATUSES.includes(body.status)) throw badRequest(`Invalid status: ${body.status}`);
    if (moveTo) ticket = this.moveDraft(ticket, moveTo);
    if (Object.keys(patch).length) {
      ticket = this.store.tickets.update(ticket.id, patch)!;
      if (patch.title) this.store.sessions.update(ticket.sessionId, { title: patch.title });
      this.touchSession(ticket.sessionId);
    }
    if (patch.skipAgentReview !== undefined) ticket = await this.applySkipAgentReview(ticket);
    if (body.status !== undefined && body.status !== ticket.status) {
      switch (body.status) {
        case "in_progress":
          if (ticket.status === "done") await this.reopen(ticket, this.prompts().workStartPrompt(ticket), "Re-opened: moved to in progress");
          else await this.begin(ticket, this.prompts().workStartPrompt(ticket));
          break;
        case "done":
          this.transition(ticket, "done", { blockedReason: null }, "Moved to done");
          break;
        case "blocked":
          this.transition(ticket, "blocked", {}, "Moved to blocked");
          break;
        case "review":
          this.transition(ticket, "review", {}, "Moved to review");
          break;
        case "planning":
          this.transition(ticket, "planning", { blockedReason: null }, "Moved to planning");
          break;
      }
    }
    if (patch.dependsOn) this.kickScheduler();
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * PATCH projectId on a draft: it takes the other project's next key (the old key stays an alias,
   * as with a project rename), moves to the end of that project's planning column, and its branch
   * choices reset, since they were the old project's.
   */
  private moveDraft(ticket: Ticket, project: Project): Ticket {
    const from = this.store.projects.get(ticket.projectId);
    const moved = this.store.transaction(() => {
      const key = this.store.projects.takeNextKey(project.id, (k) => this.store.tickets.keyExists(k) || !!this.store.db.query("SELECT 1 FROM sessions WHERE key = $k").get({ k }));
      const renamed = this.store.tickets.moveToProject(ticket.id, project.id, key);
      this.store.sessions.update(ticket.sessionId, { cwd: project.path });
      return renamed;
    });
    for (const p of [from, project]) {
      const fresh = p ? this.store.projects.get(p.id) : null;
      if (fresh) this.bus.emit({ kind: "project.upserted", project: fresh });
    }
    this.appendStatus(ticket.sessionId, null, `Moved to ${project.name}: ${moved.from} → ${moved.to}`);
    this.touchSession(ticket.sessionId);
    this.log(`draft ${moved.from} → ${moved.to} (moved to ${project.key})`);
    return this.store.tickets.get(ticket.id)!;
  }

  async deleteTicket(key: string) {
    const ticket = this.requireTicket(key);
    await this.cancelSession(ticket.sessionId, true);
    for (const child of this.store.tickets.list({ parentId: ticket.id })) {
      this.store.db.query("UPDATE tickets SET parent_id = NULL WHERE id = $id").run({ id: child.id });
      this.touchTicket(child.id);
    }
    this.conductorBuffer.delete(ticket.id);
    await this.browser.close(ticket.sessionId).catch(() => {});
    const files = this.store.summaries.attachmentsBySession(ticket.sessionId).map((a) => attachmentPath(this.paths.attachmentsDir, a));
    this.store.transaction(() => {
      this.store.tickets.delete(ticket.id);
      this.store.sessions.delete(ticket.sessionId);
    });
    removeAttachmentFiles(files);
    rmSync(join(this.paths.scratchDir, ticket.sessionId), { recursive: true, force: true });
    this.bus.emit({ kind: "ticket.deleted", id: ticket.id });
    this.bus.emit({ kind: "session.deleted", id: ticket.sessionId });
    if (ticket.parentId) this.touchTicket(ticket.parentId); // its childCount changed
    this.kickScheduler();
  }

  async startTicket(key: string): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "started");
    if (ticket.status === "in_progress") throw conflict(`${ticket.key} is already in progress`);
    if (ticket.status === "done" || ticket.status === "review") throw conflict(`${ticket.key} is in ${ticket.status}; it cannot be started`);
    await this.begin(ticket, this.prompts().workStartPrompt(ticket));
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * A human message to the ticket's agent. By default it acts on the ticket: a blocked or review
   * ticket goes back to in progress. With chat, the agent answers in a chat run, with the ticket's
   * own permission mode and a work run's tools minus the ones that move it, and the ticket keeps
   * its status and reviews.
   */
  async sendMessage(key: string, text: string, opts: { chat?: boolean } = {}): Promise<Ticket> {
    if (typeof text !== "string" || !text.trim()) throw badRequest("text is required");
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "messaged (it has no agent yet)");
    if (opts.chat) {
      if (ticket.pendingApproval) throw conflict(`${ticket.key} is waiting on a tool approval; answer it before chatting`);
      this.notCompleting(ticket, "messaged");
      // Chat turns go in the summaries, where the human reads the ticket (the answer when the run ends).
      this.addSummary(ticket.sessionId, ticket.id, "human", text.trim());
      await this.steerOrEnqueue(ticket.sessionId, "chat", text);
      return this.store.tickets.get(ticket.id)!;
    }
    if (ticket.pendingApproval) return this.answerApproval(ticket.key, { decision: "deny", message: text });
    this.notCompleting(ticket, "messaged");
    this.autoRetries.delete(ticket.id);
    this.resetRejections(ticket);
    switch (ticket.status) {
      case "planning":
        await this.steerOrEnqueue(ticket.sessionId, "plan", text);
        break;
      case "in_progress":
        await this.steerOrEnqueue(ticket.sessionId, this.workKind(ticket), text);
        break;
      case "blocked":
        if (!ticket.workdir || (ticket.branch && !existsSync(ticket.workdir))) {
          await this.begin(ticket, text);
        } else {
          this.transition(ticket, "in_progress", { blockedReason: null }, "Unblocked by human reply");
          this.enqueueRun(ticket.sessionId, this.workKind(ticket), text);
        }
        break;
      case "done":
        await this.reopen(ticket, text, "Re-opened by human message");
        break;
      case "review":
        this.transition(
          ticket,
          "in_progress",
          { agentReview: "pending", humanReview: "pending", blockedReason: null },
          `Moved back to in progress (human message)`,
        );
        this.enqueueRun(ticket.sessionId, this.workKind(ticket), text);
        break;
    }
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * A human message for a run of `kind` (DESIGN.md "Steering"). When such a run is going and its
   * driver takes input, the message goes straight into it and the agent sees it at its next
   * step. Otherwise it waits for a run of its own, queued behind the active one, with a
   * transcript note when there was a running agent it couldn't reach.
   */
  private async steerOrEnqueue(sessionId: string, kind: RunKind, text: string): Promise<void> {
    const active = [...this.active.values()].find((a) => a.run.sessionId === sessionId && !a.cancelled);
    if (!active) {
      this.enqueueRun(sessionId, kind, text);
      return;
    }
    const input = active.input;
    if (input && !input.isClosed && active.run.kind === kind) {
      this.append(sessionId, active.run.id, "user", { type: "text", text });
      this.touchSession(sessionId);
      const prompt = MENTION_RUN_KINDS.has(kind) && active.cwd ? await this.withMentions(sessionId, active.run.id, text, active.cwd) : text;
      if (input.push(prompt, text)) return;
      // The run stopped taking input while the mentions were read.
      const run = this.enqueueRun(sessionId, kind, text, undefined, { skipTranscript: true });
      this.appendStatus(sessionId, run.id, STEER_FALLBACK_STATUS);
      return;
    }
    const run = this.enqueueRun(sessionId, kind, text);
    this.appendStatus(sessionId, run.id, STEER_FALLBACK_STATUS);
  }

  /** Send a done ticket back to in progress with the human's notes (the done-column "request changes"). */
  async reopenTicket(key: string, body: ReopenBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "re-opened");
    if (ticket.status !== "done") throw conflict(`${ticket.key} is not done; only done tickets can be re-opened`);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    if (!notes) throw badRequest("notes are required");
    this.addSummary(ticket.sessionId, ticket.id, "human", `Re-opened: ${notes}`);
    return this.reopen(ticket, this.prompts().reopenPrompt(ticket, notes, (await this.refreshBaseBranch(ticket)).branch), "Re-opened by human");
  }

  /**
   * Done → in progress. Both reviews start over, and begin() recreates the worktree when the
   * complete run removed it.
   */
  private async reopen(ticket: Ticket, prompt: string, note: string): Promise<Ticket> {
    this.autoRetries.delete(ticket.id);
    await this.begin(ticket, prompt, { agentReview: "pending", humanReview: "pending" }, note);
    return this.store.tickets.get(ticket.id)!;
  }

  humanReview(key: string, body: HumanReviewBody): Ticket {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "reviewed");
    return this.applyReview(ticket, body.decision, body.notes ?? "", "human", body);
  }

  /**
   * The parent whose branch a child lands on (`parentLandingBranch`): one working in a worktree of
   * its own and not done yet, for a child that sets no base branch of its own. Decides the child's
   * base, its merge-only choice and its merge lock.
   */
  private branchParent(t: Pick<Ticket, "parentId" | "baseBranch"> | null): Ticket | null {
    if (!t?.parentId) return null;
    const parent = this.store.tickets.get(t.parentId);
    return parent && parentLandingBranch(t, parent) ? parent : null;
  }

  /**
   * The completion action a request picked for `t` (DESIGN.md "Completion"), validated against
   * what the ticket offers: 400 for anything else. Omitted → undefined (keep the earlier choice).
   */
  private requestedCompletion(t: Ticket, value: unknown): CompletionAction | undefined {
    const action = validCompletionAction("action", value);
    if (!action) return undefined;
    const r = resolveCompletionAction(action, t, this.store.projects.get(t.projectId), this.branchParent(t));
    if (r.error !== null) throw badRequest(`${t.key}: ${r.error}`);
    return r.action;
  }

  /** Keep the approver's choice on the ticket until the completion runs. */
  private storeCompletionChoice(t: Ticket, choice: { action?: unknown; instructions?: unknown }): Ticket {
    const action = this.requestedCompletion(t, choice.action);
    if (choice.instructions !== undefined && choice.instructions !== null && typeof choice.instructions !== "string") {
      throw badRequest("instructions must be text");
    }
    const instructions = typeof choice.instructions === "string" ? choice.instructions.trim() || null : undefined;
    if (action === undefined && instructions === undefined) return t;
    // A new action without instructions drops the earlier action's instructions.
    const patch: TicketPatch = { completionInstructions: instructions ?? (action !== undefined ? null : t.completionInstructions ?? null) };
    if (action !== undefined) patch.completionAction = action;
    return this.store.tickets.update(t.id, patch)!;
  }

  private resetRejections(ticket: Ticket) {
    if (this.store.tickets.reviewRejections(ticket.id) !== 0) this.store.tickets.update(ticket.id, { reviewRejections: 0 });
  }

  /** Answer the ticket's pending tool-permission request and resume the agent. */
  async answerApproval(key: string, body: ApprovalBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "approved");
    const pa = ticket.pendingApproval;
    if (!pa) throw conflict(`${ticket.key} has no pending approval`);
    const decision = body?.decision;
    if (decision !== "allow_once" && decision !== "allow_tool" && decision !== "deny") {
      throw badRequest("decision must be allow_once, allow_tool or deny");
    }
    if (decision === "allow_tool" && (pa.onceOnly || GATED_TOOL_NAMES.has(pa.toolName))) {
      throw badRequest(`${pa.toolName} can only be allowed once: every call needs its own approval`);
    }
    const what = `${pa.toolName} (${pa.summary ?? summarizeToolInput(pa.input)})`;
    const note = typeof body.message === "string" ? body.message.trim().replace(/[.\s]+$/, "") : "";
    let prompt: string;
    let allowedTools = ticket.allowedTools;
    this.autoRetries.delete(ticket.id);
    if (decision === "allow_once") {
      this.store.tickets.addGrant(ticket.id, pa.toolName, pa.input);
      prompt = `The human approved your request to use ${what}. Retry it now and continue.`;
    } else if (decision === "allow_tool") {
      if (!allowedTools.includes(pa.toolName)) allowedTools = [...allowedTools, pa.toolName];
      // Claude Code's auto mode ignores a bare rule for some tools (Bash): the denied call itself
      // also gets a one-time grant so the retry goes through as an exact rule.
      if (pa.source === "classifier") this.store.tickets.addGrant(ticket.id, pa.toolName, pa.input);
      prompt = `The human approved your request to use ${what}; you may use ${pa.toolName} freely for the rest of this ticket. Retry it now and continue.`;
    } else {
      prompt = `The human denied ${what}.${note ? ` ${note}.` : ""} Find another way or call block if you can't proceed.`;
    }
    if (note && decision !== "deny") prompt += ` Note from the human: ${note}.`;
    this.addSummary(ticket.sessionId, ticket.id, "human", `${decision === "deny" ? "Denied" : decision === "allow_tool" ? "Always allowed" : "Allowed once"}: ${what}`);
    const kind = this.store.runs.get(pa.runId)?.kind === "complete" ? "complete" : this.workKind(ticket);
    const t = this.transition(
      ticket,
      kind === "complete" ? "review" : "in_progress",
      { pendingApproval: null, blockedReason: null, allowedTools, reviewRejections: 0 },
      `Approval answered: ${decision}`,
    );
    this.enqueueRun(t.sessionId, kind, prompt);
    return this.store.tickets.get(t.id)!;
  }

  private applyReview(
    ticket: Ticket,
    decision: "approve" | "request_changes",
    notes: string,
    by: "human" | "conductor",
    choice: { action?: unknown; instructions?: unknown } = {},
  ): Ticket {
    if (ticket.status !== "review") throw conflict(`${ticket.key} is not in review`);
    if (decision === "approve") ticket = this.storeCompletionChoice(ticket, choice);
    this.resetRejections(ticket);
    if (decision === "approve") {
      const t = this.store.tickets.update(ticket.id, { humanReview: "approved" })!;
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, by === "human" ? "Human review: approved" : "Conductor review: approved");
      if (notes.trim()) this.addSummary(t.sessionId, t.id, by === "human" ? "human" : "agent", `Approved: ${notes.trim()}`);
      this.noteReady(t);
      return t;
    }
    if (decision !== "request_changes") throw badRequest(`Invalid decision: ${decision}`);
    this.notCompleting(ticket, "sent back");
    return this.requestChanges(ticket, notes, by);
  }

  async completeTicket(key: string, body: CompleteBody = {}): Promise<Ticket> {
    let ticket = this.requireTicket(key);
    this.notDraft(ticket, "completed");
    if (ticket.status === "done") throw conflict(`${ticket.key} is already done`);
    if (body.skipAgent) {
      // "Approve and take no action": no completion run. In review it counts as the approval.
      if (ticket.status === "review") {
        this.notCompleting(ticket, "marked done");
        this.transition(ticket, "done", { blockedReason: null, humanReview: "approved" }, "Approved, no action taken");
      } else {
        this.transition(ticket, "done", { blockedReason: null }, "Marked done");
      }
      return this.store.tickets.get(ticket.id)!;
    }
    if (ticket.status !== "review") throw conflict(`${ticket.key} must be in review to complete`);
    if (this.completing(ticket)) throw conflict(`${ticket.key} is already completing`);
    ticket = this.storeCompletionChoice(ticket, body);
    this.appendStatus(ticket.sessionId, null, "Completing");
    await this.enqueueComplete(ticket);
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * Enqueue the complete run once git has said what the base branch is (the prompt names it, and
   * the fallback cache is empty after a restart). The ticket counts as completing meanwhile, so
   * nothing is queued ahead of it.
   */
  private async enqueueComplete(ticket: Ticket) {
    this.startingComplete.add(ticket.id);
    try {
      await this.refreshBaseBranch(ticket);
      let t = this.store.tickets.get(ticket.id);
      if (!t || t.status !== "review") return;
      // The action this completion runs with: the stored choice while the ticket still offers it,
      // else the default (a project that lost its gh login merges instead of failing). Written
      // back so the run's system prompt picks the same completion prompts.
      const action = completionOptions(t, this.store.projects.get(t.projectId), this.branchParent(t)).defaultAction;
      if (action !== t.completionAction) t = this.store.tickets.update(t.id, { completionAction: action })!;
      this.enqueueRun(t.sessionId, "complete", this.completePromptFor(t, t.completionInstructions ?? undefined), this.completeLock(t));
    } finally {
      this.startingComplete.delete(ticket.id);
    }
  }

  /**
   * Complete runs that merge into the same place run one at a time: siblings merging into their
   * parent's worktree, or tickets merging into the project's base branch. PR and custom
   * completions don't share a checkout with anyone.
   */
  private completeLock(t: Ticket): string | undefined {
    if (t.completionAction && t.completionAction !== "merge") return undefined;
    const parent = this.branchParent(t);
    return parent ? `merge:${parent.id}` : `merge:${t.projectId}`;
  }

  /**
   * After skipAgentReview changed: a ticket waiting in review on its agent review follows the
   * flag right away. On: the review is skipped (queued or running review runs are dropped) and
   * the ticket may be ready. Off: a skipped review becomes a real one.
   */
  private async applySkipAgentReview(ticket: Ticket): Promise<Ticket> {
    if (ticket.status !== "review") return ticket;
    if (ticket.skipAgentReview && ticket.agentReview === "pending") {
      await this.cancelReviewRuns(ticket.sessionId);
      const t = this.store.tickets.update(ticket.id, { agentReview: "skipped" })!;
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, "Agent review: skipped");
      this.noteReady(t);
    } else if (!ticket.skipAgentReview && ticket.agentReview === "skipped") {
      const t = this.store.tickets.update(ticket.id, { agentReview: "pending" })!;
      this.touchSession(t.sessionId);
      this.enqueueReview(t);
    }
    return this.store.tickets.get(ticket.id)!;
  }

  /** Drop the session's queued review runs and stop a running one. */
  private async cancelReviewRuns(sessionId: string) {
    for (const job of this.queue.pendingFor(sessionId)) {
      if (job.kind !== "review" || !this.queue.remove(job.runId)) continue;
      const r = this.store.runs.finish(job.runId, "cancelled", null);
      this.bus.emit({ kind: "run.upserted", run: r });
      this.appendStatus(sessionId, job.runId, "Run cancelled (review)");
    }
    const running = this.queue.runningFor(sessionId);
    if (running?.kind !== "review") return;
    const a = this.active.get(running.runId);
    if (a) {
      a.cancelled = true;
      a.controller.abort();
    }
    await Promise.race([this.queue.whenSessionIdle(sessionId), Bun.sleep(5000)]);
  }

  rerunAgentReview(key: string): Ticket {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "reviewed");
    if (ticket.status !== "review") throw conflict(`${ticket.key} is not in review`);
    const t = this.store.tickets.update(ticket.id, { agentReview: "pending" })!;
    this.enqueueReview(t);
    return this.store.tickets.get(ticket.id)!;
  }

  async cancelTicket(key: string): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "cancelled (nothing runs on a draft)");
    await this.cancelSession(ticket.sessionId, true);
    return this.store.tickets.get(ticket.id)!;
  }

  /** Cancel queued runs and abort the active run of a session. */
  async cancelSession(sessionId: string, wait: boolean) {
    for (const job of this.queue.pendingFor(sessionId)) {
      if (this.queue.remove(job.runId)) {
        const r = this.store.runs.finish(job.runId, "cancelled", null);
        this.bus.emit({ kind: "run.upserted", run: r });
        this.appendStatus(sessionId, job.runId, `Run cancelled (${job.kind})`);
      }
    }
    const running = this.queue.runningFor(sessionId);
    if (running) {
      const a = this.active.get(running.runId);
      if (a) {
        a.cancelled = true;
        a.controller.abort();
      }
      if (wait) await Promise.race([this.queue.whenSessionIdle(sessionId), Bun.sleep(5000)]);
    }
    this.touchSession(sessionId);
  }

  // =========================================================================
  // Sessions & transcript
  // =========================================================================

  listSessions(kind?: "ticket" | "triage"): Session[] {
    return this.store.sessions.list(kind);
  }

  getSession(id: string): Session {
    const s = this.store.sessions.get(id);
    if (!s) throw notFound(`Unknown session: ${id}`);
    return s;
  }

  /** The session agent's transcript, or with `subagentId` one sub-agent's (404 when unknown). */
  transcript(sessionId: string, after = 0, subagentId: string | null = null) {
    this.getSession(sessionId);
    if (subagentId && !this.store.subagents.get(sessionId, subagentId)) throw notFound(`Unknown sub-agent: ${subagentId}`);
    return this.store.transcript.list(sessionId, after, undefined, subagentId);
  }

  subagents(sessionId: string) {
    this.getSession(sessionId);
    return this.store.subagents.listBySession(sessionId);
  }

  // =========================================================================
  // Watchers, triage
  // =========================================================================

  listWatchers(): Watcher[] {
    return this.store.watchers.list().map((w) => this.withLive(w));
  }

  /** The stored watcher plus what its process is doing now (see WatcherLive). */
  private withLive(w: Watcher): Watcher {
    const live = this.watcherRunner?.live?.(w.id);
    return live ? { ...w, live } : w;
  }

  createWatcher(body: WatcherBody & { name: string; command: string }): Watcher {
    const input = this.validateWatcher(body, null) as WatcherInput & { name: string; command: string };
    const created = this.store.watchers.create(input);
    // Sync first so the event (and the response) carry the new process state.
    this.syncWatchers();
    const w = this.withLive(this.store.watchers.get(created.id) ?? created);
    this.bus.emit({ kind: "watcher.upserted", watcher: w });
    return w;
  }

  updateWatcher(id: string, body: WatcherBody): Watcher {
    const existing = this.store.watchers.get(id);
    if (!existing) throw notFound(`Unknown watcher: ${id}`);
    this.store.watchers.update(id, this.validateWatcher(body, existing));
    this.syncWatchers();
    const w = this.withLive(this.store.watchers.get(id)!);
    this.bus.emit({ kind: "watcher.upserted", watcher: w });
    return w;
  }

  deleteWatcher(id: string) {
    if (!this.store.watchers.get(id)) throw notFound(`Unknown watcher: ${id}`);
    this.store.watchers.delete(id);
    this.bus.emit({ kind: "watcher.deleted", id });
    this.syncWatchers();
  }

  async runWatcher(id: string) {
    if (!this.store.watchers.get(id)) throw notFound(`Unknown watcher: ${id}`);
    if (!this.watcherRunner) throw badRequest("Watchers are disabled");
    await this.watcherRunner.runNow(id);
  }

  /** `existing` is the watcher being updated (null when creating); models merge over its map. */
  private validateWatcher(body: WatcherBody, existing: Watcher | null): WatcherInput {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const creating = !existing;
    const out: WatcherInput = {};
    if (creating || body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw badRequest("name is required");
      out.name = body.name.trim();
    }
    if (creating || body.command !== undefined) {
      if (typeof body.command !== "string" || !body.command.trim()) throw badRequest("command is required");
      out.command = body.command.trim();
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string") throw badRequest("prompt must be a string");
      out.prompt = body.prompt.trim();
    }
    if (body.args !== undefined) {
      if (!Array.isArray(body.args) || body.args.some((a) => typeof a !== "string")) throw badRequest("args must be an array of strings");
      out.args = body.args;
    }
    if (body.env !== undefined) {
      if (!body.env || typeof body.env !== "object" || Object.values(body.env).some((v) => typeof v !== "string"))
        throw badRequest("env must be an object of strings");
      out.env = body.env;
    }
    if (body.mode !== undefined) {
      if (body.mode !== "loop" && body.mode !== "interval") throw badRequest("mode must be loop or interval");
      out.mode = body.mode;
    }
    if (body.intervalSec !== undefined) {
      if (typeof body.intervalSec !== "number" || body.intervalSec <= 0) throw badRequest("intervalSec must be a positive number");
      out.intervalSec = Math.round(body.intervalSec);
    }
    if (body.enabled !== undefined) out.enabled = !!body.enabled;
    if (body.cwd !== undefined) out.cwd = body.cwd || null;
    if (body.driver !== undefined) {
      if (body.driver && !this.drivers.has(body.driver)) throw badRequest(`Unknown driver: ${body.driver}`);
      out.driver = body.driver || null;
    }
    if (body.models !== undefined) out.models = mergeModelMap(existing?.models ?? {}, validateModelMap("models", body.models, [...this.drivers.keys()]));
    return out;
  }

  syncWatchers() {
    this.watcherRunner?.sync(this.store.watchers.list());
  }

  /**
   * Feed output as if a watcher named `source` printed `text` (an object is taken as its JSON).
   * `prompt` plays the watcher's prompt. Null when deduped or when the text is only whitespace.
   */
  async injectOutput(source: string, text: unknown, prompt?: unknown): Promise<Session | null> {
    if (typeof source !== "string" || !source.trim()) throw badRequest("source is required");
    if (prompt !== undefined && prompt !== null && typeof prompt !== "string") throw badRequest("prompt must be a string");
    const raw = typeof text === "string" ? text : text === undefined || text === null ? "" : JSON.stringify(text);
    const output = toOutput(raw);
    if (!output) throw badRequest("text is required");
    const name = source.trim();
    return this.ingest({ sourceId: `inject:${name}`, source: name, output, prompt: (prompt ?? "").trim(), driver: null });
  }

  /** Dedupe (identical text from the same source is triaged once), then triage. */
  async ingest(input: IngestInput): Promise<Session | null> {
    const hash = createHash("sha256").update(input.output.text).digest("hex");
    if (!this.store.seen.markSeen(input.sourceId, `sha256:${hash}`, null)) return null;
    return this.triage(input);
  }

  triage(input: Omit<IngestInput, "sourceId">): Session {
    const { source, output, prompt, driver, watcherId = null } = input;
    const projects = this.store.projects.list();
    const keys = findKeys(output.text);
    const existingTickets = keys.flatMap((key) => {
      const t = this.agentLookup(key)?.ticket;
      return t ? [t] : [];
    });
    const title = outputTitle(output.text);
    const n = this.store.counters.next("triage");
    const session = this.store.sessions.create({
      key: `TRIAGE-${n}`,
      kind: "triage",
      ticketId: null,
      driver: watcherDriver({ driver }, this.settings()),
      cwd: this.paths.home,
      title,
      triageStatus: "triaging",
      meta: { source, text: output.text, truncated: output.truncated, prompt, watcherId } satisfies TriageMeta,
    });
    this.touchSession(session.id);
    this.appendStatus(session.id, null, `New output from ${source}`);
    this.enqueueRun(
      session.id,
      "triage",
      this.prompts().triagePrompt({ source, title, text: output.text, truncated: output.truncated, prompt, projects, existingTickets }),
    );
    return this.store.sessions.get(session.id)!;
  }

  // =========================================================================
  // MCP
  // =========================================================================

  /** Resolve a run-scoped MCP token (null once the run has ended). */
  mcpRun(token: string): { tools: ToolDefinition[]; ctx: ToolContext } | null {
    return this.mcpRuns.get(token) ?? null;
  }

  // =========================================================================
  // HarnessOps (called by tools during a run)
  // =========================================================================

  private ctxTicket(ctx: ToolContext): Ticket {
    if (!ctx.ticket) throw new Error("This run has no ticket");
    const t = this.store.tickets.get(ctx.ticket.id);
    if (!t) throw new Error("Ticket no longer exists");
    return t;
  }

  private ctxActive(ctx: ToolContext): ActiveRun | undefined {
    return this.active.get(ctx.runId);
  }

  async postSummary(ctx: ToolContext, body: string, attachments?: string[]): Promise<void> {
    if (!body?.trim()) throw new Error("summary is empty");
    const prepared = prepareAttachments(attachments, ctx.cwd);
    this.addSummary(ctx.session.id, ctx.ticket?.id ?? null, "agent", body.trim(), storeAttachments(this.paths.attachmentsDir, prepared));
  }

  async updatePlan(ctx: ToolContext, plan: string, title?: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (!plan?.trim()) throw new Error("plan is empty");
    const patch: TicketPatch = { description: plan };
    if (title?.trim()) patch.title = title.trim();
    const u = this.store.tickets.update(t.id, patch)!;
    if (patch.title) this.store.sessions.update(u.sessionId, { title: patch.title });
    this.touchSession(u.sessionId);
    this.appendStatus(u.sessionId, ctx.runId, "Plan updated");
  }

  async block(ctx: ToolContext, question: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (t.status !== "in_progress") throw new Error(`${t.key} is ${t.status}, not in progress`);
    if (!question?.trim()) throw new Error("question is empty");
    this.addSummary(t.sessionId, t.id, "agent", `Blocked: ${question.trim()}`);
    this.transition(t, "blocked", { blockedReason: question.trim() }, `Blocked: ${question.trim()}`, question.trim());
    const a = this.ctxActive(ctx);
    if (a) a.blocked = true;
  }

  async submitForReview(ctx: ToolContext, summary: string, attachments?: string[], skipAgentReview?: boolean): Promise<void> {
    let t = this.ctxTicket(ctx);
    if (t.status !== "in_progress") throw new Error(`${t.key} is ${t.status}, not in progress`);
    // A parent in review (or done) would strand its children: their reviews and merges are its job.
    const open = this.store.tickets.list({ parentId: t.id }).filter((c) => c.status !== "done");
    if (open.length) {
      throw new Error(
        `${t.key} still has child tickets that aren't done (${open.map((c) => `${c.key}: ${c.status}`).join(", ")}). You review and complete them with review_ticket and complete_ticket; end the run now and you'll be re-invoked when they change. Submit once every child is done.`,
      );
    }
    if (skipAgentReview === true) this.assertAgentMaySkipReview(t);
    const prepared = prepareAttachments(attachments, ctx.cwd);
    if (skipAgentReview !== undefined && skipAgentReview !== !!t.skipAgentReview) {
      t = this.store.tickets.update(t.id, { skipAgentReview })!;
      this.appendStatus(t.sessionId, ctx.runId, skipAgentReview ? "The agent turned off the agent review for this ticket" : "The agent turned the agent review back on");
    }
    this.submit(t, summary?.trim() || "Work submitted for review.", "agent", storeAttachments(this.paths.attachmentsDir, prepared));
    const a = this.ctxActive(ctx);
    if (a) a.submitted = true;
    else this.enqueueReview(this.store.tickets.get(t.id)!); // tool called outside the tracked run
  }

  /**
   * An agent may skip an agent review (its own ticket's, or one it creates or edits) only when a
   * human or conductor still reviews the ticket: with the project's human review off, the agent
   * review is the only check left.
   */
  private assertAgentMaySkipReview(t: Ticket) {
    const project = this.store.projects.get(t.projectId);
    if (project && !project.requireHumanReview) {
      throw new Error(
        `${t.key}'s project (${project.key}) doesn't require a human review, so the agent review is the only review it gets and an agent can't skip it. A human can turn it off on the ticket.`,
      );
    }
  }

  async reviewDecision(ctx: ToolContext, decision: "approve" | "request_changes", notes: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (ctx.runKind !== "review") throw new Error("review_decision is only available in review runs");
    if (t.status !== "review") throw new Error(`${t.key} is no longer in review`);
    if (t.agentReview === "skipped") throw new Error(`The agent review of ${t.key} was skipped; there is nothing to decide`);
    const a = this.ctxActive(ctx);
    if (a?.decided) throw new Error("A review decision was already recorded for this run");
    if (a) a.decided = true;
    if (decision === "approve") {
      const u = this.store.tickets.update(t.id, { agentReview: "approved" })!;
      this.touchSession(u.sessionId);
      this.appendStatus(u.sessionId, ctx.runId, "Agent review: approved");
      if (notes?.trim()) this.addSummary(u.sessionId, u.id, "agent", `Review approved: ${notes.trim()}`);
      if (u.parentId) this.notifyConductor(u.parentId, { key: u.key, title: u.title, from: "review", to: "review", summary: `Agent review approved. ${notes ?? ""}`.trim() });
      this.noteReady(u);
    } else if (decision === "request_changes") {
      const n = this.store.tickets.reviewRejections(t.id) + 1;
      if (n >= MAX_AGENT_REJECTIONS) {
        const reason = `Agent review requested changes ${n} times — needs a human decision`;
        this.addSummary(t.sessionId, t.id, "agent", `Changes requested (agent): ${notes?.trim() || "no notes"}`);
        this.transition(
          t,
          "blocked",
          { reviewRejections: n, agentReview: "changes_requested", blockedReason: reason },
          reason,
          notes,
        );
      } else {
        this.store.tickets.update(t.id, { reviewRejections: n });
        this.requestChanges(t, notes ?? "", "agent");
      }
    } else {
      throw new Error(`Invalid decision: ${decision}`);
    }
  }

  // --- board (read): every run kind; never changes state ---

  private boardTicket(t: Ticket): BoardTicket {
    return { ...t, projectKey: this.store.projects.get(t.projectId)?.key ?? "" };
  }

  private boardProject(key: string): Project {
    const project = this.store.projects.getByKey(key.trim());
    if (!project) throw new Error(`Unknown project: ${key}. Use list_projects for the valid keys.`);
    return project;
  }

  async listTickets_(ctx: ToolContext, filter: BoardListFilter = {}): Promise<{ tickets: BoardTicket[]; total: number; scope: BoardScope }> {
    const own = ctx.ticket ? this.ctxTicket(ctx) : null;
    const scope: BoardScope = filter.scope ?? (filter.projectKey ? "project" : own && isConductor(own) ? "children" : own ? "project" : "all");
    const statuses = filter.statuses?.length ? filter.statuses : undefined;
    const bad = statuses?.find((st) => !(TICKET_STATUSES as readonly string[]).includes(st));
    if (bad) throw new Error(`Unknown status: ${bad}`);
    let tickets: Ticket[];
    if (scope === "children") {
      if (!own) throw new Error('scope "children" needs a ticket run; use "project" with project_key, or "all"');
      const projectId = filter.projectKey ? this.boardProject(filter.projectKey).id : undefined;
      tickets = this.store.tickets.list({ parentId: own.id, drafts: false, ...(projectId ? { projectId } : {}), ...(statuses ? { statuses } : {}) });
    } else if (scope === "project") {
      const projectId = filter.projectKey ? this.boardProject(filter.projectKey).id : own?.projectId;
      if (!projectId) throw new Error('project_key is required for scope "project" in a run without a ticket');
      tickets = this.store.tickets.list({ projectId, drafts: false, ...(statuses ? { statuses } : {}) });
    } else if (scope === "all") {
      if (filter.projectKey) throw new Error('scope "all" spans every project; drop project_key or use scope "project"');
      tickets = this.store.tickets.list({ drafts: false, ...(statuses ? { statuses } : {}) });
    } else {
      throw new Error(`Unknown scope: ${scope}`);
    }
    // Board order: columns left to right; done newest-completed first so a long Done column's
    // oldest tickets are the ones the cap drops.
    const col = (t: Ticket) => TICKET_STATUSES.indexOf(t.status);
    const sorted = tickets
      .map((t, i) => ({ t, i }))
      .sort((a, b) => col(a.t) - col(b.t) || (a.t.status === "done" ? (b.t.completedAt ?? b.t.updatedAt) - (a.t.completedAt ?? a.t.updatedAt) : 0) || a.i - b.i)
      .map(({ t }) => t);
    const limit = clampLimit(filter.limit, DEFAULT_PAGE_LIMIT);
    return { tickets: sorted.slice(0, limit).map((t) => this.boardTicket(t)), total: sorted.length, scope };
  }

  async getTicket_(_ctx: ToolContext, key: string, opts: { transcript?: number } = {}): Promise<BoardTicketDetail> {
    const found = this.agentLookup(key);
    if (!found) throw new Error(`Unknown ticket: ${key}`);
    const t = found.ticket;
    const detail: BoardTicketDetail = {
      ticket: this.boardTicket(t),
      resolvedFrom: found.alias,
      parent: t.parentId ? (this.store.tickets.get(t.parentId)?.key ?? null) : null,
      children: this.store.tickets.list({ parentId: t.id, drafts: false }).map((c) => c.key),
      base: await this.refreshBaseBranch(t),
      summaries: this.store.summaries.listBySession(t.sessionId).map((s) => ({
        author: s.author,
        body: s.body,
        createdAt: s.createdAt,
        attachments: s.attachments.map((a) => ({ name: a.name, kind: a.kind, path: this.attachmentFilePath(a) })),
      })),
    };
    const n = Math.min(BOARD_TRANSCRIPT_MAX, Math.max(0, Math.trunc(opts.transcript ?? 0)));
    if (n > 0) {
      detail.transcript = this.store.transcript.tail(t.sessionId, n, ["text", "status", "error"]).map((e) => ({
        role: e.role,
        type: e.content.type as "text" | "status" | "error",
        text: truncateMiddle("text" in e.content ? e.content.text : "", BOARD_TRANSCRIPT_CHARS),
        createdAt: e.createdAt,
      }));
    }
    return detail;
  }

  async searchTickets_(_ctx: ToolContext, input: Parameters<HarnessOps["searchTickets"]>[1]) {
    const projectId = input.projectKey ? this.boardProject(input.projectKey).id : undefined;
    let page: TicketPage;
    try {
      page = this.searchTickets({ q: input.query, projectId, limit: input.limit ?? BOARD_SEARCH_LIMIT, cursor: input.cursor ?? null, drafts: false });
    } catch (err) {
      throw new Error(errMsg(err));
    }
    return {
      hits: page.tickets.map((t) => {
        const latest = this.store.summaries.listBySession(t.sessionId).at(-1)?.body;
        return { ticket: this.boardTicket(t), snippet: searchSnippet([t.title, t.description, latest], input.query) };
      }),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async listProjects_(_ctx: ToolContext): Promise<ProjectView[]> {
    return this.store.projects.list().map((p) => this.projectView(p));
  }

  async listInbox_(_ctx: ToolContext, filter: Parameters<HarnessOps["listInbox"]>[1]): Promise<{ items: InboxItem[]; total: number }> {
    const limit = Math.min(Math.max(1, filter.limit ?? BOARD_INBOX_LIMIT), 100);
    const source = filter.source?.trim().toLowerCase();
    const matches = this.store.sessions
      .list("triage")
      .map((s) => ({ s, meta: this.store.sessions.getMeta<TriageMeta>(s.id) }))
      .filter(({ s, meta }) => {
        if (filter.statuses?.length && !filter.statuses.includes(s.triageStatus ?? "triaging")) return false;
        return !source || (meta?.source ?? "").toLowerCase() === source;
      })
      .sort((a, b) => b.s.createdAt - a.s.createdAt || b.s.key.localeCompare(a.s.key, undefined, { numeric: true }));
    const items = matches.slice(0, limit).map(({ s, meta }): InboxItem => ({
      key: s.key,
      title: s.title,
      source: meta?.source ?? "",
      status: s.triageStatus ?? "triaging",
      outcome: s.outcome,
      prompt: meta?.prompt ?? "",
      ...(filter.output ? { output: truncateMiddle(meta?.text ?? "", BOARD_TRANSCRIPT_CHARS) } : {}),
      createdAt: s.createdAt,
    }));
    return { items, total: matches.length };
  }

  // --- board (write): work, conductor and chat runs; the HTTP API's code paths plus guard rails ---

  /** The caller's ticket, for a run kind that may change the board. */
  private boardActor(ctx: ToolContext, tool: string): Ticket {
    if (!BOARD_WRITE_RUNS.includes(ctx.runKind)) throw new Error(`${tool} is only available in work, conductor and chat runs`);
    return this.ctxTicket(ctx);
  }

  /** Another ticket the caller may act on: never its own (block / submit_for_review cover that). */
  private boardTarget(ctx: ToolContext, key: string, tool: string): { actor: Ticket; target: Ticket } {
    const actor = this.boardActor(ctx, tool);
    const target = this.agentLookup(String(key ?? "").trim())?.ticket;
    if (!target) throw new Error(`Unknown ticket: ${key}`);
    if (target.id === actor.id) {
      throw new Error(`${target.key} is your own ticket. ${tool} acts on other tickets; use ${actor.kind === "conductor" ? "submit_for_review" : "block or submit_for_review"} to change your own.`);
    }
    return { actor, target };
  }

  private noPendingApproval(t: Ticket) {
    if (t.pendingApproval) {
      throw new Error(`${t.key} is waiting on a human to answer a tool approval (${t.pendingApproval.toolName}); only a human can answer it or move it.`);
    }
  }

  /**
   * Starting a run on a ticket with a looser permission mode than the caller's would let a strict
   * agent get work done that its own mode forbids.
   */
  private notLooserThanCaller(actor: Ticket, target: Ticket) {
    const mine = this.permissionModeFor(actor);
    const theirs = this.permissionModeFor(target);
    if (PERMISSION_STRICTNESS[theirs] < PERMISSION_STRICTNESS[mine]) {
      throw new Error(`${target.key} runs in ${theirs}, looser than your ${mine}; ask a human.`);
    }
  }

  /** HarnessErrors (HTTP status codes) become plain tool errors with the same message. */
  private async asTool<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  private asToolSync<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  async createTicket_(ctx: ToolContext, input: CreateTicketInput): Promise<Ticket> {
    const own = this.boardActor(ctx, "create_ticket");
    const project = input.projectKey ? this.boardProject(input.projectKey) : this.store.projects.get(own.projectId);
    if (!project) throw new Error(`Unknown project for ${own.key}`);
    const kind = input.conductor ? "conductor" : "task";
    // The new ticket runs no looser than its creator: it takes the caller's mode when the project's
    // would be looser, and otherwise keeps inheriting.
    const mine = this.permissionModeFor(own);
    const inherited = this.permissionModeFor(null, project);
    const permissionMode = PERMISSION_STRICTNESS[mine] > PERMISSION_STRICTNESS[inherited] ? mine : undefined;
    // depends_on lets the scheduler start the new ticket on its own; that must never happen under a
    // looser mode than the caller's. Unreachable while the rule above holds; kept as the backstop.
    const effective = permissionMode ?? inherited;
    if (input.dependsOn?.length && PERMISSION_STRICTNESS[effective] < PERMISSION_STRICTNESS[mine]) {
      throw new Error(`The new ticket would run in ${effective}, looser than your ${mine}; ask a human.`);
    }
    if (input.skipAgentReview && !project.requireHumanReview) {
      throw new Error(`${project.key} doesn't require a human review, so the agent review is the only review its tickets get and an agent can't skip it.`);
    }
    if (input.child ?? own.kind === "conductor") {
      // Children run on the parent's driver/model unless it picks another. Any ticket can take
      // children; having one makes it act as a conductor (isConductor).
      return this.asTool(() =>
        this.createTicket({
          projectId: project.id,
          prompt: input.description || input.title,
          title: input.title,
          kind,
          dependsOn: input.dependsOn,
          autoStart: input.autoStart ?? true,
          parentId: own.id,
          start: input.start ?? false,
          driver: input.driver ?? own.driver,
          model: input.model !== undefined ? input.model : input.driver ? null : own.model,
          permissionMode,
          useWorktree: input.useWorktree,
          branch: input.branch,
          baseBranch: input.baseBranch,
          skipAgentReview: input.skipAgentReview,
        }),
      );
    }
    return this.asTool(() =>
      this.createTicket({
        projectId: project.id,
        prompt: input.description || input.title,
        title: input.title,
        kind,
        dependsOn: input.dependsOn,
        autoStart: input.autoStart,
        start: input.start ?? false,
        driver: input.driver,
        model: input.model,
        permissionMode,
        useWorktree: input.useWorktree,
        branch: input.branch,
        baseBranch: input.baseBranch,
        skipAgentReview: input.skipAgentReview,
      }),
    );
  }

  async updateTicket_(ctx: ToolContext, key: string, input: UpdateTicketInput): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "update_ticket");
    // Editing a looser ticket (its brief, dependencies, driver...) would get it to act for the caller
    // under looser permissions. The one edit allowed on it is tightening its mode, alone.
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateTicketInput] !== undefined);
    if (!(fields.length === 1 && fields[0] === "permissionMode")) this.notLooserThanCaller(actor, target);
    const body: UpdateTicketBody = {};
    if (input.title !== undefined) {
      if (!String(input.title).trim()) throw new Error("title can't be empty");
      body.title = String(input.title).trim();
    }
    if (input.description !== undefined) body.description = input.description;
    if (input.driver !== undefined) body.driver = input.driver;
    if (input.model !== undefined) body.model = input.model;
    if (input.dependsOn !== undefined) body.dependsOn = input.dependsOn;
    if (input.baseBranch !== undefined) body.baseBranch = input.baseBranch;
    if (input.branch !== undefined) body.branch = input.branch;
    if (input.skipAgentReview !== undefined) {
      // Turning it on in review would end the review under way; that's the reviewers' call.
      if (target.status === "review" && target.parentId !== actor.id) {
        throw new Error(`${target.key} is in review; its reviewers decide whether its agent review runs.`);
      }
      if (input.skipAgentReview) this.assertAgentMaySkipReview(target);
      body.skipAgentReview = input.skipAgentReview;
    }
    if (input.permissionMode !== undefined) {
      // Agents may tighten another ticket's permission mode, never loosen it: that would be a way
      // around the approvals a human set up.
      const mode = this.asToolSync(() => validPermissionMode(input.permissionMode));
      const project = this.store.projects.get(target.projectId);
      const from = resolvePermissionMode(target, project, this.settings()).mode;
      const to = resolvePermissionMode({ permissionMode: mode }, project, this.settings()).mode;
      if (PERMISSION_STRICTNESS[to] < PERMISSION_STRICTNESS[from]) {
        throw new Error(`Agents can't loosen a ticket's permission mode (${target.key} runs in ${from}; ${mode ?? "inherit"} would be ${to}). Ask a human.`);
      }
      body.permissionMode = mode;
    }
    if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one field");
    return this.asTool(() => this.updateTicket(target.key, body));
  }

  async moveTicket_(ctx: ToolContext, key: string, status: TicketStatus, position?: number): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "move_ticket");
    if (!(TICKET_STATUSES as readonly string[]).includes(status)) throw new Error(`Unknown status: ${status}. Use one of ${TICKET_STATUSES.join(", ")}`);
    if (position !== undefined && (typeof position !== "number" || !Number.isInteger(position) || position < 0)) {
      throw new Error("position must be a whole number ≥ 0 (0 = top of the column)");
    }
    if (status !== target.status) {
      this.noPendingApproval(target);
      if (target.status === "review") {
        throw new Error(
          `${target.key} is in review: its reviewers decide what happens next (review_ticket / complete_ticket when it's your conductor's child, otherwise a human).`,
        );
      }
      if (status === "review") throw new Error(`Only ${target.key}'s own agent moves it to review (submit_for_review).`);
      if (status === "done" && target.status !== "planning") {
        throw new Error(`${target.key} is ${target.status}: only a ticket still in planning can be moved straight to done (to close one that isn't needed). Finished work goes through review.`);
      }
      if (status === "in_progress" || status === "planning") this.notLooserThanCaller(actor, target);
    } else if (position === undefined) {
      throw new Error(`${target.key} is already ${status}; pass position to reorder it`);
    }
    let pos: number | undefined;
    if (position !== undefined) {
      if (status === "done") throw new Error("The done column is ordered by completion time; position doesn't apply");
      const column = this.store.tickets.list({ projectId: target.projectId, statuses: [status], drafts: false }).filter((t) => t.id !== target.id);
      pos = positionForDrop(column, position);
    }
    return this.asTool(() => this.updateTicket(target.key, { ...(status !== target.status ? { status } : {}), ...(pos !== undefined ? { position: pos } : {}) }));
  }

  async startTicket_(ctx: ToolContext, key: string): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "start_ticket");
    this.noPendingApproval(target);
    this.notLooserThanCaller(actor, target);
    return this.asTool(() => this.startTicket(target.key));
  }

  async messageTicket_(ctx: ToolContext, key: string, text: string): Promise<void> {
    const { actor, target } = this.boardTarget(ctx, key, "message_ticket");
    this.noPendingApproval(target);
    // A message moves a ticket in review back to in progress: that's a review decision, which only
    // its conductor (standing in for the human reviewer) may make.
    if (target.status === "review" && target.parentId !== actor.id) {
      throw new Error(`${target.key} is in review; messaging it would send it back to in progress. Only its reviewers can do that.`);
    }
    this.notLooserThanCaller(actor, target);
    await this.asTool(() => this.sendMessage(target.key, text));
  }

  async cancelTicket_(ctx: ToolContext, key: string): Promise<Ticket> {
    const { target } = this.boardTarget(ctx, key, "cancel_ticket");
    // Nothing runs while an approval waits; cancelling would only strand it.
    this.noPendingApproval(target);
    return this.asTool(() => this.cancelTicket(target.key));
  }

  async reopenTicket_(ctx: ToolContext, key: string, notes: string): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "reopen_ticket");
    this.notLooserThanCaller(actor, target);
    return this.asTool(() => this.reopenTicket(target.key, { notes }));
  }

  // --- conductor ---

  /** The caller, standing in for its children's human reviewer. Any ticket may: childOf checks the parent. */
  private conductorOf(ctx: ToolContext, tool: string): Ticket {
    return this.boardActor(ctx, tool);
  }

  private childOf(conductor: Ticket, key: string): Ticket {
    const t = this.agentLookup(key)?.ticket;
    if (!t) throw new Error(`Unknown ticket: ${key}`);
    if (t.parentId !== conductor.id) throw new Error(`${t.key} is not a child of ${conductor.key}`);
    return t;
  }

  async reviewTicket_(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string, action?: CompletionAction): Promise<Ticket> {
    const child = this.childOf(this.conductorOf(ctx, "review_ticket"), key);
    try {
      return this.applyReview(child, decision, notes ?? "", "conductor", { action });
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  async completeTicket_(ctx: ToolContext, key: string, instructions?: string, action?: CompletionAction): Promise<Ticket> {
    const child = this.childOf(this.conductorOf(ctx, "complete_ticket"), key);
    if (child.status !== "review" || !reviewPassed(child.agentReview) || child.humanReview !== "approved") {
      throw new Error(`${child.key} is not ready: both reviews must be approved first`);
    }
    try {
      return await this.completeTicket(child.key, { instructions, action });
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  /** record_pull_request: the pull request a "pr" completion opened (or updated). */
  async recordPullRequest(ctx: ToolContext, url: string): Promise<string> {
    const t = this.ctxTicket(ctx);
    if (ctx.runKind !== "complete" || t.completionAction !== "pr") {
      throw new Error("record_pull_request is only for completion runs that open a pull request");
    }
    const u = String(url ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(u)) throw new Error("url must be the pull request's http(s) link, as gh printed it");
    const updated = this.store.tickets.update(t.id, { pullRequestUrl: u })!;
    this.bus.emit({ kind: "ticket.upserted", ticket: updated });
    this.appendStatus(t.sessionId, ctx.runId, `Pull request: ${u}`);
    const a = this.ctxActive(ctx);
    if (a) a.pullRequest = true;
    return `Recorded ${u} on ${t.key}.`;
  }

  /** `more`: a dispatch may follow earlier dispatches (one output can hold several items). */
  private triageMeta(ctx: ToolContext, more = false): { session: Session; meta: TriageMeta } {
    const session = this.store.sessions.get(ctx.session.id);
    if (!session || session.kind !== "triage") throw new Error("Not a triage session");
    const meta = this.store.sessions.getMeta<TriageMeta>(session.id);
    if (!meta) throw new Error("Triage session has no output");
    const open = session.triageStatus === "triaging" || (more && session.triageStatus === "dispatched");
    if (!open) throw new Error(`This output was already ${session.triageStatus}`);
    return { session, meta };
  }

  async dispatchTicket(ctx: ToolContext, input: Parameters<HarnessOps["dispatchTicket"]>[1]): Promise<Ticket> {
    const { session, meta } = this.triageMeta(ctx, true);
    const project = this.store.projects.getByKey(input.projectKey ?? "");
    if (!project) throw new Error(`Unknown project: ${input.projectKey}`);
    const key = input.key?.trim().toUpperCase() || null;
    // A draft isn't there for triage: its key is taken, so creating one under it fails below.
    const existing = key ? (this.agentLookup(key)?.ticket ?? null) : null;
    if (existing) {
      const body = input.description?.trim() || `Update from ${meta.source}: ${input.title || session.title}`;
      const t = await this.sendMessage(existing.key, body);
      this.finishTriage(session.id, "dispatched", `Sent update to existing ${existing.key}`, input.title);
      return t;
    }
    if (key && !isTicketKey(key)) throw new Error(`Invalid ticket key: ${key}`);
    const t = await this.createTicket({
      projectId: project.id,
      key: key ?? undefined,
      title: input.title,
      prompt: input.description || input.title,
      kind: input.conductor ? "conductor" : "task",
      start: input.start ?? false,
      driver: project.defaultDriver ?? session.driver,
      // Only an external key makes the ticket a mirror; otherwise the description carries the context.
      externalRef: key ? { source: meta.source, key, url: input.url?.trim() || null, raw: meta.text ?? null } : null,
    });
    this.finishTriage(session.id, "dispatched", `Dispatched to ${t.key} in ${project.key}`, input.title);
    return t;
  }

  // =========================================================================
  // Config tools (DESIGN.md "Config tools"). The tools gate every mutation behind a human
  // approval; these check the run may make config changes at all and resolve agent-facing
  // references (keys, names). dryRun validates only.
  // =========================================================================

  /** A run that may change configuration: work or conductor, acting for its ticket. */
  private configWriter(ctx: ToolContext): Ticket {
    if (!CONFIG_RUNS.includes(ctx.runKind) || !ctx.ticket) throw new Error(`Configuration can't be changed during a ${ctx.runKind} run.`);
    return this.ctxTicket(ctx);
  }

  private projectView(p: Project): ProjectView {
    return {
      key: p.key,
      name: p.name,
      path: p.path,
      defaultDriver: p.defaultDriver,
      defaultModels: p.defaultModels,
      useWorktrees: p.useWorktrees,
      requireHumanReview: p.requireHumanReview,
      autoComplete: p.autoComplete,
      permissionMode: p.permissionMode,
      color: p.color,
      baseBranch: p.baseBranch ?? null,
      completionAction: p.completionAction ?? "merge",
      completionActions: p.completionActions ?? offeredCompletionActions(p),
      pullRequestHost: p.pullRequestHost ?? null,
    };
  }

  private projectByKey(key: string): Project {
    const p = this.store.projects.getByKey(String(key ?? "").trim().toUpperCase());
    if (!p) throw new Error(`Unknown project: ${key}. Use list_projects for the keys.`);
    return p;
  }

  private watcherByRef(ref: string): Watcher {
    const byId = this.store.watchers.get(ref);
    if (byId) return byId;
    const named = this.store.watchers.list().filter((w) => w.name === ref);
    if (named.length === 1) return named[0]!;
    throw new Error(named.length ? `Several watchers are named "${ref}"; use its id (list_watchers).` : `Unknown watcher: ${ref}. Use list_watchers.`);
  }

  /** HTTP-style errors (badRequest…) become plain errors: the message is what the model sees. */
  private asToolError<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  async listWatchers_(_ctx: ToolContext): Promise<Watcher[]> {
    return this.listWatchers();
  }

  async getSettings_(_ctx: ToolContext): Promise<PublicSettings> {
    return this.publicSettings();
  }

  async listDrivers_(_ctx: ToolContext) {
    const infos = await this.driverInfos();
    return Promise.all(infos.map(async (info) => ({ ...info, models: await this.listModels(info.id) })));
  }

  async createWatcher_(ctx: ToolContext, input: WatcherBody & { name: string; command: string }, dryRun = false): Promise<Watcher | null> {
    this.configWriter(ctx);
    return this.asToolError(() => {
      if (dryRun) return (this.validateWatcher(input, null), null);
      const w = this.createWatcher(input);
      this.log(`watcher "${w.name}" created by ${ctx.ticket!.key}`);
      return w;
    });
  }

  async updateWatcher_(ctx: ToolContext, ref: string, input: WatcherBody, dryRun = false): Promise<Watcher | null> {
    this.configWriter(ctx);
    const w = this.watcherByRef(ref);
    const body: WatcherBody = { ...input };
    if (input.env !== undefined) {
      // Tools merge env (a model never sees the stored values): "" removes a variable.
      const env = { ...w.env };
      for (const [k, v] of Object.entries(input.env ?? {})) {
        if (v === "" || v === null) delete env[k];
        else env[k] = v;
      }
      body.env = env;
    }
    return this.asToolError(() => (dryRun ? (this.validateWatcher(body, w), null) : this.updateWatcher(w.id, body)));
  }

  async deleteWatcher_(ctx: ToolContext, ref: string, dryRun = false): Promise<Watcher> {
    this.configWriter(ctx);
    const w = this.watcherByRef(ref);
    if (!dryRun) this.deleteWatcher(w.id);
    return w;
  }

  async runWatcher_(ctx: ToolContext, ref: string, dryRun = false): Promise<Watcher> {
    this.configWriter(ctx);
    const w = this.watcherByRef(ref);
    if (!this.watcherRunner) throw new Error("Watchers are disabled in this service.");
    if (!dryRun) await this.runWatcher(w.id);
    return w;
  }

  async createProject_(ctx: ToolContext, input: CreateProjectBody, dryRun = false): Promise<ProjectView | null> {
    this.configWriter(ctx);
    return this.asToolError(() => (dryRun ? (this.prepareProject(input), null) : this.projectView(this.createProject(input))));
  }

  async updateProject_(ctx: ToolContext, key: string, input: Partial<CreateProjectBody>, dryRun = false): Promise<ProjectView | null> {
    this.configWriter(ctx);
    const p = this.projectByKey(key);
    return this.asToolError(() => (dryRun ? (this.prepareProjectUpdate(p, input), null) : this.projectView(this.updateProject(p.id, input))));
  }

  async deleteProject_(ctx: ToolContext, key: string, dryRun = false): Promise<ProjectView> {
    const own = this.configWriter(ctx);
    const p = this.projectByKey(key);
    if (this.lineage(own).some((t) => t.projectId === p.id)) {
      throw new Error(`You can't delete ${p.key}: your ticket ${own.key}${own.projectId === p.id ? " is in it" : " descends from a ticket in it"}.`);
    }
    if (!dryRun) await this.deleteProject(p.id);
    return this.projectView(p);
  }

  async updateSettings_(ctx: ToolContext, patch: Record<string, unknown>, dryRun = false): Promise<PublicSettings> {
    this.configWriter(ctx);
    // Secrets never pass through a model; the legacy/echo keys aren't for tools either.
    for (const k of ["anthropicApiKey", "anthropicApiKeySet", "claudePermissionMode"]) {
      if (patch && k in patch) throw new Error(`${k} can't be changed with a tool${k === "anthropicApiKey" ? ": ask the human to enter it in Settings" : ""}.`);
    }
    return this.asToolError(() => {
      if (dryRun) return (validateSettingsPatch(patch, [...this.drivers.keys()], this.settings()), this.publicSettings());
      return this.updateSettings(patch);
    });
  }

  async deleteTicket_(ctx: ToolContext, key: string, dryRun = false): Promise<Ticket> {
    const own = this.configWriter(ctx);
    const t = this.agentLookup(String(key ?? "").trim().toUpperCase())?.ticket;
    if (!t) throw new Error(`Unknown ticket: ${key}`);
    if (this.lineage(own).some((a) => a.id === t.id)) {
      throw new Error(t.id === own.id ? `You can't delete your own ticket (${t.key}).` : `You can't delete ${t.key}: it is an ancestor of your ticket ${own.key}.`);
    }
    if (!dryRun) await this.deleteTicket(t.key);
    return t;
  }

  /** The ticket and its ancestors (parent chain), nearest first. */
  private lineage(t: Ticket): Ticket[] {
    const out: Ticket[] = [];
    const seen = new Set<string>();
    for (let cur: Ticket | null = t; cur && !seen.has(cur.id); cur = cur.parentId ? this.store.tickets.get(cur.parentId) : null) {
      seen.add(cur.id);
      out.push(cur);
    }
    return out;
  }

  async requestApproval(
    ctx: ToolContext,
    toolName: string,
    input: unknown,
    meta: ApprovalMeta = {},
  ): Promise<{ behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }> {
    if (ctx.runKind === "chat") {
      return {
        behavior: "deny",
        message: `${toolName} needs a human's approval, and a chat can't ask for one: that would block the ticket, and a chat leaves its status alone. Proceed without it, and say in your answer what you couldn't run.`,
      };
    }
    if (!APPROVABLE_RUNS.includes(ctx.runKind) || !ctx.ticket) {
      return {
        behavior: "deny",
        message: `No human is available to approve tools during a ${ctx.runKind} run; proceed without it and mention it in your notes.`,
      };
    }
    const t = this.ctxTicket(ctx);
    if (this.permissionModeFor(t) === "read_only") {
      // Nothing in read-only mode goes to a human: the answer would always be no.
      return { behavior: "deny", message: `${toolName} isn't allowed: this ticket is in read-only mode. Don't retry it; report what you would change instead.` };
    }
    // A matching one-time grant is used up first, even when the tool is also allowed outright.
    if (this.store.tickets.consumeGrant(t.id, toolName, input)) return { behavior: "allow", updatedInput: input };
    // Gated harness tools are never allowed wholesale, even if a name ended up in allowedTools.
    const onceOnly = !!meta.onceOnly || GATED_TOOL_NAMES.has(toolName);
    if (!onceOnly && t.allowedTools.includes(toolName)) return { behavior: "allow", updatedInput: input };
    if (meta.viaPromptTool && !onceOnly && this.permissionModeFor(t) === "auto") {
      // An auto-mode ticket whose run is in ask mode only to deliver a grant (planGrants): judge
      // the rest of its calls as auto mode would, instead of sending every one to a human. The
      // gate asks a human (meta.source set, so no loop) only when the classifier can't decide.
      const d = await this.gate.judge(toolName, input, this.gateEnv(ctx, t, "auto"));
      return d.behavior === "allow" ? { behavior: "allow", updatedInput: input } : d;
    }
    if (t.pendingApproval) return { behavior: "deny", message: APPROVAL_PENDING_MESSAGE }; // one request at a time
    this.openApproval(t, ctx.runId, toolName, input, onceOnly ? { ...meta, onceOnly } : meta);
    return { behavior: "deny", message: APPROVAL_PENDING_MESSAGE };
  }

  /**
   * Put a tool call in front of a human: pendingApproval + blocked. A ticket the agent already
   * blocked (it called block after a denial) keeps its question; the approval is attached to it.
   */
  private openApproval(t: Ticket, runId: string, toolName: string, input: unknown, meta: ApprovalMeta) {
    const pending: PendingApproval = { id: crypto.randomUUID(), runId, toolName, input, requestedAt: Date.now() };
    if (meta.reason) pending.reason = meta.reason;
    if (meta.source) pending.source = meta.source;
    if (meta.summary) pending.summary = meta.summary;
    if (meta.onceOnly) pending.onceOnly = true;
    const reason = `Permission needed: ${toolName} — ${meta.summary ?? summarizeToolInput(input)}`;
    this.addSummary(t.sessionId, t.id, "system", meta.reason ? `${reason}\n\n${meta.source === "classifier" ? "Classifier" : "Policy"}: ${meta.reason}` : reason);
    if (t.status === "blocked") {
      this.store.tickets.update(t.id, { pendingApproval: pending });
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, reason);
    } else {
      this.transition(t, "blocked", { pendingApproval: pending, blockedReason: reason }, reason, reason);
    }
  }

  /**
   * RunRequest.grants: human grants for runs that act for the ticket (not review/plan/triage, not
   * read_only). Chat runs get the ticket's "always allow" tools, but its one-time grants wait for
   * the work run they were given to.
   */
  private runGrants(kind: RunKind, ticket: Ticket | null, project: Project | null, active: ActiveRun): RunGrants | undefined {
    if (!ticket || (!APPROVABLE_RUNS.includes(kind) && kind !== "chat")) return undefined;
    if (this.permissionModeFor(ticket, project) === "read_only") return undefined;
    if (kind === "chat") return { tools: ticket.allowedTools.filter((name) => !GATED_TOOL_NAMES.has(name)), once: [] };
    const grants = this.store.tickets.listGrants(ticket.id);
    active.offeredGrants = grants.map((g) => g.id);
    // Gated harness tools consume their grants in-process (requestApproval); the driver never
    // sees them (claude-code would downgrade an auto run to acceptEdits for a grant it can't express).
    const once = grants.filter((g) => !GATED_TOOL_NAMES.has(g.toolName)).map((g) => {
      const viaPrompt = this.ruleFailures.has(`${ticket.id}\u0000${grantKey(g.toolName, g.input)}`);
      return viaPrompt ? { toolName: g.toolName, input: g.input, viaPrompt } : { toolName: g.toolName, input: g.input };
    });
    return { tools: ticket.allowedTools.filter((name) => !GATED_TOOL_NAMES.has(name)), once };
  }

  /**
   * After a succeeded work/complete/conductor run: the driver's own permission system denied a
   * call without asking (Claude Code's auto-mode classifier, or a deferred soft_deny of the
   * PermissionGate) and the call never went through. The agent is told to find another way
   * first, so a run that submitted is reviewed as usual, with the denied calls noted in a
   * summary. Otherwise the run's last denial becomes a pending approval: attached to the
   * agent's block if it blocked, or blocking the ticket if the run just ended.
   * A denial of a tool the human already allows on the ticket is retried with the exact call
   * pre-approved instead (bounded by MAX_AUTO_RETRIES). Returns true when it handled the run.
   */
  private surfaceDenial(ticket: Ticket, run: Run, active: ActiveRun): boolean {
    const denial = active.denials.at(-1);
    if (!denial || !APPROVABLE_RUNS.includes(run.kind)) return false;
    const t = this.store.tickets.get(ticket.id);
    if (!t || t.pendingApproval || this.permissionModeFor(t) === "read_only") return false;
    if (active.submitted && t.status === "review") {
      // The agent found another way and submitted: the review goes ahead, and the denied calls
      // are on record for the reviewer and the human.
      const calls = [...new Map(active.denials.map((d) => [grantKey(d.toolName, d.input), d])).values()];
      const lines = calls.map((d) => `- ${d.toolName} (${summarizeToolInput(d.input)}): ${d.reason}`);
      this.addSummary(t.sessionId, t.id, "system", `The classifier denied ${calls.length === 1 ? "a call" : `${calls.length} calls`} during this run, and the agent submitted without ${calls.length === 1 ? "it" : "them"}:\n${lines.join("\n")}`);
      return false;
    }
    if (t.status !== "in_progress" && t.status !== "blocked" && !(t.status === "review" && run.kind === "complete")) return false;
    const key = grantKey(denial.toolName, denial.input);
    // The exact rule for this call was passed and it was still denied: next time, ask instead.
    if (active.appliedGrants.has(key)) this.ruleFailures.add(`${t.id}\u0000${key}`);
    const what = `${denial.toolName} (${summarizeToolInput(denial.input)})`;
    const retries = this.autoRetries.get(t.id) ?? 0;
    if (t.allowedTools.includes(denial.toolName) && retries < MAX_AUTO_RETRIES) {
      this.autoRetries.set(t.id, retries + 1);
      this.store.tickets.addGrant(t.id, denial.toolName, denial.input);
      const kind = run.kind === "complete" ? "complete" : this.workKind(t);
      this.appendStatus(t.sessionId, run.id, `Claude Code's classifier denied ${what}, but ${denial.toolName} is allowed on this ticket: retrying with that call pre-approved`);
      const u = this.transition(t, kind === "complete" ? "review" : "in_progress", { blockedReason: null }, t.status === "blocked" ? "Unblocked: the denied tool is allowed on this ticket" : undefined);
      this.enqueueRun(
        u.sessionId,
        kind,
        `${what} was denied by Claude Code's classifier, but the human allows ${denial.toolName} on this ticket. Retry it now and continue.`,
      );
      return true;
    }
    this.openApproval(t, run.id, denial.toolName, denial.input, { reason: denial.reason, source: "classifier" });
    return true;
  }

  // =========================================================================
  // Permission modes (DESIGN.md "Permissions")
  // =========================================================================

  /** Effective mode for a ticket: ticket → project → settings. */
  permissionModeFor(ticket: Ticket | null, project?: Project | null): PermissionMode {
    const fresh = ticket ? (this.store.tickets.get(ticket.id) ?? ticket) : null;
    const p = project !== undefined ? project : fresh ? this.store.projects.get(fresh.projectId) : null;
    return resolvePermissionMode(fresh, p, this.settings()).mode;
  }

  // =========================================================================
  // Branches (DESIGN.md "Branches")
  // =========================================================================

  /**
   * Effective base branch: ticket → project → settings. When nothing overrides the setting and
   * the repo has no branch of that name (a "master" repo under the default "main"), it falls back
   * to the branch checked out in the main checkout, which is what the harness always used before
   * base branches existed. An explicit ticket or project base branch is taken as given.
   */
  baseBranchFor(ticket: Ticket | null, project?: Project | null): { branch: string; source: BaseBranchSource | "checkout" } {
    const p = project !== undefined ? project : ticket ? this.store.projects.get(ticket.projectId) : null;
    const r = resolveBaseBranch(ticket, p, this.settings(), this.branchParent(ticket));
    if (r.source !== "settings" || !p) return r;
    const head = this.baseFallback.get(`${p.path}\u0000${r.branch}`);
    return head ? { branch: head, source: "checkout" } : r;
  }

  /**
   * baseBranchFor, after asking git whether the settings' branch exists in the project (cached
   * for the sync callers). Called wherever a run is about to start or a worktree is made.
   */
  async refreshBaseBranch(ticket: Ticket | null, project?: Project | null): Promise<{ branch: string; source: BaseBranchSource | "checkout" }> {
    const p = project !== undefined ? project : ticket ? this.store.projects.get(ticket.projectId) : null;
    const r = resolveBaseBranch(ticket, p, this.settings(), this.branchParent(ticket));
    // Only the inherited setting can fall back; a folder outside git has nothing to ask.
    if (r.source === "settings" && p && p.isGit !== false) {
      // Outside a repo branchExists fails and currentBranch gives null: no fallback.
      const head = (await branchExists(p.path, r.branch)) ? null : await currentBranch(p.path);
      const key = `${p.path}\u0000${r.branch}`;
      if (head) this.baseFallback.set(key, head);
      else this.baseFallback.delete(key);
    }
    return this.baseBranchFor(ticket, p);
  }

  /** What the prompts need to know about the ticket's branches. */
  private branchContext(ticket: Ticket | null, project: Project | null): prompts.BranchContext {
    const base = this.baseBranchFor(ticket, project);
    const ownsWorktree = !ticket?.workdir || isInside(ticket.workdir, this.paths.worktreesDir);
    let leftover: prompts.BranchContext["leftover"] = null;
    if (ticket?.branch && ticket.workdir && !ownsWorktree) {
      // update_branch moved the ticket out of its harness worktree and left that one in place.
      const old = join(this.paths.worktreesDir, ticket.key);
      if (existsSync(old)) leftover = { path: old, branch: branchForKey(ticket.key) };
    }
    const pullRequest = project && ticket?.completionAction === "pr" ? cachedPullRequestTarget(project.path) : null;
    return { base: base.branch, baseSource: base.source, ownsWorktree, worktreesDir: this.paths.worktreesDir, leftover, pullRequest };
  }

  private completePromptFor(t: Ticket, instructions?: string): string {
    const project = this.store.projects.get(t.projectId) ?? null;
    return this.prompts().completePrompt(t, instructions, this.branchContext(t, project), project);
  }

  /**
   * update_branch: re-point the run's own ticket (work and conductor runs). A branch checked out
   * in another worktree moves the ticket (workdir and session cwd) into that worktree; any other
   * branch is switched to in the ticket's worktree (created at its HEAD when new). Nothing is
   * ever deleted: the old worktree and branch stay for the human to clean up.
   */
  async updateBranch_(ctx: ToolContext, input: { branch?: string; baseBranch?: string | null }): Promise<string> {
    const t = this.boardActor(ctx, "update_branch");
    if (input.branch === undefined && input.baseBranch === undefined) throw new Error("Nothing to update: pass branch, base_branch, or both.");
    const patch: TicketPatch = {};
    const done: string[] = [];
    if (input.baseBranch !== undefined) {
      patch.baseBranch = this.asToolSync(() => validateBranchName("base_branch", input.baseBranch));
    }
    if (input.branch !== undefined) {
      const branch = this.asToolSync(() => validateBranchName("branch", input.branch, false))!;
      const workdir = t.workdir;
      if (!t.branch || !workdir || !existsSync(workdir)) {
        throw new Error(
          workdir && existsSync(workdir)
            ? `${t.key} runs in the project checkout at ${workdir}, not a worktree of its own, so update_branch has nothing to re-point. Switch branches there with git only if the ticket asks for it.`
            : `${t.key} has no worktree right now, so there is nothing to re-point.`,
        );
      }
      const from = t.branch;
      if (branch === from) {
        done.push(`${t.key} is already on ${branch} in ${workdir}; nothing changed.`);
      } else {
        const holder = await checkedOutElsewhere(workdir, branch, workdir);
        const unmerged = await commitsNotIn(workdir, from, branch, (await this.refreshBaseBranch(t)).branch);
        const pending =
          unmerged > 0
            ? ` ${unmerged} commit${unmerged === 1 ? "" : "s"} on ${from} ${unmerged === 1 ? "isn't" : "aren't"} on ${branch}: integrate ${unmerged === 1 ? "it" : "them"}${holder ? ` in ${holder.path} (git -C ${holder.path} cherry-pick or merge ${from})` : ` (git cherry-pick or git merge ${from})`} before you finish, since completion merges ${branch}, not ${from}.`
            : "";
        if (holder) {
          patch.workdir = holder.path;
          patch.branch = branch;
          patch.requestedBranch = branch;
          this.store.sessions.update(t.sessionId, { cwd: holder.path });
          done.push(
            `${t.key} now uses branch ${branch} in the worktree at ${holder.path}, where it is checked out. Your next run starts there; for the rest of this run, work in that directory (git -C ${holder.path}, absolute paths).${pending} The old worktree at ${workdir} and branch ${from} are left in place for cleanup; nothing was deleted.`,
          );
        } else {
          const { created } = await this.asTool(() => switchBranch(workdir, branch));
          patch.branch = branch;
          patch.requestedBranch = branch;
          done.push(
            `Switched the worktree at ${workdir} from ${from} to ${created ? `a new branch ${branch} at ${from}'s commit` : branch}.${created ? "" : pending} Branch ${from} is left in place for cleanup; nothing was deleted.`,
          );
        }
      }
    }
    const u = this.store.tickets.update(t.id, patch)!;
    const base = await this.refreshBaseBranch(u);
    if (patch.baseBranch !== undefined) {
      done.push(`Base branch: ${base.branch} (${BASE_SOURCE_LABEL[base.source]}); the work merges into it when the ticket completes.`);
    }
    this.touchSession(u.sessionId);
    this.appendStatus(u.sessionId, ctx.runId, `Branch updated: ${u.branch ?? "none"}, base ${base.branch}`);
    return done.join("\n");
  }

  /** The classifier for settings.classifier (or the injected one); null → "off". */
  private classifier(): Classifier | null {
    if (this.classifierOption !== undefined) return this.classifierOption;
    const settings = this.settings();
    if (settings.classifier === "off") return null;
    if (process.env.NODE_ENV === "test") {
      // Tests must never reach a real model; inject a classifier to exercise auto mode.
      return { backend: settings.classifier, classify: async () => Promise.reject(new Error("no real classifier under bun test")) };
    }
    const key = `${settings.classifier}|${settings.defaultModels["anthropic-api"] ?? ""}`;
    if (this.classifierCache?.key === key) return this.classifierCache.classifier;
    const rules = () => this.autoModeRules.get();
    const classifier: Classifier =
      settings.classifier === "anthropic-api"
        ? new AnthropicApiClassifier({
            apiKey: () => this.settings().anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null,
            model: () => this.settings().defaultModels["anthropic-api"] || DEFAULT_ANTHROPIC_MODEL,
            rules,
          })
        : new ClaudeCliClassifier({ bin: () => resolveClaudeBin(process.env), env: () => cleanClaudeEnv(process.env), rules });
    this.classifierCache = { key, classifier };
    return classifier;
  }

  /** HarnessOps.fileOutputScope: review runs only read too, whatever the ticket's mode. */
  async fileOutputScope(ctx: ToolContext): Promise<{ scratchDir: string; readOnly: boolean }> {
    const ticket = ctx.ticket ? (this.store.tickets.get(ctx.ticket.id) ?? null) : null;
    const readOnly = READ_ONLY_RUNS.includes(ctx.runKind) || ctx.runKind === "review" || this.permissionModeFor(ticket) === "read_only";
    return { scratchDir: join(this.paths.scratchDir, ctx.session.id), readOnly };
  }

  /** HarnessOps.checkPermission: run a native tool call through the PermissionGate. */
  async checkPermission(ctx: ToolContext, toolName: string, input: unknown): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const ticket = ctx.ticket ? this.store.tickets.get(ctx.ticket.id) : null;
    // Plan and triage runs are read-only for every driver (claude-code runs plan runs in
    // --permission-mode plan).
    const mode: PermissionMode = READ_ONLY_RUNS.includes(ctx.runKind) ? "read_only" : this.permissionModeFor(ticket);
    return this.gate.check(toolName, input, this.gateEnv(ctx, ticket ?? null, mode));
  }

  private gateEnv(ctx: ToolContext, ticket: Ticket | null, mode: PermissionMode): GateEnv {
    const active = this.active.get(ctx.runId);
    return {
      mode,
      runKind: ctx.runKind,
      cwd: ctx.cwd,
      signal: ctx.signal,
      // A chat leaves one-time grants to the work run they were given to (see runGrants).
      isGranted: (tool, i) =>
        !!ticket && ((ctx.runKind !== "chat" && this.store.tickets.consumeGrant(ticket.id, tool, i)) || ticket.allowedTools.includes(tool)),
      requestApproval: (tool, i, meta) => this.requestApproval(ctx, tool, i, meta),
      // A soft denial is the agent's to work around first; surfaceDenial turns the run's last
      // one into a card if the run ends stuck on it (runs that can hold a card only).
      defer:
        active && ticket && APPROVABLE_RUNS.includes(ctx.runKind)
          ? (tool, i, reason) => active.denials.push({ toolName: tool, input: i, reason })
          : undefined,
      log: (entry) => this.logPermission(ctx.session.id, ctx.runId, entry),
      context: () => ({
        ticket: ticket ? { key: ticket.key, title: ticket.title, brief: ticket.description } : null,
        transcript: this.recentTranscript(ctx.session.id),
      }),
    };
  }

  /** Transcript status entry for a permission decision (rendered as an audit row). */
  private logPermission(sessionId: string, runId: string | null, entry: PermissionDecisionLog, subagentId?: string) {
    const verb = entry.decision === "allow" ? (entry.source === "classifier" ? "Auto-approved" : "Allowed") : entry.decision === "ask" ? "Asked you" : "Denied";
    const took = entry.latencyMs !== undefined ? ` (${entry.backend ?? "classifier"}, ${(entry.latencyMs / 1000).toFixed(1)}s)` : "";
    this.append(sessionId, runId, "system", { type: "status", text: `${verb}: ${entry.summary} — ${entry.reason}${took}`, permission: entry }, subagentId);
  }

  /** The last few transcript entries as short lines, for the classifier's sense of intent. */
  private recentTranscript(sessionId: string, max = 16): string[] {
    const entries = this.store.transcript.list(sessionId).slice(-60);
    const lines: string[] = [];
    for (const e of entries) {
      const c = e.content;
      if (c.type === "text") lines.push(`[${e.role === "user" ? "human" : e.role}] ${c.text}`);
      else if (c.type === "tool_call") lines.push(`[tool_call ${c.name}] ${summarizeToolInput(c.input, 300)}`);
      else if (c.type === "tool_result") {
        const text = c.output.map((o) => (o.type === "text" ? o.text : `[${o.type}]`)).join(" ");
        lines.push(`[tool_result ${c.name}${c.isError ? " error" : ""}] ${text.replace(/\s+/g, " ").slice(0, 300)}`);
      }
    }
    return lines.slice(-max);
  }

  async declineWork(ctx: ToolContext, reason: string, title?: string): Promise<void> {
    const { session } = this.triageMeta(ctx);
    this.finishTriage(session.id, "declined", `Declined: ${reason?.trim() || "no reason given"}`, title);
  }

  /**
   * `title` (from triage) replaces the Inbox title derived from the raw output. Later dispatches
   * from the same output add to the outcome and keep the first title.
   */
  private finishTriage(sessionId: string, status: "dispatched" | "declined" | "failed", outcome: string, title?: string) {
    const prev = this.store.sessions.get(sessionId);
    if (prev?.triageStatus === "dispatched" && status === "dispatched") {
      this.store.sessions.update(sessionId, { outcome: `${prev.outcome}; ${outcome}` });
    } else {
      this.store.sessions.update(sessionId, { triageStatus: status, outcome, title: title?.trim() || undefined });
    }
    this.appendStatus(sessionId, null, outcome);
    this.touchSession(sessionId);
  }

  // =========================================================================
  // State machine internals
  // =========================================================================

  private workKind(t: Ticket): RunKind {
    return t.kind === "conductor" ? "conductor" : "work";
  }

  private isDone(key: string): boolean {
    const t = this.store.tickets.getByKey(key);
    return !t || t.status === "done"; // deleted dependencies no longer block
  }

  private depsDone(t: Ticket): boolean {
    return t.dependsOn.every((k) => this.isDone(k));
  }

  /**
   * Prepare the workdir, move to in_progress and enqueue the first work/conductor run. A worktree
   * that has gone missing (removed by the complete run of a ticket now re-opened) is recreated.
   */
  private async begin(ticket: Ticket, prompt: string, patch: TicketPatch = {}, note = "Moved to in progress") {
    this.notDraft(ticket, "started");
    if (this.starting.has(ticket.id)) return;
    this.starting.add(ticket.id);
    try {
      let workdir = ticket.workdir;
      let branch = ticket.branch;
      if (!workdir || (branch && !existsSync(workdir))) {
        branch = null;
        const project = this.store.projects.get(ticket.projectId)!;
        workdir = project.path;
        if ((ticket.useWorktree ?? project.useWorktrees) && (await isGitRepo(project.path))) {
          try {
            ({ workdir, branch } = await ensureWorktree({
              repo: project.path,
              worktreesDir: this.paths.worktreesDir,
              key: ticket.key,
              // A re-opened ticket whose worktree was removed gets its branch back.
              branch: ticket.requestedBranch ?? ticket.branch,
              base: (await this.refreshBaseBranch(ticket, project)).branch,
            }));
          } catch (err) {
            const reason = `Could not create worktree: ${errMsg(err)}`;
            this.addSummary(ticket.sessionId, ticket.id, "system", reason);
            this.transition(ticket, "blocked", { blockedReason: reason }, "Could not create worktree");
            return;
          }
        }
      }
      const fresh = this.store.tickets.get(ticket.id);
      if (!fresh) return;
      this.store.sessions.update(fresh.sessionId, { cwd: workdir });
      this.transition(fresh, "in_progress", { ...patch, workdir, branch, blockedReason: null, pendingApproval: null, reviewRejections: 0 }, note);
      this.enqueueRun(fresh.sessionId, this.workKind(fresh), prompt);
    } finally {
      this.starting.delete(ticket.id);
    }
  }

  /**
   * Change a ticket's status (plus optional fields), record a status line, and fire
   * status-change hooks: parent conductor notification and dependency scheduling.
   */
  private transition(ticket: Ticket, to: TicketStatus, patch: TicketPatch, note?: string, summary?: string): Ticket {
    const from = ticket.status;
    const t = this.store.tickets.update(ticket.id, { ...patch, status: to })!;
    this.touchSession(t.sessionId);
    if (note) this.appendStatus(t.sessionId, null, note);
    if (from !== to) {
      if (t.parentId && !(from === "planning" && to === "in_progress")) {
        this.notifyConductor(t.parentId, { key: t.key, title: t.title, from, to, summary });
      }
      if (to === "in_progress" && this.conductorBuffer.has(t.id)) queueMicrotask(() => this.flushConductor(t.id));
      if (to === "done") this.kickScheduler();
    }
    return t;
  }

  private submit(ticket: Ticket, summary: string, author: SummaryAuthor, attachments: SummaryAttachment[] = []) {
    const project = this.store.projects.get(ticket.projectId);
    const humanReview = project && !project.requireHumanReview ? "approved" : "pending";
    const agentReview = ticket.skipAgentReview ? "skipped" : "pending";
    this.addSummary(ticket.sessionId, ticket.id, author, summary, attachments);
    const t = this.transition(ticket, "review", { agentReview, humanReview, blockedReason: null }, "Moved to review", summary);
    if (agentReview === "skipped") {
      this.appendStatus(t.sessionId, null, "Agent review: skipped");
      this.noteReady(t);
    }
  }

  private requestChanges(ticket: Ticket, notes: string, by: "agent" | "human" | "conductor"): Ticket {
    const author: SummaryAuthor = by === "human" ? "human" : "agent";
    this.addSummary(ticket.sessionId, ticket.id, author, `Changes requested (${by}): ${notes.trim() || "no notes"}`);
    const t = this.transition(
      ticket,
      "in_progress",
      { agentReview: "pending", humanReview: "pending", blockedReason: null },
      `Changes requested by ${by}`,
      notes,
    );
    this.enqueueRun(t.sessionId, this.workKind(t), this.prompts().changesRequestedPrompt(notes, by));
    return this.store.tickets.get(t.id)!;
  }

  /**
   * Both reviews approved: say so, and with the project's autoComplete on start the complete run
   * right away. Conductor children wait for their conductor's complete_ticket instead.
   */
  private noteReady(t: Ticket) {
    if (t.status !== "review" || !reviewPassed(t.agentReview) || t.humanReview !== "approved") return;
    const project = this.store.projects.get(t.projectId);
    if (!project?.autoComplete || t.parentId || this.completing(t)) {
      this.appendStatus(t.sessionId, null, "Ready to complete");
      return;
    }
    this.appendStatus(t.sessionId, null, "Both reviews approved: completing automatically");
    this.track(this.enqueueComplete(t));
  }

  /**
   * Refuse to queue work behind a complete run. The work run would start after the merge, in the
   * worktree the complete run just removed, fail, and block a ticket that is already done.
   */
  private notCompleting(t: Ticket, what: string) {
    if (!this.completing(t)) return;
    throw conflict(
      `${t.key} is completing: its complete run is merging the branch and removing the worktree, so it can't be ${what} now. Once it's done, re-open it with notes if anything needs to change.`,
    );
  }

  /** A complete run is queued or running for the ticket. */
  private completing(t: Ticket): boolean {
    if (this.startingComplete.has(t.id)) return true;
    return this.queue.runningFor(t.sessionId)?.kind === "complete" || this.queue.pendingFor(t.sessionId).some((j) => j.kind === "complete");
  }

  /** Start the agent review, unless the ticket skips it (submit already marked it "skipped"). */
  private enqueueReview(t: Ticket) {
    if (t.agentReview === "skipped") return;
    this.enqueueRun(t.sessionId, "review", this.prompts().reviewPrompt(t, this.store.summaries.listBySession(t.sessionId), (a) => this.attachmentFilePath(a)));
  }

  private allChildrenDone(t: Ticket): boolean {
    return this.store.tickets.list({ parentId: t.id }).every((c) => c.status === "done");
  }

  /** Run async work in the background, tracked for idle(). Errors are logged. */
  private track(p: Promise<unknown>) {
    const tracked = p.catch((err) => this.log(`background task failed: ${errMsg(err)}`));
    this.background.add(tracked);
    tracked.finally(() => this.background.delete(tracked));
  }

  /** Kick the scheduler without awaiting it. */
  private kickScheduler() {
    this.track(this.schedule());
  }

  /** Start autoStart tickets whose dependencies are all done. */
  async schedule() {
    if (this.stopping) return;
    for (const t of this.store.tickets.list({ drafts: false })) {
      if (!t.autoStart || t.status !== "planning" || t.busy || this.starting.has(t.id)) continue;
      if (!this.depsDone(t)) continue;
      const fresh = this.store.tickets.get(t.id); // an earlier await may have started it already
      if (!fresh || fresh.draft || fresh.status !== "planning" || fresh.busy || this.starting.has(t.id)) continue;
      await this.begin(fresh, this.prompts().workStartPrompt(fresh));
    }
  }

  private notifyConductor(conductorId: string, change: ConductorChange) {
    const buf = this.conductorBuffer.get(conductorId) ?? [];
    buf.push(change);
    this.conductorBuffer.set(conductorId, buf);
    queueMicrotask(() => this.flushConductor(conductorId));
  }

  /** Enqueue one conductor run for all buffered child changes, if the conductor is free. */
  private flushConductor(conductorId: string) {
    const buf = this.conductorBuffer.get(conductorId);
    if (!buf?.length || this.stopping) return;
    const c = this.store.tickets.get(conductorId);
    if (!c) {
      this.conductorBuffer.delete(conductorId);
      return;
    }
    if (c.status !== "in_progress") return; // keep buffered until it is back in progress
    // Busy conductors are flushed from afterRun (which runs after the run left `active`).
    if ([...this.active.values()].some((a) => a.run.sessionId === c.sessionId) || this.queue.pendingFor(c.sessionId).length) return;
    this.conductorBuffer.delete(conductorId);
    this.enqueueRun(c.sessionId, this.workKind(c), this.prompts().conductorUpdatePrompt(buf));
  }

  // =========================================================================
  // Runs
  // =========================================================================

  /**
   * The model a run starts with (see resolveRunModel). Triage runs follow their watcher's models,
   * then settings.watcherModels (the watcher's current values: an edit applies to the next run).
   */
  private runModel(run: Run, session: Session, ticket: Ticket | null, project: Project | null): string | null {
    const settings = this.settings();
    if (run.kind === "triage") {
      const watcherId = this.store.sessions.getMeta<TriageMeta>(session.id)?.watcherId;
      return watcherModel(run.driver, watcherId ? this.store.watchers.get(watcherId) : null, settings);
    }
    return resolveRunModel({ driver: run.driver, kind: run.kind, ticket, project, settings });
  }

  /** skipTranscript: the prompt is already in the transcript (a steered message that fell back to the queue). */
  private enqueueRun(sessionId: string, kind: RunKind, prompt: string, lock?: string, opts: { skipTranscript?: boolean } = {}): Run {
    const session = this.store.sessions.get(sessionId)!;
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    if (ticket?.draft) throw conflict(`${ticket.key} is a draft: nothing runs on it until it's submitted`);
    const driver = ticket?.driver ?? session.driver;
    const run = this.store.runs.create({ sessionId, kind, driver, prompt });
    this.bus.emit({ kind: "run.upserted", run });
    if (!opts.skipTranscript) this.append(sessionId, run.id, "user", { type: "text", text: prompt });
    this.touchSession(sessionId);
    this.queue.enqueue({ runId: run.id, sessionId, kind, lock });
    return run;
  }

  private async execute(job: QueuedJob) {
    let run = this.store.runs.get(job.runId);
    if (!run || run.status !== "queued") return;
    const session = this.store.sessions.get(run.sessionId);
    if (!session) return;
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    const project = ticket ? this.store.projects.get(ticket.projectId) : null;
    const driver = this.drivers.get(run.driver);
    const controller = new AbortController();
    const active: ActiveRun = {
      run,
      controller,
      cancelled: false,
      submitted: false,
      decided: false,
      lastText: null,
      mcpToken: null,
      blocked: false,
      denials: [],
      calls: new Map(),
      appliedGrants: new Set(),
      offeredGrants: [],
      // From the start, so a message sent while the run gets going is waiting when the driver starts.
      input: driver?.supportsSteering && STEERABLE_RUN_KINDS.has(run.kind) ? new RunInput() : null,
      cwd: null,
    };
    this.active.set(run.id, active);
    let error: string | null;
    try {
      error = await this.drive(active, session, ticket, project, driver);
    } catch (err) {
      // Bookkeeping threw (e.g. a full disk fails every SQLite write): stop the agent, fail the run.
      controller.abort();
      error = errMsg(err);
    }
    // Messages the agent never saw wait for the next run. Closed first, so a message sent from
    // here on is queued by steerOrEnqueue rather than pushed into a run that's over.
    active.input?.close();
    const unseen = active.input?.undelivered() ?? [];

    const status = active.cancelled ? "cancelled" : error ? "failed" : "succeeded";
    try {
      run = this.store.runs.finish(run.id, status, status === "cancelled" ? null : error);
    } finally {
      // Even when the write fails, the run is over: reconcileRuns fails the row once it can.
      this.active.delete(run.id);
    }
    // Sub-agents live inside the run: whatever the driver didn't report as finished ended with it.
    for (const subagent of this.store.subagents.stopRunning(run.id)) this.bus.emit({ kind: "subagent.upserted", subagent });
    // A one-time grant is for the run it was handed to. The CLI doesn't always ask about the
    // granted call (acceptEdits runs read-only Bash itself, a retry can differ from the approved
    // input), and a grant left over would put every later run in ask mode (planGrants). A failed
    // or cancelled run may not have reached the call, so its grants carry over to the next run.
    if (status === "succeeded" && ticket && active.offeredGrants.length) this.store.tickets.dropGrants(ticket.id, active.offeredGrants);
    this.bus.emit({ kind: "run.upserted", run });
    this.appendStatus(
      session.id,
      run.id,
      status === "succeeded" ? `Run finished (${run.kind})` : status === "cancelled" ? `Run cancelled (${run.kind})` : `Run failed (${run.kind}): ${error}`,
    );
    this.touchSession(session.id);
    if (this.stopping) return;
    // Before afterRun, like a message queued during the run: pending work holds off auto-submit.
    // Cancelling drops them with the rest of the session's queue.
    if (status !== "cancelled") {
      for (const text of unseen) {
        try {
          const next = this.enqueueRun(session.id, run.kind, text, undefined, { skipTranscript: true });
          this.appendStatus(session.id, next.id, STEER_FALLBACK_STATUS);
        } catch (err) {
          this.log(`couldn't queue an undelivered message for ${session.id}: ${errMsg(err)}`);
        }
      }
    }
    try {
      await this.afterRun(run, active, error);
    } catch (err) {
      this.log(`post-run handling failed for ${run.id}: ${errMsg(err)}`);
    }
    this.kickScheduler();
  }

  /** Start the driver and consume its events; returns the run error, if any. */
  private async drive(active: ActiveRun, session: Session, ticket: Ticket | null, project: Project | null, driver: Driver | undefined): Promise<string | null> {
    const { controller } = active;
    const run = this.store.runs.markRunning(active.run.id);
    active.run = run;
    this.bus.emit({ kind: "run.upserted", run });
    const model = this.runModel(run, session, ticket, project);
    this.appendStatus(session.id, run.id, `Run started (${run.kind}${model ? ` · ${model}` : ""})`);

    let error: string | null = null;
    // A chat about a done ticket falls back to the checkout once the complete run removed the worktree.
    const workdir = run.kind === "plan" || (run.kind === "chat" && ticket?.workdir && !existsSync(ticket.workdir)) ? null : ticket?.workdir;
    const cwd = workdir ?? session.cwd ?? project?.path ?? this.paths.home;
    if (!driver) error = `Unknown driver: ${run.driver}`;
    else if (!existsSync(cwd)) error = `Working directory does not exist: ${cwd}`;
    else {
      const ctx: ToolContext = {
        runId: run.id,
        runKind: run.kind,
        session,
        ticket,
        cwd,
        ops: this.opsFacade,
        browser: this.browser,
        signal: controller.signal,
      };
      const tools = this.tools(run.kind, driver);
      const token = randomBytes(24).toString("hex");
      this.mcpRuns.set(token, { tools, ctx });
      active.mcpToken = token;
      try {
        const parent = ticket?.parentId ? this.store.tickets.get(ticket.parentId) : null;
        const children = ticket ? this.store.tickets.list({ parentId: ticket.id }) : undefined;
        const prompt = MENTION_RUN_KINDS.has(run.kind) ? await this.withMentions(session.id, run.id, run.prompt, cwd) : run.prompt;
        active.cwd = cwd;
        if (ticket) await this.refreshBaseBranch(ticket, project);
        const req: RunRequest = {
          runId: run.id,
          kind: run.kind,
          prompt,
          systemPrompt: this.prompts().systemPrompt({
            kind: run.kind,
            project,
            ticket,
            session,
            parent,
            children,
            builtinTools: driver.hasBuiltinTools,
            branches: ticket ? this.branchContext(ticket, project) : undefined,
          }),
          cwd,
          model,
          permissionMode: this.permissionModeFor(ticket, project),
          grants: this.runGrants(run.kind, ticket, project, active),
          state: run.kind === "review" ? null : this.store.sessions.getDriverState(session.id),
          tools,
          toolContext: ctx,
          mcp: { url: `${this.baseUrl().replace(/\/$/, "")}/mcp/${token}`, headers: {} },
          signal: controller.signal,
          ...(active.input ? { input: active.input } : {}),
        };
        error = await this.consume(driver.run(req), active, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) error = errMsg(err);
      } finally {
        this.mcpRuns.delete(token);
        active.mcpToken = null;
      }
    }
    return error;
  }

  /**
   * The run's prompt with the files it @-mentions attached (DESIGN.md "File mentions"). The
   * transcript keeps the prompt as written, plus a status line naming what was attached.
   */
  private async withMentions(sessionId: string, runId: string, prompt: string, cwd: string): Promise<string> {
    try {
      const a = await attachMentions(prompt, cwd);
      if (a.attached.length) this.appendStatus(sessionId, runId, `Attached ${a.attached.map((p) => `@${p}`).join(", ")}`);
      for (const s of a.skipped) this.appendStatus(sessionId, runId, `Didn't attach @${s.path}: ${s.reason}`);
      return a.prompt;
    } catch (err) {
      this.appendStatus(sessionId, runId, `Couldn't attach mentioned files: ${errMsg(err)}`);
      return prompt;
    }
  }

  /** Iterate driver events until done or aborted; returns the run error, if any. */
  private async consume(events: AsyncIterable<DriverEvent>, active: ActiveRun, signal: AbortSignal): Promise<string | null> {
    const it = events[Symbol.asyncIterator]();
    const aborted = new Promise<"abort">((resolve) => {
      if (signal.aborted) resolve("abort");
      signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    let error: string | null = null;
    for (;;) {
      const next = await Promise.race([it.next(), aborted]);
      if (next === "abort") {
        const r = it.return?.();
        if (r) r.catch(() => {});
        return error;
      }
      if (next.done) return error;
      let e: string | null;
      try {
        e = this.handleEvent(active, next.value);
      } catch (err) {
        // Recording the event failed: close the driver so its finally stops the agent process.
        const r = it.return?.();
        if (r) r.catch(() => {});
        throw err;
      }
      if (e) error = e;
    }
  }

  private handleEvent(active: ActiveRun, ev: DriverEvent): string | null {
    const { run } = active;
    switch (ev.type) {
      case "text_delta":
        this.bus.emit({ kind: "transcript.delta", sessionId: run.sessionId, runId: run.id, text: ev.text });
        return null;
      case "text":
        // A sub-agent's text is its own report to the agent, not the run's last word.
        if (ev.text.trim() && !ev.subagentId) active.lastText = ev.text;
        this.append(run.sessionId, run.id, "assistant", { type: "text", text: ev.text }, ev.subagentId);
        return null;
      case "thinking":
        this.append(run.sessionId, run.id, "assistant", { type: "thinking", text: ev.text }, ev.subagentId);
        return null;
      case "tool_call":
        active.calls.set(ev.callId, { toolName: ev.name, input: ev.input });
        this.append(run.sessionId, run.id, "assistant", { type: "tool_call", callId: ev.callId, name: ev.name, input: ev.input }, ev.subagentId);
        return null;
      case "tool_result":
        if (!ev.result.isError && active.denials.length) {
          // The denied call went through after all (e.g. the agent retried it and it was allowed).
          const call = active.calls.get(ev.callId);
          if (call) {
            const key = grantKey(call.toolName, call.input);
            active.denials = active.denials.filter((d) => grantKey(d.toolName, d.input) !== key);
          }
        }
        this.append(
          run.sessionId,
          run.id,
          "tool",
          { type: "tool_result", callId: ev.callId, name: ev.name, output: ev.result.content, isError: !!ev.result.isError },
          ev.subagentId,
        );
        return null;
      case "subagent": {
        const subagent = this.store.subagents.upsert(run.sessionId, run.id, ev.subagent);
        if (subagent) this.bus.emit({ kind: "subagent.upserted", subagent });
        return null;
      }
      case "state":
        if (run.kind !== "review") this.store.sessions.setDriverState(run.sessionId, ev.state);
        return null;
      case "usage":
        return null;
      case "status":
        this.appendStatus(run.sessionId, run.id, ev.text);
        return null;
      case "permission":
        this.logPermission(run.sessionId, run.id, ev.log, ev.subagentId);
        return null;
      case "permission_denied":
        active.denials.push({ toolName: ev.toolName, input: ev.input, reason: ev.reason });
        return null;
      case "grant_applied": {
        const ticketId = this.store.sessions.get(run.sessionId)?.ticketId;
        if (ticketId) this.store.tickets.consumeGrant(ticketId, ev.toolName, ev.input);
        active.appliedGrants.add(grantKey(ev.toolName, ev.input));
        return null;
      }
      case "error":
        this.append(run.sessionId, run.id, "system", { type: "error", text: ev.message });
        return ev.message || "Driver error";
    }
    return null;
  }

  private async afterRun(run: Run, active: ActiveRun, error: string | null) {
    const session = this.store.sessions.get(run.sessionId);
    if (!session) return;
    if (run.kind === "triage") {
      if (session.triageStatus === "triaging") {
        if (run.status === "succeeded") this.finishTriage(session.id, "failed", "Triage ended without dispatching or declining");
        else if (run.status === "failed") this.finishTriage(session.id, "failed", `Triage failed: ${error}`);
        else this.finishTriage(session.id, "failed", "Triage cancelled");
      }
      return;
    }
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    if (!ticket) return;
    if (run.status === "cancelled") return;
    if (ticket.pendingApproval) return; // waiting on a human; never auto-submit / complete / re-block
    if (run.status === "succeeded" && this.surfaceDenial(ticket, run, active)) return;
    if (run.status === "failed") {
      // A done ticket stays done: a run queued before it completed can only fail on the removed worktree.
      if (ticket.status === "done" && run.kind !== "complete") {
        this.addSummary(ticket.sessionId, ticket.id, "system", `Run failed after the ticket was done: ${error ?? "no error reported"}`);
        return;
      }
      if (run.kind === "work" || run.kind === "conductor" || run.kind === "complete") {
        this.addSummary(ticket.sessionId, ticket.id, "system", `Run failed: ${error ?? "no error reported"}`);
        this.transition(ticket, "blocked", { blockedReason: error ?? "Run failed" }, "Blocked: run failed", error ?? undefined);
      }
      return;
    }
    switch (run.kind) {
      case "work":
      case "conductor": {
        if (active.submitted) {
          if (ticket.status === "review") this.enqueueReview(ticket);
        } else if (ticket.status === "in_progress") {
          const moreWork = this.queue.pendingFor(session.id).some((j) => RUNNABLE_WORK.includes(j.kind));
          if (!moreWork && run.kind === "work" && endsWithQuestion(active.lastText)) {
            // The agent is asking the human something: block with its question instead of submitting.
            const question = active.lastText!.trim();
            this.addSummary(ticket.sessionId, ticket.id, "system", `Question: ${question}`);
            this.transition(ticket, "blocked", { blockedReason: question }, "Blocked: the agent asked a question", question);
          } else if (!moreWork && this.allChildrenDone(ticket)) {
            this.submit(ticket, active.lastText?.trim() || "Work finished.", "system");
            this.enqueueReview(this.store.tickets.get(ticket.id)!);
          }
        }
        this.flushConductor(ticket.id);
        break;
      }
      case "complete":
        if (ticket.status === "done") break;
        if (ticket.completionAction === "pr" && !active.pullRequest) {
          // The PR completion's whole result is the pull request: without one, the work hasn't landed.
          const reason = "Completion ended without opening a pull request. Check the last summary for what went wrong (gh login, push access), then complete the ticket again.";
          this.addSummary(ticket.sessionId, ticket.id, "system", reason);
          this.transition(ticket, "blocked", { blockedReason: reason }, "Blocked: no pull request");
          break;
        }
        this.transition(ticket, "done", { blockedReason: null }, "Completed");
        break;
      case "review":
        if (!active.decided && ticket.status === "review") this.appendStatus(session.id, run.id, "Agent review ended without a decision");
        break;
      case "chat":
        if (active.lastText?.trim()) this.addSummary(ticket.sessionId, ticket.id, "agent", active.lastText.trim());
        break;
      case "plan":
        break;
    }
  }

  /** HarnessOps facade handed to tools (maps conductor/triage op names onto internals). */
  private get opsFacade(): HarnessOps {
    return this._ops ?? (this._ops = this.buildOps());
  }
  private _ops: HarnessOps | null = null;

  private buildOps(): HarnessOps {
    return {
      postSummary: (c, b, a) => this.postSummary(c, b, a),
      updatePlan: (c, p, t) => this.updatePlan(c, p, t),
      block: (c, q) => this.block(c, q),
      submitForReview: (c, s, a, skip) => this.submitForReview(c, s, a, skip),
      updateBranch: (c, i) => this.updateBranch_(c, i),
      reviewDecision: (c, d, n) => this.reviewDecision(c, d, n),
      // --- board (read) ---
      listTickets: (c, f) => this.listTickets_(c, f),
      getTicket: (c, k, o) => this.getTicket_(c, k, o),
      searchTickets: (c, i) => this.searchTickets_(c, i),
      listProjects: (c) => this.listProjects_(c),
      listInbox: (c, f) => this.listInbox_(c, f),
      // --- board (write) ---
      createTicket: (c, i) => this.createTicket_(c, i),
      updateTicket: (c, k, p) => this.updateTicket_(c, k, p),
      moveTicket: (c, k, st, pos) => this.moveTicket_(c, k, st, pos),
      startTicket: (c, k) => this.startTicket_(c, k),
      messageTicket: (c, k, t) => this.messageTicket_(c, k, t),
      cancelTicket: (c, k) => this.cancelTicket_(c, k),
      reopenTicket: (c, k, n) => this.reopenTicket_(c, k, n),
      // --- conductor ---
      reviewTicket: (c, k, d, n, a) => this.reviewTicket_(c, k, d, n, a),
      completeTicket: (c, k, i, a) => this.completeTicket_(c, k, i, a),
      recordPullRequest: (c, u) => this.recordPullRequest(c, u),
      // --- triage ---
      dispatchTicket: (c, i) => this.dispatchTicket(c, i),
      declineWork: (c, r, title) => this.declineWork(c, r, title),
      requestApproval: (c, n, i, m) => this.requestApproval(c, n, i, m),
      checkPermission: (c, n, i) => this.checkPermission(c, n, i),
      fileOutputScope: (c) => this.fileOutputScope(c),
      listWatchers: (c) => this.listWatchers_(c),
      getSettings: (c) => this.getSettings_(c),
      listPrompts: async () => this.promptCatalog(),
      listDrivers: (c) => this.listDrivers_(c),
      createWatcher: (c, i, d) => this.createWatcher_(c, i, d),
      updateWatcher: (c, r, i, d) => this.updateWatcher_(c, r, i, d),
      deleteWatcher: (c, r, d) => this.deleteWatcher_(c, r, d),
      runWatcher: (c, r, d) => this.runWatcher_(c, r, d),
      createProject: (c, i, d) => this.createProject_(c, i, d),
      updateProject: (c, k, i, d) => this.updateProject_(c, k, i, d),
      deleteProject: (c, k, d) => this.deleteProject_(c, k, d),
      updateSettings: (c, p, d) => this.updateSettings_(c, p, d),
      deleteTicket: (c, k, d) => this.deleteTicket_(c, k, d),
    };
  }

  /** The HarnessOps implementation handed to tools as ctx.ops. */
  get ops(): HarnessOps {
    return this.opsFacade;
  }

  // =========================================================================
  // Persistence + event helpers
  // =========================================================================

  private append(sessionId: string, runId: string | null, role: TranscriptRole, content: TranscriptContent, subagentId?: string | null) {
    const entry = this.store.transcript.append(sessionId, runId, role, content, subagentId ?? null);
    this.bus.emit({ kind: "transcript.appended", entry });
    return entry;
  }

  private appendStatus(sessionId: string, runId: string | null, text: string) {
    return this.append(sessionId, runId, "system", { type: "status", text });
  }

  private addSummary(sessionId: string, ticketId: string | null, author: SummaryAuthor, body: string, attachments: SummaryAttachment[] = []) {
    let summary: Summary;
    try {
      summary = this.store.summaries.add({ sessionId, ticketId, author, body, attachments });
    } catch (err) {
      removeAttachmentFiles(attachments.map((a) => attachmentPath(this.paths.attachmentsDir, a)));
      throw err;
    }
    this.bus.emit({ kind: "summary.added", summary });
    return summary;
  }

  private touchSession(sessionId: string) {
    const s = this.store.sessions.get(sessionId);
    if (!s) return;
    this.bus.emit({ kind: "session.upserted", session: s });
    if (s.ticketId) this.touchTicket(s.ticketId);
  }

  private touchTicket(id: string) {
    const t = this.store.tickets.get(id);
    if (t) this.bus.emit({ kind: "ticket.upserted", ticket: t });
  }
}

export { HarnessError };
