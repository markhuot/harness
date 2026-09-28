// Mock harness service for UI development. Implements the REST routes in shared/src/client.ts
// with in-memory state, plus the WebSocket event stream, browser screencast and a fake live run.
//
//   bun app/scripts/mock-service.ts        (MOCK_PORT=7799 MOCK_TOKEN=mock-token MOCK_QUIET=1)
//   HARNESS_URL=http://127.0.0.1:7799 HARNESS_TOKEN=mock-token bun run --cwd app dev

import { deflateSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import type {
  BrowserInput,
  BrowserState,
  ClientMessage,
  DriverInfo,
  DriverModels,
  HarnessEvent,
  ListenMode,
  ListenSetting,
  Mapping,
  NetworkStatus,
  Project,
  PublicSettings,
  Run,
  RunKind,
  ServerMessage,
  Session,
  Summary,
  SummaryAuthor,
  Ticket,
  TicketDetail,
  TicketStatus,
  TranscriptContent,
  TranscriptEntry,
  TranscriptRole,
  Watcher,
} from "@harness/shared";
import { buildPairUrl, checkProjectKey, LISTEN_MODES } from "@harness/shared";

const PORT = Number(process.env.MOCK_PORT ?? 7799);
/** The bearer token; POST /token/rotate replaces it (the old one 401s from then on). */
let TOKEN = process.env.MOCK_TOKEN ?? "mock-token";
const QUIET = process.env.MOCK_QUIET === "1";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const projects = new Map<string, Project>();
const tickets = new Map<string, Ticket>(); // by id
/** Old ticket keys (from before a project rename) → ticket id, like the service's ticket_key_aliases */
const keyAliases = new Map<string, string>();
const sessions = new Map<string, Session>();
const runs = new Map<string, Run>();
const summaries: Summary[] = [];
const transcripts = new Map<string, TranscriptEntry[]>(); // by session id
const watchers = new Map<string, Watcher>();
const mappings = new Map<string, Mapping>();
const browserStates = new Map<string, BrowserState>();
let triageSeq = 0;
let idSeq = 0;

let settings: PublicSettings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: {},
  reviewModels: {},
  anthropicApiKeySet: false,
  listen: { mode: "localhost" },
};

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
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Direct Messages API with an API key",
    available: true,
    authenticated: false,
    detail: "No API key configured",
    supportsLogin: false,
  },
  {
    id: "dummy",
    name: "Dummy",
    description: "Deterministic scripted driver for testing",
    available: true,
    authenticated: true,
    detail: "Always ready",
    supportsLogin: false,
  },
];

const now = () => Date.now();
const newId = (prefix: string) => `${prefix}_${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// WebSocket fan-out
// ---------------------------------------------------------------------------

interface WsData {
  subs: Set<string>;
}
const sockets = new Set<ServerWebSocket<WsData>>();

function sendMsg(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

function broadcast(event: HarnessEvent) {
  const isBrowser = event.kind === "browser.frame" || event.kind === "browser.state";
  const payload = JSON.stringify({ type: "event", event } satisfies ServerMessage);
  for (const ws of sockets) {
    if (isBrowser && !ws.data.subs.has(event.sessionId)) continue;
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

function addSummary(sessionId: string, ticketId: string | null, author: SummaryAuthor, body: string) {
  const summary: Summary = { id: newId("sum"), sessionId, ticketId, author, body, createdAt: now() };
  summaries.push(summary);
  broadcast({ kind: "summary.added", summary });
  return summary;
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

function seedProject(key: string, name: string, path: string, requireHumanReview = true): Project {
  const p: Project = {
    id: newId("proj"),
    key,
    name,
    path,
    nextSeq: 1,
    defaultDriver: null,
    defaultModels: {},
    useWorktrees: true,
    requireHumanReview,
    autoComplete: true,
    permissionMode: null,
    createdAt: now() - 86400_000 * 7,
    updatedAt: now() - 86400_000 * 7,
  };
  projects.set(p.id, p);
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
  model?: string | null;
  key?: string;
  title: string;
  description: string;
  status: TicketStatus;
  driver: string;
  kind?: Ticket["kind"];
  parentKey?: string;
  dependsOn?: string[];
  busy?: boolean;
  agentReview?: Ticket["agentReview"];
  humanReview?: Ticket["humanReview"];
  blockedReason?: string;
  pendingApproval?: Ticket["pendingApproval"];
  allowedTools?: string[];
  permissionMode?: Ticket["permissionMode"];
  externalRef?: Ticket["externalRef"];
  autoStart?: boolean;
  summaries?: [SummaryAuthor, string][];
  ageMin: number;
}

const byKey = (key: string) => [...tickets.values()].find((t) => t.key === key);

function seedTicket(s: SeedTicket): Ticket {
  const createdAt = now() - s.ageMin * 60_000;
  const key = s.key ?? `${s.project.key}-${s.project.nextSeq++}`;
  const id = newId("tkt");
  const session = makeSession(key, "ticket", id, s.driver, s.project.path, s.title, createdAt);
  const worktree = s.status !== "planning" && s.project.useWorktrees;
  const t: Ticket = {
    id,
    key,
    projectId: s.project.id,
    kind: s.kind ?? "task",
    title: s.title,
    description: s.description,
    status: s.status,
    sessionId: session.id,
    driver: s.driver,
    parentId: s.parentKey ? (byKey(s.parentKey)?.id ?? null) : null,
    dependsOn: s.dependsOn ?? [],
    autoStart: s.autoStart ?? !!s.parentKey,
    agentReview: s.agentReview ?? "pending",
    humanReview: s.humanReview ?? "pending",
    externalRef: s.externalRef ?? null,
    workdir: worktree ? `/Users/markhuot/.harness/worktrees/${key}` : s.project.path,
    branch: worktree ? `harness/${key.toLowerCase()}` : null,
    blockedReason: s.blockedReason ?? null,
    permissionMode: s.permissionMode ?? null,
    busy: s.busy ?? false,
    pendingApproval: s.pendingApproval ?? null,
    allowedTools: s.allowedTools ?? [],
    model: s.model ?? null,
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
    prompt: s.description,
    error: s.status === "blocked" ? s.blockedReason ?? null : null,
    createdAt,
    startedAt: createdAt,
    endedAt: t.busy ? null : createdAt + 5 * 60_000,
  });
  let seq = 0;
  let at = createdAt;
  const push = (role: TranscriptRole, content: TranscriptContent) => {
    at += 7_000;
    list.push({ id: newId("te"), sessionId: session.id, runId, seq: ++seq, role, content, createdAt: at });
  };
  push("user", { type: "text", text: s.description });
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

  // Like the service's block tool: the question lands on the Summary tab (the detail view has no callout).
  const seeded: [SummaryAuthor, string][] = [...(s.summaries ?? [])];
  if (s.status === "blocked" && s.blockedReason && !s.pendingApproval) seeded.push(["agent", `Blocked: ${s.blockedReason}`]);
  for (const [i, [author, body]] of seeded.entries()) {
    summaries.push({ id: newId("sum"), sessionId: session.id, ticketId: t.id, author, body, createdAt: createdAt + (i + 1) * 3 * 60_000 });
  }
  return t;
}

function seed() {
  const ny = seedProject("NYTIMES", "nytimes", "/Users/markhuot/Sites/nytimes");
  const hx = seedProject("HARNESS", "harness", "/Users/markhuot/Sites/harness", false);

  seedTicket({
    project: ny,
    title: "Fix stale article cache on slug change",
    description: "Articles show stale content after an editor renames the slug. Investigate the `useArticle` hook cache and fix it.",
    status: "in_progress",
    driver: "claude-code",
    model: "sonnet",
    busy: true,
    ageMin: 42,
    summaries: [
      ["agent", "Reproduced the bug locally. The cache is keyed by `slug`, so a rename orphans the old entry.\n\nNext:\n- switch the key to `article.id`\n- add a regression test"],
    ],
  }); // NYTIMES-1 (live stream)
  seedTicket({
    project: ny,
    title: "Add dark mode to the crossword player",
    description: "Support prefers-color-scheme in the crossword player. Keep contrast AA for filled squares.",
    status: "planning",
    driver: "claude-code",
    ageMin: 300,
    summaries: [["agent", "Drafted a plan:\n\n1. Introduce CSS variables for the grid palette\n2. Map them under `@media (prefers-color-scheme: dark)`\n3. Snapshot test both themes"]],
  }); // NYTIMES-2
  seedTicket({
    project: ny,
    title: "Migrate newsletter signup to the new API",
    description: "Move the newsletter form from the legacy /subscribe endpoint to the v2 subscriptions API.",
    status: "blocked",
    driver: "anthropic-api",
    blockedReason: "The v2 API requires an OAuth client id for the signup form. Which environment's client id should I use — staging or production?",
    ageMin: 180,
    summaries: [["agent", "Ported the form and validation. Blocked on credentials for the v2 API; see the question."]],
  }); // NYTIMES-3
  seedTicket({
    project: hx,
    key: "HARNESS-9",
    title: "Install Playwright and add a smoke test",
    description: "Add a Playwright smoke test that loads the board and checks five columns render.",
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
    summaries: [["agent", "Scaffolded `tests/smoke.spec.ts`. Needs Playwright installed to run it."]],
  }); // HARNESS-9
  seedTicket({
    project: hx,
    key: "HARNESS-20",
    title: "Watch acme/site issues",
    description: "Add a watcher for the GitHub repository acme/site that files issues into this project.",
    status: "blocked",
    driver: "claude-code",
    blockedReason: 'Permission needed: create_watcher — Create watcher "github" (every 300s)',
    pendingApproval: {
      id: "appr_cfg",
      runId: "run_appr_cfg",
      toolName: "mcp__harness__create_watcher",
      input: {
        name: "github",
        command: "/bin/zsh",
        args: ["-lc", "gh issue list --repo acme/site --state open --json number,title,url,updatedAt --jq '.[] | {key: \"SITE-\\(.number)\", title, url, updated: .updatedAt} | tojson'"],
        mode: "interval",
        interval_sec: 300,
      },
      requestedAt: now() - 30_000,
      reason: "A watcher's command runs on this Mac as you, outside any ticket sandbox, every time the watcher fires.",
      source: "policy",
      summary: 'Create watcher "github" (every 300s)',
      onceOnly: true,
    },
    ageMin: 5,
    summaries: [["agent", "Checked `gh` is logged in. Asking to add the watcher, then a SITE → HARNESS mapping."]],
  }); // HARNESS-20
  seedTicket({
    project: ny,
    title: "Lazy-load below-the-fold images on section fronts",
    description: "Use native loading=lazy and add width/height to avoid CLS.",
    status: "review",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "pending",
    ageMin: 600,
    summaries: [
      ["agent", "Added `loading=\"lazy\"` to `SectionImage` and explicit dimensions.\n\n```tsx\n<img loading=\"lazy\" width={w} height={h} src={src} />\n```\n\nLighthouse CLS dropped from 0.14 to 0.02."],
      ["system", "Agent review approved: change is minimal and well tested."],
    ],
  }); // NYTIMES-4
  seedTicket({
    project: ny,
    title: "Upgrade Next.js to 15 and fix type errors",
    description: "Bump next and react, fix the resulting type errors.",
    status: "done",
    driver: "dummy",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 3000,
    summaries: [["agent", "Upgraded to Next 15. All `tsc` errors fixed; `bun test` green."], ["agent", "Completed. Merged `harness/nytimes-5` into `main`."]],
  }); // NYTIMES-5
  seedTicket({
    project: ny,
    title: "Paywall meter counts AMP pageviews twice",
    description: "Jira FOO-123: The meter increments twice on AMP article views.",
    key: "FOO-123",
    status: "in_progress",
    driver: "claude-code",
    externalRef: { source: "jira", key: "FOO-123", url: "https://happycog.atlassian.net/browse/FOO-123", raw: { key: "FOO-123", summary: "Paywall meter counts AMP pageviews twice" } },
    dependsOn: ["NYTIMES-5", "NYTIMES-3"],
    ageMin: 90,
    summaries: [["agent", "Dispatched from Jira. Waiting on the newsletter migration before touching the meter script."]],
  });

  // Conductor with seven children in HARNESS, across every column (Tickets tab, board rollup)
  seedTicket({
    project: hx,
    kind: "conductor",
    title: "Build the harness desktop app",
    description: "Coordinate the Electron app build.\n- Board view with drag and drop\n- Ticket detail with live transcript",
    status: "in_progress",
    driver: "claude-code",
    busy: true,
    ageMin: 120,
    summaries: [["agent", "Split the work into seven child tickets. The shell (HARNESS-5) goes first; the store, signing and settings build on it."]],
  }); // HARNESS-1
  seedTicket({
    project: hx,
    parentKey: "HARNESS-1",
    title: "Board view with drag and drop",
    description: "Five columns, cards update live.",
    status: "review",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 110,
    summaries: [["agent", "Board renders all five columns; drag and drop calls `updateTicket({ status })`."]],
  }); // HARNESS-2
  seedTicket({
    project: hx,
    parentKey: "HARNESS-1",
    title: "Ticket detail with live transcript",
    description: "Summaries, transcript and browser tabs.",
    status: "planning",
    driver: "dummy",
    dependsOn: ["HARNESS-2"],
    ageMin: 110,
  }); // HARNESS-3
  seedTicket({
    project: hx,
    title: "Write launchd install docs",
    description: "Document `harness service install` and log locations.",
    status: "done",
    driver: "dummy",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 2000,
    summaries: [["agent", "Docs written in `DESIGN.md` under Runtime paths."]],
  }); // HARNESS-4
  const child = (s: Omit<SeedTicket, "project" | "parentKey">) => seedTicket({ project: hx, parentKey: "HARNESS-1", ...s });
  child({
    key: "HARNESS-5",
    title: "Scaffold the Electron shell and preload bridge",
    description: "Main process, preload with a typed bridge, hidden-inset titlebar.",
    status: "done",
    driver: "claude-code",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 118,
    summaries: [["agent", "Shell boots with a typed `window.harness` bridge; window state persists across launches."]],
  });
  child({
    key: "HARNESS-6",
    title: "Wire the WebSocket store and reducer",
    description: "REST snapshot + live events into one normalized store.",
    status: "in_progress",
    driver: "anthropic-api",
    busy: true,
    dependsOn: ["HARNESS-5"],
    ageMin: 100,
    summaries: [["agent", "Reducer handles every event kind; reconnect refetches the snapshot. Writing the dedupe tests now."]],
  });
  child({
    key: "HARNESS-7",
    title: "Sign and notarize the macOS build",
    description: "Developer ID signing + notarytool in the package script.",
    status: "blocked",
    driver: "claude-code",
    dependsOn: ["HARNESS-5"],
    blockedReason: "Which Apple Developer team should sign the build: Happy Cog or your personal account?",
    ageMin: 95,
    summaries: [["agent", "Packaging works unsigned. Need to know which team's certificate to use."]],
  });
  child({
    key: "HARNESS-8",
    title: "Add a Playwright e2e for the board",
    description: "Drive the built app and check drag and drop.",
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
    description: "Driver login state, watcher CRUD, key mappings.",
    status: "review",
    driver: "claude-code",
    dependsOn: ["HARNESS-5"],
    agentReview: "approved",
    humanReview: "pending",
    ageMin: 80,
    summaries: [["agent", "Settings has Drivers, Watchers and Mappings sections; each saves on blur."]],
  });
  hx.nextSeq = 11;

  // A project whose key was derived from a long folder name (Project settings → Identifier).
  const hh = seedProject("HELLOHARNESS", "hello-harness", "/Users/markhuot/Sites/hello-harness");
  for (const [title, status, ageMin] of [
    ["Scaffold the hello world page", "done", 3000],
    ["Add a greeting API route", "done", 2400],
    ["Localize the greeting", "planning", 30],
  ] as const) {
    seedTicket({ project: hh, title, description: title, status, driver: "claude-code", agentReview: status === "done" ? "approved" : "pending", humanReview: status === "done" ? "approved" : "pending", ageMin });
  }
  seedTicket({
    project: hh,
    key: "ACME-12",
    title: "Greeting typo on the landing page",
    description: "Reported in Jira.",
    status: "planning",
    driver: "claude-code",
    externalRef: { source: "jira", key: "ACME-12", url: "https://example.atlassian.net/browse/ACME-12", raw: {} },
    ageMin: 20,
  });

  // A long-lived project with a deep Done column (paging, search): 130 done tickets, completed
  // over the last ~65 minutes (so they fill the first Done pages, newest first), renumbered from
  // an old WWW key (WWW-n → SITE-n resolve as aliases).
  const site = seedProject("SITE", "marketing-site", "/Users/markhuot/Sites/marketing-site");
  const verbs = ["Fix", "Refactor", "Polish", "Document", "Speed up", "Test", "Localize", "Harden"];
  const nouns = ["hero banner", "pricing table", "footer links", "blog index", "contact form", "sitemap", "RSS feed", "404 page", "cookie notice", "search page", "case studies grid", "team page", "careers list"];
  for (let i = 1; i <= 130; i++) {
    const title = i === 42 ? "Retire the legacy jQuery carousel" : `${verbs[i % verbs.length]} the ${nouns[i % nouns.length]} (#${i})`;
    const t = seedTicket({
      project: site,
      key: `SITE-${i}`,
      title,
      description: i === 42 ? "Swap the carousel for a CSS scroll-snap strip; drop jquery.slick." : `Routine maintenance ${i}.`,
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

  // Triage sessions
  const t1 = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, "claude-code", ny.path, "Paywall meter counts AMP pageviews twice", now() - 95 * 60_000);
  t1.triageStatus = "dispatched";
  t1.outcome = "Dispatched to NYTIMES as FOO-123 (started).";
  transcripts.get(t1.id)!.push(
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 1, role: "user", content: { type: "text", text: "New work item from jira: FOO-123 Paywall meter counts AMP pageviews twice\nSuggested project: NYTIMES" }, createdAt: t1.createdAt },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 2, role: "assistant", content: { type: "tool_call", callId: "c1", name: "dispatch_ticket", input: { project_key: "NYTIMES", key: "FOO-123", title: "Paywall meter counts AMP pageviews twice", start: true } }, createdAt: t1.createdAt + 5000 },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 3, role: "tool", content: { type: "tool_result", callId: "c1", name: "dispatch_ticket", output: [{ type: "text", text: "Created FOO-123" }], isError: false }, createdAt: t1.createdAt + 6000 },
    { id: newId("te"), sessionId: t1.id, runId: null, seq: 4, role: "system", content: { type: "status", text: "Dispatched to NYTIMES" }, createdAt: t1.createdAt + 7000 },
  );
  const t2 = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, "claude-code", ny.path, "Recipe card print styles broken in Safari", now() - 2 * 60_000);
  t2.triageStatus = "triaging";
  t2.busy = true;
  transcripts.get(t2.id)!.push({ id: newId("te"), sessionId: t2.id, runId: null, seq: 1, role: "user", content: { type: "text", text: "New work item from jira: FOO-131 Recipe card print styles broken in Safari" }, createdAt: t2.createdAt });

  const w: Watcher = {
    id: newId("w"),
    name: "jira",
    command: "node",
    args: ["/Users/markhuot/Sites/Jira/watch-jira.js"],
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
  };
  watchers.set(w.id, w);
  const m: Mapping = { id: newId("map"), pattern: "FOO", projectId: ny.id, notes: "Client Jira project → nytimes repo", createdAt: now() - 86400_000 };
  mappings.set(m.id, m);
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
  constructor(public status: number, message: string) {
    super(message);
  }
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
  if (t.title.toLowerCase().includes(needle)) return 1;
  const latest = summaries.filter((s) => s.ticketId === t.id).at(-1)?.body ?? "";
  if (t.description.toLowerCase().includes(needle) || latest.toLowerCase().includes(needle)) return 2;
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

/** Same rules as the service: native OLD-n → NEW-n, external mirrors keep their keys. */
function renameProjectKey(p: Project, key: string) {
  const other = [...projects.values()].find((o) => o.id !== p.id && o.key === key);
  if (other) throw new HttpError(409, `Project key ${key} is already used by ${other.name}`);
  const prefix = `${p.key}-`;
  const native = [...tickets.values()].filter((t) => t.projectId === p.id && !t.externalRef && t.key.startsWith(prefix) && /^\d+$/.test(t.key.slice(prefix.length)));
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
    summaries: summaries.filter((s) => s.ticketId === t.id),
    runs: [...runs.values()].filter((r) => r.sessionId === t.sessionId),
    dependents: [...tickets.values()].filter((o) => o.dependsOn.includes(t.key)).map((o) => o.key),
    children: [...tickets.values()].filter((o) => o.parentId === t.id),
  };
}

function setStatus(t: Ticket, status: TicketStatus) {
  if (t.status === status) return;
  t.status = status;
  t.completedAt = status === "done" ? now() : null;
  appendEntry(t.sessionId, null, "system", { type: "status", text: `Moved to ${status.replace("_", " ")}` });
}

function submitForReview(t: Ticket) {
  setStatus(t, "review");
  t.agentReview = "pending";
  const project = projects.get(t.projectId);
  t.humanReview = project?.requireHumanReview === false ? "approved" : "pending";
  addSummary(t.sessionId, t.id, "agent", `Work finished for **${t.title}**. Ready for review.`);
  upsertTicket(t);
  simulateRun(t, "review", "Review the change.", "The change looks correct and is covered by tests. Approving.", (cur) => {
    cur.agentReview = "approved";
    queueMicrotask(() => noteReady(cur));
  });
}

/** Mirrors Orchestrator.noteReady: both reviews approved + project autoComplete → complete run. */
function noteReady(t: Ticket) {
  if (t.status !== "review" || t.agentReview !== "approved" || t.humanReview !== "approved") return;
  if (!projects.get(t.projectId)?.autoComplete || t.parentId) return;
  completeRun(t);
}

function completeRun(t: Ticket, instructions = "") {
  simulateRun(t, "complete", `Finalize: merge the worktree branch. ${instructions}`, "Merged the branch and cleaned up the worktree.", (cur) => {
    addSummary(cur.sessionId, cur.id, "agent", "Completed.");
    setStatus(cur, "done");
  });
}

function workRun(t: Ticket, prompt: string) {
  appendEntry(t.sessionId, null, "user", { type: "text", text: prompt });
  simulateRun(t, "work", prompt, `Hello from the mock driver! You said: "${prompt}"`, (cur) => {
    if (cur.status === "in_progress") submitForReview(cur);
  });
}

function createTicket(body: Record<string, any>): Ticket {
  const project = projects.get(body.projectId);
  if (!project) throw new HttpError(400, "Unknown projectId");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "prompt is required");
  const key: string = body.key ?? `${project.key}-${project.nextSeq++}`;
  if (byKey(key)) throw new HttpError(409, `Ticket ${key} already exists`);
  broadcast({ kind: "project.upserted", project });
  const id = newId("tkt");
  const driver = body.driver ?? project.defaultDriver ?? settings.defaultDriver;
  const title: string = body.title ?? body.prompt.split("\n")[0]!.slice(0, 80);
  const session = makeSession(key, "ticket", id, driver, project.path, title, now());
  const start = body.start ?? true;
  const t: Ticket = {
    id,
    key,
    projectId: project.id,
    kind: body.kind ?? "task",
    title,
    description: body.prompt,
    status: start ? "in_progress" : "planning",
    sessionId: session.id,
    driver,
    parentId: body.parentId ?? null,
    dependsOn: body.dependsOn ?? [],
    autoStart: body.autoStart ?? false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: body.externalRef ?? null,
    workdir: start && project.useWorktrees ? `/Users/markhuot/.harness/worktrees/${key}` : project.path,
    branch: start && project.useWorktrees ? `harness/${key.toLowerCase()}` : null,
    blockedReason: null,
    permissionMode: body.permissionMode ?? null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    model: typeof body.model === "string" && body.model ? body.model : null,
    position: tickets.size,
    createdAt: now(),
    updatedAt: now(),
  };
  tickets.set(t.id, t);
  broadcast({ kind: "session.upserted", session });
  upsertTicket(t);
  appendEntry(t.sessionId, null, "user", { type: "text", text: body.prompt });
  if (start) {
    simulateRun(t, t.kind === "conductor" ? "conductor" : "work", body.prompt, `Hello from the mock driver! You said: "${body.prompt}"`, (cur) => {
      if (cur.status === "in_progress") submitForReview(cur);
    }, 4000);
  } else {
    simulateRun(t, "plan", body.prompt, `Here's a plan for: ${title}\n\n1. Investigate\n2. Implement\n3. Test`, (cur) => {
      addSummary(cur.sessionId, cur.id, "agent", `Drafted a plan:\n\n1. Investigate\n2. Implement\n3. Test`);
    });
  }
  return t;
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
        requireHumanReview: body.requireHumanReview ?? true,
        autoComplete: body.autoComplete ?? true,
        permissionMode: body.permissionMode ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      projects.set(p.id, p);
      broadcast({ kind: "project.upserted", project: p });
      return ok(p, 201);
    }
    const p = b ? projects.get(b) : undefined;
    if (!p) throw new HttpError(404, "Project not found");
    if (method === "PATCH") {
      const { key: rawKey, nextSeq: _n, ...body } = await readBody(req);
      if (rawKey !== undefined) {
        const { key, error } = checkProjectKey(String(rawKey));
        if (error) throw new HttpError(400, `Invalid project key "${key}": ${error}`);
        if (key !== p.key) renameProjectKey(p, key); // throws 409 on collisions
      }
      if (body.defaultModels !== undefined) body.defaultModels = mergeModels(p.defaultModels, body.defaultModels);
      Object.assign(p, body, { id: p.id, key: p.key, updatedAt: now() });
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
    const statuses = url.searchParams.get("status")?.split(",").filter(Boolean) ?? [];
    const inProject = (t: Ticket) => !pid || t.projectId === pid;
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
    if (!found) throw new HttpError(404, `Ticket ${b} not found`);
    const t = found.ticket;
    if (!c) {
      if (method === "GET") return ok(ticketDetail(t, found.alias));
      if (method === "PATCH") {
        const body = await readBody(req);
        if (body.driver !== undefined && body.driver !== t.driver && body.model === undefined) t.model = null;
        for (const k of ["title", "description", "driver", "dependsOn", "position"] as const) {
          if (body[k] !== undefined) (t as any)[k] = body[k];
        }
        if (body.model !== undefined) t.model = body.model || null;
        if (body.permissionMode !== undefined) t.permissionMode = body.permissionMode || null;
        if (body.status && body.status !== t.status) {
          const to = body.status as TicketStatus;
          if (to === "in_progress" && t.status === "planning") {
            setStatus(t, "in_progress");
            workRun(t, "The plan is approved. Begin work.");
          } else {
            setStatus(t, to);
            if (to !== "blocked") t.blockedReason = null;
          }
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
    if (method === "GET" && c === "summaries") return ok(summaries.filter((s) => s.ticketId === t.id));
    if (method === "POST") {
      const body = await readBody(req);
      switch (c) {
        case "start":
          setStatus(t, "in_progress");
          workRun(t, "The plan is approved. Begin work.");
          return ok(t);
        case "messages": {
          const text = String(body.text ?? "").trim();
          if (!text) throw new HttpError(400, "text is required");
          if (t.status === "planning") {
            appendEntry(t.sessionId, null, "user", { type: "text", text });
            simulateRun(t, "plan", text, `Updated the plan to account for: "${text}"`, () => {});
          } else {
            if (t.status === "done") {
              t.agentReview = "pending";
              t.humanReview = "pending";
            }
            if (t.status === "blocked" || t.status === "review" || t.status === "done") {
              setStatus(t, "in_progress");
              t.blockedReason = null;
            }
            workRun(t, text);
          }
          return ok(t);
        }
        case "review": {
          if (body.decision === "approve") {
            t.humanReview = "approved";
            addSummary(t.sessionId, t.id, "human", body.notes ? `Approved: ${body.notes}` : "Approved.");
            upsertTicket(t);
            noteReady(t);
          } else {
            t.agentReview = "pending";
            t.humanReview = "pending";
            setStatus(t, "in_progress");
            addSummary(t.sessionId, t.id, "human", `Changes requested: ${body.notes ?? ""}`);
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
          addSummary(t.sessionId, t.id, "human", `Re-opened: ${notes}`);
          workRun(t, notes);
          return ok(t);
        }
        case "complete":
          if (body.skipAgent) {
            setStatus(t, "done");
            upsertTicket(t);
          } else {
            completeRun(t, body.instructions ?? "");
          }
          return ok(t);
        case "cancel": {
          const r = activeRun(t.sessionId);
          if (r) finishRun(r, "cancelled");
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
          simulateRun(t, "review", "Review the change.", "Re-reviewed: still looks good. Approving.", (cur) => {
            cur.agentReview = "approved";
            queueMicrotask(() => noteReady(cur));
          });
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
    if (c === "transcript" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return ok((transcripts.get(s.id) ?? []).filter((e) => e.seq > after));
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
        cwd: body.cwd ?? null,
        env: body.env ?? {},
        mode: body.mode ?? "loop",
        intervalSec: body.intervalSec ?? 60,
        enabled: body.enabled ?? true,
        driver: body.driver ?? null,
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
      const item = body.item ?? {};
      const s = makeSession(`TRIAGE-${++triageSeq}`, "triage", null, settings.defaultDriver, "", String(item.summary ?? item.title ?? item.key ?? "Work item"), now());
      s.triageStatus = "triaging";
      s.busy = true;
      upsertSession(s);
      appendEntry(s.id, null, "user", { type: "text", text: `New work item from ${body.source}: ${JSON.stringify(item)}` });
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
      w.lastRunAt = now();
      w.updatedAt = now();
      broadcast({ kind: "watcher.upserted", watcher: w });
      return ok({ ok: true });
    }
    if (method === "PATCH") {
      Object.assign(w, await readBody(req), { id: w.id, updatedAt: now() });
      broadcast({ kind: "watcher.upserted", watcher: w });
      return ok(w);
    }
    if (method === "DELETE") {
      watchers.delete(w.id);
      broadcast({ kind: "watcher.deleted", id: w.id });
      return ok({ ok: true });
    }
  }

  // Mappings
  if (a === "mappings") {
    if (!b && method === "GET") return ok([...mappings.values()]);
    if (!b && method === "POST") {
      const body = await readBody(req);
      if (!body.pattern || !body.projectId) throw new HttpError(400, "pattern and projectId are required");
      const m: Mapping = { id: newId("map"), pattern: body.pattern, projectId: body.projectId, notes: body.notes ?? "", createdAt: now() };
      mappings.set(m.id, m);
      broadcast({ kind: "mapping.upserted", mapping: m });
      return ok(m, 201);
    }
    if (b && method === "DELETE") {
      if (!mappings.delete(b)) throw new HttpError(404, "Mapping not found");
      broadcast({ kind: "mapping.deleted", id: b });
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
      const { anthropicApiKey, defaultModels, reviewModels, listen, ...rest } = body;
      if (listen !== undefined) {
        settings.listen = applyListen(listen);
        networkError = null;
      }
      settings = { ...settings, ...rest, defaultModels: mergeModels(settings.defaultModels, defaultModels), reviewModels: mergeModels(settings.reviewModels, reviewModels) };
      if (anthropicApiKey !== undefined) {
        settings.anthropicApiKeySet = !!anthropicApiKey;
        const d = drivers.find((x) => x.id === "anthropic-api")!;
        d.authenticated = !!anthropicApiKey;
        d.detail = anthropicApiKey ? `Key ending …${String(anthropicApiKey).slice(-4)}` : "No API key configured";
      }
      broadcast({ kind: "settings.updated", settings });
      return ok(settings);
    }
  }

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
    if (!c && method === "GET") return ok(browserStates.get(b) ?? null);
    if (c === "navigate" && method === "POST") {
      const body = await readBody(req);
      const state = navigate(b, String(body.url ?? "about:blank"));
      return ok(state);
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Browser simulation (PNG frames; the app draws base64 via data URLs, which sniff content)
// ---------------------------------------------------------------------------

interface BrowserSim {
  width: number;
  height: number;
  mouseX: number;
  mouseY: number;
  clicks: { x: number; y: number }[];
  scroll: number;
  typed: string;
  history: string[];
  index: number;
}
const sims = new Map<string, BrowserSim>();

function sim(sessionId: string): BrowserSim {
  let s = sims.get(sessionId);
  if (!s) {
    s = { width: 1280, height: 800, mouseX: -1, mouseY: -1, clicks: [], scroll: 0, typed: "", history: ["http://localhost:3000/"], index: 0 };
    sims.set(sessionId, s);
    browserStates.set(sessionId, { sessionId, url: s.history[0]!, title: "Local dev server", loading: false });
  }
  return s;
}

function emitState(sessionId: string) {
  const st = browserStates.get(sessionId);
  if (st) broadcast({ kind: "browser.state", sessionId, state: st });
}

function navigate(sessionId: string, url: string): BrowserState {
  const s = sim(sessionId);
  s.history = s.history.slice(0, s.index + 1);
  s.history.push(url);
  s.index = s.history.length - 1;
  s.scroll = 0;
  s.clicks = [];
  const st: BrowserState = { sessionId, url, title: url.replace(/^https?:\/\//, ""), loading: true };
  browserStates.set(sessionId, st);
  emitState(sessionId);
  setTimeout(() => {
    st.loading = false;
    emitState(sessionId);
  }, 600);
  return st;
}

function handleInput(sessionId: string, input: BrowserInput) {
  const s = sim(sessionId);
  if (!(input.type === "mouse" && input.action === "move")) console.log(`[browser.input ${sessionId}]`, JSON.stringify(input));
  switch (input.type) {
    case "mouse":
      s.mouseX = input.x;
      s.mouseY = input.y;
      if (input.action === "down") s.clicks = [...s.clicks.slice(-9), { x: input.x, y: input.y }];
      if (input.action === "wheel") s.scroll = Math.max(0, s.scroll + (input.deltaY ?? 0));
      break;
    case "key":
      if (input.action === "down" && input.key === "Backspace") s.typed = s.typed.slice(0, -1);
      else if (input.action === "down" && input.text) s.typed += input.text;
      break;
    case "text":
      s.typed += input.text;
      break;
    case "resize":
      s.width = Math.max(100, Math.min(2560, Math.round(input.width)));
      s.height = Math.max(100, Math.min(1600, Math.round(input.height)));
      break;
    case "navigate":
      navigate(sessionId, input.url);
      break;
    case "back":
    case "forward": {
      const next = s.index + (input.type === "back" ? -1 : 1);
      if (next >= 0 && next < s.history.length) {
        s.index = next;
        const st = browserStates.get(sessionId)!;
        st.url = s.history[next]!;
        st.title = st.url.replace(/^https?:\/\//, "");
        emitState(sessionId);
      }
      break;
    }
    case "reload": {
      const st = browserStates.get(sessionId)!;
      st.loading = true;
      emitState(sessionId);
      setTimeout(() => {
        st.loading = false;
        emitState(sessionId);
      }, 400);
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

function renderFrame(sessionId: string, tick: number): { data: string; width: number; height: number } {
  const s = sim(sessionId);
  const { width: w, height: h } = s;
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
  // Header bar with slowly shifting hue so frames are visibly live
  const hue = (tick * 8) % 360;
  const [hr, hg, hb] = hsl(hue, 0.55, 0.5);
  rect(0, 0, w, 64, hr, hg, hb);
  rect(24, 20, 160, 24, 255, 255, 255);
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
  const subscribed = new Set<string>();
  for (const ws of sockets) for (const id of ws.data.subs) subscribed.add(id);
  for (const id of subscribed) {
    const f = renderFrame(id, frameTick);
    broadcast({ kind: "browser.frame", sessionId: id, ...f });
    if (frameTick % 4 === 0) emitState(id);
  }
}, 500);

// ---------------------------------------------------------------------------
// Live activity loop
// ---------------------------------------------------------------------------

const LIVE_TICKET = byKey("NYTIMES-1")!;
const LIVE_RUN = [...runs.values()].find((r) => r.sessionId === LIVE_TICKET.sessionId)!;
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
    if (cycle % 2 === 0) addSummary(t.sessionId, t.id, "agent", `Cycle ${cycle}: switched the cache key to \`article.id\`.\n\n- regression test passes\n- next: check the RSS feed builder for the same bug`);
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
    if (url.pathname === "/health") return ok({ ok: true, version: "mock", pid: process.pid });
    if (url.pathname === "/ws") {
      if (url.searchParams.get("token") !== TOKEN) return fail(401, "Unauthorized");
      if (srv.upgrade(req, { data: { subs: new Set<string>() } })) return undefined as unknown as Response;
      return fail(400, "Expected a WebSocket upgrade");
    }
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(401, "Unauthorized");
    try {
      return await route(req, url);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
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
          ws.data.subs.add(msg.sessionId);
          sim(msg.sessionId);
          emitState(msg.sessionId);
          break;
        case "browser.unsubscribe":
          ws.data.subs.delete(msg.sessionId);
          break;
        case "browser.input":
          handleInput(msg.sessionId, msg.input);
          break;
      }
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

console.log(`mock harness service on http://127.0.0.1:${server.port} (token: ${TOKEN})${QUIET ? " [quiet]" : ""}`);
console.log(`live stream: ${LIVE_TICKET.key} session ${LIVE_TICKET.sessionId}`);
