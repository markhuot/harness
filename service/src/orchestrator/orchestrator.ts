// The orchestrator: ticket state machine, run queue/executor, scheduler, conductor
// notifications and triage. Implements HarnessOps for tools.

import { existsSync, statSync } from "node:fs";
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
  HumanReviewBody,
  ReopenBody,
  Mapping,
  Project,
  PublicSettings,
  Run,
  RunKind,
  Session,
  Settings,
  Summary,
  SummaryAuthor,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptContent,
  TranscriptRole,
  UpdateTicketBody,
  Watcher,
} from "@harness/shared";
import { checkProjectKey, isTicketKey, outputTitle, PERMISSION_MODES, resolvePermissionMode, TICKET_STATUSES } from "@harness/shared";
import type { Store } from "../store";
import { grantKey, type TicketPatch } from "../store/tickets";
import { clampLimit, CursorError, DEFAULT_PAGE_LIMIT, DEFAULT_SEARCH_LIMIT, searchSnippet } from "../store/search";
import type { WatcherInput } from "../store/watchers";
import type { EventBus } from "../events";
import type { Driver, DriverEvent, RunGrants, RunRequest } from "../drivers/types";
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
import { findKeys, matchMapping, toOutput, WatcherRunner, type WatcherOutput } from "./watchers";
import { RunQueue, type QueuedJob } from "./queue";
import { ensureWorktree, isGitRepo } from "./worktree";
import { badRequest, conflict, HarnessError, notFound } from "./errors";
import { applySettingsPatch, mergeModelMap, resolveSettings, toPublicSettings, validateModelId, validateModelMap, validateSettingsPatch } from "./settings";
import { resolveRunModel } from "./models";
import { ModelCatalog, type ModelCatalogOptions } from "../drivers/models";
import { PermissionGate } from "../permissions/gate";
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
}

interface TriageMeta {
  source: string;
  /** The watcher output being triaged */
  text: string;
  truncated?: boolean;
  /** The watcher's prompt at the time ("" → none) */
  prompt?: string;
}

/** One chunk of watcher (or injected) output on its way into triage. */
export interface IngestInput {
  /** Dedupe scope: the watcher id, or inject:<source> */
  sourceId: string;
  /** Watcher name shown to triage and on dispatched tickets */
  source: string;
  output: WatcherOutput;
  prompt: string;
  driver: string | null;
}

const RUNNABLE_WORK: RunKind[] = ["work", "conductor"];
/** Run kinds with a human in the loop for tool-permission prompts */
const APPROVABLE_RUNS: RunKind[] = ["work", "complete", "conductor"];
/** Run kinds that get the (human-gated) config tools */
const CONFIG_RUNS: RunKind[] = ["work", "conductor"];
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
  /** Fire-and-forget async work (scheduling, worktree setup) that idle() must wait for */
  private background = new Set<Promise<unknown>>();
  private modelCatalog: ModelCatalog;
  private gate: PermissionGate;
  private autoModeRules: AutoModeRulesProvider;
  private classifierOption: Classifier | null | undefined;
  private classifierCache: { key: string; classifier: Classifier } | null = null;

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
      onError: (job, err) => this.log(`run ${job.runId} crashed: ${errMsg(err)}`),
    });
    const handlers = {
      onOutput: async (w: Watcher, output: WatcherOutput) => {
        await this.ingest({ sourceId: w.id, source: w.name, output, prompt: w.prompt, driver: w.driver });
      },
      onStatus: (id: string, patch: { lastRunAt?: number; lastError?: string | null }) => {
        const w = this.store.watchers.update(id, patch);
        if (w) this.bus.emit({ kind: "watcher.upserted", watcher: w });
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
  }

  /** Runs left queued/running by a previous process become failed ("service restarted"). */
  recoverStaleRuns(): number {
    const stale = this.store.runs.listUnfinished();
    for (const run of stale) {
      if (this.active.has(run.id)) continue;
      const r = this.store.runs.finish(run.id, "failed", "service restarted");
      this.bus.emit({ kind: "run.upserted", run: r });
      this.appendStatus(run.sessionId, run.id, `Run interrupted (${run.kind}): service restarted`);
      const session = this.store.sessions.get(run.sessionId);
      if (session?.kind === "triage" && session.triageStatus === "triaging") {
        this.store.sessions.update(session.id, { triageStatus: "failed", outcome: "Interrupted: service restarted" });
      }
      this.touchSession(run.sessionId);
    }
    return stale.length;
  }

  async stop() {
    this.stopping = true;
    this.queue.pause();
    await this.watcherRunner?.stopAll().catch(() => {});
    const actives = [...this.active.values()];
    for (const a of actives) {
      a.cancelled = true;
      a.controller.abort();
    }
    await Promise.race([Promise.all(actives.map((a) => this.queue.whenSessionIdle(a.run.sessionId))), Bun.sleep(5000)]);
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

  updateSettings(body: unknown): PublicSettings {
    const patch = validateSettingsPatch(body, [...this.drivers.keys()]);
    this.store.settings.set(applySettingsPatch(this.settings(), patch));
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
      defaultModels:
        body.defaultModels !== undefined ? mergeModelMap({}, validateModelMap("defaultModels", body.defaultModels, [...this.drivers.keys()])) : {},
    };
    return { input, mode: validPermissionMode(body.permissionMode) };
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
    const { key: _key, defaultModels: modelPatch, permissionMode: _mode, ...rest } = body;
    const defaultModels =
      modelPatch !== undefined ? mergeModelMap(existing.defaultModels, validateModelMap("defaultModels", modelPatch, [...this.drivers.keys()])) : undefined;
    return { newKey, permissionMode, rest, path, defaultModels };
  }

  async deleteProject(id: string) {
    if (!this.store.projects.get(id)) throw notFound(`Unknown project: ${id}`);
    for (const t of this.store.tickets.list({ projectId: id })) await this.deleteTicket(t.key);
    for (const m of this.store.mappings.list().filter((m) => m.projectId === id)) {
      this.store.mappings.delete(m.id);
      this.bus.emit({ kind: "mapping.deleted", id: m.id });
    }
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
  searchTickets(opts: { q: string; projectId?: string; limit?: number | string | null; cursor?: string | null }): TicketPage {
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
    };
  }

  summaries(key: string): Summary[] {
    return this.store.summaries.listBySession(this.requireTicket(key).sessionId);
  }

  async createTicket(body: CreateTicketBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const project = this.store.projects.get(body.projectId);
    if (!project) throw notFound(`Unknown project: ${body.projectId}`);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim() && !body.title?.trim()) throw badRequest("prompt is required");
    const kind = body.kind ?? "task";
    if (kind !== "task" && kind !== "conductor") throw badRequest(`Invalid kind: ${kind}`);
    const driver = body.driver ?? project.defaultDriver ?? this.settings().defaultDriver;
    if (!this.drivers.has(driver)) throw badRequest(`Unknown driver: ${driver}`);
    const model = validateModelId("model", body.model);
    const permissionMode = validPermissionMode(body.permissionMode);
    const dependsOn = this.validateDeps(body.dependsOn ?? []);
    let parentId: string | null = null;
    if (body.parentId) {
      const parent = this.store.tickets.get(body.parentId) ?? this.store.tickets.getByKey(body.parentId);
      if (!parent) throw badRequest(`Unknown parent: ${body.parentId}`);
      parentId = parent.id;
    }
    let explicitKey: string | null = null;
    if (body.key) {
      explicitKey = body.key.trim().toUpperCase();
      if (!isTicketKey(explicitKey)) throw badRequest(`Invalid ticket key: ${body.key}`);
      if (this.store.tickets.keyExists(explicitKey)) throw conflict(`Ticket ${explicitKey} already exists`);
    }
    const start = body.start ?? true;
    const autoStart = body.autoStart ?? parentId !== null;
    const title = body.title?.trim() || deriveTitle(prompt);

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
      });
      this.store.sessions.update(session.id, { ticketId: t.id });
      return permissionMode ? this.store.tickets.update(t.id, { permissionMode })! : t;
    });
    const p2 = this.store.projects.get(project.id);
    if (p2) this.bus.emit({ kind: "project.upserted", project: p2 });
    this.touchSession(ticket.sessionId);
    this.appendStatus(ticket.sessionId, null, "Ticket created");

    const depsDone = this.depsDone(ticket);
    if ((start || ticket.autoStart) && depsDone) {
      await this.begin(ticket, prompt);
    } else if (start || ticket.autoStart) {
      this.appendStatus(ticket.sessionId, null, `Waiting on ${ticket.dependsOn.filter((k) => !this.isDone(k)).join(", ")}`);
    } else {
      this.enqueueRun(ticket.sessionId, "plan", prompt);
    }
    return this.store.tickets.get(ticket.id)!;
  }

  private validateDeps(keys: string[]): string[] {
    if (!Array.isArray(keys)) throw badRequest("dependsOn must be an array of ticket keys");
    const out: string[] = [];
    for (const raw of keys) {
      // Old keys (from before a project rename) are stored as the ticket's current key.
      const key = this.store.tickets.resolveKey(String(raw));
      if (!key) throw badRequest(`Unknown dependency: ${raw}`);
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  async updateTicket(key: string, body: UpdateTicketBody): Promise<Ticket> {
    let ticket = this.requireTicket(key);
    const patch: TicketPatch = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.description !== undefined) patch.description = String(body.description);
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
    if (body.dependsOn !== undefined) {
      const deps = this.validateDeps(body.dependsOn);
      if (deps.includes(ticket.key)) throw badRequest("A ticket cannot depend on itself");
      patch.dependsOn = deps;
    }
    if (body.status !== undefined && !TICKET_STATUSES.includes(body.status)) throw badRequest(`Invalid status: ${body.status}`);
    if (Object.keys(patch).length) {
      ticket = this.store.tickets.update(ticket.id, patch)!;
      if (patch.title) this.store.sessions.update(ticket.sessionId, { title: patch.title });
      this.touchSession(ticket.sessionId);
    }
    if (body.status !== undefined && body.status !== ticket.status) {
      switch (body.status) {
        case "in_progress":
          if (ticket.status === "done") await this.reopen(ticket, prompts.workStartPrompt(ticket), "Re-opened: moved to in progress");
          else await this.begin(ticket, prompts.workStartPrompt(ticket));
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

  async deleteTicket(key: string) {
    const ticket = this.requireTicket(key);
    await this.cancelSession(ticket.sessionId, true);
    for (const child of this.store.tickets.list({ parentId: ticket.id })) {
      this.store.db.query("UPDATE tickets SET parent_id = NULL WHERE id = $id").run({ id: child.id });
      this.touchTicket(child.id);
    }
    this.conductorBuffer.delete(ticket.id);
    await this.browser.close(ticket.sessionId).catch(() => {});
    this.store.transaction(() => {
      this.store.tickets.delete(ticket.id);
      this.store.sessions.delete(ticket.sessionId);
    });
    this.bus.emit({ kind: "ticket.deleted", id: ticket.id });
    this.bus.emit({ kind: "session.deleted", id: ticket.sessionId });
    this.kickScheduler();
  }

  async startTicket(key: string): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    if (ticket.status === "in_progress") throw conflict(`${ticket.key} is already in progress`);
    if (ticket.status === "done" || ticket.status === "review") throw conflict(`${ticket.key} is in ${ticket.status}; it cannot be started`);
    await this.begin(ticket, prompts.workStartPrompt(ticket));
    return this.store.tickets.get(ticket.id)!;
  }

  async sendMessage(key: string, text: string): Promise<Ticket> {
    if (typeof text !== "string" || !text.trim()) throw badRequest("text is required");
    const ticket = this.requireTicket(key);
    if (ticket.pendingApproval) return this.answerApproval(ticket.key, { decision: "deny", message: text });
    this.autoRetries.delete(ticket.id);
    this.resetRejections(ticket);
    switch (ticket.status) {
      case "planning":
        this.enqueueRun(ticket.sessionId, "plan", text);
        break;
      case "in_progress":
        this.enqueueRun(ticket.sessionId, this.workKind(ticket), text);
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

  /** Send a done ticket back to in progress with the human's notes (the done-column "request changes"). */
  async reopenTicket(key: string, body: ReopenBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    if (ticket.status !== "done") throw conflict(`${ticket.key} is not done; only done tickets can be re-opened`);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    if (!notes) throw badRequest("notes are required");
    this.addSummary(ticket.sessionId, ticket.id, "human", `Re-opened: ${notes}`);
    return this.reopen(ticket, prompts.reopenPrompt(ticket, notes), "Re-opened by human");
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
    return this.applyReview(ticket, body.decision, body.notes ?? "", "human");
  }

  private resetRejections(ticket: Ticket) {
    if (this.store.tickets.reviewRejections(ticket.id) !== 0) this.store.tickets.update(ticket.id, { reviewRejections: 0 });
  }

  /** Answer the ticket's pending tool-permission request and resume the agent. */
  async answerApproval(key: string, body: ApprovalBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
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

  private applyReview(ticket: Ticket, decision: "approve" | "request_changes", notes: string, by: "human" | "conductor"): Ticket {
    if (ticket.status !== "review") throw conflict(`${ticket.key} is not in review`);
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
    return this.requestChanges(ticket, notes, by);
  }

  async completeTicket(key: string, body: CompleteBody = {}): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    if (ticket.status === "done") throw conflict(`${ticket.key} is already done`);
    if (body.skipAgent) {
      this.transition(ticket, "done", { blockedReason: null }, "Marked done");
      return this.store.tickets.get(ticket.id)!;
    }
    if (ticket.status !== "review") throw conflict(`${ticket.key} must be in review to complete`);
    if (this.completing(ticket)) throw conflict(`${ticket.key} is already completing`);
    this.appendStatus(ticket.sessionId, null, "Completing");
    this.enqueueRun(ticket.sessionId, "complete", prompts.completePrompt(ticket, body.instructions));
    return this.store.tickets.get(ticket.id)!;
  }

  rerunAgentReview(key: string): Ticket {
    const ticket = this.requireTicket(key);
    if (ticket.status !== "review") throw conflict(`${ticket.key} is not in review`);
    const t = this.store.tickets.update(ticket.id, { agentReview: "pending" })!;
    this.enqueueReview(t);
    return this.store.tickets.get(ticket.id)!;
  }

  async cancelTicket(key: string): Promise<Ticket> {
    const ticket = this.requireTicket(key);
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

  transcript(sessionId: string, after = 0) {
    this.getSession(sessionId);
    return this.store.transcript.list(sessionId, after);
  }

  // =========================================================================
  // Watchers, mappings, triage
  // =========================================================================

  listWatchers() {
    return this.store.watchers.list();
  }

  createWatcher(body: WatcherInput & { name: string; command: string }): Watcher {
    const input = this.validateWatcher(body, true) as WatcherInput & { name: string; command: string };
    const w = this.store.watchers.create(input);
    this.bus.emit({ kind: "watcher.upserted", watcher: w });
    this.syncWatchers();
    return w;
  }

  updateWatcher(id: string, body: WatcherInput): Watcher {
    if (!this.store.watchers.get(id)) throw notFound(`Unknown watcher: ${id}`);
    const w = this.store.watchers.update(id, this.validateWatcher(body, false))!;
    this.bus.emit({ kind: "watcher.upserted", watcher: w });
    this.syncWatchers();
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

  private validateWatcher(body: WatcherInput, creating: boolean): WatcherInput {
    if (!body || typeof body !== "object") throw badRequest("body is required");
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
    return out;
  }

  syncWatchers() {
    this.watcherRunner?.sync(this.store.watchers.list());
  }

  listMappings() {
    return this.store.mappings.list();
  }

  createMapping(body: { pattern: string; projectId: string; notes?: string }): Mapping {
    const m = this.store.mappings.create(this.validateMapping(body));
    this.bus.emit({ kind: "mapping.upserted", mapping: m });
    return m;
  }

  private validateMapping(body: { pattern: string; projectId: string; notes?: string }) {
    if (!body || typeof body.pattern !== "string" || !body.pattern.trim()) throw badRequest("pattern is required");
    const pattern = body.pattern.trim();
    const rx = /^\/(.+)\/([a-z]*)$/.exec(pattern);
    if (rx) {
      try {
        new RegExp(rx[1]!, rx[2]);
      } catch (err) {
        throw badRequest(`Invalid regex: ${errMsg(err)}`);
      }
    }
    if (!this.store.projects.get(body.projectId)) throw badRequest(`Unknown project: ${body.projectId}`);
    return { pattern, projectId: body.projectId, notes: body.notes };
  }

  deleteMapping(id: string) {
    if (!this.store.mappings.get(id)) throw notFound(`Unknown mapping: ${id}`);
    this.store.mappings.delete(id);
    this.bus.emit({ kind: "mapping.deleted", id });
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
    const { source, output, prompt, driver } = input;
    const projects = this.store.projects.list();
    const mappings = this.store.mappings.list();
    const keys = findKeys(output.text);
    // Routing hints: keys in the output that a mapping points at a project.
    const hints = keys.flatMap((key) => {
      const mapping = matchMapping(key, mappings);
      const project = mapping ? projects.find((p) => p.id === mapping.projectId) : undefined;
      return mapping && project ? [{ key, mapping, project }] : [];
    });
    const existingTickets = keys.flatMap((key) => {
      const t = this.store.tickets.getByKey(key);
      return t ? [t] : [];
    });
    const title = outputTitle(output.text);
    const n = this.store.counters.next("triage");
    const session = this.store.sessions.create({
      key: `TRIAGE-${n}`,
      kind: "triage",
      ticketId: null,
      driver: driver ?? this.settings().defaultDriver,
      cwd: hints[0]?.project.path ?? this.paths.home,
      title,
      triageStatus: "triaging",
      meta: { source, text: output.text, truncated: output.truncated, prompt } satisfies TriageMeta,
    });
    this.touchSession(session.id);
    this.appendStatus(session.id, null, `New output from ${source}`);
    this.enqueueRun(
      session.id,
      "triage",
      prompts.triagePrompt({ source, title, text: output.text, truncated: output.truncated, prompt, hints, projects, mappings, existingTickets }),
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

  async postSummary(ctx: ToolContext, body: string): Promise<void> {
    if (!body?.trim()) throw new Error("summary is empty");
    this.addSummary(ctx.session.id, ctx.ticket?.id ?? null, "agent", body.trim());
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

  async submitForReview(ctx: ToolContext, summary: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (t.status !== "in_progress") throw new Error(`${t.key} is ${t.status}, not in progress`);
    this.submit(t, summary?.trim() || "Work submitted for review.", "agent");
    const a = this.ctxActive(ctx);
    if (a) a.submitted = true;
    else this.enqueueReview(this.store.tickets.get(t.id)!); // tool called outside the tracked run
  }

  async reviewDecision(ctx: ToolContext, decision: "approve" | "request_changes", notes: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (ctx.runKind !== "review") throw new Error("review_decision is only available in review runs");
    if (t.status !== "review") throw new Error(`${t.key} is no longer in review`);
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
    const scope: BoardScope = filter.scope ?? (filter.projectKey ? "project" : own?.kind === "conductor" ? "children" : own ? "project" : "all");
    const statuses = filter.statuses?.length ? filter.statuses : undefined;
    const bad = statuses?.find((st) => !(TICKET_STATUSES as readonly string[]).includes(st));
    if (bad) throw new Error(`Unknown status: ${bad}`);
    let tickets: Ticket[];
    if (scope === "children") {
      if (!own) throw new Error('scope "children" needs a ticket run; use "project" with project_key, or "all"');
      const projectId = filter.projectKey ? this.boardProject(filter.projectKey).id : undefined;
      tickets = this.store.tickets.list({ parentId: own.id, ...(projectId ? { projectId } : {}), ...(statuses ? { statuses } : {}) });
    } else if (scope === "project") {
      const projectId = filter.projectKey ? this.boardProject(filter.projectKey).id : own?.projectId;
      if (!projectId) throw new Error('project_key is required for scope "project" in a run without a ticket');
      tickets = this.store.tickets.list({ projectId, ...(statuses ? { statuses } : {}) });
    } else if (scope === "all") {
      if (filter.projectKey) throw new Error('scope "all" spans every project; drop project_key or use scope "project"');
      tickets = this.store.tickets.list(statuses ? { statuses } : {});
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
    const found = this.store.tickets.lookup(key);
    if (!found) throw new Error(`Unknown ticket: ${key}`);
    const t = found.ticket;
    const detail: BoardTicketDetail = {
      ticket: this.boardTicket(t),
      resolvedFrom: found.alias,
      parent: t.parentId ? (this.store.tickets.get(t.parentId)?.key ?? null) : null,
      children: this.store.tickets.list({ parentId: t.id }).map((c) => c.key),
      summaries: this.store.summaries.listBySession(t.sessionId).map((s) => ({ author: s.author, body: s.body, createdAt: s.createdAt })),
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
      page = this.searchTickets({ q: input.query, projectId, limit: input.limit ?? BOARD_SEARCH_LIMIT, cursor: input.cursor ?? null });
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

  // --- board (write): work and conductor runs; the HTTP API's code paths plus guard rails ---

  /** The caller's ticket, for a run kind that may change the board. */
  private boardActor(ctx: ToolContext, tool: string): Ticket {
    if (ctx.runKind !== "work" && ctx.runKind !== "conductor") throw new Error(`${tool} is only available in work and conductor runs`);
    return this.ctxTicket(ctx);
  }

  /** Another ticket the caller may act on: never its own (block / submit_for_review cover that). */
  private boardTarget(ctx: ToolContext, key: string, tool: string): { actor: Ticket; target: Ticket } {
    const actor = this.boardActor(ctx, tool);
    const target = this.store.tickets.lookup(String(key ?? "").trim())?.ticket;
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
    if (ctx.runKind === "conductor" && own.kind === "conductor") {
      // A conductor's tickets are its children, on its driver/model unless it picks another.
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
      const column = this.store.tickets.list({ projectId: target.projectId, statuses: [status] }).filter((t) => t.id !== target.id);
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

  private conductorOf(ctx: ToolContext): Ticket {
    const c = this.ctxTicket(ctx);
    if (c.kind !== "conductor") throw new Error("Only conductor tickets can review or complete other tickets");
    return c;
  }

  private childOf(conductor: Ticket, key: string): Ticket {
    const t = this.store.tickets.getByKey(key);
    if (!t) throw new Error(`Unknown ticket: ${key}`);
    if (t.parentId !== conductor.id) throw new Error(`${t.key} is not a child of ${conductor.key}`);
    return t;
  }

  async reviewTicket_(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string): Promise<Ticket> {
    const child = this.childOf(this.conductorOf(ctx), key);
    try {
      return this.applyReview(child, decision, notes ?? "", "conductor");
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  async completeTicket_(ctx: ToolContext, key: string, instructions?: string): Promise<Ticket> {
    const child = this.childOf(this.conductorOf(ctx), key);
    if (child.status !== "review" || child.agentReview !== "approved" || child.humanReview !== "approved") {
      throw new Error(`${child.key} is not ready: both reviews must be approved first`);
    }
    return this.completeTicket(child.key, { instructions });
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
    const existing = key ? this.store.tickets.getByKey(key) : null;
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

  async listMappings_(_ctx: ToolContext) {
    return this.listMappings().map((m) => ({ ...m, projectKey: this.store.projects.get(m.projectId)?.key ?? null }));
  }

  async getSettings_(_ctx: ToolContext): Promise<PublicSettings> {
    return this.publicSettings();
  }

  async listDrivers_(_ctx: ToolContext) {
    const infos = await this.driverInfos();
    return Promise.all(infos.map(async (info) => ({ ...info, models: await this.listModels(info.id) })));
  }

  async createWatcher_(ctx: ToolContext, input: WatcherInput & { name: string; command: string }, dryRun = false): Promise<Watcher | null> {
    this.configWriter(ctx);
    return this.asToolError(() => {
      if (dryRun) return (this.validateWatcher(input, true), null);
      const w = this.createWatcher(input);
      this.log(`watcher "${w.name}" created by ${ctx.ticket!.key}`);
      return w;
    });
  }

  async updateWatcher_(ctx: ToolContext, ref: string, input: WatcherInput, dryRun = false): Promise<Watcher | null> {
    this.configWriter(ctx);
    const w = this.watcherByRef(ref);
    const body: WatcherInput = { ...input };
    if (input.env !== undefined) {
      // Tools merge env (a model never sees the stored values): "" removes a variable.
      const env = { ...w.env };
      for (const [k, v] of Object.entries(input.env ?? {})) {
        if (v === "" || v === null) delete env[k];
        else env[k] = v;
      }
      body.env = env;
    }
    return this.asToolError(() => (dryRun ? (this.validateWatcher(body, false), null) : this.updateWatcher(w.id, body)));
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

  async createMapping_(ctx: ToolContext, input: { pattern: string; projectKey: string; notes?: string }, dryRun = false): Promise<Mapping | null> {
    this.configWriter(ctx);
    const body = { pattern: input.pattern, projectId: this.projectByKey(input.projectKey).id, notes: input.notes };
    return this.asToolError(() => (dryRun ? (this.validateMapping(body), null) : this.createMapping(body)));
  }

  async deleteMapping_(ctx: ToolContext, id: string, dryRun = false): Promise<Mapping> {
    this.configWriter(ctx);
    const m = this.store.mappings.get(id);
    if (!m) throw new Error(`Unknown mapping: ${id}. Use list_mappings.`);
    if (!dryRun) this.deleteMapping(id);
    return m;
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
      if (dryRun) return (validateSettingsPatch(patch, [...this.drivers.keys()]), this.publicSettings());
      return this.updateSettings(patch);
    });
  }

  async deleteTicket_(ctx: ToolContext, key: string, dryRun = false): Promise<Ticket> {
    const own = this.configWriter(ctx);
    const t = this.store.tickets.getByKey(String(key ?? "").trim().toUpperCase());
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

  /** RunRequest.grants: human grants for runs that act for the ticket (not review/plan/triage, not read_only). */
  private runGrants(kind: RunKind, ticket: Ticket | null, project: Project | null, active: ActiveRun): RunGrants | undefined {
    if (!ticket || !APPROVABLE_RUNS.includes(kind)) return undefined;
    if (this.permissionModeFor(ticket, project) === "read_only") return undefined;
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
   * call without asking (Claude Code's auto-mode classifier) and the call never went through.
   * The run's last such denial becomes a pending approval: attached to the agent's block if it
   * blocked; if it submitted anyway (it usually does, reporting the denial), the ticket goes from
   * review to blocked instead of starting a review of work that couldn't be done.
   * A denial of a tool the human already allows on the ticket is retried with the exact call
   * pre-approved instead (bounded by MAX_AUTO_RETRIES). Returns true when it handled the run.
   */
  private surfaceDenial(ticket: Ticket, run: Run, active: ActiveRun): boolean {
    const denial = active.denials.at(-1);
    if (!denial || !APPROVABLE_RUNS.includes(run.kind)) return false;
    const t = this.store.tickets.get(ticket.id);
    if (!t || t.pendingApproval || this.permissionModeFor(t) === "read_only") return false;
    if (t.status !== "in_progress" && t.status !== "blocked" && !(t.status === "review" && (run.kind === "complete" || active.submitted))) return false;
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

  /** HarnessOps.checkPermission: run a native tool call through the PermissionGate. */
  async checkPermission(ctx: ToolContext, toolName: string, input: unknown): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const ticket = ctx.ticket ? this.store.tickets.get(ctx.ticket.id) : null;
    // Plan runs are read-only for every driver (claude-code runs them in --permission-mode plan).
    const mode: PermissionMode = ctx.runKind === "plan" || ctx.runKind === "triage" ? "read_only" : this.permissionModeFor(ticket);
    return this.gate.check(toolName, input, {
      mode,
      runKind: ctx.runKind,
      cwd: ctx.cwd,
      signal: ctx.signal,
      isGranted: (tool, i) => !!ticket && (this.store.tickets.consumeGrant(ticket.id, tool, i) || ticket.allowedTools.includes(tool)),
      requestApproval: (tool, i, meta) => this.requestApproval(ctx, tool, i, meta),
      log: (entry) => this.logPermission(ctx.session.id, ctx.runId, entry),
      context: () => ({
        ticket: ticket ? { key: ticket.key, title: ticket.title, brief: ticket.description } : null,
        transcript: this.recentTranscript(ctx.session.id),
      }),
    });
  }

  /** Transcript status entry for a permission decision (rendered as an audit row). */
  private logPermission(sessionId: string, runId: string | null, entry: PermissionDecisionLog) {
    const verb = entry.decision === "allow" ? (entry.source === "classifier" ? "Auto-approved" : "Allowed") : entry.decision === "ask" ? "Asked you" : "Denied";
    const took = entry.latencyMs !== undefined ? ` (${entry.backend ?? "classifier"}, ${(entry.latencyMs / 1000).toFixed(1)}s)` : "";
    this.append(sessionId, runId, "system", { type: "status", text: `${verb}: ${entry.summary} — ${entry.reason}${took}`, permission: entry });
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
    if (this.starting.has(ticket.id)) return;
    this.starting.add(ticket.id);
    try {
      let workdir = ticket.workdir;
      let branch = ticket.branch;
      if (!workdir || (branch && !existsSync(workdir))) {
        branch = null;
        const project = this.store.projects.get(ticket.projectId)!;
        workdir = project.path;
        if (project.useWorktrees && (await isGitRepo(project.path))) {
          try {
            ({ workdir, branch } = await ensureWorktree({ repo: project.path, worktreesDir: this.paths.worktreesDir, key: ticket.key }));
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
      if (t.kind === "conductor" && to === "in_progress") queueMicrotask(() => this.flushConductor(t.id));
      if (to === "done") this.kickScheduler();
    }
    return t;
  }

  private submit(ticket: Ticket, summary: string, author: SummaryAuthor) {
    const project = this.store.projects.get(ticket.projectId);
    const humanReview = project && !project.requireHumanReview ? "approved" : "pending";
    this.addSummary(ticket.sessionId, ticket.id, author, summary);
    this.transition(ticket, "review", { agentReview: "pending", humanReview, blockedReason: null }, "Moved to review", summary);
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
    this.enqueueRun(t.sessionId, this.workKind(t), prompts.changesRequestedPrompt(notes, by));
    return this.store.tickets.get(t.id)!;
  }

  /**
   * Both reviews approved: say so, and with the project's autoComplete on start the complete run
   * right away. Conductor children wait for their conductor's complete_ticket instead.
   */
  private noteReady(t: Ticket) {
    if (t.status !== "review" || t.agentReview !== "approved" || t.humanReview !== "approved") return;
    const project = this.store.projects.get(t.projectId);
    if (!project?.autoComplete || t.parentId || this.completing(t)) {
      this.appendStatus(t.sessionId, null, "Ready to complete");
      return;
    }
    this.appendStatus(t.sessionId, null, "Both reviews approved: completing automatically");
    this.enqueueRun(t.sessionId, "complete", prompts.completePrompt(t));
  }

  /** A complete run is queued or running for the ticket. */
  private completing(t: Ticket): boolean {
    return this.queue.runningFor(t.sessionId)?.kind === "complete" || this.queue.pendingFor(t.sessionId).some((j) => j.kind === "complete");
  }

  private enqueueReview(t: Ticket) {
    this.enqueueRun(t.sessionId, "review", prompts.reviewPrompt(t, this.store.summaries.listBySession(t.sessionId)));
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
    for (const t of this.store.tickets.list()) {
      if (!t.autoStart || t.status !== "planning" || t.busy || this.starting.has(t.id)) continue;
      if (!this.depsDone(t)) continue;
      const fresh = this.store.tickets.get(t.id); // an earlier await may have started it already
      if (!fresh || fresh.status !== "planning" || fresh.busy || this.starting.has(t.id)) continue;
      await this.begin(fresh, prompts.workStartPrompt(fresh));
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
    this.enqueueRun(c.sessionId, "conductor", prompts.conductorUpdatePrompt(buf));
  }

  // =========================================================================
  // Runs
  // =========================================================================

  private enqueueRun(sessionId: string, kind: RunKind, prompt: string): Run {
    const session = this.store.sessions.get(sessionId)!;
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    const driver = ticket?.driver ?? session.driver;
    const run = this.store.runs.create({ sessionId, kind, driver, prompt });
    this.bus.emit({ kind: "run.upserted", run });
    this.append(sessionId, run.id, "user", { type: "text", text: prompt });
    this.touchSession(sessionId);
    this.queue.enqueue({ runId: run.id, sessionId, kind });
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
    };
    this.active.set(run.id, active);
    run = this.store.runs.markRunning(run.id);
    active.run = run;
    this.bus.emit({ kind: "run.upserted", run });
    const model = resolveRunModel({ driver: run.driver, kind: run.kind, ticket, project, settings: this.settings() });
    this.appendStatus(session.id, run.id, `Run started (${run.kind}${model ? ` · ${model}` : ""})`);

    let error: string | null = null;
    const cwd = (run.kind === "plan" ? null : ticket?.workdir) ?? session.cwd ?? project?.path ?? this.paths.home;
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
        const children = ticket?.kind === "conductor" ? this.store.tickets.list({ parentId: ticket.id }) : undefined;
        const req: RunRequest = {
          runId: run.id,
          kind: run.kind,
          prompt: run.prompt,
          systemPrompt: prompts.systemPrompt({ kind: run.kind, project, ticket, session, parent, children, builtinTools: driver.hasBuiltinTools }),
          cwd,
          model,
          permissionMode: this.permissionModeFor(ticket, project),
          grants: this.runGrants(run.kind, ticket, project, active),
          state: run.kind === "review" ? null : this.store.sessions.getDriverState(session.id),
          tools,
          toolContext: ctx,
          mcp: { url: `${this.baseUrl().replace(/\/$/, "")}/mcp/${token}`, headers: {} },
          signal: controller.signal,
        };
        error = await this.consume(driver.run(req), active, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) error = errMsg(err);
      } finally {
        this.mcpRuns.delete(token);
        active.mcpToken = null;
      }
    }

    const status = active.cancelled ? "cancelled" : error ? "failed" : "succeeded";
    run = this.store.runs.finish(run.id, status, status === "cancelled" ? null : error);
    this.active.delete(run.id);
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
    try {
      await this.afterRun(run, active, error);
    } catch (err) {
      this.log(`post-run handling failed for ${run.id}: ${errMsg(err)}`);
    }
    this.kickScheduler();
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
      const e = this.handleEvent(active, next.value);
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
        if (ev.text.trim()) active.lastText = ev.text;
        this.append(run.sessionId, run.id, "assistant", { type: "text", text: ev.text });
        return null;
      case "thinking":
        this.append(run.sessionId, run.id, "assistant", { type: "thinking", text: ev.text });
        return null;
      case "tool_call":
        active.calls.set(ev.callId, { toolName: ev.name, input: ev.input });
        this.append(run.sessionId, run.id, "assistant", { type: "tool_call", callId: ev.callId, name: ev.name, input: ev.input });
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
        this.append(run.sessionId, run.id, "tool", {
          type: "tool_result",
          callId: ev.callId,
          name: ev.name,
          output: ev.result.content,
          isError: !!ev.result.isError,
        });
        return null;
      case "state":
        if (run.kind !== "review") this.store.sessions.setDriverState(run.sessionId, ev.state);
        return null;
      case "usage":
        return null;
      case "status":
        this.appendStatus(run.sessionId, run.id, ev.text);
        return null;
      case "permission":
        this.logPermission(run.sessionId, run.id, ev.log);
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
          } else if (!moreWork && (run.kind === "work" || this.allChildrenDone(ticket))) {
            this.submit(ticket, active.lastText?.trim() || "Work finished.", "system");
            this.enqueueReview(this.store.tickets.get(ticket.id)!);
          }
        }
        if (run.kind === "conductor") this.flushConductor(ticket.id);
        break;
      }
      case "complete":
        if (ticket.status !== "done") this.transition(ticket, "done", { blockedReason: null }, "Completed");
        break;
      case "review":
        if (!active.decided && ticket.status === "review") this.appendStatus(session.id, run.id, "Agent review ended without a decision");
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
      postSummary: (c, b) => this.postSummary(c, b),
      updatePlan: (c, p, t) => this.updatePlan(c, p, t),
      block: (c, q) => this.block(c, q),
      submitForReview: (c, s) => this.submitForReview(c, s),
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
      reviewTicket: (c, k, d, n) => this.reviewTicket_(c, k, d, n),
      completeTicket: (c, k, i) => this.completeTicket_(c, k, i),
      // --- triage ---
      dispatchTicket: (c, i) => this.dispatchTicket(c, i),
      declineWork: (c, r, title) => this.declineWork(c, r, title),
      requestApproval: (c, n, i, m) => this.requestApproval(c, n, i, m),
      checkPermission: (c, n, i) => this.checkPermission(c, n, i),
      listWatchers: (c) => this.listWatchers_(c),
      listMappings: (c) => this.listMappings_(c),
      getSettings: (c) => this.getSettings_(c),
      listDrivers: (c) => this.listDrivers_(c),
      createWatcher: (c, i, d) => this.createWatcher_(c, i, d),
      updateWatcher: (c, r, i, d) => this.updateWatcher_(c, r, i, d),
      deleteWatcher: (c, r, d) => this.deleteWatcher_(c, r, d),
      runWatcher: (c, r, d) => this.runWatcher_(c, r, d),
      createMapping: (c, i, d) => this.createMapping_(c, i, d),
      deleteMapping: (c, id, d) => this.deleteMapping_(c, id, d),
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

  private append(sessionId: string, runId: string | null, role: TranscriptRole, content: TranscriptContent) {
    const entry = this.store.transcript.append(sessionId, runId, role, content);
    this.bus.emit({ kind: "transcript.appended", entry });
    return entry;
  }

  private appendStatus(sessionId: string, runId: string | null, text: string) {
    return this.append(sessionId, runId, "system", { type: "status", text });
  }

  private addSummary(sessionId: string, ticketId: string | null, author: SummaryAuthor, body: string) {
    const summary = this.store.summaries.add({ sessionId, ticketId, author, body });
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
