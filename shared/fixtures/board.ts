// Board-state scenarios for the Swift port (ios/HarnessKit State/BoardState, Reducer, Paging,
// Selectors, Subagents). A scenario runs real reducer actions from shared/src/state and records,
// after each step, the outputs of selector "probes" and (on the last step, or when asked) the
// whole serialized State. The Swift test replays the same actions and must produce the same JSON.
//
// State is plain JSON already (records, arrays, null), so it serializes as is. Probes project
// tickets to their ids so outputs stay small. Selectors whose TS output order is object insertion
// order (which Swift dictionaries don't have) are sorted here and in Swift; see BoardState.swift.
// Not a case file itself: it lives outside cases/ so the exporter doesn't write it out.

import type { Project, Run, Session, Subagent, Summary, Ticket, TicketDetail, TicketPage, TranscriptEntry, Watcher } from "../src/protocol";
import {
  boardColumns,
  canLoadMoreDone,
  canLoadMoreSearch,
  childrenOf,
  composerProject,
  conductorsNeedingChildren,
  defaultDriverOf,
  dependencyStates,
  dependentsOf,
  doneColumn,
  doneCount,
  hasCustomDriver,
  initialState,
  latestSummary,
  liveDelta,
  matchesQuery,
  needsFirstDonePage,
  reducer,
  searchColumns,
  searchStatusText,
  sortedProjects,
  subagentById,
  subagentPath,
  subagentsOf,
  subagentTranscript,
  taskOutputOf,
  ticketByKey,
  ticketLinkable,
  ticketsForProject,
  triageSessions,
  unresolvedKeys,
  type Action,
  type Columns,
  type Snapshot,
  type State,
} from "../src/state";

// ---------------------------------------------------------------------------
// Factories (the same shapes reducer.test.ts and paging.test.ts build)
// ---------------------------------------------------------------------------

export const project = (id: string, key: string, over: Partial<Project> = {}): Project => ({
  id,
  key,
  name: key.toLowerCase(),
  path: `/tmp/${key}`,
  nextSeq: 1,
  defaultDriver: null,
  defaultModels: {},
  useWorktrees: false,
  skipAgentReview: false, skipHumanReview: false,
  permissionMode: null,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

export const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id,
  key: id.toUpperCase(),
  projectId: "p1",
  kind: "task",
  title: id,
  description: "",
  status: "planning",
  sessionId: `s-${id}`,
  driver: "dummy",
  parentId: null,
  dependsOn: [],
  autoStart: false,
  agentReview: "pending",
  humanReview: "pending",
  externalRef: null,
  workdir: null,
  branch: null,
  blockedReason: null,
  permissionMode: null,
  busy: false,
  pendingApproval: null,
  allowedTools: [],
  model: null,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** paging.test.ts's `tk`: completedAt null, created/updated at 10. */
export const tk = (id: string, over: Partial<Ticket> = {}): Ticket => ticket(id, { completedAt: null, createdAt: 10, updatedAt: 10, ...over });
/** A done ticket completed at `at` (ms). */
export const done = (id: string, at: number, over: Partial<Ticket> = {}) => tk(id, { status: "done", completedAt: at, updatedAt: at, createdAt: 5, ...over });
export const page = (tickets: Ticket[], nextCursor: string | null, total: number): TicketPage => ({ tickets, nextCursor, total });

export const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  key: id.toUpperCase(),
  kind: "ticket",
  ticketId: null,
  driver: "dummy",
  cwd: "/",
  title: "",
  triageStatus: null,
  outcome: null,
  busy: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

export const entry = (id: string, seq: number, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id,
  sessionId: "s1",
  runId: "r1",
  seq,
  role: "assistant",
  content: { type: "text", text: `entry ${id}` },
  createdAt: seq,
  ...over,
});

export const summary = (id: string, createdAt: number, over: Partial<Summary> = {}): Summary => ({
  id,
  sessionId: "s1",
  ticketId: "t1",
  author: "agent",
  body: id,
  createdAt,
  attachments: [],
  ...over,
});

export const run = (id: string, status: Run["status"], over: Partial<Run> = {}): Run => ({
  id,
  sessionId: "s1",
  kind: "work",
  status,
  driver: "dummy",
  prompt: "",
  error: null,
  createdAt: 0,
  startedAt: 0,
  endedAt: null,
  ...over,
});

export const sub = (id: string, over: Partial<Subagent> = {}): Subagent => ({
  id,
  sessionId: "s1",
  runId: "r1",
  parentId: null,
  description: `Task ${id}`,
  agentType: "general-purpose",
  prompt: "",
  status: "running",
  result: null,
  startedAt: 10,
  endedAt: null,
  updatedAt: 10,
  ...over,
});

export const watcher = (id: string, over: Partial<Watcher> = {}): Watcher => ({
  id,
  name: "jira",
  command: "node",
  args: [],
  prompt: "",
  cwd: null,
  env: {},
  mode: "loop",
  intervalSec: 60,
  enabled: true,
  driver: null,
  lastRunAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

export const settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: {},
  reviewModels: {},
  anthropicApiKeySet: false,
} as const;

/** A detail for `t` with a full session (Swift decodes every field). */
export function detail(t: Ticket, over: Partial<TicketDetail> = {}): TicketDetail {
  return { ticket: t, session: session(t.sessionId, { ticketId: t.id }), summaries: [], runs: [], dependents: [], children: [], ...over };
}

export const ev = (event: Extract<Action, { type: "event" }>["event"]): Action => ({ type: "event", event });
export const upsert = (t: Ticket): Action => ev({ kind: "ticket.upserted", ticket: t });
export function snapshot(tickets: Ticket[], donePage?: Snapshot["donePage"], over: Partial<Snapshot> = {}): Action {
  return { type: "snapshot", snapshot: { projects: [], tickets, sessions: [], watchers: [], settings: null, drivers: [], ...(donePage ? { donePage } : {}), ...over } };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const ids = (ts: Ticket[]) => ts.map((t) => t.id);
const cols = (c: Columns) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, ids(v)]));
const sorted = (xs: string[]) => [...xs].sort();
const tid = (t: Ticket | undefined) => t?.id ?? null;

/** Selector name → (state, ...args) → JSON output. Args name tickets by id where TS takes a Ticket from the state. */
const PROBES: Record<string, (s: State, ...args: never[]) => unknown> = {
  boardColumns: (s, projectId: string | null) => cols(boardColumns(s, projectId)),
  doneColumn: (s, projectId: string | null) => ids(doneColumn(s, projectId)),
  doneCount: (s, projectId: string | null, loaded: number) => doneCount(s, projectId, loaded),
  canLoadMoreDone: (s, projectId: string | null) => canLoadMoreDone(s, projectId),
  needsFirstDonePage: (s, projectId: string | null) => needsFirstDonePage(s, projectId),
  searchColumns: (s, projectId: string | null) => {
    const r = searchColumns(s, projectId);
    return { columns: cols(r.columns), pending: r.pending };
  },
  searchStatusText: (s) => (s.search ? searchStatusText(s.search) : null),
  canLoadMoreSearch: (s) => canLoadMoreSearch(s.search),
  ticketByKey: (s, key: string) => tid(ticketByKey(s, key)),
  ticketLinkable: (s, key: string) => ticketLinkable(s, key),
  dependencyStates: (s, id: string) => dependencyStates(s, s.tickets[id]!).map((d) => ({ key: d.key, done: d.done, state: d.state, ticket: tid(d.ticket), missing: d.missing })),
  unresolvedKeys: (s, extra: string[] = []) => sorted(unresolvedKeys(s, extra)),
  conductorsNeedingChildren: (s) => sorted(ids(conductorsNeedingChildren(s))),
  dependentsOf: (s, id: string) => dependentsOf(s, s.tickets[id]!).map((d) => ({ key: d.key, ticket: tid(d.ticket) })),
  liveDelta: (s, sessionId: string) => [...liveDelta(s, sessionId)].sort((a, b) => (a.runId < b.runId ? -1 : 1)),
  latestSummary: (s, sessionId: string) => latestSummary(s, sessionId)?.id ?? null,
  triageSessions: (s) => triageSessions(s).map((x) => x.id),
  defaultDriverOf: (s, projectId: string) => defaultDriverOf(s, projectId),
  hasCustomDriver: (s, t: Ticket) => hasCustomDriver(s, t),
  childrenOf: (s, id: string) => ids(childrenOf(s, id)),
  ticketsForProject: (s, projectId: string | null) => sorted(ids(ticketsForProject(s, projectId))),
  sortedProjects: (s) => sortedProjects(s).map((p) => p.id),
  composerProject: (s, current: string, candidates: (string | null)[]) => composerProject(s, current, candidates),
  matchesQuery: (s, id: string, q: string) => matchesQuery(s.tickets[id]!, q, s.keyAliases),
  subagentsOf: (s, sessionId: string) => subagentsOf(s, sessionId)?.map((x) => x.id) ?? null,
  subagentById: (s, sessionId: string, id: string) => subagentById(s, sessionId, id)?.status ?? null,
  subagentPath: (s, sessionId: string, id: string) => subagentPath(s, sessionId, id).map((x) => x.id),
  subagentTranscript: (s, sessionId: string, id: string) => {
    const t = subagentTranscript(s, sessionId, id);
    return t ? { seqs: t.entries.map((e) => e.seq), loaded: t.loaded } : null;
  },
  taskOutputOf: (s, sessionId: string, id: string) => taskOutputOf(s, sessionId, id) ?? null,
  transcript: (s, key: string) => {
    const t = s.transcripts[key];
    return t ? { ids: t.entries.map((e) => e.id), loaded: t.loaded } : null;
  },
};

export type Probe = [fn: keyof typeof PROBES, ...args: unknown[]];

export interface Step {
  actions?: Action[];
  /** Replace top-level State fields by hand (a test that edits state directly) */
  patch?: Partial<State>;
  probes?: Probe[];
  /** Record the full State after this step (always recorded on the last step) */
  full?: boolean;
}

export interface ScenarioCase {
  name: string;
  /** Only when the scenario doesn't start from initialState */
  initial?: State;
  steps: { actions: Action[]; patch?: Partial<State>; probes: { fn: string; args: unknown[]; output: unknown }[]; state?: State }[];
}

/** Run a scenario through the real reducer, recording probe outputs (and states) after each step. */
export function scenario(name: string, steps: Step[], initial?: State): ScenarioCase {
  let s = initial ?? initialState;
  const out: ScenarioCase["steps"] = steps.map((step, i) => {
    if (step.patch) s = { ...s, ...step.patch };
    const actions = step.actions ?? [];
    s = actions.reduce(reducer, s);
    const probes = (step.probes ?? []).map(([fn, ...args]) => {
      const output = (PROBES[fn] as (s: State, ...a: unknown[]) => unknown)(s, ...args);
      return { fn, args, output: output === undefined ? null : output };
    });
    const last = i === steps.length - 1;
    return { actions, ...(step.patch ? { patch: step.patch } : {}), probes, ...(step.full || last ? { state: s } : {}) };
  });
  return { name, ...(initial ? { initial } : {}), steps: out };
}

/** Every probe name, so the Swift side can check it implements them all. */
export const PROBE_NAMES = Object.keys(PROBES).sort();
