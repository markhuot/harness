// The orchestrator: ticket state machine, run queue/executor, scheduler, conductor
// notifications and the chief of staff. Implements HarnessOps for tools.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fetchPullRequestTitle, PULL_REQUEST_URL } from "../pull-requests";

/** gh processes that run at once for pull request titles, across all tickets */
const TITLE_FETCH_SLOTS = 4;
import type {
  Subagent,
  PhaseModels,
  TaskOutput,
  ApprovalBody,
  CompleteBody,
  PendingApproval,
  PermissionDecisionLog,
  PermissionMode,
  CreateProjectBody,
  CreateTicketBody,
  DriverInfo,
  ExternalRef,
  ExternalRefInput,
  FileDiff,
  FileWriteResult,
  FileMatch,
  CommandMatch,
  FileView,
  HumanReviewBody,
  ReopenBody,
  UnblockBody,
  Project,
  PublicSettings,
  RelatedTicket,
  RemoteKeyMatches,
  Run,
  RunKind,
  Session,
  Settings,
  ActivityAuthor,
  ActivityEntry,
  ActivityKind,
  ActivityMeta,
  Attachment,
  SpecConflict,
  SpecDiff,
  SpecRevision,
  SpecRevisionAuthor,
  SpecRevisionInfo,
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
  Group,
} from "@harness/shared";
import { mapPaneRefs, type PaneArrangeResult, type PaneOp, type TerminalInfo } from "@harness/shared";
import type { MacRequests } from "../api/mac-requests";
import type { BaseBranchSource, BranchInfo, CompletionAction, PhaseChoice, MessageDraft, MessageDraftBody, PlanUsageReport, PromptEntry, SessionActionBody } from "@harness/shared";
import {
  checkProjectKey,
  COMPLETION_ACTIONS,
  completionOptions,
  isCompletionAction,
  isConductor,
  isTicketKey,
  normalizeProjectColor,
  normalizeProjectGroup,
  managingConductor,
  offeredCompletionActions,
  outputTitle,
  parentLandingBranch,
  PERMISSION_MODES,
  PROJECT_COLORS,
  PROJECT_GROUP_MAX,
  resolveBaseBranch,
  resolveCompletionAction,
  resolvePermissionMode,
  reviewPassed,
  PROMPT_IDS,
  rankCommands,
  TICKET_STATUSES,
  adviserFor,
  applyLegacyProject,
  mergePhaseModels,
  resolvePhaseChoice,
  runPhase,
  ticketLegacyChoice,
  withLegacyChoice,
} from "@harness/shared";
import { ScopedStore, SpecConflictError, type GroupRepo, type Store } from "../store";
import {
  COS_EVENT_STATUSES,
  HAIKU_MODELS,
  cosScopeKey,
  parseCosScopeKey,
  resolveCosSetting,
  type Cos,
  type CosBadge,
  type CosChatPage,
  type CosEvent,
  type CosEventPage,
  type CosEventStatus,
  type CosScope,
} from "@harness/shared";
import { GroupNameTaken } from "../store/projects";

/** A group a request names, before it is resolved: an existing id, a name to find or make, or null for none. */
type GroupRef = { id: string } | { name: string } | null;
import { canonicalJson, grantKey, type TicketPatch } from "../store/tickets";
import { cachedPullRequestTarget, insideGitCheckout } from "../store/projects";
import { pushRemote } from "../store/remotes";
import { clampLimit, CursorError, DEFAULT_PAGE_LIMIT, DEFAULT_SEARCH_LIMIT, searchSnippet } from "../store/search";
import type { WatcherInput } from "../store/watchers";
import type { EventBus } from "../events";
import { RunInput, type Driver, type DriverEvent, type RunGrants, type RunRequest, type SentMessage } from "../drivers/types";
import type {
  ApprovalMeta,
  BoardAgent,
  BoardAgentDetail,
  BoardListFilter,
  BoardScope,
  BoardRelatedTicket,
  BoardTicket,
  BoardTicketDetail,
  BoardTranscriptEntry,
  CreateTicketInput,
  HarnessOps,
  InboxItem,
  ProjectView,
  ReviewSkips,
  UpdateTicketInput,
  TerminalView,
  ToolContext,
  ToolDefinition,
} from "../tools/types";
import { RemoteIdError, truncateMiddle } from "../tools/util";
import type { BrowserService } from "../browser/types";
import type { HarnessPaths } from "../config";
import { GATED_TOOL_NAMES, stopBrowserJobs, toolsForRun } from "../tools/index";
import { isTask, positionForDrop } from "@harness/shared/state";
import * as prompts from "./prompts";
import { PROMPTS, promptTemplateError } from "./prompt-templates";
import { toOutput, WatcherRunner, type WatcherOutput } from "./watchers";
import { RunQueue, type QueuedJob } from "./queue";
import {
  branchExists,
  branchForKey,
  checkedOutElsewhere,
  commitsNotIn,
  currentBranch,
  ensureWorktree,
  git,
  headCommit,
  hasChangesToLand,
  isAncestor,
  isGitRepo,
  isInside,
  realPath,
  listBranches,
  switchBranch,
} from "./worktree";
import { readFileDiff, readFileView, writeFileContents } from "./file-view";
import { attachMentions, searchPaths, type SearchOptions } from "./files";
import { compactNotes } from "../annotations";
import { attachmentFile as fileOf, ORPHAN_UPLOAD_AGE_MS, registerFile, removeUploadDirs, resolveAttachments, runAttachments, storeUpload, sweepUploads, uploadDirs, type RunImage } from "../attachment-lists";
import { badRequest, conflict, HarnessError, notFound } from "./errors";
import { nextFire, specFromInput, validateSpec } from "../cos/schedule-time";
import { SCHEDULE_MAX_ACTIVE, type CosMemory, type MemoryConflict, type Schedule } from "@harness/shared";
import { checkMemory, MemoryError, memoryRevision, replaceMemorySection } from "../cos/memory";
import {
  applySettingsPatch,
  LEGACY_MODEL_KEYS,
  mergeModelMap,
  resolveSettings,
  toPublicSettings,
  validateBranchName,
  validateModelId,
  validateCosModel,
  validateModelMap,
  validatePhaseModels,
  validateSettingsPatch,
} from "./settings";
import { resolveRunChoice, resolveRunModel } from "./models";
import { prepareAttachments, removeAttachmentFiles, storeAttachments } from "../attachments";
import { activityLine } from "../activity";
import { applySpecEdits, localImageSources, numberLines, rewriteImageSources, SpecEditError, unifiedDiff } from "../spec";
import { confineOutputPath, readSnapshot, readTaskOutput, snapshotTaskOutput, unavailable } from "../task-output";
import { ModelCatalog, type ModelCatalogOptions } from "../drivers/models";
import { CommandCatalog, type CommandCatalogOptions } from "../drivers/commands";
import { PermissionGate, type GateEnv } from "../permissions/gate";
import { AnthropicApiClassifier, ClaudeCliClassifier, type Classifier } from "../permissions/classifier";
import { AutoModeRulesProvider } from "../permissions/rules";
import { anthropicStructured, claudeCliStructured } from "../permissions/structured";
import { CosEngine, wire as wireCosEvent, type Timers as CosTimers } from "../cos/engine";
import { cosChat, isSilentReply, WAKE_PROMPT_PREFIX } from "../cos/chat";
import { AgentTriage, LlmTriage, parseTriage, TriageIncomplete, type AgentTriageRequest, type AgentTriageRun, type CosTriage, type TriageVerdict } from "../cos/triage";
import { triageDecision } from "../permissions/triage";
import { claudeCliEnv, resolveClaudeBin } from "../drivers/claude-code";
import { DEFAULT_ANTHROPIC_MODEL } from "../drivers/anthropic-api";
import { clockTime, isUsageLimit, usageLimitResumeAt } from "./usage-limit";
import { applyCall, compactedContext } from "./context-usage";
import { PlanUsageTracker, POLL_MS } from "./plan-usage";

export interface ConductorChange {
  key: string;
  title: string;
  from: TicketStatus;
  to: TicketStatus;
  /** What came with the change: the child's submit note, review notes, its question */
  note?: string;
  /** The child's spec revision at the time */
  specRevision?: number;
}

/** Who writes a spec revision: the human (PATCH), the service, or an agent's run. */
export interface SpecAuthorship {
  author: SpecRevisionAuthor;
  runId?: string | null;
  runKind?: RunKind | null;
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
  tools?: (kind: RunKind, driver: Driver, ticket: Ticket | null) => ToolDefinition[];
  /** Base URL of the HTTP server, used to build run-scoped MCP URLs */
  baseUrl?: () => string;
  /** Build the watcher supervisor (defaults to WatcherRunner); null disables watchers */
  watchers?: ((handlers: ConstructorParameters<typeof WatcherRunner>[0]) => WatcherSupervisor) | null;
  log?: (msg: string) => void;
  /** Model-list cache tuning (tests) */
  modelCatalog?: ModelCatalogOptions;
  /** Slash-command list cache tuning (tests) */
  commandCatalog?: CommandCatalogOptions;
  /**
   * Auto-mode classifier for native-tool drivers. Default: built from settings.classifier
   * (claude-cli / anthropic-api / off). null → none: auto mode asks a human instead.
   */
  classifier?: Classifier | null;
  /** The chief-of-staff triage layer (default: built from settings.classifier and cosTriageModel); `{ unavailable }` for none */
  cosTriage?: CosTriage | { unavailable: string };
  /** Timers for the chief-of-staff event pipeline (default: real ones) */
  cosTimers?: CosTimers;
  /** Classifier rules (default: `claude auto-mode config`, cached in HARNESS_HOME) */
  autoModeRules?: AutoModeRulesProvider;
  classifierTimeoutMs?: number;
  /** How often start() re-checks for runs no live job owns (default 60s; 0 disables) */
  reconcileIntervalMs?: number;
  /** The clock for usage-limit restarts (default Date.now) */
  now?: () => number;
  /** A pull request's title from GitHub, or null (default: gh pr view; tests stub it) */
  fetchPullRequestTitle?: (url: string) => Promise<string | null>;
  /** The service's terminals, for a chief of staff's terminal tools (none: they find no terminals) */
  terminals?: TerminalAccess;
  /** Requests to the Mac app, for a chief of staff's arrange_panes (none: it finds no Mac) */
  macRequests?: MacRequests;
}

/** What the orchestrator needs of the terminal registry (service/src/terminals/registry.ts). */
export interface TerminalAccess {
  list(): TerminalInfo[];
  get(id: string): TerminalInfo | null;
  text(id: string, lines?: number): Promise<{ text: string; lines: number; truncated: boolean }>;
  writeAgent(id: string, data: string): void;
  /** Where the kernel says the shell is as of the last poll (null: unknown); output can't set it. */
  kernelCwd(id: string): string | null;
  /** Poll every running terminal's cwd and foreground process now. */
  refresh(): Promise<void>;
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
  /** The agent called return_to_planning: when the run ends, a Plan run starts (afterRun) */
  replanned: { reason: string; startAfterPlan: boolean } | null;
  /**
   * The chat called unblock on a ticket blocked by a completion run: when the chat ends the
   * completion resumes (afterRun), so the queue runs one job at a time
   */
  resumeCompletion: { note: string } | null;
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
  /** The agent wrote the ticket's notes during this run (update_notes) */
  wroteNotes?: boolean;
  /** Human messages sent while the run is going (steering); null when the run can't take them */
  input: RunInput | null;
  /** The run's working directory, for @-mentions in steered messages */
  cwd: string | null;
  /** The session's epoch when the run started (Orchestrator.sessionEpochs) */
  sessionEpoch: number;
  /** Model calls the session's agent made so far this run (the gauge never counts a run's first as a cache miss) */
  modelCalls: number;
  /** What a compact run reported (its driver's "compacted" event) */
  compacted?: { before?: number; after?: number };
}

/** What the Inbox's old triage sessions (kept, read-only) stored: the output they were triaging. */
interface LegacyTriageMeta {
  source: string;
  text: string;
  prompt?: string;
}

/** One chunk of watcher (or injected) output on its way into the chief of staff's events. */
export interface IngestInput {
  /** Dedupe scope: the watcher id, or inject:<source> */
  sourceId: string;
  /** Watcher name shown on the event */
  source: string;
  output: WatcherOutput;
  /** The chief of staff (its ticket id) the output goes to; null or absent: the All chief */
  cosId?: string | null;
}

/** Runs that do the ticket's work: a queued one holds off auto-submit (see finishWork). */
const RUNNABLE_WORK: RunKind[] = ["work", "conductor", "chat"];
/**
 * Run kinds with a human in the loop for tool-permission prompts. A chat's approval card leaves the
 * ticket in its column, and answering it resumes the chat (openApproval, answerApproval).
 */
const APPROVABLE_RUNS: RunKind[] = ["work", "complete", "conductor", "chat", "cos"];
/** Run kinds whose native tool calls are checked as read_only, whatever the ticket's mode. */
const READ_ONLY_RUNS: RunKind[] = ["plan", "triage"];
/** Most agent turns a triage run takes (a lookup or two per event, then the verdicts) */
const TRIAGE_MAX_TURNS = 40;
/** Run kinds that get the board write tools (create_ticket, message_ticket, update_branch, ...) */
const BOARD_WRITE_RUNS: RunKind[] = ["work", "conductor", "chat", "cos"];
/** Run kinds that get the (human-gated) config tools */
const CONFIG_RUNS: RunKind[] = ["work", "conductor", "chat"];
/** The agent's own runs of a ticket: a message for one of them can steer any other that's going. */
const AGENT_RUNS = new Set<RunKind>(["work", "conductor", "chat", "cos"]);
/**
 * Runs that start a new driver conversation and never save theirs (DESIGN.md "Driver state"): a
 * reviewer judges the work cold, and a completion needs only its own prompt, not the work's history.
 */
const FRESH_RUN_KINDS = new Set<RunKind>(["review", "complete"]);
/** Runs that carry a human's words (the brief, a message, a chat question) and get their @-mentioned files attached. */
// "cos" is left out: its prompts carry watcher output and agent text, and its cwd is the service home (tokens, other groups' worktrees).
const MENTION_RUN_KINDS = new Set<RunKind>(["plan", "work", "conductor", "chat"]);
/**
 * Runs a human message can steer while they're going (DESIGN.md "Steering"): the ones a message
 * would otherwise queue. Review and complete runs never take one (a message moves those tickets).
 */
const STEERABLE_RUN_KINDS = new Set<RunKind>(["plan", "work", "conductor", "chat", "cos"]);
/** Why a plan run can't leave Claude Code's plan mode itself (ExitPlanMode). */
export const PLAN_APPROVAL_MESSAGE =
  "The human approves the plan on the board by pressing Start (Approve plan, while the plan run is still going), which starts the work in a new run. Don't call ExitPlanMode: make sure the plan is saved in the spec with update_spec, then end your turn.";
/** submit_for_review without spec_is_up_to_date: true */
export const SPEC_NOT_UP_TO_DATE_MESSAGE =
  "Bring the spec up to date with edit_spec or update_spec first (Status, decisions, screenshots), then submit again with spec_is_up_to_date: true.";
/** How many recent Activity entries a run's system prompt shows */
export const PROMPT_ACTIVITY_ENTRIES = 5;
/** Transcript note when a message meant for the running agent had to wait for the next run */
export const STEER_FALLBACK_STATUS = "Couldn't reach the running agent; queued for the next run";

/** A human message's transcript entry: its words, and the files sent with it when there are any. */
const messageContent = (m: SentMessage): TranscriptContent => ({ type: "text", text: m.text, ...(m.attachments.length ? { attachments: [...m.attachments] } : {}) });
export const MAX_AGENT_REJECTIONS = 3;
/** Classifier denials of an already-allowed tool retried without a human, before asking one */
export const MAX_AUTO_RETRIES = 3;
/** get_ticket include_transcript: at most this many entries, each clipped to this many characters */
export const BOARD_TRANSCRIPT_MAX = 50;
export const BOARD_TRANSCRIPT_CHARS = 2000;
/** get_ticket include_agents: each result clipped to this many characters (a long session has hundreds) */
export const BOARD_AGENT_LIST_CHARS = 500;
/** get_ticket_agent: its prompt and result clipped to this many characters, a task's output to its last BOARD_TASK_OUTPUT_CHARS */
export const BOARD_AGENT_TEXT_CHARS = 8000;
export const BOARD_TASK_OUTPUT_CHARS = 8000;
/** get_ticket_agent: transcript entries when the agent doesn't say */
export const BOARD_AGENT_TRANSCRIPT_DEFAULT = 20;

/** A sub-agent or task as the board tools show it, its result clipped to `chars`. */
const boardAgent = (s: Subagent, chars: number): BoardAgent => ({
  id: s.id,
  kind: s.kind ?? "agent",
  description: s.description,
  agentType: s.agentType,
  model: s.model ?? null,
  status: s.status,
  parentId: s.parentId,
  command: s.command ?? null,
  result: s.result === null ? null : truncateMiddle(s.result, chars),
  startedAt: s.startedAt,
  endedAt: s.endedAt,
});
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

/**
 * A project body's review defaults (Project.skipAgentReview / skipHumanReview), only the ones it
 * sets. Apps from before them send requireHumanReview instead, its inverse.
 */
function projectReviewDefaults(body: Partial<CreateProjectBody>): { skipAgentReview?: boolean; skipHumanReview?: boolean } {
  const skipAgentReview = validBoolean("skipAgentReview", body.skipAgentReview);
  const legacy = validBoolean("requireHumanReview", body.requireHumanReview);
  const skipHumanReview = validBoolean("skipHumanReview", body.skipHumanReview) ?? (legacy === undefined ? undefined : !legacy);
  return { ...(skipAgentReview !== undefined && { skipAgentReview }), ...(skipHumanReview !== undefined && { skipHumanReview }) };
}

/** A boolean that null clears (a project's override of an app setting): omitted → undefined. */
function nullableBoolean(name: string, value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "boolean") throw badRequest(`${name} must be true, false or null`);
  return value;
}

/** The chief-of-staff overrides of a project create / PATCH body (only the fields it carries). */
function projectCosFields(body: Partial<CreateProjectBody>, knownDrivers: string[]): { cosEnabled?: boolean | null; cosCanUnblock?: boolean | null; cosModel?: PhaseChoice | null } {
  const cosEnabled = nullableBoolean("cosEnabled", body.cosEnabled);
  const cosCanUnblock = nullableBoolean("cosCanUnblock", body.cosCanUnblock);
  const cosModel = body.cosModel === undefined ? undefined : validateCosModel("cosModel", body.cosModel, knownDrivers);
  return { ...(cosEnabled !== undefined && { cosEnabled }), ...(cosCanUnblock !== undefined && { cosCanUnblock }), ...(cosModel !== undefined && { cosModel }) };
}

/** Validate a completion action from a request body (omitted / null → undefined). */
function validCompletionAction(name: string, value: unknown): CompletionAction | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isCompletionAction(value)) throw badRequest(`${name} must be one of ${COMPLETION_ACTIONS.join(", ")}`);
  return value;
}

/** Validate a project group name from a request body (null / "" → none). */
function validProjectGroup(value: unknown): string | null {
  const group = normalizeProjectGroup(value);
  if (group === undefined) throw badRequest(`group must be a name of at most ${PROJECT_GROUP_MAX} characters, or null`);
  return group;
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
  private tools: (kind: RunKind, driver: Driver, ticket: Ticket | null) => ToolDefinition[];
  private baseUrl: () => string;
  private log: (msg: string) => void;
  /**
   * Tickets whose next transition() is already in Activity (moveMeta on the entry): the column it
   * goes to and the entry, which only counts while it's still the ticket's newest.
   */
  private movesRecorded = new Map<string, { to: TicketStatus; entryId: string }>();
  /**
   * sessionId → how many times its ticket's driver conversation has been dropped (`newSession`)
   * since the service started. A run saves its driver state only while this is what it was when
   * the run started, so a run that outlives its conversation can't write it back.
   */
  private sessionEpochs = new Map<string, number>();
  /** The plan-usage gauges' readings (DESIGN.md "Plan usage"); the app polls it while clients are connected */
  readonly planUsage: PlanUsageTracker;
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
  /** Fires at the earliest blocked ticket's resumeAt (armResume) */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  private fetchTitle: (url: string) => Promise<string | null>;
  /** Title lookups running now, and the ones waiting for a slot (withTitleSlot) */
  private titleSlotsInUse = 0;
  private titleSlotWaiters: (() => void)[] = [];
  /** Tickets with a refresh of their titles still running, so a repeated refresh starts nothing new */
  private titleRefreshesInFlight = new Set<string>();
  /** Fire-and-forget async work (scheduling, worktree setup) that idle() must wait for */
  private background = new Set<Promise<unknown>>();
  private modelCatalog: ModelCatalog;
  private commandCatalog: CommandCatalog;
  private gate: PermissionGate;
  private autoModeRules: AutoModeRulesProvider;
  private classifierOption: Classifier | null | undefined;
  private classifierCache: { key: string; classifier: Classifier } | null = null;
  /** The chief-of-staff event pipeline (DESIGN.md "Events") */
  readonly cosEngine: CosEngine;
  private readonly terminalAccess: TerminalAccess | undefined;
  private readonly macRequests: MacRequests | undefined;
  private cosOpts: Pick<OrchestratorOptions, "cosTriage">;
  /** The triage agent runs in flight, by their session: what each was asked and the verdicts it has recorded (runTriage) */
  private triageRuns = new Map<string, { cosId: string; system: string; model: string; ids: string[]; verdicts: Map<string, TriageVerdict> }>();
  private cosOff: (() => void)[] = [];
  /** Who caused the activity written in this async context ("cos:<ticket id>" inside a chief's run) */
  /** The project the latest wake of each chief (by ticket id) was about, when every event in it was; a chat message clears it. */
  private cosWakeProject = new Map<string, string | null>();
  private actorContext = new AsyncLocalStorage<string | null>();
  /**
   * `${project path}\0${settings base branch}` → the branch checked out in that checkout, for
   * repos without the settings' branch (refreshBaseBranch; see baseBranchFor)
   */
  private baseFallback = new Map<string, string>();
  /** Tickets whose complete run is about to be enqueued (enqueueComplete); they count as completing */
  private startingComplete = new Set<string>();
  /** The ticket branch's tip when a merge completion started, by ticket id: the run deletes the branch, so this is what must be in the base afterwards. */
  private mergeTips = new Map<string, string>();

  constructor(opts: OrchestratorOptions) {
    this.modelCatalog = new ModelCatalog(opts.modelCatalog);
    this.classifierOption = opts.classifier;
    this.cosOpts = { cosTriage: opts.cosTriage };
    this.autoModeRules =
      opts.autoModeRules ??
      new AutoModeRulesProvider({
        bin: () => {
          const bin = resolveClaudeBin(process.env);
          return existsSync(bin) ? bin : null;
        },
        env: () => claudeCliEnv(process.env, this.settings()),
        cachePath: join(opts.paths.home, "auto-mode-rules.json"),
      });
    this.gate = new PermissionGate({ classifier: () => this.classifier(), timeoutMs: opts.classifierTimeoutMs });
    this.store = opts.store;
    this.bus = opts.bus;
    this.browser = opts.browser;
    this.paths = opts.paths;
    this.terminalAccess = opts.terminals;
    this.macRequests = opts.macRequests;
    for (const d of opts.drivers) this.drivers.set(d.id, d);
    this.tools = opts.tools ?? toolsForRun;
    this.baseUrl = opts.baseUrl ?? (() => "http://127.0.0.1:0");
    this.log = opts.log ?? ((m) => console.log(`[orchestrator] ${m}`));
    this.commandCatalog = new CommandCatalog({ log: this.log, ...opts.commandCatalog });
    this.queue = new RunQueue({
      limit: () => this.settings().maxConcurrentRuns,
      execute: (job) => this.execute(job),
      onError: (job, err) => {
        this.log(`run ${job.runId} crashed: ${errMsg(err)}`);
        this.failCrashedRun(job.runId, errMsg(err));
      },
    });
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.fetchTitle = opts.fetchPullRequestTitle ?? fetchPullRequestTitle;
    this.planUsage = new PlanUsageTracker(() => this.driverList(), this.bus, () => this.now());
    const handlers = {
      onOutput: async (w: Watcher, output: WatcherOutput) => {
        // Read the owner now: a CoS that was deleted since the supervisor started has already handed its watchers to All.
        this.ingest({ sourceId: w.id, source: w.name, output, cosId: this.store.watchers.get(w.id)?.cosId ?? null });
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
    this.cosEngine = new CosEngine({
      store: this.store,
      emit: (e) => this.bus.emit(e),
      now: () => this.now(),
      settings: () => this.settings(),
      triage: () => this.cosTriage(),
      deliver: (cosTicketId, text, projectKey) => this.wakeCos(cosTicketId, text, projectKey),
      runStatus: (runId) => this.store.runs.get(runId)?.status ?? null,
      runReplies: (runId, since) => this.store.transcript.assistantTexts(runId, since),
      log: this.log,
      timers: opts.cosTimers,
    });
    this.watcherRunner = opts.watchers === null ? null : opts.watchers ? opts.watchers(handlers) : new WatcherRunner({ ...handlers, now: this.now });
  }

  // =========================================================================
  // Lifecycle of the service
  // =========================================================================

  /** Recover from a previous process and start watchers. */
  start() {
    this.warnStaleOverrides();
    this.backfillPullRequestTitles();
    const stale = this.recoverStaleRuns();
    if (stale) this.log(`marked ${stale} stale run(s) from a previous process as failed; nothing re-enqueued`);
    try {
      this.sweepUploads();
    } catch (err) {
      this.log(`upload sweep failed: ${errMsg(err)}`);
    }
    this.syncWatchers();
    this.cosOff.push(
      this.bus.onKind("activity.added", () => this.cosEngine.nudge()),
      this.bus.onKind("transcript.appended", (e) => {
        const m = e.entry;
        if (m.subagentId || (m.role !== "user" && m.role !== "assistant") || m.content.type !== "text" || m.content.text.startsWith(WAKE_PROMPT_PREFIX)) return;
        if (m.role === "assistant" && isSilentReply(m.content.text)) return;
        const cosId = this.store.sessions.get(m.sessionId)?.ticketId;
        if (!cosId || !this.store.cos.get(cosId)) return;
        this.bus.emit({ kind: "cos.transcript.appended", cosId, entry: { id: m.id, cosId, createdAt: m.createdAt, kind: "message", role: m.role, text: m.content.text } });
      }),
      this.bus.onKind("run.upserted", (e) => {
        if (e.run.kind === "cos" && (e.run.status === "succeeded" || e.run.status === "failed" || e.run.status === "cancelled")) this.cosEngine.runEnded(e.run.id, e.run.status);
      }),
    );
    this.cosEngine.start();
    if (this.store.projects.orphanedCosTickets().length) void this.pruneCos(); // a chief of staff whose group emptied while the service was down
    // Restarts that came due while the service was down run now; the rest at their time.
    this.kickResume();
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

  /**
   * Saved prompt overrides that still name the tools the spec replaced (update_plan,
   * post_summary) would steer agents to tools they no longer have: say so in the log.
   */
  private warnStaleOverrides() {
    const overrides = this.settings().prompts ?? {};
    for (const [id, text] of Object.entries(overrides)) {
      const old = ["update_plan", "post_summary"].filter((name) => typeof text === "string" && text.includes(name));
      if (old.length) this.log(`warning: the saved override of prompt ${id} names ${old.join(" and ")}, which are now update_spec / edit_spec and post_note; edit it in Settings → Prompts`);
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
    this.stopSubagents(run.id);
    this.appendStatus(run.sessionId, run.id, `Run interrupted (${run.kind}): ${reason}`);
    if (run.kind === "plan") {
      const planned = this.store.sessions.get(run.sessionId)?.ticketId;
      if (planned) this.dropPlanApproval(planned, "Plan approval cleared: planning run interrupted; work not started");
    }
    if (run.kind === "complete") this.completionStopped(run.sessionId, "interrupted");
    this.touchSession(run.sessionId);
  }

  async stop() {
    this.stopping = true;
    this.cosEngine.stop();
    for (const off of this.cosOff.splice(0)) off();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
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
    const values = applySettingsPatch(current, patch);
    this.store.transaction(() => {
      this.store.settings.set(values);
      if (values.phaseModels) this.store.settings.delete(LEGACY_MODEL_KEYS);
    });
    if (patch.anthropicApiKey !== undefined) this.modelCatalog.invalidate("anthropic-api");
    if (patch.claudeOauthToken !== undefined) this.modelCatalog.invalidate("claude-code");
    if (patch.copilotGithubToken !== undefined) this.modelCatalog.invalidate("github-copilot");
    const pub = this.publicSettings();
    this.bus.emit({ kind: "settings.updated", settings: pub });
    if (patch.cosEnabled !== undefined) this.rehomeCosEvents();
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
          const info = await d.info();
          return { ...info, ...(d.sessionActions ? { sessionActions: d.sessionActions } : {}), reportsContextUsage: d.reportsContextUsage !== false, runsCos: d.runsCos !== false };
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
    const { input: { group, ...input }, mode } = this.prepareProject(body);
    const project = this.store.transaction(() => {
      const created = this.store.projects.create({ ...input, groupId: this.groupIdOf(group) });
      if (mode) this.store.projects.setPermissionMode(created.id, mode);
      return created;
    });
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
      if (this.store.projects.keyHolder(key)) throw conflict(`Project key ${key} is already used by another project`);
    }
    const input = {
      path,
      name: body.name?.trim() || basename(path),
      key,
      useWorktrees: body.useWorktrees,
      ...projectReviewDefaults(body),
      ...projectCosFields(body, [...this.drivers.keys()]),
      color: body.color !== undefined ? validProjectColor(body.color) : null,
      group: this.groupRef(body) ?? null,
      baseBranch: validateBranchName("baseBranch", body.baseBranch),
      completionAction: this.validProjectCompletion(path, body.completionAction),
      phaseModels: this.projectPhaseModels({}, body),
    };
    return { input, mode: validPermissionMode(body.permissionMode) };
  }

  /**
   * A project's choices after a create/PATCH body: legacy defaultDriver / defaultModels first (they
   * set Planning, Work and Review), then phaseModels merged per phase. Undefined when the body has
   * neither.
   */
  private projectPhaseModels(current: Project["phaseModels"], body: Partial<CreateProjectBody>) {
    const known = [...this.drivers.keys()];
    if (body.defaultDriver && !this.drivers.has(body.defaultDriver)) throw badRequest(`Unknown driver: ${body.defaultDriver}`);
    const phasePatch = body.phaseModels !== undefined ? validatePhaseModels("phaseModels", body.phaseModels, known) : undefined;
    const models = body.defaultModels !== undefined && body.defaultModels !== null ? validateModelMap("defaultModels", body.defaultModels, known) : undefined;
    if (body.defaultDriver === undefined && models === undefined && phasePatch === undefined) return undefined;
    const legacy = body.defaultDriver !== undefined || models ? applyLegacyProject(current, { defaultDriver: body.defaultDriver, defaultModels: models }, this.settings().phaseModels) : { ...current };
    return mergePhaseModels(legacy, phasePatch ?? {});
  }

  /**
   * A ticket's own choices after a create/PATCH body. The legacy driver / model shorthand sets
   * Planning, Work and Review (a driver change without a model drops the old driver's model, and the
   * inherited driver with no model follows the project again); phaseModels then merges per phase.
   */
  private ticketPhaseModels(
    current: PhaseModels,
    body: { driver?: string; model?: string | null; phaseModels?: unknown },
    project: Project | null,
    ticket?: Ticket,
  ): PhaseModels {
    const known = [...this.drivers.keys()];
    if (body.driver !== undefined && !this.drivers.has(body.driver)) throw badRequest(`Unknown driver: ${body.driver}`);
    const model = body.model !== undefined ? validateModelId("model", body.model) : undefined;
    const phasePatch = body.phaseModels !== undefined ? validatePhaseModels("phaseModels", body.phaseModels, known) : undefined;
    let out: PhaseModels = { ...current };
    if (body.driver !== undefined || model !== undefined) {
      const settings = this.settings().phaseModels;
      const inherited = resolvePhaseChoice("work", { project: project?.phaseModels, settings });
      const curWork = resolvePhaseChoice("work", { ticket: current, project: project?.phaseModels, settings });
      const driver = body.driver ?? ticket?.driver ?? curWork.driver;
      const keepModel = driver === curWork.driver ? (current.work?.model ?? null) : null;
      out = ticketLegacyChoice(current, { driver, model: model !== undefined ? model : keepModel }, inherited);
    }
    return mergePhaseModels(out, phasePatch ?? {});
  }

  /**
   * The group a request body names: `groupId` (an existing group) or `group` (a name, which a
   * group with that name in any case takes; made if there is none). null → no group, undefined →
   * the body doesn't say. Writes nothing: groupIdOf resolves a name inside the write.
   */
  private groupRef(body: { group?: unknown; groupId?: unknown }): GroupRef | undefined {
    if (body.groupId !== undefined) {
      if (body.groupId === null || body.groupId === "") return null;
      if (typeof body.groupId !== "string" || !this.store.groups.get(body.groupId)) throw badRequest(`Unknown group: ${String(body.groupId)}`);
      return { id: body.groupId };
    }
    if (body.group === undefined) return undefined;
    const name = validProjectGroup(body.group);
    return name === null ? null : { name };
  }

  /** The id of a group a body named, making the group when only its name was given. */
  private groupIdOf(ref: GroupRef | undefined): string | null | undefined {
    if (ref === undefined || ref === null) return ref;
    if ("id" in ref) return ref.id;
    try {
      return this.store.groups.findOrCreate(ref.name).id;
    } catch (err) {
      if (err instanceof GroupNameTaken) throw conflict(err.message);
      throw err;
    }
  }

  /**
   * The group a tickets query names: `groupId`, or the legacy `group` (a name, as older apps sent
   * it) resolved to the id. A name no group has matches nothing, as it always did.
   */
  groupIdParam(sp: URLSearchParams): string | undefined {
    const id = sp.get("groupId");
    if (id) return id;
    const name = normalizeProjectGroup(sp.get("group"));
    if (!name) return undefined;
    return this.store.groups.findByName(name)?.id ?? "no-such-group";
  }

  listGroups(): Group[] {
    return this.store.groups.list();
  }

  /**
   * Rename a group (PATCH /groups/:id). The name is unique without case: another group's name is a
   * 409, not a merge. Its projects are announced after the rename commits, since a client learns a
   * project's group from the project.
   */
  renameGroup(id: string, body: { name?: unknown }): Group {
    const name = validProjectGroup(body?.name);
    if (name === null) throw badRequest("name is required");
    let renamed: ReturnType<GroupRepo["rename"]>;
    try {
      renamed = this.store.groups.rename(id, name);
    } catch (err) {
      if (err instanceof GroupNameTaken) throw conflict(err.message);
      throw err;
    }
    if (!renamed) throw notFound(`Unknown group: ${id}`);
    for (const projectId of renamed.projectIds) {
      const project = this.store.projects.get(projectId);
      if (project) this.bus.emit({ kind: "project.upserted", project });
    }
    return renamed.group;
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
   * (sessions and dependencies follow, numbers and nextSeq are kept), tickets linked to a remote
   * ID included. Legacy mirrors (key = remote ID) keep their keys, and existing branches /
   * worktree directories keep the old name: they're stored on the ticket, so work in progress
   * isn't disturbed.
   */
  updateProject(id: string, body: Partial<CreateProjectBody>): Project {
    const existing = this.store.projects.get(id);
    if (!existing || this.store.projects.isInternal(id)) throw notFound(`Unknown project: ${id}`);
    const { newKey, permissionMode, rest, group, path, phaseModels } = this.prepareProjectUpdate(existing, body);
    const renamed = this.store.transaction(() => {
      this.store.projects.update(id, { ...rest, groupId: this.groupIdOf(group), name: rest.name?.trim(), path, phaseModels });
      if (permissionMode !== undefined) this.store.projects.setPermissionMode(id, permissionMode);
      return newKey ? this.store.projects.rekey(id, newKey) : null;
    });
    const project = this.store.projects.get(id)!;
    this.bus.emit({ kind: "project.upserted", project });
    if (this.store.projects.orphanedCosTickets().length) void this.pruneCos();
    this.rehomeCosEvents();
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
        const other = this.store.projects.keyHolder(key);
        if (other && other.id !== existing.id) throw conflict(`Project key ${key} is already used by ${this.store.projects.isInternal(other.id) ? "the app" : other.name}`);
        const collisions = this.store.projects.rekeyConflicts(existing.id, key);
        if (collisions.length) {
          const list = collisions.slice(0, 3).join(", ") + (collisions.length > 3 ? ` and ${collisions.length - 3} more` : "");
          throw conflict(`Can't rename to ${key}: ${list} already exist${collisions.length === 1 ? "s" : ""}`);
        }
        newKey = key;
      }
    }
    const permissionMode = body.permissionMode !== undefined ? validPermissionMode(body.permissionMode) : undefined;
    const {
      key: _key,
      defaultDriver: _driver,
      defaultModels: _models,
      phaseModels: _phases,
      permissionMode: _mode,
      color: rawColor,
      group: _group,
      groupId: _groupId,
      baseBranch: rawBase,
      completionAction: rawAction,
      cosEnabled: _cosEnabled,
      cosCanUnblock: _cosCanUnblock,
      cosModel: _cosModel,
      skipAgentReview: _skipAgent,
      skipHumanReview: _skipHuman,
      requireHumanReview: _require,
      ...rest
    } = body;
    const color = rawColor !== undefined ? validProjectColor(rawColor) : undefined;
    const group = this.groupRef(body);
    const baseBranch = rawBase !== undefined ? validateBranchName("baseBranch", rawBase) : undefined;
    const completionAction = this.validProjectCompletion(path ?? existing.path, rawAction);
    const phaseModels = this.projectPhaseModels(existing.phaseModels, body);
    return { newKey, permissionMode, rest: { ...rest, ...projectReviewDefaults(body), ...projectCosFields(body, [...this.drivers.keys()]), color, baseBranch, completionAction }, group, path, phaseModels };
  }

  async deleteProject(id: string) {
    if (!this.store.projects.get(id) || this.store.projects.isInternal(id)) throw notFound(`Unknown project: ${id}`);
    const project = this.store.projects.get(id)!;
    const tickets = this.store.tickets.list({ projectId: id });
    this.cosEngine.drain(); // what was written about its tickets is read before it cascades away
    for (const t of tickets) await this.deleteTicket(t.key, true);
    // One event for the whole project, not one per ticket; its owner is fixed now, as the project is about to go.
    this.cosEngine.addDeleted({ what: "project", id, label: project.key, title: `${project.name} and its ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`, actor: this.actorContext.getStore() ?? "human", project });
    this.store.projects.delete(id);
    this.bus.emit({ kind: "project.deleted", id });
    await this.pruneCos();
    this.rehomeCosEvents();
  }

  // =========================================================================
  // Chiefs of staff (DESIGN.md "Chief of staff")
  // =========================================================================

  listCos(): Cos[] {
    const triageUnavailable = this.cosEngine.triageUnavailable;
    return this.store.cos.list().map((c) => ({ ...c, triageUnavailable }));
  }

  /** Events changed owner (a chief on or off, a project's setting or group): pending ones find their owner again, and anything due is handled. */
  private rehomeCosEvents() {
    this.cosEngine.rehome();
    void this.cosEngine.tick().catch((err) => this.log(`cos: tick failed: ${errMsg(err)}`));
  }

  /** The Inbox page of a chief (GET /cos/:id/events). */
  cosEvents(cosId: string, query: { status?: string | null; before?: string | null; limit?: string | null }): CosEventPage {
    if (!this.store.cos.get(cosId)) throw notFound(`Unknown chief of staff: ${cosId}`);
    const status = query.status || undefined;
    if (status && !COS_EVENT_STATUSES.includes(status as CosEventStatus)) throw badRequest(`status must be one of ${COS_EVENT_STATUSES.join(", ")}`);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    let before: { createdAt: number; id: string } | undefined;
    if (query.before) {
      const i = query.before.indexOf(":");
      const createdAt = Number(query.before.slice(0, i));
      if (i <= 0 || !Number.isFinite(createdAt)) throw badRequest("before is not a cursor from a previous page");
      before = { createdAt, id: query.before.slice(i + 1) };
    }
    const rows = this.store.cosEvents.list({ cosId, status: status as CosEventStatus | undefined, before, limit: limit + 1 });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map(wireCosEvent), nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null };
  }

  cosBadge(): CosBadge {
    return this.cosEngine.badge();
  }

  /** "Escalate anyway": an ignored event goes in the chief's next wake. */
  async escalateCosEvent(id: string): Promise<CosEvent> {
    const res = this.cosEngine.escalate(id);
    if ("error" in res) {
      if (res.error === "unknown") throw notFound(`Unknown event: ${id}`);
      throw conflict(res.error === "handled" ? "That event was already handled" : "That event is being triaged right now; try again in a moment");
    }
    // The wake is the engine's to deliver; the answer doesn't wait on a triage call or a chief.
    void this.cosEngine.tick().catch((err) => this.log(`cos: tick failed: ${errMsg(err)}`));
    return wireCosEvent(this.store.cosEvents.get(id)!);
  }

  cosTranscript(cosId: string, query: { before?: string | null; limit?: string | null }): CosChatPage {
    if (!this.store.cos.get(cosId)) throw notFound(`Unknown chief of staff: ${cosId}`);
    return cosChat(this.store, cosId, query.before || null, Math.min(200, Math.max(1, Number(query.limit) || 50)));
  }

  /** A human's message to a chief: straight to its run, with no triage in between. */
  async sendCosMessage(cosId: string, body: { text?: unknown; attachments?: unknown }): Promise<{ entryId: string }> {
    const cos = this.store.cos.get(cosId);
    const ticket = cos ? this.store.tickets.get(cos.ticketId) : null;
    if (!cos || !ticket) throw notFound(`Unknown chief of staff: ${cosId}`);
    const after = this.store.transcript.lastSeq(ticket.sessionId);
    await this.sendMessage(ticket.key, body.text as string, { attachments: body.attachments });
    const entry = this.store.transcript.list(ticket.sessionId, after).find((e) => e.role === "user" && e.content.type === "text");
    if (!entry) throw conflict(`${ticket.key} didn't take the message`);
    return { entryId: entry.id };
  }

  /** Hand a chief a message from the pipeline; resolves to the run that will read it. */
  private async wakeCos(cosTicketId: string, text: string, projectKey: string | null): Promise<string | null> {
    const ticket = this.store.tickets.get(cosTicketId);
    if (!ticket) throw notFound(`Unknown chief of staff: ${cosTicketId}`);
    // A wake about one project runs on that project's chief-of-staff model; any other run runs on the app's.
    this.cosWakeProject.set(cosTicketId, projectKey ? (this.store.projects.getByKey(projectKey)?.id ?? null) : null);
    return this.steerOrEnqueue(ticket.sessionId, "cos", { text, attachments: [] });
  }

  /**
   * One triage agent run over a batch of events (DESIGN.md "Events"): a read-only run of the claude-code
   * driver on its own session (kind "triage", hidden from the board), with the board tools and the
   * triage_verdict tool. The session stays, so the Inbox row can open what the run looked up. Resolves
   * with the verdicts recorded when the run ends; a run that failed or was cut off after recording
   * some throws TriageIncomplete, which keeps them.
   */
  async runTriage(req: AgentTriageRequest, signal: AbortSignal): Promise<AgentTriageRun> {
    // An empty folder to work in: the service's own checkout and settings never reach the agent.
    const cwd = mkdtempSync(join(tmpdir(), "harness-triage-"));
    const session = this.store.sessions.create({
      key: `TRIAGE-${this.store.counters.next("triage")}`,
      kind: "triage",
      ticketId: null,
      driver: "claude-code",
      cwd,
      title: `Triage of ${req.ids.length} event${req.ids.length === 1 ? "" : "s"}`,
    });
    const state = { cosId: req.cosId, system: req.system, model: req.model, ids: req.ids, verdicts: new Map<string, TriageVerdict>() };
    this.triageRuns.set(session.id, state);
    try {
      const run = this.enqueueRun(session.id, "triage", req.prompt, undefined, { skipTranscript: false });
      const finished = await new Promise<Run>((resolve, reject) => {
        // The run's own time limit starts when it does: a run waiting for a slot isn't timed out.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = this.bus.onKind("run.upserted", (e) => {
          if (e.run.id !== run.id) return;
          if (e.run.status === "running" && !timer) timer = setTimeout(() => stop(new Error("triage timed out")), req.timeoutMs);
          if (!["succeeded", "failed", "cancelled"].includes(e.run.status)) return;
          off();
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", stop);
          resolve(e.run);
        });
        const stop = (why?: unknown) => {
          off();
          if (timer) clearTimeout(timer);
          void this.cancelSession(session.id, false);
          reject(why instanceof Error ? why : new Error("triage was cancelled"));
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      });
      const verdicts = [...state.verdicts.values()];
      const usage = { sessionId: session.id, tokensIn: finished.inputTokens ?? null, tokensOut: finished.outputTokens ?? null };
      if (finished.status !== "succeeded") throw new TriageIncomplete(finished.error ? `triage run failed: ${finished.error}` : `triage run ${finished.status}`, verdicts, session.id);
      if (!verdicts.length) throw new TriageIncomplete("the triage run recorded no verdicts", verdicts, session.id);
      return { verdicts, ...usage };
    } catch (err) {
      // A cut-off run (timeout) keeps what it recorded before the cut.
      if (err instanceof TriageIncomplete) throw err;
      throw new TriageIncomplete(errMsg(err), [...state.verdicts.values()], session.id);
    } finally {
      this.triageRuns.delete(session.id);
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  /** HarnessOps.recordTriageVerdict: one verdict from a triage run, validated against the event ids it was asked about. */
  recordTriageVerdict(ctx: ToolContext, input: unknown): string {
    const state = this.triageRuns.get(ctx.session.id);
    if (!state) throw new Error("triage_verdict is for triage runs.");
    const [verdict] = parseTriage({ verdicts: [input] }, state.ids);
    if (!verdict) throw new Error(`Not recorded: id must be one of ${state.ids.join(", ")}, and verdict "ignore" or "escalate".`);
    // The first verdict per event is final: a later call (from injected text in tool output) can't flip it.
    if (state.verdicts.has(verdict.id)) return `${verdict.id} already has a verdict; it stands.`;
    state.verdicts.set(verdict.id, verdict);
    const left = state.ids.filter((id) => !state.verdicts.has(id));
    return left.length ? `Recorded. Still without a verdict: ${left.join(", ")}.` : "Recorded. Every event has a verdict: stop now.";
  }

  /** The triage layer: injected, else a stateless Haiku call on the classifier's backend; `unavailable` when there is none to call. */
  private cosTriage(): CosTriage | { unavailable: string } {
    if (this.cosOpts.cosTriage) return this.cosOpts.cosTriage;
    const settings = this.settings();
    if (settings.classifier === "off") return { unavailable: "the classifier is switched off in Settings, and triage uses its backend" };
    if (process.env.NODE_ENV === "test") return { unavailable: "no real model under bun test" };
    const model = () => settings.cosTriageModel?.trim() || HAIKU_MODELS[settings.classifier] || HAIKU_MODELS["claude-code"]!;
    if (settings.classifier === "anthropic-api") {
      const apiKey = () => this.settings().anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
      if (!apiKey()) return { unavailable: "no Anthropic API key" };
      return new LlmTriage("anthropic-api", model, (req, signal) => anthropicStructured({ apiKey }, req, signal), this.paths.home);
    }
    // The CLI backend gets an agent run that can look things up; a service with no claude-code driver keeps the one-shot call.
    if (this.drivers.get("claude-code")) return new AgentTriage("claude-cli", model, (req, signal) => this.runTriage(req, signal));
    return new LlmTriage("claude-cli", model, (req, signal) => claudeCliStructured({ bin: () => resolveClaudeBin(process.env), env: () => claudeCliEnv(process.env, this.settings()) }, req, signal), this.paths.home);
  }

  /**
   * The chief of staff of `scope`, made the first time it is asked for (opening its view, or an event
   * arriving) and the same one every time after. Its ticket lives in the hidden internal project and
   * runs in the harness home folder, with no worktree. Never called from a read: GET /cos lists what
   * exists. A group scope needs the group to exist.
   */
  openCos(scope: CosScope): Cos {
    if (scope !== "all" && !this.store.groups.get(scope.group)) throw notFound(`Unknown group: ${scope.group}`);
    if (scope !== "all" && !this.store.projects.list().some((p) => p.groupId === scope.group)) throw conflict(`Group ${scope.group} has no projects`);
    const existing = this.store.cos.getByScope(scope);
    if (existing) return existing;
    const settings = this.settings();
    const group = scope === "all" ? null : this.store.groups.get(scope.group)!;
    const title = group ? `Chief of staff: ${group.name}` : "Chief of staff";
    const driver = resolvePhaseChoice("work", { settings: settings.phaseModels }).driver;
    const cos = this.store.transaction(() => {
      const project = this.store.projects.internal(this.paths.home);
      const key = this.store.projects.takeNextKey(project.id, (k) => this.store.tickets.keyExists(k));
      const session = this.store.sessions.create({ key, kind: "ticket", ticketId: null, driver, cwd: this.paths.home, title });
      const t = this.store.tickets.create({
        key,
        projectId: project.id,
        kind: "cos",
        title,
        spec: "",
        status: "in_progress",
        sessionId: session.id,
        driver,
        parentId: null,
        dependsOn: [],
        autoStart: false,
        externalRef: null,
        workdir: this.paths.home,
        phaseModels: {},
        useWorktree: false,
        baseBranch: null,
        requestedBranch: null,
        skipAgentReview: true,
        skipHumanReview: true,
        draft: false,
        promptAttachments: [],
      });
      this.store.sessions.update(session.id, { ticketId: t.id });
      return this.store.cos.insert(t.id, scope);
    });
    const ticket = this.store.tickets.get(cos.ticketId);
    if (ticket) {
      this.bus.emit({ kind: "ticket.upserted", ticket });
      this.touchSession(ticket.sessionId);
    }
    this.rehomeCosEvents(); // events no chief qualified for until now
    return cos;
  }

  /** A chief of staff's own on/off switch. Off, it takes no new runs (sendMessage refuses); a run under way is left to end. */
  setCosEnabled(ticketId: string, enabled: unknown): Cos {
    if (typeof enabled !== "boolean") throw badRequest("enabled must be true or false");
    const cos = this.store.cos.setEnabled(ticketId, enabled);
    if (!cos) throw notFound(`Unknown chief of staff: ${ticketId}`);
    this.touchTicket(cos.ticketId);
    this.rehomeCosEvents();
    return cos;
  }

  // =========================================================================
  // Schedules (DESIGN.md "Schedules")
  // =========================================================================

  /** Every chief's schedules (GET /schedules): the human sees them all. */
  listSchedules(opts: { all?: boolean } = {}): Schedule[] {
    return this.store.schedules.list({ all: opts.all });
  }

  /** The human stops a schedule (DELETE /schedules/:id). */
  cancelSchedule(id: string): Schedule {
    const s = this.store.schedules.get(id);
    if (!s) throw notFound(`Unknown schedule: ${id}`);
    if (!this.store.schedules.cancel(id)) throw conflict(`That schedule is already ${s.status}`);
    this.cosEngine.ignoreScheduleEvents(id);
    return this.store.schedules.get(id)!;
  }

  /** The chief a schedule tool acts for: its own row, read on every call. Schedules are theirs alone. */
  private scheduleOwner(ctx: ToolContext): Cos {
    const cos = ctx.ticket?.kind === "cos" ? this.store.cos.get(ctx.ticket.id) : null;
    if (!cos) throw new Error("Only a chief of staff has schedules.");
    return cos;
  }

  /** The chief whose memory a tool acts on: its own ticket, read fresh on every call. */
  private memoryOwner(ctx: ToolContext): Ticket {
    const t = ctx.ticket?.kind === "cos" ? this.store.tickets.get(ctx.ticket.id) : null;
    if (!t) throw new Error("Only a chief of staff has a memory.");
    return t;
  }

  private writeMemory(t: Ticket, text: string): CosMemory {
    const stored = text.trim() ? text : "";
    const updated = this.store.tickets.update(t.id, { agentNotes: stored || null })!;
    this.bus.emit({ kind: "ticket.upserted", ticket: updated });
    return { text: stored, revision: memoryRevision(stored) };
  }

  private readMemory_(ctx: ToolContext): CosMemory {
    const text = this.memoryOwner(ctx).agentNotes ?? "";
    return { text, revision: memoryRevision(text) };
  }

  /** One section's body replaced against the current text (read and written in one synchronous step), so the other sections and a human's concurrent edit to them survive. */
  private updateMemorySection_(ctx: ToolContext, section: string, body: string): CosMemory {
    const t = this.memoryOwner(ctx);
    return this.writeMemory(t, replaceMemorySection(t.agentNotes ?? "", section, body));
  }

  private requireCos(key: string): Ticket {
    const t = this.requireTicket(key);
    if (t.kind !== "cos") throw conflict(`${t.key} is not a chief of staff: only a chief has a memory`);
    return t;
  }

  /** GET /tickets/:key/memory */
  getMemory(key: string): CosMemory {
    const text = this.requireCos(key).agentNotes ?? "";
    return { text, revision: memoryRevision(text) };
  }

  /** PUT /tickets/:key/memory: the human's whole document, refused (409) when the memory changed since they opened it. */
  putMemory(key: string, body: { text?: unknown; baseRevision?: unknown }): CosMemory {
    const t = this.requireCos(key);
    if (typeof body?.text !== "string") throw badRequest("text must be a string");
    if (typeof body.baseRevision !== "string") throw badRequest("baseRevision is required");
    const current = t.agentNotes ?? "";
    if (body.baseRevision !== memoryRevision(current)) {
      throw new HarnessError(409, `${t.key}'s memory changed since you opened it`, { currentRevision: memoryRevision(current), text: current } satisfies MemoryConflict);
    }
    try {
      return this.writeMemory(t, checkMemory(body.text));
    } catch (e) {
      if (e instanceof MemoryError) throw badRequest(e.message);
      throw e;
    }
  }

  private scheduleCreate_(ctx: ToolContext, input: Parameters<HarnessOps["scheduleCreate"]>[1]): Schedule {
    const cos = this.scheduleOwner(ctx);
    const spec = specFromInput(input);
    const now = this.now();
    validateSpec(spec, now);
    if (this.store.schedules.countActive(cos.ticketId) >= SCHEDULE_MAX_ACTIVE) throw new Error(`You have ${SCHEDULE_MAX_ACTIVE} active schedules: cancel one first.`);
    const project = input.projectKey ? this.scopeOf(ctx).projects.getByKey(input.projectKey) : null;
    if (input.projectKey && !project) throw new Error(`Unknown project: ${input.projectKey}`);
    const first = nextFire(spec, now);
    if (first === null) throw new Error("That schedule never fires.");
    return this.store.schedules.insert({ cosId: cos.ticketId, kind: input.kind, title: input.title.trim(), message: input.message.trim(), spec, projectId: project?.id ?? null, nextFireAt: first });
  }

  private scheduleCancel_(ctx: ToolContext, id: string): Schedule {
    const cos = this.scheduleOwner(ctx);
    const s = this.store.schedules.get(id);
    // Another chief's schedule can't be told from one that doesn't exist.
    if (!s || s.cosId !== cos.ticketId) throw new Error(`Unknown schedule: ${id}`);
    if (!this.store.schedules.cancel(id)) throw new Error(`That schedule is already ${s.status}.`);
    this.cosEngine.ignoreScheduleEvents(id);
    return this.store.schedules.get(id)!;
  }

  // =========================================================================
  // Tickets (human / API surface)
  // =========================================================================

  /** Every ticket (one project's), or only those whose status is in `statuses`. */
  listTickets(projectId?: string, statuses?: TicketStatus[]): Ticket[] {
    return this.store.tickets.list({ ...(projectId ? { projectId } : {}), ...(statuses ? { statuses } : {}) });
  }

  /** One page of a column (GET /tickets/page). See TicketRepo.page. */
  ticketPage(opts: { status: TicketStatus; projectId?: string; groupId?: string; q?: string; limit?: number | string | null; cursor?: string | null }): TicketPage {
    if (opts.q !== undefined && !opts.q.trim()) throw badRequest("q must not be empty");
    return this.withCursor(() => this.store.tickets.page({ ...opts, limit: clampLimit(opts.limit, DEFAULT_PAGE_LIMIT) }));
  }

  /** Ticket search across every status (GET /tickets/search). See TicketRepo.search. */
  searchTickets(opts: { q: string; projectId?: string; groupId?: string; limit?: number | string | null; cursor?: string | null; drafts?: boolean }): TicketPage {
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

  /**
   * A chief of staff isn't a board ticket: it never moves through planning, review or done, so every
   * status, lifecycle and PATCH route refuses it (409). PATCH /cos/:id switches it on and off. Its
   * scope and tools follow its kind, so no run of another kind can ever act for it.
   */
  private notCos(t: Ticket, what: string) {
    if (t.kind === "cos") throw conflict(`${t.key} is a chief of staff, not a board ticket: it can't be ${what} (PATCH /cos/${t.id} switches it on or off)`);
  }

  /** Drafts have no agent and never run: anything that would act on one is refused (409). */
  private notDraft(t: Ticket, what: string) {
    if (t.draft) throw conflict(`${t.key} is a draft: it can't be ${what} until it's submitted (POST /tickets/${t.key}/submit)`);
  }

  /** The whole board, for the HTTP API and the service's own work: no scope narrows it. */
  private get everything(): ScopedStore {
    return new ScopedStore(this.store, "all");
  }

  /**
   * What the run's tools may see and act on. A chief of staff's scope is read from its `cos` row on
   * every call, never kept from when the run started, so moving a project between groups takes effect
   * at once; every other run sees the whole board. Throws when a chief of staff has no row (its
   * ticket outlived its group): it sees nothing rather than everything.
   */
  private scopeOf(ctx: ToolContext): ScopedStore {
    // A triage run reads what its chief reads, and nothing more.
    if (ctx.runKind === "triage") {
      const row = this.store.cos.get(this.triageRuns.get(ctx.session.id)?.cosId ?? "");
      const scope = row ? parseCosScopeKey(row.scope) : null;
      if (!scope) throw new Error("This triage run has no chief to read for.");
      return new ScopedStore(this.store, scope);
    }
    if (ctx.runKind !== "cos" && ctx.ticket?.kind !== "cos") return this.everything;
    const row = ctx.ticket ? this.store.cos.get(ctx.ticket.id) : null;
    const scope = row ? parseCosScopeKey(row.scope) : null;
    if (!scope) throw new Error("This chief of staff no longer covers anything: its group is gone.");
    return new ScopedStore(this.store, scope);
  }

  // --- terminals (chief of staff) ---

  /**
   * The terminals a chief of staff may see: those the kernel says are inside the worktree (or folder)
   * of a ticket it covers, after a fresh poll. Only the polled cwd counts: the cwd a shell's own
   * output sets (OSC 7) is whatever a program printed. The deepest folder over every ticket and
   * project owns a terminal, and the chief sees it only when that owner is a ticket it covers, so a
   * covered project folder that holds another group's project doesn't leak that one's shells. A
   * terminal under no owner is in no scope, not even all's: it may be a home directory shell with
   * tokens in its environment, and one that `cd`s out of its worktree leaves the scope.
   */
  private async terminalsInScope(ctx: ToolContext): Promise<{ info: TerminalInfo; cwd: string; ticket: Ticket }[]> {
    if (ctx.runKind !== "cos" && ctx.ticket?.kind !== "cos") throw new Error("Terminals are for a chief of staff.");
    const access = this.terminalAccess;
    if (!access) return [];
    const sc = this.scopeOf(ctx);
    await access.refresh();
    const resolved = new Map<string, string>();
    const real = (p: string) => {
      let r = resolved.get(p);
      if (r === undefined) resolved.set(p, (r = realPath(p).replace(/\/+$/, "")));
      return r;
    };
    const covered = new Set(sc.tickets.list().map((t) => t.id));
    const owners: { dir: string; ticket: Ticket | null }[] = [];
    for (const t of this.everything.tickets.list()) if (t.workdir && t.kind !== "cos") owners.push({ dir: real(t.workdir), ticket: covered.has(t.id) ? t : null });
    for (const p of this.store.projects.list()) owners.push({ dir: real(p.path), ticket: null });
    // Deepest first; at the same folder a ticket the chief covers wins over a project or another ticket.
    owners.sort((a, b) => b.dir.length - a.dir.length || Number(!!b.ticket) - Number(!!a.ticket));
    const out: { info: TerminalInfo; cwd: string; ticket: Ticket }[] = [];
    for (const info of access.list()) {
      const cwd = access.kernelCwd(info.id);
      if (!cwd) continue;
      const at = real(cwd);
      const owner = owners.find((o) => at === o.dir || at.startsWith(`${o.dir}/`));
      if (owner?.ticket) out.push({ info, cwd, ticket: owner.ticket });
    }
    return out;
  }

  /** The terminal as the caller may see it; a missing and an out-of-scope id read the same. */
  private async scopedTerminal(ctx: ToolContext, id: string) {
    const found = (await this.terminalsInScope(ctx)).find((t) => t.info.id === id);
    if (!found) throw new Error(`Unknown terminal: ${id}. Use list_terminals for the valid ids.`);
    return found;
  }

  /** Terminal-controlled text (a title, a program name) with control bytes and angle brackets replaced, so it can't pass for markup or break a line. */
  private plainTerminalText(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, "?").slice(0, 200);
  }

  private terminalView({ info, cwd, ticket }: { info: TerminalInfo; cwd: string; ticket: Ticket }): TerminalView {
    const plain = (s: string) => this.plainTerminalText(s);
    return { id: info.id, cwd: plain(cwd), title: plain(info.title), process: plain(info.process), state: info.state, exitCode: info.exitCode, ticketKey: ticket.key };
  }

  private async listTerminals_(ctx: ToolContext): Promise<TerminalView[]> {
    return (await this.terminalsInScope(ctx)).map((t) => this.terminalView(t));
  }

  private async readTerminal_(ctx: ToolContext, id: string, lines?: number) {
    const found = await this.scopedTerminal(ctx, id);
    return { terminal: this.terminalView(found), ...(await this.terminalAccess!.text(id, lines)) };
  }

  private async writeTerminal_(ctx: ToolContext, id: string, data: string): Promise<void> {
    const found = await this.scopedTerminal(ctx, id);
    if (found.info.state !== "running") throw new Error(`Terminal ${id} has exited`);
    this.terminalAccess!.writeAgent(id, data);
    // What was typed stays out of Activity: it may be a password.
    if (ctx.ticket) this.addActivityLine(ctx.ticket, "system", "agent", `Typed ${data.length} character${data.length === 1 ? "" : "s"} into terminal ${id} (${found.ticket.key})`);
  }

  // --- panes (chief of staff) ---

  /**
   * One change to the Mac's window splits. The refs are checked here against what the chief covers
   * (a ticket outside it, a terminal outside its worktrees and a missing one read the same) and the
   * covered set goes along, so the Mac refuses anything else and its layout names nothing else.
   * Ticket keys are sent as the board knows them.
   */
  private async arrangePanes_(ctx: ToolContext, op: PaneOp): Promise<PaneArrangeResult> {
    if (ctx.runKind !== "cos" && ctx.ticket?.kind !== "cos") throw new Error("Panes are for a chief of staff.");
    if (!this.macRequests) throw new Error("No Mac app is connected, so there is no window to arrange. Nothing was changed.");
    const sc = this.scopeOf(ctx);
    const terminals = (await this.terminalsInScope(ctx)).map((t) => t.info.id);
    const tickets = sc.tickets.list().filter((t) => !t.draft).map((t) => t.key);
    const checked = mapPaneRefs(op, (ref) => {
      if ("ticket" in ref) {
        const found = this.agentLookup(sc, ref.ticket)?.ticket;
        if (!found) throw new Error(`Unknown ticket: ${ref.ticket}`);
        return { ...ref, ticket: found.key };
      }
      if ("terminal" in ref && !terminals.includes(ref.terminal)) throw new Error(`Unknown terminal: ${ref.terminal}. Use list_terminals for the valid ids.`);
      return ref;
    });
    const reply = await this.macRequests.request({ kind: "panes.arrange", op: checked, allowed: { tickets, terminals } });
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  }

  /** The ticket an agent (tool) names, or null. Drafts are left out unless `drafts: true` (agents can read them, never act on them). */
  private agentLookup(sc: ScopedStore, key: string, opts: { drafts?: boolean } = {}): { ticket: Ticket; alias: string | null } | null {
    const found = sc.tickets.lookup(key);
    return found && (opts.drafts || !found.ticket.draft) ? found : null;
  }

  /** The ticket an agent's write tool acts on, or null when none has the key; a draft is refused by name. */
  private agentTarget(sc: ScopedStore, key: string): Ticket | null {
    const t = this.agentLookup(sc, key, { drafts: true })?.ticket ?? null;
    if (t?.draft) throw new Error(`${t.key} is a draft: agents can't act on it until the human submits it.`);
    return t;
  }

  /**
   * Tickets linked to a remote ID equal to `requested` or to `ticket`'s own remote ID, newest
   * first, without `ticket` itself. `drafts: false` leaves drafts out (what agents see). A remote
   * ID never resolves to a ticket (lookup is local keys only); this is how it points to them.
   */
  private relatedTickets(sc: ScopedStore, requested: string, ticket: Ticket | null, opts: { drafts?: boolean } = {}): Ticket[] {
    const remoteIds = new Set([requested.trim().toUpperCase(), ticket?.externalRef?.key?.trim().toUpperCase() ?? ""].filter(Boolean));
    const seen = new Set(ticket ? [ticket.id] : []);
    const out: Ticket[] = [];
    for (const k of remoteIds) {
      for (const t of sc.tickets.byExternalKey(k, opts)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  private relatedView(t: Ticket): RelatedTicket {
    return { key: t.key, title: t.title, status: t.status, projectId: t.projectId, externalKey: t.externalRef?.key ?? "" };
  }

  /** "MH-62 is a remote ID, not a local ticket key. Open MH-124 or MH-130." */
  private remoteOnlyMessage(requested: string, related: Ticket[]): string {
    const keys = related.map((t) => t.key);
    const list = keys.length <= 1 ? keys.join("") : `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}`;
    return `${requested} is a remote ID, not a local ticket key. Tickets linked to it: ${list}.`;
  }

  ticketDetail(key: string): TicketDetail {
    const found = this.store.tickets.lookup(key);
    if (!found) {
      const requested = String(key ?? "").trim().toUpperCase();
      const related = requested ? this.relatedTickets(this.everything, requested, null) : [];
      if (related.length) {
        throw new HarnessError(404, this.remoteOnlyMessage(requested, related), {
          requested,
          relatedTickets: related.map((t) => this.relatedView(t)),
        } satisfies RemoteKeyMatches);
      }
      throw notFound(`Unknown ticket: ${key}`);
    }
    const { ticket } = found;
    // Opening a ticket in review re-checks its worktree, so a commit made by hand shows up.
    if (ticket.status === "review") this.track(this.refreshHasChanges(ticket));
    return {
      ...(found.alias ? { resolvedFrom: found.alias } : {}),
      relatedTickets: this.relatedTickets(this.everything, found.alias ?? ticket.key, ticket).map((t) => this.relatedView(t)),
      ticket,
      session: this.store.sessions.get(ticket.sessionId)!,
      activity: this.store.activity.listBySession(ticket.sessionId),
      runs: this.store.runs.listBySession(ticket.sessionId),
      dependents: this.store.tickets.dependents(ticket.key).map((t) => t.key),
      children: this.store.tickets.list({ parentId: ticket.id }),
      parent: ticket.parentId ? this.store.tickets.get(ticket.parentId) : null,
      subagents: this.store.subagents.listBySession(ticket.sessionId),
      attachments: this.store.attachments.listByTicket(ticket.id),
    };
  }

  /**
   * The @-mention autocomplete for a new session in `projectId`: paths under the project folder.
   * `opts.ignored` is the file browser's search (node_modules too), `opts.kind` keeps one kind.
   */
  projectFiles(projectId: string, q: string, limit?: number | string | null, opts: SearchOptions = {}): Promise<FileMatch[]> {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    return searchPaths(project.path, q, clampLimit(limit, 50), opts);
  }

  /** The branch picker for a new session in `projectId`: local branches, most recent first (BranchInfo). */
  projectBranches(projectId: string, q: string, limit?: number | string | null): Promise<BranchInfo[]> {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    return listBranches(project.path, q, clampLimit(limit, 50));
  }

  /** The @-mention autocomplete for a follow-up: paths where the ticket's next run works (its worktree once it has one). */
  ticketFiles(key: string, q: string, limit?: number | string | null, opts: SearchOptions = {}): Promise<FileMatch[]> {
    const root = this.ticketRoot(key);
    return root ? searchPaths(root, q, clampLimit(limit, 50), opts) : Promise.resolve([]);
  }

  /**
   * The `/command` autocomplete for a new session in `projectId`: the slash commands and skills
   * `driverId`'s agent (default: the project's, then the settings') offers in the project folder.
   */
  async projectCommands(projectId: string, q: string, limit?: number | string | null, driverId?: string | null): Promise<CommandMatch[]> {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    const id = driverId || project.defaultDriver || this.settings().defaultDriver;
    const driver = this.drivers.get(id);
    if (!driver) throw badRequest(`Unknown driver: ${id}`);
    return rankCommands(await this.commandCatalog.get(driver, project.path), q.trim(), clampLimit(limit, 50));
  }

  /** The `/command` autocomplete for a follow-up: what the ticket's agent offers where its next run works. */
  async ticketCommands(key: string, q: string, limit?: number | string | null): Promise<CommandMatch[]> {
    const root = this.ticketRoot(key);
    const { ticket } = this.store.tickets.lookup(key)!;
    const driver = this.drivers.get(ticket.driver ?? this.store.sessions.get(ticket.sessionId)?.driver ?? "");
    if (!root || !driver) return [];
    return rankCommands(await this.commandCatalog.get(driver, root), q.trim(), clampLimit(limit, 50));
  }

  /** A file in the project folder for the file viewer (FileView). */
  projectFile(projectId: string, path: string): Promise<FileView> {
    return readFileView(this.projectRoot(projectId), path);
  }

  /** A project file's uncommitted changes (FileDiff); 409 outside a git repository. */
  projectFileDiff(projectId: string, path: string): Promise<FileDiff> {
    return readFileDiff(this.projectRoot(projectId), path);
  }

  /** A file where the ticket works (the same folder as ticketFiles) for the file viewer. */
  ticketFile(key: string, path: string): Promise<FileView> {
    return readFileView(this.requireTicketRoot(key), path);
  }

  ticketFileDiff(key: string, path: string): Promise<FileDiff> {
    return readFileDiff(this.requireTicketRoot(key), path);
  }

  /** Save a file in the project folder from the viewer's editor; last write wins. */
  writeProjectFile(projectId: string, body: unknown): Promise<FileWriteResult> {
    const { path, contents } = (body ?? {}) as { path?: unknown; contents?: unknown };
    return writeFileContents(this.projectRoot(projectId), path, contents);
  }

  /** Save a file where the ticket works (the folder ticketFile reads) from the viewer's editor. */
  writeTicketFile(key: string, body: unknown): Promise<FileWriteResult> {
    const { path, contents } = (body ?? {}) as { path?: unknown; contents?: unknown };
    return writeFileContents(this.requireTicketRoot(key), path, contents);
  }

  private projectRoot(projectId: string): string {
    const project = this.store.projects.get(projectId);
    if (!project) throw notFound(`Unknown project: ${projectId}`);
    if (!existsSync(project.path)) throw notFound(`The project folder ${project.path} doesn't exist`);
    return project.path;
  }

  /** Where the ticket's next run works: its worktree, else its session's cwd, else the project folder (the first that exists). */
  private ticketRoot(key: string): string | null {
    const found = this.store.tickets.lookup(key);
    if (!found) throw notFound(`Unknown ticket: ${key}`);
    const { ticket } = found;
    const session = this.store.sessions.get(ticket.sessionId);
    const project = this.store.projects.get(ticket.projectId);
    return [ticket.workdir, session?.cwd, project?.path].find((d): d is string => !!d && existsSync(d)) ?? null;
  }

  private requireTicketRoot(key: string): string {
    const root = this.ticketRoot(key);
    if (!root) throw notFound(`${key} has no folder on disk`);
    return root;
  }

  /** GET /tickets/:key/activity */
  activity(key: string): ActivityEntry[] {
    return this.store.activity.listBySession(this.requireTicket(key).sessionId);
  }

  /** GET /tickets/:key/spec/revisions: every revision's metadata, oldest first. */
  specRevisions(key: string): SpecRevisionInfo[] {
    return this.store.specs.list(this.requireTicket(key).id);
  }

  /**
   * GET /tickets/:key/spec/revisions/:rev: the revision with its body, or with `diff` (another
   * revision) the unified diff from `diff` to `rev`.
   */
  specRevision(key: string, rawRev: string, rawDiff?: string | null): SpecRevision | SpecDiff {
    const ticket = this.requireTicket(key);
    const revOf = (raw: string, what: string) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw badRequest(`${what} must be a revision number`);
      const r = this.store.specs.get(ticket.id, n);
      if (!r) throw notFound(`${ticket.key} has no spec revision ${n} (it's at ${ticket.specRevision ?? 1})`);
      return r;
    };
    const rev = revOf(rawRev, "rev");
    if (rawDiff === undefined || rawDiff === null || rawDiff === "") return rev;
    const other = revOf(rawDiff, "diff");
    return { from: other.rev, to: rev.rev, diff: unifiedDiff(other.body, rev.body, `${ticket.key} spec rev ${other.rev}`, `${ticket.key} spec rev ${rev.rev}`) };
  }

  /**
   * Legacy (iPhone apps before the attachment registry): the file of a ticket's prompt attachment
   * for GET /tickets/:key/prompt-attachments/:index, or null when the index is out of range or the
   * file is gone (moved, renamed or deleted). Newer apps use GET /attachments/:id.
   */
  promptAttachmentFile(key: string, rawIndex: string): { path: string; mimeType: string } | null {
    const ticket = this.requireTicket(key);
    if (!/^\d+$/.test(rawIndex)) throw badRequest("index must be a number");
    const a = (ticket.promptAttachments ?? [])[Number(rawIndex)];
    return a ? fileOf(a) : null;
  }

  /**
   * Legacy, like promptAttachmentFile: the file of an attachment sent with a message (transcript
   * entry `entryId`'s attachments at `rawIndex`) for GET /transcript/:entryId/attachments/:index,
   * or null when it's gone.
   */
  messageAttachmentFile(entryId: string, rawIndex: string): { path: string; mimeType: string } | null {
    if (!/^\d+$/.test(rawIndex)) throw badRequest("index must be a number");
    const entry = this.store.transcript.get(entryId);
    if (!entry) throw notFound("No such transcript entry");
    const a = entry.content.type === "text" ? entry.content.attachments?.[Number(rawIndex)] : undefined;
    return a ? fileOf(a) : null;
  }

  /** POST /uploads: store bytes (a paste, a browser screenshot, a file from another device) and register them. */
  uploadAttachment(bytes: Uint8Array, name: string | null, mimeType: string | null): Attachment {
    const a = storeUpload(this.paths.uploadsDir, bytes, name, mimeType);
    this.store.attachments.add(null, [a]);
    this.log(`upload ${a.path} (${bytes.byteLength} bytes)`);
    return a;
  }

  /**
   * POST /attachments: register a file already on the service's machine (a drop or pick on the
   * Mac when the service is local), referenced in place. The same file registered twice is the
   * same attachment.
   */
  registerAttachment(body: { path?: unknown; name?: unknown }): Attachment {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    if (typeof body.path !== "string" || !body.path) throw badRequest("path is required: an absolute path on the service's machine");
    if (body.name !== undefined && body.name !== null && typeof body.name !== "string") throw badRequest("name must be a string");
    return registerFile(this.store.attachments, this.paths.uploadsDir, body.path, body.name as string | null | undefined);
  }

  /** A list's attachments (AttachmentInput[]) as the list stores them; see resolveAttachments. */
  private resolveAttachments(raw: unknown, previous: readonly Attachment[] = []): Attachment[] {
    return resolveAttachments(raw, previous, this.store.attachments, this.paths.uploadsDir);
  }

  /**
   * Remove what nothing uses anymore (DESIGN.md "Attachments"), when the service starts: upload
   * folders no ticket refers to that are over a day old (pastes taken back out of a draft), and
   * the registry rows of uploads and registered files that are gone, or that nothing refers to and
   * are over a day old. "file" sources are only forgotten, never deleted. Returns the upload
   * folders removed.
   */
  sweepUploads(at = this.now()): string[] {
    const referenced = this.referencedAttachments();
    // Folders age by filesystem mtime, which only real time can be compared to; registry rows age by the injected clock.
    const removed = sweepUploads(this.paths.uploadsDir, referenced.paths, ORPHAN_UPLOAD_AGE_MS, Date.now());
    const forget = this.store.attachments
      .listUnowned()
      .filter((a) => !fileOf(a) || (!referenced.ids.has(a.id) && !referenced.paths.has(a.path) && at - a.createdAt >= ORPHAN_UPLOAD_AGE_MS))
      .map((a) => a.id);
    if (forget.length) this.store.attachments.delete(forget);
    if (removed.length) this.log(`removed ${removed.length} unused upload${removed.length === 1 ? "" : "s"}`);
    return removed;
  }

  /**
   * Every attachment some ticket (drafts included) refers to, but `except`'s: by id and by path.
   * Two tickets can share an upload: a conductor passes a pasted screenshot on to a child with
   * create_ticket, or a human sends a file from an earlier message again, so an upload folder is
   * only removed once nothing names it.
   */
  private referencedAttachments(except?: Ticket): { ids: Set<string>; paths: Set<string> } {
    const ids = new Set<string>();
    const paths = new Set<string>();
    const add = (a: Attachment) => {
      if (a.id) ids.add(a.id);
      paths.add(a.path);
    };
    for (const t of this.store.tickets.list({ includeCos: true })) {
      if (t.id === except?.id) continue;
      for (const a of t.promptAttachments ?? []) add(a);
      // Files waiting in a message draft.
      for (const a of t.messageDraft?.attachments ?? []) add(a);
    }
    // Files sent with messages, which a conductor can pass on the same way.
    for (const m of this.store.transcript.messageAttachments()) if (m.sessionId !== except?.sessionId) add(m.attachment);
    for (const m of this.store.runs.messageAttachments()) if (m.sessionId !== except?.sessionId) add(m.attachment);
    return { ids, paths };
  }

  /**
   * Any registered attachment and its file for GET /attachments/:id (spec media, uploads,
   * registered files, files sent with messages), or null when either is gone.
   */
  attachmentFile(id: string): { attachment: Attachment; path: string; mimeType: string } | null {
    const attachment = this.store.attachments.get(id);
    if (!attachment) return null;
    const file = fileOf(attachment);
    return file ? { attachment, path: file.path, mimeType: file.mimeType } : null;
  }

  async createTicket(body: CreateTicketBody, by: ActivityAuthor = "human"): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const project = this.store.projects.get(body.projectId);
    if (!project || this.store.projects.isInternal(project.id)) throw notFound(`Unknown project: ${body.projectId}`);
    const prompt = typeof body.spec === "string" ? body.spec : "";
    const draft = validBoolean("draft", body.draft) ?? false;
    if (!draft && !prompt.trim() && !body.title?.trim()) throw badRequest("spec is required");
    const kind = body.kind ?? "task";
    if (kind !== "task" && kind !== "conductor") throw badRequest(`Invalid kind: ${kind}`);
    const phaseModels = this.ticketPhaseModels({}, body, project);
    const driver = resolvePhaseChoice("work", { ticket: phaseModels, project: project.phaseModels, settings: this.settings().phaseModels }).driver;
    if (!this.drivers.has(driver)) throw badRequest(`Unknown driver: ${driver}`);
    const permissionMode = validPermissionMode(body.permissionMode);
    const useWorktree = validUseWorktree(body.useWorktree);
    const baseBranch = validateBranchName("baseBranch", body.baseBranch);
    const requestedBranch = validateBranchName("branch", body.branch);
    // Left out, each review follows the project's default for new tickets.
    const skipAgentReview = validBoolean("skipAgentReview", body.skipAgentReview) ?? !!project.skipAgentReview;
    const skipHumanReview = validBoolean("skipHumanReview", body.skipHumanReview) ?? !!project.skipHumanReview;
    if (requestedBranch && !(useWorktree ?? project.useWorktrees)) {
      throw badRequest(`branch ${requestedBranch} needs a worktree, but this ticket would run in the project checkout (useWorktree is off)`);
    }
    if (requestedBranch && project.isGit === false) throw badRequest(`branch ${requestedBranch} needs a git repository; ${project.path} isn't one`);
    const dependsOn = this.validateDeps(body.dependsOn ?? []);
    const promptAttachments = body.promptAttachments === undefined ? [] : this.resolveAttachments(body.promptAttachments);
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
        spec: prompt,
        status: "planning",
        sessionId: session.id,
        driver,
        parentId,
        dependsOn,
        autoStart: autoStart || (start && dependsOn.length > 0),
        externalRef: body.externalRef ?? null,
        workdir: null,
        phaseModels,
        useWorktree,
        baseBranch,
        requestedBranch,
        skipAgentReview,
        skipHumanReview,
        draft,
        promptAttachments,
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
    await this.launch(ticket, start, prompt, by);
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * A new (or just submitted) ticket's first step: start work when asked to (or autoStart) and its
   * dependencies are done, wait on them otherwise, or plan first.
   */
  private async launch(ticket: Ticket, start: boolean, prompt: string, by: ActivityAuthor) {
    const depsDone = this.depsDone(ticket);
    if ((start || ticket.autoStart) && depsDone) {
      await this.begin(ticket, prompt, {}, undefined, [], by);
    } else if (start || ticket.autoStart) {
      this.appendStatus(ticket.sessionId, null, this.waitingOnLine(ticket));
    } else {
      this.enqueueRun(ticket.sessionId, "plan", prompt);
    }
  }

  /**
   * Launch a draft (POST /tickets/:key/submit): it stops being a draft and goes the way a ticket
   * created with the same `start` would. Its spec is the first run's message.
   */
  async submitTicket(key: string, body: SubmitTicketBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    const start = validBoolean("start", body.start);
    if (start === undefined) throw badRequest("start must be true or false");
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "submitted");
    if (!ticket.draft) throw conflict(`${ticket.key} isn't a draft; it was already submitted`);
    const prompt = ticket.spec;
    if (!prompt.trim()) throw badRequest("spec is required");
    const launched = this.store.tickets.update(ticket.id, { draft: false, autoStart: start && ticket.dependsOn.length > 0 })!;
    this.touchSession(launched.sessionId);
    this.appendStatus(launched.sessionId, null, "Ticket created");
    await this.launch(launched, start, prompt, "human");
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

  /**
   * PATCH /tickets/:key. A spec change is a new revision written by `as` (the human, unless an
   * agent's update_ticket sent it): `baseRevision` is required for it outside drafts, and a spec
   * that moved on since answers 409 with the current revision (SpecConflict).
   */
  async updateTicket(key: string, body: UpdateTicketBody, as: SpecAuthorship = { author: "human" }): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    let ticket = this.requireTicket(key);
    this.notCos(ticket, "changed here");
    for (const field of ["kind", "useWorktree", "projectId", "promptAttachments"] as const) {
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
    let spec: string | undefined;
    if (body.spec !== undefined) {
      if (typeof body.spec !== "string") throw badRequest("spec must be text");
      spec = body.spec;
      if (!ticket.draft && body.baseRevision === undefined) throw badRequest("baseRevision is required with spec: the revision your edit started from (Ticket.specRevision)");
      if (body.baseRevision !== undefined && (!Number.isInteger(body.baseRevision) || body.baseRevision < 1)) throw badRequest("baseRevision must be a revision number");
      if (body.specNote !== undefined && typeof body.specNote !== "string") throw badRequest("specNote must be text");
      // A draft's title follows its spec until someone names it.
      if (ticket.draft && body.title === undefined && (ticket.title === UNTITLED_DRAFT || ticket.title === draftTitle(ticket.spec))) {
        patch.title = draftTitle(spec);
      }
    }
    if (body.kind !== undefined && body.kind !== ticket.kind) patch.kind = body.kind;
    if (body.promptAttachments !== undefined) {
      patch.promptAttachments = this.resolveAttachments(body.promptAttachments, ticket.promptAttachments ?? []);
    }
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
    if (body.driver !== undefined || body.model !== undefined || body.phaseModels !== undefined || moveTo) {
      const project = projectOf();
      const phaseModels = this.ticketPhaseModels(ticket.phaseModels ?? {}, body, project ?? null, ticket);
      if (body.driver !== undefined || body.model !== undefined || body.phaseModels !== undefined) patch.phaseModels = phaseModels;
      const work = resolvePhaseChoice("work", { ticket: phaseModels, project: project?.phaseModels, settings: this.settings().phaseModels });
      this.store.sessions.update(ticket.sessionId, { driver: work.driver });
    }
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
    const skipHuman = validBoolean("skipHumanReview", body.skipHumanReview);
    if (skipHuman !== undefined && skipHuman !== !!ticket.skipHumanReview) patch.skipHumanReview = skipHuman;
    if (body.status !== undefined && !TICKET_STATUSES.includes(body.status)) throw badRequest(`Invalid status: ${body.status}`);
    if (body.status === "in_progress" && body.status !== ticket.status) {
      throw badRequest("Work doesn't start by setting the status: use POST /tickets/:key/start to start it, or POST /tickets/:key/reopen to re-open a done ticket");
    }
    const externalRef = body.externalRef !== undefined ? this.manualExternalRef(ticket.externalRef, body.externalRef) : undefined;
    const pullRequestUrls = body.pullRequestUrls !== undefined ? this.validPullRequestUrls(body.pullRequestUrls) : undefined;
    // The spec first: a conflict refuses the whole PATCH before anything else changed.
    if (spec !== undefined) {
      if (ticket.draft) {
        if (spec !== ticket.spec) {
          this.store.specs.replaceDraft(ticket.id, spec);
          this.touchTicket(ticket.id);
        }
      } else {
        this.reviseSpec(ticket, { body: spec, baseRevision: body.baseRevision, note: body.specNote?.trim() || (as.author === "human" ? "Edited by hand" : "Rewritten with update_ticket"), ...as });
      }
      ticket = this.store.tickets.get(ticket.id)!;
    }
    if (moveTo) ticket = this.moveDraft(ticket, moveTo);
    if (externalRef !== undefined) {
      const before = ticket.externalRef?.key ?? null;
      ticket = this.store.tickets.setExternalRef(ticket.id, externalRef)!;
      const after = externalRef?.key ?? null;
      if (after !== before) this.appendStatus(ticket.sessionId, null, after ? `Linked to ${after}` : `Unlinked from ${before}`);
      this.touchSession(ticket.sessionId);
    }
    if (pullRequestUrls !== undefined) {
      const change = this.store.tickets.setPullRequestUrls(ticket.id, pullRequestUrls)!;
      ticket = change.ticket;
      this.touchTicket(ticket.id);
      if (change.added.length || change.removed.length) {
        const parts = [
          change.added.length ? `Added ${change.added.join(", ")}` : "",
          change.removed.length ? `Removed ${change.removed.join(", ")}` : "",
        ].filter(Boolean);
        this.appendStatus(ticket.sessionId, null, `Pull requests: ${parts.join("; ")}`);
        this.touchSession(ticket.sessionId);
      }
      this.fetchPullRequestTitles(ticket.id, change.added);
    }
    if (Object.keys(patch).length) {
      ticket = this.store.tickets.update(ticket.id, patch)!;
      if (patch.title) this.store.sessions.update(ticket.sessionId, { title: patch.title });
      this.touchSession(ticket.sessionId);
    }
    if (patch.skipAgentReview !== undefined) ticket = await this.applySkipAgentReview(ticket);
    if (patch.skipHumanReview !== undefined) ticket = this.applySkipHumanReview(ticket);
    if (body.status !== undefined && body.status !== ticket.status) {
      switch (body.status) {
        case "done":
          this.transition(ticket, "done", { blockedReason: null }, "Moved to done", undefined, { by: as.author, line: "" });
          break;
        case "blocked":
          this.transition(ticket, "blocked", {}, "Moved to blocked", undefined, { by: as.author, line: "" });
          break;
        case "review":
          this.transition(ticket, "review", {}, "Moved to review", undefined, { by: as.author, line: "" });
          break;
        case "planning":
          this.transition(ticket, "planning", { blockedReason: null }, "Moved to planning", undefined, { by: as.author, line: "" });
          break;
      }
    }
    if (patch.dependsOn) this.kickScheduler();
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * Fetch the titles of pull requests that were never checked (the migration's links, and links
   * saved while gh was unavailable are not retried here: refresh does that).
   */
  private backfillPullRequestTitles() {
    const byTicket = new Map<string, string[]>();
    for (const { id, url } of this.store.tickets.unfetchedPullRequestUrls()) {
      byTicket.set(id, [...(byTicket.get(id) ?? []), url]);
    }
    for (const [id, urls] of byTicket) this.fetchPullRequestTitles(id, urls);
  }

  /**
   * Look up these links' titles in the background (saving never waits on GitHub), then write them
   * onto the links still in the list and tell the apps. idle() waits for it.
   */
  private fetchPullRequestTitles(ticketId: string, urls: string[]): Promise<void> {
    if (!urls.length) return Promise.resolve();
    const job = (async () => {
      const titles = new Map<string, string | null>();
      for (const url of urls) {
        // A fetch that couldn't run (gh missing, spawn failed) leaves the link unchecked, so the next
        // start's backfill tries it again. A null title means gh answered without one.
        const title = await this.withTitleSlot(() => this.fetchTitle(url)).catch((err) => {
          this.log(`pull request title for ${url} couldn't be fetched: ${errMsg(err)}`);
          return undefined;
        });
        if (title !== undefined) titles.set(url, title);
      }
      const ticket = this.store.tickets.applyPullRequestTitles(ticketId, titles, this.now());
      if (ticket) this.bus.emit({ kind: "ticket.upserted", ticket });
    })().catch((err) => this.log(`pull request titles for ${ticketId} failed: ${errMsg(err)}`));
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
    return job;
  }

  /**
   * Runs at most TITLE_FETCH_SLOTS title lookups (gh processes) at once, across all tickets, so a
   * start that backfills many links or a burst of saves doesn't spawn them all together.
   */
  private async withTitleSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.titleSlotsInUse >= TITLE_FETCH_SLOTS) {
      await new Promise<void>((wake) => this.titleSlotWaiters.push(wake));
    } else {
      this.titleSlotsInUse++;
    }
    try {
      return await run();
    } finally {
      // Hand the slot straight to the next waiter; it stays in use.
      const next = this.titleSlotWaiters.shift();
      if (next) next();
      else this.titleSlotsInUse--;
    }
  }

  /**
   * Fetch every pull request title on the ticket again (POST /tickets/:key/pull-requests/refresh).
   * A refresh already running for the ticket answers with the same ticket and starts nothing new,
   * so repeated taps don't stack gh batches.
   */
  refreshPullRequestTitles(key: string): Ticket {
    const ticket = this.requireTicket(key);
    if (this.titleRefreshesInFlight.has(ticket.id)) return ticket;
    const urls = ticket.pullRequests.map((pr) => pr.url);
    if (!urls.length) return ticket;
    this.titleRefreshesInFlight.add(ticket.id);
    void this.fetchPullRequestTitles(ticket.id, urls)!.finally(() => this.titleRefreshesInFlight.delete(ticket.id));
    return ticket;
  }

  /**
   * A PATCH's pullRequestUrls: each must be an http(s) link. Trimmed, duplicates dropped, order
   * kept. Titles aren't accepted; the service fetches them.
   */
  private validPullRequestUrls(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((url) => typeof url !== "string")) {
      throw badRequest("pullRequestUrls must be a list of pull request URLs");
    }
    const out: string[] = [];
    for (const raw of value as string[]) {
      const url = raw.trim();
      if (!PULL_REQUEST_URL.test(url)) throw badRequest(`Not a pull request link: ${raw} (it must start with http:// or https://)`);
      if (!out.includes(url)) out.push(url);
    }
    return out;
  }

  /**
   * PATCH externalRef: a remote ID set by hand ({ key, url? }, source "manual"), or null to unlink.
   * The key is upper-cased and must look like FOO-123. Changing only the link of the remote ID
   * the ticket already carries (`current`) keeps where it came from (a watcher's source and raw item).
   * create_ticket's remote_id goes through here too, with no current link.
   */
  private manualExternalRef(current: ExternalRef | null, input: UpdateTicketBody["externalRef"]): ExternalRef | null {
    if (input === null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("externalRef must be { key, url? } or null");
    if (typeof input.key !== "string") throw badRequest("externalRef.key must be a remote ID like FOO-123");
    const key = input.key.trim().toUpperCase();
    if (!isTicketKey(key)) throw badRequest(`Invalid remote ID: ${input.key} (expected a key like FOO-123)`);
    if (input.url !== undefined && input.url !== null && typeof input.url !== "string") throw badRequest("externalRef.url must be a string or null");
    const url = input.url?.trim() || null;
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw badRequest("externalRef.url must be an http(s) link");
    if (current && current.key.toUpperCase() === key) return { ...current, key, url };
    return { source: "manual", key, url, raw: null };
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

  /**
   * Delete a ticket. The chiefs of staff hear of it (the ticket's Activity goes with it, so the delete
   * records the event itself) unless `quiet`: a project delete records one event for all its tickets.
   */
  async deleteTicket(key: string, quiet = false) {
    const ticket = this.requireTicket(key);
    if (ticket.kind === "cos") throw conflict(`${ticket.key} is a chief of staff, not a board ticket: switch it off (PATCH /cos/${ticket.id}) instead of deleting it`);
    const project = this.store.projects.get(ticket.projectId);
    if (!quiet) this.cosEngine.drain(); // what was written about it is read before the delete cascades it away
    await this.removeTicket(ticket);
    if (!quiet) this.cosEngine.addDeleted({ what: "ticket", id: ticket.id, label: ticket.key, title: ticket.title, actor: this.actorContext.getStore() ?? "human", project, keepsProject: true });
  }

  private pruning: Promise<void> = Promise.resolve();

  /**
   * Tear down the chiefs of staff whose group lost its last project, then the emptied groups. Runs
   * one at a time; a project PATCH starts it without waiting, and awaiting it waits for that too.
   */
  pruneCos(): Promise<void> {
    this.pruning = this.pruning.then(async () => {
      const orphaned = (id: string) => this.store.projects.orphanedCosTickets().includes(id);
      for (const id of this.store.projects.orphanedCosTickets()) {
        const ticket = this.store.tickets.get(id);
        // Re-checked per ticket and again before the delete: a project may move into the group meanwhile.
        if (ticket && orphaned(id)) await this.removeTicket(ticket, () => orphaned(id));
      }
      this.store.projects.pruneGroups();
      this.rehomeCosEvents(); // a removed chief's events go to whoever is next in line
    });
    this.pruning = this.pruning.catch((err) => this.log(`pruning chiefs of staff failed: ${errMsg(err)}`));
    return this.pruning;
  }

  /** Cancel the ticket's run and remove it with its session, files and uploads (the guard against deleting a chief of staff is in deleteTicket). */
  private async removeTicket(ticket: Ticket, stillWanted?: () => boolean) {
    await this.cancelSession(ticket.sessionId, true);
    for (const child of this.store.tickets.list({ parentId: ticket.id })) {
      this.store.db.query("UPDATE tickets SET parent_id = NULL WHERE id = $id").run({ id: child.id });
      this.touchTicket(child.id);
    }
    this.conductorBuffer.delete(ticket.id);
    await this.browser.close(ticket.sessionId).catch(() => {});
    if (stillWanted && !stillWanted()) return; // the awaits above let the world change (a chief of staff's group gained a project)
    // Its spec media go with it (their rows cascade), even when another ticket's message sent one
    // on by id: there it becomes a missing file, like a moved "file". Copying it would keep a
    // deleted ticket's screenshots around for good.
    const files = this.store.attachments.listByTicket(ticket.id).map((a) => a.path);
    // Its uploads, except any another ticket still uses (by id, or by path from an older list).
    const still = this.referencedAttachments(ticket);
    const stillUsed = new Set(uploadDirs(this.paths.uploadsDir, [...still.paths].map((path) => ({ path, source: "upload" as const }))));
    const sent = [...this.store.transcript.messageAttachments(ticket.sessionId), ...this.store.runs.messageAttachments().filter((m) => m.sessionId === ticket.sessionId)].map((m) => m.attachment);
    const own = [...(ticket.promptAttachments ?? []), ...(ticket.messageDraft?.attachments ?? []), ...sent].filter((a) => a.source === "upload" && !still.ids.has(a.id));
    const uploads = uploadDirs(this.paths.uploadsDir, own).filter((d) => !stillUsed.has(d));
    const goneIds = own.filter((a) => uploads.some((d) => a.path.startsWith(d + "/"))).map((a) => a.id);
    this.store.transaction(() => {
      this.store.tickets.delete(ticket.id);
      this.store.sessions.delete(ticket.sessionId);
      this.store.attachments.delete(goneIds);
    });
    removeAttachmentFiles(files);
    removeUploadDirs(uploads);
    rmSync(join(this.paths.scratchDir, ticket.sessionId), { recursive: true, force: true });
    this.bus.emit({ kind: "ticket.deleted", id: ticket.id });
    this.bus.emit({ kind: "session.deleted", id: ticket.sessionId });
    if (ticket.parentId) this.touchTicket(ticket.parentId); // its childCount changed
    this.kickScheduler();
  }

  async startTicket(key: string, by: ActivityAuthor = "human"): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "started");
    this.notDraft(ticket, "started");
    this.notCompacting(ticket, "started");
    if (ticket.status === "in_progress") throw conflict(`${ticket.key} is already in progress`);
    if (ticket.status === "done" || ticket.status === "review") throw conflict(`${ticket.key} is in ${ticket.status}; it cannot be started`);
    // A plan run is still going: the press approves the plan, and the work starts when the run
    // ends (schedule()). The ticket stays in planning with the plan run undisturbed.
    if (ticket.status === "planning" && ticket.busy) {
      if (ticket.startAfterPlan) return ticket; // already approved
      return this.approvePlan(ticket, by);
    }
    // A planning ticket with open dependencies is queued, not started: it stays in planning with
    // autoStart on, and the scheduler starts it once they're done (as `start` does on create).
    if (ticket.status === "planning" && !this.depsDone(ticket)) {
      if (ticket.autoStart) return ticket; // already waiting
      const queued = this.store.tickets.update(ticket.id, { autoStart: true })!;
      this.touchTicket(queued.id);
      this.appendStatus(queued.sessionId, null, this.waitingOnLine(queued));
      return this.store.tickets.get(ticket.id)!;
    }
    await this.begin(ticket, this.prompts().workStartPrompt(ticket), {}, undefined, [], by);
    return this.store.tickets.get(ticket.id)!;
  }

  /** Approve the plan a planning run is writing: work starts when the run ends (schedule()). */
  private approvePlan(ticket: Ticket, by: ActivityAuthor): Ticket {
    const approved = this.store.tickets.update(ticket.id, { startAfterPlan: true, startAfterPlanBy: by === "agent" ? "agent" : "human" })!;
    this.touchTicket(approved.id);
    this.addActivityLine(approved, "system", by, "Plan approved; work starts when planning finishes");
    return approved;
  }

  /**
   * Cancel a planning ticket's automatic start: the plan approval and the dependency queue. It
   * stays in planning (a running plan run is left alone), and Start / Approve plan offer again.
   */
  cancelStart(key: string): Ticket {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "cancelled");
    this.notDraft(ticket, "cancelled (it doesn't start by itself)");
    if (ticket.status !== "planning") throw conflict(`${ticket.key} is in ${ticket.status}; only a planning ticket has an automatic start to cancel`);
    if (this.starting.has(ticket.id)) throw conflict(`${ticket.key} is already starting`);
    if (!ticket.autoStart && !ticket.startAfterPlan) throw conflict(`${ticket.key} is not set to start automatically`);
    const queued = ticket.autoStart && !this.depsDone(ticket);
    this.dropPlanApproval(ticket.id, "Plan approval cleared: automatic start cancelled");
    let t = this.store.tickets.get(ticket.id)!;
    if (t.autoStart) {
      t = this.store.tickets.update(t.id, { autoStart: false })!;
      this.touchTicket(t.id);
      this.addActivityLine(t, "system", "human", "Automatic start cancelled");
    }
    if (queued) this.appendStatus(t.sessionId, null, "Automatic start cancelled");
    return this.store.tickets.get(ticket.id)!;
  }

  /**
   * Take back a human review approval (or the standing auto-approval of skipHumanReview) while the
   * complete run hasn't started: the ticket waits for a human again.
   */
  withdrawApproval(key: string): Ticket {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "changed");
    this.notDraft(ticket, "changed");
    this.notCompleting(ticket, "taken back to human review");
    const standing = ticket.status === "in_progress" && ticket.skipHumanReview;
    const approved = ticket.status === "review" && ticket.humanReview === "approved";
    if (!standing && !approved) throw conflict(`${ticket.key} has no human review approval to withdraw`);
    // The approval was the flag's: leave it on and the next submit would approve again.
    const patch: TicketPatch = {};
    if (ticket.skipHumanReview) patch.skipHumanReview = false;
    // The approver's completion choice goes with the approval, so the next one doesn't reuse it.
    if (approved) Object.assign(patch, { humanReview: "pending", completionAction: null, completionInstructions: null });
    const t = this.store.tickets.update(ticket.id, patch)!;
    this.touchSession(t.sessionId);
    this.appendStatus(t.sessionId, null, "Human review: waiting on a human again");
    this.addActivityLine(t, "system", "human", "Human review approval withdrawn");
    return this.store.tickets.get(ticket.id)!;
  }

  /** Withdraw a plan approval (the run was cancelled, failed or is answering a message), saying why. */
  private dropPlanApproval(ticketId: string, why: string) {
    const t = this.store.tickets.get(ticketId);
    if (!t?.startAfterPlan) return;
    const cleared = this.store.tickets.update(t.id, { startAfterPlan: false, startAfterPlanBy: null })!;
    this.touchTicket(cleared.id);
    this.addActivityLine(cleared, "system", "system", why);
  }

  /**
   * A human message to the ticket's agent (DESIGN.md "Messages"). The ticket stays where it is:
   *  - planning: the plan run takes it (plan mode; it revises the plan),
   *  - in progress: the running work takes it, or a new work run,
   *  - blocked, review, done: a chat run with the ticket's work tools, whose agent moves the
   *    ticket itself (unblock once the block is resolved, resume_work before changing reviewed work, submit_for_review, block).
   * A message to a ticket waiting on a tool approval answers it as a deny.
   * The message goes to the agent and the transcript, never to Activity (older apps' `log` flag is
   * ignored). Older apps may also send `move`, from the composer switch they had: it still sends a
   * review ticket back to in progress, or re-opens a done one, before the run starts. Today's apps
   * move a ticket with Request changes and Re-open instead.
   */
  async sendMessage(key: string, text: string, opts: { move?: boolean; attachments?: unknown; fromApp?: boolean; author?: ActivityAuthor } = {}): Promise<Ticket> {
    const sent = await this.deliverMessage(key, text, opts);
    // The human's message went: the draft they wrote it in is used up, on every device. An
    // agent's message_ticket leaves the human's draft alone.
    if (!opts.fromApp || !sent.messageDraft) return sent;
    const t = this.store.tickets.setMessageDraft(sent.id, null)!;
    this.bus.emit({ kind: "ticket.upserted", ticket: t });
    return t;
  }

  /**
   * Save the message the human is writing to the ticket (DESIGN.md "Message drafts"): the whole
   * draft, last write wins. Empty text and no attachments clear it. A save that changes nothing
   * emits nothing.
   */
  saveMessageDraft(key: string, body: MessageDraftBody): Ticket {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    if (body.text !== undefined && typeof body.text !== "string") throw badRequest("text must be a string");
    if (body.origin !== undefined && body.origin !== null && (typeof body.origin !== "string" || body.origin.length > 200)) {
      throw badRequest("origin must be a string of at most 200 characters");
    }
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "given a message draft (it has no agent yet)");
    const previous = ticket.messageDraft ?? null;
    const text = body.text ?? "";
    const attachments = body.attachments === undefined || body.attachments === null ? [] : this.resolveAttachments(body.attachments, previous?.attachments ?? []);
    const origin = body.origin || null;
    const next: MessageDraft | null = text || attachments.length ? { text, attachments, origin, updatedAt: this.now() } : null;
    const same =
      next === null
        ? previous === null
        : previous !== null && previous.text === next.text && previous.origin === next.origin && canonicalJson(previous.attachments) === canonicalJson(next.attachments);
    if (same) return ticket;
    const t = this.store.tickets.setMessageDraft(ticket.id, next)!;
    this.bus.emit({ kind: "ticket.upserted", ticket: t });
    return t;
  }

  private async deliverMessage(key: string, text: string, opts: { move?: boolean; attachments?: unknown; author?: ActivityAuthor }): Promise<Ticket> {
    if (text !== undefined && typeof text !== "string") throw badRequest("text must be a string");
    text = text ?? "";
    const ticket = this.requireTicket(key);
    const attachments = opts.attachments === undefined || opts.attachments === null ? [] : this.resolveAttachments(opts.attachments);
    if (!text.trim() && !attachments.length) throw badRequest("text is required");
    this.notDraft(ticket, "messaged (it has no agent yet)");
    this.notCompacting(ticket, "messaged");
    if (ticket.kind === "cos" && this.store.cos.get(ticket.id)?.enabled === false) throw conflict(`${ticket.key} is switched off: turn it on to talk to it`);
    if (ticket.pendingApproval) {
      if (attachments.length) throw conflict(`${ticket.key} is waiting on a tool approval: answer it before sending attachments`);
      return this.answerApproval(ticket.key, { decision: "deny", message: text });
    }
    // A message to a chief isn't about one project, so its run takes the app's model, not the project of the wake before it.
    if (ticket.kind === "cos") this.cosWakeProject.delete(ticket.id);
    this.notCompleting(ticket, "messaged");
    this.autoRetries.delete(ticket.id);
    this.resetRejections(ticket);
    const sent = { text, attachments };
    switch (ticket.status) {
      case "planning":
        // The message can change the plan: the approval was for the plan as it stood.
        this.dropPlanApproval(ticket.id, "Plan approval withdrawn: a message may change the plan");
        await this.steerOrEnqueue(ticket.sessionId, "plan", sent);
        break;
      case "in_progress":
        await this.steerOrEnqueue(ticket.sessionId, this.workKind(ticket), sent);
        break;
      case "review":
        if (!opts.move) {
          await this.chat(ticket, sent);
          break;
        }
        this.transition(
          ticket,
          "in_progress",
          { agentReview: "pending", humanReview: "pending", blockedReason: null },
          `Moved back to in progress (human message)`,
          undefined,
          { by: "human", line: "Sent back to work with a message" },
        );
        this.enqueueRun(ticket.sessionId, this.workKind(ticket), text, undefined, { attachments });
        break;
      case "done":
        if (opts.move) {
          this.addActivity(ticket, "reopened", "human", "Re-opened by a message", this.moveMeta(ticket, "in_progress"));
          await this.reopen(ticket, text, "Re-opened by human message", attachments);
        } else await this.chat(ticket, sent);
        break;
      case "blocked":
        this.recordAnswer(ticket, text, opts.author ?? "human");
        await this.chat(ticket, sent);
        break;
    }
    return this.store.tickets.get(ticket.id)!;
  }

  /** A reply to a blocked ticket, in Activity beside the question it answers, by whoever sent it (what a chief of staff's query_activity reads). */
  private recordAnswer(ticket: Pick<Ticket, "id" | "sessionId">, reply: string, author: ActivityAuthor) {
    const question = this.store.activity.latestOfKind(ticket.sessionId, "blocked");
    if (question && reply.trim()) this.addActivityLine(ticket, "answered", author, reply, { answers: question.id });
  }

  /**
   * The message goes to a chat run: the ticket's own agent, conversation and work tools, with its
   * status unchanged.
   * A blocked ticket that never got a worktree (or lost it) gets one first, so the agent can work.
   */
  private async chat(ticket: Ticket, message: SentMessage) {
    if (ticket.status === "blocked" && (!ticket.workdir || (ticket.branch && !existsSync(ticket.workdir)))) {
      const error = await this.prepareWorkdir(ticket);
      if (error) {
        this.addActivityLine(ticket, "failed", "system", error);
        this.store.tickets.update(ticket.id, { blockedReason: error });
        this.touchSession(ticket.sessionId);
        return;
      }
    }
    await this.steerOrEnqueue(ticket.sessionId, ticket.kind === "cos" ? "cos" : "chat", message);
  }

  /**
   * What the agent reads with a human's message to a blocked ticket (the transcript shows only the
   * message): the ticket's question, and when to unblock.
   */
  private blockedNote(t: Ticket | null): string {
    if (t?.status !== "blocked") return "";
    const reason = t.blockedReason?.trim();
    return `\n\n[Harness note: this ticket is blocked${reason ? ` on: ${reason}` : ""}. If this message resolves that, call unblock before you continue the work; if it doesn't, answer and leave the ticket blocked.]`;
  }

  /**
   * What the agent reads when its ticket's worktree is gone and the run started in `cwd` instead
   * (DESIGN.md "Ticket lifecycle"): where the worktree was, whether its branch is still there and
   * already in the base branch, and on a review the last commit an earlier round checked. The
   * harness repairs nothing; the agent recreates the worktree when it needs one. A done ticket's
   * worktree was removed on purpose, so a chat about it gets no note.
   */
  private async missingWorktreeNote(t: Ticket, kind: RunKind, cwd: string, project: Project | null): Promise<string> {
    if (!t.workdir || t.status === "done") return "";
    const repo = project?.path ?? cwd;
    const branch = t.branch ?? t.requestedBranch ?? branchForKey(t.key);
    const base = (await this.refreshBaseBranch(t, project)).branch;
    const reviewed = kind === "review" ? this.lastReviewedCommit(t) : null;
    const exists = await branchExists(repo, branch);
    const tip = exists ? branch : reviewed;
    const landed = !!tip && (await isAncestor(repo, tip, base));
    const lines = [
      `this ticket's worktree at ${t.workdir} is missing, so this run started in ${cwd}, the project checkout.`,
      `Branch \`${branch}\` ${exists ? "still exists" : "no longer exists"}${tip ? `, and ${exists ? "it" : `commit ${tip}`} ${landed ? "is already" : "isn't"} in the base branch \`${base}\`` : ""}.`,
    ];
    if (reviewed) lines.push(`The last commit an earlier review round checked is ${reviewed}.`);
    if (kind === "complete") {
      lines.push(`A completion doesn't need the worktree back: do what it asks from the project checkout with \`git -C ${repo}\`. If the work already landed and the branch is gone, there is nothing left to merge or remove; say so.`);
    } else {
      const add = exists ? `git -C ${repo} worktree add ${t.workdir} ${branch}` : `git -C ${repo} worktree add -b ${branch} ${t.workdir} ${reviewed ?? base}`;
      lines.push(`Before you change, build or test anything, recreate the worktree at that same path (\`${add}\`) and work there. Leave the project checkout's files and branch alone.`);
      if (kind === "review") lines.push(`If the work already landed on \`${base}\`, you may review it straight from git instead (\`git show\`, \`git diff ${reviewed ?? "<commit>"} ${base}\`).`);
    }
    return `\n\n[Harness note: ${lines.join(" ")}]`;
  }

  /** The commit the last agent review round recorded (`meta.commit`), if any. */
  private lastReviewedCommit(t: Ticket): string | null {
    return this.agentReviewRounds(t).at(-1)?.meta.commit ?? null;
  }

  /** The ticket's agent review rounds, oldest first (DESIGN.md "Agent review"). */
  private agentReviewRounds(t: Ticket) {
    return this.store.activity.listBySession(t.sessionId).filter((e) => (e.kind === "review_approved" || e.kind === "changes_requested") && e.meta.by === "agent");
  }

  /**
   * A human message for a run of `kind` (DESIGN.md "Steering"). When such a run is going and its
   * driver takes input, the message goes straight into it and the agent sees it at its next
   * step. Otherwise it waits for a run of its own, queued behind the active one, with a
   * transcript note when there was a running agent it couldn't reach.
   */
  private async steerOrEnqueue(sessionId: string, kind: RunKind, message: SentMessage): Promise<string | null> {
    const { text, attachments } = message;
    const active = [...this.active.values()].find((a) => a.run.sessionId === sessionId && !a.cancelled);
    if (!active) {
      return this.enqueueRun(sessionId, kind, text, undefined, { attachments }).id;
    }
    const input = active.input;
    if (input && !input.isClosed && (active.run.kind === kind || (AGENT_RUNS.has(kind) && AGENT_RUNS.has(active.run.kind)))) {
      this.append(sessionId, active.run.id, "user", messageContent(message));
      this.touchSession(sessionId);
      const withFiles = MENTION_RUN_KINDS.has(kind) && active.cwd ? await this.withMentions(sessionId, active.run.id, text, active.cwd) : text;
      const attached = this.withAttachments(sessionId, active.run.id, attachments);
      const ticketId = this.store.sessions.get(sessionId)?.ticketId;
      const prompt = withFiles + this.blockedNote(ticketId ? this.store.tickets.get(ticketId) : null) + (attached?.block ?? "");
      if (input.push(prompt, message, attached?.images)) return active.run.id;
      // The run stopped taking input while the mentions were read.
      const run = this.enqueueRun(sessionId, kind, text, undefined, { skipTranscript: true, attachments });
      this.appendStatus(sessionId, run.id, STEER_FALLBACK_STATUS);
      return run.id;
    }
    const run = this.enqueueRun(sessionId, kind, text, undefined, { attachments });
    this.appendStatus(sessionId, run.id, STEER_FALLBACK_STATUS);
    return run.id;
  }

  /**
   * Unblock a ticket with the human's optional notes. A block a completion run raised resumes the
   * completion (resumeCompletion). Any other block moves back to in progress with both reviews
   * starting over: a block can keep an old approval (a no-PR or cleanup block does), and the
   * resumed work must not land on it. Refused while a tool approval waits (begin() would clear
   * it) or a run is going.
   */
  async unblockTicket(key: string, body: UnblockBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "unblocked");
    this.notDraft(ticket, "unblocked");
    this.notCompacting(ticket, "unblocked");
    if (ticket.status !== "blocked") throw conflict(`${ticket.key} is ${ticket.status}, not blocked: there's nothing to unblock`);
    if (ticket.pendingApproval) throw conflict(`${ticket.key} is waiting on a tool approval (${ticket.pendingApproval.toolName}); answer it instead`);
    if (ticket.busy) throw conflict(`${ticket.key} is running; unblock it once the run ends`);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    this.autoRetries.delete(ticket.id);
    this.recordAnswer(ticket, notes, "human");
    if (ticket.blockedRunKind === "complete") {
      if (!(await this.resumeCompletion(ticket, notes, "human"))) throw conflict(`${ticket.key} is already being unblocked`);
      return this.store.tickets.get(ticket.id)!;
    }
    this.addActivityLine(ticket, "unblocked", "human", notes || "Unblocked by the human", { ...(notes ? { note: notes } : {}), ...this.moveMeta(ticket, "in_progress") });
    await this.begin(ticket, this.prompts().unblockPrompt(ticket, notes), { agentReview: "pending", humanReview: "pending" }, "Unblocked by human", [], "human");
    return this.store.tickets.get(ticket.id)!;
  }

  /** Send a done ticket back to in progress with the human's notes (the done-column "request changes"). */
  async reopenTicket(key: string, body: ReopenBody): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "re-opened");
    this.notDraft(ticket, "re-opened");
    this.notCompacting(ticket, "re-opened");
    if (ticket.status !== "done") throw conflict(`${ticket.key} is not done; only done tickets can be re-opened`);
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    if (!notes) throw badRequest("notes are required");
    this.addActivity(ticket, "reopened", "human", notes, this.moveMeta(ticket, "in_progress"));
    return this.reopen(ticket, this.prompts().reopenPrompt(ticket, notes, (await this.refreshBaseBranch(ticket)).branch), "Re-opened by human");
  }

  /**
   * Done → in progress. Both reviews start over, and begin() recreates the worktree when the
   * complete run removed it.
   */
  private async reopen(ticket: Ticket, prompt: string, note: string, attachments: readonly Attachment[] = [], by: ActivityAuthor = "system"): Promise<Ticket> {
    this.autoRetries.delete(ticket.id);
    await this.begin(ticket, prompt, { agentReview: "pending", humanReview: "pending" }, note, attachments, by);
    return this.store.tickets.get(ticket.id)!;
  }

  humanReview(key: string, body: HumanReviewBody): Ticket {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "reviewed");
    this.notDraft(ticket, "reviewed");
    this.notCompacting(ticket, "reviewed");
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
    const r = resolveCompletionAction(action, t, this.store.projects.get(t.projectId), this.branchParent(t), this.baseBranchFor(t).branch);
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
    this.addActivityLine(ticket, "permission", "human", `${decision === "deny" ? "Denied" : decision === "allow_tool" ? "Always allowed" : "Allowed once"}: ${what}`);
    const asked = this.store.runs.get(pa.runId)?.kind;
    if (asked === "chat") {
      // The chat carries on where the ticket is; its question (if it's blocked) stays open.
      const t = this.store.tickets.update(ticket.id, { pendingApproval: null, allowedTools, reviewRejections: 0 })!;
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, `Approval answered: ${decision}`);
      this.enqueueRun(t.sessionId, "chat", prompt);
      return this.store.tickets.get(t.id)!;
    }
    const kind = asked === "complete" && ticket.status !== "in_progress" ? "complete" : this.workKind(ticket);
    const t = this.transition(
      ticket,
      kind === "complete" ? "review" : "in_progress",
      { pendingApproval: null, blockedReason: null, allowedTools, reviewRejections: 0 },
      `Approval answered: ${decision}`,
      undefined,
      { by: "human" },
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
      // A human's approval is kept as written; a conductor's notes show their first line, like a reviewer's.
      if (by === "human") this.addActivity(t, "approved", "human", notes.trim() || "Approved.", { by });
      else this.addActivityLine(t, "approved", "agent", notes.trim() || "Approved.", { by });
      this.noteReady(t);
      return t;
    }
    if (decision !== "request_changes") throw badRequest(`Invalid decision: ${decision}`);
    this.notCompleting(ticket, "sent back");
    return this.requestChanges(ticket, notes, by);
  }

  async completeTicket(key: string, body: CompleteBody = {}): Promise<Ticket> {
    let ticket = this.requireTicket(key);
    this.notCos(ticket, "completed");
    this.notDraft(ticket, "completed");
    this.notCompacting(ticket, "completed");
    if (ticket.status === "done") throw conflict(`${ticket.key} is already done`);
    if (body.skipAgent) {
      // "Approve and take no action": no completion run. In review it counts as the approval.
      if (ticket.status === "review") {
        this.notCompleting(ticket, "marked done");
        // It's the human's review decision, so Activity records it as one (and as the move to done).
        this.addActivity(ticket, "approved", "human", "Approved, no action taken", { by: "human", ...this.moveMeta(ticket, "done") });
        this.transition(ticket, "done", { blockedReason: null, humanReview: "approved" }, "Approved, no action taken", undefined, { by: "human" });
      } else {
        this.transition(ticket, "done", { blockedReason: null }, "Marked done", undefined, { by: "human" });
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
  private async enqueueComplete(ticket: Ticket, promptSuffix = "") {
    this.startingComplete.add(ticket.id);
    try {
      await this.refreshBaseBranch(ticket);
      // Commits made since the ticket moved to review count (a hand-made one, or update_branch).
      if (ticket.branch && ticket.workdir) await this.refreshHasChanges(ticket);
      let t = this.store.tickets.get(ticket.id);
      if (!t || t.status !== "review") return;
      // The action this completion runs with: the stored choice while the ticket still offers it,
      // else the default (a project that lost its gh login merges instead of failing). Written
      // back so the run's system prompt picks the same completion prompts.
      const action = completionOptions(t, this.store.projects.get(t.projectId), this.branchParent(t), this.baseBranchFor(t).branch).defaultAction;
      if (action !== t.completionAction) t = this.store.tickets.update(t.id, { completionAction: action })!;
      // A head recorded by an earlier pr completion is stale now: this one records its own.
      if (t.pullRequestHead) t = this.store.tickets.update(t.id, { pullRequestHead: null })!;
      this.mergeTips.delete(t.id);
      if (action === "merge") {
        const tip = await this.mergeTip(t);
        if (tip) this.mergeTips.set(t.id, tip);
      }
      this.enqueueRun(t.sessionId, "complete", this.completePromptFor(t, t.completionInstructions ?? undefined) + promptSuffix, this.completeLock(t));
    } finally {
      this.startingComplete.delete(ticket.id);
    }
  }

  /**
   * Complete runs that merge into the same place run one at a time: siblings merging into their
   * parent's worktree, or tickets merging into the project's base branch. PR and custom
   * completions don't share a checkout with anyone.
   */
  /**
   * What a "cleanup" completion should have removed and didn't: the harness worktree (only when
   * the harness made it) and the harness branch. A branch the harness didn't create is kept.
   */
  private async cleanupLeftovers(t: Ticket): Promise<string[]> {
    const project = this.store.projects.get(t.projectId);
    const left: string[] = [];
    if (t.workdir && isInside(t.workdir, this.paths.worktreesDir) && existsSync(t.workdir)) left.push(`the worktree at ${t.workdir}`);
    const branch = t.branch ?? branchForKey(t.key);
    if (project && branch === branchForKey(t.key) && (await branchExists(project.path, branch))) left.push(`the branch ${branch}`);
    return left;
  }

  /** The commit a merge completion has to land: the branch's tip, or the worktree's HEAD when the branch is gone. */
  private async mergeTip(t: Ticket): Promise<string | null> {
    const project = this.store.projects.get(t.projectId);
    const branch = t.branch ?? branchForKey(t.key);
    const spots: Array<[string, string]> = [];
    if (project) spots.push([project.path, `refs/heads/${branch}`]);
    if (t.workdir && existsSync(t.workdir)) spots.push([t.workdir, "HEAD"]);
    for (const [cwd, ref] of spots) {
      const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
      if (r.code === 0 && r.stdout) return r.stdout;
    }
    return null;
  }

  /** Whether `sha` is reachable from the local base branch in the project's main checkout, or true when that can't be told. */
  private async mergeLanded(t: Ticket, sha: string): Promise<boolean> {
    const project = this.store.projects.get(t.projectId);
    if (!project || !existsSync(project.path)) return true;
    const base = this.baseBranchFor(t).branch;
    const r = await git(["merge-base", "--is-ancestor", sha, base], project.path);
    return r.code === 0;
  }

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

  /**
   * After skipHumanReview changed: a ticket in review follows the flag right away. On: a pending
   * human review counts as approved, so the ticket lands now if its agent review passed. Off: an
   * approval that isn't landing yet goes back to pending (there's no telling it apart from a
   * human's own approval, so turning the switch off asks for one either way).
   */
  private applySkipHumanReview(ticket: Ticket): Ticket {
    if (ticket.status !== "review") return ticket;
    if (ticket.skipHumanReview && ticket.humanReview === "pending") {
      const t = this.store.tickets.update(ticket.id, { humanReview: "approved" })!;
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, "Human review: skipped");
      this.noteReady(t);
    } else if (!ticket.skipHumanReview && ticket.humanReview === "approved" && !this.completing(ticket)) {
      const t = this.store.tickets.update(ticket.id, { humanReview: "pending" })!;
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, "Human review: waiting on a human again");
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
    this.notCos(ticket, "reviewed");
    this.notDraft(ticket, "reviewed");
    this.notCompacting(ticket, "reviewed");
    if (ticket.status !== "review") throw conflict(`${ticket.key} is not in review`);
    const t = this.store.tickets.update(ticket.id, { agentReview: "pending" })!;
    this.enqueueReview(t);
    return this.store.tickets.get(ticket.id)!;
  }

  async cancelTicket(key: string): Promise<Ticket> {
    const ticket = this.requireTicket(key);
    this.notCos(ticket, "cancelled");
    this.notDraft(ticket, "cancelled (nothing runs on a draft)");
    // Before the run ends: the scheduler runs as soon as it does.
    this.dropPlanApproval(ticket.id, "Plan approval cleared: run cancelled; work not started");
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
        if (job.kind === "complete") this.completionStopped(sessionId, "cancelled");
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

  /** "triage" is accepted for apps that still ask for the old Inbox: there are no triage sessions to show any more (their items are events). */
  listSessions(kind?: "ticket" | "triage"): Session[] {
    if (kind === "triage") return [];
    // A chief of staff's conversation isn't on the board: it is read through /cos.
    const chiefs = new Set(this.store.cos.list().map((c) => c.ticketId));
    // Old triage sessions (kept only for list_inbox) are not a list any app shows.
    return this.store.sessions.list(kind).filter((s) => s.kind !== "triage" && !(s.ticketId && chiefs.has(s.ticketId)));
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

  /**
   * A background task's output (DESIGN.md "Background tasks"): the tail, or what follows `offset`.
   * Read from the CLI's file while it runs, from the kept tail once it has ended. 404 for an
   * unknown id or an agent.
   */
  taskOutput(sessionId: string, subagentId: string, offset?: number): TaskOutput {
    this.getSession(sessionId);
    const task = this.store.subagents.get(sessionId, subagentId);
    const source = this.store.subagents.outputSource(sessionId, subagentId);
    if (!task || !source) throw notFound(`Unknown background task: ${subagentId}`);
    const done = task.status !== "running";
    if (done && source.snapshot) return readSnapshot(source.snapshot, offset);
    const path = source.path && confineOutputPath(source.path);
    return path ? readTaskOutput(path, offset, done) : unavailable(offset, done);
  }

  /** The run ended: its sub-agents and tasks still running stopped with it. */
  private stopSubagents(runId: string) {
    for (const subagent of this.store.subagents.stopRunning(runId)) {
      this.keepTaskOutput(subagent);
      this.bus.emit({ kind: "subagent.upserted", subagent });
    }
  }

  /**
   * A background task ended: keep the tail of its output, since the CLI's file lives in /tmp.
   * Every report after the end (the CLI's task_notification follows its task_updated) takes it
   * again while the file is there, so the last lines the CLI writes are kept too.
   */
  private keepTaskOutput(subagent: Subagent) {
    if (!subagent.kind || subagent.kind === "agent") return;
    const source = this.store.subagents.outputSource(subagent.sessionId, subagent.id);
    if (!source?.path) return;
    const path = confineOutputPath(source.path);
    const snapshot = path && snapshotTaskOutput(path);
    if (snapshot) this.store.subagents.saveOutput(subagent.sessionId, subagent.id, snapshot);
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
    if (body.cosId !== undefined) {
      if (body.cosId !== null && typeof body.cosId !== "string") throw badRequest("cosId must be a string or null");
      const row = body.cosId ? this.store.cos.get(body.cosId) : null;
      if (body.cosId && !row) throw badRequest(`Unknown chief of staff: ${body.cosId}`);
      // The All chief is stored as NULL, so a watcher never points at a row that could be recreated.
      out.cosId = row && row.scope !== "all" ? row.ticketId : null;
    }
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
   * Feed output as if a watcher named `source` printed `text` (an object is taken as its JSON): an
   * event for the All chief of staff. Null when deduped or when the text is only whitespace.
   */
  async injectOutput(source: string, text: unknown): Promise<CosEvent | null> {
    if (typeof source !== "string" || !source.trim()) throw badRequest("source is required");
    const raw = typeof text === "string" ? text : text === undefined || text === null ? "" : JSON.stringify(text);
    const output = toOutput(raw);
    if (!output) throw badRequest("text is required");
    const name = source.trim();
    return this.ingest({ sourceId: `inject:${name}`, source: name, output });
  }

  /** Dedupe (identical text from the same source is delivered once), then an event owned by the watcher's chief of staff. */
  ingest(input: IngestInput): CosEvent | null {
    const hash = createHash("sha256").update(input.output.text).digest("hex");
    // Seen and event commit together: an insert that throws leaves the output unseen, to be delivered again.
    return this.store.transaction(() => {
      if (!this.store.seen.markSeen(input.sourceId, `sha256:${hash}`, null)) return null;
      return this.cosEngine.addExternal({
        sourceKind: "watcher",
        sourceRef: `${input.sourceId}:sha256:${hash}`,
        actor: `watcher:${input.source}`,
        title: `${input.source}: ${outputTitle(input.output.text)}`,
        body: input.output.text,
        // A chief that is gone (its ticket deleted) no longer owns anything: the All chief takes the event.
        ...(input.cosId && this.store.cos.get(input.cosId) ? { cosId: input.cosId } : {}),
      });
    });
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

  async postNote(ctx: ToolContext, note: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (typeof note !== "string" || !note.trim()) throw new Error("note is empty");
    this.addActivityLine(t, "note", "agent", note);
  }

  /** update_notes: the notes are for later agents, so no Activity entry (the human reads them on Details). */
  async updateNotes(ctx: ToolContext, notes: string): Promise<string> {
    const t = this.ctxTicket(ctx);
    if (typeof notes !== "string") throw new Error("notes must be text");
    const text = notes.trim();
    const updated = this.store.tickets.update(t.id, { agentNotes: text || null })!;
    this.bus.emit({ kind: "ticket.upserted", ticket: updated });
    const active = this.ctxActive(ctx);
    if (active) active.wroteNotes = true;
    return text;
  }

  wroteNotes(ctx: ToolContext): boolean {
    return !!this.ctxActive(ctx)?.wroteNotes;
  }

  async readSpec(ctx: ToolContext, revision?: number): Promise<string> {
    const t = this.ctxTicket(ctx);
    const current = t.specRevision ?? 1;
    const rev = revision ?? current;
    const r = this.store.specs.get(t.id, rev);
    if (!r) throw new Error(`${t.key}'s spec has no revision ${rev}; it's at revision ${current}.`);
    const head =
      rev === current
        ? `Revision ${rev} (current)${t.specBaselineRevision ? `; approved baseline: revision ${t.specBaselineRevision}` : ""}. Pass base_revision ${rev} to edit_spec or update_spec.`
        : `Revision ${rev} of ${current}: an earlier revision, for reference. Edits apply to the current one.`;
    return `${head}
${numberLines(r.body)}`;
  }

  /**
   * The spec tools are for the run's own ticket, in the run kinds toolsForRun gives them to. A
   * review run may edit_spec (to record what it found) but not replace the spec whole.
   */
  private specWriter(ctx: ToolContext, tool: string): Ticket {
    if (ctx.runKind === "review" && tool !== "edit_spec") throw new Error(`${tool} isn't available in review runs: record what you found with edit_spec instead`);
    return this.ctxTicket(ctx);
  }

  async editSpec(ctx: ToolContext, input: { baseRevision: number; note: string; edits: unknown }): Promise<string> {
    const t = this.specWriter(ctx, "edit_spec");
    const current = t.specRevision ?? 1;
    if (input.baseRevision !== current) throw new Error(this.staleSpecMessage(t, input.baseRevision));
    let body: string;
    try {
      body = applySpecEdits(t.spec, input.edits, current);
    } catch (err) {
      if (err instanceof SpecEditError) throw new Error(`${err.message}. No edit was applied; the spec is still at revision ${current}.`);
      throw err;
    }
    return this.agentSpecWrite(ctx, t, { body, baseRevision: current, note: input.note });
  }

  async updateSpec(ctx: ToolContext, input: { spec: string; note: string; baseRevision: number; title?: string }): Promise<string> {
    const t = this.specWriter(ctx, "update_spec");
    if (typeof input.spec !== "string" || !input.spec.trim()) throw new Error("spec is empty");
    const current = t.specRevision ?? 1;
    if (input.baseRevision !== current) throw new Error(this.staleSpecMessage(t, input.baseRevision));
    const out = await this.agentSpecWrite(ctx, t, { body: input.spec, baseRevision: current, note: input.note });
    const title = input.title?.trim();
    if (title && title !== t.title) {
      const u = this.store.tickets.update(t.id, { title })!;
      this.store.sessions.update(u.sessionId, { title });
      this.touchSession(u.sessionId);
      return `${out} Retitled to "${title}".`;
    }
    return out;
  }

  /** A spec write based on a revision that isn't current anymore; `reread` is the tool that shows it. */
  private staleSpecMessage(t: Ticket, base: number, reread = "read_spec"): string {
    const current = t.specRevision ?? 1;
    return `The spec${reread === "read_spec" ? "" : ` of ${t.key}`} is at revision ${current}, not ${base}: it changed since you read it${current > base ? " (a human may have edited it)" : ""}. Call ${reread}, then redo your change against revision ${current}. Nothing was changed.`;
  }

  /**
   * An agent's spec write: local images in `body` are validated and stored as the ticket's
   * attachments (their src becomes attachment:<id>), then the revision is added. Nothing is kept
   * when any of it fails.
   */
  private async agentSpecWrite(ctx: ToolContext, t: Ticket, w: { body: string; baseRevision: number; note: string }): Promise<string> {
    if (typeof w.note !== "string" || !w.note.trim()) throw new Error("note is empty: say in a few words what changed");
    const sources = localImageSources(w.body);
    const prepared = prepareAttachments(sources, ctx.cwd);
    const stored = storeAttachments(this.paths.attachmentsDir, prepared);
    const body = rewriteImageSources(w.body, new Map(sources.map((src, i) => [src, stored[i]!.id])));
    let rev: SpecRevisionInfo | null;
    try {
      rev = this.store.transaction(() => {
        this.store.attachments.add(t.id, stored);
        return this.reviseSpec(t, { body, baseRevision: w.baseRevision, note: w.note.trim(), author: "agent", runId: ctx.runId, runKind: ctx.runKind });
      });
    } catch (err) {
      removeAttachmentFiles(stored.map((a) => a.path));
      if (err instanceof HarnessError && err.status === 409) throw new Error(this.staleSpecMessage(this.store.tickets.get(t.id) ?? t, w.baseRevision));
      throw err;
    }
    const images = stored.length ? ` Stored ${stored.length} attachment${stored.length === 1 ? "" : "s"} (${stored.map((a) => `${a.name} → attachment:${a.id}`).join(", ")}).` : "";
    if (!rev) return `The spec already reads that way; it stays at revision ${w.baseRevision}.${images}`;
    return `Spec updated to revision ${rev.rev}.${images}`;
  }

  /**
   * Every spec write goes through here (DESIGN.md "Spec revisions and attachments"): PATCH,
   * update_spec, edit_spec, update_ticket. Adds the next revision (none when the body didn't
   * change), records it in Activity (spec_revised, the note as its line), broadcasts spec.revised
   * and the ticket. A stale `baseRevision` throws 409 carrying
   * SpecConflict. Ticket creation (create_ticket, a chief of staff, POST /tickets) writes
   * revision 1 with the ticket itself.
   */
  reviseSpec(ticket: Ticket, w: { body: string; baseRevision?: number; note: string } & SpecAuthorship): SpecRevisionInfo | null {
    let rev: SpecRevisionInfo | null;
    try {
      rev = this.store.specs.revise(ticket.id, { body: w.body, baseRevision: w.baseRevision, note: w.note, author: w.author, runId: w.runId ?? null, runKind: w.runKind ?? null });
    } catch (err) {
      if (err instanceof SpecConflictError) {
        throw new HarnessError(409, `${ticket.key}'s spec is at revision ${err.currentRevision}, not ${err.baseRevision}: it changed since this edit started. Reload it, or send it again with baseRevision ${err.currentRevision} to overwrite.`, {
          currentRevision: err.currentRevision,
          spec: err.currentBody,
        } satisfies SpecConflict);
      }
      throw err;
    }
    if (!rev) return null;
    this.bus.emit({ kind: "spec.revised", ticketId: ticket.id, rev: rev.rev, author: rev.author, note: rev.note, runId: rev.runId, runKind: rev.runKind, createdAt: rev.createdAt });
    this.appendStatus(ticket.sessionId, w.runId ?? null, `Spec revision ${rev.rev}: ${rev.note}`);
    this.addActivityLine(ticket, "spec_revised", rev.author, rev.note, { specRevision: rev.rev });
    this.touchTicket(ticket.id);
    return rev;
  }

  /**
   * The agent's question for the human. From in progress or blocked (a new question replaces the
   * old one); from review too, which starts both reviews over (a chat about a reviewed ticket).
   */
  async block(ctx: ToolContext, question: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    this.lifecycleFrom(t, "block");
    if (!question?.trim()) throw new Error("question is empty");
    const patch: TicketPatch = { blockedReason: question.trim() };
    // A completion run's block keeps the approvals (unblocking resumes the completion) and
    // remembers the branch tip it blocked at; a chat re-asking a completion's question keeps both.
    // Only a completion still in review: one that called resume_work is a work run now, and its block is any other.
    if (ctx.runKind === "complete" && t.status === "review") {
      Object.assign(patch, { blockedRunKind: "complete", blockedHead: await this.mergeTip(t) });
    } else if (t.status === "blocked") {
      Object.assign(patch, { blockedRunKind: t.blockedRunKind, blockedHead: t.blockedHead });
    } else if (t.status === "review") {
      await this.cancelReviewRuns(t.sessionId);
      Object.assign(patch, { agentReview: "pending", humanReview: "pending" });
    }
    // A completion that already called resume_work queued its work run: the question comes first.
    if (ctx.runKind === "complete" && t.status === "in_progress") {
      for (const job of this.queue.pendingFor(t.sessionId)) {
        if (job.kind !== "work" && job.kind !== "conductor") continue;
        if (this.queue.remove(job.runId)) this.bus.emit({ kind: "run.upserted", run: this.store.runs.finish(job.runId, "cancelled", null) });
      }
    }
    this.addActivity(t, "blocked", "agent", question.trim(), { question: question.trim(), ...this.moveMeta(t, "blocked") });
    this.transition(t, "blocked", patch, `Blocked: ${question.trim()}`, question.trim());
    const a = this.ctxActive(ctx);
    if (a) {
      a.blocked = true;
      a.resumeCompletion = null;
    }
  }

  /** Whether the branch is still at the commit a completion run blocked at (the tip the approved work had, plus any commits the completion made). */
  private async headUnmoved(t: Ticket): Promise<boolean> {
    return (await this.mergeTip(t)) === (t.blockedHead ?? null);
  }

  /**
   * Unblocked after a completion run's block: back to review with the approvals the ticket had, and
   * a new completion run (the stored choice, the usual locks) that is told the question and the
   * answer, since complete runs start a fresh conversation. A branch that moved meanwhile would
   * land commits nobody reviewed: that goes back to in progress with both reviews pending.
   */
  private async resumeCompletion(ticket: Ticket, answer: string, by: "human" | "agent"): Promise<boolean> {
    // Claimed before the first await, so a second unblock pressed meanwhile is refused (and
    // enqueueComplete, which clears it, only runs once).
    if (this.startingComplete.has(ticket.id)) return false;
    this.startingComplete.add(ticket.id);
    try {
      const note = answer.trim();
      const moved = !(await this.headUnmoved(ticket));
      const current = this.store.tickets.get(ticket.id);
      if (!current || current.status !== "blocked" || current.blockedRunKind !== "complete") return false;
      const stands = current.humanReview === "approved" && (current.agentReview === "approved" || current.agentReview === "skipped");
      if (moved || !stands) {
        const why = moved ? "the branch changed since it was approved" : "its approvals no longer stand";
        const asked = current.blockedReason?.trim();
        const framed = `${asked ? `A completion run stopped to ask: ${asked}\n` : ""}${moved ? "The branch has moved since the work was approved, so both reviews start over and it has to be reviewed again before it lands.\n" : "The work's approvals no longer stand, so both reviews start over.\n"}${note}`.trim();
        this.addActivityLine(current, "unblocked", by, note || "Unblocked", { ...(note ? { note } : {}), ...this.moveMeta(current, "in_progress") });
        await this.begin(current, this.prompts().unblockPrompt(current, framed), { agentReview: "pending", humanReview: "pending" }, `Unblocked by ${by}: ${why}`, [], by);
        return true;
      }
      const question = current.blockedReason?.trim() ?? "";
      this.addActivityLine(current, "unblocked", by, note || "Unblocked: resuming the completion", { ...(note ? { note } : {}), ...this.moveMeta(current, "review") });
      const t = this.transition(current, "review", { blockedReason: null }, `Unblocked by ${by}: resuming the completion`, undefined, { by, keepApprovals: true });
      const asked = question ? `The completion stopped to ask: ${question}\n` : "";
      await this.enqueueComplete(t, `\n\n[Harness note: an earlier completion run for this ticket stopped to ask the human. ${asked}${note ? `The human's answer: ${note}\n` : "The human unblocked it without further notes.\n"}Carry on with the completion with that in mind. If the answer means the work needs changes, call resume_work to send the ticket back to in progress instead.]`);
      return true;
    } finally {
      this.startingComplete.delete(ticket.id);
    }
  }

  /**
   * The human's message resolved the block. After a completion run's block the completion resumes
   * once the chat that answered ends (this run's reply is the answer); otherwise back to in
   * progress while the agent carries on.
   */
  async unblock(ctx: ToolContext, note?: string): Promise<string> {
    const t = this.ctxTicket(ctx);
    if (t.pendingApproval) throw new Error(`${t.key} is waiting on a human to answer a tool approval (${t.pendingApproval.toolName}); only they can unblock it.`);
    if (t.status !== "blocked") throw new Error(`${t.key} is ${t.status}, not blocked: there's nothing to unblock.`);
    const why = typeof note === "string" ? note.trim() : "";
    const a = this.ctxActive(ctx);
    if (t.blockedRunKind === "complete" && a && ctx.runKind === "chat" && (await this.headUnmoved(t))) {
      a.resumeCompletion = { note: why };
      return "Noted. The completion resumes on its own when this reply ends, with the question and the human's answer: don't change the work or call submit_for_review. If the answer means the work needs changes, call resume_work instead.";
    }
    // Approvals a completion's block kept start over: the resumed work must be reviewed again.
    const reviews: TicketPatch = t.blockedRunKind === "complete" ? { agentReview: "pending", humanReview: "pending" } : {};
    this.addActivityLine(t, "unblocked", "agent", why || "Unblocked: picking the work back up.", { ...(why ? { note: why } : {}), ...this.moveMeta(t, "in_progress") });
    this.transition(t, "in_progress", { blockedReason: null, ...reviews }, `Unblocked by the agent${why ? `: ${why}` : ""}`);
    return "";
  }

  /**
   * A chat on a ticket in review is changing the work again: back to in progress, as when the human
   * moves it there, with both reviews pending and a running agent review stopped (it would judge
   * work that's about to change).
   * A chat on a done ticket that's doing work re-opens it, as Re-open does: both reviews pending,
   * and the worktree the complete run removed comes back. The running chat started in the old
   * directory (often the project checkout), so the result names the workdir when it moved.
   */
  async resumeWork(ctx: ToolContext, note?: string): Promise<string> {
    const t = this.ctxTicket(ctx);
    if (t.pendingApproval) throw new Error(`${t.key} is waiting on a human to answer a tool approval (${t.pendingApproval.toolName}); only they can move it.`);
    const afterCompletionBlock = t.status === "blocked" && t.blockedRunKind === "complete";
    if (t.status !== "review" && t.status !== "done" && !afterCompletionBlock) throw new Error(`${t.key} is ${t.status}, not in review or done: resume_work only takes a ticket out of review or done (or out of a block a completion run raised).`);
    const why = typeof note === "string" ? note.trim() : "";
    if (afterCompletionBlock) {
      // The answer means the work changes: the chat carries on as the in-progress session, and the
      // completion that was going to resume doesn't.
      const a = this.ctxActive(ctx);
      if (a) a.resumeCompletion = null;
      this.transition(t, "in_progress", { agentReview: "pending", humanReview: "pending", blockedReason: null }, `Moved back to in progress by the agent${why ? `: ${why}` : ""}`, undefined, { by: "agent", line: why || "Changing the work after a completion question", keepSession: true });
      return "";
    }
    if (t.status === "review" && ctx.runKind === "complete") {
      // A resumed completion found the work needs changes: the work run is queued now, behind this
      // run (the queue serializes a session), so it starts however this run ends.
      await this.cancelReviewRuns(t.sessionId);
      const prompt = this.prompts().unblockPrompt(t, why);
      this.transition(t, "in_progress", { agentReview: "pending", humanReview: "pending", blockedReason: null }, `Moved back to in progress by the agent${why ? `: ${why}` : ""}`, undefined, { by: "agent", line: why || "Changing the work during completion" });
      this.enqueueRun(t.sessionId, this.workKind(t), prompt);
      return "";
    }
    // The chat keeps running in its own conversation, which started fresh when the ticket entered
    // review or done: it becomes the in-progress session (keepSession), so it's saved as it goes.
    if (t.status === "review") {
      await this.cancelReviewRuns(t.sessionId);
      this.transition(t, "in_progress", { agentReview: "pending", humanReview: "pending", blockedReason: null }, `Moved back to in progress by the agent${why ? `: ${why}` : ""}`, undefined, { by: "agent", line: why || "Changing the reviewed work", keepSession: true });
      return "";
    }
    const dir = await this.workdirFor(t);
    if (typeof dir === "string") throw new Error(`${t.key} couldn't be re-opened: ${dir}`);
    this.autoRetries.delete(t.id);
    this.store.sessions.update(t.sessionId, { cwd: dir.workdir });
    this.addActivityLine(t, "reopened", "agent", why || "Re-opened to pick the work back up", this.moveMeta(t, "in_progress"));
    this.transition(t, "in_progress", { ...dir, agentReview: "pending", humanReview: "pending", blockedReason: null, reviewRejections: 0 }, `Re-opened by the agent${why ? `: ${why}` : ""}`, undefined, { keepSession: true });
    // A completion run that found the ticket done: the work still has to be picked up once it ends.
    if (ctx.runKind === "complete") this.enqueueRun(t.sessionId, this.workKind(t), this.prompts().unblockPrompt(t, why));
    return dir.workdir === ctx.cwd ? "" : dir.workdir;
  }

  /**
   * The agent sends its own ticket back to planning (return_to_planning). The ticket moves now,
   * with both reviews reset and any agent review stopped; the Plan run is queued when the calling
   * run ends (queueReplan), on the Plan model in a fresh conversation, so the scheduler can't
   * start work in between.
   */
  async returnToPlanning(ctx: ToolContext, reason: string, startAfterPlan: boolean): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (ctx.runKind !== "work" && ctx.runKind !== "conductor" && ctx.runKind !== "chat") throw new Error("return_to_planning is only available in work, conductor and chat runs");
    if (t.pendingApproval) throw new Error(`${t.key} is waiting on a human to answer a tool approval (${t.pendingApproval.toolName}); only they can move it.`);
    if (t.status === "planning") throw new Error(`${t.key} is already in planning.`);
    this.notCompleting(t, "sent back to planning");
    const why = typeof reason === "string" ? reason.trim() : "";
    if (!why) throw new Error("reason is empty: say what the human asked for and what's wrong with the current approach");
    if (t.status === "review") await this.cancelReviewRuns(t.sessionId);
    const from = t.status;
    this.autoRetries.delete(t.id);
    this.transition(
      t,
      "planning",
      { agentReview: "pending", humanReview: "pending", blockedReason: null, pendingApproval: null, reviewRejections: 0, autoStart: false },
      `Moved back to planning by the agent: ${why}`,
      why,
      { by: "agent", line: `Moved back to planning by the agent: ${why}` },
    );
    // Leaving Blocked would keep the conversation; the Plan run starts a new one.
    if (from === "blocked") this.newSession(t.sessionId);
    const a = this.ctxActive(ctx);
    if (a) a.replanned = { reason: why, startAfterPlan };
    else this.queueReplan(t.id, why, "", startAfterPlan); // tool called outside the tracked run
  }

  /**
   * Queue the Plan run after return_to_planning. The run is queued before the approval is set, so
   * the ticket is busy whenever the scheduler could see the approval.
   */
  private queueReplan(ticketId: string, reason: string, humanMessage: string, startAfterPlan: boolean) {
    const t = this.store.tickets.get(ticketId);
    if (!t || t.status !== "planning") return;
    this.enqueueRun(t.sessionId, "plan", this.prompts().replanPrompt(t, reason, humanMessage, startAfterPlan));
    if (startAfterPlan) this.approvePlan(t, "agent");
  }

  /**
   * block and submit_for_review work from in progress, blocked and review; a planning ticket
   * starts when the human presses Start, and a done one when they re-open it (or a chat calls resume_work).
   */
  private lifecycleFrom(t: Ticket, tool: "block" | "submit_for_review") {
    if (t.status === "planning") throw new Error(`${t.key} is still in planning: the work starts when the human presses Start, so ${tool} doesn't apply yet.`);
    if (t.status === "done") throw new Error(`${t.key} is done: call resume_work first to re-open it when you're picking the work back up, then ${tool}.`);
  }

  async submitForReview(ctx: ToolContext, note: string, specIsUpToDate: unknown, skips: ReviewSkips = {}): Promise<void> {
    const { skipAgentReview, skipHumanReview } = skips;
    let t = this.ctxTicket(ctx);
    this.lifecycleFrom(t, "submit_for_review");
    // The spec is updated in its own, earlier call; the submit only confirms it.
    if (specIsUpToDate !== true) throw new Error(SPEC_NOT_UP_TO_DATE_MESSAGE);
    // A parent in review (or done) would strand its children: their reviews and merges are its job.
    const open = this.store.tickets.list({ parentId: t.id }).filter((c) => c.status !== "done");
    if (open.length) {
      throw new Error(
        `${t.key} still has child tickets that aren't done (${open.map((c) => `${c.key}: ${c.status}`).join(", ")}). You review and complete them with review_ticket and complete_ticket; end the run now and you'll be re-invoked when they change. Submit once every child is done.`,
      );
    }
    // Submitted again from review (a chat changed the work): the reviews start over.
    if (t.status === "review") await this.cancelReviewRuns(t.sessionId);
    if (skipAgentReview !== undefined && skipAgentReview !== !!t.skipAgentReview) {
      t = this.store.tickets.update(t.id, { skipAgentReview })!;
      this.appendStatus(t.sessionId, ctx.runId, skipAgentReview ? "The agent turned off the agent review for this ticket" : "The agent turned the agent review back on");
    }
    if (skipHumanReview !== undefined && skipHumanReview !== !!t.skipHumanReview) {
      t = this.store.tickets.update(t.id, { skipHumanReview })!;
      this.appendStatus(t.sessionId, ctx.runId, skipHumanReview ? "The agent turned off the human review for this ticket" : "The agent turned the human review back on");
    }
    this.submit(t, (typeof note === "string" && note.trim()) || "Work submitted for review.", "agent");
    const a = this.ctxActive(ctx);
    if (a) a.submitted = true;
    else this.enqueueReview(this.store.tickets.get(t.id)!); // tool called outside the tracked run
  }

  async reviewDecision(ctx: ToolContext, decision: "approve" | "request_changes", notes: string, adviserFindings?: string): Promise<void> {
    const t = this.ctxTicket(ctx);
    if (ctx.runKind !== "review") throw new Error("review_decision is only available in review runs");
    if (t.status !== "review") throw new Error(`${t.key} is no longer in review`);
    if (t.agentReview === "skipped") throw new Error(`The agent review of ${t.key} was skipped; there is nothing to decide`);
    if (decision !== "approve" && decision !== "request_changes") throw new Error(`Invalid decision: ${decision}`);
    const a = this.ctxActive(ctx);
    if (a?.decided) throw new Error("A review decision was already recorded for this run");
    if (a) a.decided = true;
    // The round and the commit it judged, so the next review can look at just what changed since.
    const meta: ActivityMeta = { by: "agent", round: this.reviewRounds(t).length + 1, commit: t.workdir ? await headCommit(t.workdir) : null };
    // The adviser's findings go under their own heading, exactly as the reviewer received them.
    const findings = adviserFindings?.trim();
    const text = [notes?.trim() ?? "", findings ? `### Adviser review\n${findings}` : ""].filter(Boolean).join("\n\n");
    if (decision === "approve") {
      const u = this.store.tickets.update(t.id, { agentReview: "approved" })!;
      this.touchSession(u.sessionId);
      this.appendStatus(u.sessionId, ctx.runId, "Agent review: approved");
      this.addActivityLine(u, "review_approved", "agent", text || "Approved.", meta);
      if (u.parentId) this.notifyConductor(u.parentId, { key: u.key, title: u.title, from: "review", to: "review", note: `Agent review approved. ${text}`.trim(), specRevision: u.specRevision });
      this.noteReady(u);
      return;
    }
    const n = this.store.tickets.reviewRejections(t.id) + 1;
    if (n >= MAX_AGENT_REJECTIONS) {
      const reason = `Agent review requested changes ${n} times — needs a human decision`;
      this.addActivityLine(t, "changes_requested", "agent", text || "No notes.", meta);
      this.addActivity(t, "blocked", "system", reason, { question: reason, ...this.moveMeta(t, "blocked") });
      this.transition(t, "blocked", { reviewRejections: n, agentReview: "changes_requested", blockedReason: reason }, reason, notes);
    } else {
      this.store.tickets.update(t.id, { reviewRejections: n });
      this.requestChanges(t, text, "agent", meta);
    }
  }

  /** The ticket's earlier agent review decisions, oldest first (their Activity entries). */
  private reviewRounds(t: Ticket): ActivityEntry[] {
    return this.store.activity.listBySession(t.sessionId).filter((e) => (e.kind === "review_approved" || e.kind === "changes_requested") && e.meta.by === "agent");
  }

  // --- board (read): every run kind; never changes state ---

  /** A ticket as board tools return it; lists leave the agent notes out (get_ticket has them). */
  private boardTicket(t: Ticket, opts: { notes?: boolean } = {}): BoardTicket {
    const { agentNotes, ...rest } = t;
    return { ...rest, ...(opts.notes === false ? {} : { agentNotes: agentNotes ?? null }), projectKey: this.store.projects.get(t.projectId)?.key ?? "" };
  }

  private boardProject(sc: ScopedStore, key: string): Project {
    const project = sc.projects.getByKey(key.trim());
    if (!project) throw new Error(`Unknown project: ${key}. Use list_projects for the valid keys.`);
    return project;
  }

  async listTickets_(ctx: ToolContext, filter: BoardListFilter = {}): Promise<{ tickets: BoardTicket[]; total: number; scope: BoardScope }> {
    const own = ctx.ticket ? this.ctxTicket(ctx) : null;
    const sc = this.scopeOf(ctx);
    // A chief of staff isn't in a project: with no filter it lists everything it can see.
    const scope: BoardScope = filter.scope ?? (filter.projectKey ? "project" : own?.kind === "cos" ? "all" : own && isConductor(own) ? "children" : own ? "project" : "all");
    const statuses = filter.statuses?.length ? filter.statuses : undefined;
    const bad = statuses?.find((st) => !(TICKET_STATUSES as readonly string[]).includes(st));
    if (bad) throw new Error(`Unknown status: ${bad}`);
    // The store includes drafts unless told otherwise; include_drafts: false leaves them out.
    const drafts = filter.includeDrafts === false ? { drafts: false } : {};
    let tickets: Ticket[];
    if (scope === "children") {
      if (!own) throw new Error('scope "children" needs a ticket run; use "project" with project_key, or "all"');
      const projectId = filter.projectKey ? this.boardProject(sc, filter.projectKey).id : undefined;
      tickets = sc.tickets.list({ parentId: own.id, ...drafts, ...(projectId ? { projectId } : {}), ...(statuses ? { statuses } : {}) });
    } else if (scope === "project") {
      const projectId = filter.projectKey ? this.boardProject(sc, filter.projectKey).id : own?.projectId;
      if (!projectId) throw new Error('project_key is required for scope "project" in a run without a ticket');
      tickets = sc.tickets.list({ projectId, ...drafts, ...(statuses ? { statuses } : {}) });
    } else if (scope === "all") {
      if (filter.projectKey) throw new Error('scope "all" spans every project; drop project_key or use scope "project"');
      tickets = sc.tickets.list({ ...drafts, ...(statuses ? { statuses } : {}) });
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
    return { tickets: sorted.slice(0, limit).map((t) => this.boardTicket(t, { notes: false })), total: sorted.length, scope };
  }

  private boardRelated(t: Ticket): BoardRelatedTicket {
    return { ...this.relatedView(t), projectKey: this.store.projects.get(t.projectId)?.key ?? "" };
  }

  async getTicket_(ctx: ToolContext, key: string, opts: { transcript?: number; agents?: boolean } = {}): Promise<BoardTicketDetail> {
    const sc = this.scopeOf(ctx);
    const found = this.agentLookup(sc, key, { drafts: true });
    if (!found) {
      const requested = String(key ?? "").trim().toUpperCase();
      const related = requested ? this.relatedTickets(sc, requested, null) : [];
      if (!related.length) {
        // The Inbox isn't any project's: a group scope can't tell an item's key from a missing ticket's.
        const item = requested && sc.scope === "all" ? this.store.sessions.list("triage").find((s) => s.triageStatus !== null && s.key.toUpperCase() === requested) : undefined;
        if (item) {
          const routed = item.outcome ? ` (${item.outcome})` : "";
          throw new Error(`${item.key} is an Inbox item${routed}, not a ticket. Read it with list_inbox { key: "${item.key}", include_output: true }.`);
        }
        throw new Error(`Unknown ticket: ${key}`);
      }
      throw new RemoteIdError(`${this.remoteOnlyMessage(requested, related)} Call get_ticket with one of those keys.`, {
        ticket: null,
        requested,
        relatedTickets: related.map((r) => this.boardRelated(r)),
      });
    }
    const t = found.ticket;
    const detail: BoardTicketDetail = {
      ticket: this.boardTicket(t),
      relatedTickets: this.relatedTickets(sc, found.alias ?? t.key, t).map((r) => this.boardRelated(r)),
      resolvedFrom: found.alias,
      parent: t.parentId ? (sc.tickets.get(t.parentId)?.key ?? null) : null,
      children: sc.tickets.list({ parentId: t.id }).map((c) => c.key),
      base: await this.refreshBaseBranch(t),
      specRevision: t.specRevision ?? 1,
      specBaselineRevision: t.specBaselineRevision ?? null,
      activity: sc.activity(t).map((e) => ({ kind: e.kind, author: e.author, body: e.body, meta: e.meta, createdAt: e.createdAt })),
      attachments: this.store.attachments.listByTicket(t.id).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path })),
      // Each with the human's numbered notes on it (Attachment.annotation), one line per note.
      promptAttachments: (t.promptAttachments ?? []).map((a) => ({ id: a.id, name: a.name, path: a.path, missing: !fileOf(a), ...(a.annotation ? { notes: compactNotes(a.annotation) } : {}) })),
    };
    const n = Math.min(BOARD_TRANSCRIPT_MAX, Math.max(0, Math.trunc(opts.transcript ?? 0)));
    if (n > 0) detail.transcript = this.boardTranscript(t.sessionId, n, null);
    if (opts.agents) detail.agents = this.store.subagents.listBySession(t.sessionId).map((s) => boardAgent(s, BOARD_AGENT_LIST_CHARS));
    return detail;
  }

  /** The last `n` text/status/error entries of the session agent's transcript (or a sub-agent's), clipped. */
  private boardTranscript(sessionId: string, n: number, subagentId: string | null): BoardTranscriptEntry[] {
    return this.store.transcript.tail(sessionId, n, ["text", "status", "error"], subagentId).map((e) => ({
      role: e.role,
      type: e.content.type as "text" | "status" | "error",
      text: truncateMiddle("text" in e.content ? e.content.text : "", BOARD_TRANSCRIPT_CHARS),
      createdAt: e.createdAt,
    }));
  }

  async getTicketAgent_(ctx: ToolContext, key: string, id: string, opts: { transcript?: number } = {}): Promise<BoardAgentDetail> {
    const t = this.agentTarget(this.scopeOf(ctx), key);
    if (!t) throw new Error(`Unknown ticket: ${key}`);
    const s = this.store.subagents.get(t.sessionId, id);
    if (!s) throw new Error(`${t.key} has no sub-agent or task ${id}. get_ticket { key: "${t.key}", include_agents: true } lists them.`);
    const out: BoardAgentDetail = { ticket: t.key, agent: { ...boardAgent(s, BOARD_AGENT_TEXT_CHARS), prompt: truncateMiddle(s.prompt, BOARD_AGENT_TEXT_CHARS) } };
    if (isTask(s)) {
      // A task the driver never said where its output goes has none to read.
      const o = this.store.subagents.outputSource(t.sessionId, id) ? this.taskOutput(t.sessionId, id) : unavailable(undefined, s.status !== "running");
      const text = o.text.length > BOARD_TASK_OUTPUT_CHARS ? o.text.slice(-BOARD_TASK_OUTPUT_CHARS) : o.text;
      out.output = { text, truncated: o.start > 0 || text.length < o.text.length, done: o.done, available: o.available };
    } else {
      const n = Math.min(BOARD_TRANSCRIPT_MAX, Math.max(0, Math.trunc(opts.transcript ?? BOARD_AGENT_TRANSCRIPT_DEFAULT)));
      out.transcript = this.boardTranscript(t.sessionId, n, s.id);
    }
    return out;
  }

  async searchTickets_(ctx: ToolContext, input: Parameters<HarnessOps["searchTickets"]>[1]) {
    const sc = this.scopeOf(ctx);
    const projectId = input.projectKey ? this.boardProject(sc, input.projectKey).id : undefined;
    let page: TicketPage;
    try {
      if (!input.query?.trim()) throw badRequest("q is required");
      const limit = clampLimit(input.limit ?? BOARD_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
      page = this.withCursor(() => sc.tickets.search({ q: input.query, projectId, limit, cursor: input.cursor ?? null, ...(input.includeDrafts === false ? { drafts: false } : {}) }));
    } catch (err) {
      throw new Error(errMsg(err));
    }
    return {
      hits: page.tickets.map((t) => {
        const latest = this.latestNote(t)?.body;
        return { ticket: this.boardTicket(t, { notes: false }), snippet: searchSnippet([t.title, t.spec, latest], input.query) };
      }),
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async listProjects_(ctx: ToolContext): Promise<ProjectView[]> {
    return this.scopeOf(ctx).projects.list().map((p) => this.projectView(p));
  }

  async listInbox_(ctx: ToolContext, filter: Parameters<HarnessOps["listInbox"]>[1]): Promise<{ items: InboxItem[]; total: number }> {
    // Inbox items belong to no project: a group scope has none.
    if (this.scopeOf(ctx).scope !== "all") return { items: [], total: 0 };
    const limit = Math.min(Math.max(1, filter.limit ?? BOARD_INBOX_LIMIT), 100);
    const source = filter.source?.trim().toLowerCase();
    const key = filter.key?.trim().toUpperCase();
    const matches = this.store.sessions
      .list("triage")
      // A legacy Inbox item always has a triage status (the migration settled the open ones); a triage agent run has none.
      .filter((s) => s.triageStatus !== null)
      .map((s) => ({ s, meta: this.store.sessions.getMeta<LegacyTriageMeta>(s.id) }))
      .filter(({ s, meta }) => {
        if (key && s.key.toUpperCase() !== key) return false;
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
    if (!BOARD_WRITE_RUNS.includes(ctx.runKind)) throw new Error(`${tool} is only available in work, conductor, chat and chief of staff runs`);
    return this.ctxTicket(ctx);
  }

  /** A plan run's update_ticket target: its own ticket, and no other. */
  private ownPlanTarget(ctx: ToolContext, key: string): Ticket {
    const own = this.ctxTicket(ctx);
    const target = this.agentTarget(this.scopeOf(ctx), String(key ?? "").trim());
    if (target?.id !== own.id) throw new Error(`In a planning run, update_ticket only edits your own ticket (${own.key}).`);
    return own;
  }

  /** Another ticket the caller may act on: never its own (block / submit_for_review cover that). */
  private boardTarget(ctx: ToolContext, key: string, tool: string): { actor: Ticket; target: Ticket } {
    const actor = this.boardActor(ctx, tool);
    const target = this.agentTarget(this.scopeOf(ctx), String(key ?? "").trim());
    if (!target) throw new Error(`Unknown ticket: ${key}`);
    this.cosMayAct(actor, target);
    if (target.id === actor.id) {
      throw new Error(`${target.key} is your own ticket. ${tool} acts on other tickets; use ${actor.kind === "conductor" ? "submit_for_review" : "block or submit_for_review"} to change your own.`);
    }
    return { actor, target };
  }

  /** depends_on keys a tool names: each must be a ticket the run's scope can see. */
  private scopedDependencies(sc: ScopedStore, keys: string[] | undefined) {
    for (const k of keys ?? []) if (!sc.tickets.getByKey(String(k))) throw new Error(`Unknown dependency: ${k}`);
  }

  /**
   * A chief of staff acting on a blocked ticket is answering it. That is the project's call: with
   * "CoS can unblock" off for the ticket's project (cosCanUnblock, else the app's) the write tools
   * refuse, and reading and reporting on it stay available. Every board write passes through
   * boardTarget, so this is the one place a chief of staff's actions on a blocked ticket are gated.
   */
  private cosMayAct(actor: Ticket, target: Ticket) {
    if (actor.kind !== "cos" || target.status !== "blocked") return;
    const project = this.store.projects.get(target.projectId);
    if (resolveCosSetting(project, this.settings(), "cosCanUnblock")) return;
    throw new Error(
      `${target.key} is blocked and waiting on a human: "CoS can unblock" is off for ${project?.key ?? "its project"} (Settings, or the project's settings), so a chief of staff doesn't answer its tickets. You can still read it and report what it asks. ${
        target.blockedReason ? `It asks: ${target.blockedReason}` : ""
      }`.trim(),
    );
  }

  /** Activity for what a chief of staff did to a ticket, so the ticket's own history says who. */
  private cosNote(actor: Ticket, target: Ticket, what: string) {
    if (actor.kind !== "cos") return;
    const t = this.store.tickets.get(target.id);
    if (t) this.addActivityLine(t, "note", "agent", `Chief of staff (${actor.key}) ${what}`);
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
    const sc = this.scopeOf(ctx);
    // A chief of staff belongs to no project, so it always names the one the ticket goes in.
    if (own.kind === "cos" && !input.projectKey) throw new Error("project_key is required: a chief of staff has no project of its own. list_projects has the keys.");
    const project = input.projectKey ? this.boardProject(sc, input.projectKey) : this.store.projects.get(own.projectId);
    if (!project) throw new Error(`Unknown project for ${own.key}`);
    this.scopedDependencies(sc, input.dependsOn);
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
    if (input.remoteUrl && !input.remoteId) throw new Error("remote_url needs remote_id: the external item's key, e.g. FOO-123");
    const externalRef = input.remoteId ? this.asToolSync(() => this.manualExternalRef(null, { key: input.remoteId!, url: input.remoteUrl })) : null;
    // A chief of staff has no checkout: it can attach nothing from the host's disk.
    if (own.kind === "cos" && input.attachments?.length) throw new Error("A chief of staff can't attach files: it has no files of its own. Put what the ticket needs in its spec.");
    const promptAttachments = input.attachments?.length ? input.attachments.map((p) => ({ path: resolve(ctx.cwd, String(p)) })) : undefined;
    if (own.kind !== "cos" && (input.child ?? own.kind === "conductor")) {
      // Children run on the parent's driver/model unless it picks another. Any ticket can take
      // children; having one makes it act as a conductor (isConductor).
      return this.asTool(() =>
        this.createTicket({
          projectId: project.id,
          spec: input.spec || input.title,
          title: input.title,
          kind,
          dependsOn: input.dependsOn,
          autoStart: input.autoStart ?? true,
          parentId: own.id,
          start: input.start ?? false,
          // The parent's own choices, with the shorthand and phase_models over them.
          phaseModels: mergePhaseModels(
            input.driver !== undefined || input.model !== undefined
              ? withLegacyChoice(own.phaseModels, {
                  driver: input.driver ?? own.driver,
                  model: input.model !== undefined ? input.model : input.driver ? null : own.model,
                })
              : own.phaseModels,
            input.phaseModels ?? {},
          ),
          permissionMode,
          useWorktree: input.useWorktree,
          branch: input.branch,
          baseBranch: input.baseBranch,
          skipAgentReview: input.skipAgentReview,
          skipHumanReview: input.skipHumanReview,
          externalRef,
          promptAttachments,
        }, "agent"),
      );
    }
    const created = await this.asTool(() =>
      this.createTicket({
        projectId: project.id,
        spec: input.spec || input.title,
        title: input.title,
        kind,
        dependsOn: input.dependsOn,
        autoStart: input.autoStart,
        start: input.start ?? false,
        driver: input.driver,
        model: input.model,
        phaseModels: input.phaseModels,
        permissionMode,
        useWorktree: input.useWorktree,
        branch: input.branch,
        baseBranch: input.baseBranch,
        skipAgentReview: input.skipAgentReview,
        skipHumanReview: input.skipHumanReview,
        externalRef,
        promptAttachments,
      }, "agent"),
    );
    this.cosNote(own, created, "created it");
    return created;
  }

  /**
   * A work or chat run's own ticket, when its only field is pullRequestUrls: the one edit these runs
   * make to their own card (they add the pull requests they opened outside the completion run, and a
   * chat on a ticket in review opens one when the human asks for it). Anything else on its own ticket
   * is refused by boardTarget.
   */
  private ownWorkPullRequests(ctx: ToolContext, key: string, fields: string[]): Ticket | null {
    if ((ctx.runKind !== "work" && ctx.runKind !== "chat") || fields.length !== 1 || fields[0] !== "pullRequestUrls") return null;
    const own = this.ctxTicket(ctx);
    // Resolved like ownPlanTarget does, so an earlier key (alias) of this ticket counts too. A remote ID never identifies a ticket.
    const target = this.agentTarget(this.scopeOf(ctx), String(key ?? "").trim());
    return target?.id === own.id ? own : null;
  }

  async updateTicket_(ctx: ToolContext, key: string, input: UpdateTicketInput): Promise<Ticket> {
    // A planning agent sets up its own ticket from the spec (dependencies, branch, reviews, mode...)
    // before the human presses Start, which approves the plan and those settings together. It edits
    // nothing else, and has full access to its own card.
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateTicketInput] !== undefined);
    const own = ctx.runKind === "plan" ? this.ownPlanTarget(ctx, key) : this.ownWorkPullRequests(ctx, key, fields);
    const { actor, target } = own ? { actor: own, target: own } : this.boardTarget(ctx, key, "update_ticket");
    // Editing a looser ticket (its spec, dependencies, driver...) would get it to act for the caller
    // under looser permissions. The one edit allowed on it is tightening its mode, alone.
    if (!own && !(fields.length === 1 && fields[0] === "permissionMode")) this.notLooserThanCaller(actor, target);
    const body: UpdateTicketBody = {};
    if (input.title !== undefined) {
      if (!String(input.title).trim()) throw new Error("title can't be empty");
      body.title = String(input.title).trim();
    }
    if (input.spec !== undefined) {
      if (!String(input.spec).trim()) throw new Error("spec can't be empty");
      // Like edit_spec: the write names the revision it replaces, so a human's edit in between isn't overwritten.
      if (input.baseRevision === undefined) {
        throw new Error(`base_revision is required with spec: the specRevision get_ticket showed for ${target.key} (it's at ${target.specRevision ?? 1} now).`);
      }
      if (input.baseRevision !== (target.specRevision ?? 1)) throw new Error(this.staleSpecMessage(target, input.baseRevision, `get_ticket { key: "${target.key}" }`));
      body.spec = String(input.spec);
      body.baseRevision = input.baseRevision;
    } else if (input.baseRevision !== undefined) {
      throw new Error("base_revision only goes with spec");
    }
    if (input.driver !== undefined) body.driver = input.driver;
    if (input.model !== undefined) body.model = input.model;
    if (input.phaseModels !== undefined) body.phaseModels = input.phaseModels;
    if (input.dependsOn !== undefined) {
      this.scopedDependencies(this.scopeOf(ctx), input.dependsOn);
      body.dependsOn = input.dependsOn;
    }
    if (input.pullRequestUrls !== undefined) body.pullRequestUrls = input.pullRequestUrls;
    if (input.baseBranch !== undefined) body.baseBranch = input.baseBranch;
    if (input.branch !== undefined) body.branch = input.branch;
    if (input.remoteId !== undefined || input.remoteUrl !== undefined) body.externalRef = this.toolExternalRef(target, input.remoteId, input.remoteUrl);
    if (input.skipAgentReview !== undefined || input.skipHumanReview !== undefined) {
      // Turning one on in review would end the review under way; that's the reviewers' call.
      if (target.status === "review" && target.parentId !== actor.id) {
        throw new Error(`${target.key} is in review; its reviewers decide whether its reviews run.`);
      }
      if (input.skipAgentReview !== undefined) body.skipAgentReview = input.skipAgentReview;
      if (input.skipHumanReview !== undefined) body.skipHumanReview = input.skipHumanReview;
    }
    if (input.permissionMode !== undefined) {
      // Agents may tighten another ticket's permission mode, never loosen it: that would be a way
      // around the approvals a human set up. A planning agent's own ticket is the exception: the
      // mode is for the work run the human starts after reading the plan.
      const mode = this.asToolSync(() => validPermissionMode(input.permissionMode));
      const project = this.store.projects.get(target.projectId);
      const from = resolvePermissionMode(target, project, this.settings()).mode;
      const to = resolvePermissionMode({ permissionMode: mode }, project, this.settings()).mode;
      if (!own && PERMISSION_STRICTNESS[to] < PERMISSION_STRICTNESS[from]) {
        throw new Error(`Agents can't loosen a ticket's permission mode (${target.key} runs in ${from}; ${mode ?? "inherit"} would be ${to}). Ask a human.`);
      }
      body.permissionMode = mode;
    }
    if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one field");
    try {
      const updated = await this.updateTicket(target.key, body, { author: "agent", runId: ctx.runId, runKind: ctx.runKind });
      if (!own) this.cosNote(actor, updated, `edited ${Object.keys(body).join(", ")}`);
      return updated;
    } catch (err) {
      // The spec moved on between the check above and the write.
      if (err instanceof HarnessError && err.status === 409 && body.baseRevision !== undefined && (err.data as SpecConflict | undefined)?.currentRevision !== undefined) {
        throw new Error(this.staleSpecMessage(this.store.tickets.get(target.id) ?? target, body.baseRevision, `get_ticket { key: "${target.key}" }`));
      }
      throw new Error(errMsg(err));
    }
  }

  /**
   * update_ticket's remote_id / remote_url as a PATCH externalRef. remote_id null unlinks; a remote
   * ID without remote_url keeps the link it already has when it's the one the ticket carries; a
   * remote_url alone re-links the ticket's current remote ID.
   */
  private toolExternalRef(target: Ticket, remoteId: string | null | undefined, remoteUrl: string | null | undefined): ExternalRefInput | null {
    const current = target.externalRef;
    if (remoteId === null) {
      if (remoteUrl) throw new Error("remote_url can't be set while unlinking (remote_id \"\")");
      return null;
    }
    if (remoteId === undefined) {
      if (!current) throw new Error(`${target.key} has no remote ID to change the link of; pass remote_id too`);
      return { key: current.key, url: remoteUrl ?? null };
    }
    const same = current && current.key.toUpperCase() === remoteId.trim().toUpperCase();
    return { key: remoteId, url: remoteUrl !== undefined ? remoteUrl : same ? current.url : null };
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
      if (status === "in_progress") {
        throw new Error(`Moving ${target.key} to in_progress doesn't start it: use start_ticket to start work, or resume_work (its own agent) to re-open reviewed work.`);
      }
      if (status === "done" && target.status !== "planning") {
        throw new Error(`${target.key} is ${target.status}: only a ticket still in planning can be moved straight to done (to close one that isn't needed). Finished work goes through review.`);
      }
      if (status === "planning") this.notLooserThanCaller(actor, target);
    } else if (position === undefined) {
      throw new Error(`${target.key} is already ${status}; pass position to reorder it`);
    }
    let pos: number | undefined;
    if (position !== undefined) {
      if (status === "done") throw new Error("The done column is ordered by completion time; position doesn't apply");
      const column = this.store.tickets.list({ projectId: target.projectId, statuses: [status], drafts: false }).filter((t) => t.id !== target.id);
      pos = positionForDrop(column, position);
    }
    const moved = await this.asTool(() =>
      this.updateTicket(
        target.key,
        { ...(status !== target.status ? { status } : {}), ...(pos !== undefined ? { position: pos } : {}) },
        { author: "agent", runId: ctx.runId, runKind: ctx.runKind },
      ),
    );
    if (status !== target.status) this.cosNote(actor, moved, `moved it to ${status}`);
    return moved;
  }

  async startTicket_(ctx: ToolContext, key: string): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "start_ticket");
    this.noPendingApproval(target);
    this.notLooserThanCaller(actor, target);
    const started = await this.asTool(() => this.startTicket(target.key, "agent"));
    this.cosNote(actor, started, "started it");
    return started;
  }

  async messageTicket_(ctx: ToolContext, key: string, text: string): Promise<void> {
    const { actor, target } = this.boardTarget(ctx, key, "message_ticket");
    this.noPendingApproval(target);
    this.notLooserThanCaller(actor, target);
    await this.asTool(() => this.sendMessage(target.key, text, { author: "agent" }));
    this.cosNote(actor, target, "sent it a message");
  }

  async cancelTicket_(ctx: ToolContext, key: string): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "cancel_ticket");
    // Nothing runs while an approval waits; cancelling would only strand it.
    this.noPendingApproval(target);
    const cancelled = await this.asTool(() => this.cancelTicket(target.key));
    this.cosNote(actor, cancelled, "cancelled its run");
    return cancelled;
  }

  async reopenTicket_(ctx: ToolContext, key: string, notes: string): Promise<Ticket> {
    const { actor, target } = this.boardTarget(ctx, key, "reopen_ticket");
    this.notLooserThanCaller(actor, target);
    const reopened = await this.asTool(() => this.reopenTicket(target.key, { notes }));
    this.cosNote(actor, reopened, "re-opened it");
    return reopened;
  }

  // --- conductor ---

  /** The caller, standing in for its children's human reviewer. Any ticket may: childOf checks the parent. */
  private conductorOf(ctx: ToolContext, tool: string): Ticket {
    return this.boardActor(ctx, tool);
  }

  private childOf(sc: ScopedStore, conductor: Ticket, key: string): Ticket {
    const t = this.agentTarget(sc, key);
    if (!t) throw new Error(`Unknown ticket: ${key}`);
    if (t.parentId !== conductor.id) throw new Error(`${t.key} is not a child of ${conductor.key}`);
    return t;
  }

  async reviewTicket_(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string, action?: CompletionAction): Promise<Ticket> {
    const child = this.childOf(this.scopeOf(ctx), this.conductorOf(ctx, "review_ticket"), key);
    try {
      return this.applyReview(child, decision, notes ?? "", "conductor", { action });
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  async completeTicket_(ctx: ToolContext, key: string, instructions?: string, action?: CompletionAction): Promise<Ticket> {
    const child = this.childOf(this.scopeOf(ctx), this.conductorOf(ctx, "complete_ticket"), key);
    if (child.status !== "review" || !reviewPassed(child.agentReview) || child.humanReview !== "approved") {
      throw new Error(`${child.key} is not ready: both reviews must be approved first`);
    }
    try {
      return await this.completeTicket(child.key, { instructions, action });
    } catch (err) {
      throw new Error(errMsg(err));
    }
  }

  /**
   * record_pull_request: the pull request a "pr" completion opened (or updated), or a "cleanup" of a
   * ticket with a pull request pushed to, and the commit it pushed. The commit must be a hash the
   * project repo has; it's stored in full, and the git plugin pins it as the ticket's Changes
   * (DESIGN.md "Pinned diffs").
   */
  async recordPullRequest(ctx: ToolContext, url: string, head: string): Promise<string> {
    const t = this.ctxTicket(ctx);
    const pushesToPullRequest = t.completionAction === "pr" || (t.completionAction === "cleanup" && t.pullRequests.length > 0);
    if (ctx.runKind !== "complete" || !pushesToPullRequest) {
      throw new Error("record_pull_request is only for completion runs that open a pull request");
    }
    const u = String(url ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(u)) throw new Error("url must be the pull request's http(s) link, as gh printed it");
    const h = String(head ?? "").trim();
    if (!/^[0-9a-f]{7,64}$/i.test(h)) throw new Error("head must be the hash of the commit you pushed (`git rev-parse HEAD` in the worktree), not a branch or ref name");
    const repo = [t.workdir, this.store.projects.get(t.projectId)?.path].find((d): d is string => !!d && existsSync(d));
    const resolved = repo ? await git(["rev-parse", "--verify", "--quiet", `${h}^{commit}`], repo) : null;
    if (!resolved || resolved.code !== 0 || !resolved.stdout) throw new Error(`head ${h} isn't a commit in this ticket's repository`);
    // Appends the link, or moves a link the ticket already has to the end, so the last link is the one
    // whose head is pinned (pullRequestUrl mirrors the last link). Any link still without a title is
    // fetched again, since its earlier fetch may have failed.
    const urls = t.pullRequests.map((pr) => pr.url).filter((url) => url !== u);
    const change = this.store.tickets.setPullRequestUrls(t.id, [...urls, u])!;
    const untitled = change.ticket.pullRequests.filter((pr) => pr.title === null).map((pr) => pr.url);
    const updated = this.store.tickets.update(t.id, { pullRequestHead: resolved.stdout })!;
    this.bus.emit({ kind: "ticket.upserted", ticket: updated });
    this.fetchPullRequestTitles(t.id, [...new Set([...change.added, ...untitled])]);
    this.appendStatus(t.sessionId, ctx.runId, `Pull request: ${u}`);
    const a = this.ctxActive(ctx);
    if (a) a.pullRequest = true;
    return `Recorded ${u} at ${resolved.stdout.slice(0, 8)} on ${t.key}.`;
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
      phaseModels: p.phaseModels ?? {},
      useWorktrees: p.useWorktrees,
      skipAgentReview: !!p.skipAgentReview,
      skipHumanReview: !!p.skipHumanReview,
      permissionMode: p.permissionMode,
      color: p.color,
      group: p.group ?? null,
      groupId: p.groupId ?? null,
      baseBranch: p.baseBranch ?? null,
      cosEnabled: p.cosEnabled ?? null,
      cosCanUnblock: p.cosCanUnblock ?? null,
      cosModel: p.cosModel ?? null,
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

  /** The watcher a chief names, among the ones its scope covers (another chief's can't be told from one that doesn't exist). */
  private watcherByRef(ctx: ToolContext, ref: string): Watcher {
    const sc = this.scopeOf(ctx);
    const byId = sc.watchers.get(ref);
    if (byId) return byId;
    const named = sc.watchers.list().filter((w) => w.name === ref);
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

  async listWatchers_(ctx: ToolContext): Promise<Watcher[]> {
    const visible = new Set(this.scopeOf(ctx).watchers.list().map((w) => w.id));
    return this.listWatchers().filter((w) => visible.has(w.id));
  }

  /** The chief a watcher write acts for: only a chief of staff has watchers, and a human approves each call (the tool is gated). */
  private watcherWriter(ctx: ToolContext): Cos {
    const cos = ctx.ticket?.kind === "cos" ? this.store.cos.get(ctx.ticket.id) : null;
    if (!cos) throw new Error("Only a chief of staff manages watchers.");
    return cos;
  }

  /** App-wide configuration (settings, prompts) is for the All chief of staff; a group's chief sees only its group. */
  private appWide(ctx: ToolContext, what: string) {
    if (this.scopeOf(ctx).scope !== "all") throw new Error(`${what} shows app-wide configuration: only the All chief of staff may read it.`);
  }

  async getSettings_(ctx: ToolContext): Promise<PublicSettings> {
    this.appWide(ctx, "get_settings");
    return this.publicSettings();
  }

  async listDrivers_(_ctx: ToolContext) {
    const infos = await this.driverInfos();
    return Promise.all(infos.map(async (info) => ({ ...info, models: await this.listModels(info.id) })));
  }

  async createWatcher_(ctx: ToolContext, input: WatcherBody & { name: string; command: string }, dryRun = false): Promise<Watcher | null> {
    const cos = this.watcherWriter(ctx);
    // The tools take no owner: a watcher belongs to the chief that makes it (the All chief is stored as NULL).
    const owned = { ...input, cosId: cos.scope === "all" ? null : cos.ticketId };
    return this.asToolError(() => {
      if (dryRun) return (this.validateWatcher(owned, null), null);
      const w = this.createWatcher(owned);
      this.log(`watcher "${w.name}" created by ${ctx.ticket!.key}`);
      return w;
    });
  }

  async updateWatcher_(ctx: ToolContext, ref: string, input: WatcherBody, dryRun = false): Promise<Watcher | null> {
    this.watcherWriter(ctx);
    const w = this.watcherByRef(ctx, ref);
    const { cosId: _owner, ...rest } = input;
    const body: WatcherBody = rest;
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
    this.watcherWriter(ctx);
    const w = this.watcherByRef(ctx, ref);
    if (!dryRun) this.deleteWatcher(w.id);
    return w;
  }

  async runWatcher_(ctx: ToolContext, ref: string, dryRun = false): Promise<Watcher> {
    this.watcherWriter(ctx);
    const w = this.watcherByRef(ctx, ref);
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
    const secrets = ["anthropicApiKey", "claudeOauthToken", "copilotGithubToken"];
    for (const k of [...secrets, "anthropicApiKeySet", "claudeOauthTokenSet", "copilotGithubTokenSet", "claudePermissionMode"]) {
      if (patch && k in patch) throw new Error(`${k} can't be changed with a tool${secrets.includes(k) ? ": ask the human to enter it in Settings" : ""}.`);
    }
    return this.asToolError(() => {
      if (dryRun) return (validateSettingsPatch(patch, [...this.drivers.keys()], this.settings()), this.publicSettings());
      return this.updateSettings(patch);
    });
  }

  async deleteTicket_(ctx: ToolContext, key: string, dryRun = false): Promise<Ticket> {
    const own = this.configWriter(ctx);
    const t = this.agentTarget(this.scopeOf(ctx), String(key ?? "").trim().toUpperCase());
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
    // Triage has no human and no ticket: Harness's own read-only policy answers (permissions/triage.ts).
    if (ctx.runKind === "triage") {
      const d = triageDecision(toolName, input);
      this.logPermission(ctx.session.id, ctx.runId, { tool: toolName, decision: d.behavior, source: "policy", mode: "read_only", summary: summarizeToolInput(input, 200), reason: d.behavior === "allow" ? "read-only" : d.message });
      return d.behavior === "allow" ? { behavior: "allow", updatedInput: input } : d;
    }
    if (ctx.runKind === "plan" && toolName === "ExitPlanMode") {
      // Claude Code's plan mode asks to leave it; on the board the human approves the plan instead.
      return { behavior: "deny", message: PLAN_APPROVAL_MESSAGE };
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
   * A chat's approval leaves the ticket in its column: the card shows wherever the ticket is.
   */
  private openApproval(t: Ticket, runId: string, toolName: string, input: unknown, meta: ApprovalMeta) {
    const pending: PendingApproval = { id: crypto.randomUUID(), runId, toolName, input, requestedAt: this.now() };
    if (meta.reason) pending.reason = meta.reason;
    if (meta.source) pending.source = meta.source;
    if (meta.summary) pending.summary = meta.summary;
    if (meta.onceOnly) pending.onceOnly = true;
    const reason = `Permission needed: ${toolName} — ${meta.summary ?? summarizeToolInput(input)}`;
    // The approval card shows the classifier's or policy's reason; Activity gets the one line.
    const stays = t.status === "blocked" || t.kind === "cos" || this.store.runs.get(runId)?.kind === "chat";
    this.addActivityLine(t, "permission", "system", reason, {
      ...(meta.reason ? { detail: `${reason}\n\n${meta.source === "classifier" ? "Classifier" : "Policy"}: ${meta.reason}` } : {}),
      ...(stays ? {} : this.moveMeta(t, "blocked")),
    });
    if (stays) {
      this.store.tickets.update(t.id, { pendingApproval: pending });
      this.touchSession(t.sessionId);
      this.appendStatus(t.sessionId, null, reason);
    } else {
      this.transition(t, "blocked", { pendingApproval: pending, blockedReason: reason }, reason, reason);
    }
  }

  /**
   * RunRequest.grants: human grants for runs that act for the ticket (not review/plan/triage, not
   * read_only).
   */
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
   * call without asking (Claude Code's auto-mode classifier, or a deferred soft_deny of the
   * PermissionGate) and the call never went through. The agent is told to find another way
   * first, so a run that submitted is reviewed as usual, with the denied calls noted in
   * Activity. Otherwise the run's last denial becomes a pending approval: attached to the
   * agent's block if it blocked, or blocking the ticket if the run just ended.
   * A denial of a tool the human already allows on the ticket is retried with the exact call
   * pre-approved instead (bounded by MAX_AUTO_RETRIES). Returns true when it handled the run.
   */
  private surfaceDenial(ticket: Ticket, run: Run, active: ActiveRun): boolean {
    const denial = active.denials.at(-1);
    if (!denial || !APPROVABLE_RUNS.includes(run.kind)) return false;
    const t = this.store.tickets.get(ticket.id);
    if (!t || t.pendingApproval || this.permissionModeFor(t) === "read_only") return false;
    // A completion that called resume_work left the ticket in progress with a work run queued behind it: its denied call is moot.
    if (run.kind === "complete" && t.status === "in_progress") return false;
    if (active.submitted && t.status === "review") {
      // The agent found another way and submitted: the review goes ahead, and the denied calls
      // are on record for the reviewer and the human.
      const calls = [...new Map(active.denials.map((d) => [grantKey(d.toolName, d.input), d])).values()];
      const lines = calls.map((d) => `- ${d.toolName} (${summarizeToolInput(d.input)}): ${d.reason}`);
      const summary = `The classifier denied ${calls.length === 1 ? "a call" : `${calls.length} calls`} during this run, and the agent submitted without ${calls.length === 1 ? "it" : "them"}`;
      this.addActivity(t, "permission", "system", `${summary}.`, { detail: `${summary}:\n${lines.join("\n")}` });
      this.appendStatus(t.sessionId, run.id, `${summary}:\n${lines.join("\n")}`);
      return false;
    }
    // A chat's denial surfaces wherever the ticket is (its card leaves the column alone).
    if (run.kind !== "chat" && t.status !== "in_progress" && t.status !== "blocked" && !(t.status === "review" && run.kind === "complete")) return false;
    if (run.kind === "chat" && t.status === "done") return false;
    const key = grantKey(denial.toolName, denial.input);
    // The exact rule for this call was passed and it was still denied: next time, ask instead.
    if (active.appliedGrants.has(key)) this.ruleFailures.add(`${t.id}\u0000${key}`);
    const what = `${denial.toolName} (${summarizeToolInput(denial.input)})`;
    const retries = this.autoRetries.get(t.id) ?? 0;
    if (t.allowedTools.includes(denial.toolName) && retries < MAX_AUTO_RETRIES) {
      this.autoRetries.set(t.id, retries + 1);
      this.store.tickets.addGrant(t.id, denial.toolName, denial.input);
      const kind = run.kind === "complete" || run.kind === "chat" ? run.kind : this.workKind(t);
      this.appendStatus(t.sessionId, run.id, `Claude Code's classifier denied ${what}, but ${denial.toolName} is allowed on this ticket: retrying with that call pre-approved`);
      // A chat retries where the ticket is; a work run retries in progress.
      const u =
        kind === "chat"
          ? t
          : this.transition(t, kind === "complete" ? "review" : "in_progress", { blockedReason: null }, t.status === "blocked" ? "Unblocked: the denied tool is allowed on this ticket" : undefined);
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
    const remote = project && ticket?.completionAction === "cleanup" ? pushRemote(project.path) : null;
    return { base: base.branch, baseSource: base.source, ownsWorktree, worktreesDir: this.paths.worktreesDir, leftover, pullRequest, pushRemote: remote };
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
        : new ClaudeCliClassifier({ bin: () => resolveClaudeBin(process.env), env: () => claudeCliEnv(process.env, this.settings()), rules });
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
      isGranted: (tool, i) => !!ticket && (this.store.tickets.consumeGrant(ticket.id, tool, i) || ticket.allowedTools.includes(tool)),
      requestApproval: (tool, i, meta) => this.requestApproval(ctx, tool, i, meta),
      // A soft denial is the agent's to work around first; surfaceDenial turns the run's last
      // one into a card if the run ends stuck on it (runs that can hold a card only).
      defer:
        active && ticket && APPROVABLE_RUNS.includes(ctx.runKind)
          ? (tool, i, reason) => active.denials.push({ toolName: tool, input: i, reason })
          : undefined,
      log: (entry) => this.logPermission(ctx.session.id, ctx.runId, entry),
      context: () => ({
        ticket: ticket ? { key: ticket.key, title: ticket.title, spec: ticket.spec } : null,
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

  // =========================================================================
  // State machine internals
  // =========================================================================

  private workKind(t: Ticket): RunKind {
    return t.kind === "conductor" ? "conductor" : t.kind === "cos" ? "cos" : "work";
  }

  private isDone(key: string): boolean {
    const t = this.store.tickets.getByKey(key);
    return !t || t.status === "done"; // deleted dependencies no longer block
  }

  private depsDone(t: Ticket): boolean {
    return t.dependsOn.every((k) => this.isDone(k));
  }

  /** "Waiting on A, B": the status line of a ticket queued behind its open dependencies. */
  private waitingOnLine(t: Ticket): string {
    return `Waiting on ${t.dependsOn.filter((k) => !this.isDone(k)).join(", ")}`;
  }

  /**
   * Prepare the workdir, move to in_progress and enqueue the first work/conductor run. A worktree
   * that has gone missing (removed by the complete run of a ticket now re-opened) is recreated.
   */
  private async begin(ticket: Ticket, prompt: string, patch: TicketPatch = {}, note = "Moved to in progress", attachments: readonly Attachment[] = [], by: ActivityAuthor = "system") {
    this.notDraft(ticket, "started");
    if (this.starting.has(ticket.id)) return;
    this.starting.add(ticket.id);
    try {
      const dir = await this.workdirFor(ticket);
      if (typeof dir === "string") {
        this.addActivityLine(ticket, "failed", "system", dir, this.moveMeta(ticket, "blocked"));
        this.transition(ticket, "blocked", { blockedReason: dir }, "Could not create worktree");
        return;
      }
      let fresh = this.store.tickets.get(ticket.id);
      if (!fresh) return;
      if (fresh.status === "planning") {
        // Start: the spec as it is now is what the human approved; the agent review diffs against it.
        const rev = this.store.specs.markBaseline(fresh.id);
        this.appendStatus(fresh.sessionId, null, `Spec revision ${rev} approved as the baseline`);
        fresh = this.store.tickets.get(fresh.id)!;
      }
      this.store.sessions.update(fresh.sessionId, { cwd: dir.workdir });
      const line = fresh.status === "planning" ? "Work started" : note === "Moved to in progress" ? "" : note;
      this.transition(fresh, "in_progress", { ...patch, ...dir, blockedReason: null, pendingApproval: null, reviewRejections: 0, startAfterPlan: false, startAfterPlanBy: null }, note, undefined, { by, line });
      this.enqueueRun(fresh.sessionId, this.workKind(fresh), prompt, undefined, { attachments });
    } finally {
      this.starting.delete(ticket.id);
    }
  }

  /**
   * Give a ticket that has no workdir (or lost its worktree) one, without changing its status: for
   * a chat on a blocked ticket. Returns an error message when the worktree can't be created.
   */
  private async prepareWorkdir(ticket: Ticket): Promise<string | null> {
    const dir = await this.workdirFor(ticket);
    if (typeof dir === "string") return dir;
    const t = this.store.tickets.update(ticket.id, dir)!;
    this.store.sessions.update(t.sessionId, { cwd: dir.workdir });
    this.touchSession(t.sessionId);
    return null;
  }

  /**
   * The ticket's workdir and branch: its own when they're still there, else a new worktree (or the
   * project checkout for a project without worktrees). A string is why the worktree couldn't be made.
   */
  private async workdirFor(ticket: Ticket): Promise<{ workdir: string; branch: string | null } | string> {
    if (ticket.workdir && !(ticket.branch && !existsSync(ticket.workdir))) return { workdir: ticket.workdir, branch: ticket.branch };
    const project = this.store.projects.get(ticket.projectId)!;
    if (!((ticket.useWorktree ?? project.useWorktrees) && (await isGitRepo(project.path)))) return { workdir: project.path, branch: null };
    try {
      return await ensureWorktree({
        repo: project.path,
        worktreesDir: this.paths.worktreesDir,
        key: ticket.key,
        // A re-opened ticket whose worktree was removed gets its branch back.
        branch: ticket.requestedBranch ?? ticket.branch,
        base: (await this.refreshBaseBranch(ticket, project)).branch,
      });
    } catch (err) {
      return `Could not create worktree: ${errMsg(err)}`;
    }
  }

  /**
   * Change a ticket's status (plus optional fields), record a status line, and fire
   * status-change hooks: parent conductor notification and dependency scheduling.
   */
  /**
   * Move a ticket to another column (or update it in place). Every column change is in Activity:
   * the entry the caller just added for it (moveMeta) carries from/to, otherwise a `moved` entry
   * by `by` says why in one line (`line`, else the status text).
   */
  private transition(ticket: Ticket, to: TicketStatus, patch: TicketPatch, status?: string, note?: string, move: { by?: ActivityAuthor; line?: string; keepSession?: boolean; keepApprovals?: boolean } = {}): Ticket {
    const from = ticket.status;
    const pending = this.movesRecorded.get(ticket.id);
    this.movesRecorded.delete(ticket.id);
    const recorded = pending?.to === to && this.store.activity.listBySession(ticket.sessionId).at(-1)?.id === pending.entryId;
    // A scheduled restart is for the block that set it: any move (or a new block) drops it.
    const resume = patch.resumeAt === undefined && ticket.resumeAt ? { resumeAt: null } : {};
    // A completion's choice is spent once the ticket is done: a re-opened ticket's next approval
    // starts from the defaults again (clean up when it has a pull request open).
    const spent: TicketPatch = from === "done" && to !== "done" ? { completionAction: null, completionInstructions: null } : {};
    // Which run blocked the ticket belongs to that block: only a block that keeps the ticket
    // blocked (a chat re-asking) or sets it itself carries it over.
    const blockOwner: TicketPatch = patch.blockedRunKind === undefined && !(from === "blocked" && to === "blocked") ? { blockedRunKind: null, blockedHead: null } : {};
    // An approval to start after planning means nothing outside planning.
    const approval: TicketPatch = to !== "planning" && ticket.startAfterPlan ? { startAfterPlan: false, startAfterPlanBy: null } : {};
    // The approvals a completion's block kept were for that completion: any way out of the block
    // other than resuming it (a drag to review, Start) sends the work to be reviewed again.
    const reviewAgain: TicketPatch = from === "blocked" && ticket.blockedRunKind === "complete" && (to === "review" || to === "in_progress") && !move.keepApprovals ? { agentReview: "pending", humanReview: "pending" } : {};
    const t = this.store.tickets.update(ticket.id, { ...spent, ...approval, ...blockOwner, ...reviewAgain, ...patch, ...resume, status: to })!;
    if (patch.resumeAt !== undefined || "resumeAt" in resume) this.armResume();
    this.touchSession(t.sessionId);
    if (status) this.appendStatus(t.sessionId, null, status);
    if (from !== to) {
      // Where the card moved from decides whether the next run resumes (DESIGN.md "Driver state"):
      // a block keeps the running conversation and leaving Blocked resumes it; every other move
      // starts the next run fresh.
      if (from !== "blocked" && to !== "blocked" && !move.keepSession) this.newSession(t.sessionId);
      if (!recorded) this.addActivityLine(t, "moved", move.by ?? "system", move.line ?? status ?? "", { from, to });
      if (t.parentId && !(from === "planning" && to === "in_progress")) {
        this.notifyConductor(t.parentId, { key: t.key, title: t.title, from, to, note, specRevision: t.specRevision });
      }
      if (to === "in_progress" && this.conductorBuffer.has(t.id)) queueMicrotask(() => this.flushConductor(t.id));
      if (to === "review") this.track(this.refreshHasChanges(t));
      if (to === "done") {
        // A done ticket's pages would otherwise keep running (and rendering) in Chrome for good. Its tabs stay, to reload when someone looks.
        this.track(this.browser.suspendTabs(t.sessionId));
        this.kickScheduler();
        this.releaseReadyChildren(t);
      }
    }
    return t;
  }

  /**
   * The ticket moved columns: its next agent run starts a new driver conversation, and runs still
   * going from before the move no longer save theirs.
   */
  private newSession(sessionId: string) {
    this.store.sessions.setDriverState(sessionId, null);
    this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
  }

  /** A child its conductor still approves and lands (`managingConductor`: the parent isn't done). */
  private managedChild(t: Ticket): boolean {
    return !!managingConductor(t, t.parentId ? this.store.tickets.get(t.parentId) : null);
  }

  /**
   * A conductor went done with children it had approved but not completed. They're the human's now,
   * and nothing would land them, so their approval goes back to pending: approving lands them.
   */
  private releaseReadyChildren(conductor: Ticket) {
    for (const c of this.store.tickets.list({ parentId: conductor.id })) {
      if (c.status !== "review" || !reviewPassed(c.agentReview) || c.humanReview !== "approved" || this.completing(c)) continue;
      this.transition(c, "review", { humanReview: "pending" }, `${conductor.key} is done: approve to land this ticket`);
    }
  }

  /**
   * A complete run stopped without landing anything (cancelled, or cut off by a restart). The
   * approval goes back to pending, so the Approve button offers its choices again and approving
   * lands the work: nothing else starts a completion for a ticket that's already approved.
   */
  /**
   * A complete run stopped before it landed the work: the ticket stays in review with its agent
   * review approved. Approving again lands it, so the human approval goes back to pending. A
   * conductor-managed child whose completion failed or was interrupted stays ready instead, and
   * its conductor is told to call complete_ticket again (a cancel was someone's choice, so it
   * hands the approval back like any other).
   */
  private completionStopped(sessionId: string, why: "cancelled" | "interrupted" | "failed", error?: string | null) {
    const ticketId = this.store.sessions.get(sessionId)?.ticketId;
    const t = ticketId ? this.store.tickets.get(ticketId) : null;
    if (!t || t.status !== "review" || t.humanReview !== "approved") return;
    const what = `Completion ${why}${error ? ` (${error})` : ""}`;
    if (why !== "cancelled" && t.parentId && this.managedChild(t)) {
      const conductor = this.store.tickets.get(t.parentId)!;
      this.appendStatus(t.sessionId, null, `${what}: still approved, waiting on ${conductor.key} to complete it again`);
      this.notifyConductor(t.parentId, {
        key: t.key,
        title: t.title,
        from: "review",
        to: "review",
        note: `${what}. It's still approved and nothing landed it: call complete_ticket again once the cause is cleared.`,
        specRevision: t.specRevision,
      });
      return;
    }
    this.transition(t, "review", { humanReview: "pending" }, `${what}: approve again to land it`);
  }

  private submit(ticket: Ticket, note: string, author: ActivityAuthor) {
    const humanSkipped = !!ticket.skipHumanReview;
    const humanReview = humanSkipped ? "approved" : "pending";
    const agentReview = ticket.skipAgentReview ? "skipped" : "pending";
    this.addActivityLine(ticket, "submitted", author, note, { specRevision: ticket.specRevision ?? 1, ...this.moveMeta(ticket, "review") });
    const t = this.transition(ticket, "review", { agentReview, humanReview, blockedReason: null }, "Moved to review", note);
    if (agentReview === "skipped") this.appendStatus(t.sessionId, null, "Agent review: skipped");
    if (humanSkipped) this.appendStatus(t.sessionId, null, "Human review: skipped");
    if (agentReview === "skipped") this.noteReady(t);
  }

  private requestChanges(ticket: Ticket, notes: string, by: "agent" | "human" | "conductor", meta: ActivityMeta = { by }): Ticket {
    // A reviewer agent's or conductor's notes can be long (the author needs the detail): Activity
    // shows their first line, and the whole notes stay in meta.detail and the work run's prompt.
    const moved = { ...meta, ...this.moveMeta(ticket, "in_progress") };
    if (by === "human") this.addActivity(ticket, "changes_requested", "human", notes.trim() || "No notes.", moved);
    else this.addActivityLine(ticket, "changes_requested", "agent", notes.trim() || "No notes.", moved);
    const t = this.transition(
      ticket,
      "in_progress",
      { agentReview: "pending", humanReview: "pending", blockedReason: null },
      `Changes requested by ${by}`,
      notes,
    );
    this.enqueueRun(t.sessionId, this.workKind(t), this.prompts().changesRequestedPrompt(notes, by, t.specRevision ?? 1));
    return this.store.tickets.get(t.id)!;
  }

  /**
   * Both reviews approved: start the complete run right away, with the action chosen at approval
   * (else the project default). Conductor children wait for their conductor's complete_ticket
   * instead, unless they skip the human review: then nobody approves them, so they land too.
   */
  private noteReady(t: Ticket) {
    if (t.status !== "review" || !reviewPassed(t.agentReview) || t.humanReview !== "approved") return;
    // A child whose conductor is done is the human's again, and lands like any other ticket.
    if ((this.managedChild(t) && !t.skipHumanReview) || this.completing(t)) {
      this.appendStatus(t.sessionId, null, "Ready to complete");
      return;
    }
    this.appendStatus(t.sessionId, null, "Both reviews approved: completing automatically");
    // Nobody approves a ticket that skips its human review, so its leaving review is recorded here.
    if (t.skipHumanReview) this.addActivity(t, "approved", "system", "Human review skipped: completing automatically");
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

  /**
   * GET /usage: the plan-usage readings. Readings older than the poll interval (a service with no
   * client for a while) are read again first, and the first call reads them for the first time.
   */
  async planUsageReport(): Promise<PlanUsageReport> {
    if (this.driverList().some((d) => d.planUsage && !this.planUsage.isFresh(d.id, POLL_MS))) await this.planUsage.refresh();
    return this.planUsage.report();
  }

  /** A compact run holds the saved session: messages and ticket actions wait until it ends. */
  private notCompacting(t: Ticket, what: string) {
    if (!t.compacting) return;
    throw conflict(`The session is compacting: ${t.key} can't be ${what} until it finishes (cancel the run to stop it)`);
  }

  /**
   * What the human does with the ticket's saved session from the context gauge (DESIGN.md "Context
   * gauge"). It takes effect on the ticket's next run. Refused while a run is going, which is still
   * writing the session back.
   */
  async sessionAction(key: string, body: SessionActionBody): Promise<Ticket> {
    if (!body || typeof body !== "object") throw badRequest("body is required");
    if (body.action !== "compact" && body.action !== "new") throw badRequest('action must be "compact" or "new"');
    const ticket = this.requireTicket(key);
    this.notDraft(ticket, "given a session action (it has no agent yet)");
    if (ticket.busy) throw conflict(ticket.compacting ? `The session is compacting` : `${ticket.key} has a run going: its session can change once the run ends (cancel it to change it now)`);
    const session = this.store.sessions.get(ticket.sessionId)!;
    const state = this.store.sessions.getDriverState(session.id);
    const context = this.store.sessions.getContext(session.id);
    const stateDriver = this.store.sessions.stateDriver(session.id);
    const driver = stateDriver ? this.drivers.get(stateDriver) : undefined;
    if (body.action === "new") {
      if (driver && driver.sessionActions?.newSession === false) throw badRequest(`${driver.name} can't start a new session`);
      if (state == null && !context) return ticket; // nothing saved: it already starts fresh
      this.newSession(session.id);
      const size = context && !context.estimated ? ` (${tokensLabel(context.input + context.cacheRead + context.cacheWrite)} tokens)` : "";
      this.addActivityLine(ticket, "system", "human", `Session cleared${size}; the next run starts fresh`);
      this.touchTicket(ticket.id);
      return this.store.tickets.get(ticket.id)!;
    }
    if (state == null || !driver) throw conflict(`${ticket.key} has no saved session to compact`);
    if (!driver.sessionActions?.compact || !driver.compact) throw badRequest(`${driver.name} can't compact a session`);
    const run = this.store.runs.create({ sessionId: session.id, kind: "compact", driver: driver.id, prompt: "/compact" });
    this.bus.emit({ kind: "run.upserted", run });
    this.touchSession(session.id);
    this.queue.enqueue({ runId: run.id, sessionId: session.id, kind: "compact" });
    return this.store.tickets.get(ticket.id)!;
  }

  /** A complete run is queued or running for the ticket. */
  private completing(t: Ticket): boolean {
    if (this.startingComplete.has(t.id)) return true;
    return this.queue.runningFor(t.sessionId)?.kind === "complete" || this.queue.pendingFor(t.sessionId).some((j) => j.kind === "complete");
  }

  /** Start the agent review, unless the ticket skips it (submit already marked it "skipped"). */
  private enqueueReview(t: Ticket) {
    if (t.agentReview === "skipped") return;
    this.enqueueRun(t.sessionId, "review", this.prompts().reviewPrompt(t, this.reviewContext(t)));
  }

  /**
   * What a review run reads (DESIGN.md "Agent review"): the round, the earlier rounds' notes and
   * reviewed commits, the approved baseline revision, and the Activity since the last review (all
   * of it on the first).
   */
  reviewContext(t: Ticket): prompts.ReviewContext {
    const activity = this.store.activity.listBySession(t.sessionId);
    const rounds = this.agentReviewRounds(t);
    const last = rounds.at(-1);
    const since = last ? activity.slice(activity.findIndex((e) => e.id === last.id) + 1) : activity;
    return {
      round: rounds.length + 1,
      earlier: rounds.map((e) => ({ round: e.meta.round ?? 0, decision: e.kind === "review_approved" ? "approve" : "request_changes", notes: e.meta.detail ?? e.body, commit: e.meta.commit ?? null })),
      baselineRevision: t.specBaselineRevision ?? null,
      activity: since.slice(-30),
    };
  }

  private allChildrenDone(t: Ticket): boolean {
    return this.store.tickets.list({ parentId: t.id }).every((c) => c.status === "done");
  }

  /**
   * Re-check Ticket.hasChanges with git (hasChangesToLand against its effective base branch) and
   * broadcast the ticket when it changed. A ticket without a worktree of its own stays null.
   */
  private async refreshHasChanges(ticket: Ticket): Promise<void> {
    const t = this.store.tickets.get(ticket.id);
    if (!t) return;
    const has = t.branch && t.workdir ? await hasChangesToLand(t.workdir, t.branch, (await this.refreshBaseBranch(t)).branch) : null;
    const current = this.store.tickets.get(t.id);
    if (!current || (current.hasChanges ?? null) === has) return;
    this.store.tickets.update(current.id, { hasChanges: has });
    this.touchTicket(current.id);
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
      if (!(t.autoStart || t.startAfterPlan) || t.status !== "planning" || t.busy || this.starting.has(t.id)) continue;
      if (!this.depsDone(t)) continue;
      const fresh = this.store.tickets.get(t.id); // an earlier await may have started it already
      if (!fresh || fresh.draft || fresh.status !== "planning" || fresh.busy || this.starting.has(t.id)) continue;
      // An approved plan is the approver's Start (human or agent), whatever the dependency wait or the plan's last message.
      await this.begin(fresh, this.prompts().workStartPrompt(fresh), {}, undefined, [], fresh.startAfterPlan ? fresh.startAfterPlanBy ?? "human" : "system");
    }
  }

  /** Run restarts that are due now and arm the timer for the next one. */
  private kickResume() {
    this.track(this.resumeDue());
  }

  /** Point the timer at the earliest scheduled restart (none: no timer). */
  private armResume() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.stopping) return;
    let next = Infinity;
    for (const t of this.store.tickets.list({ drafts: false })) {
      if (t.status === "blocked" && t.resumeAt) next = Math.min(next, t.resumeAt);
    }
    if (next === Infinity) return;
    // setTimeout holds at most ~24.8 days; a later restart re-arms when this one fires.
    const delay = Math.min(Math.max(next - this.now(), 0), 2 ** 31 - 1);
    this.resumeTimer = setTimeout(() => this.kickResume(), delay);
    this.resumeTimer.unref?.();
  }

  /**
   * Restart blocked tickets whose resumeAt has come (DESIGN.md "Usage limits"), as if a human had
   * moved them to in progress. One waiting on a tool approval, or with a run going, keeps waiting
   * for the human instead.
   */
  async resumeDue() {
    if (this.stopping) return;
    const now = this.now();
    for (const t of this.store.tickets.list({ drafts: false })) {
      if (t.status !== "blocked" || !t.resumeAt || t.resumeAt > now) continue;
      const fresh = this.store.tickets.get(t.id);
      if (!fresh || fresh.status !== "blocked" || !fresh.resumeAt || fresh.resumeAt > now) continue;
      if (fresh.pendingApproval || fresh.busy || this.starting.has(fresh.id)) {
        this.store.tickets.update(fresh.id, { resumeAt: null });
        this.touchTicket(fresh.id);
        continue;
      }
      await this.begin(fresh, this.prompts().workStartPrompt(fresh), {}, "Restarted after the usage limit reset");
    }
    this.armResume();
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
   * The model a run starts with (see resolveRunModel).
   */
  private runModel(run: Run, session: Session, ticket: Ticket | null, project: Project | null): string | null {
    if (run.kind === "triage") return this.triageRuns.get(session.id)?.model ?? null;
    const settings = this.settings();
    return resolveRunModel({ driver: run.driver, kind: run.kind, ticket, project, settings, cosProject: this.cosProject(ticket) });
  }

  /**
   * The adviser a planning or review run launches as a subagent (see adviserFor): its model and how
   * the driver launches it, or nothing when the run keeps the single-tier prompt.
   */
  private adviserInfo(run: Run, model: string | null, driver: Driver, ticket: Ticket | null, project: Project | null): { adviserModel?: string; adviserTool?: string } {
    if ((run.kind !== "plan" && run.kind !== "review") || !ticket || !driver.adviserTool) return {};
    const choice = resolvePhaseChoice("adviser", { ticket: ticket.phaseModels, project: project?.phaseModels, settings: this.settings().phaseModels });
    const adviser = adviserFor({ driver: run.driver, model }, choice, !!driver.subagentTool);
    return adviser ? { adviserModel: adviser, adviserTool: driver.adviserTool } : {};
  }

  /** The driver a run of this kind goes to: its phase's (see resolveRunChoice); a standalone session keeps its own. */
  private runDriver(kind: RunKind, session: Session, ticket: Ticket | null): string {
    if (!ticket) return session.driver;
    return resolveRunChoice({ kind, ticket, project: this.store.projects.get(ticket.projectId) ?? null, settings: this.settings(), cosProject: this.cosProject(ticket) }).driver;
  }

  /** The project a chief's current run is about (see cosWakeProject), for resolveCosChoice. */
  private cosProject(ticket: Ticket | null): Project | null {
    const id = ticket?.kind === "cos" ? this.cosWakeProject.get(ticket.id) : null;
    return id ? (this.store.projects.get(id) ?? null) : null;
  }

  /**
   * skipTranscript: the prompt is already in the transcript (a steered message that fell back to
   * the queue). attachments: files the human attached to the message, sent with the run's prompt.
   */
  private enqueueRun(sessionId: string, kind: RunKind, prompt: string, lock?: string, opts: { skipTranscript?: boolean; attachments?: readonly Attachment[] } = {}): Run {
    const session = this.store.sessions.get(sessionId)!;
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    if (ticket?.draft) throw conflict(`${ticket.key} is a draft: nothing runs on it until it's submitted`);
    const driver = this.runDriver(kind, session, ticket);
    const attachments = opts.attachments ?? [];
    const run = this.store.runs.create({ sessionId, kind, driver, prompt, attachments });
    this.bus.emit({ kind: "run.upserted", run });
    if (!opts.skipTranscript) this.append(sessionId, run.id, "user", messageContent({ text: prompt, attachments }));
    this.touchSession(sessionId);
    this.queue.enqueue({ runId: run.id, sessionId, kind, lock });
    return run;
  }

  /** One queued run. It starts with no actor, so a run a chief's tool call queued doesn't inherit the chief's stamp (see `asActor`). */
  private execute(job: QueuedJob): Promise<void> {
    return this.actorContext.run(null, () => this.executeRun(job));
  }

  /**
   * A chief's tools stamp the activity they write "cos:<id>". The stamp is scoped to the tool call
   * itself, the one place every driver passes through (in-process, or over POST /mcp/:token, which
   * starts a fresh async root), so timers armed during a chief's run don't inherit it.
   */
  private asActor(tools: ToolDefinition[], ticket: Ticket | null, kind: RunKind): ToolDefinition[] {
    if (kind !== "cos" || !ticket) return tools;
    const actor = `cos:${ticket.id}`;
    return tools.map((t) => ({ ...t, execute: (input, ctx) => this.actorContext.run(actor, () => t.execute(input, ctx)) }));
  }

  private async executeRun(job: QueuedJob) {
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
      replanned: null,
      resumeCompletion: null,
      denials: [],
      calls: new Map(),
      appliedGrants: new Set(),
      offeredGrants: [],
      // From the start, so a message sent while the run gets going is waiting when the driver starts.
      input: driver?.supportsSteering && STEERABLE_RUN_KINDS.has(run.kind) ? new RunInput() : null,
      cwd: null,
      sessionEpoch: this.sessionEpochs.get(session.id) ?? 0,
      modelCalls: 0,
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
    this.stopSubagents(run.id);
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
    // A run just used some of the plan: read the gauges again.
    if (driver?.planUsage && run.kind !== "compact") void this.planUsage.refresh(driver.id, true).catch(() => {});
    // Before afterRun, like a message queued during the run: pending work holds off auto-submit.
    // Cancelling drops them with the rest of the session's queue.
    if (status !== "cancelled") {
      for (const message of unseen) {
        try {
          const next = this.enqueueRun(session.id, run.kind, message.text, undefined, { skipTranscript: true, attachments: message.attachments });
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
    const started = this.store.runs.markRunning(active.run.id);
    const model = this.runModel(started, session, ticket, project);
    const run = this.store.runs.setModel(started.id, model);
    active.run = run;
    this.bus.emit({ kind: "run.upserted", run });
    // Name the driver when this phase runs on another one than the ticket's Work runs.
    const onOtherDriver = ticket && run.driver !== ticket.driver ? ` · ${run.driver}` : "";
    this.appendStatus(session.id, run.id, `Run started (${run.kind}${onOtherDriver}${model ? ` · ${model}` : ""})`);

    let error: string | null = null;
    // A ticket whose worktree is gone (the complete run removed it, or an agent did) runs from the
    // project checkout instead of failing; missingWorktreeNote tells the agent. The session's cwd
    // is that same worktree, so it's skipped when it's gone too.
    const gone = run.kind !== "plan" && !!ticket?.workdir && !existsSync(ticket.workdir);
    const workdir = run.kind === "plan" || gone ? null : ticket?.workdir;
    const sessionCwd = gone && session.cwd && !existsSync(session.cwd) ? null : session.cwd;
    const cwd = workdir ?? sessionCwd ?? project?.path ?? this.paths.home;
    if (!driver) error = `Unknown driver: ${run.driver}`;
    else if (!existsSync(cwd)) error = `Working directory does not exist: ${cwd}`;
    else if (run.kind === "compact") {
      try {
        if (!driver.compact) throw new Error(`${driver.name} can't compact a session`);
        const req: RunRequest = {
          runId: run.id,
          kind: run.kind,
          prompt: run.prompt,
          systemPrompt: "",
          cwd,
          model,
          state: this.store.sessions.getDriverState(session.id, run.driver),
          tools: [],
          toolContext: { runId: run.id, runKind: run.kind, session, ticket, cwd, ops: this.opsFacade, browser: this.browser, signal: controller.signal },
          mcp: { url: "", headers: {} },
          signal: controller.signal,
        };
        error = await this.consume(driver.compact(req), active, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) error = errMsg(err);
      }
    } else {
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
      const triage = run.kind === "triage" ? this.triageRuns.get(session.id) : undefined;
      const tools = this.asActor(this.tools(run.kind, driver, ticket), ticket, run.kind);
      const token = randomBytes(24).toString("hex");
      this.mcpRuns.set(token, { tools, ctx });
      active.mcpToken = token;
      try {
        const parent = ticket?.parentId ? this.store.tickets.get(ticket.parentId) : null;
        const children = ticket ? this.store.tickets.list({ parentId: ticket.id }) : undefined;
        const withFiles = MENTION_RUN_KINDS.has(run.kind) ? await this.withMentions(session.id, run.id, run.prompt, cwd) : run.prompt;
        // The ticket's attachments go with its first run that gets through (the agent's
        // conversation keeps them after that).
        const firstRun = !this.store.runs.listBySession(session.id).some((r) => r.id !== run.id && r.status === "succeeded" && MENTION_RUN_KINDS.has(r.kind));
        const attached = MENTION_RUN_KINDS.has(run.kind) ? this.withAttachments(session.id, run.id, [...(ticket && firstRun ? (ticket.promptAttachments ?? []) : []), ...(run.attachments ?? [])]) : null;
        const missing = gone && ticket ? await this.missingWorktreeNote(ticket, run.kind, cwd, project) : "";
        if (missing) this.appendStatus(session.id, run.id, `Worktree missing: running from ${cwd}`);
        // The transcript keeps the human's words; the agent also reads when to unblock.
        const prompt = (run.kind === "chat" ? withFiles + this.blockedNote(ticket) : withFiles) + missing + (attached?.block ?? "");
        active.cwd = cwd;
        if (ticket) await this.refreshBaseBranch(ticket, project);
        // The system prompt holds only what's stable for the session; what changes per run goes
        // in front of the first message (DESIGN.md "System prompt and run context").
        const promptInfo = {
          kind: run.kind,
          project,
          ticket,
          session,
          parent,
          children,
          builtinTools: driver.hasBuiltinTools,
          subagentTool: driver.subagentTool,
          ...this.adviserInfo(run, model, driver, ticket, project),
          branches: ticket ? this.branchContext(ticket, project) : undefined,
          activity: ticket ? this.store.activity.listBySession(ticket.sessionId).slice(-PROMPT_ACTIVITY_ENTRIES) : undefined,
          schedules: ticket?.kind === "cos" ? this.store.schedules.list({ cosId: ticket.id }) : undefined,
        };
        const req: RunRequest = {
          runId: run.id,
          kind: run.kind,
          prompt,
          ...(attached?.images.length ? { images: attached.images } : {}),
          ...(triage ? { maxTurns: TRIAGE_MAX_TURNS } : {}),
          systemPrompt: triage ? triage.system : this.prompts().systemPrompt(promptInfo),
          runContext: triage ? undefined : this.prompts().runContext(promptInfo),
          cwd,
          model,
          permissionMode: this.permissionModeFor(ticket, project),
          grants: this.runGrants(run.kind, ticket, project, active),
          state: FRESH_RUN_KINDS.has(run.kind) ? null : this.store.sessions.getDriverState(session.id, run.driver),
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
        // A browser_run script never outlives its run.
        stopBrowserJobs(run.id);
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

  /**
   * Attachments for a run's prompt or a steered message (DESIGN.md "Prompt attachments"): the
   * ticket's own on its first run, and the ones sent with the message. A block for the prompt
   * lists every path, and the images go inline. The transcript gets a status line for what was
   * attached, one for each missing file, and one for images sent by path only.
   */
  private withAttachments(sessionId: string, runId: string, list: readonly Attachment[]): { block: string; images: RunImage[] } | null {
    try {
      const a = runAttachments(list);
      if (!a) return null;
      if (a.attached.length) this.appendStatus(sessionId, runId, `Attached ${a.attached.join(", ")}`);
      for (const m of a.missing) this.appendStatus(sessionId, runId, `Attachment missing: ${m.name} (was at ${m.path})`);
      for (const n of a.notInline) this.appendStatus(sessionId, runId, `Sent ${n.name} by path only: ${n.reason}`);
      return { block: a.block, images: a.images };
    } catch (err) {
      this.appendStatus(sessionId, runId, `Couldn't attach files: ${errMsg(err)}`);
      return null;
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
        if (subagent) {
          if (subagent.status !== "running") this.keepTaskOutput(subagent);
          this.bus.emit({ kind: "subagent.upserted", subagent });
        }
        return null;
      }
      case "state":
        if (!FRESH_RUN_KINDS.has(run.kind) && active.sessionEpoch === (this.sessionEpochs.get(run.sessionId) ?? 0)) {
          this.store.sessions.setDriverState(run.sessionId, ev.state, run.driver);
        }
        return null;
      case "usage": {
        // Summed per run (Claude Code reports cost as a per-turn delta); a report with nothing in it is skipped.
        if (ev.inputTokens === undefined && ev.outputTokens === undefined && ev.costUsd === undefined) return null;
        active.run = this.store.runs.addUsage(run.id, ev);
        this.bus.emit({ kind: "run.upserted", run: active.run });
        return null;
      }
      case "call": {
        // The gauge follows the conversation the next run resumes: a review or complete run starts
        // fresh, a compact run's own calls aren't it, and a run from before a session change no
        // longer is. Every call is kept either way.
        const first = active.modelCalls++ === 0;
        const at = this.now();
        this.store.sessions.addCall(run.sessionId, run.id, ev.call, at);
        if (!FRESH_RUN_KINDS.has(run.kind) && run.kind !== "compact" && active.sessionEpoch === (this.sessionEpochs.get(run.sessionId) ?? 0)) {
          this.store.sessions.setContext(run.sessionId, applyCall(this.store.sessions.getContext(run.sessionId), ev.call, at, first));
          const ticketId = this.store.sessions.get(run.sessionId)?.ticketId;
          if (ticketId) this.touchTicket(ticketId);
        }
        return null;
      }
      case "rate_limit": {
        const driver = this.drivers.get(run.driver);
        if (driver?.planUsage) this.planUsage.noteRateLimit(driver, ev);
        return null;
      }
      case "compacted":
        active.compacted = { before: ev.before, after: ev.after };
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

  /** A compact run ended: record the new size on the gauge and say what happened in Activity. */
  private afterCompact(ticket: Ticket, run: Run, active: ActiveRun, error: string | null) {
    if (run.status === "succeeded") {
      const prev = this.store.sessions.getContext(ticket.sessionId);
      const before = active.compacted?.before ?? (prev ? prev.input + prev.cacheRead + prev.cacheWrite : undefined);
      const after = active.compacted?.after;
      if (after !== undefined && active.sessionEpoch === (this.sessionEpochs.get(ticket.sessionId) ?? 0)) {
        this.store.sessions.setContext(ticket.sessionId, compactedContext(prev, after, this.now()));
      }
      const sizes = after === undefined ? "" : `: ${before === undefined ? "" : `${tokensLabel(before)} → `}${tokensLabel(after)} tokens`;
      this.addActivityLine(ticket, "system", "system", `Session compacted${sizes}`);
    } else if (run.status === "failed") {
      this.addActivityLine(ticket, "failed", "system", `Compacting the session failed: ${error ?? "no error reported"}`);
    }
    this.touchTicket(ticket.id);
    this.kickScheduler();
  }

  private async afterRun(run: Run, active: ActiveRun, error: string | null) {
    const session = this.store.sessions.get(run.sessionId);
    if (!session) return;
    const ticket = session.ticketId ? this.store.tickets.get(session.ticketId) : null;
    if (!ticket) return;
    if (run.kind === "compact") return this.afterCompact(ticket, run, active, error);
    if (run.kind === "plan" && run.status !== "succeeded") {
      this.dropPlanApproval(ticket.id, run.status === "failed" ? "Planning run failed; work not started" : "Plan approval cleared: run cancelled; work not started");
    }
    if (run.status === "cancelled") {
      if (run.kind === "complete") this.completionStopped(run.sessionId, "cancelled");
      return;
    }
    // The agent sent the ticket back to planning: the Plan run follows, whether or not this run ended cleanly.
    if (active.replanned) {
      this.queueReplan(ticket.id, active.replanned.reason, run.kind === "chat" ? run.prompt : "", active.replanned.startAfterPlan);
      return;
    }
    if (ticket.pendingApproval) return; // waiting on a human; never auto-submit / complete / re-block
    if (run.status === "succeeded" && this.surfaceDenial(ticket, run, active)) return;
    if (run.status === "failed") {
      // A done ticket stays done: a run queued before it completed can only fail on the removed worktree.
      if (ticket.status === "done" && run.kind !== "complete") {
        this.addActivityLine(ticket, "failed", "system", `Run failed after the ticket was done: ${error ?? "no error reported"}`);
        return;
      }
      // A completion that fails in review keeps its approvals: blocking it would send it through
      // in progress again, and the resubmit would reset both reviews. A usage limit blocks it
      // anyway, like any run: it restarts (on its own, when the limit says when) and goes through
      // review and completion again.
      if (run.kind === "complete" && ticket.status === "review" && !isUsageLimit(error)) {
        this.addActivityLine(ticket, "failed", "system", `Completion failed: ${error ?? "no error reported"}`);
        this.completionStopped(run.sessionId, "failed", error);
        return;
      }
      // A chat that unblocked the ticket was doing its work: it fails like a work run. Any other
      // failed chat leaves the ticket where it is.
      if (run.kind === "work" || run.kind === "conductor" || run.kind === "complete" || (run.kind === "chat" && ticket.status === "in_progress")) {
        // A usage limit that says when it resets: the ticket restarts on its own a little after.
        const resumeAt = usageLimitResumeAt(error, this.now());
        const restart = resumeAt === null ? "" : ` Restarts on its own at ${clockTime(resumeAt)}.`;
        const what = run.kind === "complete" ? "Completion failed" : "Run failed";
        // A completion blocked in review gives its approvals back: the restart resubmits for review.
        const reviews = run.kind === "complete" && ticket.status === "review" ? { agentReview: "pending" as const, humanReview: "pending" as const } : {};
        this.addActivityLine(ticket, "failed", "system", `${what}: ${error ?? "no error reported"}${restart}`, this.moveMeta(ticket, "blocked"));
        this.transition(ticket, "blocked", { blockedReason: error ?? "Run failed", resumeAt, ...reviews }, `Blocked: ${what.toLowerCase()}`, error ?? undefined);
        if (resumeAt !== null) this.appendStatus(ticket.sessionId, run.id, `Usage limit: restarts on its own at ${clockTime(resumeAt)}`);
      } else if (run.kind === "chat") {
        this.addActivityLine(ticket, "failed", "system", `Run failed: ${error ?? "no error reported"}`);
      } else if (run.kind === "review" && ticket.status === "review") {
        // Otherwise the ticket sits in review with nothing running and no word why.
        this.addActivityLine(ticket, "failed", "system", `Agent review failed: ${error ?? "no error reported"}. Re-run agent review to try again.`);
      }
      return;
    }
    switch (run.kind) {
      case "work":
      case "conductor":
        this.finishWork(ticket, run, active);
        break;
      case "chat":
        // A chat that moved the ticket (submit_for_review, block, unblock, resume_work) ends like a work run;
        // one that left it where it was answered the human's message in the transcript.
        if (active.resumeCompletion && ticket.status === "blocked") {
          // The chat answered a completion's question and unblocked it: the completion carries on.
          await this.resumeCompletion(ticket, [run.prompt, active.resumeCompletion.note].filter(Boolean).join("\n"), "agent");
          break;
        }
        if (active.submitted || active.blocked || ticket.status === "in_progress") this.finishWork(ticket, run, active);
        break;
      case "complete":
        // done: the human marked it so meanwhile. blocked: the agent called block, which kept the
        // approvals for the resumed completion. in_progress: the agent called resume_work, which queued the work run.
        if (ticket.status === "done" || ticket.status === "blocked" || ticket.status === "in_progress") break;
        if ((ticket.completionAction ?? "merge") === "merge" && run.status === "succeeded") {
          const sha = this.mergeTips.get(ticket.id);
          this.mergeTips.delete(ticket.id);
          if (sha && !(await this.mergeLanded(ticket, sha))) {
            const base = this.baseBranchFor(ticket).branch;
            const reason = `Completion ended but \`${ticket.branch ?? branchForKey(ticket.key)}\` isn't merged into \`${base}\`. Check the last Activity note, then answer to have the agent finish the merge.`;
            this.addActivity(ticket, "blocked", "system", reason, { question: reason, ...this.moveMeta(ticket, "blocked") });
            // The approvals stand: answering resumes the completion (resumeCompletion).
            this.transition(ticket, "blocked", { blockedReason: reason, blockedRunKind: "complete", blockedHead: await this.mergeTip(ticket) }, "Blocked: merge didn't land");
            break;
          }
        }
        if (ticket.completionAction === "pr" && !active.pullRequest) {
          // The PR completion's whole result is the pull request: without one, the work hasn't landed.
          const reason = "Completion ended without opening a pull request. Check the last Activity note for what went wrong (gh login, push access), then message the agent; once it's back in review, approve it again.";
          this.addActivity(ticket, "blocked", "system", reason, { question: reason, ...this.moveMeta(ticket, "blocked") });
          this.transition(ticket, "blocked", { blockedReason: reason }, "Blocked: no pull request");
          break;
        }
        if (ticket.completionAction === "cleanup") {
          // The cleanup's whole result is the worktree and branch gone: what's left holds work that hasn't landed.
          const left = await this.cleanupLeftovers(ticket);
          if (left.length) {
            const reason = `Cleanup didn't finish: ${left.join(" and ")} still ${left.length === 1 ? "exists" : "exist"}, which usually means unpushed or unmerged work. Check the last Activity note, then move the ticket back to In progress to deal with those commits.`;
            this.addActivity(ticket, "blocked", "system", reason, { question: reason, ...this.moveMeta(ticket, "blocked") });
            this.transition(ticket, "blocked", { blockedReason: reason }, "Blocked: cleanup didn't finish");
            break;
          }
        }
        this.transition(ticket, "done", { blockedReason: null }, "Completed");
        break;
      case "review":
        if (!active.decided && ticket.status === "review") this.appendStatus(session.id, run.id, "Agent review ended without a decision");
        break;
    }
  }

  /**
   * The end of a run that did the ticket's work: a submit gets its review; a ticket still in
   * progress with nothing more queued blocks on the agent's trailing question, or is submitted
   * with its last text (Activity shows the first line) once its children are done.
   */
  private finishWork(ticket: Ticket, run: Run, active: ActiveRun): void {
    if (active.submitted) {
      if (ticket.status === "review") this.enqueueReview(ticket);
    } else if (ticket.status === "in_progress") {
      const moreWork = this.queue.pendingFor(ticket.sessionId).some((j) => RUNNABLE_WORK.includes(j.kind));
      if (!moreWork && run.kind !== "conductor" && endsWithQuestion(active.lastText)) {
        // The agent is asking the human something: block with its question instead of submitting.
        const question = active.lastText!.trim();
        this.addActivity(ticket, "blocked", "agent", question, { question, ...this.moveMeta(ticket, "blocked") });
        this.transition(ticket, "blocked", { blockedReason: question }, "Blocked: the agent asked a question", question);
      } else if (!moreWork && this.allChildrenDone(ticket)) {
        this.submit(ticket, active.lastText?.trim() || "Work finished.", "system");
        this.enqueueReview(this.store.tickets.get(ticket.id)!);
      }
    }
    this.flushConductor(ticket.id);
  }

  /** HarnessOps facade handed to tools (maps conductor and chief of staff op names onto internals). */
  private get opsFacade(): HarnessOps {
    return this._ops ?? (this._ops = this.buildOps());
  }
  private _ops: HarnessOps | null = null;

  private buildOps(): HarnessOps {
    return {
      postNote: (c, n) => this.postNote(c, n),
      recordTriageVerdict: (c, v) => this.recordTriageVerdict(c, v),
      updateNotes: (c, n) => this.updateNotes(c, n),
      wroteNotes: (c) => this.wroteNotes(c),
      statusLine: async (c, text) => void this.appendStatus(c.session.id, c.runId, text),
      readSpec: (c, r) => this.readSpec(c, r),
      editSpec: (c, i) => this.editSpec(c, i),
      updateSpec: (c, i) => this.updateSpec(c, i),
      block: (c, q) => this.block(c, q),
      unblock: (c, n) => this.unblock(c, n),
      resumeWork: (c, n) => this.resumeWork(c, n),
      returnToPlanning: (c, r, s) => this.returnToPlanning(c, r, s),
      submitForReview: (c, n, up, skips) => this.submitForReview(c, n, up, skips),
      updateBranch: (c, i) => this.updateBranch_(c, i),
      reviewDecision: (c, d, n, f) => this.reviewDecision(c, d, n, f),
      // --- board (read) ---
      listTickets: (c, f) => this.listTickets_(c, f),
      getTicket: (c, k, o) => this.getTicket_(c, k, o),
      getTicketAgent: (c, k, id, o) => this.getTicketAgent_(c, k, id, o),
      searchTickets: (c, i) => this.searchTickets_(c, i),
      listProjects: (c) => this.listProjects_(c),
      listInbox: (c, f) => this.listInbox_(c, f),
      // --- memory and activity (chief of staff) ---
      queryActivity: async (c, q) => this.scopeOf(c).queryActivity(q),
      // --- terminals (chief of staff) ---
      listTerminals: (c) => this.listTerminals_(c),
      readTerminal: (c, id, n) => this.readTerminal_(c, id, n),
      writeTerminal: (c, id, d) => this.writeTerminal_(c, id, d),
      arrangePanes: (c, op) => this.arrangePanes_(c, op),
      readMemory: async (c) => this.readMemory_(c),
      updateMemorySection: async (c, s, b) => this.updateMemorySection_(c, s, b),
      recordEventOutcomes: async (c, items) => {
        this.scheduleOwner(c);
        return this.cosEngine.recordOutcomes(c.runId, items);
      },
      // --- schedules ---
      scheduleCreate: async (c, i) => this.scheduleCreate_(c, i),
      scheduleList: async (c, o) => this.store.schedules.list({ cosId: this.scheduleOwner(c).ticketId, all: o.all }),
      scheduleCancel: async (c, id) => this.scheduleCancel_(c, id),
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
      recordPullRequest: (c, u, h) => this.recordPullRequest(c, u, h),
      requestApproval: (c, n, i, m) => this.requestApproval(c, n, i, m),
      checkPermission: (c, n, i) => this.checkPermission(c, n, i),
      fileOutputScope: (c) => this.fileOutputScope(c),
      listWatchers: (c) => this.listWatchers_(c),
      getSettings: (c) => this.getSettings_(c),
      listPrompts: async (c) => (this.appWide(c, "include_prompts"), this.promptCatalog()),
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

  /** Add an entry to the ticket's Activity (DESIGN.md "Activity") and broadcast it. */
  private addActivity(ticket: Pick<Ticket, "id" | "sessionId">, kind: ActivityKind, author: ActivityAuthor, body: string, meta: ActivityMeta = {}): ActivityEntry {
    const entry = this.store.activity.add({ sessionId: ticket.sessionId, ticketId: ticket.id, kind, author, body, meta, actor: this.actorContext.getStore() ?? null });
    this.bus.emit({ kind: "activity.added", entry });
    if (meta.to && kind !== "moved") this.movesRecorded.set(ticket.id, { to: meta.to, entryId: entry.id });
    return entry;
  }

  /** ActivityMeta for an entry that records the ticket's move to `to` (none when it's already there). */
  private moveMeta(t: Pick<Ticket, "status">, to: TicketStatus): ActivityMeta {
    return t.status === to ? {} : { from: t.status, to };
  }

  /** addActivity for text that can run long: the body is its first line, the whole text meta.detail. */
  private addActivityLine(ticket: Pick<Ticket, "id" | "sessionId">, kind: ActivityKind, author: ActivityAuthor, text: string, meta: ActivityMeta = {}): ActivityEntry {
    const full = text.trim();
    const line = activityLine(full);
    return this.addActivity(ticket, kind, author, line, line === full ? meta : { ...meta, detail: full });
  }


  /** The ticket's newest agent note or submit note (what search snippets and the conductor show). */
  private latestNote(t: Ticket): ActivityEntry | undefined {
    return this.store.activity.listBySession(t.sessionId).findLast((e) => e.kind === "note" || e.kind === "submitted");
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

/** "482k", "1.2M", "850": a token count as the gauge writes it. */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString()}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export { HarnessError };
