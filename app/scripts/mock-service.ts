// Mock harness service for UI development. Implements the REST routes in shared/src/client.ts
// with in-memory state, plus the WebSocket event stream, browser screencast and a fake live run.
//
//   bun app/scripts/mock-service.ts        (MOCK_PORT=7799 MOCK_TOKEN=mock-token MOCK_QUIET=1)
//   HARNESS_URL=http://127.0.0.1:7799 HARNESS_TOKEN=mock-token bun run --cwd app dev

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import { applyLegacySettings, contextTokens, BROWSER_DESKTOP, BROWSER_MAX_SIDE, BROWSER_MIN_SIDE, BROWSER_MOBILE, legacySettingsFields, legacyWork, mergePhaseModels, resolvePhaseChoice, type BrowserSize } from "@harness/shared";
import type {
  ActivityAuthor,
  ActivityEntry,
  ActivityKind,
  ActivityMeta,
  Attachment,
  BranchInfo,
  BrowserInput,
  BrowserState,
  ClientMessage,
  DriverInfo,
  DriverModels,
  HarnessEvent,
  ListenMode,
  ListenSetting,
  NetworkStatus,
  Project,
  PublicSettings,
  Run,
  RunKind,
  ServerMessage,
  Session,
  SpecConflict,
  SpecDiff,
  SpecRevision,
  SpecRevisionAuthor,
  SpecRevisionInfo,
  Ticket,
  RelatedTicket,
  RemoteKeyMatches,
  TicketDetail,
  Subagent,
  TicketStatus,
  TranscriptContent,
  TranscriptEntry,
  TranscriptRole,
  Watcher,
} from "@harness/shared";
import type { PromptEntry, PromptId } from "@harness/shared";
import { buildPairUrl, canonicalGroup, checkProjectKey, isCompletionAction, isLegacyMirror, isTicketKey, LISTEN_MODES, normalizeProjectColor, normalizeProjectGroup, offeredCompletionActions, outputTitle, projectGroups, PROMPT_IDS, resolveCompletionAction, reviewPassed } from "@harness/shared";
import type { CompletionAction, PlanUsageReport, PlanWindow } from "@harness/shared";
// The real catalog, so the Prompts screen shows the text runs get.
import { isPromptId, PROMPTS, promptTemplateError } from "../../service/src/orchestrator/prompt-templates";
// The real diff, so the Spec tab's history shows what the service would send.
import { unifiedDiff } from "../../service/src/spec";
import { attachmentFromInput } from "@harness/shared/state";

const PORT = Number(process.env.MOCK_PORT ?? 7799);
/** The bearer token; POST /token/rotate replaces it (the old one 401s from then on). */
let TOKEN = process.env.MOCK_TOKEN ?? "mock-token";
const QUIET = process.env.MOCK_QUIET === "1";
/**
 * The service's code vs. the app (the stale-service banner): unset = current, MOCK_STALE=1 = its
 * checkout changed since it started, MOCK_STALE=old = from before /health reported a build.
 * POST /service/restart "restarts" onto current code (sockets drop and reconnect).
 */
let STALE = process.env.MOCK_STALE ?? "";
const serviceCode = () => (STALE === "old" ? {} : { build: "mock", stale: STALE === "1" });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const projects = new Map<string, Project>();
const tickets = new Map<string, Ticket>(); // by id
/** Old ticket keys (from before a project rename) → ticket id, like the service's ticket_key_aliases */
const keyAliases = new Map<string, string>();
const sessions = new Map<string, Session>();
const runs = new Map<string, Run>();
const activity: ActivityEntry[] = [];
/** Every ticket's spec revisions (with bodies), oldest first, by ticket id */
const specRevisions = new Map<string, SpecRevision[]>();
/** Attachment bytes by id, served at GET /attachments/:id (an attachment seeded without bytes 404s). Rendered on first request. */
const attachmentFiles = new Map<string, { mimeType: string; bytes: () => Uint8Array }>();
/** Every attachment record by id (spec media), for TicketDetail.attachments. */
const attachmentRecords = new Map<string, Attachment>();
const specMedia = (a: Attachment): Attachment => (attachmentRecords.set(a.id, a), a);
const transcripts = new Map<string, TranscriptEntry[]>(); // by session id
/** Sub-agents and background tasks by session id, oldest first (TicketDetail.subagents) */
const subagents = new Map<string, Subagent[]>();
const watchers = new Map<string, Watcher>();
let triageSeq = 0;
let idSeq = 0;

let settings: PublicSettings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: {},
  reviewModels: {},
  phaseModels: { complete: { driver: "claude-code", model: "haiku" } },
  watcherDriver: null,
  watcherModels: {},
  anthropicApiKeySet: false,
  claudeOauthTokenSet: false,
  copilotGithubTokenSet: false,
  listen: { mode: "localhost" },
  baseBranch: "main",
  browserIdleTabMinutes: 5,
  // One working override and one that names a variable the prompt doesn't have (as after an app
  // update renamed it): GET /prompts reports its overrideError.
  prompts: {
    ...Object.fromEntries(PROMPT_IDS.map((id) => [id, null])),
    "run.review": `Review {{ticket}} carefully.\n\nRead it with get_ticket { key: "{{key}}" }.\n\nCheck the tests first, then the diff.`,
    "system.files": "## Files\nRead with {{readTool}}. Never use {{shellTool}} to edit files.",
  },
};

/** GET /prompts (mirrors Orchestrator.promptCatalog). */
function promptCatalog(): PromptEntry[] {
  return PROMPT_IDS.map((id) => {
    const def = PROMPTS[id];
    const override = settings.prompts?.[id] ?? null;
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

/** PATCH /settings { prompts } (mirrors service validatePrompts): 400 on unknown ids and bad templates. */
function mergePrompts(value: Record<string, unknown>): Partial<Record<PromptId, string | null>> {
  const current = settings.prompts ?? {};
  const out = { ...current };
  for (const [id, text] of Object.entries(value)) {
    if (!isPromptId(id)) throw new HttpError(400, `Unknown prompt: ${id} (GET /prompts lists them)`);
    if (text === null || (typeof text === "string" && !text.trim())) {
      out[id] = null;
      continue;
    }
    if (typeof text !== "string") throw new HttpError(400, `prompts.${id} must be template text or null`);
    const error = current[id] === text ? null : promptTemplateError(id, text);
    if (error) throw new HttpError(400, `prompts.${id}: ${error}`);
    out[id] = text;
  }
  return out;
}

// Local branches for GET /projects/:id/branches (the same list for every git project), newest first.
const MOCK_BRANCHES: BranchInfo[] = [
  { name: "main", lastCommitAt: Date.now() - 20 * 60_000, checkedOutAt: null },
  { name: "medl-1223-ai-app", lastCommitAt: Date.now() - 2 * 3600_000, checkedOutAt: "/Users/markhuot/Sites/medl-worktrees/medl-1223-ai-app" },
  { name: "develop", lastCommitAt: Date.now() - 26 * 3600_000, checkedOutAt: null },
  { name: "harness/nytimes-4", lastCommitAt: Date.now() - 3 * 86400_000, checkedOutAt: "/Users/markhuot/.harness/worktrees/NYTIMES-4" },
  { name: "feature/dark-mode", lastCommitAt: Date.now() - 9 * 86400_000, checkedOutAt: null },
  { name: "release/2026-09", lastCommitAt: Date.now() - 21 * 86400_000, checkedOutAt: null },
];

/**
 * The service's branch filter: case-insensitive substring matches first, then in-order letters.
 * `main` is what the project directory itself has checked out (a draft picking it runs there, with no worktree).
 */
function filterBranches(q: string, limit: number, projectPath: string): BranchInfo[] {
  const all = MOCK_BRANCHES.map((b) => (b.name === "main" ? { ...b, checkedOutAt: projectPath } : b));
  const needle = q.toLowerCase();
  if (!needle) return all.slice(0, limit);
  const sub = all.filter((b) => b.name.toLowerCase().includes(needle));
  const fuzzy = all.filter((b) => !sub.includes(b) && new RegExp([...needle].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")).test(b.name.toLowerCase()));
  return [...sub, ...fuzzy].slice(0, limit);
}

// Network (mirrors service/src/api/network.ts): a fake Tailscale and a fake LAN address.
const MOCK_TAILSCALE = { ip: "100.101.102.103", dnsName: "mock.tail.ts.net." };
const MOCK_LAN = "192.168.1.50";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", MOCK_LAN, MOCK_TAILSCALE.ip, "mock.local"]);
let networkError: string | null = null;

function networkStatus(): NetworkStatus {
  const listen = settings.listen ?? { mode: "localhost" };
  const url = (a: string) => ({ address: a, url: `http://${a}:${PORT}` });
  const bound =
    listen.mode === "any"
      ? [url("0.0.0.0")]
      : listen.mode === "tailscale"
        ? [url(MOCK_TAILSCALE.ip), url("127.0.0.1")]
        : listen.mode === "custom" && listen.host && listen.host !== "127.0.0.1"
          ? [url(listen.host), url("127.0.0.1")]
          : [url("127.0.0.1")];
  return { mode: listen.mode, host: listen.mode === "custom" ? (listen.host ?? null) : null, port: PORT, bound, active: listen.mode, tailscale: MOCK_TAILSCALE, error: networkError, override: null };
}

/** Validate + "bind" a listen setting: 400 for a bad shape, 409 when the host isn't this machine's. */
function applyListen(value: unknown): ListenSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "listen must be an object { mode, host? }");
  const { mode, host } = value as { mode?: unknown; host?: unknown };
  if (!(LISTEN_MODES as readonly unknown[]).includes(mode)) throw new HttpError(400, `listen.mode must be one of ${LISTEN_MODES.join(", ")}`);
  if (mode !== "custom") return { mode: mode as ListenMode };
  if (typeof host !== "string" || !host.trim()) throw new HttpError(400, "listen.host is required for custom mode");
  const h = host.trim();
  if (!LOCAL_HOSTS.has(h)) {
    networkError = `${h} is not an address of this machine; still listening on ${networkStatus().bound.map((b) => b.address).join(", ")}`;
    throw new HttpError(409, networkError);
  }
  return { mode: "custom", host: h };
}

const MOCK_MODELS: Record<string, DriverModels["models"]> = {
  "claude-code": [
    { id: "opus", name: "Opus 5.5", description: "Most capable for ambitious work", default: true },
    { id: "claude-fable-5-1", name: "Fable 5.1", description: "For your toughest challenges" },
    { id: "sonnet", name: "Sonnet 5", description: "Most efficient for everyday tasks" },
    { id: "haiku", name: "Haiku 4.5", description: "Fastest for quick answers" },
  ],
  "anthropic-api": [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", default: true },
  ],
  dummy: [
    { id: "dummy-fast", name: "Dummy Fast", default: true },
    { id: "dummy-slow", name: "Dummy Slow" },
  ],
};

/** Merge a per-driver model patch (null clears one), like the service. */
function mergeModels(cur: Record<string, string | null>, patch: Record<string, string | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...cur, ...(patch ?? {}) })) if (v) out[k] = v;
  return out;
}

const drivers: DriverInfo[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Wraps the claude CLI with your team-plan login",
    available: true,
    authenticated: true,
    detail: "mark@happycog.com · Happy Cog (team)",
    supportsLogin: true,
    sessionActions: { compact: true, newSession: true },
    reportsContextUsage: true,
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Direct Messages API with an API key",
    available: true,
    authenticated: false,
    detail: "No API key configured",
    supportsLogin: false,
    sessionActions: { compact: false, newSession: true },
    reportsContextUsage: true,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "Wraps the copilot CLI",
    available: true,
    authenticated: true,
    detail: "markhuot",
    supportsLogin: false,
    sessionActions: { compact: false, newSession: true },
    reportsContextUsage: true,
  },
  {
    id: "dummy",
    name: "Dummy",
    description: "Deterministic scripted driver for testing",
    available: true,
    // MOCK_ONE_DRIVER=1 leaves Claude Code as the only signed-in driver (flat model lists)
    authenticated: !process.env.MOCK_ONE_DRIVER,
    detail: process.env.MOCK_ONE_DRIVER ? "Signed out" : "Always ready",
    supportsLogin: false,
  },
];

const now = () => Date.now();
const newId = (prefix: string) => `${prefix}_${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// WebSocket fan-out
// ---------------------------------------------------------------------------

interface WsData {
  /** Watched browsers: session id → the tab this socket is on (each socket watches one per session) */
  subs: Map<string, number>;
}
const sockets = new Set<ServerWebSocket<WsData>>();

function sendMsg(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

/** GET /usage: Claude's two windows (one amber) and Copilot's Premium requests (limited). PUT /mock/usage swaps it and pushes usage.updated. */
function defaultUsage(): PlanUsageReport {
  const t = Date.now();
  const win = (id: PlanWindow["id"], label: string, usedPercent: number, resetsIn: number, windowSeconds: number): PlanWindow => ({ id, label, usedPercent, resetsAt: t + resetsIn, windowSeconds });
  const m = 60_000;
  return {
    drivers: [
      { driver: "claude-code", name: "Claude Code", status: "ok", error: null, fetchedAt: t - 3 * m, windows: [win("five_hour", "5-hour", 42, 134 * m, 18000), win("seven_day", "Weekly", 78, 3 * 86_400_000, 604800)] },
      { driver: "github-copilot", name: "GitHub Copilot", status: "limited", error: null, fetchedAt: t - 3 * m, windows: [win("monthly", "Premium requests", 100, 9 * 3_600_000, 2_592_000)] },
    ],
  };
}
let usage: PlanUsageReport = defaultUsage();

function broadcast(event: HarnessEvent) {
  const isBrowser = event.kind === "browser.frame" || event.kind === "browser.state";
  const payload = JSON.stringify({ type: "event", event } satisfies ServerMessage);
  for (const ws of sockets) {
    // Browser events go only to sockets watching that tab (see emitState / the frame loop).
    if (isBrowser) continue;
    ws.send(payload);
  }
}

// ---------------------------------------------------------------------------
// Mutators (each emits its event)
// ---------------------------------------------------------------------------

function upsertTicket(t: Ticket, touch = true) {
  if (touch) t.updatedAt = now();
  tickets.set(t.id, t);
  broadcast({ kind: "ticket.upserted", ticket: t });
  const s = sessions.get(t.sessionId);
  if (s && s.busy !== t.busy) {
    s.busy = t.busy;
    upsertSession(s);
  }
}

function upsertSession(s: Session) {
  s.updatedAt = now();
  sessions.set(s.id, s);
  broadcast({ kind: "session.upserted", session: s });
}

function upsertRun(r: Run) {
  runs.set(r.id, r);
  broadcast({ kind: "run.upserted", run: r });
}

function appendEntry(sessionId: string, runId: string | null, role: TranscriptRole, content: TranscriptContent): TranscriptEntry {
  const list = transcripts.get(sessionId) ?? [];
  transcripts.set(sessionId, list);
  const entry: TranscriptEntry = {
    id: newId("te"),
    sessionId,
    runId,
    seq: (list.at(-1)?.seq ?? 0) + 1,
    role,
    content,
    createdAt: now(),
  };
  list.push(entry);
  broadcast({ kind: "transcript.appended", entry });
  return entry;
}

function addActivity(sessionId: string, ticketId: string | null, kind: ActivityKind, author: ActivityAuthor, body: string, meta: ActivityMeta = {}) {
  const entry: ActivityEntry = { id: newId("act"), sessionId, ticketId, kind, author, body, meta, createdAt: now() };
  activity.push(entry);
  broadcast({ kind: "activity.added", entry });
  return entry;
}

const revisionInfo = ({ body: _body, ...info }: SpecRevision): SpecRevisionInfo => info;

/** Revision 1, written with the ticket (no event: the ticket.upserted that follows carries it). */
function seedSpec(t: Ticket, createdAt: number) {
  specRevisions.set(t.id, [{ rev: 1, author: "human", runId: null, runKind: null, note: "Created", approvedBaseline: false, body: t.spec, createdAt }]);
  t.specRevision = 1;
  t.specBaselineRevision ??= null;
}

/**
 * Mirrors Orchestrator.reviseSpec: the next revision (none when the body didn't change), then
 * spec.revised. A stale `baseRevision` is a 409 carrying SpecConflict, like the service's PATCH.
 * The caller broadcasts the ticket.
 */
function reviseSpec(t: Ticket, body: string, w: { author: SpecRevisionAuthor; note: string; baseRevision?: number; runId?: string | null; runKind?: RunKind | null; createdAt?: number }): SpecRevisionInfo | null {
  const list = specRevisions.get(t.id) ?? [];
  const current = t.specRevision ?? 1;
  if (w.baseRevision !== undefined && w.baseRevision !== current) {
    throw new HttpError(409, `${t.key}'s spec is at revision ${current}, not ${w.baseRevision}: it changed since this edit started. Reload it, or send it again with baseRevision ${current} to overwrite.`, {
      currentRevision: current,
      spec: t.spec,
    } satisfies SpecConflict);
  }
  if (body === t.spec) return null;
  const rev: SpecRevision = { rev: current + 1, author: w.author, runId: w.runId ?? null, runKind: w.runKind ?? null, note: w.note, approvedBaseline: false, body, createdAt: w.createdAt ?? now() };
  list.push(rev);
  specRevisions.set(t.id, list);
  t.spec = body;
  t.specRevision = rev.rev;
  t.updatedAt = rev.createdAt;
  broadcast({ kind: "spec.revised", ticketId: t.id, rev: rev.rev, author: rev.author, note: rev.note, runId: rev.runId, runKind: rev.runKind, createdAt: rev.createdAt });
  return revisionInfo(rev);
}

/** Pressing Start (planning → work) approves the current revision as the review baseline. */
function markBaseline(t: Ticket, rev = t.specRevision ?? 1) {
  t.specBaselineRevision = rev;
  for (const r of specRevisions.get(t.id) ?? []) r.approvedBaseline = r.rev === rev;
}

function specRevisionOf(t: Ticket, raw: string, what: string): SpecRevision {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${what} must be a revision number`);
  const r = specRevisions.get(t.id)?.find((x) => x.rev === n);
  if (!r) throw new HttpError(404, `${t.key} has no spec revision ${n} (it's at ${t.specRevision ?? 1})`);
  return r;
}

function startRun(t: Ticket, kind: RunKind, prompt: string): Run {
  const r: Run = {
    id: newId("run"),
    sessionId: t.sessionId,
    kind,
    status: "running",
    driver: t.driver,
    prompt,
    error: null,
    createdAt: now(),
    startedAt: now(),
    endedAt: null,
  };
  upsertRun(r);
  appendEntry(t.sessionId, r.id, "system", { type: "status", text: `Run started (${kind})` });
  t.busy = true;
  return r;
}

function activeRun(sessionId: string): Run | undefined {
  return [...runs.values()].find((r) => r.sessionId === sessionId && (r.status === "running" || r.status === "queued"));
}

function finishRun(r: Run, status: Run["status"] = "succeeded", error: string | null = null) {
  r.status = status;
  r.error = error;
  r.endedAt = now();
  upsertRun(r);
  appendEntry(r.sessionId, r.id, "system", { type: "status", text: `Run ${status} (${r.kind})` });
}

/** Simulate a short agent run that finishes after `ms`, then calls `after`. */
function simulateRun(t: Ticket, kind: RunKind, prompt: string, text: string, after: (t: Ticket) => void, ms = 2500) {
  const r = startRun(t, kind, prompt);
  upsertTicket(t);
  setTimeout(() => {
    const cur = tickets.get(t.id);
    if (!cur || r.status !== "running") return;
    appendEntry(cur.sessionId, r.id, "assistant", { type: "text", text });
    finishRun(r);
    cur.busy = false;
    after(cur);
    upsertTicket(cur);
  }, ms);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Mirrors the service's project reads: the offered completion actions follow the checkout (git,
 * and a remote on a host gh is logged into → pullRequestHost). Recomputed after each change.
 */
function withCompletionActions(p: Project): Project {
  p.completionActions = offeredCompletionActions({ isGit: p.isGit, pullRequestHost: p.pullRequestHost ?? null });
  return p;
}

/** The ticket's parent, for a completion choice (a child on its parent's branch only merges). */
const parentOf = (t: Ticket) => (t.parentId ? (tickets.get(t.parentId) ?? null) : null);

/** Mirrors the service's resolveCompletionAction check: 400 for a choice the ticket doesn't offer. */
function checkCompletionAction(t: Ticket, requested: unknown): CompletionAction {
  if (requested != null && !isCompletionAction(requested)) throw new HttpError(400, `action must be one of merge, pr, custom`);
  const r = resolveCompletionAction((requested as CompletionAction | undefined) ?? null, t, projects.get(t.projectId), parentOf(t));
  if (r.error !== null) throw new HttpError(400, r.error);
  return r.action;
}

/** A project group from a request, spelled like an existing group that matches it without case (as the service does). */
function mockGroup(value: unknown, except?: string): string | null {
  const group = normalizeProjectGroup(value);
  if (group === undefined) throw new HttpError(400, `Invalid group ${JSON.stringify(value)}`);
  return group === null ? null : canonicalGroup(group, projectGroups([...projects.values()].filter((p) => p.id !== except)));
}

function seedProject(key: string, name: string, path: string, skipHumanReview = false, color: string | null = null, isGit = true, pullRequestHost: string | null = null): Project {
  const p: Project = {
    id: newId("proj"),
    key,
    name,
    path,
    nextSeq: 1,
    defaultDriver: null,
    defaultModels: {},
    useWorktrees: true,
    isGit,
    skipAgentReview: false,
    skipHumanReview,
    permissionMode: null,
    color,
    group: null,
    completionAction: "merge",
    pullRequestHost: isGit ? pullRequestHost : null,
    createdAt: now() - 86400_000 * 7,
    updatedAt: now() - 86400_000 * 7,
  };
  projects.set(p.id, withCompletionActions(p));
  return p;
}

function makeSession(key: string, kind: Session["kind"], ticketId: string | null, driver: string, cwd: string, title: string, createdAt: number): Session {
  const s: Session = {
    id: newId("sess"),
    key,
    kind,
    ticketId,
    driver,
    cwd,
    title,
    triageStatus: null,
    outcome: null,
    busy: false,
    createdAt,
    updatedAt: createdAt,
  };
  sessions.set(s.id, s);
  transcripts.set(s.id, []);
  return s;
}

interface SeedTicket {
  project: Project;
  /** The context gauge's usage (Ticket.context) and whether a compact run is going (Ticket.compacting) */
  context?: Ticket["context"];
  compacting?: boolean;
  model?: string | null;
  key?: string;
  title: string;
  /** Revision 1 of the spec */
  spec: string;
  /** Later revisions: [author, note, body], each written a few minutes after the last */
  revisions?: [SpecRevisionAuthor, string, string][];
  status: TicketStatus;
  driver: string;
  kind?: Ticket["kind"];
  parentKey?: string;
  dependsOn?: string[];
  busy?: boolean;
  agentReview?: Ticket["agentReview"];
  humanReview?: Ticket["humanReview"];
  skipAgentReview?: boolean;
  skipHumanReview?: boolean;
  blockedReason?: string;
  resumeAt?: number;
  pendingApproval?: Ticket["pendingApproval"];
  allowedTools?: string[];
  permissionMode?: Ticket["permissionMode"];
  externalRef?: Ticket["externalRef"];
  autoStart?: boolean;
  /** A message the human started writing to the agent (Ticket.messageDraft) */
  messageDraft?: string;
  /** The agents' notes for the next run (Ticket.agentNotes) */
  agentNotes?: string;
  /** Activity entries: [author, body, kind (default: note from an agent, system from the system, message from a human)] */
  activity?: [ActivityAuthor, string, ActivityKind?][];
  ageMin: number;
}

const byKey = (key: string) => [...tickets.values()].find((t) => t.key === key);

// HARNESS-20's approval card: a looping curl watcher with a triage prompt.
const EVENTS_PROMPT = "If this event is assigned to me and has actionable next steps, dispatch it to an agent.";
const EVENTS_LOOP = "while true; do curl -s -H \"Authorization: Bearer $EVENTS_TOKEN\" 'https://api.example.com/events?since=1m'; sleep 60; done";
const EVENTS_SUMMARY = `Create watcher "events" (loop): ${EVENTS_LOOP}; prompt: "${EVENTS_PROMPT}"; env: EVENTS_TOKEN`;

function seedTicket(s: SeedTicket): Ticket {
  const createdAt = now() - s.ageMin * 60_000;
  const key = s.key ?? `${s.project.key}-${s.project.nextSeq++}`;
  const id = newId("tkt");
  const session = makeSession(key, "ticket", id, s.driver, s.project.path, s.title, createdAt);
  const worktree = s.status !== "planning" && s.project.useWorktrees && s.project.isGit !== false;
  const t: Ticket = {
    id,
    key,
    projectId: s.project.id,
    kind: s.kind ?? "task",
    title: s.title,
    spec: s.spec,
    status: s.status,
    sessionId: session.id,
    driver: s.driver,
    parentId: s.parentKey ? (byKey(s.parentKey)?.id ?? null) : null,
    dependsOn: s.dependsOn ?? [],
    autoStart: s.autoStart ?? !!s.parentKey,
    agentReview: s.agentReview ?? "pending",
    humanReview: s.humanReview ?? "pending",
    skipAgentReview: s.skipAgentReview ?? !!s.project.skipAgentReview,
    skipHumanReview: s.skipHumanReview ?? !!s.project.skipHumanReview,
    externalRef: s.externalRef ?? null,
    workdir: worktree ? `/Users/markhuot/.harness/worktrees/${key}` : s.project.path,
    branch: worktree ? `harness/${key.toLowerCase()}` : null,
    blockedReason: s.blockedReason ?? null,
    resumeAt: s.resumeAt ?? null,
    permissionMode: s.permissionMode ?? null,
    busy: s.busy ?? false,
    pendingApproval: s.pendingApproval ?? null,
    allowedTools: s.allowedTools ?? [],
    messageDraft: s.messageDraft ? { text: s.messageDraft, attachments: [], origin: null, updatedAt: createdAt + 60_000 } : null,
    model: s.model ?? null,
    ...(s.context !== undefined ? { context: s.context } : {}),
    ...(s.compacting ? { compacting: true } : {}),
    agentNotes: s.agentNotes ?? null,
    position: tickets.size,
    completedAt: s.status === "done" ? createdAt + 60_000 : null,
    createdAt,
    updatedAt: createdAt + 60_000,
  };
  session.busy = t.busy;
  tickets.set(t.id, t);

  // Transcript
  const list = transcripts.get(session.id)!;
  const runId = newId("run");
  const kind: RunKind = t.kind === "conductor" ? "conductor" : s.status === "planning" ? "plan" : "work";
  runs.set(runId, {
    id: runId,
    sessionId: session.id,
    kind,
    status: t.busy ? "running" : s.status === "blocked" ? "failed" : "succeeded",
    driver: t.driver,
    prompt: s.spec,
    error: s.status === "blocked" ? s.blockedReason ?? null : null,
    createdAt,
    startedAt: createdAt,
    endedAt: t.busy ? null : createdAt + 5 * 60_000,
    // What the Runs list shows when a driver reports usage (Claude Code: tokens and cost)
    ...(t.driver === "claude-code" ? { inputTokens: 41_300, outputTokens: 6_900, costUsd: 0.42 } : {}),
  });
  if (!t.busy && s.status !== "planning") {
    // A review run on another driver and model than the phase default, with tokens but no cost
    const reviewId = newId("run");
    runs.set(reviewId, {
      id: reviewId,
      sessionId: session.id,
      kind: "review",
      status: "succeeded",
      driver: "anthropic-api",
      prompt: "Review the changes on this branch",
      error: null,
      createdAt: createdAt + 6 * 60_000,
      startedAt: createdAt + 6 * 60_000,
      endedAt: createdAt + 6 * 60_000 + 83_000,
      model: "claude-sonnet-5",
      inputTokens: 1_240_000,
      outputTokens: 3_100,
    });
  }
  let seq = 0;
  let at = createdAt;
  const push = (role: TranscriptRole, content: TranscriptContent) => {
    at += 7_000;
    list.push({ id: newId("te"), sessionId: session.id, runId, seq: ++seq, role, content, createdAt: at });
  };
  push("user", { type: "text", text: s.spec });
  push("system", { type: "status", text: `Run started (${kind})` });
  push("assistant", { type: "thinking", text: "The user wants this done carefully. Let me look at the relevant files first." });
  push("assistant", { type: "text", text: `I'll start by looking at how \`${s.title.split(" ").slice(-1)[0]}\` is wired up in the codebase.` });
  push("assistant", { type: "tool_call", callId: "call_1", name: "Bash", input: { command: "rg -n \"useArticle\" src --type ts", timeout_ms: 30000 } });
  push("tool", {
    type: "tool_result",
    callId: "call_1",
    name: "Bash",
    output: [{ type: "text", text: "src/hooks/useArticle.ts:12:export function useArticle(id: string) {\nsrc/pages/article.tsx:8:import { useArticle } from \"../hooks/useArticle\";" }],
    isError: false,
  });
  push("system", {
    type: "status",
    text: "Allowed: rg -n \"useArticle\" src --type ts — read-only command",
    permission: { tool: "bash", summary: 'rg -n "useArticle" src --type ts', decision: "allow", reason: "read-only command", source: "policy", mode: "auto" },
  });
  push("assistant", { type: "tool_call", callId: "call_2", name: "Read", input: { file_path: `${s.project.path}/src/hooks/useArticle.ts`, limit: 40 } });
  push("tool", { type: "tool_result", callId: "call_2", name: "Read", output: [{ type: "text", text: "ENOENT: no such file or directory" }], isError: true });
  if (s.status === "blocked") push("system", { type: "error", text: s.blockedReason ?? "Run failed" });
  push("assistant", { type: "text", text: "Found it. The hook caches by slug, not by id, which explains the stale data. I'll switch the cache key and add a regression test." });
  if (s.status !== "planning" && s.status !== "in_progress") push("system", { type: "status", text: `Moved to ${s.status.replace("_", " ")}` });

  // The spec: revision 1 with the ticket, then the agent's (or human's) later revisions.
  seedSpec(t, createdAt);
  for (const [i, [author, note, body]] of (s.revisions ?? []).entries()) {
    reviseSpec(t, body, { author, note, runId: author === "agent" ? runId : null, runKind: author === "agent" ? kind : null, createdAt: createdAt + (i + 1) * 2 * 60_000 });
  }
  // Pressing Start approved what the spec said then (seeded tickets past planning started from revision 1).
  if (s.status !== "planning") markBaseline(t, 1);

  // Like the service's block tool: the question lands in Activity as a `blocked` entry.
  const seeded: [ActivityAuthor, string, ActivityKind?][] = [...(s.activity ?? [])];
  if (s.status === "blocked" && s.blockedReason && !s.pendingApproval) seeded.push(["agent", s.blockedReason, "blocked"]);
  for (const [i, [author, body, kind = author === "agent" ? "note" : author === "human" ? "message" : "system"]] of seeded.entries()) {
    const meta: ActivityMeta = kind === "blocked" ? { question: body } : kind === "review_approved" || kind === "changes_requested" ? { round: 1, by: "agent" } : kind === "submitted" ? { specRevision: t.specRevision } : {};
    activity.push({ id: newId("act"), sessionId: session.id, ticketId: t.id, kind, author, body, meta, createdAt: createdAt + (i + 1) * 3 * 60_000 });
  }
  return t;
}

function seed() {
  // Three kinds of checkout for the Approve menu: a GitHub remote gh is logged into (merge, open
  // PR, custom), plain git (HARNESS, HELLOHARNESS: merge, custom) and no git (SITE: custom only).
  const ny = seedProject("NYTIMES", "nytimes", "/Users/markhuot/Sites/nytimes", false, "blue", true, "github.com");
  const hx = seedProject("HARNESS", "harness", "/Users/markhuot/Sites/harness", true);

  seedTicket({
    project: ny,
    title: "Fix stale article cache on slug change",
    spec: "Articles show stale content after an editor renames the slug. Investigate the `useArticle` hook cache and fix it.",
    status: "in_progress",
    driver: "claude-code",
    model: "sonnet",
    busy: true,
    ageMin: 42,
    agentNotes:
      "## Where things live\n- `src/hooks/useArticle.ts`: the cache, keyed by `slug` (the bug)\n- `src/api/articles.ts`: `renameSlug()` returns the article with its stable `id`\n\n## Gotchas\n- The SSR path warms the cache from `getServerSideProps`; key it by `id` there too.\n\n## Verify\n- `bun test src/hooks/useArticle.test.ts`\n- Rename a slug in the editor and reload the article page.\n\n## Half done\n- Regression test written, not yet passing.",
    activity: [
      ["agent", "Reproduced the bug locally. The cache is keyed by `slug`, so a rename orphans the old entry.\n\nNext:\n- switch the key to `article.id`\n- add a regression test"],
    ],
  }); // NYTIMES-1 (live stream)
  seedTicket({
    project: ny,
    title: "Add dark mode to the crossword player",
    spec: "Support prefers-color-scheme in the crossword player. Keep contrast AA for filled squares.",
    status: "planning",
    driver: "claude-code",
    ageMin: 300,
    revisions: [
      [
        "agent",
        "Drafted the plan",
        "## Goal\n\nSupport prefers-color-scheme in the crossword player. Keep contrast AA for filled squares.\n\n## Plan\n\n1. Introduce CSS variables for the grid palette\n2. Map them under `@media (prefers-color-scheme: dark)`\n3. Snapshot test both themes\n\n| Token | Light | Dark | Contrast |\n|:------|:-----:|:----:|---------:|\n| `--cell-bg` | #ffffff | #1e1f24 | — |\n| `--cell-filled` | #111111 | #f2f2f2 | **15.3:1** |\n| `--cell-focus` | #ffda00 | #8a6d00 | 4.6:1 |\n\n## Open questions\n\n- Should the clue list follow the system theme too, or only the grid?",
      ],
    ],
    activity: [["agent", "Drafted a plan in the spec. One open question on the clue list."]],
  }); // NYTIMES-2
  seedTicket({
    project: ny,
    title: "Migrate newsletter signup to the new API",
    spec: "Move the newsletter form from the legacy /subscribe endpoint to the v2 subscriptions API.",
    status: "blocked",
    driver: "anthropic-api",
    blockedReason: "The v2 API requires an OAuth client id for the signup form. Which environment's client id should I use — staging or production?",
    ageMin: 180,
    activity: [["agent", "Ported the form and validation. Blocked on credentials for the v2 API; see the question."]],
  }); // NYTIMES-3
  seedTicket({
    project: hx,
    key: "HARNESS-9",
    title: "Install Playwright and add a smoke test",
    spec: "Add a Playwright smoke test that loads the board and checks five columns render.",
    status: "blocked",
    driver: "claude-code",
    blockedReason: "Waiting for permission to use Bash",
    pendingApproval: {
      id: "appr_1",
      runId: "run_appr_1",
      toolName: "Bash",
      input: { command: "bun add -d @playwright/test && bunx playwright install chromium", description: "Install Playwright and its browser" },
      requestedAt: now() - 90_000,
      reason: "Installs a new dev dependency the agent chose (@playwright/test) and downloads a browser binary.",
      source: "classifier",
    },
    allowedTools: ["Read", "Edit"],
    ageMin: 25,
    activity: [["agent", "Scaffolded `tests/smoke.spec.ts`. Needs Playwright installed to run it."]],
  }); // HARNESS-9
  seedTicket({
    project: hx,
    key: "HARNESS-21",
    title: "Walk a purchase on the demo branch",
    spec: "Merge the latest branches into the demo branch, then walk a purchase step by step.",
    status: "blocked",
    driver: "claude-code",
    blockedReason: "You've hit your limit · resets 2:30pm (America/New_York)",
    resumeAt: now() + 25 * 60_000,
    ageMin: 40,
    activity: [["agent", "Merged the latest branch; clearing the cart for the walkthrough."]],
  }); // HARNESS-21: stopped on a usage limit, restarts on its own
  seedTicket({
    project: hx,
    key: "HARNESS-20",
    title: "Watch the events API",
    spec: "Add a watcher that polls https://api.example.com/events every minute. If an event is assigned to me and has actionable next steps, dispatch it to an agent.",
    status: "blocked",
    driver: "claude-code",
    blockedReason: `Permission needed: create_watcher — ${EVENTS_SUMMARY}`,
    pendingApproval: {
      id: "appr_cfg",
      runId: "run_appr_cfg",
      toolName: "mcp__harness__create_watcher",
      input: {
        name: "events",
        command: EVENTS_LOOP,
        mode: "loop",
        prompt: EVENTS_PROMPT,
        env: { EVENTS_TOKEN: "evt_live_2f9c" },
      },
      requestedAt: now() - 30_000,
      reason: "A watcher's command runs on this Mac as you, outside any ticket sandbox, every time the watcher fires.",
      source: "policy",
      summary: EVENTS_SUMMARY,
      onceOnly: true,
    },
    ageMin: 5,
    activity: [["agent", "Checked the events endpoint with `curl`. Asking to add the watcher with your triage instructions."]],
  }); // HARNESS-20
  seedTicket({
    project: ny,
    title: "Lazy-load below-the-fold images on section fronts",
    spec: "Use native loading=lazy and add width/height to avoid CLS.",
    status: "review",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "pending",
    messageDraft: "Can we keep the hero image eager? It's above the fold on",
    ageMin: 600,
    activity: [
      ["agent", "Added `loading=\"lazy\"` to `SectionImage` and explicit dimensions.\n\n```tsx\n<img loading=\"lazy\" width={w} height={h} src={src} />\n```\n\nLighthouse CLS dropped from 0.14 to 0.02."],
      ["agent", "Lazy-loading and explicit sizes on section fronts; CLS 0.14 → 0.02.", "submitted"],
      ["agent", "Change is minimal and well tested.", "review_approved"],
    ],
    revisions: [
      [
        "agent",
        "Status: what changed",
        [
          "## Goal",
          "",
          "Use native loading=lazy and add width/height to avoid CLS.",
          "",
          "## Status",
          "",
          "Done. The image helper, its config and the template change:",
          "",
          "```ts",
          "export function imageProps(src: string, w: number, h: number): ImgProps {",
          '  return { src, width: w, height: h, loading: "lazy" as const }; // below the fold',
          "}",
          "```",
          "",
          "```php",
          "<?php",
          "function image_props(string $src, int $w, int $h): array {",
          "    return ['src' => $src, 'width' => $w, 'height' => $h, 'loading' => 'lazy'];",
          "}",
          "```",
          "",
          "```yaml",
          "images:",
          "  lazy: true",
          "  sizes: [320, 640, 1280] # srcset widths",
          "```",
          "",
          "```diff",
          "--- a/src/SectionImage.tsx",
          "+++ b/src/SectionImage.tsx",
          "@@ -12,3 +12,3 @@ export function SectionImage({ src, w, h }: Props) {",
          "-  return <img src={src} />;",
          '+  return <img loading="lazy" width={w} height={h} src={src} />;',
          " }",
          "```",
        ].join("\n"),
      ],
    ],
  }); // NYTIMES-4
  const upgrade = seedTicket({
    project: ny,
    title: "Upgrade Next.js to 15 and fix type errors",
    spec: "Bump next and react, fix the resulting type errors.",
    status: "done",
    driver: "dummy",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 3000,
    activity: [["agent", "Upgraded to Next 15. All `tsc` errors fixed; `bun test` green."], ["agent", "Completed. Opened https://github.com/markhuot/nytimes/pull/318 from `harness/nytimes-5`."]],
  }); // NYTIMES-5
  // Completed with "Approve and open PR": the card shows a PR chip, the ticket a PR link.
  upgrade.completionAction = "pr";
  upgrade.pullRequestUrl = "https://github.com/markhuot/nytimes/pull/318";
  seedTicket({
    project: ny,
    title: "Paywall meter counts AMP pageviews twice",
    spec: "Jira FOO-123: The meter increments twice on AMP article views.",
    key: "FOO-123",
    status: "in_progress",
    driver: "claude-code",
    externalRef: { source: "jira", key: "FOO-123", url: "https://happycog.atlassian.net/browse/FOO-123", raw: { key: "FOO-123", summary: "Paywall meter counts AMP pageviews twice" } },
    dependsOn: ["NYTIMES-5", "NYTIMES-3"],
    ageMin: 90,
    activity: [["agent", "Dispatched from Jira. Waiting on the newsletter migration before touching the meter script."]],
  });

  // Conductor with seven children in HARNESS, across every column (Tickets tab, board rollup)
  seedTicket({
    project: hx,
    kind: "conductor",
    title: "Build the harness desktop app",
    spec: "Coordinate the Electron app build.\n- Board view with drag and drop\n- Ticket detail with live transcript",
    status: "in_progress",
    driver: "claude-code",
    busy: true,
    ageMin: 120,
    activity: [["agent", "Split the work into seven child tickets. The shell (HARNESS-5) goes first; the store, signing and settings build on it."]],
  }); // HARNESS-1
  seedTicket({
    project: hx,
    parentKey: "HARNESS-1",
    title: "Board view with drag and drop",
    spec: "Five columns, cards update live.",
    status: "review",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 110,
    revisions: [
      [
        "agent",
        "Status with screenshots",
        [
          "## Goal",
          "",
          "Five columns, cards update live.",
          "",
          "## Status",
          "",
          "Board renders all five columns; drag and drop calls `updateTicket({ status })`. Screenshots of the board in both themes, the narrow layout, and a recording of a drag.",
          "",
          // A figure (full width, its alt text the caption), then a row of thumbnails.
          `![The board in the light theme, with all five columns](attachment:${mockScreenshot("board-light.png", 1440, 900, 215, false).id})`,
          "",
          // deleted.png has no bytes: its attachment 404s, like one whose ticket was deleted.
          [
            mockScreenshot("board-dark.png", 1440, 900, 265, true),
            mockScreenshot("board-narrow.png", 390, 844, 150, false),
            ...mockVideo("drag.mp4"),
            specMedia({ id: newId("att"), path: "/tmp/harness-mock/attachments/deleted.png", name: "deleted.png", source: "spec", kind: "image", mimeType: "image/png", size: 1024, width: 800, height: 600 }),
          ]
            .map((a) => `![${a.name}](attachment:${a.id} "thumb")`)
            .join(" "),
        ].join("\n"),
      ],
    ],
    activity: [["agent", "Board view done, with screenshots in the spec.", "submitted"]],
  }); // HARNESS-2
  seedTicket({
    project: hx,
    parentKey: "HARNESS-1",
    title: "Ticket detail with live transcript",
    spec: "Spec, Activity, transcript and browser tabs.",
    status: "planning",
    driver: "dummy",
    dependsOn: ["HARNESS-2"],
    ageMin: 110,
  }); // HARNESS-3
  seedTicket({
    project: hx,
    title: "Write launchd install docs",
    spec: "Document `harness service install` and log locations.",
    status: "done",
    driver: "dummy",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 2000,
    activity: [["agent", "Docs written in `DESIGN.md` under Runtime paths."]],
  }); // HARNESS-4
  const child = (s: Omit<SeedTicket, "project" | "parentKey">) => seedTicket({ project: hx, parentKey: "HARNESS-1", ...s });
  child({
    key: "HARNESS-5",
    title: "Scaffold the Electron shell and preload bridge",
    spec: "Main process, preload with a typed bridge, hidden-inset titlebar.",
    status: "done",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 118,
    activity: [["agent", "Shell boots with a typed `window.harness` bridge; window state persists across launches."]],
  });
  child({
    key: "HARNESS-6",
    title: "Wire the WebSocket store and reducer",
    spec: "REST snapshot + live events into one normalized store.",
    status: "in_progress",
    driver: "anthropic-api",
    busy: true,
    dependsOn: ["HARNESS-5"],
    ageMin: 100,
    activity: [["agent", "Reducer handles every event kind; reconnect refetches the snapshot. Writing the dedupe tests now."]],
  });
  child({
    key: "HARNESS-7",
    title: "Sign and notarize the macOS build",
    spec: "Developer ID signing + notarytool in the package script.",
    status: "blocked",
    driver: "claude-code",
    dependsOn: ["HARNESS-5"],
    blockedReason: "Which Apple Developer team should sign the build: Happy Cog or your personal account?",
    ageMin: 95,
    activity: [["agent", "Packaging works unsigned. Need to know which team's certificate to use."]],
  });
  child({
    key: "HARNESS-8",
    title: "Add a Playwright e2e for the board",
    spec: "Drive the built app and check drag and drop.",
    status: "blocked",
    driver: "claude-code",
    dependsOn: ["HARNESS-2"],
    blockedReason: "Waiting for permission to use Bash",
    pendingApproval: {
      id: "appr_2",
      runId: "run_appr_2",
      toolName: "Bash",
      input: { command: "bunx playwright install chromium", description: "Install the Playwright browser" },
      requestedAt: now() - 45_000,
    },
    ageMin: 60,
  });
  child({
    key: "HARNESS-10",
    title: "Settings screen for drivers and watchers",
    spec: "Driver login state and watcher CRUD.",
    status: "review",
    driver: "claude-code",
    dependsOn: ["HARNESS-5"],
    agentReview: "approved",
    humanReview: "pending",
    ageMin: 80,
    activity: [["agent", "Settings has Drivers and Watchers sections; each saves on blur."]],
  });
  hx.nextSeq = 11;

  // A project whose key was derived from a long folder name (Project settings → Identifier).
  const hh = seedProject("HELLOHARNESS", "hello-harness", "/Users/markhuot/Sites/hello-harness", false,"#e0569b");
  for (const [title, status, ageMin] of [
    ["Scaffold the hello world page", "done", 3000],
    ["Add a greeting API route", "done", 2400],
    ["Localize the greeting", "planning", 30],
  ] as const) {
    seedTicket({ project: hh, title, spec: title, status, driver: "claude-code", agentReview: status === "done" ? "approved" : "pending", humanReview: status === "done" ? "approved" : "pending", ageMin });
  }
  seedTicket({
    project: hh,
    key: "ACME-12",
    title: "Greeting typo on the landing page",
    spec: "Reported in Jira.",
    status: "planning",
    driver: "claude-code",
    externalRef: { source: "jira", key: "ACME-12", url: "https://example.atlassian.net/browse/ACME-12", raw: {} },
    ageMin: 20,
  });

  // A long-lived project with a deep Done column (paging, search): 130 done tickets, completed
  // over the last ~65 minutes (so they fill the first Done pages, newest first), renumbered from
  // an old WWW key (WWW-n → SITE-n resolve as aliases).
  // Not a git checkout: the composer hides its Use worktree switch for it.
  const site = seedProject("SITE", "marketing-site", "/Users/markhuot/Sites/marketing-site", false,"orange", false);
  const verbs = ["Fix", "Refactor", "Polish", "Document", "Speed up", "Test", "Localize", "Harden"];
  const nouns = ["hero banner", "pricing table", "footer links", "blog index", "contact form", "sitemap", "RSS feed", "404 page", "cookie notice", "search page", "case studies grid", "team page", "careers list"];
  for (let i = 1; i <= 130; i++) {
    const title = i === 42 ? "Retire the legacy jQuery carousel" : `${verbs[i % verbs.length]} the ${nouns[i % nouns.length]} (#${i})`;
    const t = seedTicket({
      project: site,
      key: `SITE-${i}`,
      title,
      spec: i === 42 ? "Swap the carousel for a CSS scroll-snap strip; drop jquery.slick." : `Routine maintenance ${i}.`,
      status: "done",
      driver: "dummy",
      agentReview: "approved",
      humanReview: "approved",
      ageMin: 600 + i,
    });
    // SITE-130 finished most recently; SITE-1 about 65 minutes ago.
    t.completedAt = t.updatedAt = now() - (131 - i) * 30_000;
    keyAliases.set(`WWW-${i}`, t.id);
  }
  site.nextSeq = 131;

  // Remote IDs (DESIGN.md "Remote IDs"): a native MH-62, and two tickets with their own keys
  // linked to Jira's MH-62 (a PR review's stages), so the board shows "MH-62 · MH-124" and
  // "MH-62 · MH-130" beside the native MH-62. OPS-41 is a remote ID with no local ticket of that
  // key: opening it (#/board/all/ticket/OPS-41) lists the two tickets linked to it.
  const mh = seedProject("MH", "markhuot.com", "/Users/markhuot/Sites/markhuot.com", false,"teal", true, "github.com");
  const jira = (key: string, summary: string): Ticket["externalRef"] => ({ source: "jira", key, url: `https://happycog.atlassian.net/browse/${key}`, raw: { key, summary } });
  seedTicket({
    project: mh,
    key: "MH-62",
    title: "Newsletter signup posts twice on slow connections",
    spec: "The signup form doesn't disable its button while the request is in flight.",
    status: "in_progress",
    driver: "claude-code",
    ageMin: 400,
    activity: [["agent", "Reproduced with network throttling. The button re-enables before the response lands."]],
  });
  seedTicket({
    project: mh,
    key: "MH-124",
    title: "Review the checkout PR: API changes",
    spec: "Jira MH-62, stage 1: review the order API changes in the checkout PR.",
    status: "review",
    driver: "claude-code",
    agentReview: "approved",
    externalRef: jira("MH-62", "Checkout rewrite"),
    ageMin: 180,
    activity: [["agent", "Reviewed the order API. Two comments on idempotency keys; otherwise good."]],
  });
  seedTicket({
    project: mh,
    key: "MH-130",
    title: "Review the checkout PR: UI pass",
    spec: "Jira MH-62, stage 2: review the checkout UI once the API changes land.",
    status: "in_progress",
    driver: "claude-code",
    externalRef: jira("MH-62", "Checkout rewrite"),
    dependsOn: ["MH-124"],
    ageMin: 60,
  });
  seedTicket({
    project: mh,
    key: "MH-131",
    title: "Rotate the CDN signing key",
    spec: "Jira OPS-41: rotate the key and update the edge config.",
    status: "planning",
    driver: "claude-code",
    externalRef: jira("OPS-41", "Rotate CDN keys"),
    ageMin: 45,
  });
  seedTicket({
    project: mh,
    key: "MH-132",
    title: "Rotate the CDN signing key on staging",
    spec: "Jira OPS-41, staging first.",
    status: "done",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "approved",
    externalRef: jira("OPS-41", "Rotate CDN keys"),
    ageMin: 50,
  });
  mh.nextSeq = 133;

  // Triage sessions
  const t1 = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, "claude-code", ny.path, "Paywall meter counts AMP pageviews twice", now() - 95 * 60_000);
  t1.triageStatus = "dispatched";
  t1.outcome = "Dispatched to NYTIMES as FOO-123 (started).";
  transcripts.get(t1.id)!.push(
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 1, role: "user", content: { type: "text", text: "New output from watcher jira:\n\nFOO-123 Paywall meter counts AMP pageviews twice\n\nPrompt: If this ticket is assigned to me and has actionable next steps, dispatch it. FOO tickets go to the NYTIMES project." }, createdAt: t1.createdAt },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 2, role: "assistant", content: { type: "tool_call", callId: "c1", name: "dispatch_ticket", input: { project_key: "NYTIMES", key: "FOO-123", title: "Paywall meter counts AMP pageviews twice", start: true } }, createdAt: t1.createdAt + 5000 },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 3, role: "tool", content: { type: "tool_result", callId: "c1", name: "dispatch_ticket", output: [{ type: "text", text: "Created FOO-123" }], isError: false }, createdAt: t1.createdAt + 6000 },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 4, role: "system", content: { type: "status", text: "Dispatched to NYTIMES" }, createdAt: t1.createdAt + 7000 },
  );
  const t3 = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, "claude-code", mh.path, "Checkout rewrite: UI ready for review", now() - 61 * 60_000);
  t3.triageStatus = "dispatched";
  t3.outcome = "Dispatched to MH-130 (MH-62) in MH (started).";
  transcripts.get(t3.id)!.push({ id: newId("te"), sessionId: t3.id, runId: null, seq: 1, role: "user", content: { type: "text", text: "New output from watcher jira:\n\nMH-62 Checkout rewrite: UI ready for review" }, createdAt: t3.createdAt });
  const t2 = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, "claude-code", ny.path, "Recipe card print styles broken in Safari", now() - 2 * 60_000);
  t2.triageStatus = "triaging";
  t2.busy = true;
  transcripts.get(t2.id)!.push({ id: newId("te"), sessionId: t2.id, runId: null, seq: 1, role: "user", content: { type: "text", text: "New output from watcher jira:\n\nFOO-131 Recipe card print styles broken in Safari\n\nPrompt: If this ticket is assigned to me and has actionable next steps, dispatch it. FOO tickets go to the NYTIMES project." }, createdAt: t2.createdAt });

  const w: Watcher = {
    id: newId("w"),
    name: "jira",
    command: "~/Sites/Jira/watch-jira.js",
    args: [],
    prompt: "If this ticket is assigned to me and has actionable next steps, dispatch it. FOO tickets go to the NYTIMES project.",
    cwd: null,
    env: {},
    mode: "loop",
    intervalSec: 60,
    enabled: true,
    driver: null,
    lastRunAt: now() - 60_000,
    lastError: null,
    createdAt: now() - 86400_000,
    updatedAt: now() - 60_000,
    live: { state: "running", since: now() - 42 * 60_000, nextRunAt: null, failures: 0 },
  };
  watchers.set(w.id, w);
  const status: Watcher = {
    ...w,
    id: newId("w"),
    name: "status-page",
    command: "while true; do curl -s https://status.example.com/api/incidents.json; sleep 300; done",
    prompt: "Only surface new incidents that affect the NYTIMES site.",
    lastRunAt: now() - 4 * 60_000,
    live: { state: "waiting", since: now() - 30_000, nextRunAt: now() + 90_000, failures: 3 },
    lastError: "Command exited with code 6: curl: (6) Could not resolve host: status.example.com\ncurl: (6) Could not resolve host: status.example.com\nThe watcher's loop exits when curl fails, so every restart hits the same DNS error until the host resolves again.",
  };
  watchers.set(status.id, status);
  const reviews: Watcher = {
    ...w,
    id: newId("w"),
    name: "gh-reviews",
    command: "gh search prs --review-requested=@me --state=open --json url,title",
    prompt: "Dispatch review requests for harness to HARNESS.",
    mode: "interval",
    intervalSec: 300,
    models: { "claude-code": "sonnet" },
    lastRunAt: now() - 60_000,
    live: { state: "waiting", since: now() - 58_000, nextRunAt: now() + 240_000, failures: 0 },
  };
  watchers.set(reviews.id, reviews);
  const sentry: Watcher = {
    ...w,
    id: newId("w"),
    name: "sentry-alerts",
    command: "sentry-cli events list --project web --max-rows 20",
    enabled: false,
    lastRunAt: now() - 3 * 86400_000,
    live: { state: "stopped", since: now() - 3 * 86400_000, nextRunAt: null, failures: 0 },
  };
  watchers.set(sentry.id, sentry);
  // The context gauge in each state (app/scripts/context-gauge-check.ts): normal, over the limit with
  // cache misses, compacting, a github-copilot estimate, and a fresh session.
  const gauge = (key: string, title: string, o: Partial<SeedTicket>) =>
    seedTicket({ project: hx, key, title, spec: "A ticket for the context gauge.", status: "review", driver: "claude-code", ageMin: 30, ...o });
  const usage = (o: Partial<NonNullable<Ticket["context"]>>): NonNullable<Ticket["context"]> => ({
    input: 1000, cacheRead: 61_000, cacheWrite: 20_000, output: 800, prefix: 50_000, at: now() - 60_000, estimated: false, misses: 0, missTokens: 0, ...o,
  });
  gauge("HARNESS-901", "Gauge: normal", { context: usage({}) });
  gauge("HARNESS-902", "Gauge: over the limit with misses", { context: usage({ input: 2000, cacheRead: 150_000, cacheWrite: 168_000, misses: 3, missTokens: 377_000 }) });
  gauge("HARNESS-903", "Gauge: compacting", { status: "in_progress", busy: true, compacting: true, context: usage({ cacheRead: 150_000 }) });
  gauge("HARNESS-904", "Gauge: github-copilot estimate", { driver: "github-copilot", context: usage({ input: 82_000, cacheRead: 0, cacheWrite: 0, prefix: 0, estimated: true }) });
  gauge("HARNESS-905", "Gauge: new session", { context: null });
  gauge("HARNESS-906", "Gauge: run going", { status: "in_progress", busy: true, context: usage({ misses: 1, missTokens: 40_000 }) });
}
seed();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
};

const ok = (data: unknown, status = 200) => Response.json({ data }, { status, headers: CORS });
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: CORS });

class HttpError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message);
  }
}

/**
 * Like the service's relatedTickets: tickets linked to `requested` as their remote ID, or to the
 * found ticket's own remote ID, newest first, without the ticket itself or drafts.
 */
function relatedTickets(requested: string, t?: Ticket): RelatedTicket[] {
  const ids = new Set([requested.toUpperCase(), ...(t?.externalRef ? [t.externalRef.key.toUpperCase()] : [])]);
  return [...tickets.values()]
    .filter((o) => o !== t && !o.draft && !!o.externalRef && ids.has(o.externalRef.key.toUpperCase()))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((o) => ({ key: o.key, title: o.title, status: o.status, projectId: o.projectId, externalKey: o.externalRef!.key }));
}

/** By current key, else by an old key (resolvedFrom = the alias it came through). */
function lookupTicket(key: string): { ticket: Ticket; alias: string | null } | null {
  const k = decodeURIComponent(key).toUpperCase();
  const direct = byKey(k);
  if (direct) return { ticket: direct, alias: null };
  const viaAlias = keyAliases.get(k);
  const t = viaAlias ? tickets.get(viaAlias) : undefined;
  return t ? { ticket: t, alias: k } : null;
}

function ticketByKey(key: string): Ticket {
  const t = lookupTicket(key)?.ticket;
  if (!t) throw new HttpError(404, `Ticket ${key} not found`);
  return t;
}

const completedAtOf = (t: Ticket) => t.completedAt ?? t.updatedAt;
/** Page order: done newest-completed first, other columns by position. */
function columnOrder(a: Ticket, b: Ticket) {
  if (a.status === "done" && b.status === "done") return completedAtOf(b) - completedAtOf(a) || (a.id < b.id ? -1 : 1);
  return a.position - b.position || a.createdAt - b.createdAt;
}

/** Search rank like the service: key (current or old, exact/prefix) 0, title 1, the rest 2; null = no match. */
function searchRank(t: Ticket, q: string): number | null {
  const needle = q.toLowerCase();
  const keys = [t.key, ...[...keyAliases].filter(([, id]) => id === t.id).map(([k]) => k)].map((k) => k.toLowerCase());
  if (keys.some((k) => k === needle || k.startsWith(needle))) return 0;
  // A remote ID hit ranks after local keys, above the title.
  const remote = t.externalRef?.key.toLowerCase();
  if (remote && (remote === needle || remote.startsWith(needle))) return 0.5;
  if (t.title.toLowerCase().includes(needle)) return 1;
  const latest = activity.filter((e) => e.ticketId === t.id).at(-1)?.body ?? "";
  if (t.spec.toLowerCase().includes(needle) || latest.toLowerCase().includes(needle)) return 2;
  return null;
}

/** Offset cursors ("o:50"): opaque to clients. */
function paginate(list: Ticket[], url: URL) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
  const cursor = url.searchParams.get("cursor");
  const offset = cursor ? Number(cursor.replace(/^o:/, "")) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "Invalid cursor");
  const page = list.slice(offset, offset + limit);
  return { tickets: page, nextCursor: offset + limit < list.length ? `o:${offset + limit}` : null, total: list.length };
}

/** Same rules as the service: native OLD-n → NEW-n (linked tickets too), legacy mirrors (key = remote ID) keep their keys. */
function renameProjectKey(p: Project, key: string) {
  const other = [...projects.values()].find((o) => o.id !== p.id && o.key === key);
  if (other) throw new HttpError(409, `Project key ${key} is already used by ${other.name}`);
  const prefix = `${p.key}-`;
  const native = [...tickets.values()].filter((t) => t.projectId === p.id && !isLegacyMirror(t) && t.key.startsWith(prefix) && /^\d+$/.test(t.key.slice(prefix.length)));
  const map = new Map(native.map((t) => [t.key, `${key}-${t.key.slice(prefix.length)}`]));
  const clash = [...map.values()].filter((k) => {
    const hit = byKey(k);
    return hit && !map.has(hit.key);
  });
  if (clash.length) throw new HttpError(409, `Can't rename to ${key}: ${clash.join(", ")} already exist${clash.length === 1 ? "s" : ""}`);
  p.key = key;
  for (const t of native) {
    keyAliases.set(t.key, t.id);
    t.key = map.get(t.key)!;
    const s = sessions.get(t.sessionId);
    if (s) {
      s.key = t.key;
      s.updatedAt = now();
      broadcast({ kind: "session.upserted", session: s });
    }
  }
  for (const t of tickets.values()) {
    const deps = t.dependsOn.map((d) => map.get(d) ?? d);
    const touched = native.includes(t) || deps.some((d, i) => d !== t.dependsOn[i]);
    t.dependsOn = deps;
    if (touched) upsertTicket(t);
  }
}

function ticketDetail(t: Ticket, resolvedFrom: string | null = null): TicketDetail {
  return {
    ...(resolvedFrom ? { resolvedFrom } : {}),
    ticket: t,
    session: sessions.get(t.sessionId)!,
    activity: activity.filter((e) => e.ticketId === t.id),
    runs: [...runs.values()].filter((r) => r.sessionId === t.sessionId),
    dependents: [...tickets.values()].filter((o) => o.dependsOn.includes(t.key)).map((o) => o.key),
    children: [...tickets.values()].filter((o) => o.parentId === t.id),
    relatedTickets: relatedTickets(resolvedFrom ?? t.key, t),
    // Like the service: the media the spec refers to, as attachment records.
    attachments: [...new Set([...t.spec.matchAll(/\(attachment:([^\s)]+)/g)].map((m) => m[1]!))].flatMap((id) => attachmentRecords.get(id) ?? []),
    subagents: subagents.get(t.sessionId) ?? [],
  };
}

/** PATCH projectId on a draft: it takes the other project's next key, and the old one resolves as an alias. */
function moveDraft(t: Ticket, projectId: string) {
  const to = projects.get(projectId);
  if (!to) throw new HttpError(400, "Unknown projectId");
  const from = projects.get(t.projectId);
  keyAliases.set(t.key, t.id);
  t.key = `${to.key}-${to.nextSeq++}`;
  t.projectId = to.id;
  t.requestedBranch = null;
  t.baseBranch = null;
  t.useWorktree = null;
  t.workdir = to.path;
  if (from) broadcast({ kind: "project.upserted", project: from });
  broadcast({ kind: "project.upserted", project: to });
  const s = sessions.get(t.sessionId);
  if (s) {
    s.key = t.key;
    s.cwd = to.path;
    s.updatedAt = now();
    broadcast({ kind: "session.upserted", session: s });
  }
}

function setStatus(t: Ticket, status: TicketStatus) {
  if (t.status === status) return;
  t.status = status;
  t.completedAt = status === "done" ? now() : null;
  appendEntry(t.sessionId, null, "system", { type: "status", text: `Moved to ${status.replace("_", " ")}` });
}

/**
 * Mirrors Orchestrator.submit: a ticket with skipAgentReview gets agentReview "skipped" and no
 * review run; one with skipHumanReview gets humanReview "approved", so it lands once the agent
 * review passes.
 */
function submitForReview(t: Ticket) {
  setStatus(t, "review");
  t.agentReview = t.skipAgentReview ? "skipped" : "pending";
  t.humanReview = t.skipHumanReview ? "approved" : "pending";
  addActivity(t.sessionId, t.id, "submitted", "agent", `Work finished for **${t.title}**. Ready for review.`, { specRevision: t.specRevision ?? 1 });
  upsertTicket(t);
  if (t.skipHumanReview) appendEntry(t.sessionId, null, "system", { type: "status", text: "Human review: skipped" });
  if (t.skipAgentReview) {
    appendEntry(t.sessionId, null, "system", { type: "status", text: "Agent review: skipped" });
    noteReady(t);
  } else agentReviewRun(t, "The change looks correct and is covered by tests. Approving.");
}

function agentReviewRun(t: Ticket, text: string) {
  simulateRun(t, "review", "Review the change.", text, (cur) => {
    cur.agentReview = "approved";
    addActivity(cur.sessionId, cur.id, "review_approved", "agent", text, { round: 1, by: "agent" });
    queueMicrotask(() => noteReady(cur));
  });
}

/** Mirrors Orchestrator.applySkipAgentReview: in review, the flag skips a pending review or starts one for a skipped review. */
function applySkipAgentReview(t: Ticket) {
  if (t.status !== "review") return;
  if (t.skipAgentReview && t.agentReview === "pending") {
    const r = activeRun(t.sessionId);
    if (r?.kind === "review") {
      finishRun(r, "cancelled");
      t.busy = false;
    }
    t.agentReview = "skipped";
    appendEntry(t.sessionId, null, "system", { type: "status", text: "Agent review: skipped" });
    noteReady(t);
  } else if (!t.skipAgentReview && t.agentReview === "skipped") {
    t.agentReview = "pending";
    agentReviewRun(t, "The change looks correct and is covered by tests. Approving.");
  }
}

/** Mirrors Orchestrator.applySkipHumanReview: in review, the flag approves a pending human review or puts its approval back to pending. */
function applySkipHumanReview(t: Ticket) {
  if (t.status !== "review") return;
  if (t.skipHumanReview && t.humanReview === "pending") {
    t.humanReview = "approved";
    appendEntry(t.sessionId, null, "system", { type: "status", text: "Human review: skipped" });
    noteReady(t);
  } else if (!t.skipHumanReview && t.humanReview === "approved" && activeRun(t.sessionId)?.kind !== "complete") {
    t.humanReview = "pending";
    appendEntry(t.sessionId, null, "system", { type: "status", text: "Human review: waiting on a human again" });
  }
}

/** Mirrors Orchestrator.noteReady: both reviews passed → complete run (conductor children wait, unless they skip the human review). */
function noteReady(t: Ticket) {
  if (t.status !== "review" || !reviewPassed(t.agentReview) || t.humanReview !== "approved") return;
  if (t.parentId && !t.skipHumanReview) return;
  completeRun(t);
}

/** Mirrors the service's completion run for the ticket's action (merge / pr / cleanup / custom). */
function completeRun(t: Ticket, instructions = t.completionInstructions ?? "") {
  const project = projects.get(t.projectId);
  // A stored choice the project no longer offers falls back to the default (as the service does).
  const action = resolveCompletionAction(t.completionAction ?? null, t, project, parentOf(t)).action ?? resolveCompletionAction(null, t, project, parentOf(t)).action!;
  const prompt = { merge: "Finalize: merge the worktree branch.", pr: "Finalize: push the branch and open a pull request.", cleanup: "Finalize: remove the worktree and branch.", custom: "Finalize the work as instructed." }[action];
  const result = { merge: "Merged the branch and cleaned up the worktree.", pr: "Pushed the branch and opened a pull request.", cleanup: "Removed the worktree and the harness branch.", custom: instructions ? `Done: ${instructions}` : "Wrapped up." }[action];
  simulateRun(t, "complete", `${prompt} ${instructions}`.trim(), result, (cur) => {
    if (action === "pr" && !cur.pullRequestUrl) cur.pullRequestUrl = `https://${project?.pullRequestHost ?? "github.com"}/markhuot/${project?.name ?? "repo"}/pull/${400 + tickets.size}`;
    addActivity(cur.sessionId, cur.id, "note", "agent", action === "pr" ? `Completed. Opened ${cur.pullRequestUrl}` : "Completed.");
    setStatus(cur, "done");
  });
}

function workRun(t: Ticket, prompt: string) {
  appendEntry(t.sessionId, null, "user", { type: "text", text: prompt });
  const answer = `Hello from the mock driver! You said: "${prompt}"`;
  simulateRun(t, "work", prompt, answer, (cur) => {
    if (cur.status === "in_progress") submitForReview(cur);
  });
}

function createTicket(body: Record<string, any>): Ticket {
  const project = projects.get(body.projectId);
  if (!project) throw new HttpError(400, "Unknown projectId");
  const draft = body.draft === true;
  if (typeof body.spec !== "string" || (!draft && !body.spec.trim())) throw new HttpError(400, "spec is required");
  const key: string = body.key ?? `${project.key}-${project.nextSeq++}`;
  if (byKey(key)) throw new HttpError(409, `Ticket ${key} already exists`);
  broadcast({ kind: "project.upserted", project });
  const id = newId("tkt");
  const driver = body.driver ?? project.defaultDriver ?? settings.defaultDriver;
  const title: string = body.title ?? draftTitle(body.spec);
  const session = makeSession(key, "ticket", id, driver, project.path, title, now());
  // A draft is saved in planning and never runs until it's submitted.
  const start = !draft && (body.start ?? true);
  const worktree = (body.useWorktree ?? project.useWorktrees) && project.isGit !== false;
  const t: Ticket = {
    id,
    key,
    projectId: project.id,
    kind: body.kind ?? "task",
    title,
    spec: body.spec,
    status: start ? "in_progress" : "planning",
    sessionId: session.id,
    driver,
    parentId: body.parentId ?? null,
    dependsOn: body.dependsOn ?? [],
    autoStart: body.autoStart ?? false,
    agentReview: "pending",
    humanReview: "pending",
    skipAgentReview: typeof body.skipAgentReview === "boolean" ? body.skipAgentReview : !!project.skipAgentReview,
    skipHumanReview: typeof body.skipHumanReview === "boolean" ? body.skipHumanReview : !!project.skipHumanReview,
    externalRef: body.externalRef ?? null,
    workdir: start && worktree ? `/Users/markhuot/.harness/worktrees/${key}` : project.path,
    branch: start && worktree ? body.branch || `harness/${key.toLowerCase()}` : null,
    requestedBranch: worktree ? body.branch || null : null,
    baseBranch: body.baseBranch || null,
    useWorktree: body.useWorktree ?? null,
    draft,
    blockedReason: null,
    permissionMode: body.permissionMode ?? null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    model: typeof body.model === "string" && body.model ? body.model : null,
    ...(body.phaseModels ? { phaseModels: mergePhaseModels({}, body.phaseModels) } : {}),
    position: tickets.size,
    createdAt: now(),
    updatedAt: now(),
  };
  seedSpec(t, t.createdAt);
  tickets.set(t.id, t);
  broadcast({ kind: "session.upserted", session });
  upsertTicket(t);
  if (draft) {
    appendEntry(t.sessionId, null, "system", { type: "status", text: "Draft saved" });
    return t;
  }
  launchTicket(t, start);
  return t;
}

/** A ticket's title from its spec: the first line (a blank draft is "Untitled draft"). */
function draftTitle(spec: string): string {
  return spec.trim().split("\n")[0]!.slice(0, 80) || "Untitled draft";
}

/** Start a new (or just submitted) ticket's first run: work (start) or a plan. */
function launchTicket(t: Ticket, start: boolean) {
  const project = projects.get(t.projectId)!;
  const worktree = (t.useWorktree ?? project.useWorktrees) && project.isGit !== false;
  if (start && worktree) {
    t.workdir = `/Users/markhuot/.harness/worktrees/${t.key}`;
    t.branch = t.requestedBranch || `harness/${t.key.toLowerCase()}`;
  }
  const title = t.title;
  const prompt = t.spec;
  appendEntry(t.sessionId, null, "user", { type: "text", text: prompt });
  if (start) {
    markBaseline(t);
    simulateRun(t, t.kind === "conductor" ? "conductor" : "work", prompt, `Hello from the mock driver! You said: "${prompt}"`, (cur) => {
      if (cur.status === "in_progress") submitForReview(cur);
    }, 4000);
  } else {
    simulateRun(t, "plan", prompt, `Here's a plan for: ${title}\n\n1. Investigate\n2. Implement\n3. Test`, (cur) => {
      // Like a plan run's update_spec: the plan goes into the spec, a note into Activity.
      const run = [...runs.values()].filter((r) => r.sessionId === cur.sessionId && r.kind === "plan").at(-1);
      reviseSpec(cur, `${cur.spec.trim()}\n\n## Plan\n\n1. Investigate\n2. Implement\n3. Test`, { author: "agent", note: "Drafted the plan", runId: run?.id ?? null, runKind: "plan" });
      addActivity(cur.sessionId, cur.id, "note", "agent", "Drafted a plan in the spec.");
    });
  }
}

async function readBody(req: Request): Promise<Record<string, any>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req: Request, url: URL): Promise<Response> {
  const method = req.method;
  const parts = url.pathname.split("/").filter(Boolean);
  const [a, b, c] = parts;

  if (a === "usage" && !b && method === "GET") return ok(usage);
  if (a === "mock" && b === "usage" && method === "PUT") {
    usage = (await req.json()) as PlanUsageReport;
    broadcast({ kind: "usage.updated", usage });
    return ok(usage);
  }

  if (a === "service" && b === "restart" && !c && method === "POST") {
    STALE = "";
    setTimeout(() => {
      for (const ws of sockets) ws.close();
    }, 50);
    return ok({ ok: true });
  }

  // Projects
  if (a === "projects") {
    if (!b && method === "GET") return ok([...projects.values()]);
    if (!b && method === "POST") {
      const body = await readBody(req);
      if (!body.path) throw new HttpError(400, "path is required");
      const base = String(body.path).replace(/\/+$/, "").split("/").pop() ?? "proj";
      const key = (body.key ?? base).toUpperCase().replace(/[^A-Z0-9]/g, "") || "PROJ";
      if ([...projects.values()].some((p) => p.key === key)) throw new HttpError(409, `Project key ${key} already exists`);
      const p: Project = {
        id: newId("proj"),
        key,
        name: body.name ?? base,
        path: body.path,
        nextSeq: 1,
        defaultDriver: body.defaultDriver ?? null,
        defaultModels: mergeModels({}, body.defaultModels),
        useWorktrees: body.useWorktrees ?? true,
        isGit: true,
        skipAgentReview: body.skipAgentReview ?? false,
        skipHumanReview: body.skipHumanReview ?? false,
        permissionMode: body.permissionMode ?? null,
        color: normalizeProjectColor(body.color ?? null) ?? null,
        group: mockGroup(body.group),
        completionAction: "merge",
        pullRequestHost: null,
        createdAt: now(),
        updatedAt: now(),
      };
      withCompletionActions(p);
      if (body.completionAction !== undefined) {
        if (!p.completionActions!.includes(body.completionAction)) throw new HttpError(400, `completionAction must be one of ${p.completionActions!.join(", ")}`);
        p.completionAction = body.completionAction;
      }
      projects.set(p.id, p);
      broadcast({ kind: "project.upserted", project: p });
      return ok(p, 201);
    }
    const p = b ? projects.get(b) : undefined;
    if (!p) throw new HttpError(404, "Project not found");
    if (c === "branches" && method === "GET") {
      if (p.isGit === false) return ok([]);
      return ok(filterBranches(url.searchParams.get("q") ?? "", Math.min(200, Number(url.searchParams.get("limit")) || 50), p.path));
    }
    if (method === "PATCH") {
      const { key: rawKey, nextSeq: _n, completionActions: _ca, pullRequestHost: _ph, isGit: _g, ...body } = await readBody(req);
      if (body.completionAction !== undefined && !offeredCompletionActions(p).includes(body.completionAction)) {
        throw new HttpError(400, `completionAction must be one of ${offeredCompletionActions(p).join(", ")}`);
      }
      if (rawKey !== undefined) {
        const { key, error } = checkProjectKey(String(rawKey));
        if (error) throw new HttpError(400, `Invalid project key "${key}": ${error}`);
        if (key !== p.key) renameProjectKey(p, key); // throws 409 on collisions
      }
      if (body.defaultModels !== undefined) body.defaultModels = mergeModels(p.defaultModels, body.defaultModels);
      if (body.phaseModels !== undefined) {
        body.phaseModels = mergePhaseModels(p.phaseModels, body.phaseModels);
        const legacy = legacyWork(body.phaseModels);
        body.defaultDriver = legacy.driver;
        body.defaultModels = legacy.models;
      }
      if (body.color !== undefined) {
        const color = normalizeProjectColor(body.color);
        if (color === undefined) throw new HttpError(400, `Invalid color ${JSON.stringify(body.color)}`);
        body.color = color;
      }
      if (body.group !== undefined) body.group = mockGroup(body.group, p.id);
      Object.assign(p, body, { id: p.id, key: p.key, updatedAt: now() });
      withCompletionActions(p);
      broadcast({ kind: "project.upserted", project: p });
      return ok(p);
    }
    if (method === "DELETE") {
      projects.delete(p.id);
      broadcast({ kind: "project.deleted", id: p.id });
      return ok({ ok: true });
    }
  }

  // Tickets
  if (a === "tickets") {
    const pid = url.searchParams.get("projectId");
    const group = url.searchParams.get("group");
    const statuses = url.searchParams.get("status")?.split(",").filter(Boolean) ?? [];
    const inProject = (t: Ticket) => (!pid || t.projectId === pid) && (!group || projects.get(t.projectId)?.group === group);
    if (!b && method === "GET") {
      return ok([...tickets.values()].filter((t) => inProject(t) && (!statuses.length || statuses.includes(t.status))));
    }
    if (b === "page" && !c && method === "GET") {
      const status = url.searchParams.get("status") as TicketStatus | null;
      if (!status) throw new HttpError(400, "status is required");
      const q = url.searchParams.get("q")?.trim();
      const list = [...tickets.values()].filter((t) => t.status === status && inProject(t) && (!q || searchRank(t, q) !== null)).sort(columnOrder);
      return ok(paginate(list, url));
    }
    if (b === "search" && !c && method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) throw new HttpError(400, "q is required");
      const ranked = [...tickets.values()]
        .filter(inProject)
        .map((t) => ({ t, rank: searchRank(t, q) }))
        .filter((x): x is { t: Ticket; rank: number } => x.rank !== null)
        .sort((x, y) => x.rank - y.rank || y.t.updatedAt - x.t.updatedAt || (x.t.id < y.t.id ? -1 : 1));
      return ok(paginate(ranked.map((x) => x.t), url));
    }
    if (!b && method === "POST") return ok(createTicket(await readBody(req)), 201);
    const found = lookupTicket(b!);
    if (!found) {
      // A remote ID never opens a ticket: GET points to the tickets linked to it.
      const requested = decodeURIComponent(b!).toUpperCase();
      const related = !c && method === "GET" ? relatedTickets(requested) : [];
      if (related.length) throw new HttpError(404, `${requested} is a remote ID, not a ticket key`, { requested, relatedTickets: related } satisfies RemoteKeyMatches);
      throw new HttpError(404, `Ticket ${b} not found`);
    }
    const t = found.ticket;
    if (!c) {
      if (method === "GET") return ok(ticketDetail(t, found.alias));
      if (method === "PATCH") {
        const body = await readBody(req);
        // kind, useWorktree and projectId only change while it's a draft; a draft's status doesn't.
        for (const k of ["kind", "useWorktree", "projectId"] as const) {
          if (body[k] !== undefined && !t.draft) throw new HttpError(409, `${t.key} isn't a draft; ${k} is fixed once a ticket launches`);
        }
        if (t.draft && body.status && body.status !== t.status) throw new HttpError(409, `${t.key} is a draft; submit it to start it`);
        // The spec first, like the service: a stale baseRevision refuses the whole PATCH (409 + SpecConflict).
        if (body.spec !== undefined) {
          if (typeof body.spec !== "string") throw new HttpError(400, "spec must be a string");
          if (t.draft) {
            // A draft keeps revision 1 and rewrites it in place.
            const first = specRevisions.get(t.id)?.[0];
            if (first) first.body = body.spec;
            t.spec = body.spec;
            if (body.title === undefined) t.title = draftTitle(t.spec);
          } else {
            if (body.baseRevision === undefined) throw new HttpError(400, "baseRevision is required with spec: the revision your edit started from (Ticket.specRevision)");
            if (!Number.isInteger(body.baseRevision) || body.baseRevision < 1) throw new HttpError(400, "baseRevision must be a revision number");
            const note = typeof body.specNote === "string" && body.specNote.trim() ? body.specNote.trim() : "Edited by hand";
            const rev = reviseSpec(t, body.spec, { author: "human", note, baseRevision: body.baseRevision });
            if (rev) appendEntry(t.sessionId, null, "system", { type: "status", text: `Spec revision ${rev.rev}: ${rev.note}` });
          }
        }
        if (body.projectId !== undefined && body.projectId !== t.projectId) moveDraft(t, body.projectId);
        if (body.kind !== undefined) t.kind = body.kind;
        if (body.useWorktree !== undefined) {
          t.useWorktree = body.useWorktree;
          const project = projects.get(t.projectId)!;
          if (!(t.useWorktree ?? project.useWorktrees) && body.branch === undefined) t.requestedBranch = null;
        }
        if (body.driver !== undefined && body.driver !== t.driver && body.model === undefined) t.model = null;
        for (const k of ["title", "driver", "dependsOn", "position"] as const) {
          if (body[k] !== undefined) (t as any)[k] = body[k];
        }
        if (body.model !== undefined) t.model = body.model || null;
        if (body.phaseModels !== undefined) {
          t.phaseModels = mergePhaseModels(t.phaseModels, body.phaseModels);
          t.driver = resolvePhaseChoice("work", { ticket: t.phaseModels, project: projects.get(t.projectId)?.phaseModels, settings: settings.phaseModels }).driver;
          t.model = t.phaseModels.work?.model ?? null;
        }
        if (body.permissionMode !== undefined) t.permissionMode = body.permissionMode || null;
        if (body.baseBranch !== undefined) t.baseBranch = body.baseBranch || null;
        if (body.externalRef !== undefined) {
          if (body.externalRef === null) t.externalRef = null;
          else {
            const key = String(body.externalRef.key ?? "").trim().toUpperCase();
            if (!isTicketKey(key)) throw new HttpError(400, `externalRef.key must look like FOO-123 (got "${body.externalRef.key ?? ""}")`);
            const url = typeof body.externalRef.url === "string" && body.externalRef.url.trim() ? body.externalRef.url.trim() : null;
            if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, "externalRef.url must be an http(s) URL");
            t.externalRef = { source: "manual", key, url, raw: null };
          }
        }
        if (body.branch !== undefined) {
          if (t.branch) throw new HttpError(409, `${t.key} already has a worktree on ${t.branch}; ask its agent to move it with update_branch`);
          t.requestedBranch = body.branch || null;
        }
        if (typeof body.skipAgentReview === "boolean" && body.skipAgentReview !== !!t.skipAgentReview) {
          t.skipAgentReview = body.skipAgentReview;
          applySkipAgentReview(t);
        }
        if (typeof body.skipHumanReview === "boolean" && body.skipHumanReview !== !!t.skipHumanReview) {
          t.skipHumanReview = body.skipHumanReview;
          applySkipHumanReview(t);
        }
        if (body.status && body.status !== t.status) {
          const to = body.status as TicketStatus;
          // Mirrors the service: Start (or Re-open) is the only way into in_progress.
          if (to === "in_progress") throw new HttpError(400, "Use POST /tickets/:key/start (or /reopen) to start work");
          setStatus(t, to);
          if (to !== "blocked") t.blockedReason = null;
        }
        upsertTicket(t);
        return ok(t);
      }
      if (method === "DELETE") {
        tickets.delete(t.id);
        broadcast({ kind: "ticket.deleted", id: t.id });
        return ok({ ok: true });
      }
    }
    if (method === "GET" && c === "activity") return ok(activity.filter((e) => e.ticketId === t.id));
    if (method === "GET" && c === "spec" && parts[3] === "revisions") {
      // /spec/revisions: every revision's metadata; /spec/revisions/:rev a body; ?diff=<rev> the diff from that one.
      const raw = parts[4];
      if (!raw) return ok((specRevisions.get(t.id) ?? []).map(revisionInfo));
      const rev = specRevisionOf(t, raw, "rev");
      const diff = url.searchParams.get("diff");
      if (!diff) return ok(rev);
      const other = specRevisionOf(t, diff, "diff");
      return ok({ from: other.rev, to: rev.rev, diff: unifiedDiff(other.body, rev.body, `${t.key} spec rev ${other.rev}`, `${t.key} spec rev ${rev.rev}`) } satisfies SpecDiff);
    }
    if (method === "PUT" && c === "message-draft") {
      // Mirrors the service: the whole draft, last write wins; empty clears it.
      if (t.draft) throw new HttpError(409, `${t.key} is a draft; submit it first`);
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      const files = Array.isArray(body.attachments) ? body.attachments.map(attachmentFromInput) : [];
      t.messageDraft = text || files.length ? { text, attachments: files, origin: typeof body.origin === "string" ? body.origin : null, updatedAt: now() } : null;
      upsertTicket(t, false);
      return ok(t);
    }
    if (method === "POST") {
      const body = await readBody(req);
      if (c === "submit") {
        if (!t.draft) throw new HttpError(409, `${t.key} isn't a draft`);
        if (!t.spec.trim()) throw new HttpError(400, "A draft needs a spec before it's submitted");
        t.draft = false;
        const start = body.start === true;
        if (start) setStatus(t, "in_progress");
        upsertTicket(t);
        launchTicket(t, start);
        return ok(t);
      }
      if (t.draft) throw new HttpError(409, `${t.key} is a draft; submit it first`);
      switch (c) {
        case "start": {
          // Mirrors the service: a planning ticket with open dependencies is queued (autoStart)
          // and stays in planning; a deleted dependency doesn't hold it.
          const open = t.dependsOn.filter((k) => byKey(k) && byKey(k)!.status !== "done");
          if (t.status === "planning" && open.length) {
            if (!t.autoStart) {
              t.autoStart = true;
              upsertTicket(t);
              appendEntry(t.sessionId, null, "system", { type: "status", text: `Waiting on ${open.join(", ")}` });
            }
            return ok(t);
          }
          // Mirrors the service: a press during a plan run approves the plan; the work starts when
          // the run ends (see simulateRun's callback in "messages").
          if (t.status === "planning" && t.busy) {
            if (!t.startAfterPlan) {
              t.startAfterPlan = true;
              upsertTicket(t);
              appendEntry(t.sessionId, null, "system", { type: "status", text: "Plan approved; work starts when planning finishes" });
            }
            return ok(t);
          }
          setStatus(t, "in_progress");
          markBaseline(t);
          workRun(t, "The plan is approved. Begin work.");
          return ok(t);
        }
        case "messages": {
          const text = String(body.text ?? "").trim();
          if (!text) throw new HttpError(400, "text is required");
          // Mirrors the service: an app's send uses up the ticket's message draft.
          t.messageDraft = null;
          // Mirrors the service: the message and the agent's answer are in the transcript only
          // (an older app's `log` is ignored).
          // Mirrors the service: planning → the plan run, in progress → the work, and blocked,
          // review and done stay put (a chat) unless `move` sends review/done back to work first.
          if (t.status === "planning") {
            appendEntry(t.sessionId, null, "user", { type: "text", text });
            const answer = `Updated the plan to account for: "${text}"`;
            t.startAfterPlan = false; // a message may change the plan, so it withdraws the approval
            simulateRun(t, "plan", text, answer, (cur) => {
              if (!cur.startAfterPlan) return;
              cur.startAfterPlan = false;
              setStatus(cur, "in_progress");
              markBaseline(cur);
              workRun(cur, "The plan is approved. Begin work.");
            });
          } else if (t.status === "in_progress") {
            workRun(t, text);
          } else if (body.move === true && (t.status === "review" || t.status === "done")) {
            t.agentReview = "pending";
            t.humanReview = "pending";
            setStatus(t, "in_progress");
            t.blockedReason = null;
            workRun(t, text);
          } else {
            appendEntry(t.sessionId, null, "user", { type: "text", text });
            const answer = `Here's what I know about that: "${text}". The ticket stays where it is.`;
            simulateRun(t, "chat", text, answer, () => {});
          }
          return ok(t);
        }
        case "review": {
          if (body.decision === "approve") {
            // Mirrors the service: the choice is kept on the ticket until the completion runs.
            if (body.action !== undefined) {
              t.completionAction = checkCompletionAction(t, body.action);
              t.completionInstructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions.trim() : null;
            }
            t.humanReview = "approved";
            addActivity(t.sessionId, t.id, "approved", "human", body.notes ? `Approved: ${body.notes}` : "Approved.", { by: "human" });
            upsertTicket(t);
            noteReady(t);
          } else {
            t.agentReview = "pending";
            t.humanReview = "pending";
            setStatus(t, "in_progress");
            addActivity(t.sessionId, t.id, "changes_requested", "human", `Changes requested: ${body.notes ?? ""}`, { by: "human" });
            workRun(t, body.notes ?? "Please address the review feedback.");
          }
          return ok(t);
        }
        case "reopen": {
          const notes = String(body.notes ?? "").trim();
          if (t.status !== "done") throw new HttpError(409, `${t.key} is not done; only done tickets can be re-opened`);
          if (!notes) throw new HttpError(400, "notes are required");
          t.agentReview = "pending";
          t.humanReview = "pending";
          setStatus(t, "in_progress");
          addActivity(t.sessionId, t.id, "reopened", "human", notes);
          workRun(t, notes);
          return ok(t);
        }
        case "complete":
          if (body.skipAgent) {
            // "Approve and take no action": in review it's also the human's approval.
            const inReview = t.status === "review";
            if (inReview) t.humanReview = "approved";
            appendEntry(t.sessionId, null, "system", { type: "status", text: inReview ? "Approved, no action taken" : "Marked done" });
            setStatus(t, "done");
            upsertTicket(t);
          } else {
            const action = checkCompletionAction(t, body.action ?? t.completionAction ?? undefined);
            t.completionAction = action;
            if (typeof body.instructions === "string") t.completionInstructions = body.instructions.trim() || null;
            completeRun(t, t.completionInstructions ?? "");
          }
          return ok(t);
        case "session": {
          // POST /tickets/:key/session { action }: refused while a run (or a compact) is going.
          if (t.compacting) throw new HttpError(409, "The session is compacting");
          if (t.busy) throw new HttpError(409, "A run is going; the session can change when it ends");
          if (body.action === "new") {
            const before = t.context ? contextTokens(t.context) : 0;
            t.context = null;
            appendEntry(t.sessionId, null, "system", { type: "status", text: `Session cleared (${before} tokens); the next run starts fresh` });
          } else if (body.action === "compact") {
            if (t.context) t.context = { ...t.context, input: 500, cacheRead: 40_000, cacheWrite: 6_000, misses: 0, missTokens: 0 };
          } else throw new HttpError(400, "action must be compact or new");
          upsertTicket(t);
          return ok(t);
        }
        case "cancel": {
          const r = activeRun(t.sessionId);
          if (r) finishRun(r, "cancelled");
          // Mirrors Orchestrator.completionStopped: a stopped completion puts the approval back.
          if (r?.kind === "complete" && t.status === "review" && t.humanReview === "approved") {
            t.humanReview = "pending";
            appendEntry(t.sessionId, r.id, "system", { type: "status", text: "Completion cancelled: approve again to land it" });
          }
          t.busy = false;
          upsertTicket(t);
          return ok(t);
        }
        case "approval": {
          const pa = t.pendingApproval;
          if (!pa) throw new HttpError(409, "No pending approval");
          const decision = String(body.decision ?? "");
          if (!["allow_once", "allow_tool", "deny"].includes(decision)) throw new HttpError(400, "decision must be allow_once, allow_tool or deny");
          if (decision === "allow_tool" && pa.onceOnly) throw new HttpError(400, `${pa.toolName} can only be allowed once`);
          if (decision === "allow_tool" && !t.allowedTools.includes(pa.toolName)) t.allowedTools = [...t.allowedTools, pa.toolName];
          t.pendingApproval = null;
          t.blockedReason = null;
          appendEntry(t.sessionId, pa.runId, "system", {
            type: "status",
            text: decision === "deny" ? `Denied ${pa.toolName}${body.message ? `: ${body.message}` : ""}` : `Allowed ${pa.toolName}${decision === "allow_tool" ? " for this ticket" : " once"}`,
          });
          setStatus(t, "in_progress");
          workRun(t, decision === "deny" ? `Permission denied. ${body.message ?? ""}` : `Permission granted for ${pa.toolName}.`);
          return ok(t);
        }
        case "agent-review":
          t.agentReview = "pending";
          upsertTicket(t);
          agentReviewRun(t, "Re-reviewed: still looks good. Approving.");
          return ok(t);
      }
    }
  }

  // Sessions
  if (a === "sessions") {
    if (!b && method === "GET") {
      const kind = url.searchParams.get("kind");
      return ok([...sessions.values()].filter((s) => !kind || s.kind === kind));
    }
    const s = b ? sessions.get(b) : undefined;
    if (!s) throw new HttpError(404, "Session not found");
    if (!c && method === "GET") return ok(s);
    if (c === "subagents" && method === "GET") return ok(subagents.get(s.id) ?? []);
    if (c === "transcript" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      // Like the service: ?subagent=<id> is that sub-agent's transcript, else the session's own.
      const subagent = url.searchParams.get("subagent");
      return ok((transcripts.get(s.id) ?? []).filter((e) => e.seq > after && (e.subagentId ?? null) === subagent));
    }
  }

  // Watchers
  if (a === "watchers") {
    if (!b && method === "GET") return ok([...watchers.values()]);
    if (!b && method === "POST") {
      const body = await readBody(req);
      if (!body.name || !body.command) throw new HttpError(400, "name and command are required");
      const w: Watcher = {
        id: newId("w"),
        name: body.name,
        command: body.command,
        args: body.args ?? [],
        prompt: body.prompt ?? "",
        cwd: body.cwd ?? null,
        env: body.env ?? {},
        mode: body.mode ?? "loop",
        intervalSec: body.intervalSec ?? 60,
        enabled: body.enabled ?? true,
        driver: body.driver ?? null,
        models: mergeModels({}, body.models),
        lastRunAt: null,
        lastError: null,
        createdAt: now(),
        updatedAt: now(),
      };
      watchers.set(w.id, w);
      broadcast({ kind: "watcher.upserted", watcher: w });
      return ok(w, 201);
    }
    if (b === "inject" && method === "POST") {
      const body = await readBody(req);
      // { source, text, prompt? }; a legacy `item` (or an object `text`) is JSON-stringified
      const raw = body.text ?? body.item ?? "";
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (!body.source || !text.trim()) throw new HttpError(400, "source and text are required");
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const s = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, settings.defaultDriver, "", outputTitle(text), now());
      s.triageStatus = "triaging";
      s.busy = true;
      upsertSession(s);
      appendEntry(s.id, null, "user", { type: "text", text: `New output from watcher ${body.source}:\n\n${text}${prompt ? `\n\nPrompt: ${prompt}` : ""}` });
      setTimeout(() => {
        s.triageStatus = "declined";
        s.outcome = "Declined: mock service does not dispatch.";
        s.busy = false;
        appendEntry(s.id, null, "system", { type: "status", text: "Declined" });
        upsertSession(s);
      }, 3000);
      return ok(s);
    }
    const w = b ? watchers.get(b) : undefined;
    if (!w) throw new HttpError(404, "Watcher not found");
    if (c === "run" && method === "POST") {
      // A pretend run: the process comes up, and loop watchers stay up (clearing the last error).
      w.lastRunAt = now();
      w.updatedAt = now();
      if (w.mode === "loop") w.lastError = null;
      w.live = { state: "running", since: now(), nextRunAt: null, failures: w.live?.failures ?? 0 };
      broadcast({ kind: "watcher.upserted", watcher: w });
      if (w.mode === "interval")
        setTimeout(() => {
          w.lastError = null;
          w.live = { state: "waiting", since: now(), nextRunAt: now() + w.intervalSec * 1000, failures: 0 };
          broadcast({ kind: "watcher.upserted", watcher: w });
        }, 1500);
      return ok({ ok: true });
    }
    if (method === "PATCH") {
      const wasEnabled = w.enabled;
      const { models, ...patch } = await readBody(req);
      Object.assign(w, patch, { id: w.id, updatedAt: now() });
      if (models !== undefined) w.models = mergeModels(w.models ?? {}, models);
      if (wasEnabled !== w.enabled) w.live = w.enabled ? { state: "running", since: now(), nextRunAt: null, failures: 0 } : { state: "stopped", since: now(), nextRunAt: null, failures: 0 };
      broadcast({ kind: "watcher.upserted", watcher: w });
      return ok(w);
    }
    if (method === "DELETE") {
      watchers.delete(w.id);
      broadcast({ kind: "watcher.deleted", id: w.id });
      return ok({ ok: true });
    }
  }

  // Drivers & settings
  if (a === "drivers") {
    if (!b && method === "GET") return ok(drivers);
    if (b && c === "models" && method === "GET") {
      if (!drivers.some((x) => x.id === b)) throw new HttpError(404, "Driver not found");
      const noKey = b === "anthropic-api" && !settings.anthropicApiKeySet;
      const data: DriverModels = noKey
        ? { driverId: b, models: [], error: "No Anthropic API key configured. Add one in Settings or set ANTHROPIC_API_KEY.", fetchedAt: now() }
        : { driverId: b, models: MOCK_MODELS[b] ?? [], error: null, fetchedAt: now() };
      return ok(data);
    }
    if (b && c === "login" && method === "POST") {
      const d = drivers.find((x) => x.id === b);
      if (!d) throw new HttpError(404, "Driver not found");
      if (!d.supportsLogin) throw new HttpError(400, `${d.name} does not support login`);
      return ok({ url: "https://claude.ai/login", message: "Opened the Claude login page. Finish signing in in your browser." });
    }
  }
  if (a === "settings") {
    if (method === "GET") return ok(settings);
    if (method === "PATCH") {
      const body = await readBody(req);
      const { anthropicApiKey, claudeOauthToken, copilotGithubToken, defaultModels, reviewModels, watcherModels, listen, prompts, phaseModels, ...rest } = body;
      if (prompts !== undefined) settings.prompts = mergePrompts(prompts);
      if (listen !== undefined) {
        settings.listen = applyListen(listen);
        networkError = null;
      }
      let pm = settings.phaseModels ?? {};
      if (rest.defaultDriver !== undefined || defaultModels !== undefined || reviewModels !== undefined) pm = applyLegacySettings(pm, { defaultDriver: rest.defaultDriver, defaultModels, reviewModels });
      if (phaseModels !== undefined) pm = mergePhaseModels(pm, phaseModels);
      settings = { ...settings, ...rest, phaseModels: pm, ...legacySettingsFields(pm), watcherModels: mergeModels(settings.watcherModels ?? {}, watcherModels) };
      if (anthropicApiKey !== undefined) {
        settings.anthropicApiKeySet = !!anthropicApiKey;
        const d = drivers.find((x) => x.id === "anthropic-api")!;
        d.authenticated = !!anthropicApiKey;
        d.detail = anthropicApiKey ? `Key ending …${String(anthropicApiKey).slice(-4)}` : "No API key configured";
      }
      if (claudeOauthToken !== undefined) {
        settings.claudeOauthTokenSet = !!claudeOauthToken;
        const d = drivers.find((x) => x.id === "claude-code")!;
        d.authenticated = true;
        d.detail = claudeOauthToken ? "Long-lived token" : "mark@happycog.com · Happy Cog (team)";
      }
      if (copilotGithubToken !== undefined) settings.copilotGithubTokenSet = !!copilotGithubToken;
      broadcast({ kind: "settings.updated", settings });
      return ok(settings);
    }
  }

  if (a === "prompts" && !b && method === "GET") return ok(promptCatalog());

  // Network & pairing
  if (a === "network" && !b && method === "GET") return ok(networkStatus());
  if (a === "pairing" && !b && method === "GET") {
    const mode = settings.listen?.mode ?? "localhost";
    if (mode === "localhost") throw new HttpError(409, "The service only listens on localhost; choose Tailscale, Any or Custom to pair a phone");
    const host = mode === "tailscale" ? MOCK_TAILSCALE.ip : mode === "custom" ? settings.listen!.host! : MOCK_LAN;
    const base = `http://${host}:${PORT}`;
    return ok({ url: base, token: TOKEN, pairUrl: buildPairUrl(base, TOKEN) });
  }
  if (a === "token" && b === "rotate" && method === "POST") {
    TOKEN = `mock-${crypto.randomUUID().replace(/-/g, "")}`;
    // Sockets opened with the old token are dropped, like the service does.
    setTimeout(() => {
      for (const ws of sockets) ws.close(4001, "Token rotated");
    }, 50);
    return ok({ token: TOKEN });
  }

  // Browser
  if (a === "browser" && b) {
    const tabParam = url.searchParams.get("tab");
    if (!c && method === "GET") return ok(browsers.has(b) ? stateFor(b, tabParam === null ? undefined : Number(tabParam)) : null);
    if (c === "navigate" && method === "POST") {
      const body = await readBody(req);
      const tab = navigate(b, typeof body.tabId === "number" ? body.tabId : undefined, String(body.url ?? "about:blank"));
      return ok(stateFor(b, tab.id));
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Browser simulation (PNG frames; the app draws base64 via data URLs, which sniff content)
// ---------------------------------------------------------------------------

// Like the service: a session's browser has tabs (ids count up from 1, never reused); each socket
// watches one tab per session. Each tab has its own size (Desktop | Mobile, width × height), and a
// `resize` counts only from the socket the tab's Responsive follows: the last to switch it on,
// else the newest socket watching it (a new tab is Responsive, and handOn passes it along when its
// socket leaves). A suspended tab (its page closed to save memory) reopens when a socket watches it.
interface TabSim {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  suspended?: boolean;
  size: BrowserSize;
  /** The socket whose stage the tab follows while `size.responsive`. */
  owner?: ServerWebSocket<WsData>;
  mouseX: number;
  mouseY: number;
  clicks: { x: number; y: number }[];
  scroll: number;
  typed: string;
  history: string[];
  index: number;
}
interface BrowserSim {
  tabs: Map<number, TabSim>;
  nextTab: number;
}
const browsers = new Map<string, BrowserSim>();

const titleOf = (url: string) => (url === "about:blank" ? "" : url.replace(/^https?:\/\//, ""));

function addTab(b: BrowserSim, url: string, title = titleOf(url)): TabSim {
  const t: TabSim = { id: b.nextTab++, url, title, loading: false, size: { device: "desktop", ...BROWSER_DESKTOP, responsive: true }, mouseX: -1, mouseY: -1, clicks: [], scroll: 0, typed: "", history: [url], index: 0 };
  b.tabs.set(t.id, t);
  return t;
}

function sim(sessionId: string): BrowserSim {
  let b = browsers.get(sessionId);
  if (!b) {
    b = { tabs: new Map(), nextTab: 1 };
    browsers.set(sessionId, b);
    addTab(b, "http://localhost:3000/", "Local dev server");
    addTab(b, "http://localhost:3000/docs", "Docs").suspended = true;
  }
  return b;
}

/** The tab `tabId` names, else (omitted or closed) the lowest open one. */
function tabOf(sessionId: string, tabId?: number): TabSim {
  const b = sim(sessionId);
  return (tabId !== undefined ? b.tabs.get(tabId) : undefined) ?? b.tabs.values().next().value!;
}

/** A tab's state as `ws` sees it: sizeOwner only for the socket the tab follows. */
function stateFor(sessionId: string, tabId?: number, ws?: ServerWebSocket<WsData>): BrowserState {
  const t = tabOf(sessionId, tabId);
  const tabs = [...sim(sessionId).tabs.values()].map(({ id, url, title, loading, suspended, size }) => ({ id, url, title, loading, ...(suspended && { suspended }), size }));
  const sizeOwner = t.size.responsive && !!ws && t.owner === ws;
  return { sessionId, tabId: t.id, url: t.url, title: t.title, loading: t.loading, ...(t.suspended && { suspended: true }), tabs, size: { ...t.size }, ...(sizeOwner && { sizeOwner }) };
}

const side = (n: number) => Math.max(BROWSER_MIN_SIDE, Math.min(BROWSER_MAX_SIDE, Math.round(n)));

function sendEvent(ws: ServerWebSocket<WsData>, event: HarnessEvent) {
  sendMsg(ws, { type: "event", event });
}

/** A Responsive tab whose socket left (or that never had one) follows the newest socket watching it. */
function handOn(sessionId: string) {
  for (const t of sim(sessionId).tabs.values()) {
    if (!t.size.responsive) {
      t.owner = undefined;
      continue;
    }
    if (t.owner && sockets.has(t.owner) && t.owner.data.subs.get(sessionId) === t.id) continue;
    t.owner = [...sockets].filter((ws) => ws.data.subs.get(sessionId) === t.id).at(-1);
  }
}

/** Every watcher of the session gets its own tab's state (the tab list changes for all of them). */
function emitState(sessionId: string) {
  handOn(sessionId);
  for (const ws of sockets) {
    const tabId = ws.data.subs.get(sessionId);
    if (tabId !== undefined) sendEvent(ws, { kind: "browser.state", sessionId, state: stateFor(sessionId, tabId, ws) });
  }
}

/** Point a socket at a tab (or the lowest open one) and send it that tab's state and a frame. */
function watch(ws: ServerWebSocket<WsData>, sessionId: string, tabId?: number) {
  const t = tabOf(sessionId, tabId);
  ws.data.subs.set(sessionId, t.id);
  t.suspended = false; // watching reopens it
  // Everyone: the watched tab may have a new Responsive owner (this socket, or another one's left).
  emitState(sessionId);
  sendEvent(ws, { kind: "browser.frame", sessionId, tabId: t.id, ...renderFrame(sessionId, t.id, frameTick) });
}

function navigate(sessionId: string, tabId: number | undefined, url: string): TabSim {
  const t = tabOf(sessionId, tabId);
  t.history = t.history.slice(0, t.index + 1);
  t.history.push(url);
  t.index = t.history.length - 1;
  t.scroll = 0;
  t.clicks = [];
  t.url = url;
  t.title = titleOf(url);
  t.loading = true;
  emitState(sessionId);
  setTimeout(() => {
    t.loading = false;
    emitState(sessionId);
  }, 600);
  return t;
}

function handleInput(ws: ServerWebSocket<WsData>, sessionId: string, tabId: number | undefined, input: BrowserInput) {
  const b = sim(sessionId);
  const t = tabOf(sessionId, tabId ?? ws.data.subs.get(sessionId));
  if (!(input.type === "mouse" && input.action === "move")) console.log(`[browser.input ${sessionId}#${t.id}]`, JSON.stringify(input));
  switch (input.type) {
    case "mouse":
      t.mouseX = input.x;
      t.mouseY = input.y;
      if (input.action === "down") t.clicks = [...t.clicks.slice(-9), { x: input.x, y: input.y }];
      if (input.action === "wheel") t.scroll = Math.max(0, t.scroll + (input.deltaY ?? 0));
      break;
    case "key":
      if (input.action === "down" && input.key === "Backspace") t.typed = t.typed.slice(0, -1);
      else if (input.action === "down" && input.text) t.typed += input.text;
      break;
    case "text":
      t.typed += input.text;
      break;
    case "resize":
      // Only the Responsive owner's stage counts; anyone else's pane leaves the tab alone.
      if (!t.size.responsive || t.owner !== ws) break;
      t.size = { ...t.size, width: side(input.width), height: side(input.height) };
      emitState(sessionId);
      break;
    case "device":
      // Resets to the mode's preset, switches Responsive off and reloads, even for the same mode.
      t.size = { device: input.device, ...(input.device === "mobile" ? BROWSER_MOBILE : BROWSER_DESKTOP), responsive: false };
      t.owner = undefined;
      t.loading = true;
      emitState(sessionId);
      setTimeout(() => {
        t.loading = false;
        emitState(sessionId);
      }, 400);
      break;
    case "size":
      t.size = { ...t.size, width: side(input.width), height: side(input.height), responsive: false };
      t.owner = undefined;
      emitState(sessionId);
      break;
    case "responsive":
      if (input.on) {
        t.owner = ws;
        t.size = { ...t.size, responsive: true, ...(input.width && input.height && { width: side(input.width), height: side(input.height) }) };
      } else {
        t.owner = undefined;
        t.size = { ...t.size, responsive: false };
      }
      emitState(sessionId);
      break;
    case "navigate":
      navigate(sessionId, t.id, input.url);
      break;
    case "back":
    case "forward": {
      const next = t.index + (input.type === "back" ? -1 : 1);
      if (next >= 0 && next < t.history.length) {
        t.index = next;
        t.url = t.history[next]!;
        t.title = titleOf(t.url);
        emitState(sessionId);
      }
      break;
    }
    case "reload": {
      t.loading = true;
      emitState(sessionId);
      setTimeout(() => {
        t.loading = false;
        emitState(sessionId);
      }, 400);
      break;
    }
    case "newTab": {
      // Opens the tab and moves this socket to it; the others just see the longer list.
      const added = addTab(b, input.url ?? "about:blank");
      if (input.url) navigate(sessionId, added.id, input.url);
      ws.data.subs.set(sessionId, added.id);
      emitState(sessionId);
      break;
    }
    case "closeTab": {
      b.tabs.delete(t.id);
      if (!b.tabs.size) addTab(b, "about:blank");
      // Sockets watching the closed tab move to the lowest open one, with its last frame.
      for (const other of sockets) {
        if (other.data.subs.get(sessionId) === t.id) watch(other, sessionId);
      }
      emitState(sessionId);
      break;
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 1 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A fake app screenshot (header bar, sidebar, card columns) stored as an attachment. */
function mockScreenshot(name: string, w: number, h: number, hue: number, dark: boolean): Attachment {
  const id = newId("att");
  let png: Uint8Array | undefined;
  attachmentFiles.set(id, { mimeType: "image/png", bytes: () => (png ??= renderScreenshot(w, h, hue, dark)) });
  return specMedia({ id, path: `/tmp/harness-mock/attachments/${id}.png`, name, source: "spec", kind: "image", mimeType: "image/png", size: w * h, width: w, height: h });
}

function renderScreenshot(w: number, h: number, hue: number, dark: boolean): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  const rect = (x0: number, y0: number, rw: number, rh: number, [r, g, b]: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) px.set([r, g, b], (y * w + x) * 3);
    }
  };
  const bg: [number, number, number] = dark ? [28, 29, 34] : [246, 246, 248];
  const card: [number, number, number] = dark ? [44, 46, 54] : [255, 255, 255];
  rect(0, 0, w, h, bg);
  rect(0, 0, w, 56, hsl(hue, 0.55, dark ? 0.35 : 0.5));
  const side = w > 600 ? 220 : 0;
  if (side) rect(0, 56, side, h - 56, dark ? [36, 37, 43] : [236, 236, 240]);
  const cols = Math.max(1, Math.floor((w - side - 24) / 240));
  const colW = Math.floor((w - side - 24) / cols) - 16;
  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < 5 - (c % 3); i++) rect(side + 24 + c * (colW + 16), 88 + i * 110, colW, 94, card);
  }
  return encodePng(w, h, px);
}

/** MOCK_VIDEO=/path/to/clip.mp4 adds that clip as a video attachment; without it, nothing. */
function mockVideo(name: string): Attachment[] {
  const path = process.env.MOCK_VIDEO;
  if (!path) return [];
  const bytes = new Uint8Array(readFileSync(path));
  const id = newId("att");
  attachmentFiles.set(id, { mimeType: "video/mp4", bytes: () => bytes });
  return [specMedia({ id, path, name, source: "spec", kind: "video", mimeType: "video/mp4", size: bytes.length })];
}

function renderFrame(sessionId: string, tabId: number, tick: number): { data: string; width: number; height: number } {
  const s = tabOf(sessionId, tabId);
  const { width: w, height: h } = s.size;
  const px = new Uint8Array(w * h * 3);
  const rect = (x0: number, y0: number, rw: number, rh: number, r: number, g: number, b: number) => {
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(w, Math.floor(x0 + rw));
    const yb = Math.min(h, Math.floor(y0 + rh));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = (y * w + x) * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
    }
  };
  rect(0, 0, w, h, 250, 250, 252);
  // Header bar with slowly shifting hue so frames are visibly live (each tab starts elsewhere on the wheel)
  const hue = (tick * 8 + (s.id - 1) * 110) % 360;
  const [hr, hg, hb] = hsl(hue, 0.55, 0.5);
  rect(0, 0, w, 64, hr, hg, hb);
  rect(24, 20, 160, 24, 255, 255, 255);
  // The tab's id as that many white pips, so tabs are told apart at a glance
  for (let i = 0; i < Math.min(s.id, 20); i++) rect(200 + i * 18, 26, 12, 12, 255, 255, 255);
  // Content blocks, offset by scroll
  const off = -(s.scroll % 2000);
  for (let i = 0; i < 12; i++) {
    const y = 100 + i * 150 + off;
    rect(48, y, Math.min(w - 96, 720), 22, 30, 30, 40);
    rect(48, y + 36, Math.min(w - 96, 900), 12, 200, 200, 210);
    rect(48, y + 56, Math.min(w - 96, 820), 12, 200, 200, 210);
    rect(48, y + 76, Math.min(w - 96, 600), 12, 200, 200, 210);
  }
  // Typed text indicator: one block per typed char
  for (let i = 0; i < Math.min(s.typed.length, 60); i++) rect(w - 40 - (Math.min(s.typed.length, 60) - i) * 12, 26, 9, 12, 255, 255, 255);
  // Click markers
  for (const c of s.clicks) rect(c.x - 6, c.y - 6, 12, 12, 230, 60, 60);
  // Crosshair at mouse
  if (s.mouseX >= 0) {
    rect(s.mouseX - 12, s.mouseY - 1, 24, 2, 20, 120, 255);
    rect(s.mouseX - 1, s.mouseY - 12, 2, 24, 20, 120, 255);
  }
  return { data: Buffer.from(encodePng(w, h, px)).toString("base64"), width: w, height: h };
}

function hsl(hDeg: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hDeg / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

let frameTick = 0;
setInterval(() => {
  frameTick++;
  // One render per watched tab, sent to the sockets on that tab.
  const watched = new Map<string, ServerWebSocket<WsData>[]>();
  for (const ws of sockets) {
    for (const [id, tabId] of ws.data.subs) {
      const key = `${id}\0${tabId}`;
      watched.set(key, [...(watched.get(key) ?? []), ws]);
    }
  }
  const sessionsWatched = new Set<string>();
  for (const [key, viewers] of watched) {
    const [id, tab] = key.split("\0") as [string, string];
    const tabId = Number(tab);
    const f = renderFrame(id, tabId, frameTick);
    for (const ws of viewers) sendEvent(ws, { kind: "browser.frame", sessionId: id, tabId, ...f });
    sessionsWatched.add(id);
  }
  if (frameTick % 4 === 0) for (const id of sessionsWatched) emitState(id);
}, 500);

// ---------------------------------------------------------------------------
// Live activity loop
// ---------------------------------------------------------------------------

const LIVE_TICKET = byKey("NYTIMES-1")!;
const LIVE_RUN = [...runs.values()].find((r) => r.sessionId === LIVE_TICKET.sessionId)!;

// The live ticket's Agents & tasks tab: two sub-agents (one nested, each on its own model) and a
// background task.
{
  const at = now() - 6 * 60_000;
  const agent = (id: string, over: Partial<Subagent>): Subagent => ({
    id,
    sessionId: LIVE_TICKET.sessionId,
    runId: LIVE_RUN.id,
    parentId: null,
    description: "",
    agentType: "general-purpose",
    prompt: "",
    status: "running",
    result: null,
    startedAt: at,
    endedAt: null,
    updatedAt: at,
    kind: "agent",
    ...over,
  });
  subagents.set(LIVE_TICKET.sessionId, [
    agent("toolu_mock_explore", {
      description: "Find where the article cache is keyed",
      agentType: "Explore",
      model: "claude-haiku-4-5-20251001",
      prompt: "Find every place src/ reads or writes the article cache, with file paths and line numbers.",
      status: "succeeded",
      result: "The cache is keyed by slug in src/hooks/useArticle.ts:41 and invalidated in src/store/articles.ts:88.",
      endedAt: at + 48_000,
      updatedAt: at + 48_000,
    }),
    agent("toolu_mock_review", {
      description: "Review the cache key change",
      model: "claude-opus-5-5",
      prompt: "Review the diff that keys the article cache by id for correctness bugs.",
      startedAt: at + 120_000,
      updatedAt: at + 200_000,
    }),
    agent("toolu_mock_tests", {
      parentId: "toolu_mock_review",
      description: "Check the hooks tests",
      agentType: "Explore",
      model: "claude-sonnet-5-5",
      prompt: "List the tests that exercise useArticle.",
      startedAt: at + 150_000,
      updatedAt: at + 150_000,
    }),
    agent("toolu_mock_bash", { kind: "bash", agentType: null, description: "Run the test suite", command: "bun test src/hooks", startedAt: at + 90_000, updatedAt: at + 90_000, hasOutput: false }),
  ]);
  const list = transcripts.get(LIVE_TICKET.sessionId)!;
  let seq = Math.max(0, ...list.map((e) => e.seq));
  const said = (subagentId: string, text: string) =>
    list.push({ id: newId("te"), sessionId: LIVE_TICKET.sessionId, runId: LIVE_RUN.id, subagentId, seq: ++seq, role: "assistant", content: { type: "text", text }, createdAt: at + seq * 1000 });
  said("toolu_mock_review", "Reading the diff in src/hooks/useArticle.ts first.");
  said("toolu_mock_review", "The id key looks right; checking the tests that cover a slug rename next.");
}
const LIVE_TEXT =
  "Looking at the failing test in src/hooks/useArticle.test.ts, the assertion expects the renamed article to resolve through its id, but the cache map is still keyed by the old slug. I'll change the key to article.id, invalidate on slug updates, and rerun the suite to confirm nothing else depends on the slug-based lookup.";

async function liveLoop() {
  const words = LIVE_TEXT.split(" ");
  let cycle = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (true) {
    const t = tickets.get(LIVE_TICKET.id);
    if (!t) return;
    cycle++;
    const count = Math.min(words.length, 40);
    let streamed = "";
    for (let i = 0; i < count; i++) {
      const piece = (i === 0 ? "" : " ") + words[i];
      streamed += piece;
      broadcast({ kind: "transcript.delta", sessionId: t.sessionId, runId: LIVE_RUN.id, text: piece });
      await sleep(80);
    }
    appendEntry(t.sessionId, LIVE_RUN.id, "assistant", { type: "text", text: streamed });
    await sleep(2000);
    const callId = `live_${cycle}`;
    appendEntry(t.sessionId, LIVE_RUN.id, "assistant", { type: "tool_call", callId, name: "Bash", input: { command: "bun test src/hooks/useArticle.test.ts" } });
    await sleep(700);
    appendEntry(t.sessionId, LIVE_RUN.id, "tool", {
      type: "tool_result",
      callId,
      name: "Bash",
      output: [{ type: "text", text: `bun test v1.2.23\n\n src/hooks/useArticle.test.ts:\n✓ resolves renamed articles by id [3.10ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [${40 + cycle}ms]` }],
      isError: false,
    });
    if (cycle % 2 === 0) addActivity(t.sessionId, t.id, "note", "agent", `Cycle ${cycle}: switched the cache key to \`article.id\`.\n\n- regression test passes\n- next: check the RSS feed builder for the same bug`);
    await sleep(2000);
  }
}

if (!QUIET) {
  void liveLoop();
  setInterval(() => {
    const t = byKey("NYTIMES-2");
    if (!t) return;
    t.busy = !t.busy;
    upsertTicket(t);
  }, 15_000);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return ok({ ok: true, version: "mock", pid: process.pid, ...serviceCode() });
    if (url.pathname === "/ws") {
      if (url.searchParams.get("token") !== TOKEN) return fail(401, "Unauthorized");
      if (srv.upgrade(req, { data: { subs: new Map<string, number>() } })) return undefined as unknown as Response;
      return fail(400, "Expected a WebSocket upgrade");
    }
    // Like the service: attachments also take ?token=, since <img>/<video> can't send headers.
    const att = url.pathname.match(/^\/attachments\/([^/]+)$/);
    if (att && req.method === "GET") {
      if (url.searchParams.get("token") !== TOKEN && req.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(401, "Unauthorized");
      const file = attachmentFiles.get(decodeURIComponent(att[1]!));
      if (!file) return fail(404, "No such attachment");
      return new Response(Buffer.from(file.bytes()), { headers: { ...CORS, "content-type": file.mimeType, "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(401, "Unauthorized");
    try {
      return await route(req, url);
    } catch (e) {
      if (e instanceof HttpError) return e.data === undefined ? fail(e.status, e.message) : Response.json({ error: e.message, data: e.data }, { status: e.status, headers: CORS });
      console.error(e);
      return fail(500, e instanceof Error ? e.message : String(e));
    }
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      sendMsg(ws, { type: "welcome", version: "mock" });
    },
    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        sendMsg(ws, { type: "error", message: "Invalid JSON" });
        return;
      }
      switch (msg.type) {
        case "ping":
          sendMsg(ws, { type: "pong" });
          break;
        case "hello":
          break;
        case "browser.subscribe":
          watch(ws, msg.sessionId, msg.tabId);
          break;
        case "browser.unsubscribe":
          ws.data.subs.delete(msg.sessionId);
          emitState(msg.sessionId);
          break;
        case "browser.input":
          handleInput(ws, msg.sessionId, msg.tabId, msg.input);
          break;
      }
    },
    close(ws) {
      sockets.delete(ws);
      for (const sessionId of ws.data.subs.keys()) emitState(sessionId);
    },
  },
});

console.log(`mock harness service on http://127.0.0.1:${server.port} (token: ${TOKEN})${QUIET ? " [quiet]" : ""}`);
console.log(`live stream: ${LIVE_TICKET.key} session ${LIVE_TICKET.sessionId}`);
