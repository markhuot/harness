// The seeded world the app's smoke and shoot scripts (and the other app checks that used to run
// against app/scripts/mock-service.ts) run in: the REAL daemon with the dummy driver, on a database
// seeded before it starts. Five projects (NYTIMES, HARNESS with a conductor and its children, the
// HELLOHARNESS rename case, SITE with a deep Done column, MH with linked remote IDs), a ticket in
// every state, spec history with media, approvals, context gauges, watchers and triage sessions.
//
// Rows are written with SQL, the way sim-check seeds its database, because a state like "blocked
// on a classifier's approval" or "completed 40 minutes ago" is what a run would have left behind,
// not something an API call can ask for. Run state the daemon would sweep at startup (a run going)
// goes in after it is up. `bun run --cwd app world` boots one for development.
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "@harness/shared/testing";
import { startDaemonProxy } from "@harness/shared/testing/proxy";
import { apiClient, repoRoot, startDaemon, type StartDaemonOptions, type TestDaemon } from "@harness/shared/testing/daemon";
import { GREETER_FILES, git, seedRepo, withDb } from "@harness/shared/testing/seed";
import { png } from "./png";

const now = () => Date.now();
const id = () => randomUUID();

export type WorldProject = { id: string; key: string; path: string };

export type World = Omit<TestDaemon, "base" | "api" | "stop"> & {
  stop(opts?: { termMs?: number }): Promise<void>;
  /**
   * Where clients (the app, the checks) connect: a proxy in front of the daemon that answers GET /usage
   * with a fixed report (the dummy driver has no plan usage, and Claude Code's reads the machine's own
   * login) and reports the messages clients send. Everything else is the daemon's.
   */
  base: string;
  /** The daemon itself, for a check that has to bypass the proxy. */
  daemonBase: string;
  /** An API client for `base`. */
  api: TestDaemon["api"];
  /** Stop the daemon but keep its home, for a restart test; the proxy stays up and the app sees the connection drop. */
  stopDaemon(): Promise<void>;
  /** Start the daemon again on the same home and port. */
  startDaemonAgain(): Promise<void>;
  /** The seeded database file (write to it only while the daemon is stopped). */
  readonly home: string;
  /** Replace the plan usage GET /usage answers with, and push it to connected clients as usage.updated. */
  setUsage(drivers: unknown[]): void;
  /** Call `fn` with every message a client socket sends (the browser input the app forwards). Returns a stop function. */
  onClientMessage(fn: (message: string) => void): () => void;
  /** Seeded projects by key. */
  projects: Record<"NYTIMES" | "HARNESS" | "HELLOHARNESS" | "SITE" | "MH", WorldProject>;
  /** The page NYTIMES-1's browser tabs show (a local server standing in for a dev server). */
  devUrl: string;
  /** Session id of a ticket by key, for transcript and browser routes. */
  sessionOf(key: string): string;
};

type Status = "planning" | "in_progress" | "blocked" | "review" | "done";
type Author = "agent" | "human" | "system";

interface SeedTicket {
  project: WorldProject;
  key?: string;
  title: string;
  spec: string;
  /** Later revisions: [author, note, body], each written a few minutes after the last. */
  revisions?: [Author, string, string][];
  status: Status;
  driver: string;
  kind?: "task" | "conductor";
  parentKey?: string;
  dependsOn?: string[];
  busy?: boolean;
  agentReview?: "pending" | "approved" | "skipped";
  humanReview?: "pending" | "approved";
  blockedReason?: string;
  resumeAt?: number;
  pendingApproval?: Record<string, unknown>;
  allowedTools?: string[];
  externalRef?: { source: string; key: string; url: string; raw: Record<string, unknown> };
  model?: string | null;
  context?: Record<string, unknown> | null;
  compacting?: boolean;
  messageDraft?: string;
  agentNotes?: string;
  completionAction?: string;
  pullRequests?: { url: string; title: string | null }[];
  completedAt?: number;
  /** Activity entries: [author, body, kind (default: a note from an agent, a message from a human)]. */
  activity?: [Author, string, string?][];
  ageMin: number;
}

const EVENTS_PROMPT = "If this event is assigned to me and has actionable next steps, dispatch it to an agent.";
const EVENTS_LOOP = "while true; do curl -s -H \"Authorization: Bearer $EVENTS_TOKEN\" 'https://api.example.com/events?since=1m'; sleep 60; done";
const EVENTS_SUMMARY = `Create watcher "events" (loop): ${EVENTS_LOOP}; prompt: "${EVENTS_PROMPT}"; env: EVENTS_TOKEN`;

/** Models the fake claude CLI lists (the real driver reads them from `claude`'s initialize response). */
const CLAUDE_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Most capable for ambitious work" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for ambitious work" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5", description: "Most efficient for everyday tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

/** The fake `tailscale` the world's Network settings read: an address this machine really has. */
export const WORLD_TAILSCALE = { ip: "127.0.0.1", dnsName: "mock.tail.ts.net" };

/** A fake bin dir (gh and tailscale), a gh config logged into github.com, and the fake claude CLI. */
function fakeTools(root: string): Record<string, string> {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // gh has to exist on PATH (the service reads its hosts.yml for the login), and answers the one
  // question the service asks it: a pull request's title.
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "{\\"title\\":\\"Mock pull request ${3##*/}\\"}"; fi\nexit 0\n');
  writeFileSync(
    join(bin, "tailscale"),
    `#!/bin/sh\nif [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"TailscaleIPs":["${WORLD_TAILSCALE.ip}"],"DNSName":"${WORLD_TAILSCALE.dnsName}."}}'; else echo ${WORLD_TAILSCALE.ip}; fi\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "tailscale"), 0o755);
  const gh = join(root, "gh");
  mkdirSync(gh, { recursive: true });
  writeFileSync(join(gh, "hosts.yml"), "github.com:\n  user: markhuot\n");
  return {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GH_CONFIG_DIR: gh,
    HARNESS_CLAUDE_BIN: join(repoRoot, "service/src/drivers/__fixtures__/fake-claude.ts"),
    FAKE_CLAUDE_AUTH: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "mark@happycog.com", orgName: "Happy Cog", subscriptionType: "team" }),
    FAKE_CLAUDE_MODELS: JSON.stringify(CLAUDE_MODELS),
  };
}

/** Apply the service's migrations to a fresh database file (the daemon would, but we seed first). */
function migrate(home: string) {
  const out = Bun.spawnSync(["bun", "-e", `import { openDb } from ${JSON.stringify(join(repoRoot, "service/src/db.ts"))}; openDb(process.argv[1]).close();`, join(home, "harness.db")], { stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`couldn't create the database: ${out.stderr.toString()}`);
}

/** A tiny server standing in for the dev server NYTIMES-1's agent browses. */
function devServer() {
  const page = (title: string) => `<!doctype html><title>${title}</title><body style="font:20px system-ui;padding:40px;background:#fafafa"><h1>${title}</h1><p>The agent's browser is on this page.</p>`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(page(new URL(req.url).pathname.startsWith("/docs") ? "Docs" : "Local dev server"), { headers: { "content-type": "text/html" } }) });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const HUE = (h: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = 0.55 * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
};

/** Claude's two windows (one amber) and Copilot's Premium requests (limited), as of now. */
export function defaultUsage(): unknown[] {
  const t = Date.now();
  const min = 60_000;
  const win = (id: string, label: string, usedPercent: number, resetsIn: number, windowSeconds: number) => ({ id, label, usedPercent, resetsAt: t + resetsIn, windowSeconds });
  return [
    { driver: "claude-code", name: "Claude Code", status: "ok", error: null, fetchedAt: t - 3 * min, windows: [win("five_hour", "5-hour", 42, 134 * min, 18000), win("seven_day", "Weekly", 78, 3 * 86_400_000, 604800)] },
    { driver: "github-copilot", name: "GitHub Copilot", status: "limited", error: null, fetchedAt: t - 3 * min, windows: [win("monthly", "Premium requests", 100, 9 * 3_600_000, 2_592_000)] },
  ];
}

export async function bootWorld(opts: Pick<StartDaemonOptions, "delayMs" | "readyMs" | "logs"> & { env?: Record<string, string> } = {}): Promise<World> {
  // The real path: git reports checkouts by it (/private/var…), and the app compares them with the project's path.
  const root = realpathSync(tempDir("harness-world-"));
  const home = join(root, "home");
  const sites = join(root, "Sites");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "attachments"), { recursive: true });
  const dev = devServer();

  // The projects' checkouts. NYTIMES and MH have a GitHub remote gh is logged into (Approve offers
  // "open a PR"), HARNESS and HELLOHARNESS are plain git, SITE isn't a checkout at all.
  const repoOf = async (name: string, remote: string | null, branches: string[] = [], worktrees: { branch: string; path: string }[] = []) => {
    const dir = await seedRepo(join(sites, name), { ...GREETER_FILES, "package.json": JSON.stringify({ name }) + "\n" }, { branches, worktrees });
    if (remote) await git(dir, "remote", "add", "origin", remote);
    return dir;
  };
  const branches = ["develop", "feature/dark-mode", "release/2026-09"];
  const [nytimes, harness, hello, mh] = await Promise.all([
    repoOf("nytimes", "https://github.com/markhuot/nytimes.git", branches, [
      // A branch checked out in another worktree (the branch picker warns about it). Not a ticket's own
      // branch: finishing a ticket cleans its branch up, and one that's checked out elsewhere blocks it.
      { branch: "medl-1223-ai-app", path: join(root, "medl-worktrees", "medl-1223-ai-app") },
    ]),
    repoOf("harness", null, branches),
    repoOf("hello-harness", null),
    repoOf("markhuot.com", "https://github.com/markhuot/markhuot.com.git", branches),
  ]);
  const siteDir = join(sites, "marketing-site");
  mkdirSync(siteDir, { recursive: true });

  migrate(home);
  const db = new Database(join(home, "harness.db"));
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const sessionIds = new Map<string, string>();
  const busyRuns: { sessionId: string; kind: string; driver: string; prompt: string; startedAt: number }[] = [];
  const attachmentRows: unknown[][] = [];

  const setting = (key: string, value: unknown) => db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ $k: key, $v: JSON.stringify(value) });

  const projects = {} as World["projects"];
  const nextSeq = new Map<string, number>();
  const seedProject = (key: keyof World["projects"], name: string, path: string, o: { skipHumanReview?: boolean; color?: string | null } = {}): WorldProject => {
    const pid = id();
    const t = now() - 7 * 86400_000;
    db.query(
      `INSERT INTO projects (id, key, name, path, next_seq, default_driver, use_worktrees, skip_agent_review, skip_human_review, color, group_name, base_branch, completion_action, default_models, phase_models, created_at, updated_at)
       VALUES ($id, $key, $name, $path, 1, NULL, 1, 0, $skipHuman, $color, NULL, NULL, 'merge', '{}', '{}', $t, $t)`,
    ).run({ $id: pid, $key: key, $name: name, $path: path, $skipHuman: o.skipHumanReview ? 1 : 0, $color: o.color ?? null, $t: t });
    const p = { id: pid, key, path };
    projects[key] = p;
    return p;
  };
  const setNextSeq = (p: WorldProject, n: number) => db.query("UPDATE projects SET next_seq = $n WHERE id = $id").run({ $n: n, $id: p.id });

  const ny = seedProject("NYTIMES", "nytimes", nytimes, { color: "blue" });
  const hx = seedProject("HARNESS", "harness", harness, { skipHumanReview: true });
  const hh = seedProject("HELLOHARNESS", "hello-harness", hello, { color: "#e0569b" });
  const site = seedProject("SITE", "marketing-site", siteDir, { color: "orange" });
  const mhp = seedProject("MH", "markhuot.com", mh, { color: "teal" });

  const ticketIds = new Map<string, string>();
  let position = 0;

  const seedTicket = (s: SeedTicket) => {
    const createdAt = now() - s.ageMin * 60_000;
    const seq = nextSeq.get(s.project.key) ?? 1;
    const key = s.key ?? `${s.project.key}-${seq}`;
    if (!s.key) nextSeq.set(s.project.key, seq + 1);
    const tid = id();
    const sid = id();
    ticketIds.set(key, tid);
    sessionIds.set(key, sid);
    const worktree = s.status !== "planning" && s.project.key !== "SITE";
    const runKind = s.kind === "conductor" ? "conductor" : s.status === "planning" ? "plan" : "work";
    const runId = id();
    const finished = !s.busy;
    const transcript: [string, unknown][] = [];
    const push = (role: string, content: unknown) => transcript.push([role, content]);
    push("user", { type: "text", text: s.spec });
    push("system", { type: "status", text: `Run started (${runKind})` });
    push("assistant", { type: "thinking", text: "The user wants this done carefully. Let me look at the relevant files first." });
    push("assistant", { type: "text", text: `I'll start by looking at how \`${s.title.split(" ").slice(-1)[0]}\` is wired up in the codebase.` });
    push("assistant", { type: "tool_call", callId: "call_1", name: "Bash", input: { command: 'rg -n "useArticle" src --type ts', timeout_ms: 30000 } });
    push("tool", {
      type: "tool_result",
      callId: "call_1",
      name: "Bash",
      output: [{ type: "text", text: 'src/hooks/useArticle.ts:12:export function useArticle(id: string) {\nsrc/pages/article.tsx:8:import { useArticle } from "../hooks/useArticle";' }],
      isError: false,
    });
    push("system", {
      type: "status",
      text: 'Allowed: rg -n "useArticle" src --type ts — read-only command',
      permission: { tool: "bash", summary: 'rg -n "useArticle" src --type ts', decision: "allow", reason: "read-only command", source: "policy", mode: "auto" },
    });
    push("assistant", { type: "tool_call", callId: "call_2", name: "Read", input: { file_path: `${s.project.path}/src/hooks/useArticle.ts`, limit: 40 } });
    push("tool", { type: "tool_result", callId: "call_2", name: "Read", output: [{ type: "text", text: "ENOENT: no such file or directory" }], isError: true });
    if (s.status === "blocked") push("system", { type: "error", text: s.blockedReason ?? "Run failed" });
    push("assistant", { type: "text", text: "Found it. The hook caches by slug, not by id, which explains the stale data. I'll switch the cache key and add a regression test." });
    if (s.status !== "planning" && s.status !== "in_progress") push("system", { type: "status", text: `Moved to ${s.status.replace("_", " ")}` });

    const revisions = s.revisions ?? [];
    const latestSpec = revisions.length ? revisions[revisions.length - 1]![2] : s.spec;
    const started = s.status !== "planning";
    const completedAt = s.completedAt ?? (s.status === "done" ? createdAt + 60_000 : null);
    db.query(
      `INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, parent_id, auto_start, agent_review, human_review, external_ref, external_key, workdir, branch,
         blocked_reason, position, model, phase_models, completed_at, completion_action, spec_revision, spec_baseline_revision, resume_at, message_draft, agent_notes, pull_requests, pending_approval, allowed_tools, skip_human_review, created_at, updated_at)
       VALUES ($id, $key, $projectId, $kind, $title, $spec, $status, $sid, $driver, $parentId, $autoStart, $agentReview, $humanReview, $externalRef, $externalKey, $workdir, $branch,
         $blockedReason, $position, $model, $phaseModels, $completedAt, $completionAction, $specRevision, $baseline, $resumeAt, $messageDraft, $agentNotes, $pullRequests, $pendingApproval, $allowedTools, $skipHuman, $createdAt, $updatedAt)`,
    ).run({
      $id: tid,
      $key: key,
      $projectId: s.project.id,
      $kind: s.kind ?? "task",
      $title: s.title,
      $spec: latestSpec,
      $status: s.status,
      $sid: sid,
      $driver: s.driver,
      $parentId: s.parentKey ? (ticketIds.get(s.parentKey) ?? null) : null,
      $autoStart: s.parentKey ? 1 : 0,
      $agentReview: s.agentReview ?? "pending",
      $humanReview: s.humanReview ?? "pending",
      $externalRef: s.externalRef ? JSON.stringify(s.externalRef) : null,
      $externalKey: s.externalRef ? s.externalRef.key.toUpperCase() : null,
      $workdir: worktree ? join(root, "worktrees", key) : s.project.path,
      $branch: worktree ? `harness/${key.toLowerCase()}` : null,
      $blockedReason: s.blockedReason ?? null,
      $position: ++position,
      $model: s.model ?? null,
      // The ticket's driver is its Work choice (the settings' default driver is dummy, so every new ticket runs on it).
      $phaseModels: JSON.stringify({ work: { driver: s.driver, model: s.model ?? null } }),
      $completedAt: completedAt,
      $completionAction: s.completionAction ?? null,
      $specRevision: 1 + revisions.length,
      $baseline: started ? 1 : null,
      $resumeAt: s.resumeAt ?? null,
      $messageDraft: s.messageDraft ? JSON.stringify({ text: s.messageDraft, attachments: [], origin: null, updatedAt: createdAt + 60_000 }) : null,
      $agentNotes: s.agentNotes ?? null,
      $pullRequests: JSON.stringify((s.pullRequests ?? []).map((p) => ({ ...p, titleCheckedAt: now() }))),
      $pendingApproval: s.pendingApproval ? JSON.stringify(s.pendingApproval) : null,
      $allowedTools: JSON.stringify(s.allowedTools ?? []),
      $skipHuman: s.project.key === "HARNESS" ? 1 : 0,
      $createdAt: createdAt,
      $updatedAt: createdAt + 60_000,
    });
    for (const [i, dep] of (s.dependsOn ?? []).entries()) db.query("INSERT OR IGNORE INTO ticket_deps (ticket_id, depends_on_key, ord) VALUES ($t, $k, $o)").run({ $t: tid, $k: dep, $o: i });
    // The session, its finished run (and a review run), and the transcript.
    db.query("INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, title, next_seq, created_at, updated_at, context) VALUES ($id, $key, 'ticket', $tid, $driver, $cwd, $title, $next, $t, $t, $ctx)").run({
      $id: sid,
      $key: key,
      $tid: tid,
      $driver: s.driver,
      $cwd: s.project.path,
      $title: s.title,
      $next: transcript.length + 1,
      $t: createdAt,
      $ctx: s.context === undefined || s.context === null ? null : JSON.stringify(s.context),
    });
    const runRow = db.query("INSERT INTO runs (id, session_id, kind, status, driver, prompt, error, created_at, started_at, ended_at, model, input_tokens, output_tokens, cost_usd) VALUES ($id, $sid, $kind, $status, $driver, $prompt, $error, $c, $c, $e, $model, $in, $out, $cost)");
    if (finished) {
      runRow.run({
        $id: runId,
        $sid: sid,
        $kind: runKind,
        $status: s.status === "blocked" ? "failed" : "succeeded",
        $driver: s.driver,
        $prompt: s.spec,
        $error: s.status === "blocked" ? (s.blockedReason ?? null) : null,
        $c: createdAt,
        $e: createdAt + 5 * 60_000,
        $model: null,
        $in: s.driver === "claude-code" ? 41_300 : null,
        $out: s.driver === "claude-code" ? 6_900 : null,
        $cost: s.driver === "claude-code" ? 0.42 : null,
      });
      if (s.status !== "planning") {
        runRow.run({ $id: id(), $sid: sid, $kind: "review", $status: "succeeded", $driver: "anthropic-api", $prompt: "Review the changes on this branch", $error: null, $c: createdAt + 6 * 60_000, $e: createdAt + 6 * 60_000 + 83_000, $model: "claude-sonnet-5", $in: 1_240_000, $out: 3_100, $cost: null });
      }
    } else {
      // A run going has to be inserted once the daemon is up, which would fail it at startup.
      busyRuns.push({ sessionId: sid, kind: runKind, driver: s.driver, prompt: s.spec, startedAt: createdAt });
    }
    transcript.forEach(([role, content], i) =>
      db.query("INSERT INTO transcript (id, session_id, run_id, seq, role, content, created_at) VALUES ($id, $sid, $run, $seq, $role, $content, $t)").run({
        $id: id(), $sid: sid, $run: runId, $seq: i + 1, $role: role, $content: JSON.stringify(content), $t: createdAt + (i + 1) * 7_000,
      }),
    );
    // The spec's history: revision 1 from the human, then the agent's (or a human's) later ones.
    const rev = db.query("INSERT INTO spec_revisions (id, ticket_id, rev, body, author, run_id, run_kind, note, approved_baseline, created_at) VALUES ($id, $t, $rev, $body, $author, $run, $kind, $note, $base, $c)");
    rev.run({ $id: id(), $t: tid, $rev: 1, $body: s.spec, $author: "human", $run: null, $kind: null, $note: "Created", $base: started ? 1 : 0, $c: createdAt });
    revisions.forEach(([author, note, body], i) =>
      rev.run({ $id: id(), $t: tid, $rev: i + 2, $body: body, $author: author, $run: author === "agent" ? runId : null, $kind: author === "agent" ? runKind : null, $note: note, $base: 0, $c: createdAt + (i + 1) * 2 * 60_000 }),
    );
    // Like the service's block tool: the question lands in Activity as a `blocked` entry.
    const seeded: [Author, string, string?][] = [...(s.activity ?? [])];
    if (s.status === "blocked" && s.blockedReason && !s.pendingApproval) seeded.push(["agent", s.blockedReason, "blocked"]);
    seeded.forEach(([author, body, kind], i) => {
      const k = kind ?? (author === "agent" ? "note" : author === "human" ? "message" : "system");
      const meta = k === "blocked" ? { question: body } : k === "review_approved" || k === "changes_requested" ? { round: 1, by: "agent" } : k === "submitted" ? { specRevision: 1 + revisions.length } : {};
      db.query("INSERT INTO activity (id, session_id, ticket_id, kind, author, body, meta, created_at) VALUES ($id, $sid, $tid, $kind, $author, $body, $meta, $c)").run({
        $id: id(), $sid: sid, $tid: tid, $kind: k, $author: author, $body: body, $meta: JSON.stringify(meta), $c: createdAt + (i + 1) * 3 * 60_000,
      });
    });
    return key;
  };

  /** A picture for a spec's Status: a gradient the shade of `hue`, stored where the service keeps attachments. */
  const media = (name: string, w: number, h: number, hue: number, dark: boolean, ticketKey: string, bytes = true) => {
    const aid = id();
    const path = join(home, "attachments", `${aid}.png`);
    if (bytes) writeFileSync(path, png(Math.min(w, 320), Math.min(h, 200), HUE(hue, dark ? 0.25 : 0.7), HUE(hue + 40, dark ? 0.4 : 0.85)));
    attachmentRows.push([aid, ticketKey, path, name, "spec", "image", "image/png", w * h, w, h, now()]);
    return { id: aid, name };
  };

  // ------------------------------------------------------------------ NYTIMES
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
    activity: [["agent", "Reproduced the bug locally. The cache is keyed by `slug`, so a rename orphans the old entry.\n\nNext:\n- switch the key to `article.id`\n- add a regression test"]],
  }); // NYTIMES-1 (a run going; the agents and browser tabs below)
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
      ["agent", 'Added `loading="lazy"` to `SectionImage` and explicit dimensions.\n\n```tsx\n<img loading="lazy" width={w} height={h} src={src} />\n```\n\nLighthouse CLS dropped from 0.14 to 0.02.'],
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
  seedTicket({
    project: ny,
    title: "Upgrade Next.js to 15 and fix type errors",
    spec: "Bump next and react, fix the resulting type errors.",
    status: "done",
    driver: "dummy",
    agentReview: "approved",
    humanReview: "approved",
    ageMin: 3000,
    completionAction: "pr",
    pullRequests: [
      { url: "https://github.com/markhuot/nytimes/pull/318", title: "Split the secrets out of checkout" },
      { url: "https://github.com/markhuot/nytimes/pull/319", title: null },
    ],
    activity: [["agent", "Upgraded to Next 15. All `tsc` errors fixed; `bun test` green."], ["agent", "Completed. Opened https://github.com/markhuot/nytimes/pull/318 from `harness/nytimes-5`."]],
  }); // NYTIMES-5
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
  setNextSeq(ny, 6);

  // ------------------------------------------------------------------ HARNESS
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
  });
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
  });
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
      input: { name: "events", command: EVENTS_LOOP, mode: "loop", prompt: EVENTS_PROMPT, env: { EVENTS_TOKEN: "evt_live_2f9c" } },
      requestedAt: now() - 30_000,
      reason: "A watcher's command runs on this Mac as you, outside any ticket sandbox, every time the watcher fires.",
      source: "policy",
      summary: EVENTS_SUMMARY,
      onceOnly: true,
    },
    ageMin: 5,
    activity: [["agent", "Checked the events endpoint with `curl`. Asking to add the watcher with your triage instructions."]],
  });
  // The conductor and its seven children, across every column. Created in key order: HARNESS-1 first.
  setNextSeq(hx, 1);
  nextSeq.set("HARNESS", 1);
  const shot = (name: string, w: number, h: number, hue: number, dark: boolean) => media(name, w, h, hue, dark, "HARNESS-2");
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
  const figure = shot("board-light.png", 1440, 900, 215, false);
  const row = [shot("board-dark.png", 1440, 900, 265, true), shot("board-narrow.png", 390, 844, 150, false)];
  // deleted.png has no bytes: its attachment 404s, like one whose ticket was deleted.
  const gone = media("deleted.png", 800, 600, 0, false, "HARNESS-2", false);
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
          "Board renders all five columns; drag and drop calls `updateTicket({ status })`. Screenshots of the board in both themes and the narrow layout.",
          "",
          `![The board in the light theme, with all five columns](attachment:${figure.id})`,
          "",
          [...row, gone].map((a) => `![${a.name}](attachment:${a.id} "thumb")`).join(" "),
        ].join("\n"),
      ],
    ],
    activity: [["agent", "Board view done, with screenshots in the spec.", "submitted"]],
  }); // HARNESS-2
  seedTicket({ project: hx, parentKey: "HARNESS-1", title: "Ticket detail with live transcript", spec: "Spec, Activity, transcript and browser tabs.", status: "planning", driver: "dummy", dependsOn: ["HARNESS-2"], ageMin: 110 }); // HARNESS-3
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
  child({ key: "HARNESS-5", title: "Scaffold the Electron shell and preload bridge", spec: "Main process, preload with a typed bridge, hidden-inset titlebar.", status: "done", driver: "claude-code", agentReview: "approved", humanReview: "approved", ageMin: 118, activity: [["agent", "Shell boots with a typed `window.harness` bridge; window state persists across launches."]] });
  child({ key: "HARNESS-6", title: "Wire the WebSocket store and reducer", spec: "REST snapshot + live events into one normalized store.", status: "in_progress", driver: "anthropic-api", busy: true, dependsOn: ["HARNESS-5"], ageMin: 100, activity: [["agent", "Reducer handles every event kind; reconnect refetches the snapshot. Writing the dedupe tests now."]] });
  child({ key: "HARNESS-7", title: "Sign and notarize the macOS build", spec: "Developer ID signing + notarytool in the package script.", status: "blocked", driver: "claude-code", dependsOn: ["HARNESS-5"], blockedReason: "Which Apple Developer team should sign the build: Happy Cog or your personal account?", ageMin: 95, activity: [["agent", "Packaging works unsigned. Need to know which team's certificate to use."]] });
  child({
    key: "HARNESS-8",
    title: "Add a Playwright e2e for the board",
    spec: "Drive the built app and check drag and drop.",
    status: "blocked",
    driver: "claude-code",
    dependsOn: ["HARNESS-2"],
    blockedReason: "Waiting for permission to use Bash",
    pendingApproval: { id: "appr_2", runId: "run_appr_2", toolName: "Bash", input: { command: "bunx playwright install chromium", description: "Install the Playwright browser" }, requestedAt: now() - 45_000 },
    ageMin: 60,
  });
  child({ key: "HARNESS-10", title: "Settings screen for drivers and watchers", spec: "Driver login state and watcher CRUD.", status: "review", driver: "claude-code", dependsOn: ["HARNESS-5"], agentReview: "approved", humanReview: "pending", ageMin: 80, activity: [["agent", "Settings has Drivers and Watchers sections; each saves on blur."]] });
  setNextSeq(hx, 11);

  // The context gauge in each state (app/scripts/context-gauge-check.ts): normal, over the limit with
  // cache misses, compacting, a github-copilot estimate, and a fresh session.
  const usage = (o: Record<string, unknown>) => ({ input: 1000, cacheRead: 61_000, cacheWrite: 20_000, output: 800, prefix: 50_000, at: now() - 60_000, estimated: false, misses: 0, missTokens: 0, ...o });
  const gauge = (key: string, title: string, o: Partial<SeedTicket>) => seedTicket({ project: hx, key, title, spec: "A ticket for the context gauge.", status: "review", driver: "claude-code", ageMin: 30, ...o });
  gauge("HARNESS-901", "Gauge: normal", { context: usage({}) });
  gauge("HARNESS-902", "Gauge: over the limit with misses", { context: usage({ input: 2000, cacheRead: 150_000, cacheWrite: 168_000, misses: 3, missTokens: 377_000 }) });
  gauge("HARNESS-903", "Gauge: compacting", { status: "in_progress", busy: true, compacting: true, context: usage({ cacheRead: 150_000 }) });
  gauge("HARNESS-904", "Gauge: github-copilot estimate", { driver: "github-copilot", context: usage({ input: 82_000, cacheRead: 0, cacheWrite: 0, prefix: 0, estimated: true }) });
  gauge("HARNESS-905", "Gauge: new session", { context: null });
  gauge("HARNESS-906", "Gauge: run going", { status: "in_progress", busy: true, context: usage({ misses: 1, missTokens: 40_000 }) });

  // ------------------------------------------------------------------ HELLOHARNESS
  for (const [title, status, ageMin] of [
    ["Scaffold the hello world page", "done", 3000],
    ["Add a greeting API route", "done", 2400],
    ["Localize the greeting", "planning", 30],
  ] as const) {
    seedTicket({ project: hh, title, spec: title, status, driver: "claude-code", agentReview: status === "done" ? "approved" : "pending", humanReview: status === "done" ? "approved" : "pending", ageMin });
  }
  seedTicket({ project: hh, key: "ACME-12", title: "Greeting typo on the landing page", spec: "Reported in Jira.", status: "planning", driver: "claude-code", externalRef: { source: "jira", key: "ACME-12", url: "https://example.atlassian.net/browse/ACME-12", raw: {} }, ageMin: 20 });
  setNextSeq(hh, 4);

  // ------------------------------------------------------------------ SITE: a deep Done column
  // 130 done tickets completed over the last ~65 minutes (newest first), renumbered from an old
  // WWW key (WWW-n resolves to SITE-n). Not a git checkout: the composer hides its worktree switch.
  const verbs = ["Fix", "Refactor", "Polish", "Document", "Speed up", "Test", "Localize", "Harden"];
  const nouns = ["hero banner", "pricing table", "footer links", "blog index", "contact form", "sitemap", "RSS feed", "404 page", "cookie notice", "search page", "case studies grid", "team page", "careers list"];
  db.exec("BEGIN");
  for (let i = 1; i <= 130; i++) {
    const title = i === 42 ? "Retire the legacy jQuery carousel" : `${verbs[i % verbs.length]} the ${nouns[i % nouns.length]} (#${i})`;
    const key = seedTicket({
      project: site,
      key: `SITE-${i}`,
      title,
      spec: i === 42 ? "Swap the carousel for a CSS scroll-snap strip; drop jquery.slick." : `Routine maintenance ${i}.`,
      status: "done",
      driver: "dummy",
      agentReview: "approved",
      humanReview: "approved",
      ageMin: 600 + i,
      completedAt: now() - (131 - i) * 30_000,
    });
    db.query("UPDATE tickets SET updated_at = completed_at WHERE key = $k").run({ $k: key });
    db.query("INSERT INTO ticket_key_aliases (key, ticket_id, created_at) VALUES ($k, $t, $c)").run({ $k: `WWW-${i}`, $t: ticketIds.get(key)!, $c: now() });
  }
  db.exec("COMMIT");
  setNextSeq(site, 131);

  // ------------------------------------------------------------------ MH: remote IDs
  // A native MH-62, and two tickets with their own keys linked to Jira's MH-62 (a PR review's
  // stages). OPS-41 is a remote ID with no local ticket of that key.
  const jira = (key: string, summary: string) => ({ source: "jira", key, url: `https://happycog.atlassian.net/browse/${key}`, raw: { key, summary } });
  seedTicket({ project: mhp, key: "MH-62", title: "Newsletter signup posts twice on slow connections", spec: "The signup form doesn't disable its button while the request is in flight.", status: "in_progress", driver: "claude-code", ageMin: 400, activity: [["agent", "Reproduced with network throttling. The button re-enables before the response lands."]] });
  seedTicket({ project: mhp, key: "MH-124", title: "Review the checkout PR: API changes", spec: "Jira MH-62, stage 1: review the order API changes in the checkout PR.", status: "review", driver: "claude-code", agentReview: "approved", externalRef: jira("MH-62", "Checkout rewrite"), ageMin: 180, activity: [["agent", "Reviewed the order API. Two comments on idempotency keys; otherwise good."]] });
  seedTicket({ project: mhp, key: "MH-130", title: "Review the checkout PR: UI pass", spec: "Jira MH-62, stage 2: review the checkout UI once the API changes land.", status: "in_progress", driver: "claude-code", externalRef: jira("MH-62", "Checkout rewrite"), dependsOn: ["MH-124"], ageMin: 60 });
  seedTicket({ project: mhp, key: "MH-131", title: "Rotate the CDN signing key", spec: "Jira OPS-41: rotate the key and update the edge config.", status: "planning", driver: "claude-code", externalRef: jira("OPS-41", "Rotate CDN keys"), ageMin: 45 });
  seedTicket({ project: mhp, key: "MH-132", title: "Rotate the CDN signing key on staging", spec: "Jira OPS-41, staging first.", status: "done", driver: "claude-code", agentReview: "approved", humanReview: "approved", externalRef: jira("OPS-41", "Rotate CDN keys"), ageMin: 50 });
  setNextSeq(mhp, 133);

  for (const r of attachmentRows) {
    const [aid, tkey, path, name, source, kind, mime, size, width, height, created] = r as [string, string, string, string, string, string, string, number, number, number, number];
    db.query("INSERT INTO attachments (id, ticket_id, path, name, source, kind, mime_type, size, width, height, created_at) VALUES ($id, $t, $p, $n, $s, $k, $m, $z, $w, $h, $c)").run({
      $id: aid, $t: ticketIds.get(tkey)!, $p: path, $n: name, $s: source, $k: kind, $m: mime, $z: size, $w: width, $h: height, $c: created,
    });
  }

  // NYTIMES-1's Agents & tasks tab (two sub-agents, one nested, each on its own model, and a background task) and its browser tabs.
  {
    const sid = sessionIds.get("NYTIMES-1")!;
    const at = now() - 6 * 60_000;
    const insert = db.query(
      `INSERT INTO subagents (session_id, id, run_id, parent_id, description, agent_type, model, prompt, status, result, started_at, ended_at, updated_at, kind, command)
       VALUES ($sid, $id, $run, $parent, $desc, $type, $model, $prompt, $status, $result, $start, $end, $upd, $kind, $command)`,
    );
    const runId = id();
    const sub = (aid: string, o: { parent?: string; desc: string; type?: string | null; model?: string; prompt?: string; status?: string; result?: string; start: number; end?: number; kind?: string; command?: string }) =>
      insert.run({ $sid: sid, $id: aid, $run: runId, $parent: o.parent ?? null, $desc: o.desc, $type: o.type === undefined ? "general-purpose" : o.type, $model: o.model ?? null, $prompt: o.prompt ?? "", $status: o.status ?? "running", $result: o.result ?? null, $start: o.start, $end: o.end ?? null, $upd: o.end ?? o.start, $kind: o.kind ?? "agent", $command: o.command ?? null });
    db.query("INSERT INTO runs (id, session_id, kind, status, driver, prompt, attachments, created_at, started_at, ended_at) VALUES ($id, $sid, 'work', 'succeeded', 'claude-code', 'sub-agents', '[]', $c, $c, $c)").run({ $id: runId, $sid: sid, $c: at });
    sub("toolu_mock_explore", { desc: "Find where the article cache is keyed", type: "Explore", model: "claude-haiku-4-5-20251001", prompt: "Find every place src/ reads or writes the article cache, with file paths and line numbers.", status: "succeeded", result: "The cache is keyed by slug in src/hooks/useArticle.ts:41 and invalidated in src/store/articles.ts:88.", start: at, end: at + 48_000 });
    sub("toolu_mock_review", { desc: "Review the cache key change", model: "claude-opus-5-5", prompt: "Review the diff that keys the article cache by id for correctness bugs.", start: at + 120_000 });
    sub("toolu_mock_tests", { parent: "toolu_mock_review", desc: "Check the hooks tests", type: "Explore", model: "claude-sonnet-5-5", prompt: "List the tests that exercise useArticle.", start: at + 150_000 });
    sub("toolu_mock_bash", { kind: "bash", type: null, desc: "Run the test suite", command: "bun test src/hooks", start: at + 90_000 });
    const said = db.query("INSERT INTO transcript (id, session_id, run_id, subagent_id, seq, role, content, created_at) VALUES ($id, $sid, $run, $sub, $seq, 'assistant', $content, $c)");
    let seq = (db.query("SELECT next_seq FROM sessions WHERE id = $id").get({ $id: sid }) as { next_seq: number }).next_seq;
    for (const text of ["Reading the diff in src/hooks/useArticle.ts first.", "The id key looks right; checking the tests that cover a slug rename next."]) {
      said.run({ $id: id(), $sid: sid, $run: runId, $sub: "toolu_mock_review", $seq: seq++, $content: JSON.stringify({ type: "text", text }), $c: at + seq * 1000 });
    }
    db.query("UPDATE sessions SET next_seq = $n WHERE id = $id").run({ $n: seq, $id: sid });
    db.query("INSERT INTO browser_tabs (session_id, next_tab_id, tabs, updated_at) VALUES ($id, 3, $tabs, $t)").run({
      $id: sid,
      $tabs: JSON.stringify([
        { id: 1, url: `${dev.url}/`, title: "Local dev server" },
        { id: 2, url: `${dev.url}/docs`, title: "Docs" },
      ]),
      $t: now(),
    });
  }

  // ------------------------------------------------------------------ triage sessions and watchers
  const triage = (n: number, projectPath: string, title: string, ago: number, status: string, outcome: string | null, transcript: [string, unknown][]) => {
    const sid = id();
    const at = now() - ago * 60_000;
    db.query("INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, title, triage_status, outcome, next_seq, created_at, updated_at) VALUES ($id, $key, 'triage', NULL, 'claude-code', $cwd, $title, $status, $outcome, $next, $t, $t)").run({
      $id: sid, $key: `TRIAGE-${n}`, $cwd: projectPath, $title: title, $status: status, $outcome: outcome, $next: transcript.length + 1, $t: at,
    });
    transcript.forEach(([role, content], i) =>
      db.query("INSERT INTO transcript (id, session_id, run_id, seq, role, content, created_at) VALUES ($id, $sid, NULL, $seq, $role, $content, $t)").run({ $id: id(), $sid: sid, $seq: i + 1, $role: role, $content: JSON.stringify(content), $t: at + i * 1000 }),
    );
  };
  const JIRA_PROMPT = "If this ticket is assigned to me and has actionable next steps, dispatch it. FOO tickets go to the NYTIMES project.";
  triage(1, ny.path, "Paywall meter counts AMP pageviews twice", 95, "dispatched", "Dispatched to NYTIMES as FOO-123 (started).", [
    ["user", { type: "text", text: `New output from watcher jira:\n\nFOO-123 Paywall meter counts AMP pageviews twice\n\nPrompt: ${JIRA_PROMPT}` }],
    ["assistant", { type: "tool_call", callId: "c1", name: "dispatch_ticket", input: { project_key: "NYTIMES", key: "FOO-123", title: "Paywall meter counts AMP pageviews twice", start: true } }],
    ["tool", { type: "tool_result", callId: "c1", name: "dispatch_ticket", output: [{ type: "text", text: "Created FOO-123" }], isError: false }],
    ["system", { type: "status", text: "Dispatched to NYTIMES" }],
  ]);
  triage(2, mhp.path, "Checkout rewrite: UI ready for review", 61, "dispatched", "Dispatched to MH-130 (MH-62) in MH (started).", [["user", { type: "text", text: "New output from watcher jira:\n\nMH-62 Checkout rewrite: UI ready for review" }]]);
  triage(3, ny.path, "Recipe card print styles broken in Safari", 2, "triaging", null, [["user", { type: "text", text: `New output from watcher jira:\n\nFOO-131 Recipe card print styles broken in Safari\n\nPrompt: ${JIRA_PROMPT}` }]]);

  // Watchers, all stopped: an enabled one would run its command on this Mac.
  const watcher = db.query(
    "INSERT INTO watchers (id, name, command, args, prompt, cwd, env, mode, interval_sec, enabled, driver, models, last_run_at, last_error, created_at, updated_at) VALUES ($id, $name, $cmd, '[]', $prompt, NULL, '{}', $mode, $interval, 0, NULL, $models, $last, $err, $c, $c)",
  );
  const w = (name: string, command: string, prompt: string, o: { mode?: string; interval?: number; models?: object; last?: number; err?: string } = {}) =>
    watcher.run({ $id: id(), $name: name, $cmd: command, $prompt: prompt, $mode: o.mode ?? "loop", $interval: o.interval ?? 60, $models: JSON.stringify(o.models ?? {}), $last: o.last ?? now() - 60_000, $err: o.err ?? null, $c: now() - 86400_000 });
  w("jira", "~/Sites/Jira/watch-jira.js", JIRA_PROMPT);
  w("status-page", "while true; do curl -s https://status.example.com/api/incidents.json; sleep 300; done", "Only surface new incidents that affect the NYTIMES site.", {
    last: now() - 4 * 60_000,
    err: "Command exited with code 6: curl: (6) Could not resolve host: status.example.com\ncurl: (6) Could not resolve host: status.example.com\nThe watcher's loop exits when curl fails, so every restart hits the same DNS error until the host resolves again.",
  });
  w("gh-reviews", "gh search prs --review-requested=@me --state=open --json url,title", "Dispatch review requests for harness to HARNESS.", { mode: "interval", interval: 300, models: { "claude-code": "sonnet" } });
  w("sentry-alerts", "sentry-cli events list --project web --max-rows 20", JIRA_PROMPT, { last: now() - 3 * 86400_000 });

  // ------------------------------------------------------------------ settings
  setting("defaultDriver", "dummy");
  setting("classifier", "off");
  setting("baseBranch", "main");
  setting("phaseModels", {});
  setting("prompts", {
    // One working override and one naming a variable the prompt doesn't have (as after an app update renamed it): GET /prompts reports its overrideError.
    "run.review": 'Review {{ticket}} carefully.\n\nRead it with get_ticket { key: "{{key}}" }.\n\nCheck the tests first, then the diff.',
    "system.files": "## Files\nRead with {{readTool}}. Never use {{shellTool}} to edit files.",
  });
  db.close();

  const daemonOptions: StartDaemonOptions = { home, delayMs: opts.delayMs ?? 5, readyMs: opts.readyMs, logs: opts.logs, env: { ...fakeTools(root), ...opts.env } };
  const daemon = await startDaemon(daemonOptions);
  let current = daemon;
  // Runs going: the daemon sweeps any it finds at startup, so these go in once it is up.
  withDb(home, (d) => {
    for (const r of busyRuns) {
      d.query("INSERT INTO runs (id, session_id, kind, status, driver, prompt, attachments, created_at, started_at) VALUES ($id, $s, $kind, 'running', $driver, $prompt, '[]', $t, $t)").run({
        $id: id(), $s: r.sessionId, $kind: r.kind, $driver: r.driver, $prompt: r.prompt, $t: r.startedAt,
      });
    }
    // HARNESS-903's compact run is the one that makes it `compacting`.
    d.query("UPDATE runs SET kind = 'compact', prompt = '/compact' WHERE session_id = $s AND status = 'running'").run({ $s: sessionIds.get("HARNESS-903")! });
  });
  let planUsage = defaultUsage();
  const listeners = new Set<(message: string) => void>();
  const proxy = startDaemonProxy(daemon.base, {
    intercept: (req) => (req.method === "GET" && new URL(req.url).pathname === "/usage" ? Response.json({ data: { drivers: planUsage } }) : undefined),
    onClientMessage: (m) => listeners.forEach((fn) => fn(m)),
  });
  return {
    ...daemon,
    base: proxy.base,
    daemonBase: daemon.base,
    api: apiClient(proxy.base, daemon.token),
    projects,
    devUrl: dev.url,
    sessionOf: (key: string) => sessionIds.get(key) ?? "",
    setUsage(drivers) {
      planUsage = drivers;
      proxy.push({ kind: "usage.updated", usage: { drivers } });
    },
    onClientMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stopDaemon: () => current.stop({ termMs: 20000 }),
    async startDaemonAgain() {
      current = await startDaemon({ ...daemonOptions, port: daemon.port });
    },
    stop: async (o) => {
      proxy.stop();
      dev.stop();
      await current.stop({ termMs: o?.termMs });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
